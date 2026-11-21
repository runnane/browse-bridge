// Sandboxed preload: the page gets exactly these calls and nothing else.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('bridge', {
  // { overall, label, hosts: [per-host snapshot, …], configFailure: null | { path, message, backup, backupError },
  //   app: { pollSeconds, browseVersion, configPath } }
  state: invoke('state'),
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
  // Host list: saveConfig(id, fields), addHost(fields), removeHost(id).
  saveConfig: invoke('saveConfig'),
  addHost: invoke('addHost'),
  removeHost: invoke('removeHost'),
  // The General page (BBR-45): saveAppSettings({ pollSeconds }), and open config.json in the desktop's editor.
  saveAppSettings: invoke('saveAppSettings'),
  openConfigFile: invoke('openConfigFile'),
  copy: invoke('copy'),
  openLogFile: invoke('openLogFile'),
  autostart: invoke('autostart'),
  setAutostart: invoke('setAutostart'),
  // A per-host snapshot whenever that host changes.
  onState: (fn) => ipcRenderer.on('state', (_e, s) => fn(s)),
  onLog: (fn) => ipcRenderer.on('log', (_e, entry) => fn(entry)),
  // The tray asks for a host (and optionally a tab) to be shown, or a dialog opened: { id, tab, dialog }.
  onSelect: (fn) => ipcRenderer.on('select', (_e, req) => fn(req)),
});
