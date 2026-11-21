import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

/** The browse version this app installs and expects on the remote host. */
export const PINNED_BROWSE_VERSION = '0.1.4';

/**
 * Pins earlier releases of this app wrote into config.json as the default.
 * A stored value equal to one of these was never a user choice, so it is
 * dropped on load and the current pin applies.
 */
const SUPERSEDED_DEFAULT_PINS = ['0.1.3'];

export const DEFAULTS = Object.freeze({
  /** ssh destination, e.g. "jon@dev004" or an alias from ~/.ssh/config. */
  host: '',
  /** "ssh" for real use; "local" runs browse on this machine (tests, single-machine use). */
  transport: 'ssh',
  /**
   * Loopback address the browser extension pairs with, on the relay's own port
   * (<localAddress>:<relay port>). Each host has its own: the extension binds
   * its pairing proof to the port it dials, so every host's address must carry
   * that host's relay port, and only the address can tell hosts apart (BBR-21).
   */
  localAddress: '127.0.0.1',
  /** Port ssh's -L forward listens on (127.0.0.1); the proxy pipes the pairing address → innerPort. */
  innerPort: 19989,
  /** Relay port on the remote host until `browse status --json` reports the real one. */
  remotePort: 19988,
  /** Path of the browse binary on the remote host. A leading $HOME/ is expanded remotely. */
  remoteBrowse: '$HOME/.local/bin/browse',
  /** Version setup installs and the warning state checks against. */
  browseVersion: PINNED_BROWSE_VERSION,
  /** Connect as soon as the app starts. */
  autoConnect: true,
  /** Seconds between remote status polls. */
  pollSeconds: 10,
  /** Extra ssh -o options, e.g. ["IdentityFile=~/.ssh/id_dev"]. */
  sshOptions: [],
  /**
   * Opt-in (BBR-22): read the names of the commands the relay sends the
   * browser and count them by type. Off, relay → browser is never decoded.
   */
  countActions: false,
  /**
   * App-wide (BBR-43): check daily whether the source checkout is behind
   * origin. Only a notice; nothing is installed without a click.
   */
  checkUpdates: true,
});

const PORT_KEYS = ['innerPort', 'remotePort'];

/** A loopback IPv4 address other than the network and broadcast ones: 127.0.0.1 … 127.255.255.254. */
export function isLoopbackAddress(a) {
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(a));
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return false;
  const all = o.join('.');
  return all !== '0.0.0' && all !== '255.255.255';
}

/** The address the extension is told to dial: 127.0.0.1 reads as "localhost", as earlier releases showed it. */
export function pairingAddress(cfg) {
  return `${cfg.localAddress === '127.0.0.1' ? 'localhost' : cfg.localAddress}:${cfg.localPort}`;
}

/**
 * Validate and normalise one host's effective (flat) config: a host entry plus
 * the app-wide pollSeconds/browseVersion. Throws with a readable message on
 * anything that would make an ssh call unsafe or a port bind impossible.
 */
export function normalizeConfig(raw = {}) {
  const cfg = { ...DEFAULTS, ...raw };
  cfg.host = String(cfg.host ?? '').trim();
  if (cfg.transport !== 'ssh' && cfg.transport !== 'local') {
    throw new Error(`transport must be "ssh" or "local", got ${JSON.stringify(cfg.transport)}`);
  }
  if (cfg.transport === 'ssh' && cfg.host !== '') {
    // A destination that starts with "-" would be read by ssh as an option.
    if (cfg.host.startsWith('-') || /\s/.test(cfg.host)) {
      throw new Error(`host ${JSON.stringify(cfg.host)} is not a valid ssh destination`);
    }
  }
  for (const key of PORT_KEYS) {
    const n = Number(cfg[key]);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${key} must be a port number, got ${cfg[key]}`);
    cfg[key] = n;
  }
  cfg.localAddress = String(cfg.localAddress ?? '').trim();
  if (!isLoopbackAddress(cfg.localAddress)) throw new Error(`localAddress must be a loopback address such as 127.0.0.2, got ${JSON.stringify(cfg.localAddress)}`);
  if (cfg.transport === 'local' && cfg.localAddress === '127.0.0.1') {
    throw new Error('a local-transport host needs its own loopback address (e.g. 127.0.0.2): the relay itself holds 127.0.0.1');
  }
  // Not a setting: the extension must dial the relay's own port. The controller follows the port status reports.
  cfg.localPort = cfg.remotePort;
  if (cfg.localAddress === '127.0.0.1' && cfg.localPort === cfg.innerPort) throw new Error(`innerPort ${cfg.innerPort} is the pairing port on 127.0.0.1`);
  if (!Array.isArray(cfg.sshOptions) || cfg.sshOptions.some((o) => typeof o !== 'string' || !o.includes('='))) {
    throw new Error('sshOptions must be a list of "Key=value" strings');
  }
  const poll = Number(cfg.pollSeconds);
  cfg.pollSeconds = Number.isFinite(poll) && poll >= 2 ? poll : DEFAULTS.pollSeconds;
  cfg.autoConnect = Boolean(cfg.autoConnect);
  cfg.countActions = cfg.countActions === true;
  cfg.checkUpdates = cfg.checkUpdates !== false;
  cfg.remoteBrowse = String(cfg.remoteBrowse || DEFAULTS.remoteBrowse);
  cfg.browseVersion = String(cfg.browseVersion || PINNED_BROWSE_VERSION);
  return cfg;
}

/** Settings that apply to the whole app, not to one host. */
export const APP_KEYS = Object.freeze(['pollSeconds', 'browseVersion', 'checkUpdates']);

/** Settings each host entry carries. `id` and `name` have no default; the rest fall back to DEFAULTS. */
export const HOST_KEYS = Object.freeze(['id', 'name', 'host', 'transport', 'localAddress', 'innerPort', 'remotePort', 'remoteBrowse', 'sshOptions', 'autoConnect', 'countActions']);

/** A host id goes into log lines and ipc; lower-case only, so it can never look like a pairing code. */
const HOST_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;


const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));
const isSet = (v) => v !== undefined && v !== null && v !== '';

/**
 * Fill each host's missing innerPort (19989, 19991, …) and localAddress
 * (127.0.0.1, 127.0.0.2, …; a local-transport host never gets 127.0.0.1),
 * skipping every value another host already states. Values a host states are
 * never moved, so removing one host does not shift another's pairing address.
 */
function allocateLocal(entries) {
  const ports = new Set(entries.filter((e) => isSet(e.innerPort)).map((e) => Number(e.innerPort)));
  const addrs = new Set(entries.filter((e) => isSet(e.localAddress)).map((e) => String(e.localAddress).trim()));
  return entries.map((e) => {
    const out = { ...e };
    if (!isSet(out.innerPort)) {
      let p = DEFAULTS.innerPort;
      while (ports.has(p)) p += 2;
      if (p > 65535) throw new Error('no free local port left for a new host');
      out.innerPort = p;
      ports.add(p);
    }
    if (!isSet(out.localAddress)) {
      let n = out.transport === 'local' ? 2 : 1;
      while (addrs.has(`127.0.0.${n}`)) n++;
      if (n > 254) throw new Error('no free loopback address left for a new host');
      out.localAddress = `127.0.0.${n}`;
      addrs.add(out.localAddress);
    }
    return out;
  });
}

/** Give every host without an id the first free "host-N". */
function assignIds(entries) {
  const idOf = (e) => (isSet(e.id) ? String(e.id).trim() : '');
  const used = new Set(entries.map(idOf).filter(Boolean));
  let n = 1;
  return entries.map((e) => {
    const id = idOf(e);
    if (id) return { ...e, id };
    while (used.has(`host-${n}`)) n++;
    used.add(`host-${n}`);
    return { ...e, id: `host-${n}` };
  });
}

/**
 * Validate and normalise the whole app config:
 *
 *   { pollSeconds, browseVersion, hosts: [{ id, name, host, transport, localAddress, innerPort, … }] }
 *
 * A config without a `hosts` key is the single-host shape earlier releases
 * wrote (top-level `host`, `localPort`, …): it becomes a one-entry list with
 * the same effective values. An empty config gives one unconfigured host.
 * Refuses duplicate ids and any local port two hosts would both bind — a
 * clash is a config error, not a runtime "port in use".
 */
export function normalizeAppConfig(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('config must be an object');
  let entries;
  if (raw.hosts === undefined) entries = [pick(raw, HOST_KEYS)];
  else if (!Array.isArray(raw.hosts)) throw new Error('hosts must be a list');
  else entries = raw.hosts;
  entries.forEach((e, i) => {
    if (e === null || typeof e !== 'object' || Array.isArray(e)) throw new Error(`host #${i + 1} must be an object`);
  });
  entries = allocateLocal(assignIds(entries.map((e) => pick(e, HOST_KEYS))));

  const app = normalizeConfig(pick(raw, APP_KEYS));
  const seen = new Set();
  const hosts = entries.map((e) => {
    if (!HOST_ID.test(e.id)) throw new Error(`host id ${JSON.stringify(e.id)} must be lower-case letters, digits, "-" or "_" (at most 32)`);
    if (seen.has(e.id)) throw new Error(`two hosts have the id "${e.id}"`);
    seen.add(e.id);
    let flat;
    try {
      flat = normalizeConfig({ ...e, pollSeconds: app.pollSeconds, browseVersion: app.browseVersion });
    } catch (err) {
      throw new Error(`host "${e.id}": ${err.message}`);
    }
    return { ...pick(flat, HOST_KEYS), id: e.id, name: String(e.name ?? '').trim() };
  });

  // What each host binds on this machine: its pairing address, and its ssh forward on 127.0.0.1.
  const owner = new Map();
  const addrOwner = new Map();
  for (const h of hosts) {
    const binds = [[`${h.localAddress}:${h.remotePort}`, 'localAddress'], [`127.0.0.1:${h.innerPort}`, 'innerPort']];
    // One address per host even where the relay ports differ: the relay port can move at runtime.
    if (addrOwner.has(h.localAddress)) throw new Error(`localAddress ${h.localAddress} is used twice: hosts "${addrOwner.get(h.localAddress)}" and "${h.id}"`);
    addrOwner.set(h.localAddress, h.id);
    for (const [bind, key] of binds) {
      const prev = owner.get(bind);
      if (prev) throw new Error(`${bind} is used twice: host "${prev.id}" ${prev.key} and host "${h.id}" ${key}`);
      owner.set(bind, { id: h.id, key });
    }
  }
  // checkUpdates is app-only: hostConfig never passes it, so turning it off or on restarts no tunnel.
  return { pollSeconds: app.pollSeconds, browseVersion: app.browseVersion, checkUpdates: app.checkUpdates, hosts };
}

/** One host's effective flat config: what Controller, the tunnel and the transport read. */
export function hostConfig(app, id) {
  const h = app.hosts.find((x) => x.id === id);
  if (!h) throw new Error(`no host with id "${id}"`);
  // checkUpdates is app-wide (BBR-43): a host's config never carries it, so it cannot read as that host's setting.
  const { checkUpdates: _app, ...flat } = normalizeConfig({ ...h, pollSeconds: app.pollSeconds, browseVersion: app.browseVersion });
  return flat;
}

/**
 * The app config with one host's fields replaced (e.g. by the Settings form).
 * Only host fields are taken from `fields`, and the id stays. Not validated
 * here: saveConfig / normalizeAppConfig do that.
 */
export function withHostEdits(app, id, fields) {
  if (!app.hosts.some((h) => h.id === id)) throw new Error(`no host with id "${id}"`);
  const edits = pick(fields, HOST_KEYS.filter((k) => k !== 'id'));
  return { ...app, hosts: app.hosts.map((h) => (h.id === id ? { ...h, ...edits } : h)) };
}

/**
 * App-wide settings the window may change (BBR-45; checkUpdates, BBR-43).
 * `browseVersion` is not one: the window shows the pin read-only, so no ipc
 * call can move it.
 */
export const APP_EDITABLE_KEYS = Object.freeze(['pollSeconds', 'checkUpdates']);

/**
 * The app config with app-wide fields replaced (e.g. by the General page).
 * Only APP_EDITABLE_KEYS are taken from `fields`; the hosts stay. Not
 * validated here: saveConfig / normalizeAppConfig do that.
 */
export function withAppEdits(app, fields) {
  return { ...app, ...pick(fields ?? {}, APP_EDITABLE_KEYS) };
}

/**
 * A host id from a name or an ssh destination ("jon@dev005:22" → "dev005"),
 * made unique against `taken` with a "-2", "-3", … suffix. Empty when nothing
 * usable is left, so the config's own "host-N" applies.
 */
export function suggestHostId(fields, taken = []) {
  const source = isSet(fields.name) ? String(fields.name) : String(fields.host ?? '').replace(/^.*@/, '').replace(/:.*$/, '').split('.')[0];
  const base = source.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|-+$/g, '').slice(0, 28);
  if (!base) return '';
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

/**
 * The app config with one host appended. Ports left blank are not filled
 * here: normalizeAppConfig's allocator gives the next free address and port, so the window
 * never guesses a port. A blank id becomes suggestHostId's. Not validated
 * here: saveConfig / normalizeAppConfig do that (duplicate id, port clash, …).
 */
export function withHostAdded(app, fields) {
  const entry = Object.fromEntries(Object.entries(pick(fields, HOST_KEYS)).filter(([, v]) => isSet(v)));
  if (!isSet(entry.id)) {
    const id = suggestHostId(entry, app.hosts.map((h) => h.id));
    if (id) entry.id = id;
  }
  return { ...app, hosts: [...app.hosts, entry] };
}

/** The app config without one host. The last host cannot be removed: the window and tray always drive one. */
export function withHostRemoved(app, id) {
  if (!app.hosts.some((h) => h.id === id)) throw new Error(`no host with id "${id}"`);
  if (app.hosts.length === 1) throw new Error('the last host cannot be removed; edit it instead');
  return { ...app, hosts: app.hosts.filter((h) => h.id !== id) };
}

export function loadConfig(path) {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (SUPERSEDED_DEFAULT_PINS.includes(raw.browseVersion)) delete raw.browseVersion;
    return normalizeAppConfig(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return normalizeAppConfig({});
    throw err;
  }
}

const differs = (k, v) => JSON.stringify(v) !== JSON.stringify(DEFAULTS[k]);

/** Validates first and writes nothing on an invalid config. Returns the normalised app config. */
export function saveConfig(path, cfg) {
  const clean = normalizeAppConfig(cfg);
  // Persist only what differs from the defaults, so a later default (e.g. a new pin) still applies.
  // Ports compare with the fixed defaults, not a host's allocated pair, so a stored port never moves.
  const stored = Object.fromEntries(APP_KEYS.filter((k) => differs(k, clean[k])).map((k) => [k, clean[k]]));
  stored.hosts = clean.hosts.map((h) => ({
    id: h.id,
    ...(h.name ? { name: h.name } : {}),
    ...Object.fromEntries(HOST_KEYS.filter((k) => k !== 'id' && k !== 'name' && differs(k, h[k])).map((k) => [k, h[k]])),
  }));
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(stored, null, 2)}\n`);
  renameSync(tmp, path);
  return clean;
}

/** Where an unreadable config file is copied aside: "<path>.broken-2026-11-21T16-38-17-752Z" (no colons). */
export function brokenBackupPath(path, now = new Date()) {
  return `${path}.broken-${now.toISOString().replace(/[:.]/g, '-')}`;
}

/** The start of the message a save is refused with while the config file is unreadable. */
export const UNREADABLE_REFUSAL = 'could not be read, so nothing is saved over it';

/**
 * The one path the app reads and writes config.json through (BBR-36).
 *
 * A file that exists but does not load — bad JSON, a value normalizeAppConfig
 * refuses, a permission error — is never replaced behind the user's back:
 * open() copies its bytes aside to brokenBackupPath() before returning, and
 * the store stays failed. While failed, `failure` says why and save() refuses
 * every write, so an Apply on the blank host the app runs with cannot
 * overwrite the user's hosts. It leaves the failed state only through open()
 * reading the file again (after the user fixed it: the caller applies what was
 * read, never the blank host), or startOver(), the user's explicit choice,
 * which writes a fresh config only once a copy of the old bytes exists.
 * A missing file is not a failure: it is the first start.
 */
export class ConfigStore {
  constructor(path, { now = () => new Date() } = {}) {
    this.path = path;
    this.now = now;
    /** null, or { path, message, backup, backupError } while the file could not be read. */
    this.failure = null;
  }

  /**
   * Read the file. Returns the app config: the file's, or one blank host when
   * it is missing or unreadable (then `failure` is set and the bytes are copied aside).
   */
  open() {
    try {
      const config = loadConfig(this.path);
      this.failure = null;
      return config;
    } catch (err) {
      const prev = this.failure;
      this.failure = { path: this.path, message: err.message, backup: null, backupError: null };
      Object.assign(this.failure, this.backUp(prev?.backup));
      return normalizeAppConfig({});
    }
  }

  /**
   * Copy the file's current bytes aside, never over an existing file. `known`
   * is a backup already made: when it holds the same bytes it is reused, so a
   * repeated Reload of one bad file leaves one copy. Returns { backup, backupError }.
   */
  backUp(known = null) {
    let bytes;
    try {
      bytes = readFileSync(this.path);
    } catch (err) {
      return { backup: null, backupError: err.code === 'ENOENT' ? null : err.message };
    }
    if (known) {
      try {
        if (readFileSync(known).equals(bytes)) return { backup: known, backupError: null };
      } catch {
        // gone or unreadable: make a new one
      }
    }
    const base = brokenBackupPath(this.path, this.now());
    for (let n = 1; n <= 100; n++) {
      const target = n === 1 ? base : `${base}-${n}`;
      try {
        writeFileSync(target, bytes, { flag: 'wx' });
        return { backup: target, backupError: null };
      } catch (err) {
        if (err.code !== 'EEXIST') return { backup: null, backupError: err.message };
      }
    }
    return { backup: null, backupError: 'no free backup file name' };
  }

  /** saveConfig through the guard: refused while the file is unreadable. */
  save(cfg) {
    if (this.failure) {
      // The load error is not repeated here: it can quote file text, and the window's bar already shows it.
      throw new Error(`${this.path} ${UNREADABLE_REFUSAL}. Fix the file and choose Reload, or choose Start Over.`);
    }
    return saveConfig(this.path, cfg);
  }

  /**
   * The user chose to discard the unreadable file: copy its current bytes
   * aside (again, if they changed since open()), then write a config with one
   * blank host. Refused when the copy cannot be made. Returns the new config.
   */
  startOver() {
    if (!this.failure) throw new Error(`${this.path} reads fine; there is nothing to start over from`);
    const copy = this.backUp(this.failure.backup);
    Object.assign(this.failure, copy);
    if (copy.backupError) throw new Error(`Cannot start over: ${this.path} could not be copied aside first (${copy.backupError})`);
    const clean = saveConfig(this.path, {});
    this.failure = null;
    return clean;
  }
}
