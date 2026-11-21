import { spawn } from 'node:child_process';

/** Quote one argument for a POSIX shell. */
export function shQuote(arg) {
  const s = String(arg);
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Quote a path for the remote shell, keeping a leading `$HOME/` expandable.
 * A non-interactive ssh does not read ~/.profile, so ~/.local/bin is not on
 * PATH there — the browse binary is always called by absolute path.
 */
export function shQuotePath(path) {
  const s = String(path);
  if (s.startsWith('$HOME/')) return `"$HOME"/${shQuote(s.slice('$HOME/'.length))}`;
  if (s.startsWith('~/')) return `"$HOME"/${shQuote(s.slice(2))}`;
  return shQuote(s);
}

/** Options every app-made ssh call carries. BatchMode: Electron has no tty, so a prompt would hang for ever. */
export function baseSshOptions(cfg) {
  return [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    ...cfg.sshOptions.flatMap((o) => ['-o', o]),
  ];
}

/**
 * Run a child process and collect its output. Resolves (never rejects) with
 * { code, signal, stdout, stderr, timedOut } so callers handle every outcome.
 */
export function run(cmd, args, { input = null, timeoutMs = 30_000, env = process.env, cwd = undefined } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: -1, signal: null, stdout: '', stderr: String(err), timedOut: false });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { stderr += String(err); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, signal, stdout, stderr, timedOut });
    });
    child.stdin.on('error', () => {});
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

/**
 * Where browse commands run. "ssh" runs them on cfg.host; "local" runs them
 * on this machine (used by the tests, against the real binary).
 */
export function createTransport(cfg, { localEnv = process.env } = {}) {
  if (cfg.transport === 'local') {
    const browsePath = cfg.remoteBrowse.replace(/^\$HOME\//, `${localEnv.HOME}/`).replace(/^~\//, `${localEnv.HOME}/`);
    return {
      kind: 'local',
      browse: (args, opts = {}) => run(browsePath, args, { env: localEnv, ...opts }),
      script: (body, args = [], opts = {}) => run('bash', ['-s', '--', ...args], { input: body, env: localEnv, ...opts }),
      closeMaster: async () => null,
    };
  }
  if (!cfg.host) throw new Error('No host configured');
  return {
    kind: 'ssh',
    browse: (args, { controlDir = null, ...opts } = {}) => run('ssh', sshBrowseArgs(cfg, args, controlDir), opts),
    script: (body, args = [], { controlDir = null, ...opts } = {}) => run('ssh', sshScriptArgs(cfg, args, controlDir), { input: body, ...opts }),
    /** Ask the multiplexing master (if any) to exit, so nothing outlives a disconnect. */
    closeMaster: (controlDir) => (controlDir
      // Same options as the calls that made it: %C hashes host, port and user, so a missing Port= misses the socket.
      ? run('ssh', [...baseSshOptions(cfg), '-o', `ControlPath=${controlDir}/cm-%C`, '-O', 'exit', '--', cfg.host], { timeoutMs: 5000 })
      : Promise.resolve(null)),
  };
}

function controlOpts(controlDir) {
  // ClearAllForwardings: a LocalForward in the user's ~/.ssh/config for this host must not be
  // attempted by every status poll (it would also collide with the tunnel's own port).
  return [
    '-o', 'ClearAllForwardings=yes',
    ...(controlDir ? ['-o', 'ControlMaster=auto', '-o', `ControlPath=${controlDir}/cm-%C`, '-o', 'ControlPersist=120'] : []),
  ];
}

/** argv for `ssh <host> <command>`, where `command` is one remote shell string the caller has already quoted. */
export function sshCommandArgs(cfg, command, controlDir = null) {
  return [...baseSshOptions(cfg), ...controlOpts(controlDir), '--', cfg.host, command];
}

/** argv for `ssh <host> <browse> <args…>`: the remote command is one string, every part quoted. */
export function sshBrowseArgs(cfg, args, controlDir = null) {
  return sshCommandArgs(cfg, [shQuotePath(cfg.remoteBrowse), ...args.map(shQuote)].join(' '), controlDir);
}

/** argv for `ssh <host> bash -s -- <args…>` with the script on stdin. */
export function sshScriptArgs(cfg, args, controlDir = null) {
  return sshCommandArgs(cfg, ['bash', '-s', '--', ...args.map(shQuote)].join(' '), controlDir);
}
