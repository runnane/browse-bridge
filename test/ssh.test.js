/**
 * The ssh transport end to end, against a private unprivileged sshd on
 * 127.0.0.1:39922 with a throwaway host key, client key and HOME. Skipped
 * unless BROWSE_BIN is set and /usr/sbin/sshd exists.
 *
 * Covers what the local-transport test cannot: remote quoting, the setup
 * script over stdin, ControlMaster status polls, the real `ssh -L` through
 * the proxy, and that nothing (tunnel, master) outlives disconnect.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { execFileSync, execSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeConfig } from '../src/core/config.js';
import { Logger } from '../src/core/log.js';
import { Controller } from '../src/core/controller.js';
import { pairWithCode } from './support/pair-client.js';
import { sshdStartMessage } from './support/sshd-log.js';

const BIN = process.env.BROWSE_BIN;
const SSHD = '/usr/sbin/sshd';
const SSH_PORT = 39922;
// Distinct from integration.test.js's ports: node --test runs files in parallel.
const RELAY_PORT = 39978;
const skip = (!BIN && 'BROWSE_BIN not set') || (!existsSync(SSHD) && 'no sshd');

async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function pidOnPort(port) {
  const out = execSync(`ss -ltnpH 'sport = :${port}'`, { encoding: 'utf8' });
  const m = /pid=(\d+)/.exec(out);
  return m ? Number(m[1]) : null;
}

test('ssh transport: setup, tunnel, status, pairing and traffic over real ssh', { skip }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bb-ssh-'));
  chmodSync(dir, 0o700);
  const home = join(dir, 'home');
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  symlinkSync(BIN, join(home, '.local', 'bin', 'browse'));
  for (const k of ['hostkey', 'clientkey']) execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, k)]);
  copyFileSync(join(dir, 'clientkey.pub'), join(dir, 'authorized_keys'));
  const hostPub = readFileSync(join(dir, 'hostkey.pub'), 'utf8').split(' ').slice(0, 2).join(' ');
  writeFileSync(join(dir, 'known_hosts'), `[127.0.0.1]:${SSH_PORT} ${hostPub}\n`);
  writeFileSync(join(dir, 'sshd_config'), [
    `Port ${SSH_PORT}`, 'ListenAddress 127.0.0.1', `HostKey ${join(dir, 'hostkey')}`, `PidFile ${join(dir, 'sshd.pid')}`,
    `AuthorizedKeysFile ${join(dir, 'authorized_keys')}`, 'PasswordAuthentication no', 'KbdInteractiveAuthentication no',
    'UsePAM no', 'StrictModes no', 'AllowTcpForwarding yes',
    `SetEnv HOME=${home} OPENCODE_BROWSER_PORT=${RELAY_PORT} OPENCODE_BROWSER_AUTO_UPDATE=off`, '',
  ].join('\n'));
  execFileSync(SSHD, ['-f', join(dir, 'sshd_config'), '-E', join(dir, 'sshd.log')]);
  assert.ok(await waitFor(() => existsSync(join(dir, 'sshd.pid')), 5000), sshdStartMessage(join(dir, 'sshd.log')));
  const sshdPid = Number(readFileSync(join(dir, 'sshd.pid'), 'utf8'));

  const controlDir = join(dir, 'cm');
  const cfg = normalizeConfig({
    host: '127.0.0.1', remotePort: RELAY_PORT, localAddress: '127.0.0.3', innerPort: 39981, pollSeconds: 3,
    sshOptions: [`Port=${SSH_PORT}`, `IdentityFile=${join(dir, 'clientkey')}`, 'IdentitiesOnly=yes', `UserKnownHostsFile=${join(dir, 'known_hosts')}`],
  });
  const ctl = new Controller({ config: cfg, logger: new Logger(), controlDir });

  t.after(async () => {
    await ctl.disconnect();
    const relay = pidOnPort(RELAY_PORT);
    if (relay) process.kill(relay, 'SIGTERM');
    process.kill(sshdPid, 'SIGTERM');
  });

  const setup = await ctl.setupRemote();
  assert.deepEqual(setup.problems, [], 'setup verified at the receiver, over ssh');

  await ctl.connect();
  assert.ok(await waitFor(() => ctl.tunnelState.state === 'up', 15_000), `tunnel: ${JSON.stringify(ctl.tunnelState)}`);
  assert.ok(await waitFor(() => ctl.status?.relayRunning === true, 15_000), `status: ${ctl.statusError}`);
  assert.equal(ctl.snapshot().overall, 'needsPairing');

  const pairing = await ctl.pair();
  assert.match(pairing?.code ?? '', /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

  const reply = await new Promise((resolve, reject) => {
    const c = net.connect({ port: RELAY_PORT, host: cfg.localAddress }, () => c.write('GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
    let buf = '';
    c.on('data', (d) => { buf += d; });
    c.on('end', () => resolve(buf));
    c.on('error', reject);
  });
  assert.match(reply, /^HTTP\/1\.1 \d{3}/, 'browser side → proxy → ssh -L → relay');
  // The browser pairs through proxy → ssh -L → relay, its proofs bound to the relay's own port (BBR-21).
  assert.equal(pairing.address, `127.0.0.3:${RELAY_PORT}`);
  assert.deepEqual(await pairWithCode(`ws://${pairing.address}/extension`, pairing.code), { paired: true }, 'the browser pairs over ssh');
  assert.ok(await waitFor(() => ctl.proxy.stats.connectionsActive === 0, 3000));
  assert.ok(ctl.proxy.stats.bytesDown > 0);

  const tunnelPid = ctl.tunnel.child.pid;
  await ctl.disconnect();
  assert.equal(await waitFor(() => { try { process.kill(tunnelPid, 0); return false; } catch { return true; } }, 3000), true, 'tunnel ssh exited');
  assert.equal(await waitFor(() => readdirSync(controlDir).length === 0, 3000), true, 'multiplex master exited, socket gone');
});
