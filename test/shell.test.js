import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { iconPng, ICON_STATES, trayIconPng, TRAY_ICON_STATES } from '../src/icons.js';
import { AGGREGATE } from '../src/core/hosts.js';
import {
  MENU_ICON_SIZES, appMenuIconPath, appMenuPath, autostartArgv, autostartPath, desktopEntry, isAppMenuEnabled, isAutostartEnabled, setAppMenu, setAutostart, startsHidden,
} from '../src/core/autostart.js';
import { OVERALL } from '../src/core/controller.js';

/** A 32px PNG's alpha channel as a '0'/'1' string: the shape, without its colour. */
function alphaMask(png, label) {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], label);
  assert.equal(png.readUInt32BE(16), 32);
  const idatLen = png.readUInt32BE(33);
  assert.equal(png.toString('ascii', 37, 41), 'IDAT');
  const raw = inflateSync(png.subarray(41, 41 + idatLen));
  assert.equal(raw.length, 32 * (32 * 4 + 1));
  let mask = '';
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) mask += raw[y * 129 + 1 + x * 4 + 3] > 127 ? '1' : '0';
  return mask;
}

test('icons: every overall state has a valid PNG, and states differ in shape, not only colour', () => {
  assert.deepEqual([...ICON_STATES].sort(), Object.keys(OVERALL).sort());
  const alphaMasks = new Map(ICON_STATES.map((s) => [s, alphaMask(iconPng(s, 32), s)]));
  // Shapes the user must tell apart without colour: connected, needs attention, down, idle.
  const distinct = new Set(['ready', 'warning', 'needsPairing', 'error', 'unknown', 'stopped'].map((s) => alphaMasks.get(s)));
  assert.equal(distinct.size, 6);
});

test('icons: every tray aggregate state has its own shape (all up, some down, all down, stopped, no host)', () => {
  assert.deepEqual([...TRAY_ICON_STATES].sort(), Object.keys(AGGREGATE).sort());
  const masks = TRAY_ICON_STATES.map((s) => alphaMask(trayIconPng(s, 32), s));
  assert.equal(new Set(masks).size, TRAY_ICON_STATES.length);
});

test('autostart: XDG desktop entry quotes paths with spaces and toggles cleanly', () => {
  const home = mkdtempSync(join(tmpdir(), 'bb-auto-'));
  const env = { HOME: home };
  assert.equal(autostartPath(env), join(home, '.config', 'autostart', 'browse-bridge.desktop'));
  assert.equal(isAutostartEnabled(env), false);
  setAutostart(true, ['/opt/My Apps/electron', '/home/user/browse-bridge'], env);
  const text = readFileSync(autostartPath(env), 'utf8');
  assert.match(text, /^Exec="\/opt\/My Apps\/electron" \/home\/user\/browse-bridge$/m);
  assert.match(text, /^Type=Application$/m);
  assert.equal(isAutostartEnabled(env), true);
  setAutostart(false, [], env);
  assert.equal(isAutostartEnabled(env), false);
  assert.match(desktopEntry(['a$b']), /Exec="a\\\$b"/);
});

test('app menu: the entry goes under XDG_DATA_HOME, or ~/.local/share when it is unset', () => {
  const home = mkdtempSync(join(tmpdir(), 'bb-menu-'));
  const data = mkdtempSync(join(tmpdir(), 'bb-data-'));
  assert.equal(appMenuPath({ HOME: home }), join(home, '.local', 'share', 'applications', 'browse-bridge.desktop'));
  assert.equal(appMenuPath({ HOME: home, XDG_DATA_HOME: data }), join(data, 'applications', 'browse-bridge.desktop'));
  assert.equal(appMenuIconPath(48, { HOME: home, XDG_DATA_HOME: data }), join(data, 'icons', 'hicolor', '48x48', 'apps', 'browse-bridge.png'));
  assert.equal(appMenuIconPath(128, { HOME: home }), join(home, '.local', 'share', 'icons', 'hicolor', '128x128', 'apps', 'browse-bridge.png'));
});

test('app menu: the entry quotes Exec, carries an Icon and never --hidden; unticking removes it and the icons', () => {
  const data = mkdtempSync(join(tmpdir(), 'bb-data-'));
  const config = mkdtempSync(join(tmpdir(), 'bb-cfg-'));
  const env = { HOME: data, XDG_DATA_HOME: data, XDG_CONFIG_HOME: config };
  assert.equal(isAppMenuEnabled(env), false);
  setAppMenu(true, ['/opt/My Apps/electron', '/home/user/browse-bridge'], env);
  const text = readFileSync(appMenuPath(env), 'utf8');
  assert.doesNotMatch(text, /--hidden/, 'a menu launch shows the window');
  assert.match(text, /^Exec="\/opt\/My Apps\/electron" \/home\/user\/browse-bridge$/m);
  assert.match(text, /^Icon=browse-bridge$/m);
  assert.doesNotMatch(text, /Autostart/i, 'the menu entry is not an autostart entry');
  assert.equal(isAppMenuEnabled(env), true);
  assert.equal(existsSync(autostartPath(env)), false, 'the login entry is separate');
  for (const size of MENU_ICON_SIZES) {
    const png = readFileSync(appMenuIconPath(size, env));
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(png.readUInt32BE(16), size);
  }
  setAppMenu(false, [], env);
  assert.equal(isAppMenuEnabled(env), false);
  for (const size of MENU_ICON_SIZES) assert.equal(existsSync(appMenuIconPath(size, env)), false);
  assert.equal(existsSync(autostartPath(env)), false);
  // the shared builder still makes the autostart form by default
  assert.match(desktopEntry(['a']), /^X-GNOME-Autostart-enabled=true$/m);
  assert.doesNotMatch(desktopEntry(['a']), /^Icon=/m);
});

test('autostart: the login entry starts hidden; a launch by hand does not', () => {
  const argv = autostartArgv(['/home/user/browse-bridge/bin/browse-bridge']);
  assert.deepEqual(argv, ['/home/user/browse-bridge/bin/browse-bridge', '--hidden']);
  assert.match(desktopEntry(argv), /^Exec=\/home\/user\/browse-bridge\/bin\/browse-bridge --hidden$/m);
  assert.equal(startsHidden(['electron', '/app', '--hidden']), true);
  assert.equal(startsHidden(['electron', '/app']), false, 'a manual launch shows the window');
  assert.equal(startsHidden(['electron', '/app', '--no-sandbox']), false);
});
