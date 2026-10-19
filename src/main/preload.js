// Narrow, explicit bridge between the UI and the main process.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch, ...a) => ipcRenderer.invoke(ch, ...a);
const on = (ch, fn) => {
  const listener = (_e, ...a) => fn(...a);
  ipcRenderer.on(ch, listener);
  return () => ipcRenderer.removeListener(ch, listener);
};

contextBridge.exposeInMainWorld('api', {
  apps: {
    list: () => invoke('apps:list'),
    check: () => invoke('apps:check'),
    install: (id) => invoke('apps:install', id),
    updateAll: () => invoke('apps:updateAll'),
    uninstall: (id) => invoke('apps:uninstall', id),
    launch: (id) => invoke('apps:launch', id),
    releaseNotes: (id) => invoke('apps:releaseNotes', id),
    onChange: (fn) => on('apps:changed', fn),
  },
  settings: {
    get: () => invoke('settings:get'),
    set: (patch) => invoke('settings:set', patch),
  },
  toolbox: {
    status: () => invoke('toolbox:status'),
    check: () => invoke('toolbox:check'),
    install: () => invoke('toolbox:install'),
    logs: () => invoke('toolbox:logs'),
    onStatus: (fn) => on('toolbox:status', fn),
  },
});
