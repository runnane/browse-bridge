/**
 * The ~/.ssh/config alias parser (BBR-46). Fixture text and a fake reader
 * only: no test reads the real ~/.ssh/config. The real reader is exercised
 * against a throwaway directory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_INCLUDE_DEPTH, fsReader, includePath, parseSshAliases, readSshAliases } from '../src/core/sshconfig.js';

const HOME = '/home/tester';

/** A reader over an in-memory file map; glob supports `*` in the last component, enough for the fixtures. */
function fakeReader(files) {
  const reads = [];
  return {
    reads,
    read(p) {
      reads.push(p);
      return Object.hasOwn(files, p) ? files[p] : null;
    },
    glob(pattern) {
      if (!pattern.includes('*')) return [pattern];
      const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);
      return Object.keys(files).filter((p) => re.test(p)).sort();
    },
  };
}

test('ssh config: Host aliases in order, wildcard and negated patterns skipped, keywords any case, Key=value', () => {
  const text = [
    '# comment',
    'Host dev004 dev005',
    '  HostName dev004.lab.example',
    'host *.lab !secret build?',
    '  User jon',
    'HOST=gpu',
    '  IdentityFile ~/.ssh/id_gpu',
    'Host = "quoted alias" dev004',
    '',
  ].join('\n');
  assert.deepEqual(parseSshAliases(text).map((a) => a.alias), ['dev004', 'dev005', 'gpu', 'quoted alias']);
});

test('ssh config: a LocalForward flags its own Host, any case and Key=value form', () => {
  const text = [
    'Host plain',
    '  HostName 10.0.0.1',
    'Host tunnel',
    '  localforward=19988 127.0.0.1:19988',
    'Host other',
    '  User x',
  ].join('\n');
  assert.deepEqual(parseSshAliases(text), [
    { alias: 'plain', localForward: false },
    { alias: 'tunnel', localForward: true },
    { alias: 'other', localForward: false },
  ]);
});

test('ssh config: a LocalForward under a wildcard flags every alias it matches, as ssh would apply it', () => {
  const text = [
    'Host a.lab b.other',
    'Host *.lab !b.lab',
    '  LocalForward 19988 127.0.0.1:19988',
    'Host b.lab',
  ].join('\n');
  assert.deepEqual(parseSshAliases(text), [
    { alias: 'a.lab', localForward: true },
    { alias: 'b.other', localForward: false },
    { alias: 'b.lab', localForward: false },
  ]);
});

test('ssh config: a Match line ends the Host block, so its LocalForward is no alias\'s', () => {
  const text = ['Host dev004', '  User jon', 'Match exec "true"', '  LocalForward 1 127.0.0.1:1'].join('\n');
  assert.deepEqual(parseSshAliases(text), [{ alias: 'dev004', localForward: false }]);
});

test('ssh config: Include is relative to ~/.ssh, ~/ is the home, globs and several files per line', () => {
  const files = {
    [`${HOME}/.ssh/config.d/10-work`]: 'Host work1\nHost work2\n  LocalForward 9 127.0.0.1:9\n',
    [`${HOME}/.ssh/config.d/20-home`]: 'Host nas\n',
    [`${HOME}/extra.conf`]: 'Host extra\n',
    '/etc/ssh/abs.conf': 'Host abs\n',
  };
  const reader = fakeReader(files);
  const text = 'Include config.d/* ~/extra.conf\nInclude /etc/ssh/abs.conf missing.conf\nHost last\n';
  assert.deepEqual(parseSshAliases(text, { reader, home: HOME }), [
    { alias: 'work1', localForward: false },
    { alias: 'work2', localForward: true },
    { alias: 'nas', localForward: false },
    { alias: 'extra', localForward: false },
    { alias: 'abs', localForward: false },
    { alias: 'last', localForward: false },
  ]);
  assert.ok(reader.reads.includes(`${HOME}/.ssh/missing.conf`), 'a missing include is read as relative to ~/.ssh and skipped');
  assert.equal(includePath('a', HOME), `${HOME}/.ssh/a`);
  assert.equal(includePath('~/b', HOME), `${HOME}/b`);
  assert.equal(includePath('/c', HOME), '/c');
});

test('ssh config: an Include inside a Host block continues that block, and the block resumes after it', () => {
  const files = { [`${HOME}/.ssh/fwd.conf`]: '  LocalForward 19988 127.0.0.1:19988\n' };
  const text = 'Host jump\n  Include fwd.conf\n  User x\nHost after\n';
  assert.deepEqual(parseSshAliases(text, { reader: fakeReader(files), home: HOME }), [
    { alias: 'jump', localForward: true },
    { alias: 'after', localForward: false },
  ]);
});

test('ssh config: an Include cycle stops at ssh\'s own depth limit', () => {
  const files = { [`${HOME}/.ssh/loop`]: 'Host looped\nInclude loop\n' };
  const reader = fakeReader(files);
  assert.deepEqual(parseSshAliases('Include loop', { reader, home: HOME }), [{ alias: 'looped', localForward: false }]);
  assert.equal(reader.reads.length, MAX_INCLUDE_DEPTH);
});

test('ssh config: the real reader on a throwaway home, and no config file is no aliases', () => {
  const home = mkdtempSync(join(tmpdir(), 'bb-sshcfg-'));
  assert.deepEqual(readSshAliases(home), []);
  mkdirSync(join(home, '.ssh', 'conf.d'), { recursive: true });
  writeFileSync(join(home, '.ssh', 'config'), 'Include conf.d/*.conf\nHost top\n');
  writeFileSync(join(home, '.ssh', 'conf.d', 'b.conf'), 'Host b\n');
  writeFileSync(join(home, '.ssh', 'conf.d', 'a.conf'), 'Host a\n  LocalForward 1 127.0.0.1:1\n');
  writeFileSync(join(home, '.ssh', 'conf.d', '.hidden.conf'), 'Host hidden\n');
  writeFileSync(join(home, '.ssh', 'conf.d', 'c.txt'), 'Host txt\n');
  assert.deepEqual(readSshAliases(home), [
    { alias: 'a', localForward: true },
    { alias: 'b', localForward: false },
    { alias: 'top', localForward: false },
  ]);
  assert.deepEqual(fsReader.glob(join(home, 'nope', '*.conf')), []);
  assert.equal(fsReader.read(join(home, 'nope')), null);
});
