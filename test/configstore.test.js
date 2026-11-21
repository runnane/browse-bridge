import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore, UNREADABLE_REFUSAL, brokenBackupPath } from '../src/core/config.js';

// Two hosts and one hand-edit typo: the trailing comma after the last host (the BBR-36 repro).
const BROKEN = '{\n  "hosts": [\n    { "id": "dev004", "host": "jon@dev004.invalid" },\n    { "id": "dev005", "host": "jon@dev005.invalid" },\n  ]\n}\n';
const FIXED = BROKEN.replace('},\n  ]', '}\n  ]');
const AT = new Date('2026-11-21T16:38:17.752Z');

function setup(contents) {
  const dir = mkdtempSync(join(tmpdir(), 'bb-store-'));
  const path = join(dir, 'config.json');
  if (contents !== undefined) writeFileSync(path, contents);
  return { dir, path, store: new ConfigStore(path, { now: () => AT }) };
}

const backups = (dir) => readdirSync(dir).filter((f) => f.startsWith('config.json.broken-')).sort();

test('config store: an unreadable file is copied aside on open, and a save never overwrites it (BBR-36)', () => {
  const { dir, path, store } = setup(BROKEN);
  const config = store.open();

  // The app runs with one blank host, and says why.
  assert.deepEqual(config.hosts.map((h) => h.id), ['host-1']);
  assert.equal(store.failure.path, path);
  assert.ok(store.failure.message.length > 0);
  assert.equal(store.failure.backup, brokenBackupPath(path, AT));
  assert.equal(store.failure.backupError, null);
  assert.equal(readFileSync(store.failure.backup, 'utf8'), BROKEN, 'the backup holds the original bytes');
  assert.match(store.failure.backup, /config\.json\.broken-2026-11-21T16-38-17-752Z$/);

  // The user fills in the blank host and clicks Apply: a valid config, refused by the guard, not by validation.
  let refused = null;
  try {
    store.save({ hosts: [{ id: 'host-1', host: 'u@new.invalid' }] });
  } catch (err) {
    refused = err;
  }
  // The file itself first: the backup alone would survive a save that went through.
  assert.equal(readFileSync(path, 'utf8'), BROKEN, 'config.json still holds every host after the attempted save');
  assert.ok(refused?.message.includes(UNREADABLE_REFUSAL), `refused by the guard, not by validation: ${refused?.message}`);
  assert.deepEqual(backups(dir), ['config.json.broken-2026-11-21T16-38-17-752Z']);
});

test('config store: a value normalizeAppConfig refuses is a failure too, and an existing backup is never overwritten', () => {
  const bad = JSON.stringify({ hosts: [{ id: 'dev004', host: '-oProxyCommand=x' }] });
  const { dir, path, store } = setup(bad);
  writeFileSync(brokenBackupPath(path, AT), 'an older backup');
  store.open();
  assert.match(store.failure.message, /not a valid ssh destination/);
  assert.equal(store.failure.backup, `${brokenBackupPath(path, AT)}-2`);
  assert.equal(readFileSync(brokenBackupPath(path, AT), 'utf8'), 'an older backup');
  assert.equal(readFileSync(store.failure.backup, 'utf8'), bad);
  assert.equal(backups(dir).length, 2);
});

test('config store: a missing file is the first start, not a failure, and saves go through', () => {
  const { dir, path, store } = setup();
  assert.deepEqual(store.open().hosts.map((h) => h.id), ['host-1']);
  assert.equal(store.failure, null);
  store.save({ hosts: [{ id: 'host-1', host: 'u@new.invalid' }] });
  assert.match(readFileSync(path, 'utf8'), /u@new\.invalid/);
  assert.deepEqual(backups(dir), []);
});

test('config store: Reload after the user fixed the file reads their hosts and clears the failure; the same bad bytes keep one backup', () => {
  const { dir, path, store } = setup(BROKEN);
  store.open();
  store.open(); // Reload with the file still broken
  assert.ok(store.failure);
  assert.equal(backups(dir).length, 1, 'the same bytes are not copied twice');

  writeFileSync(path, FIXED);
  const config = store.open();
  assert.equal(store.failure, null);
  assert.deepEqual(config.hosts.map((h) => h.id), ['dev004', 'dev005']);
  store.save(config);
  assert.match(readFileSync(path, 'utf8'), /dev005/);
});

test('config store: Start over writes a blank config only after the current bytes are copied aside', () => {
  const { dir, path, store } = setup(BROKEN);
  store.open();
  // The user edits the broken file again before choosing Start over: those bytes are kept as well.
  const edited = `${BROKEN}// another try\n`;
  writeFileSync(path, edited);
  const clean = store.startOver();
  assert.equal(store.failure, null);
  assert.deepEqual(clean.hosts.map((h) => h.id), ['host-1']);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { hosts: [{ id: 'host-1' }] });
  const kept = backups(dir).map((f) => readFileSync(join(dir, f), 'utf8'));
  assert.deepEqual(kept, [BROKEN, edited]);
  // Saves go through again.
  store.save({ hosts: [{ id: 'host-1', host: 'u@new.invalid' }] });
  assert.match(readFileSync(path, 'utf8'), /u@new\.invalid/);
});

test('config store: Start over is refused when the file cannot be copied aside, and nothing is written', { skip: process.getuid?.() === 0 && 'root reads any file' }, () => {
  const { path, store } = setup(BROKEN);
  chmodSync(path, 0o000);
  try {
    store.open();
    assert.ok(store.failure.backupError, 'an unreadable file cannot be copied');
    assert.equal(store.failure.backup, null);
    assert.throws(() => store.startOver(), /Cannot start over/);
    assert.throws(() => store.save({}), (err) => err.message.includes(UNREADABLE_REFUSAL));
  } finally {
    chmodSync(path, 0o600);
  }
  assert.equal(readFileSync(path, 'utf8'), BROKEN);
  assert.ok(store.failure);
});

test('config store: Start over with nothing wrong is refused', () => {
  const { store } = setup(FIXED);
  store.open();
  assert.throws(() => store.startOver(), /nothing to start over from/);
});
