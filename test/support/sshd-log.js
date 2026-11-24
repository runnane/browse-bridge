import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

/**
 * The failure message for a test sshd that did not come up (BBR-89).
 * The log lives in a mkdtemp dir that does not survive a CI runner, so its
 * text has to travel in the assertion message to be of any use.
 */
export function sshdStartMessage(logFile, why) {
  const log = existsSync(logFile) ? readFileSync(logFile, 'utf8').trim() : '';
  const where = existsSync(logFile) ? `sshd.log: ${log || '(empty)'}` : 'no sshd.log';
  return `sshd started; ${why ? `${why}; ` : ''}${where}`;
}

/**
 * Start a private test sshd in the foreground (-D) and wait for its pid file
 * (BBR-93). Because it is our own child, the test holds its pid directly:
 * an sshd that exits at launch is seen as an exit (with its log in the
 * message), and one that never writes its pid file is still stopped by the
 * pid we spawned, never left holding the port. Never stopped by name.
 *
 * Returns { pid, stop }; register stop() in the test's own t.after.
 */
export async function startTestSshd({ sshd, config, log, pidFile, timeoutMs = 5000 }) {
  const child = spawn(sshd, ['-D', '-f', config, '-E', log], { stdio: 'ignore' });
  let exited = null;
  child.on('exit', (code, signal) => { exited = signal ? `signal ${signal}` : `code ${code}`; });
  child.on('error', (err) => { exited = err.message; });
  const stop = () => {
    if (exited === null) {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
    }
  };

  const end = Date.now() + timeoutMs;
  while (Date.now() < end && exited === null && !existsSync(pidFile)) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (exited !== null || !existsSync(pidFile)) {
    const why = exited !== null ? `sshd exited at launch (${exited})` : `no pid file within ${timeoutMs} ms`;
    stop();
    assert.fail(sshdStartMessage(log, why));
  }
  return { pid: child.pid, stop };
}
