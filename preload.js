const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  search: (opts) => ipcRenderer.invoke('bili:search', opts),
  info: (bvid) => ipcRenderer.invoke('bili:info', bvid),
  audio: (bvid, cid) => ipcRenderer.invoke('bili:audio', bvid, cid),
  resolve: (text) => ipcRenderer.invoke('bili:resolve', text),
  feed: (page) => ipcRenderer.invoke('bili:feed', page),
  related: (bvid) => ipcRenderer.invoke('bili:related', bvid),
  ranking: () => ipcRenderer.invoke('bili:ranking'),
  history: () => ipcRenderer.invoke('bili:history'),
  me: () => ipcRenderer.invoke('bili:me'),
  login: () => ipcRenderer.invoke('bili:login'),
  logout: () => ipcRenderer.invoke('bili:logout'),
  findLyrics: (track, pick) => ipcRenderer.invoke('lyrics:find', track, pick),
  searchLyrics: (q) => ipcRenderer.invoke('lyrics:search', q),
  findVersions: (track) => ipcRenderer.invoke('versions:find', track),
  danmaku: (cid) => ipcRenderer.invoke('bili:danmaku', cid),
  overlay: (color, symbolColor) => ipcRenderer.invoke('win:overlay', color, symbolColor),
  load: () => ipcRenderer.invoke('store:get'),
  save: (data) => ipcRenderer.invoke('store:set', data),
  open: (url) => ipcRenderer.invoke('shell:open', url),
  velouraStatus: () => ipcRenderer.invoke('veloura:status'),
  velouraPlan: (payload) => ipcRenderer.invoke('veloura:plan', payload),
  skinSave: (payload) => ipcRenderer.invoke('skin:save', payload),
  skinRead: () => ipcRenderer.invoke('skin:read'),
  skinClear: () => ipcRenderer.invoke('skin:clear'),
  setThumbarPlaying: (playing) => ipcRenderer.invoke('thumbar:setPlaying', playing),
  setWindowTitle: (title) => ipcRenderer.invoke('thumbar:setTitle', title),
  notifyPluginTrack: (track) => ipcRenderer.invoke('plugins:notifyTrack', track),
  getShortcuts: () => ipcRenderer.invoke('shortcuts:get'),
  applyShortcuts: (cfg) => ipcRenderer.invoke('shortcuts:apply', cfg),
  listPlugins: () => ipcRenderer.invoke('plugins:list'),
  addPlugin: () => ipcRenderer.invoke('plugins:add'),
  removePlugin: (id) => ipcRenderer.invoke('plugins:remove', id),
  setPluginEnabled: (id, enabled) => ipcRenderer.invoke('plugins:setEnabled', id, enabled),
  openPluginsDir: () => ipcRenderer.invoke('plugins:openDir'),
  listSources: () => ipcRenderer.invoke('sources:list'),
  addSource: () => ipcRenderer.invoke('sources:add'),
  removeSource: (id) => ipcRenderer.invoke('sources:remove', id),
  setSourceEnabled: (id, enabled) => ipcRenderer.invoke('sources:setEnabled', id, enabled),
  openSourcesDir: () => ipcRenderer.invoke('sources:openDir'),
  sourceSearch: (query, page, type) => ipcRenderer.invoke('sources:search', query, page, type),
  sourceMedia: (track, quality) => ipcRenderer.invoke('sources:media', track, quality),
  sourceLyric: (track) => ipcRenderer.invoke('sources:lyric', track),
  logWrite: (level, message) => ipcRenderer.invoke('log:write', level, message),
  logPaths: () => ipcRenderer.invoke('log:paths'),
  openLogDir: () => ipcRenderer.invoke('log:openDir'),
  clearLogs: () => ipcRenderer.invoke('log:clear'),
  downloadTrack: (payload) => ipcRenderer.invoke('download:save', payload),
  openVideo: (payload) => ipcRenderer.invoke('video:open', payload),
  onDownloadProgress: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('download:progress', handler);
    return () => ipcRenderer.removeListener('download:progress', handler);
  },
  onMediaCmd: (cb) => {
    const handler = (_e, cmd, payload) => cb(cmd, payload);
    ipcRenderer.on('media:cmd', handler);
    return () => ipcRenderer.removeListener('media:cmd', handler);
  },
  appVersion: () => ipcRenderer.invoke('app:version'),
  updateStatus: () => ipcRenderer.invoke('update:status'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  openReleases: () => ipcRenderer.invoke('app:openReleases'),
  onUpdateStatus: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('update:status', handler);
    return () => ipcRenderer.removeListener('update:status', handler);
  },
  platform: process.platform,
});
