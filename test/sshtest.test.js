/** Test Connection (BBR-46) against a fake exec: every outcome, and the argv it hands ssh. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testConnection, TEST_TIMEOUT_MS } from '../src/core/sshtest.js';
import { SETUP_LABEL } from '../src/core/labels.js';

const ok = (stdout = '') => ({ code: 0, signal: null, stdout, stderr: '', timedOut: false });
const fail = (code, stderr) => ({ code, signal: null, stdout: '', stderr, timedOut: false });

/** An exec that answers each call in turn and records it. */
function fakeExec(...answers) {
  const calls = [];
  const exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return answers.shift() ?? fail(1, 'unexpected call');
  };
  return { exec, calls };
}

const FIELDS = { host: 'jon@dev004', sshOptions: ['Port=2222'] };

test('test connection: logs in with `true`, then asks the remote browse its version, both BatchMode and bounded', async () => {
  const { exec, calls } = fakeExec(ok(), ok('0.1.4\n'));
  const r = await testConnection(FIELDS, { browseVersion: '0.1.4', exec });
  assert.deepEqual([r.ok, r.level], [true, 'ok']);
  assert.deepEqual(r.steps.map((s) => [s.name, s.level]), [['ssh', 'ok'], ['browse', 'ok']]);
  assert.match(r.steps[1].text, /browse 0\.1\.4 at \$HOME\/\.local\/bin\/browse, the pinned version/);
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.equal(c.cmd, 'ssh');
    assert.equal(c.opts.timeoutMs, TEST_TIMEOUT_MS);
    assert.deepEqual(c.args.slice(0, 2), ['-o', 'BatchMode=yes']);
    assert.ok(c.args.includes('Port=2222'), 'the form\'s SSH options are passed');
    assert.ok(c.args.includes('ClearAllForwardings=yes'), 'an alias\'s LocalForward is not attempted');
    assert.ok(!c.args.some((a) => /^ControlMaster=/.test(a)), 'no multiplexing master is left behind');
    assert.equal(c.args.at(-2), 'jon@dev004');
    assert.equal(c.args.at(-3), '--');
  }
  assert.equal(calls[0].args.at(-1), 'true');
  assert.equal(calls[1].args.at(-1), '"$HOME"/.local/bin/browse version');
});

test('test connection: an ssh failure stops at the login with the classified guidance', async () => {
  const { exec, calls } = fakeExec(fail(255, 'jon@dev004: Permission denied (publickey).\n'));
  const r = await testConnection(FIELDS, { exec });
  assert.deepEqual([r.ok, r.level, calls.length], [false, 'bad', 1]);
  assert.equal(r.steps[0].kind, 'auth');
  assert.match(r.steps[0].text, /^No usable key\./);
});

test('test connection: an unknown host key names the command to run', async () => {
  const { exec } = fakeExec(fail(255, 'Host key verification failed.\n'));
  const r = await testConnection({ host: 'dev004' }, { exec });
  assert.match(r.steps[0].text, /Run ssh dev004 once in a terminal/);
});

test('test connection: a login that never answers says so, by the timeout it was given', async () => {
  const { exec } = fakeExec({ code: -1, signal: 'SIGTERM', stdout: '', stderr: '', timedOut: true });
  const r = await testConnection(FIELDS, { exec, timeoutMs: 5000 });
  assert.deepEqual([r.ok, r.steps[0].kind, r.steps[0].text], [false, 'timeout', 'No answer within 5 s.']);
});

test('test connection: browse missing at the default path is a warning that names Set Up Host', async () => {
  const { exec } = fakeExec(ok(), fail(127, 'bash: line 1: /home/user/.local/bin/browse: No such file or directory\n'));
  const r = await testConnection(FIELDS, { browseVersion: '0.1.4', exec });
  assert.deepEqual([r.ok, r.level, r.steps[1].kind], [true, 'warn', 'missing']);
  assert.ok(r.steps[1].text.includes(`then ${SETUP_LABEL} installs 0.1.4`), r.steps[1].text);
});

test('test connection: browse missing at a custom path is a failure, since setup installs nothing there', async () => {
  const { exec } = fakeExec(ok(), fail(127, 'sh: 1: /opt/browse: not found\n'));
  const r = await testConnection({ ...FIELDS, remoteBrowse: '/opt/browse' }, { exec });
  assert.deepEqual([r.ok, r.level], [false, 'bad']);
  assert.ok(r.steps[1].text.startsWith(`No browse at /opt/browse. ${SETUP_LABEL} installs only at $HOME/.local/bin/browse`), r.steps[1].text);
});

test('test connection: another browse version is a warning naming the pin', async () => {
  const { exec } = fakeExec(ok(), ok('0.1.3\n'));
  const r = await testConnection(FIELDS, { browseVersion: '0.1.4', exec });
  assert.deepEqual([r.ok, r.level, r.steps[1].kind], [true, 'warn', 'other-version']);
  assert.ok(r.steps[1].text.includes(`not the pinned 0.1.4: ${SETUP_LABEL} installs 0.1.4`), r.steps[1].text);
});

test('test connection: ssh failing on the second call is classified, not read as "browse missing"', async () => {
  const { exec } = fakeExec(ok(), fail(255, 'ssh: connect to host dev004 port 22: Connection refused\n'));
  const r = await testConnection(FIELDS, { exec });
  assert.deepEqual([r.ok, r.steps[1].kind], [false, 'refused']);
});

test('test connection: a destination ssh would read as an option is refused before any ssh runs', async () => {
  const { exec, calls } = fakeExec();
  await assert.rejects(testConnection({ host: '-oProxyCommand=touch /tmp/x' }, { exec }), /not a valid ssh destination/);
  await assert.rejects(testConnection({ host: 'dev004', sshOptions: ['NoEquals'] }, { exec }), /sshOptions must be/);
  await assert.rejects(testConnection({ host: '' }, { exec }), /Enter the SSH host/);
  assert.equal(calls.length, 0);
});
