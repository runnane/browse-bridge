import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/core/exec.js';
import { CHECK_UPDATES_LABEL } from '../src/core/labels.js';
import { checkForUpdate, defaultBranch, failureReason, gitEnv, performUpdate, pickInstaller, updateSummary } from '../src/core/updater.js';

// ---------- an injected exec: no test here runs git against a remote, or npm ----------

const DIR = '/checkout';
const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const done = (stdout = '') => ({ code: 0, stdout, stderr: '', timedOut: false });
const fail = (code = 128, stderr = 'fatal: something broke') => ({ code, stdout: '', stderr, timedOut: false });

/**
 * A git that answers by the start of its argv (after `-C <dir>`), every answer
 * a healthy checkout on main, one fast-forward behind origin. `answers`
 * overrides one; a function answer gets the call. Every call is recorded,
 * installs included, so a test can say what never ran.
 */
function fakeExec(answers = {}) {
  const calls = [];
  let merged = false;
  const table = {
    'rev-parse --is-inside-work-tree': done('true'),
    'symbolic-ref --quiet --short refs/remotes/origin/HEAD': done('origin/main'),
    'rev-parse --verify --quiet refs/remotes/origin/main': fail(1, ''),
    'rev-parse --verify --quiet refs/remotes/origin/master': fail(1, ''),
    fetch: done(),
    'rev-list --left-right --count': done('0\t3'),
    log: done('feat: one\nfix: two\nfix: three'),
    'status --porcelain --untracked-files=no': done(''),
    'symbolic-ref --quiet --short HEAD': done('main'),
    'merge-base --is-ancestor': done(),
    'rev-parse HEAD': () => done(merged ? NEW : OLD),
    'rev-parse origin/main': done(NEW),
    merge: () => { merged = true; return done(); },
    diff: done(''),
    install: done('added 3 packages'),
    ...answers,
  };
  const exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    let key;
    if (cmd === 'git') {
      assert.deepEqual(args.slice(0, 2), ['-C', DIR], 'every git call names the checkout');
      const line = args.slice(2).join(' ');
      key = Object.keys(table).filter((k) => line === k || line.startsWith(`${k} `)).sort((a, b) => b.length - a.length)[0];
      if (!key) throw new Error(`unexpected git call: ${line}`);
    } else {
      key = 'install';
    }
    const a = table[key];
    return typeof a === 'function' ? a({ cmd, args, opts }) : a;
  };
  const gitCalls = () => calls.filter((c) => c.cmd === 'git').map((c) => c.args.slice(2).join(' '));
  const installs = () => calls.filter((c) => c.cmd !== 'git');
  return { exec, calls, gitCalls, installs };
}

const ENV = { PATH: '/usr/bin', HOME: '/home/u', SSH_AUTH_SOCK: '/run/agent' };
const NOW = () => new Date('2026-11-21T10:00:00Z');

test('updater: every git call is non-interactive and bounded, and keeps the caller\'s environment', async () => {
  assert.deepEqual(gitEnv(ENV), { ...ENV, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' });
  for (const go of [
    (f) => checkForUpdate(DIR, { exec: f.exec, env: ENV, now: NOW }),
    (f) => performUpdate(DIR, { exec: f.exec, env: ENV, exists: () => false }),
  ]) {
    const f = fakeExec();
    await go(f);
    const git = f.calls.filter((c) => c.cmd === 'git');
    assert.ok(git.length > 3);
    for (const c of git) {
      assert.equal(c.opts.env.GIT_TERMINAL_PROMPT, '0', c.args.join(' '));
      assert.equal(c.opts.env.GIT_SSH_COMMAND, 'ssh -o BatchMode=yes', c.args.join(' '));
      assert.equal(c.opts.env.SSH_AUTH_SOCK, '/run/agent', 'the ssh agent is still reachable');
      assert.equal(c.opts.env.PATH, '/usr/bin');
      assert.ok(Number.isFinite(c.opts.timeoutMs) && c.opts.timeoutMs > 0, `${c.args.join(' ')} has a timeout`);
    }
    const fetch = git.find((c) => c.args[2] === 'fetch');
    assert.deepEqual(fetch.args.slice(2), ['fetch', '--quiet', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
    assert.ok(fetch.opts.timeoutMs >= 30_000, 'a fetch gets a network-sized timeout');
  }
});

test('updater: a checkout behind origin reports the count and the subjects', async () => {
  const f = fakeExec();
  const r = await checkForUpdate(DIR, { exec: f.exec, env: ENV, now: NOW });
  assert.deepEqual(r, {
    status: 'available', branch: 'main', branchSource: 'origin/HEAD', checkedAt: '2026-11-21T10:00:00.000Z',
    behind: 3, ahead: 0, subjects: ['feat: one', 'fix: two', 'fix: three'],
  });
  assert.ok(f.gitCalls().includes('rev-list --left-right --count HEAD...origin/main'));
  assert.equal(f.installs().length, 0);
  assert.ok(!f.gitCalls().some((c) => /^(merge|status)/.test(c)), 'a check changes nothing');
  const s = updateSummary({ enabled: true, result: r });
  assert.equal(s.line, 'Update available: 3 commits');
  assert.equal(s.canUpdate, true);
  assert.deepEqual(s.subjects, ['feat: one', 'fix: two', 'fix: three']);
  assert.equal(updateSummary({ result: { ...r, behind: 1 } }).line, 'Update available: 1 commit');
});

test('updater: a failed fetch is "could not check", never "up to date"', async () => {
  // Hostile: the count would say "nothing new" if it were reached.
  const f = fakeExec({
    fetch: fail(128, 'fatal: unable to access \'https://user:secret@github.example/x.git/\': Could not resolve host: github.example'),
    'rev-list --left-right --count': done('0\t0'),
  });
  const r = await checkForUpdate(DIR, { exec: f.exec, env: ENV, now: NOW });
  assert.equal(r.status, 'failed');
  assert.match(r.reason, /^git fetch failed: fatal: unable to access/);
  assert.doesNotMatch(r.reason, /secret|https:/, 'the remote URL is not repeated into the log');
  assert.ok(!f.gitCalls().some((c) => c.startsWith('rev-list')), 'nothing is counted after a failed fetch');
  const s = updateSummary({ enabled: true, result: r });
  assert.equal(s.line, null);
  assert.match(s.detail, /^Could not check for updates: git fetch failed/);
  assert.doesNotMatch(s.detail, /up to date/i);
  assert.equal(s.canUpdate, false);
  assert.equal(s.canCheck, true, 'Check Now stays available to retry');

  // A fetch that hangs is cut off by its own deadline, and is a failed check too.
  const hung = fakeExec({ fetch: () => new Promise(() => {}) });
  const t0 = Date.now();
  const h = await checkForUpdate(DIR, { exec: hung.exec, env: ENV, now: NOW, fetchTimeoutMs: 50 });
  assert.equal(h.status, 'failed');
  assert.equal(h.reason, 'git fetch failed: it timed out');
  assert.ok(Date.now() - t0 < 3000);

  // A count that fails after a good fetch is not "up to date" either.
  const noCount = fakeExec({ 'rev-list --left-right --count': fail() });
  assert.equal((await checkForUpdate(DIR, { exec: noCount.exec, env: ENV, now: NOW })).status, 'failed');
});

test('updater: level with origin is "up to date"; outside a checkout nothing is checked', async () => {
  const f = fakeExec({ 'rev-list --left-right --count': done('0\t0') });
  const r = await checkForUpdate(DIR, { exec: f.exec, env: ENV, now: NOW });
  assert.equal(r.status, 'current');
  assert.equal(updateSummary({ result: r }).detail, 'Up to date with origin/main.');
  assert.equal(updateSummary({ result: r }).line, null);

  const outside = fakeExec({ 'rev-parse --is-inside-work-tree': fail(128, 'fatal: not a git repository') });
  const u = await checkForUpdate(DIR, { exec: outside.exec, env: ENV, now: NOW });
  assert.equal(u.status, 'unsupported');
  assert.deepEqual(outside.gitCalls(), ['rev-parse --is-inside-work-tree'], 'no fetch outside a checkout');
  assert.equal(updateSummary({ result: u }).canCheck, false);
});

test('updater: the default branch is origin/HEAD, else origin/main or origin/master, and says which', async () => {
  const noHead = { 'symbolic-ref --quiet --short refs/remotes/origin/HEAD': fail(1, '') };
  assert.deepEqual(await defaultBranch(DIR, { exec: fakeExec({ 'symbolic-ref --quiet --short refs/remotes/origin/HEAD': done('origin/trunk') }).exec }),
    { branch: 'trunk', source: 'origin/HEAD' });
  assert.deepEqual(await defaultBranch(DIR, { exec: fakeExec({ ...noHead, 'rev-parse --verify --quiet refs/remotes/origin/master': done('x') }).exec }),
    { branch: 'master', source: 'origin/master, as origin/HEAD is not set' });
  assert.equal(await defaultBranch(DIR, { exec: fakeExec(noHead).exec }), null);
  const f = fakeExec(noHead);
  const r = await checkForUpdate(DIR, { exec: f.exec, env: ENV, now: NOW });
  assert.equal(r.status, 'failed');
  assert.match(r.reason, /default branch is unknown/);
  assert.ok(!f.gitCalls().some((c) => c.startsWith('fetch')));
});

/** Each refusal leaves the checkout alone: no merge, no install, no relaunch. */
function assertRefused(r, f, refusal, message) {
  assert.equal(r.ok, false);
  assert.equal(r.refusal, refusal);
  assert.equal(r.relaunch, false);
  assert.match(r.message, message);
  assert.ok(!f.gitCalls().some((c) => c.startsWith('merge ')), 'no merge ran');
  assert.equal(f.installs().length, 0, 'no install ran');
}

test('updater: a dirty tree is refused, with the reason', async () => {
  const f = fakeExec({ 'status --porcelain --untracked-files=no': done(' M src/main.js\nM  README.md') });
  const r = await performUpdate(DIR, { exec: f.exec, env: ENV, exists: () => false });
  assertRefused(r, f, 'dirty', /^Not updated: 2 tracked files have local changes in \/checkout\. Commit or stash them/);
  assert.ok(!f.gitCalls().some((c) => c.startsWith('fetch')), 'refused before any fetch');
  // An unreadable status is refused too, never read as clean.
  const broken = fakeExec({ 'status --porcelain --untracked-files=no': fail() });
  assertRefused(await performUpdate(DIR, { exec: broken.exec, env: ENV }), broken, 'failed', /Could not read the checkout's state/);
});

test('updater: a HEAD that is not the default branch is refused, detached included', async () => {
  const other = fakeExec({ 'symbolic-ref --quiet --short HEAD': done('feat/x') });
  assertRefused(await performUpdate(DIR, { exec: other.exec, env: ENV }), other, 'branch', /^Not updated: the checkout is on feat\/x, not main\. Switch to main/);
  const detached = fakeExec({ 'symbolic-ref --quiet --short HEAD': fail(1, '') });
  assertRefused(await performUpdate(DIR, { exec: detached.exec, env: ENV }), detached, 'branch', /^Not updated: HEAD is detached/);
});

test('updater: a HEAD that is not an ancestor of origin is refused; a broken ancestry check is not read as one', async () => {
  const diverged = fakeExec({ 'merge-base --is-ancestor': fail(1, '') });
  assertRefused(await performUpdate(DIR, { exec: diverged.exec, env: ENV }), diverged, 'diverged', /cannot fast-forward/);
  const broken = fakeExec({ 'merge-base --is-ancestor': fail(128, 'fatal: Not a valid object name') });
  assertRefused(await performUpdate(DIR, { exec: broken.exec, env: ENV }), broken, 'failed', /Could not compare main with origin\/main/);
  const noFetch = fakeExec({ fetch: fail(128, 'fatal: Could not read from remote repository.') });
  assertRefused(await performUpdate(DIR, { exec: noFetch.exec, env: ENV }), noFetch, 'fetch', /git fetch failed \(fatal: Could not read from remote repository\.\)/);
});

test('updater: the happy path fast-forwards, skips the install when no lockfile changed, and asks for a relaunch', async () => {
  const f = fakeExec();
  const r = await performUpdate(DIR, { exec: f.exec, env: ENV, exists: () => true });
  assert.deepEqual(r, { ok: true, message: `Updated to ${NEW.slice(0, 7)}; the dependencies did not change.`, relaunch: true, installer: null, updated: true, from: OLD, to: NEW });
  assert.deepEqual(f.gitCalls(), [
    'rev-parse --is-inside-work-tree',
    'symbolic-ref --quiet --short refs/remotes/origin/HEAD',
    'status --porcelain --untracked-files=no',
    'symbolic-ref --quiet --short HEAD',
    'fetch --quiet --no-tags origin +refs/heads/main:refs/remotes/origin/main',
    'merge-base --is-ancestor HEAD origin/main',
    'rev-parse HEAD',
    'rev-parse origin/main',
    'merge --ff-only --quiet origin/main',
    'rev-parse HEAD',
    `diff --name-only ${OLD} ${NEW} -- package.json pnpm-lock.yaml package-lock.json pnpm-workspace.yaml`,
  ]);
  assert.equal(f.installs().length, 0, 'no install when neither package.json nor a lockfile changed');

  // Already level: nothing merged, nothing relaunched.
  const level = fakeExec({ 'rev-parse origin/main': done(OLD) });
  const l = await performUpdate(DIR, { exec: level.exec, env: ENV });
  assert.equal(l.ok, true);
  assert.equal(l.relaunch, false);
  assert.ok(!level.gitCalls().some((c) => c.startsWith('merge ')));
});

test('updater: the install runs only when package.json or a lockfile changed, with the installer that made node_modules', async () => {
  const pnpm = fakeExec({ diff: done('pnpm-lock.yaml') });
  const seen = [];
  const r = await performUpdate(DIR, { exec: pnpm.exec, env: ENV, exists: (p) => { seen.push(p); return p === '/checkout/node_modules/.modules.yaml'; } });
  assert.equal(r.ok, true);
  assert.equal(r.relaunch, true);
  assert.equal(r.installer, 'pnpm');
  assert.deepEqual(pnpm.installs().map((c) => [c.cmd, c.args, c.opts.cwd]), [['pnpm', ['install'], DIR]]);
  assert.ok(pnpm.installs()[0].opts.timeoutMs >= 60_000, 'an install gets minutes, not seconds');
  assert.deepEqual(seen, ['/checkout/node_modules/.modules.yaml']);

  const npm = fakeExec({ diff: done('package.json') });
  const n = await performUpdate(DIR, { exec: npm.exec, env: ENV, exists: () => false });
  assert.equal(n.installer, 'npm');
  assert.deepEqual(npm.installs().map((c) => [c.cmd, c.args]), [['npm', ['install']]]);

  // A diff that fails is read as "changed": one install too many, never one missing.
  const unknown = fakeExec({ diff: fail() });
  await performUpdate(DIR, { exec: unknown.exec, env: ENV, exists: () => false });
  assert.equal(unknown.installs().length, 1);

  assert.equal(pickInstaller('/c', (p) => p === '/c/node_modules/.modules.yaml'), 'pnpm');
  assert.equal(pickInstaller('/c', () => false), 'npm');
});

test('updater: a failed install after the merge says what to run, and does not relaunch', async () => {
  const f = fakeExec({ diff: done('package.json'), install: fail(1, 'npm ERR! code E404') });
  const r = await performUpdate(DIR, { exec: f.exec, env: ENV, exists: () => false });
  assert.equal(r.ok, false);
  assert.equal(r.refusal, 'install');
  assert.equal(r.relaunch, false);
  assert.equal(r.updated, true);
  assert.equal(r.message, `Updated to ${NEW.slice(0, 7)}, but npm install failed (npm ERR! code E404). Run "npm install" in /checkout, then restart browse-bridge.`);
});

test('updater: the summary never claims "up to date" without a check, and follows the setting and a running update', () => {
  assert.equal(updateSummary({ enabled: true }).detail, 'Not checked yet.');
  assert.equal(updateSummary({ enabled: false }).detail, `Checking for updates is off (General → ${CHECK_UPDATES_LABEL}).`);
  assert.equal(updateSummary({ enabled: false }).canCheck, false);
  const available = { status: 'available', branch: 'main', behind: 2, ahead: 0, subjects: [] };
  const checking = updateSummary({ checking: true, result: available });
  assert.equal(checking.canUpdate, false, 'no update while a check runs');
  const updating = updateSummary({ updating: true, result: available });
  assert.equal(updating.line, 'Updating browse-bridge…');
  assert.equal(updating.canUpdate, false);
  const refused = updateSummary({ result: available, outcome: { ok: false, message: 'Not updated: HEAD is detached in /c. Switch to main, then try again.' } });
  assert.match(refused.detail, /^Not updated: HEAD is detached .* Update available: 2 commits on origin\/main\.$/);
  assert.match(updateSummary({ result: { ...available, ahead: 1 } }).detail, /also has 1 commit of its own/);
  assert.equal(failureReason({ code: 128, stderr: 'fatal: could not read from git@github.example:o/r.git', timedOut: false }), 'fatal: could not read from <remote>');
});

test('updater: exec.run starts the child in `cwd`, so the install runs in the checkout', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bb-cwd-')));
  try {
    const res = await run('pwd', [], { cwd: dir });
    assert.equal(res.code, 0);
    assert.equal(res.stdout.trim(), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- one real checkout, with a local bare "origin" in a temp dir ----------

// Git with no user or system configuration and no inherited repository, so nothing outside the temp dir is read or written.
const REAL_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/.test(k)));
Object.assign(REAL_ENV, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main'];
const git = (cwd, ...args) => execFileSync('git', [...ID, '-C', cwd, ...args], { env: REAL_ENV, encoding: 'utf8' }).trim();

function commit(dir, name, content, message = name) {
  writeFileSync(join(dir, name), content);
  git(dir, 'add', name);
  git(dir, 'commit', '-q', '-m', message);
}

test('updater: against a real checkout and a local bare origin: check, refuse while dirty, fast-forward, install only on a lockfile change', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bb-updater-'));
  try {
    const origin = join(root, 'origin.git');
    const seed = join(root, 'seed');
    const app = join(root, 'app');
    execFileSync('git', [...ID, 'init', '-q', '--bare', origin], { env: REAL_ENV });
    // stderr piped: cloning the still-empty origin warns about it.
    execFileSync('git', [...ID, 'clone', '-q', `file://${origin}`, seed], { env: REAL_ENV, stdio: 'pipe' });
    commit(seed, 'package.json', '{"name":"x"}\n', 'init');
    git(seed, 'push', '-q', 'origin', 'HEAD:main');
    execFileSync('git', [...ID, 'clone', '-q', `file://${origin}`, app], { env: REAL_ENV });

    // Real git, never npm: an install is recorded, not run.
    const installs = [];
    const exec = (cmd, args, opts) => (cmd === 'git' ? run(cmd, args, { ...opts, env: { ...opts.env, ...REAL_ENV } }) : (installs.push([cmd, ...args]), Promise.resolve(done())));
    const opts = { exec, env: REAL_ENV, exists: () => false };

    assert.equal((await checkForUpdate(app, opts)).status, 'current');
    commit(seed, 'a.txt', 'a', 'feat: a');
    commit(seed, 'b.txt', 'b', 'fix: b');
    git(seed, 'push', '-q', 'origin', 'HEAD:main');
    const r = await checkForUpdate(app, opts);
    assert.equal(r.status, 'available');
    assert.equal(r.behind, 2);
    assert.deepEqual(r.subjects, ['fix: b', 'feat: a']);
    assert.equal(r.branchSource, 'origin/HEAD');

    writeFileSync(join(app, 'package.json'), '{"name":"edited"}\n');
    const dirty = await performUpdate(app, opts);
    assert.equal(dirty.refusal, 'dirty');
    git(app, 'checkout', '-q', '--', 'package.json');
    // An untracked file (an npm user's package-lock.json) is not "dirty".
    writeFileSync(join(app, 'package-lock.json'), '{}\n');

    const before = git(app, 'rev-parse', 'HEAD');
    const up = await performUpdate(app, opts);
    assert.equal(up.ok, true, up.message);
    assert.equal(up.relaunch, true);
    assert.equal(up.from, before);
    assert.equal(git(app, 'rev-parse', 'HEAD'), git(seed, 'rev-parse', 'HEAD'));
    assert.deepEqual(installs, [], 'no install: no package.json or lockfile changed');

    commit(seed, 'package.json', '{"name":"x","dependencies":{}}\n', 'chore: deps');
    git(seed, 'push', '-q', 'origin', 'HEAD:main');
    const deps = await performUpdate(app, opts);
    assert.equal(deps.ok, true, deps.message);
    assert.deepEqual(installs, [['npm', 'install']]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
