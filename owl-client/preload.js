'use strict';

// Exposes a minimal API to the page; the page never gets Node.js or the token.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('owl', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (data) => ipcRenderer.invoke('settings:save', {
    url: String((data && data.url) || ''),
    token: String((data && data.token) || ''),
    clearToken: Boolean(data && data.clearToken),
  }),
  runTask: (data) => ipcRenderer.invoke('task:run', {
    task: String((data && data.task) || ''),
    startUrl: String((data && data.startUrl) || ''),
  }),
  stopTask: () => ipcRenderer.invoke('task:stop'),
  onLog: (callback) => {
    const listener = (_event, entry) => callback({ time: String(entry.time), line: String(entry.line) });
    ipcRenderer.on('task:log', listener);
    return () => ipcRenderer.removeListener('task:log', listener);
  },
});
