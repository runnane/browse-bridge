/**
 * What the tray shows, as plain data: the aggregate icon state, the tooltip,
 * the menu model and the per-host notifications. The Electron shell
 * (main.js) turns the menu model into a Menu and attaches the clicks; all the
 * decisions live here so they are tested without a display (BBR-14).
 *
 * The tray's Electron calls are where a main-process freeze was seen
 * (BBR-4/BBR-10), so TrayRenderer only makes a call when what it would set
 * changed, and `coalesce` folds a burst of change events into one render.
 */

import { RELAY_LABEL, SETUP_LABEL } from './labels.js';

/** A host's display name: its name, else its id. Same rule as the window's hostTitle. */
export function hostTitle(snap) {
  return snap.name || snap.id || 'host';
}

/** A host's state in words, with the running action if there is one. */
export function hostStateText(snap) {
  return snap.busy ? `${snap.label} (${snap.busy}…)` : snap.label;
}

/**
 * One line per item, joined with "\n": the title with the aggregate state, one
 * line per host, then the running version (omitted when none is passed), e.g.
 *   browse-bridge — Some hosts down
 *   dev004: Connected
 *   dev005: Tunnel down
 *   0.1.0+3 1b86d65
 */
export function trayTooltip(agg, { version = '', configFailure = null } = {}) {
  return [
    `browse-bridge — ${agg.label}`,
    ...(configFailure ? [configFailureLine(configFailure)] : []),
    ...agg.hosts.map((h) => `${hostTitle(h)}: ${hostStateText(h)}`),
    ...(version ? [version] : []),
  ].join('\n');
}

/**
 * The tray menu as plain data. An item that does something carries `action`
 * (and `hostId` for a host's own controls); a host action that opens a
 * dialog in the window also carries `show: true`, so the window comes up
 * with that host selected. Host actions are HOST_ACTIONS names (hosts.js),
 * dispatched by host id — never "the first host".
 *
 * Byte counters are left out on purpose: they change on every extension
 * retry, and the menu would be rebuilt (under the cursor) each time. The
 * window shows traffic.
 */
export function trayMenuModel(agg, { autostart = false, version = '', configFailure = null, update = null } = {}) {
  return [
    { label: `browse-bridge: ${agg.label}`, enabled: false },
    // The config file did not load (BBR-36): the window has the details and the Reload / Start over choice.
    ...(configFailure ? [{ label: configFailureLine(configFailure), action: 'showWindow' }] : []),
    // A newer browse-bridge on origin (BBR-43): opens About, where the update is one click. No timestamp, so the menu is not rebuilt each check.
    ...(update ? [{ label: update, action: 'showAbout' }] : []),
    { type: 'separator' },
    ...agg.hosts.map(hostSubmenu),
    { type: 'separator' },
    { label: 'Show window', action: 'showWindow' },
    { label: 'Open log file', action: 'openLogFile' },
    { label: 'Start at login', type: 'checkbox', checked: Boolean(autostart), action: 'autostart' },
    { type: 'separator' },
    // Both open a dialog in the window (BBR-32).
    { label: 'Help', action: 'showHelp' },
    { label: 'About browse-bridge…', action: 'showAbout' },
    // Puts a bug-report bundle on the clipboard, always with host names hidden (BBR-47).
    { label: 'Copy diagnostics', action: 'copyDiagnostics' },
    { type: 'separator' },
    ...(version ? [{ label: version, enabled: false }] : []),
    { label: 'Quit', action: 'quit' },
  ];
}

function hostSubmenu(h) {
  const hostId = h.id;
  const configured = h.overall !== 'unconfigured';
  const idle = configured && !h.busy;
  return {
    label: `${hostTitle(h)}: ${hostStateText(h)}`,
    submenu: [
      { label: h.host || 'no ssh host', enabled: false },
      // What to do about an ssh failure (BBR-46). Its text holds no countdown, so the menu is not rebuilt each retry.
      ...(h.problem ? [{ label: problemLine(h.problem), enabled: false }] : []),
      ...(h.warnings ?? []).map((w) => ({ label: `⚠ ${w}`, enabled: false })),
      { type: 'separator' },
      h.connected
        ? { label: 'Disconnect', action: 'disconnect', hostId }
        : { label: 'Connect', enabled: configured, action: 'connect', hostId },
      { label: 'Pair browser…', enabled: idle, action: 'pair', hostId, show: true },
      { label: RELAY_LABEL, enabled: idle, action: 'startRelay', hostId },
      { label: SETUP_LABEL, enabled: idle, action: 'setup', hostId, show: true },
      { type: 'separator' },
      { label: 'Show logs', action: 'showLogs', hostId },
    ],
  };
}

/**
 * One line naming the unreadable config file and why (ConfigStore's
 * `failure`), cut to a length a menu shows: "⚠ Cannot read /…/config.json: Unexpected token …".
 */
export function configFailureLine(failure, max = 120) {
  const line = `⚠ Cannot read ${failure.path}: ${String(failure.message).replace(/\s+/g, ' ')}`;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** A host's classified ssh failure (snapshot `problem`) as one menu line, cut to a length a menu shows. */
export function problemLine(problem, max = 160) {
  const line = `✕ ${String(problem.text).replace(/\s+/g, ' ')}`;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * Everything the tray displays for one aggregate snapshot (HostManager.snapshot()), plus ConfigStore's failure if any
 * and the updater's one notice line (core/updater.js updateSummary's `line`), if any.
 */
export function trayView(agg, { autostart = false, version = '', configFailure = null, update = null } = {}) {
  return {
    icon: agg.overall,
    tooltip: trayTooltip(agg, { version, configFailure }),
    menu: trayMenuModel(agg, { autostart, version, configFailure, update }),
  };
}

/**
 * Applies trayViews to a tray through three setters, calling each only when
 * its part changed: setImage(iconState, opts), setToolTip(text, opts),
 * setContextMenu(menuModel, opts). `opts.trace` is true when the icon state
 * changed — the transitions the freeze was seen at (BBR-4). A setter that
 * throws leaves its part marked unrendered, so the next render retries it.
 */
export class TrayRenderer {
  constructor({ setImage, setToolTip, setContextMenu }) {
    this.setters = { icon: setImage, tooltip: setToolTip, menu: setContextMenu };
    this.invalidate();
  }

  /** Forget what was rendered: the next render sets every part. */
  invalidate() {
    this.last = { icon: null, tooltip: null, menu: null };
  }

  /** Returns the parts that were set, in order. */
  render(view) {
    const keys = { icon: view.icon, tooltip: view.tooltip, menu: JSON.stringify(view.menu) };
    const trace = keys.icon !== this.last.icon;
    const done = [];
    for (const part of ['icon', 'tooltip', 'menu']) {
      if (keys[part] === this.last[part]) continue;
      this.setters[part](view[part], { trace });
      this.last[part] = keys[part];
      done.push(part);
    }
    return done;
  }
}

/** The states a host has left on a disconnect worth telling the user about. */
const DISCONNECTED = new Set(['error', 'needsPairing', 'relayIdle']);

/**
 * Per-host connect/disconnect notifications. Feed it every aggregate
 * snapshot; it remembers each host's last state by id. A host seen for the
 * first time (start-up, an added host, a reconfigured host's new controller)
 * only records its state, and a host that is gone is forgotten, so adding or
 * removing a host never notifies. Stopping a host (stopped) is silent.
 */
export class HostNotifier {
  constructor() {
    this.prev = new Map();
  }

  /** Returns the notifications to show: [{ hostId, title, body }]. */
  update(hosts) {
    const notes = [];
    const next = new Map();
    for (const h of hosts) {
      const was = this.prev.get(h.id);
      next.set(h.id, h.overall);
      if (was === undefined || was === h.overall) continue;
      const title = hostTitle(h);
      if (h.overall === 'ready') {
        notes.push({ hostId: h.id, title: `${title} connected`, body: `Agents on ${h.host} can use this browser.` });
      } else if (was === 'ready' && DISCONNECTED.has(h.overall)) {
        const detail = h.tunnel?.detail ? `: ${h.tunnel.detail}` : '';
        notes.push({ hostId: h.id, title: `${title} disconnected`, body: `${h.label}${detail}` });
      }
    }
    this.prev = next;
    return notes;
  }
}

/**
 * Fold a burst of calls into one: `run()` schedules `fn` after `ms` unless a
 * run is already pending; `cancel()` drops it (on quit). Timers are
 * injectable for tests.
 */
export function coalesce(fn, ms, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let pending = null;
  return {
    run() {
      if (pending !== null) return;
      pending = setTimer(() => {
        pending = null;
        fn();
      }, ms);
    },
    cancel() {
      if (pending !== null) clearTimer(pending);
      pending = null;
    },
    get pending() {
      return pending !== null;
    },
  };
}
