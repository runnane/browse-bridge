/**
 * Everything the app knows about the browse CLI (measured against 0.1.3, 0.1.4 and 0.1.5):
 * `status --json`, `pair --wait-seconds N`, `update --mode off`,
 * `set hostname 127.0.0.1`, `restart`, `version`.
 */

const MARK = '@@BB@@';

/** The only origin a platform tarball may be downloaded from (BBR-54). */
export const TARBALL_PREFIX = 'https://registry.npmjs.org/@opencode/';

/**
 * POSIX sh functions behind the native install (BBR-54). `SETUP_SCRIPT`
 * interpolates this exact text, and the tests source it, so both run the same
 * code. POSIX sh, run under dash and bash with `set -u` (and parsed by busybox
 * ash, whose applets defeat the tests' fake PATH). No
 * pipeline's status is tested, so nothing relies on bash's `pipefail`.
 * (This is a String.raw template: a dollar-brace in here is JS
 * interpolation, so shell variables are written without braces.)
 *
 *   bb_target [alpine-release-file]  linux-x64|linux-arm64[-musl]; 1 = not Linux, 2 = Linux on an arch with no native package
 *   bb_need_tools                    0, or 1 and the missing tools on stdout
 *   bb_integrity_hex <sha512-b64>    the 128 lowercase hex digits, or 1
 *   bb_tarball_ok <url>              0 only for a URL under TARBALL_PREFIX
 *   bb_sha512 <file>                 lowercase hex SHA-512 of the file
 *   bb_json_str <key> <file>         the one "key":"value" string in a JSON file, or 1 if there is not exactly one
 */
export const INSTALL_FUNCS = String.raw`bb_target() {
  bb_alp=/etc/alpine-release; [ $# -gt 0 ] && bb_alp=$1
  bb_os=$(uname -s 2>/dev/null); bb_arch=$(uname -m 2>/dev/null)
  [ "$bb_os" = Linux ] || return 1
  case "$bb_arch" in
    x86_64|amd64) bb_arch=x64 ;;
    aarch64|arm64) bb_arch=arm64 ;;
    *) return 2 ;;
  esac
  bb_ldd=$(ldd --version 2>&1 || true)
  bb_libc=""
  [ -f "$bb_alp" ] && bb_libc=-musl
  case "$bb_ldd" in *musl*|*MUSL*|*Musl*) bb_libc=-musl ;; esac
  echo "linux-$bb_arch$bb_libc"
}
bb_need_tools() {
  bb_missing=""
  for bb_t in curl tar gzip od mktemp; do command -v "$bb_t" >/dev/null 2>&1 || bb_missing="$bb_missing $bb_t"; done
  command -v sha512sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 || command -v openssl >/dev/null 2>&1 || bb_missing="$bb_missing sha512sum/shasum/openssl"
  command -v base64 >/dev/null 2>&1 || command -v openssl >/dev/null 2>&1 || bb_missing="$bb_missing base64/openssl"
  [ -z "$bb_missing" ] && return 0
  echo "$bb_missing"
  return 1
}
bb_integrity_hex() {
  case "$1" in sha512-*) ;; *) return 1 ;; esac
  bb_b64=$(printf '%s' "$1" | cut -c8-)
  case "$bb_b64" in ''|*[!A-Za-z0-9+/=]*) return 1 ;; esac
  [ "$(printf '%s' "$bb_b64" | wc -c | tr -d ' ')" = 88 ] || return 1
  if command -v base64 >/dev/null 2>&1; then
    bb_hex=$(printf '%s' "$bb_b64" | base64 -d 2>/dev/null | od -An -v -tx1 | tr -d ' \n')
  else
    bb_hex=$(printf '%s\n' "$bb_b64" | openssl base64 -d -A 2>/dev/null | od -An -v -tx1 | tr -d ' \n')
  fi
  case "$bb_hex" in ''|*[!0-9a-f]*) return 1 ;; esac
  [ "$(printf '%s' "$bb_hex" | wc -c | tr -d ' ')" = 128 ] || return 1
  echo "$bb_hex"
}
bb_tarball_ok() {
  case "$1" in *..*|*[!A-Za-z0-9._:/@-]*) return 1 ;; '${TARBALL_PREFIX}'*) return 0 ;; esac
  return 1
}
bb_sha512() {
  if command -v sha512sum >/dev/null 2>&1; then bb_s=$(sha512sum "$1")
  elif command -v shasum >/dev/null 2>&1; then bb_s=$(shasum -a 512 "$1")
  else bb_s=$(openssl dgst -sha512 -r "$1"); fi
  printf '%s\n' "$bb_s" | cut -d' ' -f1 | tr 'A-F' 'a-f'
}
bb_json_str() {
  bb_m=$(tr -d '\n' < "$2" | grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" || true)
  [ -n "$bb_m" ] || return 1
  [ "$(printf '%s\n' "$bb_m" | wc -l | tr -d ' ')" = 1 ] || return 1
  printf '%s\n' "$bb_m" | sed 's/^"[^"]*"[[:space:]]*:[[:space:]]*"//; s/"$//'
}
`;

/**
 * Idempotent remote setup, run with `sh -s -- <browsePath> <version>`.
 * Prints marker-delimited sections so the result can be checked at the
 * receiver rather than trusted from an exit code.
 *
 * POSIX sh (BBR-57): a stock Alpine or busybox host has /bin/sh but no bash.
 * So no `pipefail`, no `${var:n}` substring, no `[[ ]]`, and text that did not
 * come from this script (paths, versions, registry answers) is printed with
 * `printf '%s\n'`, because dash's and ash's `echo` interpret backslashes.
 * dash runs an EXIT trap on `exit` but not when a signal kills the script, so
 * HUP/INT/TERM (a timed-out setup, a dropped ssh) exit through it explicitly.
 *
 * Install (BBR-54): on Linux x64/arm64 (glibc or musl) the platform package's
 * tarball is fetched from the npm registry with curl, its SHA-512 checked
 * against the registry's `dist.integrity`, and `package/bin/browse` renamed
 * into ~/.local/bin. No npm and no Node are needed. npm is used only on a
 * non-Linux remote; a native failure never falls through to it.
 *
 * Exit codes: 0 ran to the end (verify the markers), 3 a tool the install
 * needs is missing, 4 the install failed (registry, download, checksum,
 * unpack, npm), 5 browsePath is not the ~/.local install this app manages,
 * 6 no supported install route for this platform. In the install branch,
 * every command that could read stdin is fed /dev/null: stdin is this script.
 * Each curl attempt is capped (--max-time) and retried at most twice, so the
 * downloads take at most about 4 minutes (3 x 20 s + 3 x 60 s), inside the
 * controller's 300 s setup timeout.
 */
export const SETUP_SCRIPT = String.raw`set -u
BROWSE="$1"; PIN="$2"; MARK='${MARK}'
case "$BROWSE" in '$HOME/'*) BROWSE="$HOME/${'$'}{BROWSE#\$HOME/}";; '~/'*) BROWSE="$HOME/${'$'}{BROWSE#\~/}";; esac
step() { echo "$MARK step $1 $2"; }
fail() { step install fail; printf '%s\n' "$1"; exit "$2"; }
${INSTALL_FUNCS}
have=""
[ -x "$BROWSE" ] && have="$("$BROWSE" version 2>/dev/null </dev/null || true)"
if [ "$have" != "$PIN" ]; then
  case "$BROWSE" in
    "$HOME/.local/bin/browse") ;;
    *) fail "browse $have at $BROWSE is not $PIN and is not the ~/.local install this app manages" 5 ;;
  esac
  target=$(bb_target); tcode=$?
  if [ "$tcode" = 0 ]; then
    missing=$(bb_need_tools) || fail "cannot install browse $PIN: missing$missing" 3
    tmp=$(mktemp -d) || fail "mktemp -d failed" 4
    trap 'rm -rf "$tmp"' EXIT
    trap 'exit 1' HUP INT TERM
    pkg="@opencode/browse-$target"
    code=$(curl -sS --connect-timeout 15 --max-time 20 --retry 2 -o "$tmp/meta.json" -w '%{http_code}' "https://registry.npmjs.org/@opencode%2fbrowse-$target/$PIN" </dev/null); crc=$?
    case "$code" in
      ''|000) fail "could not reach registry.npmjs.org from this host (curl exit $crc); check its DNS and outbound HTTPS" 4 ;;
    esac
    [ "$code" = 200 ] || fail "registry answered HTTP $code for $pkg@$PIN" 4
    integrity=$(bb_json_str integrity "$tmp/meta.json") || fail "registry metadata for $pkg@$PIN has no single dist.integrity" 4
    tarball=$(bb_json_str tarball "$tmp/meta.json") || fail "registry metadata for $pkg@$PIN has no single dist.tarball" 4
    want=$(bb_integrity_hex "$integrity") || fail "registry integrity for $pkg@$PIN is not a sha512: $integrity" 4
    bb_tarball_ok "$tarball" || fail "refusing tarball URL outside ${TARBALL_PREFIX}: $tarball" 4
    curl -fsSL --connect-timeout 15 --max-time 60 --retry 2 -o "$tmp/pkg.tgz" "$tarball" </dev/null >&2 || fail "download failed: $tarball" 4
    got=$(bb_sha512 "$tmp/pkg.tgz")
    [ "$got" = "$want" ] || fail "checksum mismatch for $tarball: expected sha512 $want, got $got" 4
    mkdir -p "$tmp/x" "$HOME/.local/bin" || fail "cannot create $HOME/.local/bin" 4
    tar -xzf "$tmp/pkg.tgz" -C "$tmp/x" </dev/null >&2 || fail "cannot unpack $tarball" 4
    [ -f "$tmp/x/package/bin/browse" ] || fail "$tarball has no package/bin/browse" 4
    mv -f "$tmp/x/package/bin/browse" "$HOME/.local/bin/browse.new" || fail "cannot write $HOME/.local/bin/browse.new" 4
    chmod 755 "$HOME/.local/bin/browse.new" || fail "cannot chmod $HOME/.local/bin/browse.new" 4
    mv -f "$HOME/.local/bin/browse.new" "$HOME/.local/bin/browse" || fail "cannot rename browse.new over $HOME/.local/bin/browse" 4
    step install ok
    echo "$MARK install-via native"
    echo "$MARK install-sha512 $got"
  elif [ "$tcode" = 1 ] && command -v npm >/dev/null 2>&1; then
    npm i -g --prefix "$HOME/.local" "@opencode/browse@$PIN" </dev/null >&2 || fail "npm install of @opencode/browse@$PIN failed" 4
    step install ok
    echo "$MARK install-via npm"
  else
    fail "unsupported platform $(uname -s 2>/dev/null)/$(uname -m 2>/dev/null); install browse yourself and set remoteBrowse" 6
  fi
else
  step install skip
fi
"$BROWSE" update --mode off >&2 && step autoupdate ok || step autoupdate fail
"$BROWSE" set hostname 127.0.0.1 >&2 && step hostname ok || step hostname fail
"$BROWSE" restart >&2 && step restart ok || step restart fail
printf '%s\n' "$MARK version $("$BROWSE" version 2>/dev/null)"
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
  let installVia = null;
  let installSha512 = null;
  const listen = [];
  const statusLines = [];
  let section = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith(`${MARK} `)) {
      const [, kind, a, b] = line.split(' ');
      if (kind === 'step') steps[a] = b;
      else if (kind === 'version') version = a || null;
      else if (kind === 'install-via') installVia = a || null;
      else if (kind === 'install-sha512') installSha512 = a || null;
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
  return { steps, version, installVia, installSha512, listen, status };
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
  const install = parsed.steps.install;
  if (install !== 'ok' && install !== 'skip') problems.push(`step install: ${install ?? 'did not run'}`);
  // BBR-54: a native install must report the SHA-512 it checked. npm (non-Linux
  // only) checks the same registry integrity itself and reports no hash.
  if (install === 'ok' && parsed.installVia !== 'npm' && !/^[0-9a-f]{128}$/.test(parsed.installSha512 ?? '')) {
    problems.push(`install ran but reported no verified sha512 (via ${parsed.installVia ?? 'unknown'})`);
  }
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
