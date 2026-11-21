import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySshError, SSH_ERROR_KINDS } from '../src/core/ssherror.js';
import { SSH_OPTIONS_LABEL } from '../src/core/labels.js';

/**
 * Real OpenSSH stderr, quoted exactly as ssh prints it (BatchMode=yes runs).
 * [name, stderr, expected kind, a phrase the guidance must carry]
 */
const TABLE = [
  ['publickey only', 'jon@dev004: Permission denied (publickey).\n', 'auth', 'No usable key. Load it with ssh-add'],
  ['publickey among methods', 'jon@dev004: Permission denied (publickey,password).\n', 'auth', `set IdentityFile in ${SSH_OPTIONS_LABEL}`],
  ['publickey with gssapi', 'bob@10.1.2.3: Permission denied (publickey,gssapi-keyex,gssapi-with-mic).\r\n', 'auth', 'No usable key'],
  ['unknown host key, strict', 'No ED25519 host key is known for dev004 and you have requested strict checking.\nHost key verification failed.\n', 'hostKeyUnknown', 'Run ssh dev004 once in a terminal and accept it'],
  ['unknown host key, bare', 'Host key verification failed.\n', 'hostKeyUnknown', 'not in known_hosts yet'],
  [
    'changed host key',
    [
      '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
      '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @',
      '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
      'IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!',
      'Host key for dev004 has changed and you have requested strict checking.',
      'Host key verification failed.',
      '',
    ].join('\n'),
    'hostKeyChanged',
    'ssh-keygen -R dev004',
  ],
  ['unresolvable name', 'ssh: Could not resolve hostname foo: Name or service not known\n', 'resolve', 'Cannot find host foo'],
  ['resolver down', 'ssh: Could not resolve hostname dev004.lab: Temporary failure in name resolution\n', 'resolve', 'Temporary failure in name resolution'],
  ['refused', 'ssh: connect to host 10.0.0.5 port 22: Connection refused\n', 'refused', '10.0.0.5 refused the connection on port 22'],
  ['timed out', 'ssh: connect to host x port 22: Connection timed out\n', 'timeout', 'No answer from x on port 22'],
  ['no route', 'ssh: connect to host 192.168.9.9 port 2222: No route to host\n', 'noRoute', 'No network route to 192.168.9.9'],
  ['network unreachable', 'ssh: connect to host 2001:db8::1 port 22: Network is unreachable\n', 'noRoute', 'No network route to 2001:db8::1'],
  ['warning line first', "Warning: Permanently added '[127.0.0.1]:39924' (ED25519) to the list of known hosts.\r\njon@127.0.0.1: Permission denied (publickey).\r\n", 'auth', 'No usable key'],
];

for (const [name, stderr, kind, phrase] of TABLE) {
  test(`ssh error: ${name} → ${kind}`, () => {
    const c = classifySshError(stderr, { host: 'dev004' });
    assert.equal(c.kind, kind);
    assert.ok(c.text.includes(phrase), `"${c.text}" should include "${phrase}"`);
    assert.ok(c.line && stderr.includes(c.line), 'line is the raw line ssh printed');
  });
}

test('ssh error: every kind the table expects is a declared kind, and every rule has a row', () => {
  const kinds = new Set(TABLE.map((r) => r[2]));
  for (const k of kinds) assert.ok(SSH_ERROR_KINDS.includes(k), k);
  assert.deepEqual([...kinds, 'unknown'].sort(), [...SSH_ERROR_KINDS].sort());
});

test('ssh error: anything else is the raw last line, unchanged', () => {
  const stderr = 'kex_exchange_identification: read: Connection reset by peer\nConnection reset by 10.0.0.5 port 22\n';
  assert.deepEqual(classifySshError(stderr), { kind: 'unknown', text: 'Connection reset by 10.0.0.5 port 22', line: 'Connection reset by 10.0.0.5 port 22' });
  assert.deepEqual(classifySshError(''), { kind: 'unknown', text: '', line: '' });
  assert.deepEqual(classifySshError(undefined), { kind: 'unknown', text: '', line: '' });
});

test('ssh error: phrases that look alike but are not ssh\'s own failure stay unknown', () => {
  // A non-executable remote browse, a stale ControlMaster socket, a bare phrase with no "ssh: connect to host".
  for (const stderr of [
    'bash: line 1: /home/u/.local/bin/browse: Permission denied',
    'Control socket connect(/tmp/cm/cm-abc): Connection refused',
    'Connection refused',
    'jon@dev004: Permission denied (password).',
  ]) {
    assert.equal(classifySshError(stderr).kind, 'unknown', stderr);
    assert.equal(classifySshError(stderr).text, stderr);
  }
});
