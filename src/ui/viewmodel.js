/**
 * The window's view-model: plain functions over HostManager snapshots and log
 * entries. No DOM and no Node imports, so the renderer loads it as an ES
 * module and test/viewmodel.test.js runs it without a display.
 */
import { ROLLBACK_BROWSE_LABEL, UPGRADE_BROWSE_LABEL } from '../core/labels.js';
import { compareVersions, testedText } from '../core/browseversion.js';

/** Each state has a glyph and a word, so meaning never rides on colour alone. */
export const GLYPH = Object.freeze({
  ready: '●', warning: '◉', needsPairing: '◎', relayIdle: '◎', error: '✕',
  connecting: '○', unknown: '?', stopped: '■', unconfigured: '■',
});

/** The window-wide glyph for HostManager's aggregate (hosts.js AGGREGATE). */
export const AGGREGATE_GLYPH = Object.freeze({ none: '■', allUp: '●', someDown: '◉', allDown: '✕', stopped: '■' });

/** The aggregate's colour class: reuses the per-host state classes. */
export const AGGREGATE_CLASS = Object.freeze({ none: 'unconfigured', allUp: 'ready', someDown: 'warning', allDown: 'error', stopped: 'stopped' });

/** The one line the pairing dialog carries (BBR-11's finding: the extension keeps one relay address per profile). */
export const PROFILE_NOTE =
  'A browser profile follows one host at a time. Switching a profile to another host’s address needs no new code once it has paired there, and a second profile can use another host at the same time.';

// ---------- formatting ----------

export function fmtBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

export const fmtRate = (n) => `${fmtBytes(Math.round(n))}/s`;

export function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** An error from ipcRenderer.invoke without Electron's "Error invoking remote method 'x': Error: " prefix. */
export function cleanError(message) {
  return String(message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

// ---------- hosts ----------

/** What a host is called in the list and in messages: its name, else its id. */
export function hostTitle(snap) {
  return snap.name || snap.id || 'host';
}

/** The host to show: the current selection while it exists, else the first host, else null. */
export function pickSelected(hosts, selectedId) {
  if (hosts.some((h) => h.id === selectedId)) return selectedId;
  return hosts[0]?.id ?? null;
}

/** Shared with core (tray, controller) so a message and the control it names cannot drift; see core/labels.js. */
export {
  SETUP_LABEL, RELAY_LABEL, EXTENSION_NAME, TEST_LABEL, SSH_OPTIONS_LABEL, CHECK_UPDATES_LABEL, UPDATE_LABEL, CHECK_NOW_LABEL,
  UPGRADE_BROWSE_LABEL, ROLLBACK_BROWSE_LABEL,
} from '../core/labels.js';

/**
 * The message bar for a host's recognised ssh failure (snapshot `problem`,
 * from core/ssherror.js via the tunnel or a status poll), or null (BBR-46).
 */
export function problemBar(snap) {
  if (!snap?.problem?.text) return null;
  return { kind: 'bad', text: `${hostTitle(snap)}: ${snap.problem.text}` };
}

/**
 * A host config's pairing address, as config.js pairingAddress() gives it
 * (the renderer cannot import config.js, which needs node:fs; a test pins the two together).
 */
export function pairingAddressOf(cfg) {
  return `${cfg.localAddress === '127.0.0.1' ? 'localhost' : cfg.localAddress}:${cfg.localPort}`;
}

/** The snapshot of one host from a HostManager snapshot ({ hosts: [...] }). */
export function hostById(state, id) {
  return state?.hosts?.find((h) => h.id === id) ?? null;
}

/** Rows for the host list, in config order. */
export function hostRows(state, selectedId) {
  return (state?.hosts ?? []).map((h) => ({
    id: h.id,
    title: hostTitle(h),
    host: h.host || 'no ssh host',
    /** What a browser profile pairs with to use this host. */
    address: h.pairingAddress,
    overall: h.overall,
    label: h.busy ? `${h.busy}…` : h.label,
    glyph: GLYPH[h.overall] ?? '?',
    selected: h.id === selectedId,
  }));
}

/** Replace one host's snapshot in a HostManager snapshot (on a per-host "state" event). Unknown ids are ignored. */
export function withHostSnapshot(state, snap) {
  if (!state || !state.hosts.some((h) => h.id === snap.id)) return state;
  return { ...state, hosts: state.hosts.map((h) => (h.id === snap.id ? snap : h)) };
}

// ---------- config file ----------

/**
 * The phrase ConfigStore.save() refuses with while the config file is
 * unreadable (config.js UNREADABLE_REFUSAL; the renderer cannot import
 * config.js, so a test pins the two together).
 */
export const UNREADABLE_REFUSAL_TEXT = 'could not be read, so nothing is saved over it';

/**
 * The window's persistent bar for a config file that did not load (BBR-36),
 * from the `configFailure` the state carries (ConfigStore's `failure`), or
 * null when the file read fine. It names the file and the error, where the
 * old bytes were kept, and that nothing is saved until the user acts.
 */
export function configFailureView(failure) {
  if (!failure) return null;
  const kept = failure.backup
    ? ` The file as it was is kept at ${failure.backup}.`
    : failure.backupError ? ` It could not be copied aside (${failure.backupError}).` : '';
  return {
    text: `Could not read ${failure.path}: ${failure.message}.${kept} `
      + 'Settings are not saved over it: fix the file and choose Reload, or choose Start Over to replace it with one empty host.',
    startOverText: `Replace ${failure.path} with a config holding one empty host? `
      + (failure.backup ? `The unreadable file stays at ${failure.backup}.` : 'Its current contents are copied aside first; if they cannot be, nothing is replaced.'),
  };
}

// ---------- log ----------

/**
 * The app-log lines for one host: lines tagged with exactly that id. "all"
 * returns every line, app-wide ones included.
 */
export function logForHost(entries, id) {
  if (id === 'all') return entries;
  return entries.filter((e) => e.host === id);
}

/** One rendered log line. Tagged lines show "<host>/<source>". */
export function logText(e) {
  return `${e.ts.slice(11, 19)}  ${e.level.padEnd(5)}  ${(e.host ? `${e.host}/${e.source}` : e.source).padEnd(7)}  ${e.message}`;
}

// ---------- pairing ----------

/**
 * The pairing dialog for the host with a live code: the selected host's when
 * it has one, else the first host's that has. `dismissed` holds the codes the
 * user closed (any host's), so closing one host's dialog never brings back
 * another's. The address is always that host's own pairing address
 * (its loopback address on its relay's port, BBR-21).
 */
export function pairingView(state, selectedId, { now = Date.now(), dismissed = [] } = {}) {
  const closed = new Set(dismissed);
  const live = (h) => h?.pairing && new Date(h.pairing.expiresAt).getTime() > now
    && h.status?.extensionConnected !== true && !closed.has(h.pairing.code);
  const hosts = state?.hosts ?? [];
  const h = [hostById(state, selectedId), ...hosts].find(live);
  if (!h) return null;
  return {
    id: h.id,
    title: `Pair Browser with ${hostTitle(h)}`,
    code: h.pairing.code,
    address: h.pairingAddress,
    expiresAt: h.pairing.expiresAt,
    note: PROFILE_NOTE,
  };
}

// ---------- agents ----------

/** The command that registers browse's MCP server with an agent on the remote; a test pins it to the README's. */
export const AGENT_INSTALL_COMMAND = 'browse install -a claude';

/**
 * The Status page's Agents row (BBR-49) from `status.agents` (browse.js
 * summarizeStatus): { text, hint }. null is unknown (never "none"); an empty
 * list says none are set up and names the command to run on the remote.
 */
export function agentsView(agents) {
  if (!Array.isArray(agents)) return { text: 'unknown', hint: '' };
  if (agents.length === 0) {
    return { text: 'none set up', hint: `Agents on the remote cannot see browse yet: run ${AGENT_INSTALL_COMMAND} there.` };
  }
  return { text: agents.join(', '), hint: '' };
}

// ---------- action counts ----------

/**
 * The Traffic tab's Actions block (BBR-22) from a host's traffic snapshot:
 * { summary, top, note }. Counting is opt-in, so `traffic.actions` null means
 * off — said as off, never shown as zero actions.
 */
export function actionsView(traffic) {
  const a = traffic?.actions;
  if (!traffic) return { summary: '—', top: '', note: '' };
  if (!a) return { summary: 'Off', top: '', note: 'Turn on “Count browser actions” in Settings to count the commands the relay sends this browser.' };
  const types = Object.entries(a.byType).filter(([, n]) => n > 0).sort((x, y) => y[1] - x[1]);
  const summary = a.total ? `${a.total} command${a.total === 1 ? '' : 's'}: ${types.map(([t, n]) => `${t} ${n}`).join(' · ')}` : 'No commands yet';
  const top = Object.entries(a.byName).sort((x, y) => y[1] - x[1]).slice(0, 6).map(([name, n]) => `${name} ${n}`).join(' · ');
  const notes = [];
  if (a.undecodable) notes.push(`${a.undecodable} connection${a.undecodable === 1 ? '' : 's'} could not be read, so these counts are incomplete (a browse version other than the one measured?)`);
  if (a.undecodedMessages) notes.push(`${a.undecodedMessages} message${a.undecodedMessages === 1 ? '' : 's'} could not be read`);
  notes.push('One agent tool call is usually several browser commands.');
  return { summary, top, note: notes.join('. ') };
}

// ---------- host form ----------

/**
 * config.js DEFAULTS.remotePort and .remoteBrowse (the renderer cannot import
 * config.js; a test pins them together).
 */
export const DEFAULT_RELAY_PORT = 19988;
export const DEFAULT_REMOTE_BROWSE = '$HOME/.local/bin/browse';

/** A whole port number 1–65535 from a form value, else null. "0x50", "1e3" and "" are not ports. */
export function parsePort(value) {
  const s = String(value ?? '').trim();
  if (!/^\d{1,5}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= 65535 ? n : null;
}

/**
 * A remote browse path the form accepts: absolute, or under the remote home
 * ($HOME/ or ~/), naming a file (not ending in /), on one line.
 */
export function isRemoteBrowsePath(p) {
  const s = String(p);
  return /^(\/|\$HOME\/|~\/)/.test(s) && !s.endsWith('/') && !/[\u0000-\u001f\u007f]/.test(s);
}

/**
 * The Settings form's fields → the host fields IPC sends. A blank local address
 * on Add means "next free" and is left out; on Edit it keeps the address.
 * The Advanced fields (BBR-45): a blank remote browse path is the default
 * one; a blank relay port is left to the default on Add and refused on Edit.
 * A field the form does not carry (undefined) is not sent. Transport is never
 * sent: the window shows it read-only, so Apply cannot flip a "local" host.
 * Returns { fields } or { error, field } for what can be told without the config.
 */
export function parseHostForm(form, { adding = false } = {}) {
  const host = String(form.host ?? '').trim();
  if (adding && !host) return { error: 'Enter the SSH host (user@host or an ~/.ssh/config alias).', field: 'host' };
  const fields = {
    name: String(form.name ?? '').trim(),
    host,
    sshOptions: String(form.sshOptions ?? '').split(',').map((x) => x.trim()).filter(Boolean),
    autoConnect: Boolean(form.autoConnect),
    countActions: Boolean(form.countActions),
  };
  const addr = String(form.localAddress ?? '').trim();
  // The pairing port is never asked for: it must be the relay's own. The inner (ssh -L) port is allocated.
  if (addr) fields.localAddress = addr;
  if (adding) {
    const id = String(form.id ?? '').trim();
    if (id) fields.id = id;
  }
  if (form.remoteBrowse !== undefined) {
    const path = String(form.remoteBrowse).trim();
    if (path && !isRemoteBrowsePath(path)) {
      return { error: 'Enter the path of browse on the remote host: absolute, or starting with $HOME/ or ~/.', field: 'remoteBrowse' };
    }
    if (path) fields.remoteBrowse = path;
    else if (!adding) fields.remoteBrowse = DEFAULT_REMOTE_BROWSE;
  }
  if (form.remotePort !== undefined) {
    const raw = String(form.remotePort).trim();
    if (raw || !adding) {
      const port = parsePort(raw);
      if (port === null) return { error: `Enter the relay port, a whole number from 1 to 65535 (${DEFAULT_RELAY_PORT} unless the remote moved it).`, field: 'remotePort' };
      fields.remotePort = port;
    }
  }
  return { fields };
}

// ---------- Test Connection and the ~/.ssh/config aliases (BBR-46) ----------

/**
 * The host form's fields Test Connection needs ({ host, sshOptions,
 * remoteBrowse }), checked as Add checks them: a host is required and the
 * remote browse path must be one the form accepts. Returns { fields } or
 * { error, field }.
 */
export function parseTestForm(form) {
  const parsed = parseHostForm({ host: form.host, sshOptions: form.sshOptions, remoteBrowse: form.remoteBrowse }, { adding: true });
  if (parsed.error) return parsed;
  const { host, sshOptions, remoteBrowse } = parsed.fields;
  return { fields: { host, sshOptions, ...(remoteBrowse ? { remoteBrowse } : {}) } };
}

/** core/sshtest.js's result as the form's in-place bar: { kind: ok|warn|bad, text }. */
export function testResultView(result) {
  if (!result) return null;
  const text = (result.steps ?? []).map((s) => s.text).join(' ');
  return { kind: result.level ?? (result.ok ? 'ok' : 'bad'), text: text || (result.ok ? 'Connected.' : 'The test failed.') };
}

/** The ~/.ssh/config aliases ([{ alias, localForward }], core/sshconfig.js) as the SSH host field's suggestions. */
export function aliasOptions(aliases) {
  return (aliases ?? []).map((a) => ({ value: a.alias, label: a.localForward ? 'has a LocalForward: use the plain host instead' : '' }));
}

/**
 * The warning under the SSH host field when it names an alias that carries a
 * LocalForward, else null. README First run says not to use one: the app
 * forwards the relay itself, and the alias's own forward collides with it.
 */
export function aliasWarning(aliases, host) {
  const h = String(host ?? '').trim();
  const a = (aliases ?? []).find((x) => x.localForward && x.alias.toLowerCase() === h.toLowerCase());
  if (!a) return null;
  return `${a.alias} carries a LocalForward in ~/.ssh/config. The app forwards the relay itself and that forward collides with it: use the plain user@host instead, or an alias without a LocalForward.`;
}

/** How a host's transport reads in the Advanced section, which shows it and never edits it. */
export function transportText(transport) {
  return transport === 'local' ? 'local (browse on this machine)' : 'ssh';
}

// ---------- General (app-wide settings, BBR-45) ----------

/** The poll interval the General page accepts, in whole seconds. config.js falls back to its default below 2. */
export const POLL_SECONDS_MIN = 2;
export const POLL_SECONDS_MAX = 3600;

/**
 * The General page's form → the app-wide fields IPC sends (only the editable
 * ones: the browse pin is shown, never sent). Returns { fields } or { error, field }.
 */
export function parseGeneralForm(form) {
  const s = String(form.pollSeconds ?? '').trim();
  const n = /^\d+$/.test(s) ? Number(s) : NaN;
  if (!(n >= POLL_SECONDS_MIN && n <= POLL_SECONDS_MAX)) {
    return { error: `Enter the poll interval in whole seconds, from ${POLL_SECONDS_MIN} to ${POLL_SECONDS_MAX}.`, field: 'pollSeconds' };
  }
  return { fields: { pollSeconds: n } };
}

/**
 * The General page's read-only lines from the state's `app` block
 * ({ pollSeconds, browseVersion, configPath }): null until main has sent it.
 */
export function generalView(app) {
  if (!app) return null;
  return {
    pollSeconds: String(app.pollSeconds),
    checkUpdates: app.checkUpdates !== false,
    browseVersion: app.browseVersion,
    pinNote: `Set Up Host installs this version on each host and warns when a host runs another. A new browse-bridge release moves it. One host can try a newer browse first: ${UPGRADE_BROWSE_LABEL} on its Status tab, and ${ROLLBACK_BROWSE_LABEL} puts it back on this version.`,
    configPath: app.configPath,
  };
}

/**
 * The update notice (BBR-43) from the state's `update` block (core/updater.js
 * updateSummary): the status bar's button (hidden when `bar` is null), the
 * About dialog's text and commit subjects, and which of its buttons show.
 * Before main has sent it, nothing shows and nothing can be clicked.
 */
export function updateView(update) {
  if (!update) return { bar: null, text: '', subjects: [], showUpdate: false, canUpdate: false, canCheck: false };
  return {
    bar: update.line ?? null,
    text: update.detail ?? '',
    subjects: Array.isArray(update.subjects) ? update.subjects : [],
    showUpdate: Boolean(update.canUpdate) || (Boolean(update.busy) && update.line !== null),
    canUpdate: Boolean(update.canUpdate),
    canCheck: Boolean(update.canCheck),
  };
}

/**
 * The Status tab's browse block for one host (BBR-41), from its snapshot and
 * the state's `browse` block (core/browseversion.js browseUpstreamSummary):
 *   version   what this host is set to run: the app's pin, or its own version
 *   upstream  what the registry check found ("browse 0.1.6 available (not yet tested with this app). …")
 *   upgrade   { text, note, enabled } when a version newer than this host's is known, else null
 *   rollback  { text, enabled } when the host runs its own version, else null
 *   result    the last Upgrade or Roll back: { kind: ok|bad, text }, or null
 * Nothing can be clicked while the host is busy or has no ssh host.
 */
export function browseView(snap, upstream) {
  const cfg = snap?.config ?? {};
  const version = cfg.browseVersion ?? null;
  const pin = cfg.pinnedBrowseVersion ?? version;
  const tested = upstream?.tested ?? [];
  const own = Boolean(version && pin && version !== pin);
  const idle = Boolean(snap) && snap.overall !== 'unconfigured' && !snap.busy;
  const latest = upstream?.latest ?? null;
  const upgradeTo = latest && compareVersions(latest, version) === 1 ? latest : null;
  let result = null;
  const c = snap?.browseChange;
  if (c) {
    const what = c.action === 'rollback' ? 'Roll back' : 'Upgrade';
    result = c.ok
      ? { kind: 'ok', text: `${what} to browse ${c.version} verified${c.notes?.length ? `; ${c.notes.join('; ')}` : ''}.` }
      : { kind: 'bad', text: `${what} to browse ${c.version} did not verify: ${c.problems.join('; ')}.` };
  }
  return {
    version: !version ? 'unknown' : own ? `${version}, set for this host (the app pins ${pin}; ${testedText(version, tested)})` : `${version}, the app's pin`,
    upstream: upstream?.detail ?? '',
    upgrade: upgradeTo ? { text: `${UPGRADE_BROWSE_LABEL} on ${hostTitle(snap)} to ${upgradeTo}`, note: testedText(upgradeTo, tested), enabled: idle } : null,
    rollback: own ? { text: `${ROLLBACK_BROWSE_LABEL} to ${pin}`, enabled: idle } : null,
    canCheck: Boolean(upstream?.canCheck),
    result,
  };
}

/**
 * The "Show in application menu" checkbox from main's { offered, enabled }.
 * A source checkout and an AppImage offer it; a build installed by a package
 * manager ships its own menu entry, so the checkbox is hidden there (and
 * before main has answered).
 */
export function appMenuView(info) {
  if (!info || !info.offered) return { hidden: true, checked: false };
  return { hidden: false, checked: Boolean(info.enabled) };
}

/**
 * Which form field a config error is about, so it is shown next to that
 * field. Matches the messages normalizeAppConfig throws; anything else is
 * shown on the form as a whole (field null), never dropped.
 */
export function errorField(message) {
  const m = String(message);
  // Refused because the config file is unreadable (BBR-36): about no field the user typed.
  if (m.includes(UNREADABLE_REFUSAL_TEXT)) return null;
  if (/not a valid ssh destination/.test(m)) return 'host';
  if (/host id .* must be|two hosts have the id/.test(m)) return 'id';
  // Before the localAddress rule: "remotePort must be a port number" is about the Advanced relay port field.
  if (/remotePort must be/.test(m)) return 'remotePort';
  if (/is used twice|localAddress|innerPort|no free (local port|loopback address)|loopback address/.test(m)) return 'localAddress';
  if (/sshOptions/.test(m)) return 'sshOptions';
  return null;
}
