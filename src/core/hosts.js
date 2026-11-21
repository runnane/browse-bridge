import { EventEmitter } from 'node:events';
import { hostConfig, normalizeAppConfig, withAppEdits, withHostAdded, withHostEdits, withHostRemoved } from './config.js';

/** What a controller is rebuilt for: its effective config without the poll interval, which it reads at each poll. */
const restartKey = (cfg) => JSON.stringify({ ...cfg, pollSeconds: undefined });
import { Controller } from './controller.js';

/**
 * The state across every configured host. "Up" is the bridge — this host's
 * proxy and tunnel are running — not whether a browser is paired: a browser
 * profile follows one host at a time (BBR-11), so a healthy second host
 * normally waits at "Browser not connected".
 */
export const AGGREGATE = Object.freeze({
  none: 'No host configured',
  allUp: 'All hosts bridged',
  someDown: 'Some hosts down',
  allDown: 'All hosts down',
  stopped: 'All hosts stopped',
});

/** A host whose bridge is running: connection wanted, tunnel up, no fault. A stopped host counts as down. */
export function hostIsUp(snap) {
  return Boolean(snap.connected) && snap.tunnel?.state === 'up' && snap.overall !== 'error';
}

/**
 * Unconfigured hosts are left out; with none configured the answer is "none".
 * Every configured host stopped on purpose is "stopped", not "allDown": nothing
 * is wrong. One stopped host beside a failing one still counts as down.
 */
export function aggregateState(snaps) {
  const configured = snaps.filter((s) => s.overall !== 'unconfigured');
  if (!configured.length) return 'none';
  const up = configured.filter(hostIsUp).length;
  if (up === configured.length) return 'allUp';
  if (up > 0) return 'someDown';
  return configured.every((s) => s.overall === 'stopped') ? 'stopped' : 'allDown';
}

/**
 * The window's per-host actions, by ipc channel. Each takes the host id the
 * window had selected when the button was pressed; the shell dispatches with
 * `runHostAction`, which never falls back to another host.
 */
export const HOST_ACTIONS = Object.freeze({
  connect: (ctl) => ctl.connect(),
  disconnect: (ctl) => ctl.disconnect(),
  setup: (ctl) => ctl.setupRemote(),
  pair: (ctl) => ctl.pair(),
  startRelay: (ctl) => ctl.startRelay(),
  relayLog: (ctl) => ctl.relayLog(200),
});

/** Run one HOST_ACTIONS entry against host `id`. An unknown action or host throws. */
export function runHostAction(manager, action, id) {
  const fn = Object.hasOwn(HOST_ACTIONS, action) ? HOST_ACTIONS[action] : null;
  if (!fn) throw new Error(`no host action "${action}"`);
  return fn(manager.controller(id));
}

/**
 * Owns one Controller per configured host. UI-agnostic like Controller:
 * `apply(config)` brings the set of controllers in line with a config, and
 * every controller's "change" is re-emitted as "change" with the snapshot's
 * `id` naming the host.
 */
export class HostManager extends EventEmitter {
  constructor({ logger, controlDir = null, localEnv = process.env, spawnImpl, createController } = {}) {
    super();
    this.logger = logger;
    this.controlDir = controlDir;
    this.localEnv = localEnv;
    this.spawnImpl = spawnImpl;
    this.createController = createController ?? ((opts) => new Controller(opts));
    /** id → { ctl, key } where key is the effective config the controller was built from. */
    this.entries = new Map();
    this.config = null;
    this.queue = Promise.resolve();
  }

  /** Host ids in config order. */
  ids() {
    return this.config ? this.config.hosts.map((h) => h.id) : [];
  }

  get(id) {
    return this.entries.get(id)?.ctl ?? null;
  }

  /** The first host's controller: the one the single-host window and tray drive. */
  primary() {
    return this.get(this.ids()[0]) ?? null;
  }

  /**
   * Bring the controllers in line with `config`. Unchanged hosts are left
   * alone; removed and changed hosts are stopped first (so two hosts can swap
   * ports), then changed hosts get a new controller and added hosts are
   * created. A replaced host reconnects if it was connected or autoConnect is
   * on; an added host connects if autoConnect is on. Calls are serialised.
   */
  apply(config) {
    const run = this.queue.then(() => this.applyNow(config));
    this.queue = run.catch(() => {});
    return run;
  }

  async applyNow(config) {
    const clean = normalizeAppConfig(config);
    const next = new Map(clean.hosts.map((h) => [h.id, hostConfig(clean, h.id)]));
    const removed = [...this.entries.keys()].filter((id) => !next.has(id));
    const changed = [...next.keys()].filter((id) => this.entries.has(id) && this.entries.get(id).key !== restartKey(next.get(id)));
    const added = [...next.keys()].filter((id) => !this.entries.has(id));
    // A host that differs only in the poll interval keeps its controller and tunnel. Its pending poll
    // timer is re-armed, so a shorter interval applies now, not after the old one runs out.
    for (const [id, cfg] of next) {
      const entry = this.entries.get(id);
      if (!entry || changed.includes(id) || entry.ctl.cfg.pollSeconds === cfg.pollSeconds) continue;
      entry.ctl.cfg = cfg;
      entry.ctl.schedulePoll();
    }

    const wasWanted = new Map();
    for (const id of [...removed, ...changed]) {
      const { ctl } = this.entries.get(id);
      wasWanted.set(id, ctl.wanted);
      await ctl.disconnect();
      ctl.removeAllListeners('change');
      this.entries.delete(id);
      if (removed.includes(id)) this.logger.info('config', `host ${id} removed`);
    }
    this.config = clean;
    const toConnect = [];
    for (const id of [...changed, ...added]) {
      const cfg = next.get(id);
      const ctl = this.createController({
        config: cfg,
        logger: this.logger.forHost(id),
        controlDir: this.controlDir,
        localEnv: this.localEnv,
        spawnImpl: this.spawnImpl,
      });
      ctl.on('change', (snap) => this.emit('change', snap));
      this.entries.set(id, { ctl, key: restartKey(cfg) });
      this.logger.info('config', `host ${id} ${changed.includes(id) ? 'reconfigured' : 'added'}`);
      if (ctl.configured && (wasWanted.get(id) || cfg.autoConnect)) toConnect.push(ctl);
      ctl.changed();
    }
    for (const ctl of toConnect) await ctl.connect();
    return { added, changed, removed };
  }

  /**
   * Replace one host's fields (e.g. from the Settings form), persist with
   * `save` (which validates and returns the clean app config; saveConfig in
   * the shell), then apply. An invalid edit throws before anything is
   * written or restarted. Returns that host's effective config.
   */
  async editHost(id, fields, save = normalizeAppConfig) {
    await this.queue;
    const clean = save(withHostEdits(this.config, id, fields));
    await this.apply(clean);
    return hostConfig(clean, id);
  }

  /**
   * Append a host (from the window's Add Host form), persist with `save` and
   * apply. Blank ports get the config allocator's next free pair. Returns the
   * new host's effective config; an invalid host throws before anything is
   * written or started.
   */
  async addHost(fields, save = normalizeAppConfig) {
    await this.queue;
    const clean = save(withHostAdded(this.config, fields));
    await this.apply(clean);
    return hostConfig(clean, clean.hosts.at(-1).id);
  }

  /**
   * Replace app-wide settings (from the window's General page), persist with
   * `save` and apply. Only APP_EDITABLE_KEYS are taken. A new poll interval
   * restarts no tunnel. Returns { pollSeconds, browseVersion }.
   */
  async editApp(fields, save = normalizeAppConfig) {
    await this.queue;
    const clean = save(withAppEdits(this.config, fields));
    await this.apply(clean);
    return { pollSeconds: clean.pollSeconds, browseVersion: clean.browseVersion };
  }

  /** Remove one host: its controller is disconnected and dropped. The last host is refused. */
  async removeHost(id, save = normalizeAppConfig) {
    await this.queue;
    const clean = save(withHostRemoved(this.config, id));
    await this.apply(clean);
    return clean;
  }

  /**
   * The controller an action for host `id` goes to. An unknown id throws: an
   * action never falls back to another host.
   */
  controller(id) {
    const ctl = this.get(id);
    if (!ctl) throw new Error(`no host with id "${id}"`);
    return ctl;
  }

  /**
   * Every host's snapshot plus the aggregate. While apply() is mid-way (a
   * change event from a host just created, or a timer during a disconnect)
   * the config can name a host that has no controller yet or any more; that
   * host is left out rather than throwing.
   */
  snapshot() {
    const hosts = this.ids().map((id) => this.get(id)).filter(Boolean).map((ctl) => ctl.snapshot());
    const overall = aggregateState(hosts);
    return { overall, label: AGGREGATE[overall], hosts };
  }

  /** Disconnect every host (on quit). The controllers stay, so apply() can reconnect them. */
  async stopAll() {
    await Promise.all([...this.entries.values()].map(({ ctl }) => ctl.disconnect()));
  }
}
