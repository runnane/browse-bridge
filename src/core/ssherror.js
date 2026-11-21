/**
 * Turn what OpenSSH prints on a failed connection into what to do next
 * (BBR-46). Every app-made ssh call is BatchMode=yes, so the commonest
 * first-run failures are terse non-interactive lines that say nothing about
 * the fix. Pure and import-light (labels.js only), so the window's ES-module
 * view-model can use it as well as core.
 *
 * Each rule is anchored on the shape OpenSSH itself prints, not on a bare
 * phrase: stderr from a status poll also carries the remote command's own
 * output, and a remote "Permission denied" (a browse path that is not
 * executable) is not a missing key.
 */
import { SSH_OPTIONS_LABEL } from './labels.js';

/** The kinds a failure is classified into; `unknown` carries the raw last line. */
export const SSH_ERROR_KINDS = Object.freeze(['auth', 'hostKeyUnknown', 'hostKeyChanged', 'resolve', 'refused', 'timeout', 'noRoute', 'unknown']);

const RULES = [
  {
    // "jon@dev004: Permission denied (publickey)." / "(publickey,password)." / "(publickey,gssapi-keyex,gssapi-with-mic)."
    kind: 'auth',
    re: /Permission denied \(([a-z0-9-]+,)*publickey(,[a-z0-9-]+)*\)\.?$/,
    text: () => `No usable key. Load it with ssh-add, or set IdentityFile in ${SSH_OPTIONS_LABEL}.`,
  },
  {
    // A key that changed is printed as a banner, then "Host key verification failed." — checked before the unknown-key rule.
    kind: 'hostKeyChanged',
    re: /REMOTE HOST IDENTIFICATION HAS CHANGED!/,
    whole: true,
    text: (_m, host) => `This host's key has changed since it was accepted. If the host was reinstalled, remove the old key with ssh-keygen -R ${host}; otherwise do not connect.`,
  },
  {
    kind: 'hostKeyUnknown',
    re: /^Host key verification failed\.$/,
    text: (_m, host) => `This host's key is not in known_hosts yet. Run ssh ${host} once in a terminal and accept it.`,
  },
  {
    // "ssh: Could not resolve hostname foo: Name or service not known" / "…: Temporary failure in name resolution"
    kind: 'resolve',
    re: /^ssh: Could not resolve hostname (.+?): (.+)$/,
    text: (m) => `Cannot find host ${m[1]}: the name does not resolve (${m[2]}). Check the spelling, or the HostName in ~/.ssh/config.`,
  },
  {
    kind: 'refused',
    re: /^ssh: connect to host (\S+) port (\d+): Connection refused$/,
    text: (m) => `${m[1]} refused the connection on port ${m[2]}: no ssh server is listening there. Check the host name and port.`,
  },
  {
    kind: 'timeout',
    re: /^ssh: connect to host (\S+) port (\d+): (Connection|Operation) timed out$/,
    text: (m) => `No answer from ${m[1]} on port ${m[2]}: the host may be down, or a firewall or VPN is in the way.`,
  },
  {
    kind: 'noRoute',
    re: /^ssh: connect to host (\S+) port (\d+): (No route to host|Network is unreachable)$/,
    text: (m) => `No network route to ${m[1]}: check the network or VPN connection.`,
  },
];

/**
 * Classify ssh's stderr. `host` is the destination as configured, for the
 * guidance that names a command to run. Returns { kind, text, line }:
 * `text` is what to show, `line` the raw line it came from. Anything not
 * recognised is kind "unknown" with the raw last line as its text, as
 * before BBR-46.
 */
export function classifySshError(stderr, { host = '<host>' } = {}) {
  const raw = String(stderr ?? '');
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const rule of RULES) {
    if (rule.whole) {
      const m = rule.re.exec(raw);
      if (m) return { kind: rule.kind, text: rule.text(m, host), line: lines.at(-1) ?? '' };
      continue;
    }
    for (const line of lines) {
      const m = rule.re.exec(line);
      if (m) return { kind: rule.kind, text: rule.text(m, host), line };
    }
  }
  const last = lines.at(-1) ?? '';
  return { kind: 'unknown', text: last, line: last };
}
