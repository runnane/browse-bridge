import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SETUP_SCRIPT, parseSetupOutput } from '../src/core/browse.js';

const PIN = '0.1.4';
// The only tools SETUP_SCRIPT needs once browse is installed. npm, ssh and browse are never linked.
const TOOLS = ['hostname', 'ss', 'netstat', 'awk'];

const FAKE_BROWSE = `#!/bin/sh
case "$1" in
  version) echo ${PIN} ;;
  status) echo '{}' ;;
  *) exit 0 ;;
esac
`;

// BBR-57: exec.js runs SETUP_SCRIPT under `sh`; on Alpine that is busybox ash,
// on Debian dash. bash stays covered for hosts whose sh is bash.
const BUSYBOX = ['/usr/bin/busybox', '/bin/busybox'].find((p) => existsSync(p)) ?? null;
const SHELLS = [['/bin/sh'], ['/usr/bin/bash'], ...(BUSYBOX ? [[BUSYBOX, 'sh']] : [])];

function runSetup(t, [shell, ...pre], browsePath) {
  const root = mkdtempSync(join(tmpdir(), 'bb-tilde-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  mkdirSync(join(home, 'bin'), { recursive: true });
  mkdirSync(bin);
  for (const tool of TOOLS) {
    for (const dir of ['/usr/bin', '/bin']) {
      try {
        symlinkSync(join(dir, tool), join(bin, tool));
        break;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
    }
  }
  const browse = join(home, 'bin', 'browse');
  writeFileSync(browse, FAKE_BROWSE);
  chmodSync(browse, 0o755);
  const r = spawnSync(shell, [...pre, '-s', '--', browsePath, PIN], {
    input: SETUP_SCRIPT,
    env: { HOME: home, PATH: bin },
    encoding: 'utf8',
  });
  return { r, parsed: parseSetupOutput(r.stdout) };
}

for (const shell of SHELLS) {
  for (const path of ['~/bin/browse', '$HOME/bin/browse']) {
    test(`setup script (${shell.join(' ')}): a remoteBrowse of ${path} is expanded, so the pinned install is found`, (t) => {
      const { r, parsed } = runSetup(t, shell, path);
      assert.equal(r.status, 0, `exit ${r.status}: ${r.stdout}${r.stderr}`);
      assert.equal(parsed.steps.install, 'skip');
      assert.equal(parsed.version, PIN);
    });
  }
}
