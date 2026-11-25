/**
 * Drives the Controller against the real browse binary on this machine
 * (transport "local"), in a throwaway HOME on a spare port. Skipped unless
 * BROWSE_BIN points at a browse executable:
 *
 *   BROWSE_BIN=$HOME/.local/bin/browse node --test test/
 *
 * It always stops the relay it started, by the pid browse reports.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeConfig } from '../src/core/config.js';
import { Logger } from '../src/core/log.js';
import { Controller } from '../src/core/controller.js';
import { createTransport } from '../src/core/exec.js';
import { wsUpgrade } from './support/ws-upgrade.js';
import { pairWithCode } from './support/pair-client.js';

const BIN = process.env.BROWSE_BIN;
const RELAY_PORT = 39988;

async function waitFor(fn, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

test('integration: setup, status, pairing and proxied traffic against real browse', { skip: !BIN && 'BROWSE_BIN not set' }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'bb-home-'));
  // Same layout as a real remote: the binary at $HOME/.local/bin/browse, named with a literal $HOME.
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  symlinkSync(BIN, join(home, '.local', 'bin', 'browse'));
  const env = { HOME: home, PATH: '/usr/bin:/bin', OPENCODE_BROWSER_PORT: String(RELAY_PORT) };
  const cfg = normalizeConfig({
    transport: 'local',
    remoteBrowse: '$HOME/.local/bin/browse',
    remotePort: RELAY_PORT,
    localAddress: '127.0.0.2', // the relay holds 127.0.0.1:RELAY_PORT; the proxy has its own address on the same port
    innerPort: 39991,
    pollSeconds: 60,
    countActions: true, // BBR-22: the opt-in tap reads the real relay's frames below
  });
  const logger = new Logger({ file: join(home, 'app.log') });
  const ctl = new Controller({ config: cfg, logger, localEnv: env });

  t.after(async () => {
    await ctl.disconnect();
    const res = await createTransport(cfg, { localEnv: env }).browse(['status', '--json']);
    const pid = (() => { try { return JSON.parse(res.stdout).relay?.pid; } catch { return null; } })();
    if (pid) process.kill(pid, 'SIGTERM');
  });

  const setup = await ctl.setupRemote();
  assert.deepEqual(setup.problems, [], 'setup verified at the receiver');
  assert.equal(setup.steps.install, 'skip');

  await ctl.connect();
  assert.ok(await waitFor(() => ctl.status?.relayRunning === true), `status polled: ${ctl.statusError}`);
  const snap = ctl.snapshot();
  assert.equal(snap.status.relayPort, RELAY_PORT);
  assert.equal(snap.status.autoUpdate, 'off');
  assert.equal(snap.overall, 'needsPairing', 'no browser paired in a fresh HOME');

  const pairing = await ctl.pair();
  assert.match(pairing.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.equal(pairing.address, `127.0.0.2:${RELAY_PORT}`, 'the relay\'s own port, on this host\'s own address (BBR-21)');
  assert.ok(!logger.ring.some((e) => e.message.includes(pairing.code)), 'code never logged');

  // A raw HTTP request through the app's proxy reaches the relay and is counted.
  const reply = await new Promise((resolve, reject) => {
    const c = net.connect({ port: RELAY_PORT, host: cfg.localAddress }, () => c.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'));
    let buf = '';
    c.on('data', (d) => { buf += d; });
    c.on('end', () => resolve(buf));
    c.on('error', reject);
  });
  assert.match(reply, /^HTTP\/1\.1 \d{3}/);

  // What the extension does with that code, through the app's proxy: the whole handshake, its proofs
  // bound to the port it dialed (BBR-21). A 101 alone proved nothing (BBR-20 had one and could not pair).
  assert.deepEqual(await pairWithCode(`ws://${pairing.address}/extension`, pairing.code), { paired: true }, 'the browser pairs through the proxy');
  assert.match(await ctl.relayLog(20), /extension\.paired/, 'and the relay says so');
  assert.match(await wsUpgrade(cfg.localAddress, RELAY_PORT, `evil.example:${RELAY_PORT}`), /^HTTP\/1\.1 403 /, 'a foreign hostname still reaches the relay as sent, and is refused');
  assert.ok(await waitFor(() => ctl.proxy.stats.connectionsActive === 0, 3000));
  assert.ok(ctl.proxy.stats.bytesUp > 0 && ctl.proxy.stats.bytesDown > 0, JSON.stringify(ctl.proxy.stats));
  // BBR-22: the relay's own pairing frames (auth.challenge, auth.token) were read through the tap, and
  // nothing it sent was unreadable. Pairing is not an action, so no command is counted.
  const acts = ctl.proxy.stats.actions;
  assert.ok(acts.messages >= 2, `relay frames read: ${JSON.stringify(acts)}`);
  assert.equal(acts.undecodable, 0, 'no connection gave up decoding');
  assert.equal(acts.undecodedMessages, 0, 'every relay message was readable');
  assert.equal(acts.total, 0, 'pairing is not counted as an action');

  // BBR-98, against the real relay: the client above closed its socket, so its browser is paired but
  // offline. Measured on 0.1.5: the status JSON then lists no browser at all, and only `pair --list`
  // has it. The Browsers list must still carry it, and Unpair must remove it at the relay.
  await ctl.pollNow();
  const listed = ctl.status?.browserList;
  t.diagnostic(`browserList after pairing: ${JSON.stringify(listed)}`);
  assert.deepEqual(ctl.status?.browserIds, [], 'the status JSON itself lists no offline browser (why pair --list is read)');
  assert.equal(listed?.length, 1, `the paired browser is listed: ${JSON.stringify(listed)}`);
  assert.equal(listed[0].connected, false, 'as not connected, not dropped');
  assert.equal(ctl.status.browserListPartial, false);
  const unpaired = await ctl.unpairBrowser(listed[0].id);
  assert.equal(unpaired.ok, true, unpaired.message);
  assert.deepEqual(await ctl.readPairedList(), [], 'the relay has no paired browser afterwards');
  assert.ok(!logger.ring.some((e) => /[A-Z0-9]{4}-[A-Z0-9]{4}/.test(e.message)), 'no pairing code in the log');

  const tail = await ctl.relayLog(20);
  assert.ok(tail.length > 0 && !tail.startsWith('could not'), tail);
});
