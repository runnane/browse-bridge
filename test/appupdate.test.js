import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Logger } from '../src/core/log.js';
import { checkSmoke } from '../scripts/check-smoke.js';
import { UPDATE_LABEL } from '../src/core/labels.js';
import { UPDATE_CHECK_INTERVAL_MS, updateSummary } from '../src/core/updater.js';
import {
  E2E_QUIT_ENV, FEED_ENV, PackagedUpdates, UPDATER_LOAD_FAILED, isSmokeHook, loadAutoUpdater, testFeedUrl, updateFailure, updaterLogger,
} from '../src/core/appupdate.js';

// ---------- a fake electron-updater: no test here imports electron-updater or reaches the network ----------

/**
 * The shape core/appupdate.js is handed: an EventEmitter with the three calls
 * and the properties it sets. Every call is counted. `checkAnswer` decides
 * what a check does; the default finds `nextVersion` and says so the way
 * electron-updater does (the event before the promise resolves).
 */
function fakeUpdater({ nextVersion = '0.2.0', checkAnswer } = {}) {
  const u = new EventEmitter();
  u.calls = { checkForUpdates: 0, downloadUpdate: 0, quitAndInstall: 0, setFeedURL: [] };
  u.autoDownload = true; // electron-updater's defaults: the module must turn both off
  u.autoInstallOnAppQuit = true;
  u.logger = console;
  u.checkForUpdates = async () => {
    u.calls.checkForUpdates += 1;
    if (checkAnswer) return checkAnswer(u);
    u.emit('update-available', { version: nextVersion });
    return { updateInfo: { version: nextVersion } };
  };
  u.downloadUpdate = async () => {
    u.calls.downloadUpdate += 1;
    return ['/home/u/.cache/browse-bridge-updater/pending/browse-bridge-x86_64.AppImage'];
  };
  u.quitAndInstall = () => { u.calls.quitAndInstall += 1; };
  u.setFeedURL = (opts) => { u.calls.setFeedURL.push(opts); };
  return u;
}

/** Fake timers: setInterval records, never fires by itself. */
function fakeTimers() {
  const t = { armed: [], cleared: [] };
  t.setInterval = (fn, ms) => { const h = { fn, ms }; t.armed.push(h); return h; };
  t.clearInterval = (h) => { t.cleared.push(h); };
  return t;
}

const settle = () => new Promise((r) => setImmediate(r));

function make({ env = {}, updater = fakeUpdater(), ...rest } = {}) {
  const logger = new Logger();
  const timers = fakeTimers();
  const pu = new PackagedUpdates({ updater, logger, env, timers, ...rest });
  return { pu, updater, logger, timers, lines: () => logger.ring.map((e) => `${e.level} ${e.message}`) };
}

// ---------- Proof 1: off means no fetch ----------

test('appupdate: with Check for updates off, nothing is checked or downloaded and no timer is armed (Proof 1)', async () => {
  const { pu, updater, timers } = make();
  pu.follow(false);
  await settle();
  assert.equal(timers.armed.length, 0, 'no daily timer while the setting is off');
  assert.equal(updater.calls.checkForUpdates, 0, 'checkForUpdates is never called while off');
  assert.equal(updater.calls.downloadUpdate, 0, 'downloadUpdate is never called while off');
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updateSummary(pu.view()).detail, 'Checking for updates is off (General → Check for updates).');
});

test('appupdate: Check Now while the setting is off fetches nothing (the check\'s own guard)', async () => {
  const { pu, updater } = make();
  pu.follow(false);
  await pu.check();
  assert.equal(updater.calls.checkForUpdates, 0, 'a direct check while off makes no call');
  assert.equal(updater.calls.downloadUpdate, 0);
});

test('appupdate: on, it checks at once and every UPDATE_CHECK_INTERVAL_MS, and downloads only after the notice', async () => {
  const { pu, updater, timers, lines } = make();
  assert.equal(updater.autoDownload, false, 'a check never downloads by itself: the module decides');
  pu.follow(true);
  await settle();
  assert.equal(updater.calls.checkForUpdates, 1);
  assert.equal(timers.armed.length, 1);
  assert.equal(timers.armed[0].ms, UPDATE_CHECK_INTERVAL_MS);
  assert.equal(updater.calls.downloadUpdate, 1, 'update-available starts the download');
  assert.ok(lines().some((l) => l === 'info update available: browse-bridge 0.2.0; downloading it, to install when browse-bridge quits'), lines().join('\n'));
  const s = updateSummary(pu.view());
  assert.equal(s.line, 'Update available: browse-bridge 0.2.0');
  assert.equal(s.canUpdate, false, 'nothing to install before the download is done');
  // The timer's tick is another check.
  await timers.armed[0].fn();
  assert.equal(updater.calls.checkForUpdates, 2);
});

test('appupdate: a check that finds nothing is "up to date" with the version; a null answer never is', async () => {
  const current = fakeUpdater({ checkAnswer: (u) => { u.emit('update-not-available', { version: '0.1.0' }); return { updateInfo: { version: '0.1.0' } }; } });
  const a = make({ updater: current });
  a.pu.follow(true);
  await settle();
  assert.equal(updateSummary(a.pu.view()).detail, 'Up to date: browse-bridge 0.1.0 is the newest release.');
  assert.equal(current.calls.downloadUpdate, 0);

  // electron-updater answers null when it is not active (not packaged, or $APPIMAGE unset).
  const inactive = fakeUpdater({ checkAnswer: () => null });
  const b = make({ updater: inactive });
  b.pu.follow(true);
  await settle();
  const s = updateSummary(b.pu.view());
  assert.match(s.detail, /^Updates are not checked: this build cannot update itself/);
  assert.doesNotMatch(s.detail, /up to date/i);
  assert.equal(s.canCheck, false);
});

// ---------- Proof 2: never restarts mid-session ----------

test('appupdate: a finished download never restarts the app; it installs on quit (Proof 2)', async () => {
  const { pu, updater, lines } = make();
  pu.follow(true);
  await settle();
  updater.emit('update-downloaded', { version: '0.2.0' });
  await settle();
  assert.equal(updater.calls.quitAndInstall, 0, 'quitAndInstall is never called on update-downloaded');
  assert.equal(updater.autoInstallOnAppQuit, true, 'it installs when the app quits');
  const s = updateSummary(pu.view());
  assert.equal(s.detail, `browse-bridge 0.2.0 is downloaded and installs when browse-bridge quits. ${UPDATE_LABEL} installs it now (every host is stopped first).`);
  assert.equal(s.canUpdate, true);
  assert.ok(lines().includes('info browse-bridge 0.2.0 downloaded; it installs when browse-bridge quits'));
});

/**
 * A fake Electron app's 'quit' event with electron-updater's ordering: its
 * install handler is registered at download time (before the click), the
 * app's own relaunch handler at the click. `renameTo` makes the install behave
 * like a version-carrying file name: it emits appimage-filename-updated.
 */
function fakeQuitting(updater, { renameTo = null } = {}) {
  const app = new EventEmitter();
  const order = [];
  app.once('quit', () => {
    order.push('install');
    if (renameTo) updater.emit('appimage-filename-updated', renameTo);
  });
  return {
    order,
    onQuit: (fn) => app.once('quit', () => { order.push('relaunch-registered'); fn(); }),
    quit: async () => { order.push('quit'); app.emit('quit', {}, 0); },
  };
}

test('appupdate: Update and Restart runs the clean quit, relaunches from the quit event, and never calls quitAndInstall', async () => {
  const { pu, updater } = make();
  pu.follow(true);
  await settle();
  updater.emit('update-downloaded', { version: '0.2.0' });
  const q = fakeQuitting(updater);
  const targets = [];
  await pu.installNow({ relaunch: (p) => targets.push(p), onQuit: q.onQuit, quit: q.quit });
  assert.deepEqual(q.order, ['quit', 'install', 'relaunch-registered']);
  assert.deepEqual(targets, [undefined], 'the file kept its name: the caller relaunches the running path');
  assert.equal(updater.autoInstallOnAppQuit, true, 'the install rides on the clean quit');
  assert.equal(updater.calls.quitAndInstall, 0, 'quitAndInstall would quit without stopping the hosts');
  assert.equal(updateSummary(pu.view()).line, 'Updating browse-bridge…');
});

test('appupdate: a renamed install (appimage-filename-updated during the quit) is relaunched at the NEW path (BBR-83)', async () => {
  const changed = [];
  const { pu, updater } = make({ onPathChanged: (p) => changed.push(p) });
  pu.follow(true);
  await settle();
  updater.emit('update-downloaded', { version: '0.2.0' });
  const q = fakeQuitting(updater, { renameTo: '/home/u/Apps/browse-bridge-0.2.0.AppImage' });
  const targets = [];
  await pu.installNow({ relaunch: (p) => targets.push(p), onQuit: q.onQuit, quit: q.quit });
  assert.deepEqual(changed, ['/home/u/Apps/browse-bridge-0.2.0.AppImage'], 'autostart and the menu entry follow too');
  assert.deepEqual(targets, ['/home/u/Apps/browse-bridge-0.2.0.AppImage']);
});

test('appupdate: Update and Restart refuses before a download, and while off', async () => {
  const quit = async () => assert.fail('quit must not run');
  const relaunch = () => assert.fail('relaunch must not run');
  const a = make({ updater: fakeUpdater({ checkAnswer: () => ({}) }) });
  a.pu.follow(true);
  await settle();
  await assert.rejects(a.pu.installNow({ relaunch, quit }), /No update is downloaded yet/);
  const b = make();
  b.pu.follow(true);
  await settle();
  b.updater.emit('update-downloaded', { version: '0.2.0' });
  b.pu.follow(false);
  await assert.rejects(b.pu.installNow({ relaunch, quit }), /Checking for updates is off/);
});

// ---------- Proof 3: the smoke hooks never fetch ----------

test('appupdate: the headless test hooks never fetch, and BB_SMOKE_UPDATE shows a downloaded notice (Proof 3)', async () => {
  for (const env of [{ BB_SMOKE_OUT: '/tmp/x' }, { BB_PROBE_WINDOW: '/tmp/y' }]) {
    const { pu, updater, timers } = make({ env });
    pu.follow(true);
    await pu.check();
    await settle();
    assert.equal(updater.calls.checkForUpdates, 0, `${Object.keys(env)[0]}: the fake is never asked to check`);
    assert.equal(timers.armed.length, 0, `${Object.keys(env)[0]}: no daily timer`);
    assert.match(updateSummary(pu.view()).detail, /the headless test hooks do not fetch/);
  }
  const { pu, updater } = make({ env: { BB_SMOKE_OUT: '/tmp/x', BB_SMOKE_UPDATE: '0.9.0' } });
  pu.follow(true);
  await settle();
  assert.equal(updater.calls.checkForUpdates, 0);
  const s = updateSummary(pu.view());
  assert.equal(s.line, 'Update available: browse-bridge 0.9.0');
  assert.match(s.detail, /installs when browse-bridge quits/);
  await assert.rejects(pu.installNow({ relaunch: () => {}, quit: async () => {} }), /headless test hooks do not install/);
  assert.equal(isSmokeHook({}), false);
});

// ---------- Proof 4: off after a download installs nothing on quit ----------

test('appupdate: turning the setting off after a download means nothing installs on quit (Proof 4)', async () => {
  const { pu, updater, timers, lines } = make();
  pu.follow(true);
  await settle();
  updater.emit('update-downloaded', { version: '0.2.0' });
  assert.equal(updater.autoInstallOnAppQuit, true);
  pu.follow(false);
  assert.equal(updater.autoInstallOnAppQuit, false, 'a download already made is not installed on quit once the setting is off');
  assert.equal(timers.cleared.length >= 1, true, 'the daily timer is stopped');
  assert.equal(updateSummary(pu.view()).line, null, 'the notice is dropped');
  assert.ok(lines().includes('info checking for updates is off: the downloaded browse-bridge 0.2.0 is not installed on quit'));
  // A download that finishes after the setting went off is not offered either.
  updater.emit('update-downloaded', { version: '0.2.0' });
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updateSummary(pu.view()).canUpdate, false);
});

test('appupdate: a check that turns up an update after the setting went off does not download it', async () => {
  let release;
  const slow = fakeUpdater({ checkAnswer: (u) => new Promise((r) => { release = () => { u.emit('update-available', { version: '0.2.0' }); r({}); }; }) });
  const { pu } = make({ updater: slow });
  pu.follow(true);
  await settle();
  pu.follow(false);
  release();
  await settle();
  assert.equal(slow.calls.downloadUpdate, 0);
});

// ---------- failures, the log and the test feed ----------

test('appupdate: a failed check is "could not check", logged once with the release URL dropped', async () => {
  const url = 'https://github.com/runnane/browse-bridge/releases/download/v0.2.0/latest-linux.yml';
  const broken = fakeUpdater({
    checkAnswer: (u) => {
      const err = new Error(`Cannot find latest-linux.yml in the latest release artifacts (${url}): HttpError: 404\nstack line`);
      u.emit('error', err);
      throw err;
    },
  });
  const { pu, lines } = make({ updater: broken });
  pu.follow(true);
  await settle();
  const s = updateSummary(pu.view());
  assert.equal(s.detail, 'Could not check for updates: Cannot find latest-linux.yml in the latest release artifacts (<url> HttpError: 404.');
  const failures = lines().filter((l) => l.startsWith('warn could not update'));
  assert.equal(failures.length, 1, failures.join('\n'));
  assert.ok(!lines().some((l) => l.includes('github.com')), 'no release URL in the log');
  assert.equal(updateFailure(new Error('x\ny')), 'x');
});

test('appupdate: electron-updater\'s own log goes through Logger, one line, no URL, no debug', () => {
  const logger = new Logger();
  const log = updaterLogger(logger);
  log.info('Found version 0.2.0 (url: https://github.com/runnane/browse-bridge/releases/download/v0.2.0/browse-bridge-x86_64.AppImage)');
  log.error(Object.assign(new Error('boom'), { stack: 'Error: boom\n    at x (/tmp/a.js:1:1)' }));
  log.debug('noise');
  assert.deepEqual(logger.ring.map((e) => [e.level, e.source, e.message]), [
    ['info', 'update', 'electron-updater: Found version 0.2.0 (url: <url>'],
    ['error', 'update', 'electron-updater: Error: boom'],
  ]);
  const u = fakeUpdater();
  make({ updater: u });
  assert.notEqual(u.logger, console, 'the module replaces the default console logger');
});

test('appupdate: the test feed is loopback only, and only when the variable is set', () => {
  assert.equal(testFeedUrl({}), null);
  assert.deepEqual(testFeedUrl({ [FEED_ENV]: 'http://127.0.0.1:38611/' }), { url: 'http://127.0.0.1:38611/' });
  assert.deepEqual(testFeedUrl({ [FEED_ENV]: 'http://localhost:8080/feed' }), { url: 'http://localhost:8080/feed' });
  assert.deepEqual(testFeedUrl({ [FEED_ENV]: 'http://[::1]:8080/' }), { url: 'http://[::1]:8080/' });
  for (const bad of ['https://example.com/feed', 'http://10.0.0.1/', 'file:///tmp/feed', 'http://u:p@127.0.0.1/', 'not a url', 'http://127.0.0.1.example.com/']) {
    assert.ok(testFeedUrl({ [FEED_ENV]: bad }).refused, bad);
  }
  const used = fakeUpdater();
  make({ updater: used, env: { [FEED_ENV]: 'http://127.0.0.1:38611/' } });
  assert.deepEqual(used.calls.setFeedURL, [{ provider: 'generic', url: 'http://127.0.0.1:38611/' }]);
  const refused = fakeUpdater();
  const r = make({ updater: refused, env: { [FEED_ENV]: 'https://example.com/' } });
  assert.deepEqual(refused.calls.setFeedURL, [], 'a non-loopback feed is never set');
  assert.ok(r.lines().some((l) => l.startsWith('warn test feed ignored:')));
  const none = fakeUpdater();
  make({ updater: none });
  assert.deepEqual(none.calls.setFeedURL, [], 'without the variable the build reads its own app-update.yml (GitHub Releases)');
  assert.equal(E2E_QUIT_ENV, 'BB_UPDATE_E2E_QUIT');
});

test('appupdate: electron-updater is loaded by its default export, the CommonJS namespace', async () => {
  const updater = fakeUpdater();
  // The shape `import('electron-updater')` has under "type": "module": autoUpdater only on the default export (a getter).
  let constructed = 0;
  const ns = { default: { get autoUpdater() { constructed += 1; return updater; } }, AppImageUpdater: class {} };
  assert.equal(await loadAutoUpdater(async () => ns), updater);
  assert.equal(constructed, 1);
  await assert.rejects(loadAutoUpdater(async () => ({ default: {} })), /no autoUpdater/);
});

test('appupdate: the release smoke refuses an AppImage whose About says the updater could not be loaded', () => {
  const about = 'browse-bridge 0.1.0\nUpdates are not checked: the headless test hooks do not fetch.';
  assert.equal(checkSmoke({ errors: [], dialogs: { about } }, '0.1.0').ok, true);
  const broken = checkSmoke({ errors: [], dialogs: { about: `browse-bridge 0.1.0\nUpdates are not checked: ${UPDATER_LOAD_FAILED}.` } }, '0.1.0');
  assert.equal(broken.ok, false);
  assert.deepEqual(broken.problems, [`dialogs.about says ${UPDATER_LOAD_FAILED}`]);
});
