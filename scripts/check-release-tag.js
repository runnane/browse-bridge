// Tag guard for the release workflow (BBR-72): a release tag must be `v` plus
// package.json's version. A mismatched tag would publish a binary whose
// latest-linux.yml version disagrees with its name, and electron-updater would
// offer it as an update for ever, or never.
//
//   node scripts/check-release-tag.js v1.2.3      # or GITHUB_REF_NAME
//
// Exit 0 when the tag matches, 1 when it does not.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** @returns {{ok: boolean, message: string}} */
export function checkReleaseTag(tag, version) {
  const expected = `v${version}`;
  if (typeof tag !== 'string' || tag === '') return { ok: false, message: 'no tag given' };
  if (typeof version !== 'string' || version === '') return { ok: false, message: 'package.json has no version' };
  if (tag !== expected) return { ok: false, message: `tag ${tag} does not match package.json version ${version} (expected ${expected})` };
  return { ok: true, message: `tag ${tag} matches package.json version ${version}` };
}

/**
 * BBR-82: a release tag's commit must be on main. Only a tag push is checked; a
 * PR dry run has no tag, so the ancestry answer is never asked for.
 * `isAncestor` is injected: a function returning whether the tagged commit is an
 * ancestor of origin/main.
 * @returns {{ok: boolean, skipped: boolean, message: string}}
 */
export function checkTagOnMain({ isTagPush, isAncestor }) {
  if (!isTagPush) return { ok: true, skipped: true, message: 'not a tag push, main ancestry not checked' };
  if (isAncestor()) return { ok: true, skipped: false, message: 'tagged commit is on main' };
  return { ok: false, skipped: false, message: 'tagged commit is not an ancestor of origin/main: release tags must point at a commit on main' };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const r = checkReleaseTag(tag, pkg.version);
  console.log(r.message);
  if (!r.ok) process.exit(1);
  const m = checkTagOnMain({
    isTagPush: process.env.GITHUB_REF_TYPE === 'tag',
    isAncestor: () => {
      try {
        execFileSync('git', ['merge-base', '--is-ancestor', process.env.GITHUB_SHA ?? 'HEAD', 'origin/main'], { stdio: 'pipe' });
        return true;
      } catch {
        return false;
      }
    },
  });
  console.log(m.message);
  process.exit(m.ok ? 0 : 1);
}
