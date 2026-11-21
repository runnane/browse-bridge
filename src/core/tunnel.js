import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { baseSshOptions } from './exec.js';
import { probePort } from './proxy.js';

/** Backoff after the Nth consecutive failure: 1s, 2s, 4s … capped at 30s. */
export function backoffMs(failures) {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, failures - 1));
}

/** The ssh argv for the forward: 127.0.0.1:innerPort → remote 127.0.0.1:remotePort. */
export function tunnelArgs(cfg, remotePort) {
  return [
    ...baseSshOptions(cfg),
    '-N',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    // Never let this become (or ride on) a ControlMaster: its lifetime is the tunnel's.
    '-o', 'ControlMaster=no',
    '-o', 'ControlPath=none',
    '-L', `127.0.0.1:${cfg.innerPort}:127.0.0.1:${remotePort}`,
    '--', cfg.host,
  ];
}

/**
 * Keeps one ssh -L forward alive. States: stopped → starting → up, and back
 * to "retrying" with backoff whenever ssh exits. A live ssh process is not
 * proof of a working forward, so "up" also requires the local port to accept.
 *
 * Events: "state" ({ state, detail }), "log" ({ level, message }).
 */
export class TunnelSupervisor extends EventEmitter {
  constructor(cfg, { spawnImpl = spawn, sshBin = 'ssh' } = {}) {
    super();
    this.cfg = cfg;
    this.spawnImpl = spawnImpl;
    this.sshBin = sshBin;
    this.child = null;
    this.state = 'stopped';
    this.detail = '';
    this.failures = 0;
    this.remotePort = cfg.remotePort;
    this.timer = null;
    this.wanted = false;
  }

  setState(state, detail = '') {
    if (state === this.state && detail === this.detail) return;
    this.state = state;
    this.detail = detail;
    this.emit('state', { state, detail });
  }

  log(level, message) {
    this.emit('log', { level, message });
  }

  start() {
    this.wanted = true;
    this.failures = 0;
    if (!this.child && !this.timer) this.spawnOnce();
  }

  /** Point the forward at a different remote port (the relay moved). */
  retarget(remotePort) {
    if (remotePort === this.remotePort) return;
    this.log('info', `relay port changed ${this.remotePort} → ${remotePort}; restarting forward`);
    this.remotePort = remotePort;
    if (this.wanted) this.restart();
  }

  restart() {
    this.killChild();
    clearTimeout(this.timer);
    this.timer = null;
    if (this.wanted) this.spawnOnce();
  }

  /**
   * Start over now, as if freshly started (BBR-38): after a resume the forward
   * may sit on a dead TCP connection, and a retry may be waiting out a long
   * backoff. Forget the failure count, drop any pending retry and respawn.
   * Does nothing for a forward that is not wanted. Returns whether it acted.
   */
  kick() {
    if (!this.wanted) return false;
    this.failures = 0;
    this.restart();
    return true;
  }

  stop() {
    this.wanted = false;
    clearTimeout(this.timer);
    this.timer = null;
    this.killChild();
    this.setState('stopped');
  }

  killChild() {
    const child = this.child;
    if (!child) return;
    this.child = null;
    child.removeAllListeners('exit');
    // Signal only the process we spawned, by its own handle.
    child.kill('SIGTERM');
  }

  spawnOnce() {
    this.timer = null;
    const args = tunnelArgs(this.cfg, this.remotePort);
    this.setState('starting', `ssh ${this.cfg.host} -L ${this.cfg.innerPort}→${this.remotePort}`);
    let child;
    try {
      child = this.spawnImpl(this.sshBin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      this.onExit(null, null, String(err));
      return;
    }
    this.child = child;
    let stderr = '';
    child.stderr?.on('data', (d) => {
      const text = String(d);
      stderr = (stderr + text).slice(-4000);
      for (const line of text.split('\n')) if (line.trim()) this.log('warn', `ssh: ${line.trim()}`);
    });
    child.on('error', (err) => { stderr += String(err); });
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.onExit(code, signal, stderr);
    });
    this.confirmUp(child);
  }

  async confirmUp(child) {
    // ssh has no "forward ready" signal; poll the forward's local port for as long as this ssh lives
    // (a slow login must not leave the state stuck at "unknown").
    for (let i = 0; this.child === child; i++) {
      if (await probePort(this.cfg.innerPort, { timeoutMs: 500 })) {
        if (this.child !== child) return;
        this.failures = 0;
        this.setState('up', `127.0.0.1:${this.cfg.innerPort} → ${this.cfg.host}:${this.remotePort}`);
        this.log('info', `tunnel up (ssh pid ${child.pid})`);
        return;
      }
      if (i === 20) this.setState('unknown', 'ssh is running but the forward port does not answer yet');
      await new Promise((r) => setTimeout(r, i < 20 ? 500 : 2000));
    }
  }

  onExit(code, signal, stderr) {
    if (!this.wanted) return;
    this.failures++;
    const last = String(stderr).trim().split('\n').filter(Boolean).pop() ?? '';
    const why = signal ? `signal ${signal}` : `exit ${code}`;
    const wait = backoffMs(this.failures);
    this.setState('retrying', `${why}${last ? `: ${last}` : ''} — retry in ${Math.round(wait / 1000)}s`);
    this.log('error', `tunnel ended (${why})${last ? `: ${last}` : ''}`);
    this.timer = setTimeout(() => this.spawnOnce(), wait);
  }
}
