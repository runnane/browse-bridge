import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { changedWatchedFiles, parseProtocolConstants, verdict } from '../src/core/pincheck.js';

const fixture = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const v014 = parseProtocolConstants(fixture('protocol-v0.1.4.rs'));
const v4 = parseProtocolConstants(fixture('protocol-hypothetical-v4.rs'));

test('parses current, min and scheme separately from real v0.1.4 text', () => {
  assert.deepEqual(v014, { current: 3, min: 3, scheme: 'opencode-browser-pairing-v3' });
});

test('parser tells CURRENT from MIN when they differ', () => {
  assert.deepEqual(v4, { current: 5, min: 4, scheme: 'opencode-browser-pairing-v4' });
});

test('parser throws when a constant is missing', () => {
  assert.throws(() => parseProtocolConstants('pub const PAIRING_SCHEME: &str = "x";'), /EXTENSION_PROTOCOL_VERSION/);
  assert.throws(() => parseProtocolConstants(fixture('protocol-v0.1.4.rs').replace('PAIRING_SCHEME', 'SCHEME')), /PAIRING_SCHEME/);
});

test('same constants on both sides are compatible', () => {
  assert.deepEqual(verdict(v014, v014), { compatible: true, reasons: [] });
});

test('an extension protocol outside the pin range is incompatible', () => {
  const r = verdict(v014, { ...v014, current: 4 });
  assert.equal(r.compatible, false);
  assert.match(r.reasons[0], /newer than the pin's 3/);
  const old = verdict({ current: 5, min: 4, scheme: 's' }, { current: 3, min: 3, scheme: 's' });
  assert.equal(old.compatible, false);
  assert.match(old.reasons[0], /older than the pin's minimum 4/);
});

test('an extension inside a wider pin range is compatible', () => {
  assert.equal(verdict(v4, { current: 4, min: 4, scheme: v4.scheme }).compatible, true);
});

test('a changed pairing scheme alone is incompatible', () => {
  const r = verdict(v014, { ...v014, scheme: 'opencode-browser-pairing-v4' });
  assert.equal(r.compatible, false);
  assert.equal(r.reasons.length, 1);
  assert.match(r.reasons[0], /pairing scheme changed/);
});

test('changedWatchedFiles keeps only the watched files', () => {
  const compare = { files: [{ filename: 'CHANGELOG.md' }, { filename: 'src/agent-relay/protocol.ts' }, { filename: 'rust/crates/browse-relay/src/pairing.rs' }] };
  assert.deepEqual(changedWatchedFiles(compare), ['rust/crates/browse-relay/src/pairing.rs', 'src/agent-relay/protocol.ts']);
  assert.deepEqual(changedWatchedFiles({}), []);
});
