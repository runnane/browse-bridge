// Tag guard for the release workflow (BBR-72): a release tag must be `v` plus
// package.json's version. A mismatched tag would publish a binary whose
// latest-linux.yml version disagrees with its name, and electron-updater would
// offer it as an update for ever, or never.
//
//   node scripts/check-release-tag.js v1.2.3      # or GITHUB_REF_NAME
//
// Exit 0 when the tag matches, 1 when it does not.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** @returns {{ok: boolean, message: string}} */
export function checkReleaseTag(tag, version) {
  const expected = `v${version}`;
  if (typeof tag !== 'string' || tag === '') return { ok: false, message: 'no tag given' };
  if (typeof version !== 'string' || version === '') return { ok: false, message: 'package.json has no version' };
  if (tag !== expected) return { ok: false, message: `tag ${tag} does not match package.json version ${version} (expected ${expected})` };
  return { ok: true, message: `tag ${tag} matches package.json version ${version}` };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const r = checkReleaseTag(tag, pkg.version);
  console.log(r.message);
  process.exit(r.ok ? 0 : 1);
}
