import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { iconPng, ICON_STATES, trayIconPng, TRAY_ICON_STATES } from '../src/icons.js';
import { AGGREGATE } from '../src/core/hosts.js';
import { autostartArgv, autostartPath, desktopEntry, isAutostartEnabled, setAutostart, startsHidden } from '../src/core/autostart.js';
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

test('autostart: the login entry starts hidden; a launch by hand does not', () => {
  const argv = autostartArgv(['/home/user/browse-bridge/bin/browse-bridge']);
  assert.deepEqual(argv, ['/home/user/browse-bridge/bin/browse-bridge', '--hidden']);
  assert.match(desktopEntry(argv), /^Exec=\/home\/user\/browse-bridge\/bin\/browse-bridge --hidden$/m);
  assert.equal(startsHidden(['electron', '/app', '--hidden']), true);
  assert.equal(startsHidden(['electron', '/app']), false, 'a manual launch shows the window');
  assert.equal(startsHidden(['electron', '/app', '--no-sandbox']), false);
});
