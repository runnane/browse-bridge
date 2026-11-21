/**
 * Test Connection (BBR-46) against a private unprivileged sshd on
 * 127.0.0.1:39924 with throwaway host key, client keys, known_hosts and HOME.
 * Needs only /usr/sbin/sshd and ssh-keygen, not BROWSE_BIN: the remote browse
 * is a stub script that prints a version. Its own file and port, because
 * node --test runs files in parallel (see .agents/gates.md).
 *
 * Covers the success path and the two "unknown key" failures through real
 * OpenSSH output: a host key known_hosts does not hold, and a client key the
 * server does not accept.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testConnection } from '../src/core/sshtest.js';

const SSHD = '/usr/sbin/sshd';
const SSH_PORT = 39924;
const skip = !existsSync(SSHD) && 'no sshd';

async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

test('test connection over real ssh: success, an unknown host key, an unaccepted client key', { skip }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bb-sshtest-'));
  chmodSync(dir, 0o700);
  const pidFile = join(dir, 'sshd.pid');
  // Registered before anything can fail: sshd is stopped by the pid its own pid file names, never by name.
  t.after(() => {
    if (!existsSync(pidFile)) return;
    const pid = Number(readFileSync(pidFile, 'utf8'));
    if (pid > 0) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    }
  });

  const home = join(dir, 'home');
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  const stub = join(home, '.local', 'bin', 'browse');
  writeFileSync(stub, '#!/bin/sh\n[ "$1" = version ] && echo 0.1.4\n');
  chmodSync(stub, 0o755);
  for (const k of ['hostkey', 'clientkey', 'strangerkey']) execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, k)]);
  copyFileSync(join(dir, 'clientkey.pub'), join(dir, 'authorized_keys'));
  const hostPub = readFileSync(join(dir, 'hostkey.pub'), 'utf8').split(' ').slice(0, 2).join(' ');
  writeFileSync(join(dir, 'known_hosts'), `[127.0.0.1]:${SSH_PORT} ${hostPub}\n`);
  writeFileSync(join(dir, 'known_hosts_empty'), '');
  writeFileSync(join(dir, 'sshd_config'), [
    `Port ${SSH_PORT}`, 'ListenAddress 127.0.0.1', `HostKey ${join(dir, 'hostkey')}`, `PidFile ${pidFile}`,
    `AuthorizedKeysFile ${join(dir, 'authorized_keys')}`, 'PasswordAuthentication no', 'KbdInteractiveAuthentication no',
    'UsePAM no', 'StrictModes no', `SetEnv HOME=${home}`, '',
  ].join('\n'));
  execFileSync(SSHD, ['-f', join(dir, 'sshd_config'), '-E', join(dir, 'sshd.log')]);
  assert.ok(await waitFor(() => existsSync(pidFile), 5000), 'sshd started');

  // The user's own ~/.ssh/config still applies to these calls, so everything that matters is passed explicitly.
  const opts = (key, knownHosts) => [
    `Port=${SSH_PORT}`, `IdentityFile=${join(dir, key)}`, 'IdentitiesOnly=yes', `UserKnownHostsFile=${join(dir, knownHosts)}`,
    'GlobalKnownHostsFile=/dev/null', 'StrictHostKeyChecking=yes', 'IdentityAgent=none',
  ];

  const good = await testConnection({ host: '127.0.0.1', sshOptions: opts('clientkey', 'known_hosts') }, { browseVersion: '0.1.4' });
  assert.deepEqual(good.steps.map((s) => [s.name, s.level]), [['ssh', 'ok'], ['browse', 'ok']], JSON.stringify(good));
  assert.equal(good.steps[1].text, 'browse 0.1.4 at $HOME/.local/bin/browse, the pinned version.');

  const unknownHost = await testConnection({ host: '127.0.0.1', sshOptions: opts('clientkey', 'known_hosts_empty') });
  assert.equal(unknownHost.ok, false);
  assert.equal(unknownHost.steps[0].kind, 'hostKeyUnknown', JSON.stringify(unknownHost));
  assert.match(unknownHost.steps[0].text, /Run ssh 127\.0\.0\.1 once in a terminal and accept it/);

  const stranger = await testConnection({ host: '127.0.0.1', sshOptions: opts('strangerkey', 'known_hosts') });
  assert.equal(stranger.ok, false);
  assert.equal(stranger.steps[0].kind, 'auth', JSON.stringify(stranger));
  assert.match(stranger.steps[0].text, /^No usable key\./);

  const missing = await testConnection({ host: '127.0.0.1', sshOptions: opts('clientkey', 'known_hosts'), remoteBrowse: '$HOME/nope/browse' });
  assert.deepEqual([missing.ok, missing.steps[1].kind], [false, 'missing'], JSON.stringify(missing));
});
