const { app, BrowserWindow, ipcMain, session, shell, nativeTheme, screen, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const bili = require('./src/bili');
const lyrics = require('./src/lyrics');
const versions = require('./src/versions');
const Store = require('./src/store');
const veloura = require('./src/veloura');
const shortcuts = require('./src/shortcuts');
const plugins = require('./src/plugins');
const sources = require('./src/sources');
const logger = require('./src/logger');
const download = require('./src/download');
const updater = require('./src/updater');

let win;
let store;
let pluginRuntime = [];
let sourceRuntime = [];
/** 插件音源播放时临时注入的请求头（按完整 URL） */
const mediaHeaderMap = new Map();
let thumbarPlaying = false;

// 尽早落盘，启动失败也能留下痕迹
try {
  logger.init(app.getPath('userData'));
  logger.info('Bili Music starting', { version: app.getVersion?.() || 'dev', packaged: app.isPackaged });
} catch (e) {
  try {
    console.error('logger init failed', e);
  } catch (_) {}
}

function sendMedia(cmd, payload) {
  if (win && !win.isDestroyed()) win.webContents.send('media:cmd', cmd, payload);
  plugins.emit(pluginRuntime, 'onCommand', cmd, payload);
}

function thumbarIcon(name) {
  const p = path.join(__dirname, 'build', 'thumbar', `${name}.png`);
  return nativeImage.createFromPath(p);
}

function updateThumbar(playing = thumbarPlaying) {
  thumbarPlaying = !!playing;
  if (!win || win.isDestroyed() || process.platform !== 'win32') return;
  try {
    win.setThumbarButtons([
      {
        tooltip: '上一首',
        icon: thumbarIcon('prev'),
        click: () => sendMedia('prev'),
      },
      {
        tooltip: thumbarPlaying ? '暂停' : '播放',
        icon: thumbarIcon(thumbarPlaying ? 'pause' : 'play'),
        click: () => sendMedia('toggle'),
      },
      {
        tooltip: '下一首',
        icon: thumbarIcon('next'),
        click: () => sendMedia('next'),
      },
    ]);
  } catch (_) {}
}

function reloadPlugins() {
  const data = store?.get() || {};
  const enabledMap = data.settings?.pluginsEnabled || {};
  pluginRuntime = plugins.loadEnabled(app.getPath('userData'), enabledMap);
}

function reloadSources() {
  const data = store?.get() || {};
  const enabledMap = data.settings?.sourcesEnabled || {};
  sourceRuntime = sources.loadEnabled(app.getPath('userData'), enabledMap);
}

function rememberMediaHeaders(url, headers = {}, userAgent = '') {
  if (!url) return;
  const h = { ...(headers || {}) };
  if (userAgent) h['User-Agent'] = userAgent;
  if (Object.keys(h).length) mediaHeaderMap.set(url, h);
  // 防止无限膨胀
  if (mediaHeaderMap.size > 40) {
    const first = mediaHeaderMap.keys().next().value;
    mediaHeaderMap.delete(first);
  }
}

function applyShortcutsFromStore() {
  const data = store?.get() || {};
  data.settings = data.settings || {};
  const cfg = shortcuts.normalize(data.settings.shortcuts || {});
  // 写回迁移后的默认（如 F5 → Space），避免设置页仍显示旧键
  data.settings.shortcuts = cfg;
  try {
    store.set(data);
  } catch (_) {}
  shortcuts.setSender((action) => sendMedia(action));
  const result = shortcuts.apply(cfg);
  if (result.failed?.length) {
    logger.warn(
      '[shortcuts] register failed:',
      result.failed.map((f) => `${f.id}(${f.accel}): ${f.error}`).join('; '),
    );
  }
  return result;
}

function windowSize() {
  const wa = screen.getPrimaryDisplay().workAreaSize;
  return {
    width: Math.min(1440, Math.max(900, Math.round(wa.width * 0.82))),
    height: Math.min(920, Math.max(600, Math.round(wa.height * 0.86))),
    minWidth: Math.min(800, wa.width),
    minHeight: Math.min(560, wa.height),
  };
}

function createWindow() {
  const size = windowSize();
  win = new BrowserWindow({
    width: size.width,
    height: size.height,
    minWidth: size.minWidth,
    minHeight: size.minHeight,
    backgroundColor: '#ffffff',
    title: 'Bili Music',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#ffffff', symbolColor: '#555555', height: 51 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required',
      // 渐入渐出靠定时器调音量，最小化时也不能被节流
      backgroundThrottling: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  try {
    win.center();
  } catch (_) {}
  win.webContents.on('did-finish-load', () => {
    updateThumbar(thumbarPlaying);
    // 页面加载后再注册一次，避免启动过早导致全局快捷键失效
    applyShortcutsFromStore();
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    logger.error('render-process-gone', details);
  });
  win.webContents.on('unresponsive', () => logger.warn('window unresponsive'));
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    // 0=debug 1=info 2=warn 3=error — 只收 warn/error，避免刷爆
    if (level < 2) return;
    const tag = level >= 3 ? 'error' : 'warn';
    logger[tag](`[renderer] ${message} (${sourceId}:${line})`);
  });
  win.on('focus', () => applyShortcutsFromStore());
  setTimeout(() => updateThumbar(false), 400);
}

const LOGIN_PARTITION = 'persist:bililogin';
let loginWin = null;

async function openLogin() {
  if (loginWin) {
    loginWin.focus();
    return null;
  }
  const ses = session.fromPartition(LOGIN_PARTITION);
  await ses.clearStorageData();
  ses.setUserAgent(bili.UA);
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      ses.cookies.removeListener('changed', onCookie);
      if (loginWin && !loginWin.isDestroyed()) loginWin.close();
      loginWin = null;
      resolve(val);
    };
    const onCookie = async (_e, cookie, _cause, removed) => {
      if (removed || cookie.name !== 'SESSDATA' || !cookie.value) return;
      // 等其余 Cookie（bili_jct、DedeUserID 等）一起写入
      await new Promise((r) => setTimeout(r, 800));
      const list = await ses.cookies.get({ domain: 'bilibili.com' });
      finish(list.map((c) => `${c.name}=${c.value}`).join('; '));
    };
    ses.cookies.on('changed', onCookie);
    loginWin = new BrowserWindow({
      parent: win,
      modal: true,
      width: 1100,
      height: 720,
      title: '登录 B 站',
      icon: path.join(__dirname, 'build', 'icon.ico'),
      autoHideMenuBar: true,
      webPreferences: { partition: LOGIN_PARTITION },
    });
    loginWin.webContents.setWindowOpenHandler(({ url }) => {
      loginWin.loadURL(url);
      return { action: 'deny' };
    });
    loginWin.on('closed', () => finish(null));
    loginWin.loadURL('https://passport.bilibili.com/login');
  });
}

app.whenReady().then(() => {
  // Packaged builds never reuse a library dropped beside the exe
  if (app.isPackaged) {
    for (const leak of ['library.json', 'cookies.txt', '.env']) {
      const p = path.join(path.dirname(process.execPath), leak);
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch (_) {}
    }
  }

  nativeTheme.themeSource = 'light';
  store = new Store(app.getPath('userData'));
  bili.setUserCookie(store.get().settings.cookie);

  // B 站的音频 / 图片 CDN 需要 Referer，否则 403；插件音源也可注入自定义头
  session.defaultSession.webRequest.onBeforeSendHeaders((details, cb) => {
    let host = '';
    try {
      host = new URL(details.url).hostname;
    } catch (_) {}
    if (/(bilivideo\.(com|cn)|akamaized\.net|hdslb\.com|biliimg\.com)$/.test(host)) {
      details.requestHeaders.Referer = bili.REFERER;
      details.requestHeaders['User-Agent'] = bili.UA;
      delete details.requestHeaders.Origin;
    }
    const pluginHeaders = mediaHeaderMap.get(details.url);
    if (pluginHeaders) {
      for (const [k, v] of Object.entries(pluginHeaders)) {
        if (v != null && v !== '') details.requestHeaders[k] = String(v);
      }
      delete details.requestHeaders.Origin;
    }
    cb({ requestHeaders: details.requestHeaders });
  });
  // 允许页面用 canvas 读取封面像素来取主色
  session.defaultSession.webRequest.onHeadersReceived({ urls: ['https://*.hdslb.com/*'] }, (details, cb) => {
    const headers = details.responseHeaders || {};
    for (const k of Object.keys(headers)) if (k.toLowerCase() === 'access-control-allow-origin') delete headers[k];
    headers['Access-Control-Allow-Origin'] = ['*'];
    cb({ responseHeaders: headers });
  });

  ipcMain.handle('bili:search', (_e, opts) => bili.search(opts));
  ipcMain.handle('bili:info', (_e, bvid) => bili.videoInfo(bvid));
  ipcMain.handle('bili:audio', (_e, bvid, cid) => bili.audioUrl(bvid, cid));
  ipcMain.handle('bili:resolve', (_e, text) => bili.resolveLink(text));
  ipcMain.handle('bili:feed', (_e, page) => bili.musicFeed(page));
  ipcMain.handle('bili:related', (_e, bvid) => bili.related(bvid));
  ipcMain.handle('bili:ranking', () => bili.musicRanking());
  ipcMain.handle('bili:history', () => bili.musicHistory());
  ipcMain.handle('bili:me', () => bili.me());
  ipcMain.handle('bili:login', () => openLogin());
  ipcMain.handle('bili:logout', () => session.fromPartition(LOGIN_PARTITION).clearStorageData());
  ipcMain.handle('lyrics:find', (_e, track, pick) => lyrics.find(track, pick));
  ipcMain.handle('lyrics:search', (_e, q) => lyrics.search(q));
  ipcMain.handle('versions:find', (_e, track) => versions.findVersions(track));
  ipcMain.handle('bili:danmaku', (_e, cid) => bili.danmaku(cid));
  ipcMain.handle('win:overlay', (_e, color, symbolColor) => {
    if (win && process.platform === 'win32') win.setTitleBarOverlay({ color, symbolColor });
  });
  ipcMain.handle('store:get', () => store.get());
  ipcMain.handle('store:set', (_e, data) => {
    store.set(data);
    bili.setUserCookie(data?.settings?.cookie);
    return true;
  });

  const skinDir = () => app.getPath('userData');
  const skinPathOf = (name) => path.join(skinDir(), name);
  const wipeSkinFiles = () => {
    for (const name of fs.readdirSync(skinDir())) {
      if (/^skin-bg\./i.test(name)) {
        try {
          fs.unlinkSync(path.join(skinDir(), name));
        } catch (_) {}
      }
    }
  };
  ipcMain.handle('skin:save', (_e, payload) => {
    const raw = String(payload?.dataBase64 || '');
    const mime = String(payload?.mime || 'image/jpeg');
    if (!raw) throw new Error('没有图片数据');
    const buf = Buffer.from(raw, 'base64');
    if (buf.length < 64) throw new Error('图片无效');
    if (buf.length > 8 * 1024 * 1024) throw new Error('图片过大（最大 8MB）');
    const ext = /png/i.test(mime) ? 'png' : /webp/i.test(mime) ? 'webp' : /gif/i.test(mime) ? 'gif' : 'jpg';
    wipeSkinFiles();
    const file = `skin-bg.${ext}`;
    fs.writeFileSync(skinPathOf(file), buf);
    const data = store.get();
    data.settings = { ...(data.settings || {}), skinFile: file, skinEnabled: true };
    store.set(data);
    return { file, bytes: buf.length };
  });
  ipcMain.handle('skin:read', () => {
    const file = store.get()?.settings?.skinFile;
    if (!file) return null;
    const p = skinPathOf(file);
    if (!fs.existsSync(p)) return null;
    const buf = fs.readFileSync(p);
    const mime = /\.png$/i.test(file)
      ? 'image/png'
      : /\.webp$/i.test(file)
        ? 'image/webp'
        : /\.gif$/i.test(file)
          ? 'image/gif'
          : 'image/jpeg';
    return `data:${mime};base64,${buf.toString('base64')}`;
  });
  ipcMain.handle('skin:clear', () => {
    wipeSkinFiles();
    const data = store.get();
    if (data.settings) {
      delete data.settings.skinFile;
      data.settings.skinEnabled = false;
      store.set(data);
    }
    return true;
  });
  ipcMain.handle('shell:open', (_e, url) => {
    if (/^https:\/\//.test(url)) return shell.openExternal(url);
  });
  ipcMain.handle('thumbar:setPlaying', (_e, playing) => {
    updateThumbar(!!playing);
    plugins.emit(pluginRuntime, 'onPlayState', !!playing);
    return true;
  });
  ipcMain.handle('thumbar:setTitle', (_e, title) => {
    if (win && !win.isDestroyed() && title) win.setTitle(String(title));
    return true;
  });
  ipcMain.handle('plugins:notifyTrack', (_e, track) => {
    plugins.emit(pluginRuntime, 'onTrack', track || null);
    return true;
  });
  ipcMain.handle('shortcuts:get', () => {
    const cfg = shortcuts.normalize(store.get()?.settings?.shortcuts || {});
    return { config: cfg, actions: shortcuts.ACTIONS, defaults: shortcuts.DEFAULTS };
  });
  ipcMain.handle('shortcuts:apply', (_e, cfg) => {
    const data = store.get();
    data.settings = data.settings || {};
    data.settings.shortcuts = shortcuts.normalize(cfg || {});
    store.set(data);
    return applyShortcutsFromStore();
  });
  ipcMain.handle('plugins:list', () => {
    const enabledMap = store.get()?.settings?.pluginsEnabled || {};
    return {
      dir: plugins.pluginsDir(app.getPath('userData')),
      list: plugins.list(app.getPath('userData'), enabledMap),
    };
  });
  ipcMain.handle('plugins:add', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '添加脚本插件',
      filters: [{ name: 'JavaScript 插件', extensions: ['js'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths?.[0]) return null;
    const meta = plugins.addFromPath(app.getPath('userData'), r.filePaths[0]);
    const data = store.get();
    data.settings = data.settings || {};
    data.settings.pluginsEnabled = { ...(data.settings.pluginsEnabled || {}), [meta.id]: true };
    store.set(data);
    reloadPlugins();
    return meta;
  });
  ipcMain.handle('plugins:remove', (_e, id) => {
    plugins.remove(app.getPath('userData'), id);
    const data = store.get();
    if (data.settings?.pluginsEnabled) {
      delete data.settings.pluginsEnabled[id];
      store.set(data);
    }
    reloadPlugins();
    return true;
  });
  ipcMain.handle('plugins:setEnabled', (_e, id, enabled) => {
    const data = store.get();
    data.settings = data.settings || {};
    data.settings.pluginsEnabled = { ...(data.settings.pluginsEnabled || {}), [id]: !!enabled };
    store.set(data);
    reloadPlugins();
    return true;
  });
  ipcMain.handle('plugins:openDir', () => {
    plugins.writeExample(app.getPath('userData'));
    return shell.openPath(plugins.pluginsDir(app.getPath('userData')));
  });

  ipcMain.handle('sources:list', () => {
    const enabledMap = store.get()?.settings?.sourcesEnabled || {};
    return {
      dir: sources.sourcesDir(app.getPath('userData')),
      list: sources.list(app.getPath('userData'), enabledMap),
    };
  });
  ipcMain.handle('sources:add', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '添加 MusicFree 兼容音源插件',
      filters: [{ name: 'JavaScript', extensions: ['js'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths?.[0]) return null;
    const meta = sources.addFromPath(app.getPath('userData'), r.filePaths[0]);
    const data = store.get();
    data.settings = data.settings || {};
    data.settings.sourcesEnabled = { ...(data.settings.sourcesEnabled || {}), [meta.id]: true };
    store.set(data);
    reloadSources();
    return meta;
  });
  ipcMain.handle('sources:remove', (_e, id) => {
    sources.remove(app.getPath('userData'), id);
    const data = store.get();
    if (data.settings?.sourcesEnabled) {
      delete data.settings.sourcesEnabled[id];
      store.set(data);
    }
    reloadSources();
    return true;
  });
  ipcMain.handle('sources:setEnabled', (_e, id, enabled) => {
    const data = store.get();
    data.settings = data.settings || {};
    data.settings.sourcesEnabled = { ...(data.settings.sourcesEnabled || {}), [id]: !!enabled };
    store.set(data);
    reloadSources();
    return true;
  });
  ipcMain.handle('sources:openDir', () => {
    sources.writeExample(app.getPath('userData'));
    return shell.openPath(sources.sourcesDir(app.getPath('userData')));
  });
  ipcMain.handle('sources:search', async (_e, query, page = 1, type = 'music') => {
    reloadSources();
    return sources.searchAll(sourceRuntime, query, page, type);
  });
  ipcMain.handle('sources:media', async (_e, track, quality) => {
    reloadSources();
    const media = await sources.getMedia(sourceRuntime, track, quality || 'standard');
    rememberMediaHeaders(media.url, media.headers, media.userAgent);
    return media;
  });
  ipcMain.handle('sources:lyric', async (_e, track) => {
    reloadSources();
    const raw = await sources.getLyric(sourceRuntime, track);
    if (!raw) return null;
    const text = raw.rawLrc || raw.lrc || '';
    const lines = [];
    for (const line of String(text).split(/\r?\n/)) {
      const stamps = [...line.matchAll(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)];
      if (!stamps.length) continue;
      const content = line.replace(/\[[^\]]*\]/g, '').trim();
      for (const m of stamps) {
        const frac = m[3] ? Number(m[3]) / 10 ** m[3].length : 0;
        const t = Math.round((Number(m[1]) * 60 + Number(m[2]) + frac) * 100) / 100;
        lines.push({ t, text: content });
      }
    }
    lines.sort((a, b) => a.t - b.t);
    return {
      lines,
      plain: lines.length ? '' : String(raw.rawLrc || raw.lrc || raw.translation || ''),
      match: { source: 'plugin', id: track?.platform || 'source', name: track?.title || '', artists: [track?.artist || track?.platform || '插件'] },
    };
  });

  ipcMain.handle('log:write', (_e, level, message) => {
    const fn = logger[level] || logger.info;
    fn(String(message || ''));
    return true;
  });
  ipcMain.handle('log:paths', () => logger.getPaths());
  ipcMain.handle('log:openDir', () => {
    const { dir } = logger.getPaths();
    return shell.openPath(dir || app.getPath('userData'));
  });
  ipcMain.handle('log:clear', () => logger.clear());
  ipcMain.handle('download:save', async (e, payload) => {
    const kind = payload?.kind === 'video' ? 'video' : 'audio';
    const track = payload?.track || {};
    if (!track.bvid) throw new Error('缺少视频信息');
    const dest = await download.pickSavePath(win, { title: track.title || track.bvid, kind });
    if (!dest) return { ok: false, canceled: true };
    const sendProg = (stage) => {
      try {
        e.sender.send('download:progress', { stage, kind, title: track.title });
      } catch (_) {}
    };
    try {
      sendProg('start');
      logger.info('download', kind, track.bvid, dest);
      if (kind === 'video') await download.downloadVideo({ bvid: track.bvid, cid: track.cid, dest }, sendProg);
      else await download.downloadAudio({ bvid: track.bvid, cid: track.cid, dest }, sendProg);
      sendProg('done');
      return { ok: true, path: dest, kind };
    } catch (err) {
      logger.error('download failed', err);
      throw new Error(err?.message || String(err));
    }
  });
  ipcMain.handle('video:open', (_e, payload) => {
    const t = payload || {};
    return download.openVideoWindow(win, {
      bvid: t.bvid,
      cid: t.cid,
      page: t.page || 1,
      title: t.title || '',
    });
  });
  ipcMain.handle('video:enlarge', () => {
    const { BrowserWindow } = require('electron');
    const w = BrowserWindow.getFocusedWindow();
    if (!w) return false;
    const [cw, ch] = w.getSize();
    w.setSize(Math.min(1200, Math.round(cw * 1.35)), Math.min(800, Math.round(ch * 1.35)));
    w.center();
    return true;
  });
  ipcMain.handle('video:fullscreen', () => {
    const { BrowserWindow } = require('electron');
    const w = BrowserWindow.getFocusedWindow();
    if (!w) return false;
    w.setFullScreen(!w.isFullScreen());
    return w.isFullScreen();
  });
  ipcMain.handle('video:openWeb', (_e, payload) => {
    const bvid = payload?.bvid;
    if (!bvid) return false;
    const page = Number(payload?.page) || 1;
    return shell.openExternal(`https://www.bilibili.com/video/${bvid}${page > 1 ? `?p=${page}` : ''}`);
  });
  ipcMain.handle('video:close', () => {
    const { BrowserWindow } = require('electron');
    const w = BrowserWindow.getFocusedWindow();
    if (w && w !== win) w.close();
    return true;
  });
  ipcMain.handle('veloura:status', () => veloura.status(true));
  ipcMain.handle('veloura:plan', async (_e, payload) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-veloura-'));
    const cleanup = [];
    const headers = { Referer: bili.REFERER, 'User-Agent': bili.UA };
    try {
      const cur = { ...(payload?.current || {}) };
      const nxt = { ...(payload?.next || {}) };
      const wantAutomix = payload?.mode !== 'slm';
      const stage = async (side, meta, isOutro) => {
        if (meta.path && fs.existsSync(meta.path)) return meta;
        const url = meta.url || meta.source;
        if (!url || !wantAutomix) return meta;
        const dest = path.join(tmp, `${side}.m4a`);
        cleanup.push(dest);
        const dur = Number(meta.duration) || 0;
        const win = 36;
        const start = isOutro && dur > win + 2 ? Math.max(0, dur - win) : 0;
        try {
          await veloura.extractWindow(url, dest, { start, duration: win, headers });
          return { ...meta, path: dest, url: undefined, source: undefined };
        } catch (_) {
          return meta;
        }
      };
      const current = await stage('current', cur, true);
      const next = await stage('next', nxt, false);
      let result = null;
      if (current.path && next.path && wantAutomix) {
        result = await veloura.planTransition({
          current,
          next,
          preset: payload?.preset || 'automix',
          mode: 'automix',
          timeoutMs: payload?.timeoutMs || 55000,
        });
      }
      if (!result?.ok) {
        result = await veloura.planTransition({
          current: {
            title: current.title || cur.title || 'A',
            duration: current.duration || cur.duration || 180,
            artist: current.artist || cur.artist,
          },
          next: {
            title: next.title || nxt.title || 'B',
            duration: next.duration || nxt.duration || 180,
            artist: next.artist || nxt.artist,
          },
          preset: payload?.preset || 'automix',
          mode: 'slm',
          timeoutMs: 20000,
        });
      }
      return result;
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    } finally {
      try {
        for (const f of cleanup) fs.unlinkSync(f);
        fs.rmdirSync(tmp, { recursive: true });
      } catch (_) {}
    }
  });

  plugins.writeExample(app.getPath('userData'));
  sources.writeExample(app.getPath('userData'));
  {
    const data = store.get();
    data.settings = data.settings || {};
    const se = { ...(data.settings.sourcesEnabled || {}) };
    // 示例音源默认关闭，避免每次搜索都混入演示结果
    if (se['示例音源'] === undefined) se['示例音源'] = false;
    data.settings.sourcesEnabled = se;
    store.set(data);
  }
  reloadPlugins();
  reloadSources();
  createWindow();
  applyShortcutsFromStore();
  updater.init(win);

  ipcMain.handle('update:status', () => updater.getStatus());
  ipcMain.handle('update:check', () => updater.check(true));
  ipcMain.handle('update:install', () => updater.quitAndInstall());
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('app:openReleases', () => shell.openExternal('https://github.com/RYANLI137/bili-music/releases'));

  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('will-quit', () => {
  shortcuts.unregisterAll();
});
app.on('before-quit', () => store && store.flush());
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
