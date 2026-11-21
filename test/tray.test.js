import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGGREGATE, HOST_ACTIONS, aggregateState } from '../src/core/hosts.js';
import { OVERALL } from '../src/core/controller.js';
import { HostNotifier, TrayRenderer, coalesce, problemLine, trayMenuModel, trayTooltip, trayView } from '../src/core/tray.js';

/** A per-host snapshot in the shape Controller.snapshot() gives, for a state. */
function host(id, overall, extra = {}) {
  const up = ['ready', 'warning', 'needsPairing', 'relayIdle', 'unknown'].includes(overall);
  const connected = !['stopped', 'unconfigured'].includes(overall);
  return {
    id, name: '', overall, label: OVERALL[overall], host: `jon@${id}.invalid`, connected,
    tunnel: { state: up ? 'up' : overall === 'error' ? 'retrying' : 'stopped', detail: '' },
    warnings: [], busy: null, ...extra,
  };
}

/** What HostManager.snapshot() returns for these hosts. */
function agg(...hosts) {
  const overall = aggregateState(hosts);
  return { overall, label: AGGREGATE[overall], hosts };
}

// ---------- aggregate (the icon state) ----------

test('tray: the icon follows the aggregate — all up, some down, all down, all stopped, none configured', () => {
  assert.equal(trayView(agg(host('dev004', 'ready'), host('dev005', 'needsPairing'))).icon, 'allUp');
  assert.equal(trayView(agg(host('dev004', 'ready'), host('dev005', 'error'))).icon, 'someDown');
  assert.equal(trayView(agg(host('dev004', 'ready'), host('dev005', 'stopped'))).icon, 'someDown');
  assert.equal(trayView(agg(host('dev004', 'error'), host('dev005', 'connecting'))).icon, 'allDown');
  assert.equal(trayView(agg(host('dev004', 'error'), host('dev005', 'stopped'))).icon, 'allDown');
  assert.equal(trayView(agg(host('dev004', 'stopped'), host('dev005', 'stopped'))).icon, 'stopped');
  assert.equal(trayView(agg(host('host-1', 'unconfigured'))).icon, 'none');
  assert.equal(trayView(agg()).icon, 'none');
});

// ---------- tooltip ----------

const VERSION = '0.1.0+3 1b86d65';

test('tray: the tooltip is one line per item — title, each host in words, then the version', () => {
  assert.equal(
    trayTooltip(agg(host('dev004', 'ready'), host('dev001', 'needsPairing')), { version: VERSION }),
    'browse-bridge — All hosts bridged\ndev004: Connected\ndev001: Browser not connected\n0.1.0+3 1b86d65',
  );
  assert.equal(
    trayTooltip(agg(host('dev004', 'ready'), host('dev005', 'error')), { version: VERSION }),
    'browse-bridge — Some hosts down\ndev004: Connected\ndev005: Tunnel down\n0.1.0+3 1b86d65',
  );
  assert.equal(
    trayTooltip(agg(host('dev004', 'needsPairing', { name: 'Build box', busy: 'Pairing' }), host('dev005', 'stopped')), { version: VERSION }),
    'browse-bridge — Some hosts down\nBuild box: Browser not connected (Pairing…)\ndev005: Stopped\n0.1.0+3 1b86d65',
  );
  assert.equal(trayTooltip(agg(), { version: VERSION }), 'browse-bridge — No host configured\n0.1.0+3 1b86d65');
});

test('tray: a tooltip without a version has no version line', () => {
  assert.equal(
    trayTooltip(agg(host('dev004', 'stopped'))),
    'browse-bridge — All hosts stopped\ndev004: Stopped',
  );
  assert.equal(trayTooltip(agg()), 'browse-bridge — No host configured');
  assert.equal(trayTooltip(agg(), { version: '' }), 'browse-bridge — No host configured');
  assert.equal(trayView(agg(host('dev004', 'ready')), { version: VERSION }).tooltip, 'browse-bridge — All hosts bridged\ndev004: Connected\n0.1.0+3 1b86d65');
});

// ---------- menu ----------

test('tray: each host gets a submenu of its own controls, bound to its id; app-wide items stay top level', () => {
  const menu = trayMenuModel(agg(host('dev004', 'ready'), host('dev005', 'stopped')), { autostart: true });
  const labels = (items) => items.map((i) => i.label ?? '—');
  assert.deepEqual(labels(menu), [
    'browse-bridge: Some hosts down', '—', 'dev004: Connected', 'dev005: Stopped', '—',
    'Show window', 'Open log file', 'Start at login', '—', 'Help', 'About browse-bridge…', 'Copy diagnostics', '—', 'Quit',
  ]);
  const versioned = trayMenuModel(agg(host('dev004', 'ready'), host('dev005', 'stopped')), { autostart: true, version: VERSION });
  assert.deepEqual(labels(versioned), [
    'browse-bridge: Some hosts down', '—', 'dev004: Connected', 'dev005: Stopped', '—',
    'Show window', 'Open log file', 'Start at login', '—', 'Help', 'About browse-bridge…', 'Copy diagnostics', '—', '0.1.0+3 1b86d65', 'Quit',
  ]);
  assert.equal(versioned.at(-2).enabled, false, 'the version line is not clickable');
  assert.equal(versioned.at(-2).action, undefined);
  assert.equal(versioned.at(-1).label, 'Quit');
  assert.deepEqual(trayView(agg(host('dev004', 'ready')), { version: VERSION }).menu.at(-2), { label: VERSION, enabled: false });
  const actions = (items) => items.filter((i) => i.action).map((i) => [i.label, i.action, i.hostId ?? null]);
  assert.deepEqual(actions(menu), [['Show window', 'showWindow', null], ['Open log file', 'openLogFile', null], ['Start at login', 'autostart', null],
    ['Help', 'showHelp', null], ['About browse-bridge…', 'showAbout', null], ['Copy diagnostics', 'copyDiagnostics', null], ['Quit', 'quit', null]]);
  assert.equal(menu.find((i) => i.action === 'autostart').checked, true);

  const [a, b] = [menu[2].submenu, menu[3].submenu];
  assert.deepEqual(actions(a), [
    ['Disconnect', 'disconnect', 'dev004'], ['Pair browser…', 'pair', 'dev004'], ['Restart Relay', 'startRelay', 'dev004'],
    ['Set Up Host', 'setup', 'dev004'], ['Show logs', 'showLogs', 'dev004'],
  ]);
  assert.deepEqual(actions(b).map(([l, act, id]) => [l, act, id]).slice(0, 1), [['Connect', 'connect', 'dev005']]);
  assert.ok(actions(b).every(([, , id]) => id === 'dev005'), 'every control in dev005\'s submenu acts on dev005');
  assert.equal(a[0].label, 'jon@dev004.invalid');
  // Every host action the tray dispatches is one runHostAction knows; showLogs is the shell's own.
  for (const [, act] of [...actions(a), ...actions(b)]) assert.ok(Object.hasOwn(HOST_ACTIONS, act) || act === 'showLogs', act);
  // Dialogs that live in the window bring it up on that host.
  assert.deepEqual(a.filter((i) => i.show).map((i) => i.action), ['pair', 'setup']);
});

test('tray: a busy or unconfigured host\'s controls are disabled; warnings show in its submenu', () => {
  const busy = trayMenuModel(agg(host('dev004', 'warning', { busy: 'Pairing', warnings: ['relay 0.1.3 ≠ 0.1.4'] })))[2].submenu;
  assert.equal(busy.find((i) => i.label === '⚠ relay 0.1.3 ≠ 0.1.4')?.enabled, false);
  assert.deepEqual(busy.filter((i) => ['pair', 'startRelay', 'setup'].includes(i.action)).map((i) => i.enabled), [false, false, false]);
  assert.equal(busy.find((i) => i.action === 'disconnect').enabled, undefined, 'Disconnect stays available while busy');
  const blank = trayMenuModel(agg(host('host-1', 'unconfigured', { host: '' })))[2].submenu;
  assert.equal(blank[0].label, 'no ssh host');
  assert.equal(blank.find((i) => i.action === 'connect').enabled, false);
});

test('tray: a host\'s ssh guidance shows in its submenu under the destination, with no countdown, cut to a menu\'s length (BBR-46)', () => {
  const text = 'No usable key. Load it with ssh-add, or set IdentityFile in SSH options.';
  const sub = trayMenuModel(agg(host('dev004', 'error', { problem: { kind: 'auth', text } })))[2].submenu;
  assert.deepEqual(sub[1], { label: `✕ ${text}`, enabled: false });
  const plain = trayMenuModel(agg(host('dev004', 'error', { problem: null })))[2].submenu;
  assert.ok(!plain.some((i) => String(i.label).startsWith('✕')), 'no line without a recognised failure');
  assert.equal(problemLine({ text: 'x'.repeat(300) }).length, 160);
  assert.ok(problemLine({ text: 'x'.repeat(300) }).endsWith('…'));
});

test('tray: an unreadable config file gets a line naming the file and the error, in the menu and the tooltip (BBR-36)', () => {
  const failure = { path: '/cfg/browse-bridge/config.json', message: 'Expected double-quoted property name in JSON at position 120', backup: null, backupError: null };
  const a = agg(host('host-1', 'unconfigured', { host: '' }));
  const menu = trayMenuModel(a, { configFailure: failure });
  assert.deepEqual(menu[1], {
    label: '⚠ Cannot read /cfg/browse-bridge/config.json: Expected double-quoted property name in JSON at position 120',
    action: 'showWindow',
  });
  assert.equal(trayTooltip(a, { configFailure: failure }).split('\n')[1], menu[1].label);
  // Without a failure the menu and tooltip are exactly what they were.
  assert.deepEqual(trayMenuModel(a, { configFailure: null }), trayMenuModel(a));
  assert.equal(menu.length, trayMenuModel(a).length + 1);
  // A long message is cut to fit a menu.
  const long = trayMenuModel(a, { configFailure: { ...failure, message: 'x'.repeat(500) } })[1].label;
  assert.equal(long.length, 120);
  assert.ok(long.endsWith('…'));
});

// ---------- coalescing ----------

function fakeTray() {
  const calls = [];
  const renderer = new TrayRenderer({
    setImage: (state, { trace }) => calls.push(['setImage', state, trace]),
    setToolTip: (text) => calls.push(['setToolTip', text]),
    setContextMenu: (menu) => calls.push(['setContextMenu', menu.length]),
  });
  return { calls, renderer };
}

test('tray: an update on origin is one line near the top that opens About; none without one (BBR-43)', () => {
  const a = agg(host('dev004', 'ready'));
  const menu = trayMenuModel(a, { update: 'Update available: 3 commits' });
  assert.deepEqual(menu[1], { label: 'Update available: 3 commits', action: 'showAbout' });
  assert.equal(menu.length, trayMenuModel(a).length + 1);
  assert.deepEqual(trayMenuModel(a, { update: null }), trayMenuModel(a));
  assert.deepEqual(trayView(a, { update: 'Update available: 1 commit' }).menu[1].label, 'Update available: 1 commit');
});

test('tray: an unchanged view makes no tray call; each part is set only when it changed', () => {
  const { calls, renderer } = fakeTray();
  const two = agg(host('dev004', 'ready'), host('dev005', 'stopped'));
  assert.deepEqual(renderer.render(trayView(two)), ['icon', 'tooltip', 'menu']);
  assert.equal(calls.length, 3);
  assert.equal(calls[0][2], true, 'the first render is a state transition: traced');

  // The same aggregate again (a byte counter or a poll tick changed nothing shown): no call at all.
  assert.deepEqual(renderer.render(trayView(agg(host('dev004', 'ready', { traffic: { bytesUp: 9e6 } }), host('dev005', 'stopped')))), []);
  assert.equal(calls.length, 3);

  // Only dev004's warnings changed: the tooltip is the same, the menu is rebuilt, the icon is not.
  assert.deepEqual(renderer.render(trayView(agg(host('dev004', 'ready', { warnings: ['w'] }), host('dev005', 'stopped')))), ['menu']);

  // A busy label changes the tooltip and the menu, not the icon; not traced.
  calls.length = 0;
  assert.deepEqual(renderer.render(trayView(agg(host('dev004', 'ready', { busy: 'Pairing' }), host('dev005', 'stopped')))), ['tooltip', 'menu']);
  assert.deepEqual(calls.map((c) => c[0]), ['setToolTip', 'setContextMenu']);

  // dev005 connects: everything changes, and the icon transition is traced.
  calls.length = 0;
  renderer.render(trayView(agg(host('dev004', 'ready'), host('dev005', 'needsPairing'))));
  assert.deepEqual(calls[0], ['setImage', 'allUp', true]);

  // Toggling Start at login is in the model, so it rebuilds the menu on its own.
  calls.length = 0;
  assert.deepEqual(renderer.render(trayView(agg(host('dev004', 'ready'), host('dev005', 'needsPairing')), { autostart: true })), ['menu']);

  renderer.invalidate();
  assert.deepEqual(renderer.render(trayView(agg(host('dev004', 'ready'), host('dev005', 'needsPairing')), { autostart: true })), ['icon', 'tooltip', 'menu']);
});

test('tray: a setter that throws is retried on the next render', () => {
  let fail = true;
  const set = [];
  const renderer = new TrayRenderer({
    setImage: (s) => set.push(s),
    setToolTip: (t) => { if (fail) throw new Error('dbus'); set.push(t); },
    setContextMenu: () => set.push('menu'),
  });
  const view = trayView(agg(host('dev004', 'ready')));
  assert.throws(() => renderer.render(view), /dbus/);
  fail = false;
  assert.deepEqual(renderer.render(view), ['tooltip', 'menu']);
});

test('tray: coalesce folds a burst of change events into one render, and cancel drops a pending one', () => {
  const timers = [];
  let runs = 0;
  const c = coalesce(() => runs++, 100, { setTimer: (fn) => timers.push(fn) && timers.length, clearTimer: () => timers.pop() });
  c.run(); c.run(); c.run();
  assert.equal(timers.length, 1);
  timers.shift()();
  assert.equal(runs, 1);
  assert.equal(c.pending, false);
  c.run();
  c.cancel();
  assert.equal(timers.length, 0);
  assert.equal(runs, 1);
});

// ---------- notifications ----------

test('tray: notifications name the host that connected or disconnected, tracked per host', () => {
  const n = new HostNotifier();
  assert.deepEqual(n.update([host('dev004', 'connecting'), host('dev005', 'connecting')]), [], 'start-up records, never notifies');
  assert.deepEqual(n.update([host('dev004', 'ready'), host('dev005', 'needsPairing')]), [
    { hostId: 'dev004', title: 'dev004 connected', body: 'Agents on jon@dev004.invalid can use this browser.' },
  ]);
  // A disconnects; B is unchanged.
  assert.deepEqual(n.update([host('dev004', 'error', { tunnel: { state: 'retrying', detail: 'ssh exited 255' } }), host('dev005', 'needsPairing')]), [
    { hostId: 'dev004', title: 'dev004 disconnected', body: 'Tunnel down: ssh exited 255' },
  ]);
  assert.deepEqual(n.update([host('dev004', 'error'), host('dev005', 'needsPairing')]), [], 'no change, no notification');
  // The second host in the list pairs: the notification names it, not the first host.
  assert.deepEqual(n.update([host('dev004', 'error'), host('dev005', 'ready', { name: 'Build box' })]), [
    { hostId: 'dev005', title: 'Build box connected', body: 'Agents on jon@dev005.invalid can use this browser.' },
  ]);
});

test('tray: adding, removing or stopping a host does not notify', () => {
  const n = new HostNotifier();
  n.update([host('dev004', 'ready')]);
  assert.deepEqual(n.update([host('dev004', 'ready'), host('dev005', 'ready', { name: 'B' })]), [], 'an added host that is already up');
  assert.deepEqual(n.update([host('dev005', 'ready', { name: 'B' })]), [], 'dev004 removed');
  assert.deepEqual(n.update([host('dev005', 'stopped', { name: 'B' })]), [], 'stopping a host is the user\'s doing');
  // dev004 comes back: it is new again, so its first state is only recorded.
  assert.deepEqual(n.update([host('dev004', 'ready'), host('dev005', 'stopped', { name: 'B' })]), []);
  assert.deepEqual(n.update([host('dev004', 'relayIdle'), host('dev005', 'ready', { name: 'B' })]), [
    { hostId: 'dev004', title: 'dev004 disconnected', body: 'Relay not running' },
    { hostId: 'dev005', title: 'B connected', body: 'Agents on jon@dev005.invalid can use this browser.' },
  ]);
});
