// Sandboxed preload: the page gets exactly these calls and nothing else.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('bridge', {
  // { overall, label, hosts: [per-host snapshot, …] }
  state: invoke('state'),
  log: invoke('log'),
  // The running version, "0.1.0+3 1b86d65" (core/version.js), for the status bar.
  version: invoke('version'),
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
  copy: invoke('copy'),
  openLogFile: invoke('openLogFile'),
  autostart: invoke('autostart'),
  setAutostart: invoke('setAutostart'),
  // A per-host snapshot whenever that host changes.
  onState: (fn) => ipcRenderer.on('state', (_e, s) => fn(s)),
  onLog: (fn) => ipcRenderer.on('log', (_e, entry) => fn(entry)),
  // The tray asks for a host (and optionally a tab) to be shown: { id, tab }.
  onSelect: (fn) => ipcRenderer.on('select', (_e, req) => fn(req)),
});
