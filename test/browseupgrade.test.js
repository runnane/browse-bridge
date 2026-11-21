import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PINNED_BROWSE_VERSION, hostConfig, loadConfig, normalizeAppConfig, saveConfig, withHostAdded, withHostBrowseVersion, withHostEdits,
} from '../src/core/config.js';
import { Controller } from '../src/core/controller.js';
import { HostManager } from '../src/core/hosts.js';
import { ROLLBACK_BROWSE_LABEL, SETUP_LABEL } from '../src/core/labels.js';
import { Logger } from '../src/core/log.js';

const PIN = PINNED_BROWSE_VERSION;
const NEW = '0.1.6';

// ---------- the per-host override in the config (BBR-41) ----------

const twoHosts = (extra = {}) => ({ hosts: [
  { id: 'canary', host: 'u@canary.invalid', autoConnect: false, ...extra },
  { id: 'steady', host: 'u@steady.invalid', autoConnect: false },
] });

test('config: a host with its own browseVersion runs that; every other host follows the pin', () => {
  const app = normalizeAppConfig(twoHosts({ browseVersion: NEW }));
  assert.equal(app.browseVersion, PIN, 'the app-wide pin is unchanged');
  assert.equal(app.hosts[0].browseVersion, NEW);
  assert.equal('browseVersion' in app.hosts[1], false, 'a host without one carries none, so it follows a later pin');
  const canary = hostConfig(app, 'canary');
  const steady = hostConfig(app, 'steady');
  assert.deepEqual([canary.browseVersion, canary.pinnedBrowseVersion], [NEW, PIN]);
  assert.deepEqual([steady.browseVersion, steady.pinnedBrowseVersion], [PIN, PIN]);
});

test('config: a host browseVersion that is not a stable x.y.z is refused before anything runs', () => {
  for (const bad of ['0.1.6-dev.254', '0.1.6; rm -rf ~', 'latest', '^0.1.4']) {
    assert.throws(() => normalizeAppConfig(twoHosts({ browseVersion: bad })), /host "canary": browseVersion must be a stable version/, bad);
  }
});

test('config: the override is written while set and dropped by Roll back; one equal to the pin is no override', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'bb-ver-')), 'config.json');
  const app = saveConfig(path, withHostBrowseVersion(normalizeAppConfig(twoHosts()), 'canary', NEW));
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).hosts.map((h) => h.browseVersion), [NEW, undefined]);
  assert.equal(hostConfig(loadConfig(path), 'canary').browseVersion, NEW, 'and loads back');

  saveConfig(path, withHostBrowseVersion(app, 'canary', null));
  assert.equal('browseVersion' in JSON.parse(readFileSync(path, 'utf8')).hosts[0], false);
  assert.equal('browseVersion' in withHostBrowseVersion(app, 'canary', PIN).hosts[0], false);
  assert.throws(() => withHostBrowseVersion(app, 'ghost', NEW), /no host with id "ghost"/);
});

test('config: the Settings form and Add Host cannot set a host\'s browse version; only Upgrade and Roll back can', () => {
  const app = normalizeAppConfig(twoHosts({ browseVersion: NEW }));
  const edited = normalizeAppConfig(withHostEdits(app, 'steady', { name: 'x', browseVersion: '9.9.9' }));
  assert.equal('browseVersion' in edited.hosts[1], false, 'an edit ignores it');
  assert.equal(normalizeAppConfig(withHostEdits(app, 'canary', { name: 'y' })).hosts[0].browseVersion, NEW, 'and keeps an override the host has');
  const added = normalizeAppConfig(withHostAdded(app, { host: 'u@new.invalid', browseVersion: '9.9.9' }));
  assert.equal('browseVersion' in added.hosts[2], false, 'an added host follows the pin');
});

test('config: the single-host shape\'s top-level browseVersion stays the app pin, not a host override', () => {
  const app = normalizeAppConfig({ host: 'u@old.invalid', browseVersion: '0.1.2' });
  assert.equal(app.browseVersion, '0.1.2');
  assert.equal('browseVersion' in app.hosts[0], false);
});

// ---------- the controller: upgrade, roll back, verification at the receiver ----------

function setupOut({ version, listen = ['127.0.0.1:19988'], autoupdate = 'ok' }) {
  return [
    '@@BB@@ step install ok', `@@BB@@ step autoupdate ${autoupdate}`, '@@BB@@ step hostname ok', '@@BB@@ step restart ok',
    `@@BB@@ version ${version}`,
    '@@BB@@ listen-begin', ...listen, '@@BB@@ listen-end',
    '@@BB@@ status-begin', JSON.stringify(statusJson({ connected: false })), '@@BB@@ status-end', '',
  ].join('\n');
}

/** `browse status --json`. `version` absent: this relay does not say what it runs, so only setup's own read checks it. */
function statusJson({ connected, version = null }) {
  return {
    relay: { running: true, pid: 4242, endpoint: 'http://127.0.0.1:19988', ...(version ? { version } : {}) },
    extension: { connected },
    autoUpdate: { effective: 'off' },
  };
}

/**
 * A transport that never runs anything: `script` answers with setup output
 * reporting `reported`, `browse` with each of `statuses` in turn (the last
 * one repeats). Every call is recorded.
 */
function fakeTransport({ reported, statuses = [statusJson({ connected: true })] }) {
  const calls = { script: [], browse: 0 };
  const queue = [...statuses];
  return {
    calls,
    transport: {
      kind: 'fake',
      script: async (_body, args) => {
        calls.script.push(args);
        return { code: 0, signal: null, stdout: setupOut({ version: reported }), stderr: '', timedOut: false };
      },
      browse: async () => {
        calls.browse++;
        const s = queue.length > 1 ? queue.shift() : queue[0];
        return { code: 0, signal: null, stdout: JSON.stringify(s), stderr: '', timedOut: false };
      },
      closeMaster: async () => null,
    },
  };
}

/** A controller for host "canary" as the app would build it, connected with a browser, its I/O faked. */
function canary({ browseVersion = NEW, reported, statuses, connectedBefore = true, timeoutMs = 9_000, intervalMs = 3_000 }) {
  const logger = new Logger();
  const app = normalizeAppConfig(twoHosts(browseVersion ? { browseVersion } : {}));
  const slept = [];
  const ctl = new Controller({
    config: hostConfig(app, 'canary'), logger: logger.forHost('canary'),
    reconnectTimeoutMs: timeoutMs, reconnectIntervalMs: intervalMs, sleep: async (ms) => { slept.push(ms); },
  });
  const fake = fakeTransport({ reported, statuses });
  ctl.transport = () => fake.transport;
  ctl.pollNow = async () => {}; // the regular poll is not under test here
  ctl.wanted = true;
  ctl.tunnelState = { state: 'up', detail: '' };
  // What the last poll saw: a relay that does not report its version, and a browser connected or not.
  ctl.status = { relayRunning: true, relayPort: 19988, relayVersion: null, extensionConnected: connectedBefore, autoUpdate: 'off' };
  return { ctl, logger, calls: fake.calls, slept };
}

test('controller: an upgrade whose receiver reports the wrong version is a problem on the host, not a success', async () => {
  const { ctl, logger, calls } = canary({ reported: PIN, statuses: [statusJson({ connected: true })] });
  const res = await ctl.changeBrowse('upgrade');
  assert.deepEqual(calls.script, [['$HOME/.local/bin/browse', NEW]], 'setup ran with the chosen version as its second argument');
  assert.equal(res.ok, false);
  assert.ok(res.problems.includes(`browse version is ${PIN}, expected ${NEW}`), res.problems.join('; '));
  const snap = ctl.snapshot();
  assert.equal(snap.browseChange.ok, false, 'the snapshot keeps the failed outcome');
  assert.equal(snap.browseChange.action, 'upgrade');
  assert.ok(snap.warnings.some((w) => w.startsWith(`Upgrade to browse ${NEW} did not verify: browse version is ${PIN}`) && w.includes(`"${ROLLBACK_BROWSE_LABEL}"`)), snap.warnings.join('\n'));
  assert.equal(snap.overall, 'warning', 'a connected host with a failed upgrade is not shown as plain Connected');
  assert.ok(logger.ring.some((e) => e.host === 'canary' && e.level === 'error' && e.message === `upgrade to browse ${NEW}: browse version is ${PIN}, expected ${NEW}`), 'the host\'s log has it');
  assert.equal(snap.busy, null);
});

test('controller: a relay that reports another version after the restart fails the upgrade though setup read the right one', async () => {
  const { ctl } = canary({ reported: NEW, statuses: [statusJson({ connected: true, version: PIN })] });
  const res = await ctl.changeBrowse('upgrade');
  assert.equal(res.ok, false);
  assert.deepEqual(res.problems, [`the relay reports browse ${PIN}, expected ${NEW}`]);
});

test('controller: a browser that was connected and does not come back within the timeout fails the upgrade', async () => {
  const { ctl, calls, slept } = canary({ reported: NEW, statuses: [statusJson({ connected: false })], timeoutMs: 9_000, intervalMs: 3_000 });
  const res = await ctl.changeBrowse('upgrade');
  assert.equal(res.ok, false);
  assert.deepEqual(res.problems, ['the browser did not reconnect within 9 s']);
  assert.equal(calls.browse, 3, 'asked every 3 s for 9 s');
  assert.deepEqual(slept, [3_000, 3_000]);
});

test('controller: an upgrade verifies when the version is right and the browser reconnects', async () => {
  const { ctl, logger, calls } = canary({ reported: NEW, statuses: [statusJson({ connected: false }), statusJson({ connected: true, version: NEW })] });
  const res = await ctl.changeBrowse('upgrade');
  assert.deepEqual([res.ok, res.problems], [true, []]);
  assert.equal(calls.browse, 2, 'it waited for the reconnect');
  assert.equal(ctl.snapshot().browseChange.ok, true);
  assert.deepEqual(ctl.snapshot().warnings, []);
  assert.ok(logger.ring.some((e) => e.host === 'canary' && e.message === `upgrade to browse ${NEW} verified: version, auto-update off, relay on loopback only, browser reconnected`));
});

test('controller: with no browser connected before, the reconnect is noted as not checked, never as verified', async () => {
  const { ctl, logger, calls } = canary({ reported: NEW, connectedBefore: false, statuses: [statusJson({ connected: false })] });
  const res = await ctl.changeBrowse('upgrade');
  assert.equal(res.ok, true);
  assert.deepEqual(res.notes, ['no browser was connected before, so its reconnect was not checked']);
  assert.equal(calls.browse, 1, 'one status read, no waiting');
  assert.ok(!logger.ring.some((e) => e.message.includes('browser reconnected')));
});

test('controller: the warning names the host\'s own version when it has one, else the pin', () => {
  const { ctl } = canary({ reported: NEW });
  assert.deepEqual(ctl.statusWarnings({ autoUpdate: 'off', relayVersion: PIN }), [`browse ${PIN} running, ${NEW} set for this host (the app pins ${PIN})`]);
  const { ctl: steady } = canary({ browseVersion: null, reported: PIN });
  assert.deepEqual(steady.statusWarnings({ autoUpdate: 'off', relayVersion: NEW }), [`browse ${NEW} running, ${PIN} pinned`]);
  assert.deepEqual(steady.statusWarnings({ autoUpdate: 'off', relayVersion: PIN }), []);
});

test('controller: Set Up Host installs the host\'s own version, and a clean run clears a failed upgrade', async () => {
  const { ctl, calls } = canary({ reported: PIN });
  await ctl.changeBrowse('upgrade');
  assert.equal(ctl.snapshot().browseChange.ok, false);
  const fixed = fakeTransport({ reported: NEW });
  ctl.transport = () => fixed.transport;
  const res = await ctl.setupRemote();
  assert.deepEqual([res.ok, res.version], [true, NEW]);
  assert.deepEqual(fixed.calls.script, [['$HOME/.local/bin/browse', NEW]], `${SETUP_LABEL} aims at the host's version, not the pin`);
  assert.equal(ctl.snapshot().browseChange, null);
  assert.deepEqual(ctl.snapshot().warnings, []);
  assert.equal(calls.script.length, 1);
});

// ---------- HostManager: save first, then setup, and no tunnel restart ----------

function manager(transportFor) {
  const logger = new Logger();
  const createController = (opts) => {
    const c = new Controller({ ...opts, reconnectTimeoutMs: 1, reconnectIntervalMs: 1, sleep: async () => {} });
    c.transport = () => transportFor(c).transport;
    return c;
  };
  return { mgr: new HostManager({ logger, createController }), logger };
}

test('hosts: Upgrade saves the host\'s version and runs setup with it; Roll back clears it and runs setup with the pin', async () => {
  const fakes = new Map();
  const reported = { v: NEW };
  const { mgr } = manager((c) => {
    if (!fakes.has(c)) fakes.set(c, fakeTransport({ reported: reported.v }));
    return fakes.get(c);
  });
  const path = join(mkdtempSync(join(tmpdir(), 'bb-upg-')), 'config.json');
  const save = (cfg) => saveConfig(path, cfg);
  await mgr.apply(twoHosts());
  const ctl = mgr.get('canary');
  const steady = mgr.get('steady');

  const up = await mgr.changeBrowse('canary', NEW, save);
  assert.equal(up.ok, true, up.problems.join('; '));
  assert.equal(mgr.get('canary'), ctl, 'the same controller: the tunnel was not restarted');
  assert.equal(ctl.cfg.browseVersion, NEW);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).hosts.map((h) => h.browseVersion), [NEW, undefined]);
  assert.equal(steady.cfg.browseVersion, PIN, 'the other host stays on the pin');

  reported.v = PIN;
  fakes.delete(ctl);
  const back = await mgr.changeBrowse('canary', null, save);
  assert.deepEqual([back.ok, back.action, back.version], [true, 'rollback', PIN]);
  assert.deepEqual(fakes.get(ctl).calls.script, [['$HOME/.local/bin/browse', PIN]], 'roll back installs the pin');
  assert.equal(ctl.cfg.browseVersion, PIN);
  assert.equal('browseVersion' in JSON.parse(readFileSync(path, 'utf8')).hosts[0], false);
  assert.equal(mgr.get('canary'), ctl);
});

test('hosts: a failed upgrade leaves the chosen version saved, so the warning and Set Up Host keep aiming at it until Roll back', async () => {
  const { mgr } = manager(() => fakeTransport({ reported: PIN }));
  const path = join(mkdtempSync(join(tmpdir(), 'bb-upg-fail-')), 'config.json');
  await mgr.apply(twoHosts());
  const res = await mgr.changeBrowse('canary', NEW, (cfg) => saveConfig(path, cfg));
  assert.equal(res.ok, false);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).hosts[0].browseVersion, NEW);
  // config.json read again (Reload): the host still aims at the chosen version and keeps its controller.
  const ctl = mgr.get('canary');
  await mgr.apply(loadConfig(path));
  assert.equal(mgr.get('canary'), ctl);
  assert.equal(ctl.cfg.browseVersion, NEW, 'what Set Up Host installs next');
  assert.equal(ctl.snapshot().browseChange.ok, false);
  assert.ok(ctl.snapshot().warnings.some((w) => w.includes(`"${ROLLBACK_BROWSE_LABEL}"`)));
});

test('hosts: a busy host refuses Upgrade before anything is saved or run', async () => {
  let ran = 0;
  const { mgr } = manager(() => { ran++; return fakeTransport({ reported: NEW }); });
  const path = join(mkdtempSync(join(tmpdir(), 'bb-upg-busy-')), 'config.json');
  await mgr.apply(twoHosts());
  mgr.get('canary').busy = 'Pairing';
  await assert.rejects(mgr.changeBrowse('canary', NEW, (cfg) => saveConfig(path, cfg)), /busy: Pairing/);
  assert.equal(existsSync(path), false, 'nothing written');
  assert.equal(ran, 0, 'nothing run');
  await assert.rejects(mgr.changeBrowse('ghost', NEW, (cfg) => saveConfig(path, cfg)), /no host with id "ghost"/);
});
