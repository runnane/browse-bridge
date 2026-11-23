/**
 * Updates for a packaged build, the AppImage (BBR-73). electron-updater does
 * the network and the install; this module owns the policy, and takes the
 * updater injected, so the tests drive a fake and never import Electron:
 *
 *   notify, then download, then install on quit. The app never calls
 *   quitAndInstall by itself: a restart drops every tunnel. The user's click
 *   on Update and Restart stops every host through the app's clean quit(),
 *   and the install runs on that quit (autoInstallOnAppQuit), then the app is
 *   relaunched (main.js passes both in).
 *
 * The one setting is the existing Check for updates (`checkUpdates`): off
 * means no check, no download, and a download already made is not installed
 * on quit (autoInstallOnAppQuit false, which electron-updater reads at quit
 * time). The headless test hooks never fetch.
 *
 * The injected updater is electron-updater's autoUpdater, or anything with
 * the same shape: an EventEmitter with checkForUpdates(), downloadUpdate(),
 * quitAndInstall(), and the autoDownload / autoInstallOnAppQuit / logger
 * properties (setFeedURL() only for the test feed).
 */
import { UPDATE_CHECK_INTERVAL_MS, scrubLine } from './updater.js';

/** Test-only: a loopback `generic` feed instead of GitHub Releases. The release build never sets it. */
export const FEED_ENV = 'BB_UPDATE_FEED_URL';

/** Test-only, with FEED_ENV: once an update is downloaded, quit cleanly so the install-on-quit runs (main.js). */
export const E2E_QUIT_ENV = 'BB_UPDATE_E2E_QUIT';

/** What About says when a packaged build could not load electron-updater; the release smoke refuses it (scripts/check-smoke.js). */
export const UPDATER_LOAD_FAILED = 'the updater could not be loaded';

const LOG_SOURCE = 'update';

/** The headless test hooks (main.js's BB_SMOKE_OUT and BB_PROBE_WINDOW): they never fetch. */
export function isSmokeHook(env = process.env) {
  return Boolean(env.BB_SMOKE_OUT || env.BB_PROBE_WINDOW);
}

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * The test feed the environment asks for. Only a loopback http(s) URL is
 * taken: an environment variable must not be able to point an installed app
 * at somebody else's server. Returns { url } | { refused } | null (unset).
 */
export function testFeedUrl(env = process.env) {
  const raw = env[FEED_ENV];
  if (!raw) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { refused: `${FEED_ENV} is not a URL` };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { refused: `${FEED_ENV} must be http or https` };
  const host = u.hostname;
  const loopback = host === 'localhost' || host === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  if (!loopback) return { refused: `${FEED_ENV} must name a loopback address (127.x.y.z, localhost or [::1])` };
  if (u.username || u.password) return { refused: `${FEED_ENV} must not carry credentials` };
  return { url: u.href };
}

/**
 * electron-updater's own log, through Logger: one line each, every URL
 * dropped (it logs "Found version … (url: …)" at info), debug left out.
 */
export function updaterLogger(logger) {
  const line = (m) => scrubLine(String(m?.stack ?? m ?? '').split('\n')[0], 300);
  return {
    info: (m) => logger.info(LOG_SOURCE, `electron-updater: ${line(m)}`),
    warn: (m) => logger.warn(LOG_SOURCE, `electron-updater: ${line(m)}`),
    error: (m) => logger.error(LOG_SOURCE, `electron-updater: ${line(m)}`),
    debug: () => {},
  };
}

/** Why a check or a download failed, in one line, with the release URLs dropped. */
export function updateFailure(err) {
  const msg = String(err?.message ?? err ?? 'unknown error').split('\n').map((l) => l.trim()).find(Boolean) ?? 'unknown error';
  return scrubLine(msg);
}

/**
 * electron-updater is CommonJS; under "type": "module" its `autoUpdater` is a
 * lazy getter that Node's named-export detection does not see, so the named
 * import fails. Default import, then the property. Called only when packaged:
 * the getter constructs the platform's updater.
 */
export async function loadAutoUpdater(importer = () => import('electron-updater')) {
  const mod = await importer();
  const ns = mod?.default ?? mod;
  const updater = ns?.autoUpdater;
  if (!updater || typeof updater.checkForUpdates !== 'function') throw new Error('electron-updater has no autoUpdater');
  return updater;
}

/**
 * The packaged updater's state and policy. main.js calls follow(checkUpdates)
 * at start-up and whenever the setting changes, check() for Check Now,
 * installNow() for Update and Restart, and view() for what updateSummary
 * (core/updater.js) shows.
 */
export class PackagedUpdates {
  constructor({
    updater, logger, env = process.env, intervalMs = UPDATE_CHECK_INTERVAL_MS,
    timers = { setInterval, clearInterval }, now = () => new Date(),
    onChange = () => {}, onDownloaded = () => {}, onPathChanged = () => {},
  }) {
    this.updater = updater;
    this.logger = logger;
    this.env = env;
    this.intervalMs = intervalMs;
    this.timers = timers;
    this.now = now;
    this.onChange = onChange;
    this.onDownloaded = onDownloaded;
    this.onPathChanged = onPathChanged;
    this.smoke = isSmokeHook(env);
    this.enabled = false;
    this.checking = false;
    this.downloading = false;
    this.updating = false;
    this.result = null;
    this.outcome = null;
    this.timer = null;

    // Notify first: the download is started here, only while the setting is on.
    updater.autoDownload = false;
    // Nothing installs on quit until follow(true) says the setting is on.
    updater.autoInstallOnAppQuit = false;
    updater.logger = updaterLogger(logger);

    updater.on('update-available', (info) => this.#available(info));
    updater.on('update-not-available', (info) => {
      if (!this.enabled) return;
      this.result = { status: 'current', kind: 'release', version: info?.version ?? null, checkedAt: this.now().toISOString() };
      this.logger.info(LOG_SOURCE, `update check: browse-bridge ${info?.version ?? '?'} is the newest release`);
      this.onChange();
    });
    updater.on('update-downloaded', (info) => this.#downloaded(info));
    updater.on('error', (err) => this.#failed(err));
    // Only when the running file's name carries a version: electron-updater then writes the new file under the new name.
    updater.on('appimage-filename-updated', (path) => {
      this.logger.warn(LOG_SOURCE, `the update was installed as ${path}, not over the running file`);
      this.onPathChanged(path);
    });

    const feed = testFeedUrl(env);
    if (feed?.refused) this.logger.warn(LOG_SOURCE, `test feed ignored: ${feed.refused}`);
    else if (feed?.url) {
      updater.setFeedURL({ provider: 'generic', url: feed.url });
      this.logger.warn(LOG_SOURCE, `updates come from the loopback test feed in ${FEED_ENV}, not GitHub Releases`);
    }
  }

  /**
   * Follow the Check for updates setting: on, check now and every
   * `intervalMs`; off, stop the timer, drop the notice and install nothing on
   * quit. The headless test hooks never fetch: BB_SMOKE_UPDATE=<x.y.z> shows
   * that version as downloaded instead, so the smoke render shows the notice.
   */
  follow(enabled) {
    this.stop();
    if (this.smoke) {
      const v = this.env.BB_SMOKE_UPDATE;
      this.result = VERSION.test(v ?? '')
        ? { status: 'available', kind: 'release', version: v, downloaded: true, checkedAt: this.now().toISOString() }
        : { status: 'unsupported', kind: 'release', reason: 'the headless test hooks do not fetch' };
      this.onChange();
      return;
    }
    this.enabled = Boolean(enabled);
    this.updater.autoInstallOnAppQuit = this.enabled;
    if (!this.enabled) {
      if (this.result?.downloaded) this.logger.info(LOG_SOURCE, `checking for updates is off: the downloaded browse-bridge ${this.result.version} is not installed on quit`);
      this.result = null;
      this.outcome = null;
      this.onChange();
      return;
    }
    // A download made while the setting was off has no install-on-quit handler: check again from scratch.
    this.result = null;
    this.check();
    this.timer = this.timers.setInterval(() => this.check(), this.intervalMs);
    this.timer?.unref?.();
    this.onChange();
  }

  /** Stop the daily timer (the clean quit calls this too). */
  stop() {
    if (this.timer != null) this.timers.clearInterval(this.timer);
    this.timer = null;
  }

  /** One check; a second one while a check, a download or an install runs is dropped. Never throws. */
  async check() {
    if (!this.enabled || this.checking || this.downloading || this.updating) return;
    this.checking = true;
    this.onChange();
    try {
      const res = await this.updater.checkForUpdates();
      // null: electron-updater is not active (not packaged, or $APPIMAGE unset). Never read that as up to date.
      if (res == null && this.enabled && !this.result) {
        this.result = { status: 'unsupported', kind: 'release', reason: 'this build cannot update itself (not an AppImage, or $APPIMAGE is not set)' };
        this.logger.warn(LOG_SOURCE, `update check: ${this.result.reason}`);
      }
    } catch (err) {
      this.#failed(err);
    } finally {
      this.checking = false;
      this.onChange();
    }
  }

  #available(info) {
    // The setting may have been turned off while the check ran.
    if (!this.enabled) return;
    const version = info?.version ?? '?';
    this.result = { status: 'available', kind: 'release', version, downloaded: false, checkedAt: this.now().toISOString() };
    this.logger.info(LOG_SOURCE, `update available: browse-bridge ${version}; downloading it, to install when browse-bridge quits`);
    this.downloading = true;
    this.onChange();
    Promise.resolve()
      .then(() => this.updater.downloadUpdate())
      .catch((err) => this.#failed(err))
      .finally(() => {
        this.downloading = false;
        this.onChange();
      });
  }

  #downloaded(info) {
    const version = info?.version ?? this.result?.version ?? '?';
    if (!this.enabled) {
      this.logger.info(LOG_SOURCE, `browse-bridge ${version} downloaded while checking for updates is off: not installed on quit`);
      return;
    }
    this.result = { status: 'available', kind: 'release', version, downloaded: true, checkedAt: this.result?.checkedAt ?? this.now().toISOString() };
    // Never quitAndInstall here: a restart drops every tunnel. It installs on quit, or on the user's click.
    this.logger.info(LOG_SOURCE, `browse-bridge ${version} downloaded; it installs when browse-bridge quits`);
    this.onChange();
    this.onDownloaded(version);
  }

  #failed(err) {
    // A failed check both rejects and emits 'error': record and log it once.
    const reason = updateFailure(err);
    if (this.result?.status === 'failed' && this.result.reason === reason) return;
    if (this.enabled) this.result = { status: 'failed', kind: 'release', reason, checkedAt: this.now().toISOString() };
    this.logger.warn(LOG_SOURCE, `could not update: ${reason}`);
    this.onChange();
  }

  /**
   * The user's click on Update and Restart: the update must be downloaded and
   * the setting on. Ask for a relaunch, then run the app's clean quit(),
   * which stops every host; electron-updater installs on that quit. Never
   * quitAndInstall, which would quit without stopping the hosts first.
   */
  async installNow({ relaunch, quit }) {
    if (this.updating) throw new Error('An update is already being installed.');
    if (this.smoke) throw new Error('The headless test hooks do not install updates.');
    if (!this.enabled) throw new Error('Checking for updates is off, so no update is installed.');
    if (this.result?.status !== 'available' || !this.result.downloaded) throw new Error('No update is downloaded yet: check for one first.');
    this.updating = true;
    this.stop();
    this.updater.autoInstallOnAppQuit = true;
    this.logger.info(LOG_SOURCE, `installing browse-bridge ${this.result.version}: every host stops, then it installs and restarts`);
    this.onChange();
    relaunch();
    await quit();
  }

  /** What updateSummary (core/updater.js) reads. */
  view() {
    return {
      enabled: this.smoke ? true : this.enabled,
      checking: this.checking,
      downloading: this.downloading,
      updating: this.updating,
      result: this.result,
      outcome: this.outcome,
    };
  }
}
