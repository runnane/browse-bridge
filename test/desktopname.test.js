// BBR-81: Electron takes the window's Wayland app_id / X11 WM_CLASS from package.json
// `desktopName`, and Plasma groups a running window under the .desktop entry of that
// name. The app writes its own entries as ENTRY_FILE, so the two must stay equal.
// syncDesktopName makes electron-builder name the AppImage's embedded entry, and its
// StartupWMClass, after desktopName too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ENTRY_FILE, autostartPath, appMenuPath } from '../src/core/autostart.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('desktopName is the entry file the app writes', () => {
  assert.equal(ENTRY_FILE, 'browse-bridge.desktop');
  assert.equal(pkg.desktopName, ENTRY_FILE);
});

test('both written entries use that file name', () => {
  const env = { HOME: '/h', XDG_CONFIG_HOME: '/c', XDG_DATA_HOME: '/d' };
  assert.equal(autostartPath(env), '/c/autostart/browse-bridge.desktop');
  assert.equal(appMenuPath(env), '/d/applications/browse-bridge.desktop');
});

test('electron-builder names the AppImage entry after desktopName', () => {
  assert.equal(pkg.build.linux.syncDesktopName, true);
});
