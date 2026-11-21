/**
 * The "Copy diagnostics" bundle (BBR-47): one Markdown block a reporter pastes
 * into a bug report, built from plain inputs so it is tested without a display.
 *
 * Hiding host names is on by default. It does not blank named fields, it
 * replaces every known destination, name and id (and the host part of
 * `user@host`) anywhere in the finished text, because a name can leak through
 * `tunnel.detail`, `statusError`, a warning or a log line as easily as through
 * the config. Pairing codes are redacted over the whole bundle again with the
 * Logger's own pattern, as defence in depth.
 */
import { redact } from './log.js';

const LOG_LINES = 100;

/** A heading placeholder the replacer cannot match; turned into host-N at the very end. */
const NUM = (n) => `@@${n}@@`;

/** Plain text on one line: newlines and backticks would break the Markdown block. */
const oneLine = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

/** Every string that names this host: destination, user@host's host part, name, id. */
function hostTokens(h) {
  const dest = h.config?.host ?? h.host;
  const out = [dest, h.host, h.config?.name, h.name, h.config?.id, h.id];
  for (const d of [dest, h.host]) {
    const at = typeof d === 'string' ? d.lastIndexOf('@') : -1;
    if (at >= 0) out.push(d.slice(at + 1));
  }
  return out.filter((t) => typeof t === 'string' && t.trim() && t !== '(local)').map((t) => t.trim());
}

/**
 * A function that replaces every known host string by host-N in any text.
 * Longest string first, and only where the match is not inside a longer
 * word, so an id such as "dev" does not eat the middle of "device".
 */
function hostReplacer(hosts, homeDir) {
  const map = new Map();
  hosts.forEach((h, i) => {
    for (const t of hostTokens(h)) if (!map.has(t.toLowerCase())) map.set(t.toLowerCase(), `host-${i + 1}`);
  });
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const alt = [...map.keys()].sort((a, b) => b.length - a.length).map(esc).join('|');
  const re = alt ? new RegExp(`(?<![A-Za-z0-9])(?:${alt})(?![A-Za-z0-9])`, 'gi') : null;
  const home = typeof homeDir === 'string' && homeDir.length > 1 ? homeDir : null;
  return (text) => {
    let t = String(text);
    // The home directory carries the account name (config and log paths).
    if (home) t = t.split(home).join('~');
    return re ? t.replace(re, (m) => map.get(m.toLowerCase())) : t;
  };
}

/** `Key=value` ssh options; the value can be a key path or a jump host, so it is dropped when hiding. */
function sshOptionLine(o, hide) {
  const i = String(o).indexOf('=');
  return hide && i >= 0 ? `${String(o).slice(0, i)}=<hidden>` : String(o);
}

function hostSection(h, hide) {
  const c = h.config ?? {};
  const s = h.status ?? null;
  const lines = [
    `### ${NUM(h.n)}`,
    '',
    `- overall: ${h.overall ?? 'unknown'} (${oneLine(h.label)})`,
    `- tunnel: ${h.tunnel?.state ?? 'unknown'}${h.tunnel?.detail ? ` — ${oneLine(h.tunnel.detail)}` : ''}`,
    `- relay version: ${s?.relayVersion ?? 'not reported'}`,
    `- status: ${s
      ? `relay running ${s.relayRunning}, port ${s.relayPort}, extension connected ${s.extensionConnected}, pairing ${s.pairingState}, browsers ${s.browsers}, tabs ${s.tabs}, auto-update ${s.autoUpdate}`
      : 'not available'}`,
    `- status error: ${h.statusError ? oneLine(h.statusError) : 'none'}`,
    `- warnings: ${(h.warnings ?? []).length ? '' : 'none'}`,
    ...(h.warnings ?? []).map((w) => `  - ${oneLine(w)}`),
    '',
    'config:',
    '',
    '```json',
    JSON.stringify({
      id: c.id ?? h.id ?? null,
      name: c.name ?? h.name ?? '',
      host: c.host ?? h.host ?? '',
      transport: c.transport,
      localAddress: c.localAddress,
      innerPort: c.innerPort,
      remotePort: c.remotePort,
      remoteBrowse: c.remoteBrowse,
      browseVersion: c.browseVersion,
      autoConnect: c.autoConnect,
      countActions: c.countActions,
      sshOptions: (c.sshOptions ?? []).map((o) => sshOptionLine(o, hide)),
    }, null, 2),
    '```',
    '',
  ];
  return lines.join('\n');
}

/**
 * Build the bundle.
 *
 * @param {object} p
 * @param {string} p.version          the app version string (core/version.js)
 * @param {object} [p.runtime]        { electron, node, chrome, os, session } as strings
 * @param {string} p.pinned           the pinned browse version
 * @param {object[]} p.hosts          per-host snapshots (Controller.snapshot()), each with its `config`
 * @param {object[]} p.log            the Logger ring: { ts, level, source, message, host? }
 * @param {boolean} [p.hideHostNames] replace destinations, names and ids by host-N (default true)
 * @param {string} [p.homeDir]        replaced by ~ when hiding
 * @returns {string} Markdown
 */
export function buildDiagnostics({ version, runtime = {}, pinned, hosts = [], log = [], hideHostNames = true, homeDir = null } = {}) {
  const hide = hideHostNames !== false;
  const numbered = hosts.map((h, i) => ({ ...h, n: i + 1 }));
  const rt = runtime ?? {};
  const out = [
    '## browse-bridge diagnostics',
    '',
    `- app: ${oneLine(version) || 'unknown'}`,
    `- Electron ${rt.electron ?? '?'}, Chromium ${rt.chrome ?? '?'}, Node ${rt.node ?? '?'}`,
    `- OS: ${rt.os ?? '?'}; session: ${rt.session || 'unknown'}`,
    `- pinned browse: ${pinned ?? 'unknown'}`,
    `- host names: ${hide ? 'hidden, hosts are numbered' : 'shown'}`,
    '',
    `## Hosts (${numbered.length})`,
    '',
    ...numbered.map((h) => hostSection(h, hide)),
    `## Log (last ${Math.min(log.length, LOG_LINES)} lines)`,
    '',
    '```',
    ...log.slice(-LOG_LINES).map((e) => `${e.ts} ${String(e.level ?? '').toUpperCase().padEnd(5)} [${e.host != null ? `${e.host}/` : ''}${e.source}] ${oneLine(e.message)}`),
    '```',
    '',
  ];
  let text = out.join('\n');
  if (hide) text = hostReplacer(numbered, homeDir)(text);
  // The headings are put in last, so a host whose own id is "host-1" cannot be rewritten into another host's number.
  return redact(text).replace(/@@(\d+)@@/g, 'host-$1');
}
