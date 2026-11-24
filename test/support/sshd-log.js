import { existsSync, readFileSync } from 'node:fs';

/**
 * The failure message for a test sshd that wrote no pid file in time (BBR-89).
 * The log lives in a mkdtemp dir that does not survive a CI runner, so its
 * text has to travel in the assertion message to be of any use.
 */
export function sshdStartMessage(logFile) {
  const log = existsSync(logFile) ? readFileSync(logFile, 'utf8').trim() : '';
  return `sshd started; ${existsSync(logFile) ? `sshd.log: ${log || '(empty)'}` : 'no sshd.log'}`;
}
