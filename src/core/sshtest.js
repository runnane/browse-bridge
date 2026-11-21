/**
 * The host form's Test Connection (BBR-46): try the ssh destination and the
 * remote browse before anything is saved. Two calls through the same argv
 * builders every other ssh call uses (exec.js: BatchMode=yes,
 * ClearAllForwardings, no multiplexing master left behind), each bounded by
 * `timeoutMs`:
 *
 *   1. `ssh <opts> -- <host> true`: can we log in at all?
 *   2. `<remote browse> version`: is browse there, and which version?
 *
 * `exec` is injectable (exec.js `run` by default), so the outcomes are tested
 * with a fake.
 */
import { DEFAULTS, normalizeConfig } from './config.js';
import { run, sshBrowseArgs, sshCommandArgs } from './exec.js';
import { SETUP_LABEL } from './labels.js';
import { classifySshError } from './ssherror.js';

/** A Test Connection call never waits longer than this per step (ssh's own ConnectTimeout is 10 s). */
export const TEST_TIMEOUT_MS = 15_000;

/** What a failed ssh call says: the classified guidance, else the exit code. */
function sshFailure(res, host, timeoutMs) {
  if (res.timedOut) return { level: 'bad', kind: 'timeout', text: `No answer within ${Math.round(timeoutMs / 1000)} s.` };
  const c = classifySshError(res.stderr, { host });
  return { level: 'bad', kind: c.kind, text: c.text || `ssh exited ${res.code}.` };
}

/**
 * Which browse version Test Connection expects (BBR-62). The page never names
 * one: for an existing host (`hostId` found in the stored config) it is that
 * host's effective version (its own from BBR-41, else the pin); for Add Host
 * (no id, or one not stored) it is the app pin.
 */
export function expectedBrowseVersion(app, hostId, fallbackPin = DEFAULTS.browseVersion) {
  const pin = app?.browseVersion ?? fallbackPin;
  const host = typeof hostId === 'string' ? app?.hosts?.find((h) => h.id === hostId) : null;
  return { browseVersion: host?.browseVersion || pin, pinnedBrowseVersion: pin };
}

/**
 * Run the test for the form's fields ({ host, sshOptions, remoteBrowse }).
 * `browseVersion` is the version the host is expected to run (the app's pin
 * unless the host has its own, see expectedBrowseVersion) and
 * `pinnedBrowseVersion` the pin, which only changes the wording. Resolves (never rejects on an ssh
 * failure) to { ok, level, steps: [{ name, level, kind?, text }] }, where
 * `level` is the worst step's: "ok", "warn" (it connects; browse needs
 * setting up) or "bad". A field normalizeConfig refuses throws before any ssh
 * runs, so a destination such as "-oProxyCommand=…" never reaches ssh.
 */
export async function testConnection(fields, { browseVersion = DEFAULTS.browseVersion, pinnedBrowseVersion = browseVersion, exec = run, timeoutMs = TEST_TIMEOUT_MS } = {}) {
  const cfg = normalizeConfig({
    transport: 'ssh',
    host: fields.host,
    sshOptions: fields.sshOptions ?? [],
    remoteBrowse: fields.remoteBrowse || DEFAULTS.remoteBrowse,
    browseVersion,
  });
  if (!cfg.host) throw new Error('Enter the SSH host first.');
  const steps = [];
  const done = () => {
    const level = steps.some((s) => s.level === 'bad') ? 'bad' : steps.some((s) => s.level === 'warn') ? 'warn' : 'ok';
    return { ok: level !== 'bad', level, steps };
  };

  const login = await exec('ssh', sshCommandArgs(cfg, 'true'), { timeoutMs });
  if (login.code !== 0 || login.timedOut) {
    steps.push({ name: 'ssh', ...sshFailure(login, cfg.host, timeoutMs) });
    return done();
  }
  steps.push({ name: 'ssh', level: 'ok', text: `Logged in to ${cfg.host}.` });

  const path = cfg.remoteBrowse;
  const managed = path === DEFAULTS.remoteBrowse;
  const pin = cfg.browseVersion;
  const ver = await exec('ssh', sshBrowseArgs(cfg, ['version']), { timeoutMs });
  if (ver.timedOut || ver.code === 255) {
    // 255 is ssh's own failure (the second login failed); browse exits with its own codes.
    steps.push({ name: 'browse', ...sshFailure(ver, cfg.host, timeoutMs) });
  } else if (ver.code === 126 || ver.code === 127) {
    // The remote shell's "not found" / "not executable".
    steps.push(managed
      ? { name: 'browse', level: 'warn', kind: 'missing', text: `browse is not installed at ${path} yet: save the host, then ${SETUP_LABEL} installs ${pin}.` }
      : { name: 'browse', level: 'bad', kind: 'missing', text: `No browse at ${path}. ${SETUP_LABEL} installs only at ${DEFAULTS.remoteBrowse}: install browse ${pin} at this path yourself, or clear the path.` });
  } else if (ver.code !== 0) {
    const last = String(ver.stderr).trim().split('\n').filter(Boolean).pop();
    steps.push({ name: 'browse', level: 'bad', kind: 'error', text: `browse version failed (exit ${ver.code})${last ? `: ${last}` : ''}.` });
  } else {
    const version = String(ver.stdout).trim().split('\n').filter(Boolean).pop() ?? '';
    const own = pin !== pinnedBrowseVersion; // the host runs its own version (BBR-41)
    const what = own ? 'the version this host is set to run' : 'the pinned version';
    if (version === pin) {
      steps.push({ name: 'browse', level: 'ok', kind: 'pinned', text: `browse ${version} at ${path}, ${what}.` });
    } else {
      const fix = managed ? `${SETUP_LABEL} installs ${pin}` : `${SETUP_LABEL} installs only at ${DEFAULTS.remoteBrowse}, so install ${pin} here yourself`;
      steps.push({ name: 'browse', level: 'warn', kind: 'other-version', text: `browse ${version || '(no version printed)'} at ${path}, not ${own ? 'the version this host is set to run,' : 'the pinned'} ${pin}: ${fix}.` });
    }
  }
  return done();
}
