const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('videoApi', {
  enlarge: () => ipcRenderer.invoke('video:enlarge'),
  toggleFullscreen: () => ipcRenderer.invoke('video:fullscreen'),
  openWeb: (payload) => ipcRenderer.invoke('video:openWeb', payload),
  close: () => ipcRenderer.invoke('video:close'),
  onLoad: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('video:load', handler);
    return () => ipcRenderer.removeListener('video:load', handler);
  },
});
