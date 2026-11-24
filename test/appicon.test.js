// BBR-80: the AppImage's own icon is a committed PNG under build/ (outside the asar).
// It must keep showing exactly what the generator produces, so it cannot drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { iconPng } from '../src/icons.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const ICON_SIZE = 512;

test('build.linux.icon points at the committed icon', () => {
  assert.equal(pkg.build.linux.icon, 'build/icon.png');
});

// Split a PNG into its chunks. The IDAT data is zlib-deflated, and different zlib builds
// (e.g. the one bundled with another Node major) emit different but equally valid bytes
// for the same pixels (BBR-87), so the test compares the header and the inflated
// scanlines, never the compressed bytes.
function pngParts(buf) {
  assert.ok(buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'not a PNG');
  let ihdr = null;
  const idat = [];
  for (let off = 8; off < buf.length; ) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') ihdr = data;
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  assert.ok(ihdr, 'PNG has no IHDR');
  assert.ok(idat.length > 0, 'PNG has no IDAT');
  return { ihdr, scanlines: inflateSync(Buffer.concat(idat)) };
}

test('build/icon.png shows exactly iconPng("ready", 512)', () => {
  const committed = pngParts(readFileSync(new URL('../build/icon.png', import.meta.url)));
  const generated = pngParts(iconPng('ready', ICON_SIZE));
  assert.ok(committed.ihdr.equals(generated.ihdr), 'IHDR differs: regenerate build/icon.png from iconPng("ready", 512)');
  assert.equal(committed.scanlines.length, generated.scanlines.length, 'pixel data size differs: regenerate build/icon.png');
  assert.ok(committed.scanlines.equals(generated.scanlines), 'pixels differ: regenerate build/icon.png from iconPng("ready", 512)');
  // 512x512 per the IHDR chunk
  assert.equal(committed.ihdr.readUInt32BE(0), ICON_SIZE);
  assert.equal(committed.ihdr.readUInt32BE(4), ICON_SIZE);
});

test('package.json author is the public identity, never an email', () => {
  assert.equal(pkg.author.name, 'runnane');
  assert.equal(pkg.author.url, 'https://github.com/runnane');
  assert.ok(!JSON.stringify(pkg.author).includes('@'));
});
