/**
 * The window's view-model: plain functions over HostManager snapshots and log
 * entries. No DOM and no Node imports, so the renderer loads it as an ES
 * module and test/viewmodel.test.js runs it without a display.
 */

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

/** The snapshot of one host from a HostManager snapshot ({ hosts: [...] }). */
/**
 * A host config's pairing address, as config.js pairingAddress() gives it
 * (the renderer cannot import config.js, which needs node:fs; a test pins the two together).
 */
export function pairingAddressOf(cfg) {
  return `${cfg.localAddress === '127.0.0.1' ? 'localhost' : cfg.localAddress}:${cfg.localPort}`;
}

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
 * The Settings form's fields → the host fields IPC sends. A blank local address
 * on Add means "next free" and is left out; on Edit it keeps the address.
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
  // The port is never asked for: it must be the relay's own. The inner (ssh -L) port is allocated.
  if (addr) fields.localAddress = addr;
  if (adding) {
    const id = String(form.id ?? '').trim();
    if (id) fields.id = id;
  }
  return { fields };
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
  if (/is used twice|localAddress|innerPort|no free (local port|loopback address)|loopback address/.test(m)) return 'localAddress';
  if (/sshOptions/.test(m)) return 'sshOptions';
  return null;
}
