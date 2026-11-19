import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './exec.js';

const GIT_TIMEOUT_MS = 1500;

/** Run git in `dir` and resolve with its trimmed stdout, or null on any failure, non-zero exit or hang. */
async function git(exec, dir, args, timeoutMs) {
  let timer;
  // The race is the backstop: a child that ignores SIGTERM must not hold start-up either.
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs + 250); });
  try {
    const res = await Promise.race([exec('git', ['-C', dir, ...args], { timeoutMs }), deadline]);
    if (!res || res.timedOut || res.code !== 0) return null;
    return String(res.stdout).trim();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The running version as one string, read once at start-up so it names the
 * code that is running, not a later `git pull`: "0.1.0+3 1b86d65" — the
 * package.json version, "+N" commits since the commit that last changed that
 * version line (so a version bump reads "+0"), then the short commit, with
 * " (modified)" after a dirty tree. Without git, outside a checkout, or when
 * git errors or hangs, just "0.1.0"; if only the count fails, "+N" is dropped.
 * Never throws; each git call is bounded by `timeoutMs`. `exec` is injectable
 * for tests.
 */
export async function readVersion(dir, { exec = run, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  let pkg = '';
  try {
    pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version ?? '';
  } catch {
    // an unreadable package.json leaves the version blank rather than failing start-up
  }
  const base = pkg || '?';
  const [sha, status, build] = await Promise.all([
    git(exec, dir, ['rev-parse', '--short', 'HEAD'], timeoutMs),
    git(exec, dir, ['status', '--porcelain'], timeoutMs),
    buildNumber(exec, dir, timeoutMs),
  ]);
  if (!sha) return base;
  const n = build === null ? '' : `+${build}`;
  return `${base}${n} ${sha}${status ? ' (modified)' : ''}`;
}

/**
 * Commits since the one that last changed package.json's "version" line, or
 * every commit on HEAD when no commit ever set it; null when git fails.
 */
async function buildNumber(exec, dir, timeoutMs) {
  const bump = await git(exec, dir, ['log', '-1', '--format=%H', '-G', '"version"[[:space:]]*:', '--', 'package.json'], timeoutMs);
  if (bump === null) return null;
  const count = await git(exec, dir, ['rev-list', '--count', bump ? `${bump}..HEAD` : 'HEAD'], timeoutMs);
  return count !== null && /^\d+$/.test(count) ? Number(count) : null;
}
