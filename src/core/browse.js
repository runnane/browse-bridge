/**
 * Everything the app knows about the browse CLI (measured against 0.1.3 and 0.1.4):
 * `status --json`, `pair --wait-seconds N`, `update --mode off`,
 * `set hostname 127.0.0.1`, `restart`, `version`.
 */

const MARK = '@@BB@@';

/**
 * Idempotent remote setup, run with `bash -s -- <browsePath> <version>`.
 * Prints marker-delimited sections so the result can be checked at the
 * receiver rather than trusted from an exit code.
 */
export const SETUP_SCRIPT = String.raw`set -uo pipefail
BROWSE="$1"; PIN="$2"; MARK='${MARK}'
case "$BROWSE" in '$HOME/'*) BROWSE="$HOME/${'$'}{BROWSE#\$HOME/}";; '~/'*) BROWSE="$HOME/${'$'}{BROWSE:2}";; esac
step() { echo "$MARK step $1 $2"; }
have=""
[ -x "$BROWSE" ] && have="$("$BROWSE" version 2>/dev/null || true)"
if [ "$have" != "$PIN" ]; then
  if ! command -v npm >/dev/null 2>&1; then step install fail; echo "npm not found on $(hostname)"; exit 3; fi
  case "$BROWSE" in
    "$HOME/.local/bin/browse") npm i -g --prefix "$HOME/.local" "@opencode/browse@$PIN" >&2 && step install ok || { step install fail; exit 4; } ;;
    *) step install fail; echo "browse $have at $BROWSE is not $PIN and is not the ~/.local install this app manages"; exit 5 ;;
  esac
else
  step install skip
fi
"$BROWSE" update --mode off >&2 && step autoupdate ok || step autoupdate fail
"$BROWSE" set hostname 127.0.0.1 >&2 && step hostname ok || step hostname fail
"$BROWSE" restart >&2 && step restart ok || step restart fail
echo "$MARK version $("$BROWSE" version 2>/dev/null)"
echo "$MARK listen-begin"
(ss -ltnH 2>/dev/null || netstat -ltn 2>/dev/null) | awk '{for(i=1;i<=NF;i++) if ($i ~ /:[0-9]+$/) {print $i; break}}'
echo "$MARK listen-end"
echo "$MARK status-begin"
"$BROWSE" status --json
echo "$MARK status-end"
`;

/** Parse the setup script's marker output. */
export function parseSetupOutput(stdout) {
  const steps = {};
  let version = null;
  const listen = [];
  const statusLines = [];
  let section = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith(`${MARK} `)) {
      const [, kind, a, b] = line.split(' ');
      if (kind === 'step') steps[a] = b;
      else if (kind === 'version') version = a || null;
      else if (kind === 'listen-begin') section = 'listen';
      else if (kind === 'status-begin') section = 'status';
      else if (kind === 'listen-end' || kind === 'status-end') section = null;
      continue;
    }
    if (section === 'listen' && line.trim()) listen.push(line.trim());
    if (section === 'status') statusLines.push(line);
  }
  let status = null;
  try {
    status = statusLines.length ? JSON.parse(statusLines.join('\n')) : null;
  } catch {
    status = null;
  }
  return { steps, version, listen, status };
}

/** Port number from a relay endpoint like "http://127.0.0.1:19988". */
export function endpointPort(endpoint) {
  try {
    const port = Number(new URL(endpoint).port);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

/** Host part of a listen address: "127.0.0.1:19988" → "127.0.0.1", "[::]:19988" → "::". */
function listenHost(addr) {
  const i = addr.lastIndexOf(':');
  return addr.slice(0, i).replace(/^\[|\]$/g, '');
}

/**
 * Check a setup result at the receiver. Returns the problems found; an empty
 * list is the only "ok". Anything that could not be measured is a problem.
 */
export function verifySetup(parsed, { version, relayPort = null }) {
  const problems = [];
  for (const step of ['autoupdate', 'hostname', 'restart']) {
    if (parsed.steps[step] !== 'ok') problems.push(`step ${step}: ${parsed.steps[step] ?? 'did not run'}`);
  }
  if (parsed.version !== version) problems.push(`browse version is ${parsed.version ?? 'unknown'}, expected ${version}`);
  const s = parsed.status;
  if (!s) {
    problems.push('browse status --json returned nothing parseable');
    return problems;
  }
  const effective = s.autoUpdate?.effective;
  if (effective !== 'off') problems.push(`auto-update is ${effective ?? 'unmeasured'}, expected off`);
  const port = relayPort ?? endpointPort(s.relay?.endpoint);
  if (port == null) {
    problems.push('relay endpoint unknown');
  } else {
    const binds = parsed.listen.filter((a) => a.endsWith(`:${port}`)).map(listenHost);
    if (binds.length === 0) problems.push(`nothing listening on relay port ${port}`);
    const exposed = binds.filter((h) => !['127.0.0.1', '::1', 'localhost'].includes(h));
    if (exposed.length) problems.push(`relay port ${port} is reachable beyond loopback (${exposed.join(', ')})`);
  }
  return problems;
}

/** Extract the pairing code and browse's own instructions from `browse pair` output. */
export function parsePairOutput(stdout) {
  const m = /Pairing code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(stdout);
  if (!m) return null;
  const instructions = stdout
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('Pairing code:'))
    .find((l) => l.includes(m[1])) ?? null;
  return { code: m[1], instructions };
}

/**
 * Collapse `browse status --json` into what the UI shows. Every field that is
 * absent stays null; the UI renders null as "unknown", never as healthy.
 */
export function summarizeStatus(s) {
  if (!s || typeof s !== 'object') return null;
  const ext = s.extension ?? {};
  return {
    relayRunning: s.relay ? (s.relay.running === false ? false : Boolean(s.relay.pid ?? s.relay.instanceId ?? s.relay.running)) : null,
    relayPort: endpointPort(s.relay?.endpoint),
    relayVersion: s.relay?.version ?? s.setup?.version ?? null,
    extensionConnected: typeof (ext.connected ?? s.connected) === 'boolean' ? (ext.connected ?? s.connected) : null,
    pairingState: ext.pairingState ?? s.pairingState ?? null,
    browsers: Array.isArray(ext.browsers) ? ext.browsers.length : null,
    activeTargets: typeof ext.activeTargets === 'number' ? ext.activeTargets : null,
    tabs: Array.isArray(s.tabs) ? s.tabs.length : null,
    autoUpdate: s.autoUpdate?.effective ?? null,
    agents: Array.isArray(s.setup?.agents) ? s.setup.agents.map((a) => (typeof a === 'string' ? a : a?.name ?? '?')) : null,
    nextStep: s.nextStep ?? ext.nextStep ?? null,
  };
}
