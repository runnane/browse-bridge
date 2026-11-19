import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Electron's setLoginItemSettings does nothing on Linux; XDG autostart is what Plasma reads. */
export function autostartPath(env = process.env) {
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config');
  return join(base, 'autostart', 'browse-bridge.desktop');
}

/** Quote one Exec= argument per the desktop entry spec. */
function desktopQuote(arg) {
  if (!/[\s"'\\`$<>|&;*?#()]/.test(arg)) return arg;
  return `"${arg.replace(/(["`$\\])/g, '\\$1')}"`;
}

export function desktopEntry(execArgv) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=browse-bridge',
    'Comment=Bridge a remote agent host\'s browse relay to this browser over SSH',
    `Exec=${execArgv.map(desktopQuote).join(' ')}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    'X-KDE-autostart-after=panel',
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

export function setAutostart(enabled, execArgv, env = process.env) {
  const path = autostartPath(env);
  if (!enabled) {
    rmSync(path, { force: true });
    return false;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, desktopEntry(execArgv));
  return readFileSync(path, 'utf8').includes('Exec=');
}
