import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PINNED_BROWSE_VERSION, hostConfig, loadConfig, normalizeAppConfig, pairingAddress, saveConfig, suggestHostId } from '../src/core/config.js';
import { Logger } from '../src/core/log.js';
import { probePort } from '../src/core/proxy.js';
import { HOST_ACTIONS, HostManager, aggregateState, runHostAction } from '../src/core/hosts.js';

// ---------- config: migration ----------

test('config: a single-host config.json from an earlier release loads as a one-host list with the same values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bb-mig-'));
  const path = join(dir, 'config.json');
  const legacy = JSON.stringify({
    host: 'jon@dev004', localPort: 20000, remotePort: 29988, sshOptions: ['IdentityFile=/k'],
    autoConnect: false, pollSeconds: 5, browseVersion: '0.1.2',
  });
  writeFileSync(path, legacy);
  const app = loadConfig(path);
  assert.equal(app.pollSeconds, 5);
  assert.equal(app.browseVersion, '0.1.2');
  // A stored localPort is dropped (BBR-21): the extension must dial the relay's own port.
  assert.deepEqual(app.hosts, [{
    id: 'host-1', name: '', host: 'jon@dev004', transport: 'ssh', localAddress: '127.0.0.1', innerPort: 19989,
    remotePort: 29988, remoteBrowse: '$HOME/.local/bin/browse', sshOptions: ['IdentityFile=/k'], autoConnect: false,
    countActions: false, // BBR-22: an older config never opts in to decoding
  }]);
  // What the controller is handed: the pairing port is the relay port.
  const flat = hostConfig(app, 'host-1');
  assert.deepEqual(
    [flat.host, flat.transport, flat.localAddress, flat.localPort, flat.innerPort, flat.remotePort, flat.pollSeconds, flat.browseVersion, flat.autoConnect],
    ['jon@dev004', 'ssh', '127.0.0.1', 29988, 19989, 29988, 5, '0.1.2', false],
  );
  assert.equal(pairingAddress(flat), 'localhost:29988');
  assert.equal(readFileSync(path, 'utf8'), legacy, 'loading never rewrites the file');
  // The first save writes the list shape, still only non-defaults, and no localPort.
  saveConfig(path, app);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
    pollSeconds: 5, browseVersion: '0.1.2',
    hosts: [{ id: 'host-1', host: 'jon@dev004', remotePort: 29988, sshOptions: ['IdentityFile=/k'], autoConnect: false }],
  });
  assert.deepEqual(loadConfig(path), app, 'and loads back identically');
});

test('config: a multi-host config.json with a local port per host gets a loopback address per host (BBR-21)', () => {
  const app = normalizeAppConfig({ hosts: [
    { id: 'dev004', host: 'jon@dev004' },
    { id: 'dev001', host: 'jon@dev001', localPort: 19990, innerPort: 19991 },
    { id: 'bug', host: 'bug', localPort: 19992, innerPort: 19993 },
  ] });
  assert.deepEqual(app.hosts.map((h) => [h.id, h.localAddress, h.innerPort]), [
    ['dev004', '127.0.0.1', 19989], ['dev001', '127.0.0.2', 19991], ['bug', '127.0.0.3', 19993],
  ]);
  assert.deepEqual(app.hosts.map((h) => pairingAddress(hostConfig(app, h.id))), ['localhost:19988', '127.0.0.2:19988', '127.0.0.3:19988'],
    'the first host keeps the address its browser already paired with; every host dials its relay port');
});

test('config: new hosts get distinct addresses and inner ports; a stated one is never moved', () => {
  const app = normalizeAppConfig({ hosts: [{ host: 'a' }, { host: 'b' }, { host: 'c', localAddress: '127.0.0.2', innerPort: 19991 }] });
  assert.deepEqual(app.hosts.map((h) => [h.id, h.localAddress, h.innerPort]), [
    ['host-1', '127.0.0.1', 19989],
    ['host-2', '127.0.0.3', 19993],
    ['host-3', '127.0.0.2', 19991],
  ]);
  // Saved, then the first host removed: the second keeps its pairing address.
  const dir = mkdtempSync(join(tmpdir(), 'bb-alloc-'));
  const path = join(dir, 'config.json');
  saveConfig(path, app);
  const stored = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(stored.hosts[0], { id: 'host-1', host: 'a' }, 'the defaults are not stored');
  assert.deepEqual(stored.hosts[1], { id: 'host-2', host: 'b', localAddress: '127.0.0.3', innerPort: 19993 });
  writeFileSync(path, JSON.stringify({ hosts: stored.hosts.slice(1) }));
  assert.deepEqual(loadConfig(path).hosts.map((h) => [h.id, h.localAddress, h.innerPort]), [['host-2', '127.0.0.3', 19993], ['host-3', '127.0.0.2', 19991]]);
  // A local-transport host never gets 127.0.0.1: the relay itself listens there.
  assert.equal(normalizeAppConfig({ hosts: [{ id: 'l', transport: 'local' }] }).hosts[0].localAddress, '127.0.0.2');
});

// ---------- config: refusals ----------

test('config: two hosts binding the same address or inner port are refused, naming both', () => {
  assert.throws(
    () => normalizeAppConfig({ hosts: [{ id: 'a', localAddress: '127.0.0.5' }, { id: 'b', localAddress: '127.0.0.5' }] }),
    /localAddress 127\.0\.0\.5 is used twice: hosts "a" and "b"/,
  );
  assert.throws(
    () => normalizeAppConfig({ hosts: [{ id: 'a', innerPort: 20001 }, { id: 'b', innerPort: 20001 }] }),
    /127\.0\.0\.1:20001 is used twice: host "a" innerPort and host "b" innerPort/,
  );
  assert.throws(
    () => normalizeAppConfig({ hosts: [{ id: 'a', remotePort: 20000 }, { id: 'b', innerPort: 20000 }] }),
    /127\.0\.0\.1:20000 is used twice: host "a" localAddress and host "b" innerPort/,
  );
  // remotePort is on the remote host, so two hosts may share it: their addresses differ.
  const ok = normalizeAppConfig({ hosts: [{ id: 'a', remotePort: 19988 }, { id: 'b', remotePort: 19988 }] });
  assert.deepEqual(ok.hosts.map((h) => h.localAddress), ['127.0.0.1', '127.0.0.2']);
});

test('config: duplicate and malformed host ids are refused; per-host validation still applies', () => {
  assert.throws(() => normalizeAppConfig({ hosts: [{ id: 'a', host: 'x' }, { id: 'a', host: 'y' }] }), /two hosts have the id "a"/);
  assert.throws(() => normalizeAppConfig({ hosts: [{ id: 'AB12-CD34' }] }), /host id "AB12-CD34" must be lower-case/);
  assert.throws(() => normalizeAppConfig({ hosts: [{ id: 'a', host: '-oProxyCommand=evil' }] }), /host "a": host "-oProxyCommand=evil" is not a valid ssh destination/);
  assert.throws(() => normalizeAppConfig({ hosts: [{ id: 'a', remotePort: 5000, innerPort: 5000 }] }), /host "a": innerPort 5000 is the pairing port on 127\.0\.0\.1/);
  for (const bad of ['10.0.0.1', '127.0.0.0', '127.255.255.255', '127.0.0.256', 'localhost', '0.0.0.0']) {
    assert.throws(() => normalizeAppConfig({ hosts: [{ id: 'a', localAddress: bad }] }), /host "a": localAddress must be a loopback address/, bad);
  }
  assert.throws(() => normalizeAppConfig({ hosts: [{ id: 'l', transport: 'local', localAddress: '127.0.0.1' }] }), /needs its own loopback address/);
  assert.throws(() => normalizeAppConfig({ hosts: 'dev004' }), /hosts must be a list/);
});

test('config: an invalid config is refused before anything is written', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bb-refuse-'));
  const path = join(dir, 'config.json');
  assert.throws(() => saveConfig(path, { hosts: [{ id: 'a' }, { id: 'a' }] }), /two hosts have the id/);
  assert.equal(existsSync(path), false);
});

// ---------- logs ----------

test('log: a host-tagged line carries the tag and still never carries a pairing code', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bb-tag-'));
  const file = join(dir, 'app.log');
  const log = new Logger({ file });
  const dev = log.forHost('dev004');
  dev.info('pair', 'Pairing code: YCGB-NSHE enter it');
  dev.log('warn', 'tunnel', 'retry AB12-CD34');
  const text = readFileSync(file, 'utf8');
  assert.match(text, /INFO  \[dev004\/pair\] Pairing code: \*\*\*\*-\*\*\*\* enter it/);
  assert.match(text, /WARN  \[dev004\/tunnel\] retry \*\*\*\*-\*\*\*\*/);
  assert.ok(!text.includes('YCGB-NSHE') && !text.includes('AB12-CD34'));
  assert.deepEqual(log.ring.map((e) => [e.host, e.source, e.message]), [
    ['dev004', 'pair', 'Pairing code: ****-**** enter it'],
    ['dev004', 'tunnel', 'retry ****-****'],
  ]);
  log.info('app', 'untagged');
  assert.equal(log.ring.at(-1).host, undefined);
  assert.match(readFileSync(file, 'utf8'), /INFO  \[app\] untagged/);
});

// ---------- aggregate ----------

test('aggregate: up means the bridge runs (a host waiting for a browser counts), stopped counts as down', () => {
  const up = { overall: 'needsPairing', connected: true, tunnel: { state: 'up' } };
  const ready = { overall: 'ready', connected: true, tunnel: { state: 'up' } };
  const stopped = { overall: 'stopped', connected: false, tunnel: { state: 'stopped' } };
  const retrying = { overall: 'error', connected: true, tunnel: { state: 'retrying' } };
  const unconfigured = { overall: 'unconfigured', connected: false, tunnel: { state: 'stopped' } };
  assert.equal(aggregateState([]), 'none');
  assert.equal(aggregateState([unconfigured]), 'none');
  assert.equal(aggregateState([up, ready, unconfigured]), 'allUp');
  assert.equal(aggregateState([up, stopped]), 'someDown');
  assert.equal(aggregateState([retrying, stopped]), 'allDown');
  assert.equal(aggregateState([retrying, retrying]), 'allDown');
  // Stopped on purpose is its own state; an unconfigured host beside it does not change that.
  assert.equal(aggregateState([stopped, stopped, unconfigured]), 'stopped');
  assert.equal(aggregateState([up, ready]), 'allUp');
});

// ---------- HostManager ----------

/** Ports nothing listens on: bind :0, read the port, close. */
async function freePorts(n) {
  const servers = await Promise.all(Array.from({ length: n }, () => new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => resolve(s));
  })));
  const ports = servers.map((s) => s.address().port);
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  return ports;
}

/**
 * Hosts on the "local" transport whose browse is /bin/false: the proxy binds
 * for real, the status poll fails harmlessly, and nothing leaves this machine.
 */
const ADDR = { a: '127.0.0.2', b: '127.0.0.3' };
function localHost(id, [port, innerPort], localAddress = ADDR[id]) {
  // The pairing port is the relay port (BBR-21), so remotePort is the port this host listens on.
  return { id, transport: 'local', remoteBrowse: '/bin/false', localAddress, innerPort, remotePort: port, autoConnect: true };
}
const probeAt = (id, port) => probePort(port, { host: ADDR[id], timeoutMs: 500 });

function manager(t) {
  const logger = new Logger();
  const mgr = new HostManager({ logger, localEnv: { PATH: '/usr/bin:/bin', HOME: tmpdir() } });
  t.after(() => mgr.stopAll());
  return { mgr, logger };
}

test('hosts: two hosts bridge on their own ports; stopping one leaves the other running', async (t) => {
  const p = await freePorts(6);
  const { mgr, logger } = manager(t);
  const tagged = [];
  mgr.on('change', (snap) => tagged.push(snap.id));
  const res = await mgr.apply({ pollSeconds: 60, hosts: [localHost('a', p.slice(0, 3)), localHost('b', p.slice(3, 6))] });
  assert.deepEqual(res, { added: ['a', 'b'], changed: [], removed: [] });
  assert.deepEqual(mgr.ids(), ['a', 'b']);
  const a = mgr.get('a');
  const b = mgr.get('b');
  assert.notEqual(a, b);
  assert.equal(mgr.primary(), a);
  assert.equal(await probeAt('a', p[0]), true, 'a listens on its address, on its relay port');
  assert.equal(await probeAt('b', p[3]), true, 'b listens on its address, on its relay port');
  assert.equal(mgr.snapshot().overall, 'allUp');
  assert.deepEqual(mgr.snapshot().hosts.map((h) => [h.id, h.localPort, h.connected]), [['a', p[0], true], ['b', p[3], true]]);
  assert.ok(tagged.includes('a') && tagged.includes('b'), 'change events name their host');
  assert.ok(logger.ring.some((e) => e.host === 'a' && e.message === 'connecting to local relay'), 'controller lines are tagged');

  const bProxy = b.proxy;
  await a.disconnect();
  assert.equal(await probeAt('a', p[0]), false, 'a stopped');
  assert.equal(b.proxy, bProxy, 'b keeps its proxy');
  assert.equal(b.snapshot().connected, true);
  assert.equal(await probeAt('b', p[3]), true, 'b still listens');
  assert.equal(mgr.snapshot().overall, 'someDown');
});

test('hosts: one host failing to bind its port does not stop the other', async (t) => {
  const p = await freePorts(6);
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(p[0], ADDR.a, r));
  t.after(() => blocker.close());
  const { mgr } = manager(t);
  await mgr.apply({ pollSeconds: 60, hosts: [localHost('a', p.slice(0, 3)), localHost('b', p.slice(3, 6))] });
  const [sa, sb] = mgr.snapshot().hosts;
  assert.equal(sa.overall, 'error');
  assert.match(sa.tunnel.detail, new RegExp(`127\\.0\\.0\\.2:${p[0]} is in use`));
  assert.equal(sb.connected, true);
  assert.equal(sb.tunnel.state, 'up');
  assert.equal(await probeAt('b', p[3]), true);
  assert.equal(mgr.snapshot().overall, 'someDown');
});

/** A stand-in for spawn: records ssh children and never starts a process. */
function fakeSpawner() {
  const children = [];
  const spawnImpl = (cmd, args) => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 2000 + children.length;
    child.cmd = cmd;
    child.args = args;
    child.killedWith = null;
    child.kill = (sig) => { child.killedWith = sig; };
    children.push(child);
    return child;
  };
  return { children, spawnImpl };
}

test('hosts: one host\'s tunnel failing leaves the other host\'s bridge untouched', async (t) => {
  // Mocked setTimeout: the status polls (which would run a real ssh) never fire, and the tunnel's
  // retry backoff advances only on tick. The ssh tunnel itself is the fake spawner's.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const p = await freePorts(6);
  const { children, spawnImpl } = fakeSpawner();
  const mgr = new HostManager({ logger: new Logger(), localEnv: { PATH: '/usr/bin:/bin', HOME: tmpdir() }, spawnImpl });
  t.after(() => mgr.stopAll());
  const sshHost = { id: 'a', host: 'dev004', localAddress: '127.0.0.4', innerPort: p[1], remotePort: p[2], autoConnect: true };
  await mgr.apply({ pollSeconds: 60, hosts: [sshHost, localHost('b', p.slice(3, 6))] });
  assert.equal(children.length, 1, 'only host a has an ssh tunnel');
  assert.equal(children[0].args.at(-1), 'dev004');
  const b = mgr.get('b');
  const bProxy = b.proxy;
  const bBefore = b.snapshot();
  assert.deepEqual([bBefore.overall === 'error', bBefore.connected, bBefore.tunnel.state], [false, true, 'up']);

  children[0].stderr.emit('data', 'ssh: connect to host dev004 port 22: Connection refused\n');
  children[0].emit('exit', 255, null);
  const a = mgr.snapshot().hosts[0];
  assert.equal(a.tunnel.state, 'retrying');
  assert.equal(a.overall, 'error');
  assert.match(a.tunnel.detail, /exit 255: dev004 refused the connection on port 22/);
  assert.equal(a.problem?.kind, 'refused', 'the host\'s snapshot carries the guidance for the message bar and tray');
  assert.equal(mgr.snapshot().hosts[1].problem, null, 'the other host carries none');

  const check = async () => {
    assert.equal(mgr.get('b'), b, 'b is the same controller');
    assert.equal(b.proxy, bProxy, 'with the same proxy');
    const bNow = b.snapshot();
    assert.deepEqual([bNow.overall, bNow.connected, bNow.tunnel], [bBefore.overall, true, bBefore.tunnel], 'b\'s state is unchanged');
    assert.equal(await probeAt('b', p[3]), true, 'b still listens');
  };
  await check();
  assert.equal(mgr.snapshot().overall, 'someDown');

  t.mock.timers.tick(1000);
  assert.equal(children.length, 2, 'a retries on its own backoff');
  await check();
});

test('hosts: kick reconnects every wanted host at once, leaves a stopped one alone, and debounces (BBR-38)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const p = await freePorts(6);
  const { children, spawnImpl } = fakeSpawner();
  let clock = 1_000_000;
  const logger = new Logger();
  const mgr = new HostManager({ logger, localEnv: { PATH: '/usr/bin:/bin', HOME: tmpdir() }, spawnImpl, now: () => clock });
  t.after(() => mgr.stopAll());
  const ssh = (id, addr, [inner, remote]) => ({ id, host: `dev-${id}`, localAddress: addr, innerPort: inner, remotePort: remote, autoConnect: true });
  await mgr.apply({
    pollSeconds: 60,
    hosts: [ssh('a', '127.0.0.4', p.slice(0, 2)), localHost('b', p.slice(2, 4)), ssh('c', '127.0.0.5', p.slice(4, 6))],
  });
  // Never a real ssh: from here on record each controller's master close and poll instead.
  // (connect() armed a poll at 0 ms; the ticks below would fire it.)
  const events = [];
  for (const id of mgr.ids()) {
    const ctl = mgr.get(id);
    ctl.transport = () => ({ closeMaster: async () => { events.push(`close ${id}`); } });
    ctl.pollNow = async () => { events.push(`poll ${id}`); };
  }
  const flush = () => new Promise((r) => setImmediate(r));
  const forHost = (id) => children.filter((c) => c.args.at(-1) === `dev-${id}`);
  assert.deepEqual([forHost('a').length, forHost('c').length], [1, 1]);
  await mgr.get('c').disconnect();
  assert.equal(mgr.get('c').wanted, false, 'c is stopped by the user');

  // Host a's forward fails until it waits out the 30 s cap.
  for (let n = 1; n <= 6; n++) {
    forHost('a').at(-1).emit('exit', 255, null);
    if (n < 6) t.mock.timers.tick(2 ** (n - 1) * 1000);
  }
  assert.match(mgr.get('a').tunnel.detail, /retry in 30s$/);
  assert.equal(forHost('a').length, 6);
  await flush();
  events.length = 0; // the set-up's own poll and c's disconnect

  assert.deepEqual(mgr.kick('resume'), ['a', 'b']);
  assert.equal(forHost('a').length, 7, 'a respawns ssh at once');
  assert.equal(mgr.get('a').tunnel.failures, 0, 'with its backoff reset');
  assert.equal(forHost('c').length, 1, 'the stopped host is not restarted');
  await flush();
  assert.deepEqual(events, ['close a', 'close b', 'poll a', 'poll b'], 'each wanted host polls now, on a fresh status master');
  assert.ok(logger.ring.some((e) => e.source === 'power' && e.message === 'resume: reconnecting a, b'), 'one line names the reason');
  assert.equal(await mgr.get('c').kick(), false, 'a stopped controller refuses a kick of its own');
  assert.equal(events.length, 4, 'and neither closes a master nor polls');

  clock += 2000;
  assert.equal(mgr.kick('unlock-screen'), null, 'a second kick 2 s later is skipped');
  await flush();
  assert.equal(forHost('a').length, 7, 'one restart per host, not two');
  assert.equal(events.length, 4, 'and one poll');
  assert.ok(logger.ring.some((e) => e.source === 'power' && /^unlock-screen: .*skipped$/.test(e.message)));

  clock += 10_000;
  assert.deepEqual(mgr.kick('resume'), ['a', 'b'], 'a kick after the debounce window acts again');
  assert.equal(forHost('a').length, 8);
  assert.equal(forHost('c').length, 1);
});

test('hosts: apply() with one host changed replaces only that one; a removed host is stopped', async (t) => {
  const p = await freePorts(9);
  const { mgr } = manager(t);
  const hostA = localHost('a', p.slice(0, 3));
  await mgr.apply({ pollSeconds: 60, hosts: [hostA, localHost('b', p.slice(3, 6))] });
  const a = mgr.get('a');
  const aProxy = a.proxy;
  const oldB = mgr.get('b');

  const res = await mgr.apply({ pollSeconds: 60, hosts: [hostA, localHost('b', p.slice(6, 9))] });
  assert.deepEqual(res, { added: [], changed: ['b'], removed: [] });
  assert.equal(mgr.get('a'), a, 'a is the same controller');
  assert.equal(a.proxy, aProxy, 'with the same proxy, never restarted');
  assert.notEqual(mgr.get('b'), oldB, 'b was replaced');
  assert.equal(oldB.wanted, false, 'the old b was stopped');
  assert.equal(await probeAt('b', p[3]), false, 'b left its old port');
  assert.equal(await probeAt('b', p[6]), true, 'b reconnected on its new port');

  const again = await mgr.apply({ pollSeconds: 60, hosts: [hostA, localHost('b', p.slice(6, 9))] });
  assert.deepEqual(again, { added: [], changed: [], removed: [] }, 'an identical config restarts nothing');

  const gone = await mgr.apply({ pollSeconds: 60, hosts: [hostA] });
  assert.deepEqual(gone.removed, ['b']);
  assert.equal(await probeAt('b', p[6]), false, 'a removed host stops listening');
  assert.equal(mgr.get('a'), a);
});

test('hosts: two hosts swapping addresses and ports in one apply both come back up', async (t) => {
  const p = await freePorts(6);
  const { mgr } = manager(t);
  await mgr.apply({ pollSeconds: 60, hosts: [localHost('a', p.slice(0, 3)), localHost('b', p.slice(3, 6))] });
  await mgr.apply({ pollSeconds: 60, hosts: [localHost('a', p.slice(3, 6), ADDR.b), localHost('b', p.slice(0, 3), ADDR.a)] });
  assert.deepEqual(mgr.snapshot().hosts.map((h) => [h.id, h.localPort, h.overall === 'error']), [['a', p[3], false], ['b', p[0], false]]);
});

test('hosts: editing the first host saves and applies it; an invalid edit changes nothing', async (t) => {
  const p = await freePorts(9);
  const dir = mkdtempSync(join(tmpdir(), 'bb-edit-'));
  const path = join(dir, 'config.json');
  const { mgr } = manager(t);
  await mgr.apply({ pollSeconds: 60, hosts: [localHost('a', p.slice(0, 3)), localHost('b', p.slice(3, 6))] });
  const b = mgr.get('b');
  const save = (cfg) => saveConfig(path, cfg);

  const flat = await mgr.editHost('a', { remotePort: p[6], innerPort: p[7], id: 'hijack' }, save);
  assert.equal(flat.id, 'a', 'the id is not editable through the form');
  assert.equal(flat.localPort, p[6], 'the pairing port follows the relay port');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).hosts[0].remotePort, p[6]);
  assert.equal(mgr.get('b'), b, 'the other host is untouched');
  assert.equal(await probeAt('a', p[6]), true);

  const before = readFileSync(path, 'utf8');
  const a = mgr.get('a');
  await assert.rejects(mgr.editHost('a', { localAddress: ADDR.b }, save), /localAddress 127\.0\.0\.3 is used twice/);
  assert.equal(readFileSync(path, 'utf8'), before, 'nothing written');
  assert.equal(mgr.get('a'), a, 'nothing restarted');
});

// ---------- the window's host list: add, remove, per-host actions (BBR-13) ----------

/** A HostManager whose controllers are stubs that record each call: no ports, no ssh. */
function stubManager() {
  const calls = [];
  const createController = ({ config }) => {
    const c = new EventEmitter();
    const call = (name, ret) => async (...args) => { calls.push([config.id, name, ...args]); return ret; };
    Object.assign(c, {
      cfg: config,
      wanted: false,
      configured: Boolean(config.host),
      connect: call('connect'),
      disconnect: call('disconnect'),
      setupRemote: call('setupRemote', { ok: true }),
      pair: call('pair', { code: 'ABCD-EF12', address: pairingAddress(config) }),
      startRelay: call('startRelay', true),
      relayLog: call('relayLog', `relay log of ${config.id}`),
      schedulePoll: (...args) => { calls.push([config.id, 'schedulePoll', ...args]); },
      snapshot: () => ({ id: config.id, localPort: config.localPort, overall: 'stopped' }),
      changed: () => {},
    });
    return c;
  };
  return { mgr: new HostManager({ logger: new Logger(), createController }), calls };
}

const sshHost = (id, localAddress, innerPort) => ({ id, host: `jon@${id}.invalid`, localAddress, innerPort, autoConnect: false });

test('hosts: an added host gets the allocator\'s next free address and inner port, filling a gap, and is saved', async () => {
  const { mgr } = stubManager();
  const path = join(mkdtempSync(join(tmpdir(), 'bb-add-')), 'config.json');
  const save = (cfg) => saveConfig(path, cfg);
  await mgr.apply({ hosts: [sshHost('dev004', '127.0.0.1', 19989), sshHost('dev005', '127.0.0.3', 19993)] });

  const added = await mgr.addHost({ host: 'jon@dev006.example.com', autoConnect: false }, save);
  assert.deepEqual([added.id, added.localAddress, added.innerPort], ['dev006', '127.0.0.2', 19991]);
  assert.deepEqual(mgr.ids(), ['dev004', 'dev005', 'dev006']);
  assert.ok(mgr.get('dev006'), 'a controller was created for it');
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).hosts[2], { id: 'dev006', host: 'jon@dev006.example.com', localAddress: '127.0.0.2', innerPort: 19991, autoConnect: false });

  const next = await mgr.addHost({ host: 'jon@dev006.other' }, save);
  assert.deepEqual([next.id, next.localAddress, next.innerPort], ['dev006-2', '127.0.0.4', 19995], 'a second dev006 gets a suffix and the next free ones');
});

test('hosts: an added host that clashes is refused with the config\'s message; nothing is written or started', async () => {
  const { mgr } = stubManager();
  const path = join(mkdtempSync(join(tmpdir(), 'bb-add-bad-')), 'config.json');
  const save = (cfg) => saveConfig(path, cfg);
  await mgr.apply({ hosts: [sshHost('dev004', '127.0.0.1', 19989)] });
  await assert.rejects(mgr.addHost({ id: 'dev004', host: 'jon@x' }, save), /two hosts have the id "dev004"/);
  await assert.rejects(mgr.addHost({ host: '-oProxyCommand=evil' }, save), /is not a valid ssh destination/);
  await assert.rejects(mgr.addHost({ host: 'jon@y', localAddress: '127.0.0.1' }, save), /localAddress 127\.0\.0\.1 is used twice/);
  await assert.rejects(mgr.addHost({ host: 'jon@z', innerPort: 19989 }, save), /127\.0\.0\.1:19989 is used twice/);
  assert.equal(existsSync(path), false, 'nothing written');
  assert.deepEqual(mgr.ids(), ['dev004']);
});

test('hosts: a new poll interval from General is saved and reaches every controller without restarting one (BBR-45)', async () => {
  const { mgr, calls } = stubManager();
  const path = join(mkdtempSync(join(tmpdir(), 'bb-app-')), 'config.json');
  const save = (cfg) => saveConfig(path, cfg);
  await mgr.apply({ hosts: [sshHost('dev004', '127.0.0.1', 19989), sshHost('dev005', '127.0.0.2', 19991)] });
  const [a, b] = [mgr.get('dev004'), mgr.get('dev005')];
  calls.length = 0;

  // browseVersion is read-only in the window: an ipc caller cannot move the pin through editApp.
  const res = await mgr.editApp({ pollSeconds: 30, browseVersion: '9.9.9', hosts: [] }, save);
  assert.deepEqual(res, { pollSeconds: 30, browseVersion: PINNED_BROWSE_VERSION });
  const stored = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(stored.pollSeconds, 30);
  assert.equal('browseVersion' in stored, false, 'the pin is not written');
  assert.deepEqual(stored.hosts.map((h) => h.id), ['dev004', 'dev005'], 'the hosts are kept');
  assert.equal(mgr.get('dev004'), a, 'dev004 keeps its controller');
  assert.equal(mgr.get('dev005'), b, 'dev005 keeps its controller');
  // No disconnect or connect: only each pending poll is re-armed, so a shorter interval applies at once.
  assert.deepEqual(calls, [['dev004', 'schedulePoll'], ['dev005', 'schedulePoll']], 'no tunnel was disconnected or reconnected');
  assert.deepEqual([a.cfg.pollSeconds, b.cfg.pollSeconds], [30, 30], 'each controller polls at the new interval');
  assert.equal(mgr.config.pollSeconds, 30);

  // Any other change to a host still rebuilds it.
  await mgr.editHost('dev005', { remotePort: 20088 }, save);
  assert.notEqual(mgr.get('dev005'), b, 'a changed relay port rebuilds the controller');
  assert.equal(mgr.get('dev005').cfg.pollSeconds, 30);
});

test('hosts: removing a host stops only that host; the last host cannot be removed', async () => {
  const { mgr, calls } = stubManager();
  const path = join(mkdtempSync(join(tmpdir(), 'bb-rm-')), 'config.json');
  const save = (cfg) => saveConfig(path, cfg);
  await mgr.apply({ hosts: [sshHost('dev004', '127.0.0.1', 19989), sshHost('dev005', '127.0.0.2', 19991)] });
  const a = mgr.get('dev004');
  await mgr.removeHost('dev005', save);
  assert.deepEqual(mgr.ids(), ['dev004']);
  assert.equal(mgr.get('dev005'), null);
  assert.equal(mgr.get('dev004'), a, 'the other host is the same controller');
  assert.deepEqual(calls, [['dev005', 'disconnect']]);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).hosts.map((h) => h.id), ['dev004']);
  await assert.rejects(mgr.removeHost('dev004', save), /the last host cannot be removed/);
  await assert.rejects(mgr.removeHost('ghost', save), /no host with id "ghost"/);
  assert.deepEqual(mgr.ids(), ['dev004']);
});

test('hosts: every window action goes to the host it names and to no other; an unknown host never falls back', async () => {
  const { mgr, calls } = stubManager();
  await mgr.apply({ hosts: [sshHost('dev004', '127.0.0.1', 19989), sshHost('dev005', '127.0.0.2', 19991)] });
  const results = {};
  for (const action of Object.keys(HOST_ACTIONS)) results[action] = await runHostAction(mgr, action, 'dev005');
  assert.deepEqual(calls, [
    ['dev005', 'connect'], ['dev005', 'disconnect'], ['dev005', 'setupRemote'], ['dev005', 'pair'], ['dev005', 'startRelay'], ['dev005', 'relayLog', 200],
  ]);
  assert.equal(results.pair.address, '127.0.0.2:19988');
  assert.equal(results.relayLog, 'relay log of dev005');
  assert.throws(() => runHostAction(mgr, 'connect', 'ghost'), /no host with id "ghost"/);
  assert.throws(() => runHostAction(mgr, 'connect', undefined), /no host with id "undefined"/);
  assert.throws(() => runHostAction(mgr, 'constructor', 'dev004'), /no host action "constructor"/);
  assert.equal(calls.length, 6, 'nothing else was called');
});

test('hosts: a snapshot taken from a change event while apply() is mid-way skips hosts not created yet (BBR-14)', async () => {
  const seen = [];
  const createController = ({ config }) => {
    const c = new EventEmitter();
    Object.assign(c, {
      cfg: config, wanted: false, configured: true,
      connect: async () => {}, disconnect: async () => {},
      snapshot: () => ({ id: config.id, overall: 'stopped', connected: false, tunnel: { state: 'stopped' } }),
      changed: () => c.emit('change', c.snapshot()),
    });
    return c;
  };
  const mgr = new HostManager({ logger: new Logger(), createController });
  // The tray recomputes the aggregate from every change event.
  mgr.on('change', () => seen.push(mgr.snapshot().hosts.map((h) => h.id)));
  await mgr.apply({ hosts: [sshHost('dev004', '127.0.0.1', 19989), sshHost('dev005', '127.0.0.2', 19991)] });
  assert.deepEqual(seen, [['dev004'], ['dev004', 'dev005']]);
  assert.equal(mgr.snapshot().overall, 'stopped');
});

test('config: a suggested host id comes from the name or the ssh destination and never collides', () => {
  assert.equal(suggestHostId({ host: 'jon@dev005.example.com' }), 'dev005');
  assert.equal(suggestHostId({ host: 'dev004:2222' }), 'dev004');
  assert.equal(suggestHostId({ name: 'Build Box!', host: 'jon@b' }), 'build-box');
  assert.equal(suggestHostId({ host: 'jon@dev005' }, ['dev005', 'dev005-2']), 'dev005-3');
  assert.equal(suggestHostId({ host: '' }), '');
  assert.equal(suggestHostId({ name: '---' }), '');
});
