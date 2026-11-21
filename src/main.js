import { app, BrowserWindow, Menu, Notification, Tray, clipboard, ipcMain, nativeImage, nativeTheme, shell } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigStore, normalizeAppConfig, pairingAddress } from './core/config.js';
import { Logger } from './core/log.js';
import { timed, createLagMonitor } from './core/stall.js';
import { HOST_ACTIONS, HostManager, runHostAction } from './core/hosts.js';
import { autostartArgv, isAppMenuEnabled, isAutostartEnabled, setAppMenu, setAutostart, startsHidden } from './core/autostart.js';
import { HostNotifier, TrayRenderer, coalesce, trayView } from './core/tray.js';
import { readVersion } from './core/version.js';
import { aboutInfo, linkUrl } from './core/about.js';
import { iconPng, trayIconPng } from './icons.js';

const here = fileURLToPath(new URL('.', import.meta.url));

// Chromium on a Wayland session logs ERROR lines at every start that mean nothing for one
// small local window: Vulkan is not supported with ozone/wayland, and Plasma's
// wp_color_manager_v1 cannot take the sRGB transfer function (BBR-34). Turn both off,
// keeping any --disable-features the user passed.
if (process.platform === 'linux') {
  const off = ['Vulkan', 'WaylandWpColorManagerV1'];
  const given = app.commandLine.getSwitchValue('disable-features');
  app.commandLine.appendSwitch('disable-features', [given, ...off].filter(Boolean).join(','));
}

// Two copies would fight over the proxy port; the second one just shows the first's window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(start);
}

let tray = null;
let win = null;
let hosts = null;
/** The first host's controller: only the smoke hook's BB_SMOKE_PAIR still uses it. */
const ctl = () => hosts.primary();
let logger = null;
/** config.json's one read/write path; refuses to write over a file that did not load (BBR-36). */
let store = null;
let quitting = false;
let lagMonitor = null;
/** "0.1.0+3 1b86d65", read once at start-up (core/version.js); shown in the tray tooltip and menu and the window's status bar. */
let appVersion = '';

const paths = () => {
  const dir = app.getPath('userData');
  return {
    config: join(dir, 'config.json'),
    log: join(dir, 'logs', 'app.log'),
    control: join(dir, 'ssh'),
  };
};

/** The argv autostart re-launches: the packaged binary, or the source checkout's launcher. */
function launchArgv() {
  return autostartArgv(menuArgv());
}

/** The same launch without --hidden: the application-menu entry shows the window. */
function menuArgv() {
  return app.isPackaged ? [process.execPath] : [join(app.getAppPath(), 'bin', 'browse-bridge')];
}

function icon(state) {
  return nativeImage.createFromBuffer(iconPng(state, 32), { scaleFactor: 1 });
}

function trayIcon(state) {
  return nativeImage.createFromBuffer(trayIconPng(state, 32), { scaleFactor: 1 });
}

async function start() {
  const p = paths();
  logger = new Logger({ file: p.log });
  store = new ConfigStore(p.config);
  const config = openConfig();
  appVersion = await readVersion(join(here, '..')); // bounded: each git call has a short timeout
  lagMonitor = createLagMonitor(logger);
  lagMonitor.start();
  hosts = new HostManager({ logger, controlDir: p.control });
  // Test hook: render light or dark without a desktop theme.
  if (process.env.BB_THEME === 'dark' || process.env.BB_THEME === 'light') nativeTheme.themeSource = process.env.BB_THEME;

  // The tray needs a desktop session (GTK display); the headless test hooks render the window only.
  if (!process.env.BB_SMOKE_OUT && !process.env.BB_PROBE_WINDOW) {
    tray = new Tray(trayIcon('stopped'));
    // On Linux (StatusNotifierItem) a left click is not reliably delivered, so every control is in the menu too.
    tray.on('click', () => showWindow());
    trayRenderer = new TrayRenderer({
      // Every call is timed; the begin line is written only on an icon-state transition, where the freeze was seen (BBR-4).
      setImage: (state, { trace }) => timed(logger, 'tray.setImage', () => tray.setImage(trayIcon(state)), { trace }),
      setToolTip: (text, { trace }) => timed(logger, 'tray.setToolTip', () => tray.setToolTip(text), { trace }),
      setContextMenu: (model, { trace }) => timed(logger, 'tray.setContextMenu', () => tray.setContextMenu(buildMenu(model)), { trace }),
    });
  }

  hosts.on('change', (snap) => {
    win?.webContents.send('state', snap);
    trayChanged();
  });
  logger.onEntry((entry) => win?.webContents.send('log', entry));

  // Creates the controllers and connects the hosts with autoConnect on.
  await hosts.apply(config);
  registerIpc();
  renderTray();
  logger.info('app', `started ${appVersion}; config ${p.config}`);

  // Keep an existing login entry in the current form (earlier releases wrote it without --hidden).
  if (isAutostartEnabled()) setAutostart(true, launchArgv());
  // Likewise the application-menu entry follows the checkout's current location (never for a packaged build).
  if (!app.isPackaged && isAppMenuEnabled()) setAppMenu(true, menuArgv());
  // A launch by hand shows the window; only the login autostart (--hidden) starts in the tray.
  // An unreadable config file always shows the window: it carries the error and the Reload / Start over choice.
  if (!startsHidden(process.argv) || hosts.snapshot().overall === 'none' || store.failure) showWindow();
  if (process.env.BB_SMOKE_OUT) smoke(process.env.BB_SMOKE_OUT);
  if (process.env.BB_PROBE_WINDOW) probeWindow(process.env.BB_PROBE_WINDOW);
}

/**
 * Read config.json through the store. An unreadable file leaves one blank host
 * in memory and the store failed, so nothing is saved over it (BBR-36).
 */
function openConfig() {
  let config = store.open();
  const f = store.failure;
  if (f) {
    const kept = f.backup ? `a copy is kept at ${f.backup}` : `it could not be copied aside (${f.backupError ?? 'not found'})`;
    logger.error('config', `${f.path} could not be read; ${kept}; nothing is saved over it until it reads again or Start over is chosen: ${f.message}`);
  }
  // An empty list gets a blank host in memory, so the window has a Settings form to fill in.
  if (!config.hosts.length) config = normalizeAppConfig({ ...config, hosts: [{}] });
  return config;
}

/**
 * What the window's state call returns: the hosts, whether the config file
 * could not be read, and the app-wide settings the General page shows (BBR-45).
 */
function appState() {
  const app = hosts.config ? { pollSeconds: hosts.config.pollSeconds, browseVersion: hosts.config.browseVersion, configPath: store.path } : null;
  return { ...hosts.snapshot(), configFailure: store.failure, app };
}

/** Test hook: after start-up settles, record whether a window was opened, then quit. */
async function probeWindow(outFile) {
  const { writeFileSync } = await import('node:fs');
  await new Promise((r) => setTimeout(r, 3000));
  writeFileSync(outFile, JSON.stringify({ window: Boolean(win), visible: Boolean(win?.isVisible()), argv: process.argv.slice(1) }));
  await quit();
}

/**
 * Test hook: open the window, wait for the renderer to draw state, save a
 * screenshot and the rendered text, then quit. Used to check the UI loads
 * without a desktop session.
 */
async function smoke(outPrefix) {
  const { writeFileSync } = await import('node:fs');
  showWindow();
  if (process.env.BB_SMOKE_SIZE) win.setContentSize(...process.env.BB_SMOKE_SIZE.split('x').map(Number));
  const errors = [];
  win.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 3) errors.push(e.message); });
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  if (process.env.BB_SMOKE_PAIR) {
    await ctl().setupRemote();
    await ctl().pair();
  }
  await new Promise((r) => setTimeout(r, 2500));
  const text = await win.webContents.executeJavaScript('document.body.innerText');
  writeFileSync(`${outPrefix}.png`, (await win.webContents.capturePage()).toPNG());
  const js = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name, ms = 400) => {
    await new Promise((r) => setTimeout(r, ms));
    writeFileSync(`${outPrefix}-${name}.png`, (await win.webContents.capturePage()).toPNG());
  };
  for (const [i, tab] of ['status', 'traffic', 'log', 'settings'].entries()) {
    await js(`document.querySelector('[data-tab=${tab}]').click(); document.getElementById('pairDialog').open && document.getElementById('btnPairClose').click();`);
    await shot(tab, i === 1 ? 1500 : 400);
  }
  // With more than one host: select the second, and show its status and its own log.
  let second = null;
  const ids = hosts.ids();
  if (ids.length > 1) {
    await js(`document.querySelector('[data-host="${ids[1]}"]').click(); document.querySelector('[data-tab=status]').click();`);
    await shot('host2');
    second = await js('document.body.innerText');
    await js(`document.querySelector('[data-tab=log]').click();`);
    await shot('host2-log');
  }
  // General (BBR-45): the app-wide page reached from the sidebar. innerText leaves input values out, so they are read too.
  await js(`document.getElementById('navGeneral').click();`);
  await shot('general');
  const general = await js(`(() => {
    const p = document.getElementById('generalPage');
    return { shown: !p.hidden, tabsHidden: document.querySelector('.tabs').hidden, text: p.innerText,
      pollSeconds: document.getElementById('fPoll').value, autostart: document.getElementById('autostart').checked,
        appMenu: { visible: !document.getElementById('appMenuRow').hidden, checked: document.getElementById('appMenu').checked } };
  })()`);
  // The first host's Settings with the Advanced section expanded (it is collapsed by default), and its field values.
  await js(`document.querySelector('[data-host="${ids[0]}"]').click(); document.querySelector('[data-tab=settings]').click();
    (() => { const d = document.getElementById('advanced'); window.__advancedWasOpen = d.open; d.open = true; })();`);
  await shot('advanced');
  const advanced = await js(`(() => {
    const d = document.getElementById('advanced');
    return { host: ${JSON.stringify(ids[0])}, collapsedByDefault: window.__advancedWasOpen === false, open: d.open, text: d.innerText,
      remotePort: document.getElementById('fRemotePort').value, remoteBrowse: document.getElementById('fRemoteBrowse').value,
      transport: document.getElementById('fTransport').textContent };
  })()`);
  // BB_SMOKE_INVALID=1: submit an Add Host form whose id clashes with the first host's, and record the inline error.
  // The config refuses it before writing anything.
  let invalid = null;
  if (process.env.BB_SMOKE_INVALID) {
    await js(`document.querySelector('[data-tab=settings]').click(); document.getElementById('btnAddHost').click();
      const f = document.getElementById('settings'); f.hostId.value = ${JSON.stringify(ids[0])}; f.host.value = 'jon@new.invalid';
      f.dispatchEvent(new Event('input')); f.requestSubmit();`);
    await shot('invalid', 800);
    invalid = await js(`[...document.querySelectorAll('.field-error:not([hidden]), #formError:not([hidden])')].map((e) => (e.id || '') + ': ' + e.textContent)`);
  }
  // The Help and About dialogs: a closed <dialog> is not in innerText, so each is read while open.
  const dialogs = {};
  for (const name of ['help', 'about']) {
    win.webContents.send('select', { dialog: name });
    await shot(name, 600);
    dialogs[name] = await js(`(() => { const d = document.getElementById('${name}Dialog'); const t = d.open ? d.innerText : null; d.close(); return t; })()`);
  }
  writeFileSync(`${outPrefix}.json`, JSON.stringify({ text, second, general, advanced, invalid, dialogs, errors, tray: Boolean(tray), snapshot: hosts.snapshot() }, null, 2));
  await quit();
}

function notify(title, body) {
  if (Notification.isSupported()) timed(logger, `notify "${title}"`, () => new Notification({ title, body, silent: true }).show(), { trace: true });
}

// ---------- tray (the decisions are in core/tray.js) ----------

let trayRenderer = null;
const notifier = new HostNotifier();
// A burst of change events (start-up, a poll across every host) is one render; an unchanged part makes no call.
const trayUpdate = coalesce(() => renderTray(), 150);

/**
 * A host changed, or was added or removed (no event fires after a removal).
 * Notifications are decided now, on every change, so a short-lived transition
 * is not lost to the coalescing; the render is coalesced.
 */
function trayChanged() {
  if (!tray) return;
  for (const n of notifier.update(hosts.snapshot().hosts)) notify(n.title, n.body);
  trayUpdate.run();
}

function renderTray() {
  if (!trayRenderer || quitting) return;
  try {
    trayRenderer.render(trayView(hosts.snapshot(), { autostart: isAutostartEnabled(), version: appVersion, configFailure: store?.failure ?? null }));
  } catch (err) {
    report(err);
  }
}

/** The tray's app-wide actions; host actions go through runHostAction by the item's host id. */
const APP_ACTIONS = {
  showWindow: () => showWindow(),
  openLogFile: () => shell.openPath(paths().log),
  autostart: (item) => { setAutostart(item.checked, launchArgv()); trayUpdate.run(); },
  quit: () => quit(),
  showLogs: (_item, id) => showWindow({ id, tab: 'log' }),
  showHelp: () => showWindow({ dialog: 'help' }),
  showAbout: () => showWindow({ dialog: 'about' }),
};

/** core/tray.js's plain menu model → an Electron Menu, with the clicks attached here. */
function buildMenu(model) {
  const toItem = (m) => {
    const { action, hostId, show, submenu, ...item } = m;
    if (submenu) item.submenu = submenu.map(toItem);
    if (action) item.click = (menuItem) => runTrayAction(action, hostId, show, menuItem);
    return item;
  };
  return Menu.buildFromTemplate(model.map(toItem));
}

function runTrayAction(action, hostId, show, menuItem) {
  if (Object.hasOwn(APP_ACTIONS, action)) return APP_ACTIONS[action](menuItem, hostId);
  if (show) showWindow({ id: hostId, tab: 'status' });
  // The host may have been removed while the menu was open (throws), or be busy (rejects): log, never fall back.
  Promise.resolve().then(() => runHostAction(hosts, action, hostId)).catch(report);
}

function report(err) {
  logger.error('app', err.message);
}

/** Show the window; `focus` ({ id, tab }) selects that host (and tab) once the page is ready. */
function showWindow(focus = null) {
  const select = () => win?.webContents.send('select', focus);
  if (win) {
    win.show();
    win.focus();
    if (focus) {
      if (win.webContents.isLoading()) win.webContents.once('did-finish-load', select);
      else select();
    }
    return;
  }
  win = new BrowserWindow({
    // Wide enough for the host list beside the tabs.
    width: 880,
    height: 540,
    minWidth: 600,
    minHeight: 420,
    useContentSize: true,
    title: 'browse-bridge',
    icon: icon('ready'),
    autoHideMenuBar: true,
    // Breeze window colour, so the first frame is not a white flash.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#202326' : '#eff0f1',
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.setMenu(null);
  // The window shows only its own page: links go out through openLink (core/about.js), never by navigating.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(join(here, 'ui', 'index.html'));
  if (focus) win.webContents.once('did-finish-load', select);
  // Closing the window keeps the tunnel running in the tray.
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => { win = null; });
}

async function quit() {
  quitting = true;
  trayUpdate.cancel();
  lagMonitor?.stop();
  await hosts?.stopAll();
  app.quit();
}

// Keep running in the tray when the window closes.
app.on('window-all-closed', () => {});
app.on('before-quit', () => { quitting = true; });

function registerIpc() {
  // Every write goes through the store, which refuses while config.json is unreadable (BBR-36).
  const save = (cfg) => store.save(cfg);
  ipcMain.handle('state', () => appState());
  // Read config.json again (the user fixed it): apply what was read, never the blank host over it.
  ipcMain.handle('reloadConfig', async () => {
    await hosts.queue;
    const config = openConfig();
    if (!store.failure) {
      await hosts.apply(config);
      logger.info('config', `${store.path} read again`);
    }
    trayChanged();
    return appState();
  });
  // The user chose to replace an unreadable config.json; the store copies it aside first, or refuses.
  ipcMain.handle('startOver', async () => {
    await hosts.queue;
    const clean = store.startOver();
    logger.info('config', `started over: ${store.path} now holds one empty host`);
    await hosts.apply(clean);
    trayChanged();
    return appState();
  });
  ipcMain.handle('log', () => logger.ring);
  ipcMain.handle('version', () => appVersion);
  ipcMain.handle('about', () => ({ ...aboutInfo({ version: appVersion }), icon: `data:image/png;base64,${iconPng('ready', 96).toString('base64')}` }));
  // The page names a link by key; only a key core/about.js lists opens, in the system browser.
  ipcMain.handle('openLink', (_e, key) => {
    const url = linkUrl(key);
    if (!url) throw new Error(`unknown link: ${String(key).slice(0, 40)}`);
    return shell.openExternal(url);
  });
  // Every per-host action names its host; an unknown id is an error, never the first host.
  for (const action of Object.keys(HOST_ACTIONS)) {
    ipcMain.handle(action, (_e, id) => runHostAction(hosts, action, id));
  }
  ipcMain.handle('copy', (_e, text) => clipboard.writeText(String(text)));
  ipcMain.handle('openLogFile', () => shell.openPath(paths().log));
  ipcMain.handle('autostart', () => isAutostartEnabled());
  ipcMain.handle('appMenu', () => ({ packaged: app.isPackaged, enabled: isAppMenuEnabled() }));
  ipcMain.handle('setAppMenu', (_e, on) => {
    if (app.isPackaged) return; // the package ships its own entry
    setAppMenu(Boolean(on), menuArgv());
  });
  ipcMain.handle('setAutostart', (_e, on) => {
    setAutostart(Boolean(on), launchArgv());
    trayUpdate.run(); // the tray's Start at login checkbox follows
  });
  // The General page (BBR-45): app-wide settings go through the same store; only the poll interval is editable.
  ipcMain.handle('saveAppSettings', async (_e, raw) => {
    const clean = await hosts.editApp(raw, save);
    logger.info('config', `saved app settings (poll every ${clean.pollSeconds}s)`);
    return clean;
  });
  // Takes no argument from the page: it opens config.json and nothing else. openPath resolves to an error string.
  ipcMain.handle('openConfigFile', async () => {
    const err = await shell.openPath(store.path);
    if (err) throw new Error(`Could not open ${store.path}: ${err}`);
  });
  ipcMain.handle('saveConfig', async (_e, id, raw) => {
    const clean = await hosts.editHost(id, raw, save);
    logger.info('config', `saved host ${id} (${clean.host || '—'}, pairs with ${pairingAddress(clean)})`);
    return clean;
  });
  ipcMain.handle('addHost', async (_e, raw) => {
    const clean = await hosts.addHost(raw, save);
    logger.info('config', `added host ${clean.id} (${clean.host || '—'}, pairs with ${pairingAddress(clean)})`);
    trayChanged();
    return clean;
  });
  ipcMain.handle('removeHost', async (_e, id) => {
    await hosts.removeHost(id, save);
    trayChanged();
    return hosts.snapshot();
  });
}
