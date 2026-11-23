import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/core/exec.js';
import { readVersion } from '../src/core/version.js';

// Git with no user or system configuration, so the host's gitconfig cannot change what is measured.
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const GIT_ID = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];
const git = (cwd, ...args) => execFileSync('git', [...GIT_ID, ...args], { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
const isolatedRun = (cmd, args, opts) => run(cmd, args, { ...opts, env: GIT_ENV });

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'bb-version-'));
}

/** package.json one field per line, as npm writes it, so an edit to one field leaves the others' lines alone. */
function writePkg(dir, fields) {
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(fields, null, 2)}\n`);
}

/** A throwaway checkout with a package.json at 0.1.0, one commit. */
function tempRepo() {
  const dir = tempDir();
  writePkg(dir, { name: 'x', version: '0.1.0' });
  git(dir, 'init', '-q');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

function withDir(dir, fn) {
  return Promise.resolve().then(fn).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** Commit one more file, touching nothing in package.json. */
function commitOther(dir, name) {
  writeFileSync(join(dir, name), name);
  git(dir, 'add', name);
  git(dir, 'commit', '-q', '-m', name);
}

test('version: a packaged build returns the given version and never calls git, even inside a checkout (BBR-70)', () => {
  const dir = tempRepo();
  return withDir(dir, async () => {
    const calls = [];
    const recording = (cmd, args) => {
      calls.push([cmd, ...args]);
      throw new Error('git must not run for a packaged build');
    };
    const given = await readVersion(dir, { exec: recording, packaged: true, version: '0.3.1' });
    assert.deepEqual(calls, [], 'a packaged build makes no git call');
    assert.equal(given, '0.3.1');
    // without a passed version it falls back to package.json's, still without git
    const fallback = await readVersion(dir, { exec: recording, packaged: true });
    assert.deepEqual(calls, [], 'a packaged build makes no git call');
    assert.equal(fallback, '0.1.0');
  });
});

test('version: the commit that set the version gives <package version>+0 <short commit>', () => {
  const dir = tempRepo();
  return withDir(dir, async () => {
    const sha = git(dir, 'rev-parse', '--short', 'HEAD');
    const v = await readVersion(dir, { exec: isolatedRun });
    assert.equal(v, `0.1.0+0 ${sha}`);
    assert.match(v, /^0\.1\.0\+0 [0-9a-f]{7,}$/);
  });
});

test('version: +N counts commits since the version line last changed, and a bump resets it', () => {
  const dir = tempRepo();
  return withDir(dir, async () => {
    commitOther(dir, 'a');
    commitOther(dir, 'b');
    // A package.json edit that leaves the version line alone does not reset the count
    // (the new field goes above "version", which stays the last line, comma-free).
    writePkg(dir, { name: 'x', description: 'd', version: '0.1.0' });
    git(dir, 'commit', '-q', '-am', 'describe');
    let sha = git(dir, 'rev-parse', '--short', 'HEAD');
    assert.equal(await readVersion(dir, { exec: isolatedRun }), `0.1.0+3 ${sha}`);

    writePkg(dir, { name: 'x', description: 'd', version: '0.2.0' });
    git(dir, 'commit', '-q', '-am', 'bump');
    sha = git(dir, 'rev-parse', '--short', 'HEAD');
    assert.equal(await readVersion(dir, { exec: isolatedRun }), `0.2.0+0 ${sha}`);

    commitOther(dir, 'c');
    sha = git(dir, 'rev-parse', '--short', 'HEAD');
    assert.equal(await readVersion(dir, { exec: isolatedRun }), `0.2.0+1 ${sha}`);
  });
});

test('version: a dirty tree adds (modified)', () => {
  const dir = tempRepo();
  return withDir(dir, async () => {
    const sha = git(dir, 'rev-parse', '--short', 'HEAD');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.1.0', changed: true }));
    assert.equal(await readVersion(dir, { exec: isolatedRun }), `0.1.0+0 ${sha} (modified)`);
  });
});

test('version: a failing count drops +N but keeps the commit', () => {
  const dir = tempRepo();
  return withDir(dir, async () => {
    const sha = git(dir, 'rev-parse', '--short', 'HEAD');
    const noCount = (cmd, args, opts) => (args.includes('rev-list') ? Promise.resolve({ code: 1, stdout: '' }) : isolatedRun(cmd, args, opts));
    assert.equal(await readVersion(dir, { exec: noCount }), `0.1.0 ${sha}`);
  });
});

test('version: a directory that is not a checkout gives v<package version> alone', () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.1.0' }));
  return withDir(dir, async () => {
    assert.equal(await readVersion(dir, { exec: isolatedRun }), '0.1.0');
  });
});

test('version: no git on the machine gives v<package version> alone', () => {
  const dir = tempRepo();
  return withDir(dir, async () => {
    // The real exec, with an empty PATH: spawning git fails with ENOENT.
    const noPath = (cmd, args, opts) => run(cmd, args, { ...opts, env: { ...GIT_ENV, PATH: '' } });
    assert.equal(await readVersion(dir, { exec: noPath }), '0.1.0');
    // And an exec that throws or rejects outright.
    assert.equal(await readVersion(dir, { exec: () => { throw new Error('boom'); } }), '0.1.0');
    assert.equal(await readVersion(dir, { exec: () => Promise.reject(new Error('boom')) }), '0.1.0');
  });
});

test('version: a git binary that hangs times out to the fallback, bounded in time', () => {
  const dir = tempRepo();
  const bin = tempDir();
  writeFileSync(join(bin, 'git'), '#!/bin/sh\nexec sleep 30\n');
  chmodSync(join(bin, 'git'), 0o755);
  return withDir(dir, async () => {
    try {
      const hung = (cmd, args, opts) => run(cmd, args, { ...opts, env: { ...GIT_ENV, PATH: `${bin}:${GIT_ENV.PATH}` } });
      const t0 = Date.now();
      const v = await readVersion(dir, { exec: hung, timeoutMs: 300 });
      const elapsed = Date.now() - t0;
      assert.equal(v, '0.1.0');
      assert.ok(elapsed < 3000, `took ${elapsed} ms`);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
});

test('version: an exec that never answers (ignores its own timeout) is still cut off', () => {
  const dir = tempRepo();
  return withDir(dir, async () => {
    const t0 = Date.now();
    const v = await readVersion(dir, { exec: () => new Promise(() => {}), timeoutMs: 200 });
    assert.equal(v, '0.1.0');
    assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
  });
});
