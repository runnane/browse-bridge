// BBR-95: the POSIX shell the setup-script tests run under. Every CI and dev
// box this runs on today has dash as /bin/sh, so the bash-/bin/sh branch is
// reached only through the injected `bash` and `find` below.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findOnPath, isBash, resolvePosixSh } from './support/posix-sh.js';

const BASH_SH = '/bin/sh';
const isBashOnly = (...bashes) => (shell) => bashes.includes(shell);

test('posix sh: /bin/sh that is not bash is used as is, and PATH is not consulted', () => {
  const sh = resolvePosixSh({ bash: isBashOnly(), find: () => assert.fail('looked up dash') });
  assert.equal(sh, '/bin/sh');
});

test('posix sh: /bin/sh that is bash falls back to dash from PATH', () => {
  const sh = resolvePosixSh({ sh: BASH_SH, bash: isBashOnly(BASH_SH), find: (n) => (n === 'dash' ? '/opt/x/dash' : null) });
  assert.equal(sh, '/opt/x/dash');
});

test('posix sh: bash as /bin/sh and no dash fails loudly, naming the fix', () => {
  assert.throws(
    () => resolvePosixSh({ sh: BASH_SH, bash: isBashOnly(BASH_SH), find: () => null }),
    /\/bin\/sh is bash here and there is no dash on PATH.*Install dash/,
  );
});

test('posix sh: a "dash" on PATH that is really bash is refused too', () => {
  assert.throws(
    () => resolvePosixSh({ sh: BASH_SH, bash: isBashOnly(BASH_SH, '/opt/x/dash'), find: () => '/opt/x/dash' }),
    /Install dash/,
  );
});

test('posix sh: isBash tells real bash from a non-bash sh', () => {
  assert.equal(isBash('/usr/bin/bash'), true);
  const dash = findOnPath('dash', '/usr/bin:/bin');
  if (dash) assert.equal(isBash(dash), false);
});

test('posix sh: findOnPath returns an absolute executable, skips relative and non-executable entries', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bb-posixsh-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const a = join(root, 'a');
  const b = join(root, 'b');
  mkdirSync(a);
  mkdirSync(b);
  writeFileSync(join(a, 'dash'), '#!/bin/sh\n', { mode: 0o644 }); // not executable
  writeFileSync(join(b, 'dash'), '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(findOnPath('dash', ['relative', a, b].join(':')), join(b, 'dash'));
  assert.equal(findOnPath('dash', a), null);
});
