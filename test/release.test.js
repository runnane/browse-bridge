import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { checkReleaseTag } from '../scripts/check-release-tag.js';
import { checkSmoke } from '../scripts/check-smoke.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const release = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const gates = readFileSync(new URL('../.github/workflows/gates.yml', import.meta.url), 'utf8');

test('tag guard: v + version passes', () => {
  assert.equal(checkReleaseTag('v1.2.3', '1.2.3').ok, true);
  assert.equal(checkReleaseTag('v0.1.0-rc.1', '0.1.0-rc.1').ok, true);
});

test('tag guard: a different version, a missing v, a double v and an empty tag all fail', () => {
  assert.equal(checkReleaseTag('v1.2.4', '1.2.3').ok, false);
  assert.equal(checkReleaseTag('1.2.3', '1.2.3').ok, false);
  assert.equal(checkReleaseTag('vv1.2.3', '1.2.3').ok, false);
  assert.equal(checkReleaseTag('v1.2.3 ', '1.2.3').ok, false);
  assert.equal(checkReleaseTag('', '1.2.3').ok, false);
  assert.equal(checkReleaseTag(undefined, '1.2.3').ok, false);
  assert.equal(checkReleaseTag('v1.2.3', '').ok, false);
});

test('tag guard CLI: exits 0 for this package.json version and 1 for another', () => {
  const run = (tag) => {
    try {
      execFileSync(process.execPath, ['scripts/check-release-tag.js', tag], { stdio: 'pipe' });
      return 0;
    } catch (e) {
      return e.status;
    }
  };
  assert.equal(run(`v${pkg.version}`), 0);
  assert.equal(run(`v${pkg.version}.1`), 1);
});

test('smoke check: clean output showing the version passes', () => {
  assert.equal(checkSmoke({ errors: [], dialogs: { about: 'browse-bridge 1.2.3' } }, '1.2.3').ok, true);
});

test('smoke check: errors, a wrong or missing about, and a non-object all fail', () => {
  assert.equal(checkSmoke({ errors: ['boom'], dialogs: { about: '1.2.3' } }, '1.2.3').ok, false);
  assert.equal(checkSmoke({ dialogs: { about: '1.2.3' } }, '1.2.3').ok, false);
  assert.equal(checkSmoke({ errors: [], dialogs: { about: '1.2.2' } }, '1.2.3').ok, false);
  assert.equal(checkSmoke({ errors: [], dialogs: {} }, '1.2.3').ok, false);
  assert.equal(checkSmoke(null, '1.2.3').ok, false);
});

test('release workflow: reuses the gates workflow, which is callable', () => {
  assert.match(gates, /^\s*workflow_call:/m);
  assert.match(release, /uses: \.\/\.github\/workflows\/gates\.yml/);
});

test('release workflow: publishing is gated to a v* tag push, and only the publish job can write', () => {
  assert.match(release, /if: github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/tags\/v'\)/);
  assert.equal((release.match(/contents: write/g) ?? []).length, 1);
  assert.match(release, /^permissions:\n  contents: read/m);
});
