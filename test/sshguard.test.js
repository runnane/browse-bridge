import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, assertSshAllowed, guardedSpawn, isLoopbackDestination, createTransport } from '../src/core/exec.js';
import { TunnelSupervisor } from '../src/core/tunnel.js';

// BBR-60: with BB_FORBID_SSH=1 no test can reach a real ssh. The guard fails the process on
// purpose, so each test here undoes that and silences the message it prints.
function withGuard(value, fn) {
  const prevEnv = process.env.BB_FORBID_SSH;
  const prevExit = process.exitCode;
  const prevErr = console.error;
  if (value === undefined) delete process.env.BB_FORBID_SSH; else process.env.BB_FORBID_SSH = value;
  console.error = () => {};
  const restore = () => {
    console.error = prevErr;
    process.exitCode = prevExit;
    if (prevEnv === undefined) delete process.env.BB_FORBID_SSH; else process.env.BB_FORBID_SSH = prevEnv;
  };
  let out;
  try { out = fn(); } catch (err) { restore(); throw err; }
  if (out && typeof out.then === 'function') return out.finally(restore);
  restore();
  return out;
}

const SSH_LOOPBACK = ['-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=2', '-o', 'Port=1', '--', '127.0.0.1', 'true'];
const SSH_REMOTE = ['-o', 'BatchMode=yes', '--', 'build.example.invalid', 'browse status'];

test('isLoopbackDestination accepts this machine only', () => {
  for (const ok of ['127.0.0.1', '127.0.0.3', 'localhost', '::1', '[::1]', 'me@127.0.0.1', 'LOCALHOST']) {
    assert.equal(isLoopbackDestination(ok), true, ok);
  }
  for (const bad of ['dev004', 'build.example.invalid', '10.0.0.1', '128.0.0.1', '127.0.0.1.example.com', '', undefined]) {
    assert.equal(isLoopbackDestination(bad), false, String(bad));
  }
});

test('guard on: ssh, scp and sftp to a non-loopback destination are refused with a clear message', () => {
  for (const cmd of ['ssh', '/usr/bin/ssh', 'scp', 'sftp']) {
    withGuard('1', () => {
      assert.throws(() => assertSshAllowed(cmd, SSH_REMOTE), /BB_FORBID_SSH: refusing to run (ssh|scp|sftp) to "build\.example\.invalid" in a test/);
    });
  }
});

test('guard on: a refusal also fails the process, so a caller that swallows the throw is still red', () => {
  withGuard('1', () => {
    process.exitCode = undefined;
    assert.throws(() => assertSshAllowed('ssh', SSH_REMOTE));
    assert.equal(process.exitCode, 1);
  });
});

test('guard on: ssh with no recognisable destination is refused, not waved through', () => {
  withGuard('1', () => {
    assert.throws(() => assertSshAllowed('ssh', ['-V']), /unknown destination/);
  });
});

test('guard on: run("ssh") to a remote host is refused before anything is spawned', () => {
  withGuard('1', () => {
    assert.throws(() => run('ssh', SSH_REMOTE), /BB_FORBID_SSH/);
  });
});

test('guard on: the ssh transport (browse, script, closeMaster) is refused for a remote host', () => {
  withGuard('1', () => {
    const t = createTransport({ transport: 'ssh', host: 'build.example.invalid', sshOptions: [], remoteBrowse: '$HOME/browse' });
    assert.throws(() => t.browse(['status']), /BB_FORBID_SSH/);
    assert.throws(() => t.script('true'), /BB_FORBID_SSH/);
    assert.throws(() => t.closeMaster('/tmp/x'), /BB_FORBID_SSH/);
  });
});

test('guard on: the tunnel default spawner is guarded too', () => {
  withGuard('1', () => {
    assert.throws(() => guardedSpawn('ssh', SSH_REMOTE, {}), /BB_FORBID_SSH/);
    const sup = new TunnelSupervisor({ host: 'build.example.invalid', innerPort: 39999, sshOptions: [] });
    assert.equal(sup.spawnImpl, guardedSpawn);
  });
});

test('guard on: a non-ssh command is untouched', async () => {
  await withGuard('1', async () => {
    const res = await run(process.execPath, ['-e', 'process.stdout.write("hi")']);
    assert.equal(res.code, 0);
    assert.equal(res.stdout, 'hi');
  });
});

test('guard on: the allowed path (loopback destination) still reaches ssh', async () => {
  await withGuard('1', async () => {
    const res = await run('ssh', SSH_LOOPBACK, { timeoutMs: 10_000 });
    // Nothing listens on port 1, so ssh itself fails: the point is that the guard let it run.
    assert.doesNotMatch(res.stderr, /BB_FORBID_SSH/);
    assert.notEqual(res.code, 0);
  });
});

test('guard off (variable unset): production behaviour is unchanged, a remote destination is not refused', async () => {
  await withGuard(undefined, async () => {
    assert.doesNotThrow(() => assertSshAllowed('ssh', SSH_REMOTE));
    // Spawn a harmless ssh (-V connects nowhere) to show run() really goes through.
    const res = await run('ssh', ['-V'], { timeoutMs: 10_000 });
    assert.doesNotMatch(res.stderr, /BB_FORBID_SSH/);
  });
});

test('guard only arms on exactly "1"', () => {
  for (const v of ['', '0', 'true']) {
    withGuard(v, () => {
      assert.doesNotThrow(() => assertSshAllowed('ssh', SSH_REMOTE), v);
    });
  }
});
