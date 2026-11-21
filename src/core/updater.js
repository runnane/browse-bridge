/**
 * Updates for a source-checkout install (BBR-43). browse-bridge is installed as
 * a git clone, so "is there an update" is "is HEAD behind origin/<default>",
 * and updating is a fast-forward plus, when the dependencies changed, an
 * install. Everything here runs through an injected `exec` (core/exec.js's
 * run by default), so the tests never run git against a remote or run npm.
 *
 * Electron has no tty: every git call carries GIT_TERMINAL_PROMPT=0 and an ssh
 * command with BatchMode=yes, so a credential prompt fails instead of hanging,
 * and every call is bounded by a timeout.
 *
 * Nothing here relaunches the app: performUpdate returns a decision
 * (`relaunch: true`), and main.js relaunches through its clean quit().
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './exec.js';
import { CHECK_UPDATES_LABEL } from './labels.js';

/** The check runs at start-up and then this often. A convenience notice, so a timer is enough. */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Local git calls (status, rev-parse, merge): short. */
const GIT_TIMEOUT_MS = 10_000;
/** A fetch goes over the network. */
const FETCH_TIMEOUT_MS = 60_000;
/** npm / pnpm install may download Electron. */
const INSTALL_TIMEOUT_MS = 10 * 60_000;

/** Files whose change between the old and the new HEAD means the dependencies must be installed again. */
export const INSTALL_FILES = Object.freeze(['package.json', 'pnpm-lock.yaml', 'package-lock.json', 'pnpm-workspace.yaml']);

/** How many commit subjects an available update lists. */
const MAX_SUBJECTS = 10;

/** The environment every git call runs with: the caller's, plus no prompt of any kind. */
export function gitEnv(env = process.env) {
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' };
}

/**
 * Run git in `dir`. Resolves (never rejects) with { code, stdout, stderr,
 * timedOut }, trimmed; a hang or a child that ignores SIGTERM resolves as a
 * timeout. Unlike version.js, the exit code is kept: `merge-base
 * --is-ancestor` answers "no" with 1 and "broken" with anything else.
 */
async function git(exec, dir, args, { timeoutMs, env }) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ code: -1, stdout: '', stderr: `did not finish in ${Math.round(timeoutMs / 1000)} s`, timedOut: true }), timeoutMs + 250);
  });
  try {
    const res = await Promise.race([exec('git', ['-C', dir, ...args], { timeoutMs, env }), deadline]);
    return {
      code: res?.code ?? -1,
      stdout: String(res?.stdout ?? '').trim(),
      stderr: String(res?.stderr ?? '').trim(),
      timedOut: Boolean(res?.timedOut),
    };
  } catch (err) {
    return { code: -1, stdout: '', stderr: String(err?.message ?? err), timedOut: false };
  } finally {
    clearTimeout(timer);
  }
}

const ok = (res) => res.code === 0 && !res.timedOut;

/**
 * Why a git call failed, in a few words. The last stderr line ("fatal: …"),
 * with any URL dropped: it ends up in the log, and the log in Copy Diagnostics.
 */
export function failureReason(res) {
  if (res.timedOut) return 'it timed out';
  const line = res.stderr.split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? `exit code ${res.code}`;
  const clean = line.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>').replace(/\b[\w.-]+@[\w.-]+:\S+/g, '<remote>');
  return clean.length > 160 ? `${clean.slice(0, 159)}…` : clean;
}

const BRANCH_NAME = /^[A-Za-z0-9._/][A-Za-z0-9._/-]*$/;

/**
 * The branch updates come from: what origin/HEAD points at (set by `git
 * clone`), else origin/main, else origin/master. Returns { branch, source }
 * where `source` says which rule found it, or null when none did.
 */
export async function defaultBranch(dir, { exec = run, env = process.env, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  const opts = { timeoutMs, env: gitEnv(env) };
  const sym = await git(exec, dir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], opts);
  if (ok(sym) && sym.stdout.startsWith('origin/')) {
    const branch = sym.stdout.slice('origin/'.length);
    if (BRANCH_NAME.test(branch)) return { branch, source: 'origin/HEAD' };
  }
  for (const branch of ['main', 'master']) {
    const ref = await git(exec, dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], opts);
    if (ok(ref)) return { branch, source: `origin/${branch}, as origin/HEAD is not set` };
  }
  return null;
}

/** Update refs/remotes/origin/<branch> from the remote; nothing else is fetched. */
function fetchBranch(exec, dir, branch, { env, fetchTimeoutMs }) {
  return git(exec, dir, ['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { timeoutMs: fetchTimeoutMs, env });
}

/** Is `dir` the work tree of a git checkout? */
async function isCheckout(exec, dir, opts) {
  const res = await git(exec, dir, ['rev-parse', '--is-inside-work-tree'], opts);
  return ok(res) && res.stdout === 'true';
}

/**
 * Fetch the default branch and count the commits HEAD lacks. Never throws.
 * Resolves with one of:
 *   { status: 'unsupported', reason }            not a git checkout: nothing to check
 *   { status: 'failed', reason, branch? }         could not check — never read as up to date
 *   { status: 'current', branch, ahead }
 *   { status: 'available', branch, behind, ahead, subjects }
 * each with `checkedAt` (ISO) and, once the branch is known, `branchSource`.
 */
export async function checkForUpdate(dir, { exec = run, env = process.env, timeoutMs = GIT_TIMEOUT_MS, fetchTimeoutMs = FETCH_TIMEOUT_MS, now = () => new Date() } = {}) {
  const checkedAt = now().toISOString();
  const opts = { timeoutMs, env: gitEnv(env) };
  if (!await isCheckout(exec, dir, opts)) return { status: 'unsupported', reason: 'this install is not a git checkout', checkedAt };
  const def = await defaultBranch(dir, { exec, env, timeoutMs });
  if (!def) return { status: 'failed', reason: 'the default branch is unknown: origin/HEAD is not set and there is no origin/main or origin/master', checkedAt };
  const { branch, source: branchSource } = def;
  const base = { branch, branchSource, checkedAt };

  const fetched = await fetchBranch(exec, dir, branch, { env: opts.env, fetchTimeoutMs });
  if (!ok(fetched)) return { ...base, status: 'failed', reason: `git fetch failed: ${failureReason(fetched)}` };

  const counts = await git(exec, dir, ['rev-list', '--left-right', '--count', `HEAD...origin/${branch}`], opts);
  const m = ok(counts) ? /^(\d+)\s+(\d+)$/.exec(counts.stdout) : null;
  if (!m) return { ...base, status: 'failed', reason: `could not count the new commits: ${ok(counts) ? 'unexpected output' : failureReason(counts)}` };
  const ahead = Number(m[1]);
  const behind = Number(m[2]);
  if (behind === 0) return { ...base, status: 'current', ahead };

  const log = await git(exec, dir, ['log', '--no-merges', '--format=%s', `-n${MAX_SUBJECTS}`, `HEAD..origin/${branch}`], opts);
  const subjects = ok(log) ? log.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];
  return { ...base, status: 'available', behind, ahead, subjects };
}

/**
 * Which package manager installed this checkout's node_modules: pnpm leaves
 * node_modules/.modules.yaml, npm does not. The only tracked lockfile is
 * pnpm's, but the README's first install is `npm install`, so the lockfile
 * on disk does not say which one the user has.
 */
export function pickInstaller(dir, exists = existsSync) {
  return exists(join(dir, 'node_modules', '.modules.yaml')) ? 'pnpm' : 'npm';
}

const refuse = (refusal, message, extra = {}) => ({ ok: false, refusal, message, relaunch: false, ...extra });

/**
 * Fast-forward the checkout to origin/<default>, install when the
 * dependencies changed, and say whether to relaunch. Runs only on the user's
 * click. Never throws. Refuses, changing nothing, when:
 *   dirty     a tracked file has local changes (untracked files do not count:
 *             an npm user's package-lock.json is untracked, and the merge
 *             itself refuses to overwrite an untracked file)
 *   branch    HEAD is detached or not on the default branch
 *   fetch     the fetch failed
 *   diverged  HEAD is not an ancestor of origin/<default>
 *   failed    a git call failed, or this is not a checkout
 * After a merge that changed INSTALL_FILES it runs `<installer> install`; if
 * that fails the code is already updated, so the result is refusal 'install'
 * with the command to run, and no relaunch.
 * Resolves with { ok, refusal?, message, relaunch, updated, from, to, installer }.
 */
export async function performUpdate(dir, {
  exec = run, env = process.env, exists = existsSync,
  timeoutMs = GIT_TIMEOUT_MS, fetchTimeoutMs = FETCH_TIMEOUT_MS, installTimeoutMs = INSTALL_TIMEOUT_MS,
} = {}) {
  const opts = { timeoutMs, env: gitEnv(env) };
  if (!await isCheckout(exec, dir, opts)) return refuse('failed', 'This install is not a git checkout, so it cannot update itself.');
  const def = await defaultBranch(dir, { exec, env, timeoutMs });
  if (!def) return refuse('failed', 'Cannot tell the default branch: origin/HEAD is not set and there is no origin/main or origin/master.');
  const { branch } = def;

  const status = await git(exec, dir, ['status', '--porcelain', '--untracked-files=no'], opts);
  if (!ok(status)) return refuse('failed', `Could not read the checkout's state: ${failureReason(status)}.`);
  if (status.stdout !== '') {
    const n = status.stdout.split('\n').length;
    return refuse('dirty', `Not updated: ${n} tracked file${n === 1 ? ' has' : 's have'} local changes in ${dir}. Commit or stash them, then try again.`);
  }

  const head = await git(exec, dir, ['symbolic-ref', '--quiet', '--short', 'HEAD'], opts);
  if (!ok(head)) return refuse('branch', `Not updated: HEAD is detached in ${dir}. Switch to ${branch}, then try again.`);
  if (head.stdout !== branch) return refuse('branch', `Not updated: the checkout is on ${head.stdout}, not ${branch}. Switch to ${branch}, then try again.`);

  const fetched = await fetchBranch(exec, dir, branch, { env: opts.env, fetchTimeoutMs });
  if (!ok(fetched)) return refuse('fetch', `Not updated: git fetch failed (${failureReason(fetched)}).`);

  const ancestor = await git(exec, dir, ['merge-base', '--is-ancestor', 'HEAD', `origin/${branch}`], opts);
  if (ancestor.code === 1 && !ancestor.timedOut) {
    return refuse('diverged', `Not updated: ${branch} has commits that origin/${branch} does not, so it cannot fast-forward. Merge or rebase it by hand.`);
  }
  if (!ok(ancestor)) return refuse('failed', `Could not compare ${branch} with origin/${branch}: ${failureReason(ancestor)}.`);

  const before = await git(exec, dir, ['rev-parse', 'HEAD'], opts);
  const target = await git(exec, dir, ['rev-parse', `origin/${branch}`], opts);
  if (!ok(before) || !ok(target)) return refuse('failed', `Could not read the commits to update between: ${failureReason(ok(before) ? target : before)}.`);
  const from = before.stdout;
  if (from === target.stdout) return { ok: true, message: `Already up to date with origin/${branch}.`, relaunch: false, updated: false, from, to: from, installer: null };

  const merged = await git(exec, dir, ['merge', '--ff-only', '--quiet', `origin/${branch}`], opts);
  if (!ok(merged)) return refuse('failed', `Not updated: git merge --ff-only failed (${failureReason(merged)}).`);
  const after = await git(exec, dir, ['rev-parse', 'HEAD'], opts);
  const to = ok(after) ? after.stdout : target.stdout;

  // A diff that fails is read as "changed": an install too many is cheap, a missing one breaks the start.
  const diff = await git(exec, dir, ['diff', '--name-only', from, to, '--', ...INSTALL_FILES], opts);
  const needsInstall = !ok(diff) || diff.stdout !== '';
  const base = { updated: true, from, to };
  if (!needsInstall) return { ok: true, message: `Updated to ${to.slice(0, 7)}; the dependencies did not change.`, relaunch: true, installer: null, ...base };

  const installer = pickInstaller(dir, exists);
  let res;
  try {
    res = await exec(installer, ['install'], { cwd: dir, env, timeoutMs: installTimeoutMs });
  } catch (err) {
    res = { code: -1, stdout: '', stderr: String(err?.message ?? err), timedOut: false };
  }
  if (!res || res.code !== 0 || res.timedOut) {
    const why = res?.timedOut ? 'it timed out' : failureReason({ code: res?.code ?? -1, stderr: String(res?.stderr ?? ''), timedOut: false });
    return refuse('install', `Updated to ${to.slice(0, 7)}, but ${installer} install failed (${why}). Run "${installer} install" in ${dir}, then restart browse-bridge.`, { installer, ...base });
  }
  return { ok: true, message: `Updated to ${to.slice(0, 7)} and ran ${installer} install.`, relaunch: true, installer, ...base };
}

/**
 * What the window and the tray show for the updater's state in main:
 *   { enabled, checking, updating, result: checkForUpdate's | null, outcome: { ok, message } | null }
 * → { line, detail, subjects, canUpdate, canCheck, busy }. `line` is the one
 * notice for the status bar and the tray ("Update available: 3 commits"),
 * null when there is nothing to act on. A failed check is "could not check",
 * never "up to date".
 */
export function updateSummary(state) {
  const { enabled = true, checking = false, updating = false, result = null, outcome = null } = state ?? {};
  const available = result?.status === 'available';
  const line = available ? `Update available: ${result.behind} commit${result.behind === 1 ? '' : 's'}` : null;
  const subjects = available ? result.subjects ?? [] : [];
  let detail;
  if (updating) detail = 'Updating browse-bridge…';
  else if (result?.status === 'unsupported') detail = `Updates are not checked: ${result.reason}.`;
  else if (!enabled) detail = `Checking for updates is off (General → ${CHECK_UPDATES_LABEL}).`;
  else if (checking) detail = 'Checking for updates…';
  else if (!result) detail = 'Not checked yet.';
  else if (result.status === 'failed') detail = `Could not check for updates: ${result.reason}.`;
  else if (result.status === 'current') detail = `Up to date with origin/${result.branch}.`;
  else detail = `${line} on origin/${result.branch}.${result.ahead ? ` This checkout also has ${result.ahead} commit${result.ahead === 1 ? '' : 's'} of its own, so it cannot fast-forward.` : ''}`;
  if (outcome && !updating) detail = `${outcome.message} ${detail}`;
  const busy = checking || updating;
  return {
    line: updating ? 'Updating browse-bridge…' : line,
    detail,
    subjects,
    canUpdate: available && !busy,
    canCheck: enabled && !busy && result?.status !== 'unsupported',
    busy,
  };
}
