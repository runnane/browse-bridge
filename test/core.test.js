import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeConfig, saveConfig, loadConfig, DEFAULTS } from '../src/core/config.js';
import { Logger, redact } from '../src/core/log.js';
import { timed, createLagMonitor } from '../src/core/stall.js';
import { shQuote, shQuotePath, createTransport, sshBrowseArgs, sshScriptArgs } from '../src/core/exec.js';
import { createCountingProxy, probePort, rewriteHostValue, rewriteRequestHead } from '../src/core/proxy.js';
import { TunnelSupervisor, backoffMs, tunnelArgs } from '../src/core/tunnel.js';
import { parsePairOutput, parseSetupOutput, summarizeStatus, verifySetup, endpointPort } from '../src/core/browse.js';
import { computeOverall, Controller } from '../src/core/controller.js';

test('config: rejects an ssh destination that ssh would read as an option', () => {
  assert.throws(() => normalizeConfig({ host: '-oProxyCommand=evil' }), /not a valid ssh destination/);
  assert.throws(() => normalizeConfig({ host: 'a b' }), /not a valid ssh destination/);
  assert.equal(normalizeConfig({ host: ' jon@dev004 ' }).host, 'jon@dev004');
});

test('config: ports validated, defaults applied, round-trips through disk', () => {
  assert.throws(() => normalizeConfig({ remotePort: 0 }), /remotePort must be a port/);
  assert.throws(() => normalizeConfig({ remotePort: 5000, innerPort: 5000 }), /innerPort 5000 is the pairing port on 127\.0\.0\.1/);
  assert.equal(normalizeConfig({ localPort: 20000, remotePort: 29988 }).localPort, 29988, 'localPort is the relay port, never a setting (BBR-21)');
  assert.throws(() => normalizeConfig({ sshOptions: ['nokey'] }), /Key=value/);
  const dir = mkdtempSync(join(tmpdir(), 'bb-cfg-'));
  const path = join(dir, 'config.json');
  const fresh = loadConfig(path);
  assert.deepEqual(fresh.hosts.map((h) => [h.id, h.host, h.localAddress, h.innerPort]), [['host-1', '', '127.0.0.1', 19989]], 'no file: one unconfigured host');
  saveConfig(path, { hosts: [{ id: 'host-1', host: 'dev004', localAddress: ' 127.0.0.7 ', remotePort: '20000' }] });
  const back = loadConfig(path).hosts[0];
  assert.equal(back.localAddress, '127.0.0.7');
  assert.equal(back.remotePort, 20000);
  assert.equal(back.host, 'dev004');
  assert.equal(back.innerPort, DEFAULTS.innerPort);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { hosts: [{ id: 'host-1', host: 'dev004', localAddress: '127.0.0.7', remotePort: 20000 }] }, 'only non-defaults are stored');
});

test('config: an older default pin stored by a previous release is dropped; a deliberate pin is kept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bb-pin-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ host: 'dev004', browseVersion: '0.1.3', localPort: 19988 }));
  assert.equal(loadConfig(path).browseVersion, DEFAULTS.browseVersion);
  writeFileSync(path, JSON.stringify({ browseVersion: '0.1.3', hosts: [{ id: 'a', host: 'dev004' }] }));
  assert.equal(loadConfig(path).browseVersion, DEFAULTS.browseVersion, 'also in the host-list shape');
  assert.equal(DEFAULTS.browseVersion, '0.1.4');
  writeFileSync(path, JSON.stringify({ host: 'dev004', browseVersion: '0.1.2' }));
  assert.equal(loadConfig(path).browseVersion, '0.1.2');
});

test('log: a pairing code never reaches the file or the ring', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bb-log-'));
  const file = join(dir, 'app.log');
  const log = new Logger({ file });
  log.info('pair', 'Pairing code: YCGB-NSHE enter it');
  assert.equal(redact('x AB12-CD34 y'), 'x ****-**** y');
  assert.ok(!readFileSync(file, 'utf8').includes('YCGB-NSHE'));
  assert.ok(!log.ring.at(-1).message.includes('YCGB-NSHE'));
  assert.match(readFileSync(file, 'utf8'), /\*\*\*\*-\*\*\*\*/);
});

test('exec: quoting keeps hostile text inert and $HOME expandable', () => {
  assert.equal(shQuote('status'), 'status');
  assert.equal(shQuote("a'b; rm -rf ~"), `'a'\\''b; rm -rf ~'`);
  assert.equal(shQuotePath('$HOME/.local/bin/browse'), '"$HOME"/.local/bin/browse');
  assert.equal(shQuotePath('/opt/my browse'), `'/opt/my browse'`);
});

test('exec: ssh transport passes BatchMode, "--" before the host, and one quoted remote command', () => {
  const cfg = normalizeConfig({ host: 'jon@dev004', sshOptions: ['IdentityFile=/k'] });
  assert.equal(createTransport(cfg).kind, 'ssh');
  assert.throws(() => createTransport(normalizeConfig({ host: '' })), /No host configured/);
  const a = sshBrowseArgs(cfg, ['pair', "x'; touch /tmp/pwn"], '/run/bb');
  assert.deepEqual(a.slice(0, 2), ['-o', 'BatchMode=yes']);
  assert.ok(a.includes('IdentityFile=/k'));
  assert.ok(a.includes('ControlPath=/run/bb/cm-%C'));
  assert.deepEqual(a.slice(-3), ['--', 'jon@dev004', `"$HOME"/.local/bin/browse pair 'x'\\''; touch /tmp/pwn'`]);
  const s = sshScriptArgs(cfg, ['$HOME/.local/bin/browse', '0.1.3']);
  assert.equal(s.at(-1), `bash -s -- '$HOME/.local/bin/browse' 0.1.3`, 'the path reaches the script literally; the script expands it');
  assert.ok(!s.some((x) => x.startsWith('ControlPath')), 'no multiplexing unless asked');
  for (const argv of [a, s]) assert.ok(argv.includes('ClearAllForwardings=yes'), 'a command call never runs the user\'s LocalForward');
});

test('controller: recent connections record open, close with byte counts, and failures, capped at 50', () => {
  const ctl = new Controller({ config: normalizeConfig({ transport: 'local', localAddress: '127.0.0.2' }), logger: new Logger() });
  ctl.onProxyEvent({ type: 'open', id: 1, target: 1 });
  assert.equal(ctl.snapshot().connections[0].state, 'open');
  ctl.onProxyEvent({ type: 'close', id: 1, target: 1, up: 5, down: 10, ms: 3, error: null });
  ctl.onProxyEvent({ type: 'fail', id: 2, target: 1, up: 0, down: 0, ms: 1, error: 'ECONNREFUSED' });
  const [a, b] = ctl.snapshot().connections;
  assert.deepEqual([a.state, a.up, a.down, Boolean(a.closedAt)], ['closed', 5, 10, true]);
  assert.deepEqual([b.state, b.error], ['failed', 'ECONNREFUSED']);
  for (let i = 3; i < 60; i++) ctl.onProxyEvent({ type: 'open', id: i, target: 1 });
  assert.equal(ctl.snapshot().connections.length, 50);
  assert.equal(ctl.snapshot().connections.at(-1).id, 59);
});

test('controller: a taken pairing address is an error state with a reason, not "Stopped"', async (t) => {
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.2', r));
  t.after(() => blocker.close());
  const port = blocker.address().port;
  const ctl = new Controller({ config: normalizeConfig({ transport: 'local', localAddress: '127.0.0.2', remotePort: port, innerPort: port + 1 }), logger: new Logger() });
  await ctl.connect();
  const snap = ctl.snapshot();
  assert.equal(snap.overall, 'error');
  assert.equal(snap.connected, false, 'the button offers Connect again, not Disconnect');
  assert.match(snap.tunnel.detail, new RegExp(`127\\.0\\.0\\.2:${port} is in use`));
  await ctl.disconnect();
  assert.equal(ctl.snapshot().overall, 'stopped', 'disconnect clears the fault');
});

test('controller: the pairing address follows the relay when it moves port (BBR-21)', async (t) => {
  const ports = await new Promise((resolve) => {
    const a = net.createServer().listen(0, '127.0.0.1', () => {
      const b = net.createServer().listen(0, '127.0.0.1', () => {
        const out = [a.address().port, b.address().port];
        a.close(); b.close(); resolve(out);
      });
    });
  });
  const ctl = new Controller({ config: normalizeConfig({ transport: 'local', localAddress: '127.0.0.6', remotePort: ports[0], innerPort: 39999, pollSeconds: 600 }), logger: new Logger() });
  t.after(() => ctl.disconnect());
  ctl.schedulePoll = () => {}; // no status polls: browse is not run here
  await ctl.connect();
  assert.equal(ctl.snapshot().pairingAddress, `127.0.0.6:${ports[0]}`);
  assert.equal(await probePort(ports[0], { host: '127.0.0.6', timeoutMs: 500 }), true);
  await ctl.followRelayPort(ports[1]);
  assert.equal(ctl.snapshot().pairingAddress, `127.0.0.6:${ports[1]}`, 'the address the window shows moves with the relay');
  assert.equal(await probePort(ports[1], { host: '127.0.0.6', timeoutMs: 500 }), true, 'the proxy listens on the new port');
  assert.equal(await probePort(ports[0], { host: '127.0.0.6', timeoutMs: 500 }), false, 'and left the old one');
  assert.equal(ctl.proxy.target, ports[1], 'local transport: the proxy targets the relay\'s new port');
});

test('proxy: counts bytes both ways and logs open/close per connection', async () => {
  const echo = net.createServer((s) => s.on('data', (d) => s.write(Buffer.concat([d, d]))));
  await new Promise((r) => echo.listen(0, '127.0.0.1', r));
  const events = [];
  const proxy = createCountingProxy({ listenPort: 0, targetPort: echo.address().port, onEvent: (e) => events.push(e) });
  const port = await proxy.listen();
  const reply = await new Promise((resolve, reject) => {
    const c = net.connect({ port, host: '127.0.0.1' }, () => c.write('hello'));
    let buf = '';
    c.on('data', (d) => {
      buf += d;
      if (buf.length >= 10) { c.end(); resolve(buf); }
    });
    c.on('error', reject);
  });
  assert.equal(reply, 'hellohello');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(proxy.stats.bytesUp, 5);
  assert.equal(proxy.stats.bytesDown, 10);
  assert.equal(proxy.stats.connectionsTotal, 1);
  assert.equal(proxy.stats.connectionsActive, 0);
  assert.deepEqual(events.map((e) => e.type), ['open', 'close']);
  assert.equal(events[1].up, 5);
  assert.equal(events[1].down, 10);
  await proxy.close();
  echo.close();
});

test('proxy: only our own address literal is renamed to 127.0.0.1, and the port never changes (BBR-21)', () => {
  assert.equal(rewriteHostValue('127.0.0.3:19988', '127.0.0.3', 19988), '127.0.0.1:19988');
  assert.equal(rewriteHostValue(' 127.0.0.3:19988 ', '127.0.0.3', 19988), '127.0.0.1:19988');
  assert.equal(rewriteHostValue('evil.example:19988', '127.0.0.3', 19988), 'evil.example:19988', 'a rebound name reaches the relay as sent');
  assert.equal(rewriteHostValue('127.0.0.4:19988', '127.0.0.3', 19988), '127.0.0.4:19988', 'another address is not ours');
  assert.equal(rewriteHostValue('127.0.0.3:19992', '127.0.0.3', 19988), '127.0.0.3:19992', 'another port is not ours, and is never swapped');
  assert.equal(rewriteHostValue('127.0.0.3', '127.0.0.3', 19988), '127.0.0.3', 'portless is not ours');
  assert.equal(rewriteHostValue('localhost:19988', '127.0.0.1', 19988), 'localhost:19988', 'on 127.0.0.1 nothing is rewritten');
  const r = rewriteRequestHead('GET /extension HTTP/1.1\r\nhost: 127.0.0.3:19988\r\nUpgrade: websocket', '127.0.0.3', 19988);
  assert.equal(r.head, 'GET /extension HTTP/1.1\r\nhost: 127.0.0.1:19988\r\nUpgrade: websocket');
  assert.equal(r.upgrade, true);
});

test('proxy: renames our address in every request head, split across chunks, and nothing else', async (t) => {
  let received = '';
  const held = new Set();
  const sink = net.createServer((s) => {
    held.add(s);
    s.on('data', (d) => { received += d.toString('latin1'); });
  });
  await new Promise((r) => sink.listen(0, '127.0.0.1', r));
  const proxy = createCountingProxy({ listenHost: '127.0.0.5', listenPort: 0, targetPort: sink.address().port });
  const port = await proxy.listen();
  // Cleanup even when an assertion fails: a leaked server keeps this file's process alive for ever.
  t.after(async () => {
    await proxy.close();
    for (const s of held) s.destroy();
    sink.close();
  });
  // A body that looks like a head line must pass through untouched.
  const body = `\r\n\r\nHost: 127.0.0.5:${port}\r\n\r\n`;
  const first = `POST /a HTTP/1.1\r\nHost: 127.0.0.5:${port}\r\nContent-Length: ${body.length}\r\n\r\n${body}`;
  const second = `GET /extension HTTP/1.1\r\nHost: 127.0.0.5:${port}\r\nUpgrade: websocket\r\n\r\nHost: 127.0.0.5:${port}\r\n`;
  const third = `GET /other HTTP/1.1\r\nHost: evil.example:${port}\r\n\r\n`;
  const sent = first + second + third;
  const c = net.connect({ port, host: '127.0.0.5' });
  await new Promise((r) => c.once('connect', r));
  for (let i = 0; i < sent.length; i += 7) {
    c.write(sent.slice(i, i + 7));
    await new Promise((r) => setTimeout(r, 1));
  }
  await new Promise((r) => setTimeout(r, 100));
  c.destroy();
  const expected = sent
    .replace(`Host: 127.0.0.5:${port}\r\nContent-Length`, `Host: 127.0.0.1:${port}\r\nContent-Length`)
    .replace(`Host: 127.0.0.5:${port}\r\nUpgrade`, `Host: 127.0.0.1:${port}\r\nUpgrade`);
  assert.notEqual(expected, sent, 'fixture: something is rewritten');
  assert.equal(received, expected, 'heads rewritten; the body and the post-upgrade bytes untouched');
  assert.equal(proxy.stats.bytesUp, sent.length, 'counts what the browser sent');
});

test('proxy: an unreachable target is a counted failure, not a hang', async () => {
  const dead = net.createServer();
  await new Promise((r) => dead.listen(0, '127.0.0.1', r));
  const deadPort = dead.address().port;
  await new Promise((r) => dead.close(r));
  const events = [];
  const proxy = createCountingProxy({ listenPort: 0, targetPort: deadPort, onEvent: (e) => events.push(e) });
  const port = await proxy.listen();
  await new Promise((resolve) => {
    const c = net.connect({ port, host: '127.0.0.1' });
    c.on('close', resolve);
    c.on('error', () => {});
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(proxy.stats.connectionsFailed, 1);
  assert.equal(events.at(-1).type, 'fail');
  assert.equal(await probePort(deadPort, { timeoutMs: 300 }), false);
  await proxy.close();
});

test('tunnel: argv forwards loopback to loopback, refuses multiplexing, BatchMode on', () => {
  const cfg = normalizeConfig({ host: 'jon@dev004', innerPort: 19989 });
  const a = tunnelArgs(cfg, 19990);
  assert.deepEqual(a.slice(a.indexOf('-L'), a.indexOf('-L') + 2), ['-L', '127.0.0.1:19989:127.0.0.1:19990']);
  assert.deepEqual(a.slice(-2), ['--', 'jon@dev004']);
  for (const opt of ['BatchMode=yes', 'ExitOnForwardFailure=yes', 'ControlMaster=no', 'ServerAliveInterval=15']) {
    assert.ok(a.includes(opt), opt);
  }
  assert.ok(a.includes('-N'));
});

test('tunnel: backoff doubles to a 30 s cap', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(backoffMs), [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
});

function fakeSpawner() {
  const children = [];
  const spawnImpl = (cmd, args) => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 1000 + children.length;
    child.args = args;
    child.killedWith = null;
    child.kill = (sig) => { child.killedWith = sig; };
    children.push(child);
    return child;
  };
  return { children, spawnImpl };
}

test('tunnel: ssh exit → retrying with the reason, then respawns; stop kills only its own child', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { children, spawnImpl } = fakeSpawner();
  const cfg = normalizeConfig({ host: 'dev004', innerPort: 1 });
  const sup = new TunnelSupervisor(cfg, { spawnImpl });
  const states = [];
  sup.on('state', (s) => states.push(s.state));
  sup.start();
  assert.equal(children.length, 1);
  children[0].stderr.emit('data', 'Permission denied (publickey).\n');
  children[0].emit('exit', 255, null);
  assert.equal(sup.state, 'retrying');
  assert.match(sup.detail, /exit 255: Permission denied/);
  t.mock.timers.tick(1000);
  assert.equal(children.length, 2, 'respawned after the first backoff');
  sup.stop();
  assert.equal(children[1].killedWith, 'SIGTERM');
  assert.equal(children[0].killedWith, null, 'never signals a process it no longer owns');
  assert.equal(sup.state, 'stopped');
  t.mock.timers.tick(60_000);
  assert.equal(children.length, 2, 'no respawn after stop');
  assert.deepEqual(states.slice(0, 3), ['starting', 'retrying', 'starting']);
});

test('tunnel: retarget restarts the forward on the new remote port', () => {
  const { children, spawnImpl } = fakeSpawner();
  const sup = new TunnelSupervisor(normalizeConfig({ host: 'dev004', innerPort: 1 }), { spawnImpl });
  sup.start();
  sup.retarget(19991);
  assert.equal(children.length, 2);
  assert.equal(children[0].killedWith, 'SIGTERM');
  assert.ok(children[1].args.includes('127.0.0.1:1:127.0.0.1:19991'));
  sup.stop();
});

// Fixtures below are real browse 0.1.3 output, captured 2026-11-17.
const PAIR_OUT = `Pairing code: YCGB-NSHE
Open the Extensions menu → browse → Options, expand advanced (or click Pair with a code), enter YCGB-NSHE as the pairing code and localhost:29988 as the relay address, then click Connect. It works once, within 10 minutes.
Waiting up to 4s for that browser. Later, \`browse pair --list\` shows paired browsers.
! Pairing not confirmed. For a fresh code run \`browse pair\`.
`;

const STATUS_UP = {
  connected: false,
  pairingState: 'not-seen',
  relay: { version: '0.1.3', endpoint: 'http://127.0.0.1:29988', instanceId: 'x', pid: 42 },
  extension: { connected: false, pairingState: 'not-seen', browsers: [], activeTargets: 0, nextStep: 'pair it' },
  tabs: [],
  autoUpdate: { mode: 'off', effective: 'off', version: '0.1.3' },
  setup: { installed: false, version: '0.1.3', agents: [] },
};
const STATUS_DOWN = { relay: { running: false, endpoint: 'http://127.0.0.1:29988' }, setup: { installed: false, version: '0.1.3' } };

test('browse: pairing code and browse\'s own instruction line are extracted', () => {
  const p = parsePairOutput(PAIR_OUT);
  assert.equal(p.code, 'YCGB-NSHE');
  assert.match(p.instructions, /relay address/);
  assert.equal(parsePairOutput('error: relay not running'), null);
});

test('browse: status summary keeps unmeasured fields null, never healthy', () => {
  const up = summarizeStatus(STATUS_UP);
  assert.equal(up.relayRunning, true);
  assert.equal(up.relayPort, 29988);
  assert.equal(up.extensionConnected, false);
  assert.equal(up.autoUpdate, 'off');
  const down = summarizeStatus(STATUS_DOWN);
  assert.equal(down.relayRunning, false);
  assert.equal(down.extensionConnected, null);
  assert.equal(down.autoUpdate, null);
  assert.equal(summarizeStatus(null), null);
  assert.equal(endpointPort('garbage'), null);
});

test('overall state: every unknown input lands on unknown, not connected', () => {
  const base = { configured: true, wanted: true, tunnel: 'up', warnings: [] };
  assert.equal(computeOverall({ ...base, configured: false }), 'unconfigured');
  assert.equal(computeOverall({ ...base, wanted: false }), 'stopped');
  assert.equal(computeOverall({ ...base, wanted: false, fault: 'port taken' }), 'error');
  assert.equal(computeOverall({ ...base, tunnel: 'retrying' }), 'error');
  assert.equal(computeOverall({ ...base, tunnel: 'unknown', status: summarizeStatus(STATUS_UP) }), 'unknown');
  assert.equal(computeOverall({ ...base, status: null }), 'unknown');
  assert.equal(computeOverall({ ...base, status: summarizeStatus(STATUS_DOWN) }), 'relayIdle');
  assert.equal(computeOverall({ ...base, status: summarizeStatus(STATUS_UP) }), 'needsPairing');
  const connected = summarizeStatus({ ...STATUS_UP, extension: { ...STATUS_UP.extension, connected: true } });
  assert.equal(computeOverall({ ...base, status: connected }), 'ready');
  assert.equal(computeOverall({ ...base, status: connected, warnings: ['x'] }), 'warning');
  assert.equal(computeOverall({ ...base, status: { ...connected, extensionConnected: null } }), 'unknown');
});

function setupOut({ autoupdate = 'ok', version = '0.1.3', listen = ['127.0.0.1:29988'], status = STATUS_UP } = {}) {
  return [
    '@@BB@@ step install skip',
    `@@BB@@ step autoupdate ${autoupdate}`,
    '@@BB@@ step hostname ok',
    '@@BB@@ step restart ok',
    `@@BB@@ version ${version}`,
    '@@BB@@ listen-begin', ...listen, '@@BB@@ listen-end',
    '@@BB@@ status-begin', JSON.stringify(status, null, 2), '@@BB@@ status-end', '',
  ].join('\n');
}

test('setup verification: only a receiver-side clean read is ok', () => {
  assert.deepEqual(verifySetup(parseSetupOutput(setupOut()), { version: '0.1.3' }), []);
  const exposed = verifySetup(parseSetupOutput(setupOut({ listen: ['0.0.0.0:29988'] })), { version: '0.1.3' });
  assert.match(exposed.join('\n'), /beyond loopback \(0\.0\.0\.0\)/);
  const v6 = verifySetup(parseSetupOutput(setupOut({ listen: ['[::]:29988'] })), { version: '0.1.3' });
  assert.match(v6.join('\n'), /beyond loopback \(::\)/);
  const noListen = verifySetup(parseSetupOutput(setupOut({ listen: [] })), { version: '0.1.3' });
  assert.match(noListen.join('\n'), /nothing listening on relay port 29988/);
  const au = verifySetup(parseSetupOutput(setupOut({ status: { ...STATUS_UP, autoUpdate: { effective: 'on' } } })), { version: '0.1.3' });
  assert.match(au.join('\n'), /auto-update is on/);
  const ver = verifySetup(parseSetupOutput(setupOut({ version: '0.1.4' })), { version: '0.1.3' });
  assert.match(ver.join('\n'), /0\.1\.4, expected 0\.1\.3/);
  const garbage = verifySetup(parseSetupOutput('ssh: connect to host dev004 port 22: timed out'), { version: '0.1.3' });
  assert.ok(garbage.length >= 4, garbage.join('\n'));
});

test('stall: a traced call logs begin before it runs and end with its duration', () => {
  const log = new Logger();
  let now = 0;
  const clock = () => now;
  let ringDuring = null;
  const out = timed(log, 'tray.setContextMenu', () => { ringDuring = log.ring.map((e) => e.message); now += 4200; return 'ok'; }, { trace: true, clock });
  assert.equal(out, 'ok');
  assert.deepEqual(ringDuring, ['tray.setContextMenu: begin'], 'begin is on record before the call returns');
  assert.deepEqual(log.ring.map((e) => e.message), ['tray.setContextMenu: begin', 'tray.setContextMenu: end, 4200 ms']);
  assert.equal(log.ring[1].level, 'warn');
});

test('stall: an untraced fast call is silent; an untraced slow call logs its end; a throw is logged and rethrown', () => {
  const log = new Logger();
  let now = 0;
  const clock = () => now;
  timed(log, 'fast', () => { now += 5; }, { clock });
  assert.equal(log.ring.length, 0);
  timed(log, 'slow', () => { now += 80; }, { clock });
  assert.deepEqual(log.ring.map((e) => e.message), ['slow: end, 80 ms']);
  assert.throws(() => timed(log, 'bad', () => { throw new Error('boom'); }, { clock }), /boom/);
  assert.match(log.ring.at(-1).message, /bad: threw after 0 ms: boom/);
});

test('stall: lag monitor warns on a late tick, stays quiet on an on-time one, and is unref\'d and stoppable', () => {
  const log = new Logger();
  let now = 1000;
  let cb = null;
  let unrefd = false;
  let cleared = null;
  const handle = { unref() { unrefd = true; } };
  const mon = createLagMonitor(log, {
    intervalMs: 500, thresholdMs: 1000, clock: () => now,
    setTimer: (fn) => { cb = fn; return handle; },
    clearTimer: (h) => { cleared = h; },
  });
  mon.start();
  assert.equal(unrefd, true);
  now += 520; // 20 ms late: below threshold
  cb();
  assert.equal(log.ring.length, 0);
  now += 500 + 4200;
  cb();
  assert.equal(log.ring.length, 1);
  assert.equal(log.ring[0].level, 'warn');
  assert.equal(log.ring[0].message, 'main process stalled 4200 ms');
  mon.stop();
  assert.equal(cleared, handle);
});
