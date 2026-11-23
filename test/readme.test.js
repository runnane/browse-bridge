import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PINNED_BROWSE_VERSION } from '../src/core/config.js';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const V = String.raw`(\d+\.\d+\.\d+)`;

/**
 * Every place the README states the pinned browse version (BBR-53). The version
 * is typed in prose, so a pin bump that forgets the README must fail here
 * rather than leave the README naming the old pin. Each pattern must still
 * match: rewording one of these sentences means updating this list, not
 * silently dropping the check.
 */
const PIN_MENTIONS = [
  ['What it does: Set Up Host', new RegExp(String.raw`installs browse \*\*pinned\*\* \(${V}\)`, 'g')],
  ['Traffic: unreadable frames', new RegExp(String.raw`a browse\s+version other than ${V}`, 'g')],
  ['Config table: browseVersion default', new RegExp(String.raw`\| \`browseVersion\` \| ${V} \|`, 'g')],
  ['Compatibility: the pin today', new RegExp(String.raw`The pin today is browse \*\*${V}\*\*`, 'g')],
  ['Compatibility: the extension notice', new RegExp(String.raw`browse ${V} is out of date`, 'g')],
];

test('readme: every statement of the pinned browse version equals PINNED_BROWSE_VERSION', () => {
  for (const [where, re] of PIN_MENTIONS) {
    const found = [...readme.matchAll(re)].map((m) => m[1]);
    assert.ok(found.length > 0, `README no longer has the "${where}" sentence; update test/readme.test.js`);
    for (const v of found) assert.equal(v, PINNED_BROWSE_VERSION, `README "${where}" names ${v}, the pin is ${PINNED_BROWSE_VERSION}`);
  }
});

test('readme: the development commands use the gate the manifest names', () => {
  const manifest = JSON.parse(readFileSync(new URL('../.agents/repo.json', import.meta.url), 'utf8'));
  assert.ok(readme.includes(manifest.gates.all), `README Development should show "${manifest.gates.all}"`);
  assert.ok(!/\bpnpm gates\b/.test(readme), 'README still says "pnpm gates"; this repo has no pnpm');
});

test('readme: the AppImage install checks the download against SHA256SUMS before running it (BBR-74)', () => {
  const lines = readme.split('\n');
  const check = lines.findIndex((l) => /^sha256sum -c SHA256SUMS\b/.test(l));
  assert.ok(check >= 0, 'README Install has no "sha256sum -c SHA256SUMS" step');
  const run = lines.findIndex((l) => l.startsWith('./browse-bridge-x86_64.AppImage'));
  assert.ok(run > check, 'README must run the AppImage after the checksum step');
});

test('readme: the pin-check script the README tells you to run exists', () => {
  assert.ok(readme.includes('node scripts/check-browse-pin.js'));
  assert.doesNotThrow(() => readFileSync(new URL('../scripts/check-browse-pin.js', import.meta.url)));
});
