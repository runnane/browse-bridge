// BBR-95: which POSIX shell the setup-script tests run their `sh` cases under.
//
// exec.js runs every script() body remotely under `sh -s` (BBR-57), so the
// tests run them locally under a POSIX sh too. Those runs are evidence only
// where that sh is not bash: bash accepts bash-only syntax that dash refuses.
// On Debian/Ubuntu /bin/sh is dash and is used as is. On Arch /bin/sh is bash,
// so dash from PATH stands in, and neither one means the gate fails loudly
// rather than passing on bash in disguise.
//
// Resolved once, at import, to an absolute path: the tests then run with a
// stub PATH that has no dash on it.
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

/** True when `shell` is bash, whatever it is called (it sets BASH_VERSION). */
export function isBash(shell) {
  const r = spawnSync(shell, ['-c', 'echo "${BASH_VERSION:-none}"'], { encoding: 'utf8' });
  if (r.error) throw r.error;
  return r.stdout.trim() !== 'none';
}

/** The first executable `name` on `path`, as an absolute path, or null. */
export function findOnPath(name, path = process.env.PATH ?? '') {
  for (const dir of path.split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const p = join(dir, name);
    try {
      if (existsSync(p) && statSync(p).isFile() && (statSync(p).mode & 0o111)) return p;
    } catch {
      // unreadable entry: keep looking
    }
  }
  return null;
}

/**
 * The POSIX shell to test under: `sh` when it is not bash, else dash from
 * PATH. Throws, naming the fix, when there is neither.
 */
export function resolvePosixSh({ sh = '/bin/sh', bash = isBash, find = (n) => findOnPath(n) } = {}) {
  if (!bash(sh)) return sh;
  const dash = find('dash');
  if (dash && !bash(dash)) return dash;
  throw new Error(`${sh} is bash here and there is no dash on PATH, so the POSIX sh runs would prove nothing. Install dash (it does not have to be /bin/sh), e.g. \`pacman -S dash\`.`);
}

let resolved;
let error = null;
try {
  resolved = resolvePosixSh();
} catch (e) {
  // Keep the file loadable so its guard test can fail with this message;
  // the other cases then run under /bin/sh and prove only what bash proves.
  resolved = '/bin/sh';
  error = e;
}

/** Absolute path of the POSIX shell the tests use. */
export const POSIX_SH = resolved;
/** Why no non-bash POSIX shell was found, or null. */
export const POSIX_SH_ERROR = error;
