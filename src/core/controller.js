import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { createTransport } from './exec.js';
import { createCountingProxy } from './proxy.js';
import { summarizeCounts } from './actions.js';
import { pairingAddress } from './config.js';
import { TunnelSupervisor } from './tunnel.js';
import { SETUP_LABEL } from './labels.js';
import { SETUP_SCRIPT, parsePairOutput, parseSetupOutput, summarizeStatus, verifySetup } from './browse.js';

/**
 * The one overall state the tray shows. Each carries a label so meaning never
 * rides on the icon colour alone.
 */
export const OVERALL = Object.freeze({
  unconfigured: 'No host configured',
  stopped: 'Stopped',
  connecting: 'Connecting',
  error: 'Tunnel down',
  relayIdle: 'Relay not running',
  needsPairing: 'Browser not connected',
  ready: 'Connected',
  warning: 'Connected, with warnings',
  unknown: 'Unknown',
});

export function computeOverall({ configured, wanted, tunnel, status, warnings, fault = null }) {
  if (!configured) return 'unconfigured';
  if (fault) return 'error';
  if (!wanted) return 'stopped';
  if (tunnel === 'starting') return 'connecting';
  if (tunnel === 'retrying') return 'error';
  if (tunnel !== 'up') return 'unknown';
  if (!status) return 'unknown';
  if (status.relayRunning === false) return 'relayIdle';
  if (status.extensionConnected === false) return 'needsPairing';
  if (status.extensionConnected !== true) return 'unknown';
  return warnings.length ? 'warning' : 'ready';
}

/**
 * Wires transport + tunnel + proxy + status polling. UI-agnostic: the
 * Electron shell and the tests both drive it through these methods and the
 * "change" event.
 */
export class Controller extends EventEmitter {
  constructor({ config, logger, controlDir = null, localEnv = process.env, spawnImpl } = {}) {
    super();
    this.cfg = config;
    this.logger = logger;
    this.controlDir = controlDir;
    this.localEnv = localEnv;
    this.spawnImpl = spawnImpl;
    this.wanted = false;
    this.tunnelState = { state: 'stopped', detail: '' };
    this.status = null;
    this.statusError = null;
    this.statusAt = null;
    this.warnings = [];
    this.pairing = null;
    this.busy = null;
    /** A failure that stopped the connection outright (e.g. the local port is taken). */
    this.fault = null;
    this.proxy = null;
    this.tunnel = null;
    /** The relay's port as last measured: the port the extension must dial (BBR-21). */
    this.relayPort = config.remotePort;
    this.pollTimer = null;
    /** The last 50 browser connections through the proxy, newest last. */
    this.connections = [];
    if (controlDir) mkdirSync(controlDir, { recursive: true, mode: 0o700 });
  }

  get configured() {
    return this.cfg.transport === 'local' || Boolean(this.cfg.host);
  }

  transport() {
    return createTransport(this.cfg, { localEnv: this.localEnv });
  }

  snapshot() {
    const overall = computeOverall({
      configured: this.configured,
      wanted: this.wanted,
      tunnel: this.tunnelState.state,
      status: this.status,
      warnings: this.warnings,
      fault: this.fault,
    });
    return {
      /** The host entry's id and name (absent for a bare single config, e.g. in tests). */
      id: this.cfg.id ?? null,
      name: this.cfg.name ?? '',
      overall,
      label: OVERALL[overall],
      host: this.cfg.transport === 'local' ? '(local)' : this.cfg.host,
      /** Whether a connection is wanted (Connect pressed / autoconnect) — what the Connect/Disconnect button follows. */
      connected: this.wanted,
      localAddress: this.cfg.localAddress,
      localPort: this.relayPort,
      /** What the extension is told to dial: this host's loopback address on the relay's own port. */
      pairingAddress: this.pairingAddress(),
      tunnel: this.tunnelState,
      status: this.status,
      statusError: this.statusError,
      statusAt: this.statusAt,
      warnings: this.warnings,
      traffic: this.proxy ? { ...this.proxy.stats, actions: plainActions(this.proxy.stats.actions) } : null,
      connections: this.connections.map((c) => ({ ...c })),
      pairing: this.pairing,
      busy: this.busy,
      config: this.cfg,
    };
  }

  changed() {
    this.emit('change', this.snapshot());
  }

  async connect() {
    if (this.wanted || !this.configured) return;
    this.wanted = true;
    this.fault = null;
    this.logger.info('app', `connecting to ${this.cfg.transport === 'local' ? 'local relay' : this.cfg.host}`);
    const target = this.cfg.transport === 'local' ? this.relayPort : this.cfg.innerPort;
    if (!(await this.openProxy(target))) {
      this.wanted = false;
      this.tunnelState = { state: 'stopped', detail: this.fault };
      this.changed();
      return;
    }
    if (this.cfg.transport === 'local') {
      this.tunnelState = { state: 'up', detail: `direct to 127.0.0.1:${target}` };
    } else {
      this.tunnel = new TunnelSupervisor(this.cfg, this.spawnImpl ? { spawnImpl: this.spawnImpl } : {});
      this.tunnel.on('state', (s) => {
        this.tunnelState = s;
        this.changed();
        if (s.state === 'up') this.pollNow();
      });
      this.tunnel.on('log', ({ level, message }) => this.logger.log(level, 'tunnel', message));
      this.tunnel.start();
    }
    this.schedulePoll(0);
    this.changed();
  }

  pairingAddress() {
    return pairingAddress({ localAddress: this.cfg.localAddress, localPort: this.relayPort });
  }

  /** Listen on <localAddress>:<relay port>. False (with this.fault set) when that is taken. */
  async openProxy(target) {
    const proxy = createCountingProxy({
      listenHost: this.cfg.localAddress,
      listenPort: this.relayPort,
      targetPort: target,
      countActions: this.cfg.countActions,
      onEvent: (e) => this.onProxyEvent(e),
    });
    try {
      await proxy.listen();
    } catch (err) {
      const where = `${this.cfg.localAddress}:${this.relayPort}`;
      this.logger.error('proxy', `cannot listen on ${where}: ${err.code || err.message}`);
      this.proxy = null;
      this.fault = `${where} is in use — another copy, a local browse relay, or a manual ssh -L on it?`;
      return false;
    }
    this.proxy = proxy;
    return true;
  }

  /**
   * The relay moved port. The extension must dial the relay's own port, so the
   * pairing address moves with it: the forward retargets and the proxy re-listens.
   */
  async followRelayPort(port) {
    if (port === this.relayPort) return;
    this.logger.warn('proxy', `relay is on port ${port}, not ${this.relayPort}; the pairing address becomes ${pairingAddress({ localAddress: this.cfg.localAddress, localPort: port })}`);
    this.relayPort = port;
    if (this.tunnel) this.tunnel.retarget(port);
    if (!this.proxy) return;
    const old = this.proxy;
    this.proxy = null;
    await old.close();
    if (!this.wanted) return;
    if (!(await this.openProxy(this.cfg.transport === 'local' ? port : this.cfg.innerPort))) this.tunnelState = { state: 'stopped', detail: this.fault };
  }

  async disconnect() {
    this.fault = null;
    if (!this.wanted) {
      // Setup or pairing may have opened a multiplexing master without a connection.
      if (this.configured) await this.transport().closeMaster(this.controlDir);
      this.changed();
      return;
    }
    this.wanted = false;
    clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.tunnel?.stop();
    this.tunnel = null;
    await this.proxy?.close();
    this.proxy = null;
    if (this.configured) await this.transport().closeMaster(this.controlDir);
    this.tunnelState = { state: 'stopped', detail: '' };
    this.logger.info('app', 'disconnected');
    this.changed();
  }

  async reconfigure(cfg) {
    const was = this.wanted;
    await this.disconnect();
    this.cfg = cfg;
    this.relayPort = cfg.remotePort;
    this.status = null;
    this.warnings = [];
    this.changed();
    if (was || cfg.autoConnect) await this.connect();
  }

  onProxyEvent(e) {
    const now = new Date().toISOString();
    if (e.type === 'open' || (e.type === 'fail' && !this.connections.some((c) => c.id === e.id))) {
      this.connections.push({ id: e.id, openedAt: now, closedAt: null, up: 0, down: 0, state: 'open', error: null });
      if (this.connections.length > 50) this.connections.splice(0, this.connections.length - 50);
    }
    const conn = this.connections.find((c) => c.id === e.id);
    if (conn && e.type !== 'open') Object.assign(conn, { closedAt: now, up: e.up, down: e.down, state: e.type === 'fail' ? 'failed' : 'closed', error: e.error });
    if (e.type === 'open') this.logger.info('traffic', `#${e.id} browser connected → :${e.target}`);
    else if (e.type === 'close') this.logger.info('traffic', `#${e.id} closed after ${(e.ms / 1000).toFixed(1)}s — ↑${e.up} B ↓${e.down} B${actionNote(e.actions)}`);
    else if (e.type === 'fail') this.logger.warn('traffic', `#${e.id} could not reach :${e.target} (${e.error ?? 'closed'})`);
    this.changed();
  }

  schedulePoll(ms = this.cfg.pollSeconds * 1000) {
    clearTimeout(this.pollTimer);
    if (!this.wanted) return;
    this.pollTimer = setTimeout(() => this.pollNow(), ms);
  }

  async pollNow() {
    if (!this.wanted) return;
    clearTimeout(this.pollTimer);
    const res = await this.transport().browse(['status', '--json'], { controlDir: this.controlDir, timeoutMs: 20_000 });
    if (!this.wanted) return;
    this.statusAt = new Date().toISOString();
    let parsed = null;
    try {
      parsed = res.code === 0 ? JSON.parse(res.stdout) : null;
    } catch {
      parsed = null;
    }
    const summary = summarizeStatus(parsed);
    if (!summary) {
      const why = res.timedOut ? 'timed out' : (res.stderr.trim().split('\n').pop() || `exit ${res.code}`);
      if (this.statusError !== why) this.logger.warn('status', `browse status failed: ${why}`);
      this.statusError = why;
      this.status = null;
    } else {
      const prev = this.status;
      this.statusError = null;
      this.status = summary;
      this.warnings = this.statusWarnings(summary);
      if (prev?.extensionConnected !== summary.extensionConnected) {
        this.logger.info('status', `extension ${summary.extensionConnected === true ? 'connected' : summary.extensionConnected === false ? 'not connected' : 'unknown'}`);
      }
      if (summary.relayPort) await this.followRelayPort(summary.relayPort);
    }
    this.changed();
    this.schedulePoll();
  }

  statusWarnings(s) {
    const w = [];
    if (s.autoUpdate !== 'off') w.push(`auto-update is ${s.autoUpdate ?? 'unmeasured'} — click "${SETUP_LABEL}"`);
    if (s.relayVersion && s.relayVersion !== this.cfg.browseVersion) w.push(`browse ${s.relayVersion} running, ${this.cfg.browseVersion} pinned`);
    return w;
  }

  async withBusy(label, fn) {
    if (this.busy) throw new Error(`busy: ${this.busy}`);
    this.busy = label;
    this.changed();
    try {
      return await fn();
    } finally {
      this.busy = null;
      this.changed();
    }
  }

  /** Install/pin browse on the remote, turn auto-update off, bind loopback, restart; verify at the receiver. */
  setupRemote() {
    return this.withBusy('Setting up remote', async () => {
      this.logger.info('setup', `running setup (browse ${this.cfg.browseVersion})`);
      const res = await this.transport().script(SETUP_SCRIPT, [this.cfg.remoteBrowse, this.cfg.browseVersion], {
        controlDir: this.controlDir,
        timeoutMs: 300_000, // BBR-54: the native install's curl calls take at most about 4 minutes (see SETUP_SCRIPT)
      });
      for (const line of res.stderr.split('\n')) if (line.trim()) this.logger.info('setup', line.trim());
      const parsed = parseSetupOutput(res.stdout);
      if (parsed.installVia) this.logger.info('setup', `installed browse via ${parsed.installVia}${parsed.installSha512 ? `, tarball sha512 ${parsed.installSha512}` : ''}`);
      const problems = verifySetup(parsed, { version: this.cfg.browseVersion });
      if (res.code !== 0) problems.unshift(res.timedOut ? 'setup timed out' : `setup exited ${res.code}: ${res.stdout.split('\n').filter((l) => l && !l.startsWith('@@')).pop() ?? ''}`);
      if (problems.length) for (const p of problems) this.logger.error('setup', p);
      else this.logger.info('setup', 'verified: pinned version, auto-update off, relay on loopback only');
      if (this.wanted) this.pollNow();
      return { ok: problems.length === 0, problems, steps: parsed.steps };
    });
  }

  /** Ask the relay for a one-time pairing code; it is shown in the UI and never logged. */
  pair() {
    return this.withBusy('Pairing', async () => {
      // --wait-seconds 1: the code stays valid for 10 minutes after the command returns.
      const res = await this.transport().browse(['pair', '--wait-seconds', '1'], { controlDir: this.controlDir, timeoutMs: 30_000 });
      const p = parsePairOutput(res.stdout);
      if (!p) {
        this.logger.error('pair', `no pairing code in output (exit ${res.code}): ${res.stderr.trim() || res.stdout.trim()}`);
        this.pairing = null;
        return null;
      }
      this.pairing = {
        code: p.code,
        address: this.pairingAddress(),
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        relayInstructions: p.instructions,
      };
      this.logger.info('pair', `pairing code issued; enter it with relay address ${this.pairingAddress()}`);
      if (this.wanted) this.pollNow();
      return this.pairing;
    });
  }

  /** Start the relay if it is idle (agents normally start it on demand). */
  startRelay() {
    return this.withBusy('Starting relay', async () => {
      const res = await this.transport().browse(['restart'], { controlDir: this.controlDir, timeoutMs: 30_000 });
      if (res.code === 0) this.logger.info('relay', 'relay (re)started');
      else this.logger.error('relay', `restart failed: ${res.stderr.trim() || res.stdout.trim()}`);
      if (this.wanted) this.pollNow();
      return res.code === 0;
    });
  }

  /** Last lines of the remote relay log. */
  async relayLog(lines = 200) {
    const body = `f="\${XDG_STATE_HOME:-$HOME/.local/state}/browse/logs/relay.log"; [ -f "$f" ] && tail -n ${Number(lines) | 0} "$f" || echo "(no relay log at $f)"`;
    const res = await this.transport().script(body, [], { controlDir: this.controlDir, timeoutMs: 20_000 });
    return res.code === 0 ? res.stdout : `could not read relay log: ${res.stderr.trim()}`;
  }
}

/** The proxy's action counts as plain data for the window (its counters use null-prototype objects). */
function plainActions(a) {
  if (!a) return null;
  return { ...a, byType: { ...a.byType }, byName: { ...a.byName } };
}

/** " · 42 commands: pointer 20 · script 12" for a connection's close line. Type names and numbers only. */
export function actionNote(a) {
  if (!a) return '';
  let note = ` · ${a.counts.total} command${a.counts.total === 1 ? '' : 's'}`;
  if (a.counts.total) note += `: ${summarizeCounts(a.counts)}`;
  if (a.undecoded) note += ` · ${a.undecoded} unreadable`;
  if (a.gaveUp) note += ` · stopped decoding (${a.gaveUp})`;
  return note;
}
