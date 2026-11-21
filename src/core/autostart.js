import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { iconPng } from '../icons.js';

const ENTRY_FILE = 'browse-bridge.desktop';
/** hicolor sizes the application-menu entry installs its icon at. */
export const MENU_ICON_SIZES = [48, 128];

/** An XDG base directory: the variable when set, else `~/<fallback>`. */
function xdgBase(env, variable, fallback) {
  return env[variable] || join(env.HOME || homedir(), fallback);
}

/** Electron's setLoginItemSettings does nothing on Linux; XDG autostart is what Plasma reads. */
export function autostartPath(env = process.env) {
  return join(xdgBase(env, 'XDG_CONFIG_HOME', '.config'), 'autostart', ENTRY_FILE);
}

/** Where the application-menu entry (KRunner, Kickoff, GNOME's overview) lives. */
export function appMenuPath(env = process.env) {
  return join(xdgBase(env, 'XDG_DATA_HOME', '.local/share'), 'applications', ENTRY_FILE);
}

/** The installed icon at one hicolor size; the entry names it as `Icon=browse-bridge`. */
export function appMenuIconPath(size, env = process.env) {
  return join(xdgBase(env, 'XDG_DATA_HOME', '.local/share'), 'icons', 'hicolor', `${size}x${size}`, 'apps', 'browse-bridge.png');
}

/** Quote one Exec= argument per the desktop entry spec. */
function desktopQuote(arg) {
  if (!/[\s"'\\`$<>|&;*?#()]/.test(arg)) return arg;
  return `"${arg.replace(/(["`$\\])/g, '\\$1')}"`;
}

/** The autostart entry by default; `{ menu: true }` is the application-menu entry (an Icon, no autostart keys). */
export function desktopEntry(execArgv, { menu = false } = {}) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=browse-bridge',
    'Comment=Bridge a remote agent host\'s browse relay to this browser over SSH',
    `Exec=${execArgv.map(desktopQuote).join(' ')}`,
    ...(menu ? ['Icon=browse-bridge', 'Categories=Network;'] : []),
    'Terminal=false',
    ...(menu ? [] : ['X-GNOME-Autostart-enabled=true', 'X-KDE-autostart-after=panel']),
    '',
  ].join('\n');
}

/** The flag the login autostart passes so the app starts in the tray without a window. */
export const HIDDEN_FLAG = '--hidden';

export function autostartArgv(launcher) {
  return [...launcher, HIDDEN_FLAG];
}

export function startsHidden(argv) {
  return argv.includes(HIDDEN_FLAG);
}

export function isAutostartEnabled(env = process.env) {
  return existsSync(autostartPath(env));
}

function writeEntry(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return readFileSync(path, 'utf8').includes('Exec=');
}

export function setAutostart(enabled, execArgv, env = process.env) {
  const path = autostartPath(env);
  if (!enabled) {
    rmSync(path, { force: true });
    return false;
  }
  return writeEntry(path, desktopEntry(execArgv));
}

export function isAppMenuEnabled(env = process.env) {
  return existsSync(appMenuPath(env));
}

/**
 * Add or remove the application-menu entry and its icons. `launcher` is the
 * plain launch argv: a menu launch shows the window, so it never carries --hidden.
 */
export function setAppMenu(enabled, launcher, env = process.env) {
  const path = appMenuPath(env);
  const icons = MENU_ICON_SIZES.map((size) => appMenuIconPath(size, env));
  if (!enabled) {
    for (const p of [path, ...icons]) rmSync(p, { force: true });
    return false;
  }
  for (const [i, size] of MENU_ICON_SIZES.entries()) {
    mkdirSync(dirname(icons[i]), { recursive: true });
    writeFileSync(icons[i], iconPng('ready', size));
  }
  return writeEntry(path, desktopEntry(launcher, { menu: true }));
}
