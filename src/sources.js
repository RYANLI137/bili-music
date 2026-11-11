'use strict';

/**
 * MusicFree 兼容音源插件宿主（自研实现，协议对齐公开文档，不复制其代码）
 * 文档：https://musicfree.catcat.work/plugin/protocol.html
 * 桌面版参考：https://github.com/maotoumao/MusicFreeDesktop
 *
 * 插件示例：
 * module.exports = {
 *   platform: '示例音源',
 *   version: '0.0.1',
 *   author: 'you',
 *   supportedSearchType: ['music'],
 *   async search(query, page, type) {
 *     return { isEnd: true, data: [{ id: '1', title: '歌名', artist: '歌手', duration: 180, artwork: '' }] };
 *   },
 *   async getMediaSource(musicItem, quality) {
 *     return { url: 'https://.../a.mp3', headers: { Referer: 'https://...' } };
 *   },
 *   async getLyric(musicItem) {
 *     return { rawLrc: '[00:00.00]歌词' };
 *   },
 * };
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sourcesDir(userData) {
  return ensureDir(path.join(userData, 'sources'));
}

function safeFileName(name) {
  return String(name || 'source')
    .replace(/[^\w\u4e00-\u9fff.-]+/g, '_')
    .slice(0, 80);
}

function loadModule(filePath) {
  try {
    delete require.cache[require.resolve(filePath)];
  } catch (_) {}
  return require(filePath);
}

function normalizePlugin(mod, filePath) {
  if (!mod || typeof mod !== 'object') throw new Error('插件需导出对象');
  const platform = String(mod.platform || '').trim();
  if (!platform || platform === '本地') throw new Error('无效的 platform 名称');
  const id = safeFileName(platform);
  return {
    id,
    file: path.basename(filePath),
    path: filePath,
    platform,
    version: String(mod.version || ''),
    author: String(mod.author || ''),
    srcUrl: mod.srcUrl || '',
    supportedSearchType: Array.isArray(mod.supportedSearchType) ? mod.supportedSearchType : ['music'],
    cacheControl: mod.cacheControl || 'no-cache',
    hasSearch: typeof mod.search === 'function',
    hasMedia: typeof mod.getMediaSource === 'function',
    hasLyric: typeof mod.getLyric === 'function',
    _mod: mod,
  };
}

function list(userData, enabledMap = {}) {
  const dir = sourcesDir(userData);
  const files = fs.readdirSync(dir).filter((f) => /\.js$/i.test(f));
  return files.map((f) => {
    const full = path.join(dir, f);
    try {
      const p = normalizePlugin(loadModule(full), full);
      const on = enabledMap[p.id] !== false;
      const meta = { ...p, enabled: on && p.hasSearch, error: '' };
      delete meta._mod;
      return meta;
    } catch (e) {
      const id = f.replace(/\.js$/i, '');
      return {
        id,
        file: f,
        path: full,
        platform: id,
        version: '',
        author: '',
        enabled: false,
        error: String(e?.message || e),
        hasSearch: false,
        hasMedia: false,
        hasLyric: false,
      };
    }
  });
}

function loadEnabled(userData, enabledMap = {}) {
  const dir = sourcesDir(userData);
  const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => /\.js$/i.test(x))) {
    const full = path.join(dir, f);
    try {
      const p = normalizePlugin(loadModule(full), full);
      if (enabledMap[p.id] === false) continue;
      if (!p.hasSearch && !p.hasMedia) continue;
      out.push(p);
    } catch (e) {
      logger.warn('source plugin load fail', f, e?.message || e);
    }
  }
  return out;
}

function mapMusicItem(item, platform) {
  const id = String(item.id ?? item.songmid ?? item.rid ?? '');
  const title = String(item.title || item.name || '未知歌曲');
  const artist = String(item.artist || item.singer || '');
  const album = String(item.album || '');
  const cover = item.artwork || item.cover || item.pic || '';
  const duration = Number(item.duration) || 0;
  return {
    id: `src_${safeFileName(platform)}_${id}`,
    sourceId: id,
    platform,
    title,
    artist,
    album,
    cover,
    duration,
    // 播放器识别为插件曲
    kind: 'plugin',
    url: item.url || '',
    lrc: item.lrc || '',
    rawLrc: item.rawLrc || '',
    _raw: item,
  };
}

async function searchAll(loaded, query, page = 1, type = 'music') {
  const q = String(query || '').trim();
  if (!q) return [];
  const jobs = loaded.filter((p) => p.hasSearch && (!p.supportedSearchType || p.supportedSearchType.includes(type)));
  const bags = await Promise.all(
    jobs.map(async (p) => {
      try {
        const r = await p._mod.search(q, page, type);
        const data = Array.isArray(r?.data) ? r.data : [];
        return {
          platform: p.platform,
          isEnd: r?.isEnd !== false,
          list: type === 'music' ? data.map((x) => mapMusicItem(x, p.platform)) : data,
        };
      } catch (e) {
        logger.warn('source search fail', p.platform, e?.message || e);
        return { platform: p.platform, isEnd: true, list: [], error: String(e?.message || e) };
      }
    }),
  );
  return bags;
}

async function getMedia(loaded, track, quality = 'standard') {
  if (!track) throw new Error('无曲目');
  if (track.url && !track.platform) return { url: track.url };
  const p = loaded.find((x) => x.platform === track.platform);
  if (!p) throw new Error(`未找到音源插件：${track.platform || '?'}`);
  if (typeof p._mod.getMediaSource === 'function') {
    const media = track._raw || {
      id: track.sourceId,
      title: track.title,
      artist: track.artist,
      album: track.album,
      artwork: track.cover,
      duration: track.duration,
      platform: track.platform,
    };
    const r = await p._mod.getMediaSource(media, quality);
    if (!r?.url) throw new Error('插件未返回播放地址');
    return { url: r.url, headers: r.headers || {}, userAgent: r.userAgent || '' };
  }
  if (track.url) return { url: track.url };
  throw new Error('该插件不支持播放');
}

async function getLyric(loaded, track) {
  const p = loaded.find((x) => x.platform === track.platform);
  if (!p || typeof p._mod.getLyric !== 'function') return null;
  const media = track._raw || { id: track.sourceId, title: track.title, artist: track.artist, platform: track.platform };
  return p._mod.getLyric(media);
}

function addFromPath(userData, srcPath) {
  if (!srcPath || !/\.js$/i.test(srcPath)) throw new Error('请选择 .js 插件文件');
  if (!fs.existsSync(srcPath)) throw new Error('文件不存在');
  const mod = loadModule(srcPath);
  const meta = normalizePlugin(mod, srcPath);
  const dest = path.join(sourcesDir(userData), `${meta.id}.js`);
  fs.copyFileSync(srcPath, dest);
  // 再校验一次
  normalizePlugin(loadModule(dest), dest);
  return { id: meta.id, platform: meta.platform, version: meta.version, file: path.basename(dest) };
}

function remove(userData, id) {
  const dir = sourcesDir(userData);
  const target = path.join(dir, `${safeFileName(id)}.js`);
  if (fs.existsSync(target)) {
    fs.unlinkSync(target);
    return true;
  }
  const hit = fs.readdirSync(dir).find((f) => f.replace(/\.js$/i, '') === id);
  if (!hit) throw new Error('音源不存在');
  fs.unlinkSync(path.join(dir, hit));
  return true;
}

function writeExample(userData) {
  const dir = sourcesDir(userData);
  const file = path.join(dir, 'example-source.js');
  if (fs.existsSync(file)) return file;
  fs.writeFileSync(
    file,
    `/**
 * Bili Music · MusicFree 兼容音源示例（演示用，返回静音测试音频）
 * 协议参考：https://musicfree.catcat.work/plugin/protocol.html
 * 可安装社区 MusicFree 插件（需自行鉴别安全性）。
 */
module.exports = {
  platform: '示例音源',
  version: '0.1.0',
  author: 'Bili Music',
  supportedSearchType: ['music'],
  async search(query, page) {
    if (page > 1) return { isEnd: true, data: [] };
    return {
      isEnd: true,
      data: [
        {
          id: 'demo-1',
          title: query ? \`示例 · \${query}\` : '示例歌曲',
          artist: 'Demo Artist',
          album: 'Demo Album',
          duration: 12,
          artwork: '',
        },
      ],
    };
  },
  async getMediaSource() {
    // 公开测试音（约 12s）
    return {
      url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
      headers: {},
    };
  },
  async getLyric() {
    return { rawLrc: '[00:00.00]这是示例音源歌词\\n[00:05.00]请替换为真实插件' };
  },
};
`,
    'utf8',
  );
  return file;
}

module.exports = {
  sourcesDir,
  list,
  loadEnabled,
  searchAll,
  getMedia,
  getLyric,
  addFromPath,
  remove,
  writeExample,
  mapMusicItem,
};
