// BBR-80: the AppImage's own icon is a committed PNG under build/ (outside the asar).
// It must stay byte-identical to what the generator produces, so it cannot drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { iconPng } from '../src/icons.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const ICON_SIZE = 512;

test('build.linux.icon points at the committed icon', () => {
  assert.equal(pkg.build.linux.icon, 'build/icon.png');
});

test('build/icon.png is exactly iconPng("ready", 512)', () => {
  const committed = readFileSync(new URL('../build/icon.png', import.meta.url));
  const generated = iconPng('ready', ICON_SIZE);
  assert.equal(committed.length, generated.length, 'size differs: regenerate build/icon.png');
  assert.ok(committed.equals(generated), 'bytes differ: regenerate build/icon.png from iconPng("ready", 512)');
  // 512x512 per the IHDR chunk
  assert.equal(committed.readUInt32BE(16), ICON_SIZE);
  assert.equal(committed.readUInt32BE(20), ICON_SIZE);
});

test('package.json author is the public identity, never an email', () => {
  assert.equal(pkg.author.name, 'runnane');
  assert.equal(pkg.author.url, 'https://github.com/runnane');
  assert.ok(!JSON.stringify(pkg.author).includes('@'));
});
