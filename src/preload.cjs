// Sandboxed preload: the page gets exactly these calls and nothing else.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('bridge', {
  // { overall, label, hosts: [per-host snapshot, …], configFailure: null | { path, message, backup, backupError },
  //   app: { pollSeconds, browseVersion, checkUpdates, configPath },
  //   update: { line, detail, subjects, canUpdate, canCheck, busy } (core/updater.js updateSummary),
  //   browse: { line, detail, latest, newer, tested, pin, canCheck, checking } (core/browseversion.js browseUpstreamSummary) }
  state: invoke('state'),
  // BBR-43: check for a newer browse-bridge now; fast-forward, install if needed and restart. Each resolves to `update` above.
  checkForUpdates: invoke('checkForUpdates'),
  updateNow: invoke('updateNow'),
  // BBR-41: checkBrowse() reads the newest browse from the npm registry now and resolves to `browse` above
  // (core/browseversion.js browseUpstreamSummary); upgradeBrowse(id) / rollbackBrowse(id) resolve to the
  // verification result { ok, problems, notes, action, version }. The page never names a version.
  checkBrowse: invoke('checkBrowse'),
  upgradeBrowse: invoke('upgradeBrowse'),
  rollbackBrowse: invoke('rollbackBrowse'),
  // An unreadable config file (BBR-36): read it again, or replace it with one empty host (the old bytes are kept).
  reloadConfig: invoke('reloadConfig'),
  startOver: invoke('startOver'),
  log: invoke('log'),
  // The running version, "0.1.0+3 1b86d65" (core/version.js), for the status bar.
  version: invoke('version'),
  // The About dialog's data: { name, version, description, browseVersion, license, links: [{ key, label, url }] } (core/about.js).
  about: invoke('about'),
  // Open a link by its key in core/about.js's LINKS, in the system browser; any other key is refused in main.
  openLink: invoke('openLink'),
  // Per-host actions: each takes the host id (HOST_ACTIONS in core/hosts.js).
  connect: invoke('connect'),
  disconnect: invoke('disconnect'),
  setup: invoke('setup'),
  pair: invoke('pair'),
  startRelay: invoke('startRelay'),
  relayLog: invoke('relayLog'),
  // BBR-98: unpairBrowser(id, browserId) → { ok, message }; only a browser id the host's last status listed is sent.
  unpairBrowser: invoke('unpairBrowser'),
  // Host list: saveConfig(id, fields), addHost(fields), removeHost(id).
  saveConfig: invoke('saveConfig'),
  addHost: invoke('addHost'),
  removeHost: invoke('removeHost'),
  // BBR-46: the Host aliases in ~/.ssh/config ([{ alias, localForward }]; main reads the file, the page names no path),
  // and Test Connection for the form's unsaved { host, sshOptions, remoteBrowse } (core/sshtest.js's result).
  sshAliases: invoke('sshAliases'),
  testConnection: invoke('testConnection'),
  // The General page (BBR-45): saveAppSettings({ pollSeconds } or { checkUpdates }), and open config.json in the desktop's editor.
  saveAppSettings: invoke('saveAppSettings'),
  openConfigFile: invoke('openConfigFile'),
  // Copy the diagnostics bundle (core/diagnostics.js) to the clipboard; the argument is "hide host names". Resolves to its line count.
  copyDiagnostics: invoke('copyDiagnostics'),
  copy: invoke('copy'),
  openLogFile: invoke('openLogFile'),
  autostart: invoke('autostart'),
  setAutostart: invoke('setAutostart'),
  // The application-menu entry (BBR-48): appMenu() -> { offered, enabled }; setAppMenu(on).
  appMenu: invoke('appMenu'),
  setAppMenu: invoke('setAppMenu'),
  // A per-host snapshot whenever that host changes.
  onState: (fn) => ipcRenderer.on('state', (_e, s) => fn(s)),
  onLog: (fn) => ipcRenderer.on('log', (_e, entry) => fn(entry)),
  // The tray asks for a host (and optionally a tab) to be shown, or a dialog opened: { id, tab, dialog }.
  onSelect: (fn) => ipcRenderer.on('select', (_e, req) => fn(req)),
});
