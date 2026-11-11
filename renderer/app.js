'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const decks = [$('#audio'), $('#audio2')];
let audio = decks[0];
const content = $('#content');

/** 前端错误写入主进程日志文件（已有 console-message 兜底，这里补 stack） */
function appLog(level, ...args) {
  const msg = args
    .map((a) => {
      if (a instanceof Error) return a.stack || a.message;
      if (typeof a === 'string') return a;
      try {
        return JSON.stringify(a);
      } catch (_) {
        return String(a);
      }
    })
    .join(' ');
  api.logWrite?.(level, msg).catch?.(() => {});
}
window.addEventListener('error', (e) => appLog('error', 'window.error', e.error?.stack || e.message));
window.addEventListener('unhandledrejection', (e) => appLog('error', 'unhandledrejection', e.reason?.stack || e.reason));

/* ================= utils ================= */
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pad = (n) => String(n).padStart(2, '0');
function fmtTime(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(sec % 60)}` : `${m}:${pad(sec % 60)}`;
}
function fmtTotal(sec) {
  const m = Math.round(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分钟` : `${m} 分钟`;
}
function fmtCount(n) {
  n = Number(n) || 0;
  if (n >= 1e8) return (n / 1e8).toFixed(1) + '亿';
  if (n >= 1e4) return (n / 1e4).toFixed(1) + '万';
  return String(n);
}
function fmtDate(ts) {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const thumb = (url, w, h = w) => (url ? `${url}@${w}w_${h}h_1c.webp` : '');
const coverSrc = (url, w, h = w) => {
  if (!url) return '';
  if (/hdslb\.com|biliimg\.com/i.test(url)) return thumb(url, w, h);
  return url;
};
const errMsg = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const isPluginTrack = (t) => !!(t && (t.kind === 'plugin' || t.platform) && !t.bvid);
const trackUrl = (t) => {
  if (isPluginTrack(t)) return '';
  return `https://www.bilibili.com/video/${t.bvid}${t.page > 1 ? `?p=${t.page}` : ''}`;
};

async function ensureTrackCid(t) {
  if (isPluginTrack(t)) return t;
  if (!t?.bvid) throw new Error('缺少视频信息');
  if (t.cid) return t;
  const info = await getInfo(t.bvid);
  const page = t.page ? info.pages.find((p) => p.page === t.page) : info.pages[0];
  if (!page) throw new Error('找不到分 P');
  return { ...t, cid: page.cid, page: page.page, duration: t.duration || page.duration };
}

async function openOriginalVideo(track) {
  try {
    const cur = track || current();
    if (isPluginTrack(cur)) return toast('插件音源没有原视频', 'error');
    const t = await ensureTrackCid(cur);
    await api.openVideo({ bvid: t.bvid, cid: t.cid, page: t.page || 1, title: t.title || '' });
  } catch (e) {
    toast(errMsg(e), 'error');
  }
}

async function downloadTrack(track, kind = 'audio') {
  try {
    const cur = track || current();
    if (isPluginTrack(cur)) return toast('插件音源暂不支持站内下载', 'error');
    const t = await ensureTrackCid(cur);
    toast(kind === 'video' ? '正在准备下载原视频…' : '正在准备下载音频…');
    const r = await api.downloadTrack({ kind, track: { bvid: t.bvid, cid: t.cid, title: t.title, page: t.page } });
    if (r?.canceled) return;
    if (r?.ok) toast(`已保存到 ${r.path}`);
  } catch (e) {
    toast(`下载失败：${errMsg(e)}`, 'error');
  }
}

api.onDownloadProgress?.((p) => {
  if (p?.stage === 'start') toast(p.kind === 'video' ? '开始下载原视频…' : '开始下载音频…');
  if (p?.stage === 'done') toast('下载完成');
});
const eqHtml = () => '<span class="eq"><i></i><i></i><i></i></span>';

function hashStr(str) {
  let h = 0;
  for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h);
}
function gradient(id) {
  const h = hashStr(id) % 360;
  return `linear-gradient(150deg, hsl(${h} 85% 84%) 0%, hsl(${(h + 35) % 360} 80% 62%) 50%, hsl(${(h + 70) % 360} 75% 28%) 100%)`;
}

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast-item ${type}`;
  el.textContent = msg;
  $('#toast').appendChild(el);
  setTimeout(() => el.remove(), type === 'error' ? 4000 : 2200);
}

/* ================= state ================= */
let lib = null;
let view = { type: 'home' };
let table = { tracks: [], ctx: null, selected: new Set(), anchor: -1 };
let dragState = null;
const infoCache = new Map();

const MODES = [
  { id: 'all', label: '全部', suffix: '' },
  { id: 'live', label: 'Live 现场', suffix: 'live', icon: 'live' },
  { id: 'concert', label: '演唱会', suffix: '演唱会' },
  { id: 'mv', label: 'MV', suffix: 'MV' },
  { id: 'cover', label: '翻唱', suffix: '翻唱' },
  { id: 'inst', label: '伴奏 / 纯音乐', suffix: '纯音乐' },
];
const ORDERS = [
  { id: 'totalrank', label: '综合' },
  { id: 'click', label: '最多播放' },
  { id: 'pubdate', label: '最新发布' },
  { id: 'stow', label: '最多收藏' },
];
const search = {
  keyword: '',
  mode: 'all',
  order: 'totalrank',
  music: false,
  /** bili | plugins | all */
  scope: 'all',
  page: 1,
  numPages: 0,
  list: [],
  loading: false,
  error: '',
  token: 0,
  done: false,
};

function save() {
  api.save(lib);
}

/* ================= library ================= */
const getPl = (id) => lib.playlists.find((p) => p.id === id);
const isFav = (id) => lib.favorites.some((t) => t.id === id);

function allTracks() {
  const map = new Map();
  for (const p of lib.playlists)
    for (const t of p.tracks) {
      const e = map.get(t.id);
      if (!e || t.addedAt > e.addedAt) map.set(t.id, t);
    }
  return [...map.values()];
}

function createPlaylist(name, desc = '') {
  const pl = { id: uid(), name, desc, tracks: [], createdAt: Date.now() };
  lib.playlists.push(pl);
  save();
  renderNav();
  return pl;
}

function addToPlaylist(pl, tracks) {
  if (tracks.some((t) => t.lazy)) {
    resolveLazy(tracks).then((list) => list.length && addToPlaylist(pl, list));
    return;
  }
  const ids = new Set(pl.tracks.map((t) => t.id));
  const fresh = [];
  for (const t of tracks) {
    if (ids.has(t.id)) continue;
    ids.add(t.id);
    fresh.push({ ...t, addedAt: Date.now() });
  }
  pl.tracks.push(...fresh);
  save();
  renderNav();
  if ((view.type === 'playlist' && view.id === pl.id) || view.type === 'recent' || view.type === 'songs') renderView();
  toast(fresh.length ? `已添加 ${fresh.length} 首到「${pl.name}」` : `歌曲已在「${pl.name}」中`);
}

function removeFromPlaylist(plId, tracks) {
  const pl = getPl(plId);
  if (!pl) return;
  const ids = new Set(tracks.map((t) => t.id));
  pl.tracks = pl.tracks.filter((t) => !ids.has(t.id));
  save();
  renderNav();
  renderView();
}

function toggleFav(tracks) {
  if (tracks.some((t) => t.lazy)) {
    resolveLazy(tracks).then((list) => list.length && toggleFav(list));
    return;
  }
  const allFav = tracks.every((t) => isFav(t.id));
  if (allFav) {
    const ids = new Set(tracks.map((t) => t.id));
    lib.favorites = lib.favorites.filter((f) => !ids.has(f.id));
  } else {
    for (const t of tracks) if (!isFav(t.id)) lib.favorites.unshift({ ...t, addedAt: Date.now() });
  }
  save();
  renderView();
  updateNowPlaying();
}

function updateTrackEverywhere(id, patch) {
  const lists = [...lib.playlists.map((p) => p.tracks), lib.favorites, lib.history, player.queue];
  for (const list of lists) for (const t of list) if (t.id === id) Object.assign(t, patch);
  save();
  renderView();
  updateNowPlaying();
  renderQueue();
}

function deletePlaylist(pl) {
  openModal({
    title: '删除歌单',
    body: `<p>确定要删除「${esc(pl.name)}」吗？歌单中的 ${pl.tracks.length} 首歌曲记录会一起删除。</p>`,
    okText: '删除',
  }).then((ok) => {
    if (!ok) return;
    lib.playlists = lib.playlists.filter((p) => p !== pl);
    save();
    if (view.type === 'playlist' && view.id === pl.id) navigate({ type: 'home' });
    else {
      renderNav();
      renderView();
    }
  });
}

function addHistory(t) {
  if (!t?.id) return;
  lib.playCounts ||= {};
  lib.playCounts[t.id] = (lib.playCounts[t.id] || 0) + 1;
  const { lazyId, ...plain } = t;
  // 最新播放置顶；同曲去重后保留最近一次
  lib.history = [{ ...plain, playedAt: Date.now() }, ...(lib.history || []).filter((x) => x.id !== t.id)].slice(0, 200);
  save();
  if (view.type === 'home' || view.type === 'recent' || view.type === 'history') renderView(true);
}

/** 播放历史：只含真正播过的，最新在前 */
function historyTracks() {
  const list = lib.history || [];
  return list
    .map((t, i) => ({ t, i }))
    .sort((a, b) => (b.t.playedAt || 0) - (a.t.playedAt || 0) || a.i - b.i)
    .map((x) => x.t);
}

/* ================= bilibili → tracks ================= */
function getInfo(bvid) {
  if (!infoCache.has(bvid)) {
    if (infoCache.size > 48) {
      const first = infoCache.keys().next().value;
      if (first) infoCache.delete(first);
    }
    infoCache.set(
      bvid,
      api.info(bvid).catch((e) => {
        infoCache.delete(bvid);
        throw e;
      }),
    );
  }
  return infoCache.get(bvid);
}

function makeTrack(info, page) {
  const multi = info.pages.length > 1;
  return {
    id: `${info.bvid}_${page.cid}`,
    bvid: info.bvid,
    cid: page.cid,
    page: page.page,
    title: multi ? page.part || `P${page.page}` : info.title,
    artist: info.author,
    album: multi ? info.title : '',
    cover: info.cover,
    duration: page.duration || info.duration,
    addedAt: Date.now(),
  };
}

/** mode: 'pick' 多 P 时弹窗选择；'all' 全部分 P */
async function resolveTracks(bvid, { mode = 'pick', page = null, cid = null } = {}) {
  const info = await getInfo(bvid);
  if (cid) {
    const p = info.pages.find((x) => x.cid === cid);
    if (p) return [makeTrack(info, p)];
  }
  if (page) {
    const p = info.pages.find((x) => x.page === page);
    if (p) return [makeTrack(info, p)];
  }
  if (info.pages.length === 1 || mode === 'all') return info.pages.map((p) => makeTrack(info, p));
  const picked = await pickPages(info);
  return picked.map((p) => makeTrack(info, p));
}

/* ================= player ================= */
const player = {
  queue: [],
  index: -1,
  original: null,
  shuffle: false,
  repeat: 'off',
  urls: [],
  urlIdx: 0,
  token: 0,
  fails: 0,
  retried: false,
  pendingSeek: 0,
  needsLoad: false,
  resumeAt: 0,
  cache: new Map(),
};
const current = () => player.queue[player.index];

function playList(tracks, start = 0, { shuffle = false } = {}) {
  if (!tracks.length) return;
  player.queue = tracks.map((t) => ({ ...t }));
  player.index = Math.min(Math.max(start, 0), tracks.length - 1);
  player.original = null;
  if (shuffle) player.shuffle = true;
  if (player.shuffle) shuffleQueue();
  if (view.type === 'playlist' && view.id) touchRecentPlaylist(view.id);
  else if (table.ctx?.playlistId) touchRecentPlaylist(table.ctx.playlistId);
  updateControls();
  loadCurrent(true);
}

function touchRecentPlaylist(plId) {
  if (!plId || !getPl(plId)) return;
  lib.recentPlaylists = [plId, ...(lib.recentPlaylists || []).filter((id) => id !== plId)].slice(0, 24);
  save();
}

function shuffleQueue() {
  const cur = current();
  const rest = player.queue.filter((_, i) => i !== player.index);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  if (!player.original) player.original = player.queue.slice();
  player.queue = cur ? [cur, ...rest] : rest;
  player.index = cur ? 0 : -1;
}

/** 列表循环到头时重新打乱，刚听完的放到队尾，避免马上再播 */
function reshuffleCycle() {
  if (player.queue.length <= 1) {
    player.index = 0;
    return;
  }
  const cur = current();
  const rest = player.queue.filter((_, i) => i !== player.index);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  if (!player.original) player.original = player.queue.slice();
  player.queue = cur ? [...rest, cur] : rest;
  player.index = 0;
}

function setShuffle(on) {
  player.shuffle = on;
  // 随机只影响顺序；单曲循环仍优先，不在这里关掉 repeat
  if (on) shuffleQueue();
  else if (player.original) {
    const cur = current();
    const inQueue = new Set(player.queue);
    const kept = player.original.filter((t) => inQueue.has(t));
    const extra = player.queue.filter((t) => !player.original.includes(t));
    player.queue = [...kept, ...extra];
    player.index = Math.max(0, player.queue.indexOf(cur));
    player.original = null;
  }
  updateControls();
  renderQueue();
  saveSession();
}

function insertNext(tracks) {
  const copies = tracks.map((t) => ({ ...t }));
  if (!player.queue.length) return playList(copies);
  player.queue.splice(player.index + 1, 0, ...copies);
  renderQueue();
  saveSession();
  toast(copies.length > 1 ? `${copies.length} 首歌将在下一首播放` : `「${copies[0].title}」将在下一首播放`);
}

function appendQueue(tracks) {
  const copies = tracks.map((t) => ({ ...t }));
  if (!player.queue.length) return playList(copies);
  player.queue.push(...copies);
  renderQueue();
  saveSession();
  toast(`已添加 ${copies.length} 首到待播清单`);
}

/* ================= decks: crossfade / gapless ================= */
// 两个 <audio> 轮流做「当前」和「准备中」，所有全局事件只认当前那个
let masterVol = 0.64;
decks.forEach((d) => {
  d._gain = 1;
  d._trackGain = 1;
});
const idleDeck = () => (audio === decks[0] ? decks[1] : decks[0]);

/** LiveSort / Apple Automix 风格：每轨 EQ + 简易混响总线 */
const deckNodes = new Map();
let deckImpulse = null;

function buildImpulseResponse(ctx, seconds = 2.0, decay = 2.0) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const progress = i / len;
      const seed = Math.sin((i + 1) * 12.9898 + (ch + 1) * 78.233) * 43758.5453;
      const noise = seed - Math.floor(seed);
      data[i] = (noise * 2 - 1) * Math.pow(1 - progress, decay);
    }
  }
  return buf;
}

function ensureDeckGraph() {
  const ctx = getAudioCtx();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  if (!deckImpulse) deckImpulse = buildImpulseResponse(ctx, 2.0, 2.0);
  for (const el of decks) {
    if (deckNodes.has(el)) continue;
    try {
      const source = ctx.createMediaElementSource(el);
      const lowShelf = ctx.createBiquadFilter();
      lowShelf.type = 'lowshelf';
      lowShelf.frequency.value = 220;
      lowShelf.gain.value = 0;
      const highShelf = ctx.createBiquadFilter();
      highShelf.type = 'highshelf';
      highShelf.frequency.value = 1800;
      highShelf.gain.value = 0;
      const lowPass = ctx.createBiquadFilter();
      lowPass.type = 'lowpass';
      lowPass.frequency.value = 18000;
      lowPass.Q.value = 0.65;
      const convolver = ctx.createConvolver();
      convolver.buffer = deckImpulse;
      const dryGain = ctx.createGain();
      dryGain.gain.value = 1;
      const wetGain = ctx.createGain();
      wetGain.gain.value = 0;
      const gainNode = ctx.createGain();
      gainNode.gain.value = 1;
      source.connect(lowShelf);
      lowShelf.connect(highShelf);
      highShelf.connect(lowPass);
      lowPass.connect(dryGain);
      dryGain.connect(gainNode);
      lowPass.connect(convolver);
      convolver.connect(wetGain);
      wetGain.connect(gainNode);
      gainNode.connect(ctx.destination);
      deckNodes.set(el, { lowShelf, highShelf, lowPass, dryGain, wetGain, gainNode });
      el.volume = 1;
    } catch (_) {
      // MediaElementSource 只能建一次；失败则退回 element.volume
    }
  }
}

function setDeckTone(el, depth) {
  const node = deckNodes.get(el);
  if (!node) return;
  const ctx = getAudioCtx();
  const now = ctx.currentTime;
  // Softer mask — avoid the old “EQ cliff” that made handoffs jump
  const d = Math.min(1, Math.max(0, depth)) * 0.45;
  node.lowShelf.gain.setTargetAtTime(d * 6, now, 0.28);
  node.highShelf.gain.setTargetAtTime(-d * 10, now, 0.28);
  node.lowPass.frequency.setTargetAtTime(18000 - d * 9000, now, 0.28);
  node.lowPass.Q.setTargetAtTime(0.7 + d * 0.5, now, 0.28);
  node.dryGain.gain.setTargetAtTime(1 - d * 0.04, now, 0.28);
}

function setDeckReverb(el, wetness) {
  const node = deckNodes.get(el);
  if (!node) return;
  const now = getAudioCtx().currentTime;
  node.wetGain.gain.setTargetAtTime(Math.min(0.22, Math.max(0, wetness * 0.55)), now, 0.3);
}

function resetDeckFx(el) {
  setDeckTone(el, 0);
  setDeckReverb(el, 0);
}

function applyVolumes() {
  // While AudioParam ramps are running, don't fight the schedule
  if (fade?.scheduled) return;
  ensureDeckGraph();
  const ctx = sharedAudioCtx;
  for (const d of decks) {
    const level = Math.max(0, Math.min(1, masterVol * d._gain * (d._trackGain || 1)));
    const n = deckNodes.get(d);
    if (n?.gainNode && ctx) {
      d.volume = 1;
      n.gainNode.gain.setTargetAtTime(level, ctx.currentTime, 0.015);
    } else {
      d.volume = level;
    }
  }
}

/* ---------- loudness + automix (beat / phrase) align ---------- */
const TARGET_RMS = MixEngine?.TARGET_RMS || 0.11;
const audioAnalysis = new MixEngine.AnalysisCache(MixEngine.MAX_CACHE || 10);
let sharedAudioCtx = null;
function getAudioCtx() {
  if (!sharedAudioCtx || sharedAudioCtx.state === 'closed') sharedAudioCtx = new AudioContext();
  return sharedAudioCtx;
}

function emptyAnalysis(extra = {}) {
  return MixEngine.emptyAnalysis(extra);
}

function nearestTime(list, t) {
  return MixEngine.nearestTime(list, t);
}

function clearAudioAnalysis(reason) {
  audioAnalysis.clear();
  try {
    if (sharedAudioCtx && sharedAudioCtx.state !== 'closed') {
      // keep context; just drop decode pressure
    }
  } catch (_) {}
  if (reason) toast(reason);
}

/** Keep only current / next analyses hot; compact or drop the rest */
function trimAnalysisMemory() {
  const cur = current();
  const nextIdx = player.index >= 0 ? player.index + 1 : -1;
  const next = nextIdx >= 0 && nextIdx < player.queue.length ? player.queue[nextIdx] : null;
  audioAnalysis.touchKeep([cur?.id, next?.id]);
}

async function analyzeTrack(id, urls) {
  if (!id || !urls?.length) return emptyAnalysis();
  if (audioAnalysis.has(id)) return audioAnalysis.get(id);
  const pending = (async () => {
    try {
      const r = await fetch(urls[0]);
      if (!r.ok) throw new Error('fetch audio ' + r.status);
      const buf = await r.arrayBuffer();
      const ctx = getAudioCtx();
      const audioBuf = await ctx.decodeAudioData(buf.slice(0));
      const ch = audioBuf.getChannelData(0);
      const result = MixEngine.analyzePcm(ch, audioBuf.sampleRate, audioBuf.duration, {
        loudNorm: lib?.settings?.loudNorm !== false,
      });
      // PCM / AudioBuffer fall out of scope → GC; cache only features
      audioAnalysis.set(id, result);
      trimAnalysisMemory();
      return result;
    } catch (_) {
      const result = emptyAnalysis();
      audioAnalysis.set(id, result);
      return result;
    }
  })();
  audioAnalysis.set(id, pending);
  return pending;
}

function bestEnvOffset(query, haystack) {
  let best = 0;
  let bestScore = -1;
  const qLen = query.length;
  if (qLen < 8 || haystack.length < qLen) return { offset: 0, score: 0 };
  let qEnergy = 0;
  for (let i = 0; i < qLen; i++) qEnergy += query[i] * query[i];
  const qNorm = Math.sqrt(qEnergy) + 1e-9;
  const step = Math.max(1, Math.floor(qLen / 120));
  for (let off = 0; off <= haystack.length - qLen; off += step) {
    let dot = 0;
    let hEnergy = 0;
    for (let i = 0; i < qLen; i++) {
      const y = haystack[off + i];
      dot += query[i] * y;
      hEnergy += y * y;
    }
    const sc = dot / (qNorm * (Math.sqrt(hEnergy) + 1e-9));
    if (sc > bestScore) {
      bestScore = sc;
      best = off;
    }
  }
  const lo = Math.max(0, best - step);
  const hi = Math.min(haystack.length - qLen, best + step);
  for (let off = lo; off <= hi; off++) {
    let dot = 0;
    let hEnergy = 0;
    for (let i = 0; i < qLen; i++) {
      const y = haystack[off + i];
      dot += query[i] * y;
      hEnergy += y * y;
    }
    const sc = dot / (qNorm * (Math.sqrt(hEnergy) + 1e-9));
    if (sc > bestScore) {
      bestScore = sc;
      best = off;
    }
  }
  return { offset: best, score: bestScore };
}

/** 包络/onset 互相关精修（Automix fallback / 相位锁） */
async function alignByAudio(oldId, oldPos, newId, newUrls, guessPos, opts = {}) {
  try {
    const oldA = await analyzeTrack(oldId, player.urls);
    const newA = await analyzeTrack(newId, newUrls);
    const useOnset = opts.useOnset !== false && oldA.onset && newA.onset;
    const oldCurve = useOnset ? oldA.onset : oldA.env;
    const newCurve = useOnset ? newA.onset : newA.env;
    if (!oldCurve || !newCurve) return { at: guessPos, score: 0 };
    const qDur = opts.qDur ?? 4;
    const lead = opts.lead ?? 0.55;
    const qStart = Math.max(0, Math.floor((oldPos - lead) * oldA.rate));
    const qLen = Math.floor(qDur * oldA.rate);
    const query = oldCurve.slice(qStart, qStart + qLen);
    if (query.length < oldA.rate * 1.5) return { at: guessPos, score: 0 };
    const pad = opts.pad ?? 45;
    const hStart = Math.max(0, Math.floor((guessPos - pad) * newA.rate));
    const hEnd = Math.min(newCurve.length, Math.floor((guessPos + pad) * newA.rate) + qLen);
    const hay = newCurve.slice(hStart, hEnd);
    const { offset, score } = bestEnvOffset(query, hay);
    if (score < (opts.minScore ?? 0.58)) return { at: guessPos, score };
    return { at: Math.max(0, (hStart + offset) / newA.rate + lead), score };
  } catch (_) {
    return { at: guessPos, score: 0 };
  }
}

/**
 * Automix：歌词粗定位 → 落到 phrase/beat → onset 精修 → mapOffset + 可选 syncRate
 * 返回 { alignedAt, mapOffset, syncRate, confidence }
 */
async function alignByAutomix(oldId, oldPos, newId, newUrls, guessPos, opts = {}) {
  const fallback = {
    alignedAt: guessPos,
    mapOffset: guessPos - oldPos,
    syncRate: 1,
    confidence: 0,
  };
  try {
    const oldA = await analyzeTrack(oldId, player.urls);
    const newA = await analyzeTrack(newId, newUrls);
    let phraseGuess = guessPos;

    if (oldA.phrases?.length && newA.phrases?.length) {
      const oldPh = nearestTime(oldA.phrases, oldPos);
      const into = oldPos - oldPh;
      const newPh = nearestTime(newA.phrases, guessPos);
      phraseGuess = Math.max(0, newPh + into);
    } else if (oldA.beats?.length && newA.beats?.length) {
      const oldBt = nearestTime(oldA.beats, oldPos);
      const into = oldPos - oldBt;
      const newBt = nearestTime(newA.beats, guessPos);
      phraseGuess = Math.max(0, newBt + into);
    } else if (newA.phrases?.length) {
      phraseGuess = nearestTime(newA.phrases, guessPos);
    } else if (newA.beats?.length) {
      phraseGuess = nearestTime(newA.beats, guessPos);
    }

    const hasLyric = !!opts.hasLyric;
    const refined = await alignByAudio(oldId, oldPos, newId, newUrls, phraseGuess, {
      pad: hasLyric ? 10 : 18,
      minScore: hasLyric ? 0.5 : 0.55,
      useOnset: true,
      qDur: 3.5,
      lead: 0.4,
    });

    let alignedAt = refined.at;
    let confidence = refined.score;

    // 精修后再吸到最近拍，减少「差半拍」叠唱
    if (newA.beats?.length && confidence >= 0.5) {
      const bt = nearestTime(newA.beats, alignedAt);
      if (Math.abs(bt - alignedAt) < (newA.beatInterval || 0.5) * 0.45) alignedAt = bt;
    }

    if (confidence < 0.5) {
      const soft = await alignByAudio(oldId, oldPos, newId, newUrls, guessPos, {
        pad: hasLyric ? 14 : 40,
        minScore: 0.52,
        useOnset: false,
      });
      if (soft.score > confidence) {
        alignedAt = soft.at;
        confidence = soft.score;
      } else {
        alignedAt = phraseGuess;
      }
    }

    let syncRate = 1;
    if (oldA.bpm > 0 && newA.bpm > 0) {
      const ratio = oldA.bpm / newA.bpm;
      if (ratio >= 0.92 && ratio <= 1.08 && Math.abs(ratio - 1) >= 0.03) syncRate = ratio;
    }

    // 对齐结果若离谱（贴曲末 / 偏离粗猜太远），回退粗定位，避免一切就到结尾没声
    const newDur = newA.duration || 0;
    const ratioAt = newDur > 1 ? Math.max(0, Math.min(newDur * 0.98, (oldPos / Math.max(oldA.duration || oldPos, 1)) * newDur)) : guessPos;
    if (newDur > 8 && alignedAt > newDur - 6 && oldPos < (oldA.duration || oldPos) - 12) {
      alignedAt = Math.min(alignedAt, Math.max(guessPos, ratioAt));
      if (alignedAt > newDur - 6) alignedAt = Math.min(ratioAt, newDur - 8);
      confidence = Math.min(confidence, 0.4);
    }
    // 有歌词命中时更信任歌词句，音频精修只允许小幅偏移（同歌换版本更「跟唱」）
    if (opts.hasLyric && Math.abs(alignedAt - guessPos) > 8) {
      if (confidence < 0.7) alignedAt = guessPos;
      else alignedAt = guessPos + Math.max(-6, Math.min(6, alignedAt - guessPos));
    }
    if (Math.abs(alignedAt - guessPos) > 45 && confidence < 0.72) {
      alignedAt = guessPos;
      confidence = Math.min(confidence, 0.45);
    }
    if (newDur > 1) alignedAt = Math.max(0, Math.min(newDur - 2.5, alignedAt));

    return {
      alignedAt,
      mapOffset: alignedAt - oldPos,
      syncRate,
      confidence,
    };
  } catch (_) {
    return fallback;
  }
}

async function applyTrackLoudness(el, trackId, urls) {
  if (!el) return;
  if (lib?.settings?.loudNorm === false) {
    el._trackGain = 1;
    applyVolumes();
    return;
  }
  const a = await analyzeTrack(trackId, urls);
  el._trackGain = a.gain || 1;
  applyVolumes();
}
function onDeck(type, fn) {
  for (const d of decks) d.addEventListener(type, (e) => d === audio && fn(e));
}
const fx = () => ({
  crossfade: !!lib.settings.crossfade,
  sec: lib.settings.crossfadeSec || 6,
  gapless: lib.settings.gapless !== false,
});
/** Version / Automix overlap length (seconds), adjustable in settings */
function seamlessFadeSec() {
  const v = Number(lib?.settings?.seamlessSec);
  return Math.max(1, Math.min(8, isFinite(v) && v > 0 ? v : 2.5));
}

/** Ask bundled veloura-audio (SLM / AutoMix); null if runtime unavailable. */
async function askVelouraPlan(currentTrack, nextTrack, urlsCurrent, urlsNext, opts = {}) {
  if (!api.velouraPlan) return null;
  try {
    const res = await api.velouraPlan({
      mode: opts.mode || 'automix',
      preset: opts.preset || 'automix',
      current: {
        title: currentTrack?.title,
        artist: currentTrack?.artist || currentTrack?.author,
        duration: currentTrack?.duration || trackDuration() || 0,
        url: urlsCurrent?.[0],
      },
      next: {
        title: nextTrack?.title,
        artist: nextTrack?.artist || nextTrack?.author,
        duration: nextTrack?.duration || 0,
        url: urlsNext?.[0],
      },
      timeoutMs: opts.timeoutMs || 50000,
    });
    if (!res?.ok || !res.data) return null;
    return res.data;
  } catch (_) {
    return null;
  }
}

function mergeVelouraIntoPlan(localPlan, vel, userFade) {
  if (!vel) return localPlan;
  const velFade = Math.max(
    1.5,
    Math.min(14, Number(vel.fadeSec || vel.crossfade_seconds) || localPlan.fadeSec || userFade || 2.5),
  );
  // Same-song: allow Veloura to lengthen up to 6s; cross-track: keep Veloura seconds
  const capped = localPlan.sameSong
    ? Math.max(userFade || seamlessFadeSec(), Math.min(velFade, Math.max(6, seamlessFadeSec())))
    : Math.max(userFade || 2.5, velFade);
  let syncRate = Number(vel.syncRate || vel.next_tempo) || localPlan.syncRate || 1;
  if (syncRate < 0.94 || syncRate > 1.06) syncRate = localPlan.syncRate || 1;
  const toStart =
    vel.toStart != null && isFinite(vel.toStart)
      ? Math.max(0, Number(vel.toStart))
      : localPlan.toStart;
  let mode = vel.mode || localPlan.mode;
  if ((vel.confidence || 0) < 0.35 || localPlan.crossTrack) mode = mode === 'cut' ? 'fade' : mode;
  if (localPlan.crossTrack && mode === 'cut') mode = 'fade';
  const fromFadeTrim = Number(vel.fromFadeTrim || vel.current_trim_end);
  let fromFadeBegin = localPlan.fromFadeBegin;
  if (isFinite(fromFadeTrim) && fromFadeTrim > 0 && localPlan.crossTrack) {
    const dur = Number(vel.current_duration) || 0;
    // Veloura trim_end = silence stripped from end; start fade near remaining outro
    if (dur > fromFadeTrim + capped) fromFadeBegin = Math.max(fromFadeBegin || 0, dur - fromFadeTrim - capped);
  }
  return {
    ...localPlan,
    mode,
    fadeSec: capped,
    toStart,
    syncRate,
    fromFadeBegin: fromFadeBegin ?? localPlan.fromFadeBegin,
    fromFadeTrim: isFinite(fromFadeTrim) ? fromFadeTrim : localPlan.fromFadeTrim,
    nextTrimStart: Number(vel.next_trim_start ?? vel.toStart) || localPlan.toStart,
    confidence: Math.max(localPlan.confidence || 0, vel.confidence || 0),
    reason: vel.reason || localPlan.reason,
    engine: vel.engine || 'veloura',
  };
}

let fade = null;
function finishFade() {
  if (!fade) return;
  const f = fade;
  fade = null;
  clearInterval(f.timer);
  f.from.pause();
  f.from._gain = 1;
  f.to._gain = 1;
  resetDeckFx(f.from);
  resetDeckFx(f.to);
  try {
    f.from.playbackRate = 1;
  } catch (_) {}
  // 淡化结束：新轨从纠速平滑回到 1.0
  const endRate = typeof f.endRate === 'number' ? f.endRate : 1;
  if (Math.abs((f.to.playbackRate || 1) - endRate) > 0.01) {
    const fromRate = f.to.playbackRate || 1;
    const t0 = performance.now();
    const rampMs = 900;
    const timer = setInterval(() => {
      const p = Math.min(1, (performance.now() - t0) / rampMs);
      try {
        f.to.playbackRate = fromRate + (endRate - fromRate) * p;
      } catch (_) {}
      if (p >= 1) clearInterval(timer);
    }, 30);
  } else {
    try {
      f.to.playbackRate = endRate;
    } catch (_) {}
  }
  applyVolumes();
  f.resolve();
}
/** 把 seek 钳在可播放区间，避免贴曲末导致立刻 ended / 没声音 */
function clampPlayhead(el, t, tail = 2.5) {
  if (!isFinite(t)) return 0;
  const dur = isFinite(el?.duration) && el.duration > 1 ? el.duration : null;
  const maxT = dur != null ? Math.max(0, dur - Math.max(tail, 1.2)) : Math.max(0, t);
  return Math.max(0, Math.min(maxT, t));
}

/** LiveSort 风格：取某时刻附近包络能量，用于交接响度匹配 */
function localRmsFromAnalysis(a, pos, win = 4) {
  if (!a?.env?.length) return 0.06;
  const rate = a.rate || 80;
  const i0 = Math.max(0, Math.floor(Math.max(0, pos - win * 0.5) * rate));
  const i1 = Math.min(a.env.length, Math.floor((pos + win * 0.5) * rate));
  if (i1 <= i0) return 0.06;
  let s = 0;
  let n = 0;
  for (let i = i0; i < i1; i += 2) {
    const v = a.env[i] || 0;
    s += v * v;
    n++;
  }
  return Math.max(0.008, Math.sqrt(s / Math.max(1, n)));
}

/** 参考 LiveSort：新轨开场约 85%；中段允许两轨同时高电平「重合」 */
function transitionDynamicProfile(outEnergy, inEnergy) {
  const o = Math.max(0.008, outEnergy || 0.06);
  const i = Math.max(0.008, inEnergy || 0.06);
  const loudnessDiffDb = 20 * Math.log10(i / o);
  if (loudnessDiffDb >= 1.5) {
    const attenuationDb = Math.min(6, (loudnessDiffDb - 1.5) * 0.7);
    const incomingStartGain = Math.max(0.78, Math.min(0.9, Math.pow(10, -attenuationDb / 20)));
    return {
      incomingStartGain,
      incomingEndGain: Math.max(incomingStartGain, 1),
      outgoingShape: 0.92,
      incomingMaxGain: 1,
      totalMixCap: 1.85,
      fxIntensity: 1.05,
    };
  }
  if (loudnessDiffDb <= -1.5) {
    const boost = Math.min(0.08, (-1.5 - loudnessDiffDb) * 0.012);
    return {
      incomingStartGain: 0.86 + boost,
      incomingEndGain: 1,
      outgoingShape: 0.9,
      incomingMaxGain: 1,
      totalMixCap: 1.9,
      fxIntensity: 1.0,
    };
  }
  return {
    incomingStartGain: 0.86,
    incomingEndGain: 1,
    outgoingShape: 0.9,
    incomingMaxGain: 1,
    totalMixCap: 1.88,
    fxIntensity: 0.95,
  };
}

/** Soft mid-blend FX; release gently near the end (no hard zero cliff). */
function transitionFxEnvelope(ratio) {
  const r = Math.min(1, Math.max(0, ratio));
  if (r <= 0.04 || r >= 0.96) return { depth: 0, reverb: 0 };
  const peakAt = 0.45;
  const endAt = 0.96;
  let bell;
  if (r <= peakAt) bell = r / peakAt;
  else bell = 1 - (r - peakAt) / (endAt - peakAt);
  bell = Math.max(0, Math.min(1, bell));
  return { depth: bell * 0.28, reverb: bell * 0.14 };
}

function equalPowerGains(ratio) {
  const r = Math.min(1, Math.max(0, ratio));
  return {
    outG: Math.cos((r * Math.PI) / 2),
    inG: Math.sin((r * Math.PI) / 2),
  };
}

/**
 * Dual-deck handoff gains.
 * Default: Veloura-style equal-power (constant energy). Optional short hold then fade.
 */
function livesortCrossfadeState(ratio, breathRatio, profile) {
  const p = profile || {};
  const safeRatio = Math.min(1, Math.max(0, ratio));
  const useEqPower = p.equalPower !== false && !p.legacyLayered;

  if (useEqPower || p.layered) {
    // Optional brief dual presence (≤20%), then equal-power for the rest
    const hold = Math.min(0.2, Math.max(0, p.overlapHold ?? 0.12));
    let r = safeRatio;
    if (safeRatio < hold) r = 0;
    else r = (safeRatio - hold) / Math.max(0.001, 1 - hold);
    const ep = equalPowerGains(r);
    const fx = transitionFxEnvelope(safeRatio);
    return {
      outG: ep.outG,
      inG: ep.inG,
      outDepth: fx.depth * 0.5,
      inDepth: fx.depth * 0.4,
      outRev: fx.reverb * 0.5,
      inRev: fx.reverb * 0.4,
    };
  }

  const safeBreath = Math.min(0.22, Math.max(0.08, breathRatio ?? 0.12));
  const inRatio = safeRatio <= safeBreath ? 0 : (safeRatio - safeBreath) / (1 - safeBreath);
  const ep = equalPowerGains(inRatio);
  let outG = ep.outG;
  let inG = ep.inG;
  const startG = p.incomingStartGain ?? 0.05;
  const endG = p.incomingEndGain ?? 1;
  inG = startG + (endG - startG) * inG;

  const cap = p.totalMixCap ?? 1.35;
  if (outG + inG > cap) {
    const scale = cap / (outG + inG);
    outG *= scale;
    inG *= scale;
  }

  const fx = transitionFxEnvelope(safeRatio);
  const fxScale = Math.min(1, Math.max(0.5, p.fxIntensity ?? 0.7));
  return {
    outG,
    inG,
    outDepth: fx.depth * fxScale,
    inDepth: fx.depth * fxScale * 0.85,
    outRev: fx.reverb * fxScale,
    inRev: fx.reverb * fxScale * 0.85,
  };
}

/**
 * Crossfade handoff — Veloura-style equal-power curves on AudioParam when possible.
 */
function crossfade(from, to, sec, opts = {}) {
  finishFade();
  ensureDeckGraph();
  return new Promise((resolve) => {
    const ease = opts.ease || 1;
    const hold = Math.max(0, opts.hold || 0);
    const syncOffset = opts.syncOffset;
    const syncFrom0 = opts.syncFrom0;
    const syncTo0 = opts.syncTo0;
    const syncRate = typeof opts.syncRate === 'number' && opts.syncRate > 0 ? opts.syncRate : 1;
    const profile = opts.profile || { equalPower: true };
    const breathRatio = opts.breathRatio ?? 0.12;
    const useFx = !!profile || !!opts.eqFx;
    const start = performance.now();
    const dur = Math.max(0.05, sec) * 1000;
    let lastSync = -999;
    try {
      if (Math.abs(syncRate - 1) > 0.01) to.playbackRate = syncRate;
      else to.playbackRate = 1;
    } catch (_) {}

    const fromNode = deckNodes.get(from);
    const toNode = deckNodes.get(to);
    const ctx = sharedAudioCtx;
    const canSchedule = !!(fromNode && toNode && ctx && sec >= 0.35);

    const lockSync = (force = false) => {
      if (from.paused) return;
      const elapsed = performance.now() - start;
      const pNow = Math.min(1, Math.max(0, (elapsed - hold * 1000) / dur));
      const syncEvery = sec <= 2 ? 48 : pNow >= 0.1 && pNow <= 0.9 ? 90 : 220;
      if (!force && elapsed - lastSync < syncEvery) return;
      lastSync = elapsed;
      let want = null;
      if (typeof syncTo0 === 'number' && typeof syncFrom0 === 'number') {
        want = syncTo0 + (from.currentTime - syncFrom0) * syncRate;
      } else if (typeof syncOffset === 'number') {
        want = from.currentTime + syncOffset;
      }
      if (want == null || !isFinite(want)) return;
      want = clampPlayhead(to, want, Math.max(1.2, sec * 0.2));
      const driftTol = sec <= 2 ? 0.08 : 0.14;
      if (force || Math.abs(to.currentTime - want) > driftTol) {
        try {
          to.currentTime = want;
        } catch (_) {}
      }
    };
    lockSync(true);

    if (canSchedule) {
      const now = ctx.currentTime;
      const overlap = Math.max(0.35, sec);
      const fromLvl = Math.max(0.0001, masterVol * (from._trackGain || 1));
      const toLvl = Math.max(0.0001, masterVol * (to._trackGain || 1));
      from._gain = 1;
      to._gain = 1;
      from.volume = 1;
      to.volume = 1;
      const fG = fromNode.gainNode.gain;
      const tG = toNode.gainNode.gain;
      fG.cancelScheduledValues(now);
      tG.cancelScheduledValues(now);
      const n = Math.max(32, Math.min(128, Math.round(overlap * 24)));
      const outCurve = new Float32Array(n);
      const inCurve = new Float32Array(n);
      const holdFrac = Math.min(0.18, Math.max(0, profile?.overlapHold ?? 0.1));
      for (let i = 0; i < n; i++) {
        const raw = i / (n - 1);
        const r = raw < holdFrac ? 0 : (raw - holdFrac) / Math.max(0.001, 1 - holdFrac);
        outCurve[i] = fromLvl * Math.cos((r * Math.PI) / 2);
        inCurve[i] = toLvl * Math.sin((r * Math.PI) / 2);
      }
      try {
        fG.setValueCurveAtTime(outCurve, now, overlap);
        tG.setValueCurveAtTime(inCurve, now, overlap);
      } catch (_) {
        fG.setValueAtTime(fromLvl, now);
        tG.setValueAtTime(0.0001, now);
        fG.linearRampToValueAtTime(0.0001, now + overlap);
        tG.linearRampToValueAtTime(toLvl, now + overlap);
      }
      setDeckTone(from, 0.12);
      setDeckTone(to, 0.1);
      setDeckReverb(from, 0.06);
      setDeckReverb(to, 0.05);
    }

    fade = {
      from,
      to,
      resolve,
      endRate: 1,
      scheduled: !!canSchedule,
      timer: setInterval(() => {
        const elapsed = performance.now() - start;
        let p = 0;
        if (elapsed > hold * 1000) p = Math.min(1, (elapsed - hold * 1000) / dur);
        if (canSchedule) {
          const fx = transitionFxEnvelope(p);
          setDeckTone(from, fx.depth);
          setDeckTone(to, fx.depth * 0.85);
          setDeckReverb(from, fx.reverb);
          setDeckReverb(to, fx.reverb * 0.85);
          if (p >= 0.94) {
            setDeckTone(from, 0);
            setDeckTone(to, 0);
            setDeckReverb(from, 0);
            setDeckReverb(to, 0);
          }
        } else if (useFx) {
          const st = livesortCrossfadeState(p, breathRatio, profile);
          to._gain = st.inG;
          from._gain = st.outG;
          setDeckTone(from, st.outDepth);
          setDeckTone(to, st.inDepth);
          setDeckReverb(from, st.outRev);
          setDeckReverb(to, st.inRev);
          applyVolumes();
        } else {
          const pe = Math.pow(p, ease);
          const ep = equalPowerGains(pe);
          to._gain = ep.inG;
          from._gain = ep.outG;
          applyVolumes();
        }
        lockSync(false);
        if (p >= 1) finishFade();
      }, 20),
    };
  });
}
function rampGain(el, to, ms) {
  return new Promise((resolve) => {
    const from = el._gain;
    const start = performance.now();
    const timer = setInterval(() => {
      const p = Math.min(1, (performance.now() - start) / ms);
      el._gain = from + (to - from) * p;
      applyVolumes();
      if (p >= 1) {
        clearInterval(timer);
        resolve();
      }
    }, 20);
  });
}

let prepSeq = 0;
/** 在后台把某个地址加载到指定位置，直到可以无停顿地播放 */
function prepareDeck(el, urls, startAt = 0) {
  const id = ++prepSeq;
  el._prepId = id;
  return new Promise((resolve, reject) => {
    let i = 0;
    let done = false;
    const evs = ['loadedmetadata', 'canplay', 'seeked', 'error'];
    const finish = (ok, v) => {
      if (done) return;
      done = true;
      evs.forEach((ev) => el.removeEventListener(ev, handler));
      clearTimeout(timer);
      ok ? resolve(v) : reject(v);
    };
    const handler = (e) => {
      if (el._prepId !== id) return finish(false, new Error('cancelled'));
      if (e.type === 'loadedmetadata') {
        const s = typeof startAt === 'function' ? startAt() : startAt;
        if (s > 0.2) el.currentTime = clampPlayhead(el, s, 8);
      } else if (e.type === 'error') {
        if (++i < urls.length) el.src = urls[i];
        else finish(false, new Error('音频加载失败'));
      } else if (!el.seeking && el.readyState >= 3) finish(true, i);
    };
    const timer = setTimeout(() => finish(false, new Error('加载超时')), 20000);
    evs.forEach((ev) => el.addEventListener(ev, handler));
    el.pause();
    el.src = urls[0];
    el.load();
  });
}

function pruneStreamCache(keepId) {
  const max = 16;
  if (player.cache.size <= max) return;
  const entries = [...player.cache.entries()].sort((a, b) => (a[1].time || 0) - (b[1].time || 0));
  for (const [id] of entries) {
    if (player.cache.size <= max) break;
    if (id === keepId) continue;
    player.cache.delete(id);
  }
}

async function getStream(t, token) {
  if (isPluginTrack(t)) {
    let entry = player.cache.get(t.id);
    if (!entry || Date.now() - entry.time > 30 * 60 * 1000) {
      const media = await api.sourceMedia(t);
      if (token != null && token !== player.token) return null;
      if (!media?.url) throw new Error('插件未返回播放地址');
      const streams = [{ id: 30216, urls: [media.url] }];
      entry = { streams, time: Date.now() };
      player.cache.set(t.id, entry);
      pruneStreamCache(t.id);
    } else {
      entry.time = Date.now();
    }
    if (token != null && token !== player.token) return null;
    return { ...pickStream(entry.streams), streams: entry.streams };
  }
  if (t.lazy) {
    const info = await getInfo(t.bvid);
    if (token != null && token !== player.token) return null;
    Object.assign(t, makeTrack(info, info.pages[0]), { lazy: false, lazyId: t.id });
    updateNowPlaying();
    renderQueue();
  }
  let entry = player.cache.get(t.id);
  if (!entry || Date.now() - entry.time > 80 * 60 * 1000) {
    const r = await api.audio(t.bvid, t.cid);
    entry = { streams: r.streams, time: Date.now() };
    player.cache.set(t.id, entry);
    pruneStreamCache(t.id);
  } else {
    entry.time = Date.now();
  }
  if (token != null && token !== player.token) return null;
  return { ...pickStream(entry.streams), streams: entry.streams };
}

/**
 * 下一首下标。优先级：单曲循环 > 列表循环 > 随机(只决定队列顺序)。
 * auto=true 表示播完自动切；单曲循环时返回当前 index。
 */
function nextIndex(auto = true) {
  if (!player.queue.length) return -1;
  // 1) 单曲循环优先：自动续播当前；手动下一首可跳过
  if (player.repeat === 'one') {
    if (auto) return player.index;
    return player.index < player.queue.length - 1 ? player.index + 1 : 0;
  }
  if (player.index < player.queue.length - 1) return player.index + 1;
  // 2) 列表循环：回到队头（随机时由 next() 重新打乱）
  if (player.repeat === 'all') return 0;
  return -1;
}

/* 无缝：快结束时把下一首预载到空闲轨道，ended 时直接切过去 */
let preload = null;
function discardPreload() {
  if (!preload) return;
  const el = preload.el;
  preload = null;
  if (el && el !== audio) {
    el._prepId = -1;
    el.pause();
  }
}
async function preloadNext() {
  const ni = nextIndex(true);
  if (ni < 0 || ni === player.index) return;
  const p = { track: player.queue[ni], el: null, ready: false };
  preload = p;
  try {
    const st = await getStream(p.track, null);
    if (preload !== p || fade) return;
    p.el = idleDeck();
    p.el._gain = 1;
    applyVolumes();
    p.idx = await prepareDeck(p.el, st.urls, 0);
    if (preload !== p) return;
    p.st = st;
    p.ready = true;
  } catch (_) {
    if (preload === p) preload = null;
  }
}
function swapToPreload() {
  const p = preload;
  preload = null;
  const old = audio;
  audio = p.el;
  audio._gain = 1;
  applyVolumes();
  audio.play().catch(() => {});
  old.pause();
  player.token++;
  player.index = player.queue.indexOf(p.track);
  player.urls = p.st.urls;
  player.urlIdx = p.idx;
  player.streams = p.st.streams;
  player.quality = p.st.stream.id;
  player.retried = false;
  updateQualityBadge();
  updateNowPlaying();
  renderQueue();
  saveSession();
  addHistory(p.track);
  applyTrackLoudness(audio, p.track.id, p.st.urls);
}

/**
 * startAt 可以是函数：在真正 seek 的那一刻再取值，用于版本切换时补上加载耗时。
 * opts.fadeSec：本次过渡的淡化时长（0 / 不传则按设置）；opts.hard：强制直接切。
 */
async function loadCurrent(autoplay = true, startAt = 0, isRetry = false, opts = {}) {
  // New track load cancels end-of-song version seam unless we are executing it
  if (pendingVersionSeam && !player.transitioning) {
    const cur = current();
    if (!cur || cur.id !== pendingVersionSeam.fromId) clearPendingVersionSeam('');
  }
  const t = current();
  player.needsLoad = false;
  if (!isRetry) player.retried = false;
  discardPreload();
  updateNowPlaying();
  renderQueue();
  saveSession();
  if (!t) {
    finishFade();
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    return;
  }
  const token = ++player.token;
  const s = fx();
  const fadeSec = opts.fadeSec ?? (s.crossfade ? s.sec : 0);
  const smooth = !opts.hard && autoplay && !isRetry && fadeSec > 0 && !audio.paused && audio.currentTime > 0;
  player.transitioning = smooth;
  if (!smooth) {
    finishFade();
    audio.pause();
  }
  try {
    const st = await getStream(t, token);
    if (!st) return;
    player.streams = st.streams;
    player.quality = st.stream.id;
    updateQualityBadge();
    if (smooth) {
      finishFade();
      const el = idleDeck();
      el._gain = 0;
      applyVolumes();
      let idx;
      try {
        idx = await prepareDeck(el, st.urls, startAt);
      } catch (e) {
        if (token !== player.token) return;
        player.transitioning = false;
        return loadCurrent(autoplay, typeof startAt === 'function' ? startAt() : startAt, isRetry, { ...opts, hard: true });
      }
      if (token !== player.token) return;
      if (typeof startAt === 'function') {
        const want = clampPlayhead(el, startAt(), 8);
        if (Math.abs(want - el.currentTime) > 0.08) el.currentTime = want;
      }
      const old = audio;
      const syncRate = typeof opts.syncRate === 'number' && opts.syncRate > 0 ? opts.syncRate : 1;
      let wantPos = null;
      if (typeof opts.syncTo0 === 'number' && typeof opts.syncFrom0 === 'number') {
        wantPos = opts.syncTo0 + (old.currentTime - opts.syncFrom0) * syncRate;
      } else if (typeof opts.syncOffset === 'number') {
        wantPos = old.currentTime + opts.syncOffset;
      }
      if (wantPos != null && isFinite(wantPos)) {
        wantPos = clampPlayhead(el, wantPos, 8);
        if (Math.abs(el.currentTime - wantPos) > 0.08) el.currentTime = wantPos;
      }
      try {
        el.playbackRate = Math.abs(syncRate - 1) > 0.01 ? syncRate : 1;
      } catch (_) {}
      audio = el;
      player.urls = st.urls;
      player.urlIdx = idx;
      player.transitioning = false;
      el.play().catch(() => {});
      setPlayIcon();
      applyTrackLoudness(el, t.id, st.urls);
      crossfade(old, el, fadeSec, {
        ease: opts.fadeEase,
        hold: opts.fadeHold,
        syncOffset: opts.syncOffset,
        syncFrom0: opts.syncFrom0,
        syncTo0: opts.syncTo0,
        syncRate,
        profile: opts.profile,
        breathRatio: opts.breathRatio,
      });
    } else {
      player.urls = st.urls;
      player.urlIdx = 0;
      player.pendingSeek = typeof startAt === 'function' ? startAt() : startAt;
      audio._gain = 1;
      audio._trackGain = 1;
      applyVolumes();
      audio.src = player.urls[0];
      if (autoplay) audio.play().catch(() => {});
      applyTrackLoudness(audio, t.id, st.urls);
    }
    if (autoplay && !isRetry && !opts.noHistory) addHistory(t);
    trimAnalysisMemory();
  } catch (e) {
    player.transitioning = false;
    if (token === player.token) onTrackFail(errMsg(e));
  }
}

/* ================= audio quality ================= */
const QUALITIES = [
  { id: 30251, rank: 4, label: 'Hi-Res 无损', short: 'Hi-Res', note: '需要大会员，且视频本身提供' },
  { id: 30280, rank: 3, label: '极高 192K', short: '192K' },
  { id: 30232, rank: 2, label: '高品质 132K', short: '132K' },
  { id: 30216, rank: 1, label: '标准 64K', short: '64K' },
];
const qualityOf = (id) => QUALITIES.find((q) => q.id === id);
const qualityPref = () => lib.settings.quality || 'auto';

/** 选不高于偏好的最高档；其余档位的地址排在后面作为失败兜底 */
function pickStream(streams) {
  const pref = qualityPref();
  const maxRank = pref === 'auto' ? 99 : qualityOf(pref)?.rank || 99;
  const sorted = streams.slice().sort((a, b) => (qualityOf(b.id)?.rank || 0) - (qualityOf(a.id)?.rank || 0));
  const stream = sorted.find((s) => (qualityOf(s.id)?.rank || 0) <= maxRank) || sorted[sorted.length - 1];
  const rest = sorted.filter((s) => s !== stream && (qualityOf(s.id)?.rank || 0) < (qualityOf(stream.id)?.rank || 0));
  return { stream, urls: [...stream.urls, ...rest.flatMap((s) => s.urls)] };
}

function updateQualityBadge() {
  const q = current() && player.quality ? qualityOf(player.quality) : null;
  for (const el of [$('#btnQuality'), $('#npQuality')]) {
    el.textContent = q ? q.short : '音质';
    el.classList.toggle('hires', q?.id === 30251);
  }
}

function setQuality(pref) {
  lib.settings.quality = pref;
  save();
  const t = current();
  if (!t || !player.streams || player.needsLoad) return updateQualityBadge();
  const { stream, urls } = pickStream(player.streams);
  if (stream.id === player.quality) return toast(`当前歌曲最高只有 ${qualityOf(stream.id)?.label || '这一档'}`);
  const old = audio;
  const pos = old.currentTime;
  loadCurrent(!old.paused, () => old.currentTime || pos, false, { fadeSec: 0.2, noHistory: true });
  toast(`已切换到 ${qualityOf(stream.id)?.label}`);
}

function qualityMenu(x, y) {
  const pref = qualityPref();
  const avail = new Set((current() && player.streams ? player.streams : []).map((s) => s.id));
  const mark = (on) => (on ? 'check' : '');
  showMenu(x, y, [
    { label: '自动（最高可用）', icon: mark(pref === 'auto'), action: () => setQuality('auto') },
    { sep: true },
    ...QUALITIES.map((q) => ({
      label: `${q.label}${avail.size && !avail.has(q.id) ? '（当前歌曲无）' : ''}${q.note && !avail.has(q.id) ? ' · ' + q.note : ''}`,
      icon: mark(pref === q.id),
      action: () => setQuality(q.id),
    })),
  ]);
}
$('#btnQuality').onclick = (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  qualityMenu(r.left - 120, r.bottom + 6);
};
$('#npQuality').onclick = (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  qualityMenu(r.left - 160, r.top - 190);
};

/* ================= versions ================= */
const VER_SHORT = { studio: '录音', live: 'Live', cover: '翻唱', mv: 'MV', instrumental: '伴奏', other: '其他' };
const VER_RE = {
  cover: /翻唱|翻自|cover(?!\s*art)|女声版|男声版|女版|男版/i,
  instrumental: /伴奏|纯音乐|instrumental|inst\.|off\s*vocal|和声伴奏/i,
  mv: /\bMV\b|\bPV\b|官方MV/i,
  live: /live|现场|演唱会|音乐节|巡演|巡回|tour|万人合唱|官摄/i,
  notStudio:
    /8\s*[Dd]|环绕音?|降调|升调|变调|变速|卡点|踩点|夜店|\bDJ\s*版|remix|混音|\bSUNO\b|\bUdio\b|AI\s*(翻|生成|翻唱)|reimagined|Lo-?fi|slowed|speed\s*up|混剪|串烧|medley/i,
  studio: /录音室|录音棚|录音版|原版|官方音频|同名专辑|纯享|studio|专辑版|Hi-?Res|无损|官方音源|完整版|高品质/i,
};
function classifyLocal(title, album = '') {
  const s = `${title} ${album}`;
  if (VER_RE.cover.test(s)) return 'cover';
  if (VER_RE.instrumental.test(s)) return 'instrumental';
  if (VER_RE.mv.test(s) && !/附MV|带MV/i.test(s)) return 'mv';
  if (VER_RE.live.test(s)) return 'live';
  if (VER_RE.notStudio.test(s)) return 'other';
  return 'studio';
}

/** 切换版本后刷新列表里的「播放中」标记，避免旧项 current 残留导致双高亮 */
function versionHitIsCurrent(v, cur = current()) {
  if (!cur?.bvid || !v?.bvid || v.bvid !== cur.bvid) return false;
  if (v.cid && cur.cid) return v.cid === cur.cid;
  if (v.page && cur.page) return Number(v.page) === Number(cur.page);
  return true;
}

function syncVersionPlayingFlags() {
  const cur = current();
  const bump = (data) => {
    if (!data?.groups) return;
    for (const g of data.groups) {
      for (const v of g.list || []) v.current = versionHitIsCurrent(v, cur);
    }
  };
  bump(verState.data);
  for (const data of versionCache.values()) bump(data);
}
const versionCache = new Map();
let verState = { trackId: null, data: null, tab: '', loading: false };

function updateVersionBadge() {
  const t = current();
  const cat = t ? classifyLocal(t.title, t.album) : null;
  const label = cat ? VER_SHORT[cat] : '版本';
  for (const el of [$('#btnVersion'), $('#npVersion')]) {
    if (!el) continue;
    el.textContent = label;
    el.disabled = !t;
    el.classList.toggle('on', !!t);
    el.title = t ? `切换版本（当前：${VER_SHORT[cat]}）` : '切换版本';
  }
}

async function loadVersions(track, force = false) {
  if (!track) return null;
  if (!force && versionCache.has(track.id)) return versionCache.get(track.id);
  verState = { trackId: track.id, data: null, tab: '', loading: true };
  try {
    const data = await api.findVersions({
      title: track.title,
      artist: track.artist,
      album: track.album,
      duration: track.duration,
      bvid: track.bvid,
      cid: track.cid,
      page: track.page,
    });
    versionCache.set(track.id, data);
    if (verState.trackId === track.id) verState = { trackId: track.id, data, tab: data.groups[0]?.id || '', loading: false };
    return data;
  } catch (e) {
    if (verState.trackId === track.id) verState.loading = false;
    throw e;
  }
}

const TRAD_MAP = {
  們: '们', 麼: '么', 樂: '乐', 過: '过', 這: '这', 還: '还', 來: '来', 對: '对', 時: '时', 間: '间',
  見: '见', 說: '说', 為: '为', 會: '会', 愛: '爱', 聽: '听', 長: '长', 東: '东', 車: '车', 後: '后',
  關: '关', 開: '开', 風: '风', 電: '电', 語: '语', 嗎: '吗', 著: '着', 裡: '里', 麼: '么', 點: '点',
  萬: '万', 與: '与', 卻: '却', 種: '种', 離: '离', 需: '需', 些: '些', 空間: '空间', 滿: '满',
  淚: '泪', 麼: '么', 麼: '么', 應: '应', 當: '当', 經: '经', 麼: '么',
};
const toHans = (s) => String(s || '').replace(/[\u4e00-\u9fff]/g, (c) => TRAD_MAP[c] || c);
const normLyric = (s) =>
  toHans(s)
    .toLowerCase()
    .replace(/（.*?）|\(.*?\)/g, '')
    .replace(/[的得地了着喔哦噢呀啊呢吧嗎吗啦嘿\s]/g, '')
    .replace(/[^\u4e00-\u9fffa-z0-9]/g, '');

function lyricScore(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 10;
  if (a.includes(b) || b.includes(a)) return 7 + Math.min(a.length, b.length) / Math.max(a.length, b.length);
  const n = Math.min(6, a.length, b.length);
  if (n >= 4 && a.slice(0, n) === b.slice(0, n)) return 6;
  let hit = 0;
  const set = new Set(b);
  for (const c of a) if (set.has(c)) hit++;
  const ratio = hit / Math.max(a.length, b.length);
  return ratio >= 0.72 ? 5 + ratio : 0;
}

/** 抓取当前唱到的歌词句，用于跨版本对齐 */
function snapshotLyric(pos) {
  if (!lrc.lines?.length) return null;
  const t = pos - lyricOffset() + 0.12;
  let idx = -1;
  for (let i = 0; i < lrc.lines.length && lrc.lines[i].t <= t; i++) if (lrc.lines[i].text) idx = i;
  if (idx < 0) return null;
  const line = lrc.lines[idx];
  const next = lrc.lines.slice(idx + 1).find((x) => x.text);
  const span = Math.max(0.4, (next?.t ?? (trackDuration() || pos + 4)) - line.t);
  return { text: line.text, tr: line.tr, into: Math.max(0, Math.min(span * 0.9, t - line.t)), span, idx };
}

/** 在新版本歌词里找同一句，返回应对齐的时间点（句首 + 句内进度） */
function matchLyricTime(lines, snap) {
  if (!snap?.text || !lines?.length) return null;
  const target = normLyric(snap.text);
  const targetTr = normLyric(snap.tr);
  if (!target && !targetTr) return null;
  const scored = [];
  for (let i = 0; i < lines.length; i++) {
    const n = normLyric(lines[i].text);
    const tr = normLyric(lines[i].tr);
    let score = Math.max(lyricScore(n, target), lyricScore(tr, target), lyricScore(tr, targetTr), lyricScore(n, targetTr));
    if (score >= 5) scored.push({ i, t: lines[i].t, score, n });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0].score;
  const cands = scored.filter((x) => x.score >= top - 0.5);
  // 副歌重复：按旧歌词进度比例挑第几段
  let best = cands[0];
  if (cands.length > 1) {
    const total = Math.max(1, (lrc.lines || []).filter((x) => x.text).length);
    const ratio = Math.min(0.95, (snap.idx + 0.5) / total);
    best = cands[Math.min(cands.length - 1, Math.round(ratio * (cands.length - 1)))];
  }
  return best.t + snap.into;
}

async function resolveVersionTrack(hit, cur) {
  const tracks = await resolveTracks(hit.bvid, {
    mode: 'all',
    page: hit.page || null,
    cid: hit.cid || null,
  });
  if (!tracks.length) throw new Error('无法解析该视频');
  let t = tracks[0];
  // 未指定分 P 时，多 P 里挑时长最接近的一首
  if (tracks.length > 1 && !hit.cid && !hit.page && cur.duration) {
    t = tracks.slice().sort((a, b) => Math.abs(a.duration - cur.duration) - Math.abs(b.duration - cur.duration))[0];
  }
  t.versionOf = cur.versionOf || cur.id;
  t.versionCat = hit.cat;
  return t;
}

/** Replace current queue slot in-place — do not insert/reorder the playlist. */
function commitVersionInPlace(cur, t) {
  const rootId = cur.versionOf || cur.id;
  t.versionOf = rootId;
  if (!player.queue.length) {
    player.queue = [t];
    player.index = 0;
  } else {
    player.queue[player.index] = t;
  }
  renderQueue();
  saveSession();
}

/** Pending end-of-track version seamless handoff */
let pendingVersionSeam = null;
/** 衔接β: run only when the current song is about to end */
let pendingCrossSeam = null;

function clearPendingVersionSeam(reason) {
  if (!pendingVersionSeam) return;
  pendingVersionSeam = null;
  if (reason) toast(reason);
}

/** Guard: if current track changed, drop stale end-seam reservation */
function assertPendingSeamStillValid() {
  if (!pendingVersionSeam) return false;
  const cur = current();
  if (!cur || cur.id !== pendingVersionSeam.fromId || cur.bvid !== pendingVersionSeam.fromBvid) {
    pendingVersionSeam = null;
    return false;
  }
  return true;
}

/** 版本无缝：equal-power 渐入渐出时长（跟设置，约 2–4 秒） */
function pendingSeamFadeSec() {
  return Math.max(2, Math.min(4, seamlessFadeSec()));
}

/** 仅音频对齐失败时的时长比例兜底（不用歌词） */
function buildRatioTimeMap(oldDur, metaDur) {
  const slope = metaDur / Math.max(1e-3, oldDur);
  const clampT = (v) => clamp(v, 0, Math.max(0, metaDur - 0.05));
  return {
    ok: false,
    kind: 'ratio',
    mapTime: (srcT) => clampT(srcT * slope),
    slopeAt: () => clamp(slope, 0.92, 1.08),
  };
}

/** 切换后异步换歌词显示，不参与对齐 */
function loadVersionLyricsLater(t, cur) {
  prepareVersionLyrics(t, cur, null, { apply: true }).catch(() => {});
}

/** 拉取新版本歌词（仅 UI，不对齐） */
async function prepareVersionLyrics(t, cur, snap, { apply = true } = {}) {
  let matchedAt = null;
  let lines = [];
  let res = null;
  try {
    res = lyricsCache.get(t.id);
    if (!res?.lines?.length) {
      const q = {
        title: cur.title,
        artist: cur.artist,
        album: cur.album || t.title,
        duration: t.duration || cur.duration,
      };
      res = await api.findLyrics(q, lib.lyricPicks?.[t.id] || lib.lyricPicks?.[cur.id] || null);
      lyricsCache.set(t.id, res);
    }
    lines = res.lines || [];
    if (snap) matchedAt = matchLyricTime(lines, snap);
    if (apply && lines.length) {
      lrc = { id: t.id, lines, plain: res.plain || '', match: res.match, query: res.query || '', loading: false, idx: -1 };
    }
  } catch (_) {}
  return { matchedAt, lines, res };
}

/**
 * 版本无缝：纯音频 chroma→DTW TimeMap + equal-power 渐入渐出（不对齐歌词）。
 * 列表槽位原地替换。曲末→下一首开头只走衔接β。
 */
async function switchVersionSeamless(hit) {
  const cur = current();
  if (!cur || !hit?.bvid) return;
  if (hit.bvid === cur.bvid) return toast('已经是这个版本了');
  if (player.transitioning) return toast('正在衔接中，稍后再试');

  toast(`正在音频对齐 →「${VER_SHORT[hit.cat] || hit.catLabel || '其他'}」…`);
  try {
    const t = await resolveVersionTrack(hit, cur);
    const st = await getStream(t, null);
    if (!st) throw new Error('无法获取音频');

    const oldId = cur.id;
    const oldUrls = player.urls?.slice() || [];
    const fadeSec = pendingSeamFadeSec();

    pendingVersionSeam = {
      fromId: oldId,
      fromBvid: cur.bvid,
      track: t,
      hit,
      urls: st.urls,
      streams: st.streams,
      quality: st.stream?.id,
      fadeSec,
      seamPrep: null,
      armed: false,
    };

    // 只跑 chroma/DTW；歌词不参与
    const prepPromise = Promise.all([
      oldUrls.length && typeof Seam !== 'undefined'
        ? Seam.prepPair(oldId, oldUrls, t.id, st.urls, getAudioCtx).catch(() => null)
        : null,
      analyzeTrack(t.id, st.urls).catch(() => null),
    ]).then(([seamPrep]) => {
      if (!pendingVersionSeam || pendingVersionSeam.track?.id !== t.id) return;
      pendingVersionSeam.seamPrep = seamPrep;
      pendingVersionSeam.armed = true;
    });

    await executePendingVersionSeam(prepPromise);
  } catch (e) {
    pendingVersionSeam = null;
    toast(errMsg(e), 'error');
  }
}

let seamExecuting = false;

/** 音频 DTW 对齐后 equal-power 交叉，原地换槽 */
async function executePendingVersionSeam(prepPromise) {
  if (seamExecuting || player.transitioning) return;
  const pending = pendingVersionSeam;
  if (!pending || !assertPendingSeamStillValid()) return;
  const cur = current();
  if (!cur || cur.id !== pending.fromId) {
    pendingVersionSeam = null;
    return;
  }

  seamExecuting = true;
  player.transitioning = true;
  const old = audio;
  const t = pending.track;
  const fadeSec = pending.fadeSec || pendingSeamFadeSec();
  const oldDur = trackDuration() || cur.duration || 1;
  const metaDur = t.duration || oldDur;

  try {
    // 等音频 DTW（全曲解码可能较慢）
    const waitUntil = performance.now() + 14000;
    let reminded = false;
    while (performance.now() < waitUntil) {
      if (current()?.id !== pending.fromId) {
        pendingVersionSeam = null;
        player.transitioning = false;
        return;
      }
      if (!reminded && performance.now() > waitUntil - 11500) {
        reminded = true;
        toast('正在解码对齐音频…');
      }
      if (pending.armed) {
        if (pending.seamPrep?.map?.mapTime) break;
        if (performance.now() > waitUntil - 1500) break;
      }
      await new Promise((r) => setTimeout(r, 60));
    }
    if (prepPromise) await Promise.race([prepPromise, new Promise((r) => setTimeout(r, 400))]);
    pendingVersionSeam = null;

    if (current()?.id !== pending.fromId) {
      player.transitioning = false;
      return;
    }

    const token = ++player.token;
    discardPreload();

    const el = idleDeck();
    el._gain = 0;
    el._trackGain = 1;
    applyVolumes();

    const dtwMap = pending.seamPrep?.map;
    const map =
      dtwMap && typeof dtwMap.mapTime === 'function'
        ? { ...dtwMap, ok: dtwMap.ok !== false, kind: dtwMap.ok ? 'audio-dtw' : 'audio-fallback' }
        : buildRatioTimeMap(oldDur, metaDur);

    const alignOldPos = old.currentTime || 0;
    const dstStart = map.mapTime(alignOldPos);

    await prepareDeck(el, pending.urls, dstStart).catch(() => {});
    if (token !== player.token) {
      player.transitioning = false;
      return;
    }
    await applyTrackLoudness(el, t.id, pending.urls);

    const liveSrc = old.currentTime || alignOldPos;
    const liveDst = map.mapTime(liveSrc);
    const liveSlope = clamp(map.slopeAt?.(liveSrc) || 1, 0.92, 1.08);
    try {
      el.playbackRate = liveSlope;
    } catch (_) {}
    el.currentTime = liveDst;
    el._gain = 0;
    // scheduled:false —— 必须让 applyVolumes 真正推动渐入渐出
    applyVolumes();
    await el.play().catch(() => {});

    // 双轨 equal-power + 每帧 mapTime 锁相（参考 SEAM：按音频，不按歌词）
    ensureDeckGraph();
    const fromNode = deckNodes.get(old);
    const toNode = deckNodes.get(el);
    const ctx = sharedAudioCtx;
    const canSchedule = !!(fromNode && toNode && ctx && fadeSec >= 0.35);
    const fromLvl = Math.max(0.0001, masterVol * (old._trackGain || 1));
    const toLvl = Math.max(0.0001, masterVol * (el._trackGain || 1));

    if (canSchedule) {
      const now = ctx.currentTime;
      const n = Math.max(32, Math.min(128, Math.round(fadeSec * 24)));
      const outCurve = new Float32Array(n);
      const inCurve = new Float32Array(n);
      const holdFrac = 0.1;
      for (let i = 0; i < n; i++) {
        const raw = i / (n - 1);
        const r = raw < holdFrac ? 0 : (raw - holdFrac) / Math.max(0.001, 1 - holdFrac);
        outCurve[i] = fromLvl * Math.cos((r * Math.PI) / 2);
        inCurve[i] = toLvl * Math.sin((r * Math.PI) / 2);
      }
      const fG = fromNode.gainNode.gain;
      const tG = toNode.gainNode.gain;
      fG.cancelScheduledValues(now);
      tG.cancelScheduledValues(now);
      try {
        fG.setValueCurveAtTime(outCurve, now, fadeSec);
        tG.setValueCurveAtTime(inCurve, now, fadeSec);
      } catch (_) {
        fG.setValueAtTime(fromLvl, now);
        tG.setValueAtTime(0.0001, now);
        fG.linearRampToValueAtTime(0.0001, now + fadeSec);
        tG.linearRampToValueAtTime(toLvl, now + fadeSec);
      }
      old.volume = 1;
      el.volume = 1;
      old._gain = 1;
      el._gain = 1;
      setDeckTone(old, 0.1);
      setDeckTone(el, 0.08);
      setDeckReverb(old, 0.05);
      setDeckReverb(el, 0.04);
    }

    fade = { from: old, to: el, scheduled: canSchedule, timer: null, resolve: null, endRate: 1 };
    const wall0 = performance.now();
    const srcLock0 = old.currentTime || liveSrc;
    try {
      await new Promise((resolve) => {
        const timer = setInterval(() => {
          const p = Math.min(1, (performance.now() - wall0) / (fadeSec * 1000));
          const srcNow = old.currentTime || srcLock0;
          const want = map.mapTime(srcNow);
          const localSlope = clamp(map.slopeAt?.(srcNow) || 1, 0.92, 1.08);
          try {
            if (Math.abs((el.playbackRate || 1) - localSlope) > 0.012) el.playbackRate = localSlope;
          } catch (_) {}
          if (Math.abs(el.currentTime - want) > 0.045) {
            try {
              el.currentTime = want;
            } catch (_) {}
          }
          if (!canSchedule) {
            old._gain = Math.cos((p * Math.PI) / 2);
            el._gain = Math.sin((p * Math.PI) / 2);
            applyVolumes();
          } else if (p >= 0.94) {
            setDeckTone(old, 0);
            setDeckTone(el, 0);
            setDeckReverb(old, 0);
            setDeckReverb(el, 0);
          }
          if (p >= 1) {
            clearInterval(timer);
            resolve();
          }
        }, 16);
      });
    } finally {
      fade = null;
    }

    old.pause();
    old._gain = 1;
    el._gain = 1;
    try {
      el.playbackRate = 1;
    } catch (_) {}
    applyVolumes();
    resetDeckFx(old);
    resetDeckFx(el);
    audio = el;

    commitVersionInPlace(cur, t);
    player.needsLoad = false;
    player.streams = pending.streams;
    player.quality = pending.quality;
    player.urls = pending.urls;
    player.urlIdx = 0;
    updateQualityBadge();
    updateNowPlaying();
    setPlayIcon();
    addHistory(t);
    saveSession();
    renderQueue();
    syncVersionPlayingFlags();
    if (el.paused) el.play().catch(() => {});
    player.transitioning = false;
    Seam?.clearPairsFor?.(pending.fromId);
    updateVersionBadge();
    trimAnalysisMemory();
    loadDanmaku(t).catch(() => {});
    loadVersionLyricsLater(t, cur);
    const tip = map.kind === 'audio-dtw' ? '音频 DTW' : map.kind === 'ratio' ? '时长比例' : '音频';
    toast(`无缝衔接 · ${tip} @ ${fmtTime(el.currentTime || liveDst)}`);
  } catch (e) {
    player.transitioning = false;
    try {
      audio._gain = 1;
      applyVolumes();
      if (audio.paused && current()) audio.play().catch(() => {});
    } catch (_) {}
    toast(errMsg(e), 'error');
  } finally {
    seamExecuting = false;
  }
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Cross-track seamless (Beta): Mixxx AutoDJ-style silence + fitness → cut / beat / fade
 * into a different song (queue / favorites / playlists).
 */
async function switchCrossTrackSeamless(track, opts = {}) {
  const cur = current();
  if (!cur || !track) return;
  if (track.id === cur.id || (track.bvid && track.bvid === cur.bvid && track.cid === cur.cid)) {
    return toast('已经在播放这首');
  }
  if (player.transitioning) return toast('正在衔接中，稍后再试');
  const durNow = trackDuration() || cur.duration || 0;
  const remainNow = durNow > 0 ? durNow - (audio.currentTime || 0) : 999;
  const armFade = Math.max(2.5, Math.min(6, seamlessFadeSec()));
  if (!opts.force && remainNow > armFade + 1.2) {
    pendingCrossSeam = { track, fromId: cur.id, fadeSec: armFade };
    toast(`已预约曲末衔接β →「${(track.title || '').slice(0, 24)}」开头`);
    return;
  }
  pendingCrossSeam = null;
  const old = audio;
  const wasPlaying = !old.paused || player.needsLoad;
  const oldId = cur.id;
  const oldUrls = player.urls?.slice() || [];
  const oldPos = old.currentTime || 0;
  toast(`无缝衔接（Beta）→「${(track.title || '').slice(0, 28)}」…`);
  player.transitioning = true;
  try {
    const t = { ...track };
    const st = await getStream(t, null);
    if (!st) throw new Error('无法获取音频');
    // Jump to target in queue (insert after current if needed)
    let qi = player.queue.findIndex((x) => x.id === t.id || (x.bvid === t.bvid && x.cid === t.cid));
    if (qi < 0) {
      player.queue.splice(player.index + 1, 0, t);
      qi = player.index + 1;
    }
    player.index = qi;
    renderQueue();

    discardPreload();
    const token = ++player.token;
    player.needsLoad = false;
    player.streams = st.streams;
    player.quality = st.stream.id;
    updateQualityBadge();
    updateNowPlaying();

    const el = idleDeck();
    el._gain = 0;
    el._trackGain = 1;
    applyVolumes();

    const [resolvedOld, resolvedNew, velPlan] = await Promise.all([
      oldUrls.length ? analyzeTrack(oldId, oldUrls) : emptyAnalysis(),
      analyzeTrack(t.id, st.urls),
      askVelouraPlan(cur, t, oldUrls, st.urls, { mode: 'automix', preset: 'automix' }),
    ]);
    if (token !== player.token) return;

    let plan = MixEngine.planTransition(resolvedOld, resolvedNew, oldPos, {
      fadeSec: Math.max(seamlessFadeSec(), 3),
      allowCut: false,
      crossTrack: true,
    });
    plan.crossTrack = true;
    plan = mergeVelouraIntoPlan(plan, velPlan, Math.max(seamlessFadeSec(), 3));
    if (plan.mode === 'cut') plan.mode = 'fade';

    // Always enter the next song near its intro, not a mid-phrase jump
    let toStart = Math.max(0, resolvedNew?.firstSound || 0);
    if (resolvedNew?.introEnd > toStart + 0.4) toStart = Math.min(resolvedNew.introEnd * 0.35, toStart + 1.5);
    if (resolvedNew?.beats?.length) toStart = MixEngine.nearestTime(resolvedNew.beats, toStart);

    const outroAt = resolvedOld?.outroStart > 1 ? resolvedOld.outroStart : Math.max(oldPos, (resolvedOld?.duration || cur.duration || durNow) - armFade);
    const fadeBegin = Math.max(oldPos, outroAt);
    const waitSec = fadeBegin - (old.currentTime || oldPos);
    if (waitSec > 1.5 && waitSec < 75) {
      toast(`将在约 ${Math.ceil(waitSec)} 秒后于曲尾衔接…`);
    }

    await prepareDeck(el, st.urls, toStart);
    if (token !== player.token) return;

    player.urls = st.urls;
    resetDeckFx(el);
    await applyTrackLoudness(el, t.id, st.urls);

    const rate = plan.syncRate || 1;
    try {
      el.playbackRate = rate;
    } catch (_) {}

    // Park B at intro cue; wait for outro if we're early, then equal-power blend
    el._gain = 0;
    applyVolumes();
    el.pause();
    el.currentTime = clampPlayhead(el, toStart, 4);

    if (waitSec > 1.5 && waitSec < 75) {
      const deadline = performance.now() + waitSec * 1000 + 400;
      while (performance.now() < deadline) {
        if (token !== player.token) return;
        if ((old.currentTime || 0) >= fadeBegin - 0.08) break;
        await new Promise((r) => setTimeout(r, 60));
      }
    }

    const syncFrom0 = old.currentTime || fadeBegin;
    let syncTo0 = toStart;
    syncTo0 = clampPlayhead(el, syncTo0, 4);
    el.currentTime = syncTo0;
    if (wasPlaying) await el.play().catch(() => {});
    const lockEnd = performance.now() + 320;
    while (performance.now() < lockEnd) {
      if (Math.abs(el.currentTime - toStart) > 0.08) el.currentTime = clampPlayhead(el, toStart, 4);
      await new Promise((r) => setTimeout(r, 24));
    }

    audio = el;
    setPlayIcon();
    addHistory(t);
    saveSession();
    renderQueue();
    syncVersionPlayingFlags();
    updateVersionBadge();

    const liveFrom = old.currentTime || syncFrom0;
    const liveTo = clampPlayhead(el, toStart, 4);
    if (Math.abs(el.currentTime - liveTo) > 0.05) el.currentTime = liveTo;

    const outE = localRmsFromAnalysis(resolvedOld, liveFrom, 4);
    const inE = localRmsFromAnalysis(resolvedNew, liveTo, 4);
    const fadeSec = Math.max(2.5, plan.fadeSec || 4);
    const mixProfile = {
      ...transitionDynamicProfile(outE, inE),
      equalPower: true,
      layered: false,
      overlapHold: 0.08,
      incomingStartGain: 0.02,
      incomingEndGain: 1,
      totalMixCap: 1.25,
      fxIntensity: 0.55,
    };

    await crossfade(old, el, fadeSec, {
      hold: 0,
      syncOffset: liveTo - liveFrom,
      syncFrom0: liveFrom,
      syncTo0: liveTo,
      syncRate: rate,
      profile: mixProfile,
      breathRatio: 0.1,
      eqFx: true,
    });

    el._gain = 1;
    try {
      el.playbackRate = 1;
    } catch (_) {}
    applyVolumes();
    if (el.paused) el.play().catch(() => {});
    player.transitioning = false;
    loadDanmaku(t).catch(() => {});
    trimAnalysisMemory();
    const modeLabel = { cut: '直切', beat: '节拍对齐', fade: '淡入淡出' }[plan.mode] || plan.mode;
    const eng = plan.engine ? ` · ${plan.engine}` : '';
    toast(`已无缝衔接 · ${modeLabel} · 适配 ${Math.round((plan.confidence || 0) * 100)}%${eng}`);
  } catch (e) {
    player.transitioning = false;
    try {
      audio._gain = 1;
      applyVolumes();
      if (audio.paused && current()) audio.play().catch(() => {});
    } catch (_) {}
    toast(errMsg(e), 'error');
  }
}

async function openCrossMixPanel() {
  const cur = current();
  if (!cur) return toast('先播放一首歌');
  const upcoming = player.queue.filter((_, i) => i !== player.index).slice(0, 40);
  const favs = (lib.favorites || []).filter((t) => t.id !== cur.id).slice(0, 24);
  const recent = historyTracks().filter((t) => t.id !== cur.id).slice(0, 24);
  const row = (t, tag) =>
    `<div class="ver-item" data-mixid="${esc(t.id)}">
      <div class="ver-cover" style="background-image:url('${thumb(t.cover, 160, 90)}')"></div>
      <div class="ver-meta">
        <div class="ver-title">${esc(t.title)}</div>
        <div class="ver-sub">${esc(tag)} · ${esc(t.artist || t.author || '')}</div>
      </div>
      <span class="ver-dur">${fmtTime(t.duration)}</span>
      <div class="ver-actions"><button class="pill-btn small primary" data-act="mix">衔接</button></div>
    </div>`;
  const sections = [];
  if (upcoming.length) sections.push(`<div class="hint" style="margin:8px 0 4px">待播清单</div>${upcoming.map((t) => row(t, '待播')).join('')}`);
  if (favs.length) sections.push(`<div class="hint" style="margin:8px 0 4px">喜爱</div>${favs.map((t) => row(t, '喜爱')).join('')}`);
  if (recent.length) sections.push(`<div class="hint" style="margin:8px 0 4px">最近播放</div>${recent.map((t) => row(t, '最近')).join('')}`);
  if (!sections.length) return toast('先把歌曲加入待播 / 喜爱，再试衔接');

  const byId = new Map();
  for (const t of [...upcoming, ...favs, ...recent]) if (t?.id) byId.set(t.id, t);
  await openModal({
    title: '无缝衔接其他歌曲（Beta）',
    wide: true,
    okText: '关闭',
    cancelText: '',
    body: `<div class="hint" style="margin-bottom:10px">参考 Mixxx AutoDJ：静音检测 → BPM/节拍 → 适配度（直切 / 节拍对齐 / 淡入淡出）。当前：「${esc(cur.title)}」</div>
      <div id="mixBody" class="ver-list" style="max-height:min(58vh,520px);overflow:auto">${sections.join('')}</div>`,
    onOpen: (m) => {
      $('#mixBody', m).onclick = async (e) => {
        const btn = e.target.closest('[data-act="mix"]');
        const rowEl = e.target.closest('[data-mixid]');
        if (!btn || !rowEl) return;
        const t = byId.get(rowEl.dataset.mixid);
        if (!t) return;
        $('[data-m="ok"]', m)?.click();
        await switchCrossTrackSeamless(t);
      };
    },
  });
}

/** 更换：直接换源，从头播放，不做对齐/淡化 */
async function switchVersionReplace(hit) {
  const cur = current();
  if (!cur || !hit?.bvid) return;
  if (hit.bvid === cur.bvid) return toast('已经是这个版本了');
  toast(`正在更换为「${VER_SHORT[hit.cat] || hit.catLabel || '其他'}」…`);
  try {
    const t = await resolveVersionTrack(hit, cur);
    commitVersionInPlace(cur, t);
    lrc = { id: null, lines: [], plain: '', match: null, query: '', loading: false, idx: -1 };
    const prevId = cur.id;
    await loadCurrent(true, 0, false, { hard: true, fadeSec: 0, noHistory: false });
    syncVersionPlayingFlags();
    versionCache.delete(prevId);
    versionCache.delete(current()?.id);
    updateVersionBadge();
    toast(`已更换 · ${VER_SHORT[hit.cat] || hit.catLabel}`);
  } catch (e) {
    toast(errMsg(e), 'error');
  }
}

function renderVersionBody(m) {
  const box = $('#verBody', m);
  if (!box) return;
  if (verState.loading) {
    box.innerHTML = '<div class="spinner"></div>';
    return;
  }
  const data = verState.data;
  if (!data?.groups?.length) {
    box.innerHTML = '<div class="empty" style="padding:30px 0">没有找到其他版本<div class="hint" style="margin-top:8px">试着先编辑歌名 / 艺人，或换一首再试</div></div>';
    return;
  }
  const tab = verState.tab || data.groups[0].id;
  verState.tab = tab;
  const group = data.groups.find((g) => g.id === tab) || data.groups[0];
  box.innerHTML = `<div class="ver-tabs">${data.groups
    .map((g) => `<button class="ver-tab ${g.id === group.id ? 'on' : ''}" data-vtab="${g.id}">${esc(g.label)}<span class="ver-n">${g.list.length}</span></button>`)
    .join('')}</div>
    <div class="ver-list">${group.list
      .map((v) => {
        const on = versionHitIsCurrent(v);
        const sub = [v.album, v.author, v.play != null ? `${fmtCount(v.play)} 播放` : ''].filter(Boolean).join(' · ');
        return `<div class="ver-item ${on ? 'on' : ''}" data-vbvid="${esc(v.bvid)}" data-vcid="${v.cid || ''}" data-vpage="${v.page || ''}" data-vcat="${esc(v.cat)}">
        <div class="ver-cover" style="background-image:url('${thumb(v.cover, 160, 90)}')"></div>
        <div class="ver-meta">
          <div class="ver-title" title="${esc(v.title)}">${esc(v.title)}</div>
          <div class="ver-sub" title="${esc(sub)}">${esc(sub)}</div>
        </div>
        <span class="ver-dur">${fmtTime(v.duration)}</span>
        ${
          on
            ? '<span class="ver-now">播放中</span>'
            : `<div class="ver-actions">
                <button class="pill-btn small primary" data-act="seamless" title="按音频对齐无缝衔接">无缝</button>
                <button class="pill-btn small" data-act="replace" title="直接更换，从头播放">更换</button>
              </div>`
        }
      </div>`;
      })
      .join('')}</div>`;
  $$('.ver-title, .ver-sub', box).forEach((el) => {
    el.addEventListener('mouseenter', () => {
      if (el.scrollWidth <= el.clientWidth + 1) return;
      setMarquee(el, el.getAttribute('title') || el.textContent);
    });
    el.addEventListener('mouseleave', () => {
      el.classList.remove('scrolling');
      el.textContent = el.getAttribute('title') || '';
    });
  });
  // Hover: background decode + chroma DTW prep (gold = audio map ready)
  $$('.ver-item[data-vbvid]', box).forEach((row) => {
    row.addEventListener('mouseenter', () => {
      const cur = current();
      if (!cur || typeof Seam === 'undefined') return;
      const hit = versionHitFromRow(row);
      if (!hit.bvid || versionHitIsCurrent(hit, cur)) return;
      prefetchSeamPair(cur, hit, row);
    });
  });
}

function versionHitFromRow(row) {
  const cid = Number(row.dataset.vcid);
  const page = Number(row.dataset.vpage);
  return {
    bvid: row.dataset.vbvid,
    cat: row.dataset.vcat,
    cid: cid || null,
    page: page || null,
  };
}

async function prefetchSeamPair(cur, hit, rowEl) {
  try {
    if (!cur || !hit?.bvid || typeof Seam === 'undefined') return;
    const stCur = player.urls?.length ? { urls: player.urls } : null;
    if (!stCur?.urls?.length) return;
    const t = await resolveVersionTrack(hit, cur);
    const st = await getStream(t, null);
    if (!st?.urls?.length) return;
    rowEl?.classList.add('seam-prep');
    const prep = await Seam.prepPair(cur.id, stCur.urls, t.id, st.urls, getAudioCtx);
    rowEl?.classList.remove('seam-prep');
    if (prep?.status === 'gold') rowEl?.classList.add('seam-gold');
    else if (prep) rowEl?.classList.add('seam-green');
  } catch (_) {
    rowEl?.classList.remove('seam-prep');
  }
}

async function openVersionPanel() {
  const t = current();
  if (!t) return toast('先播放一首歌');
  const head = classifyLocal(t.title, t.album);
  verState.tab = '';
  await openModal({
    title: '切换版本',
    wide: true,
    okText: '关闭',
    cancelText: '',
    body: `<div class="hint" style="margin-bottom:10px">当前：${esc(VER_SHORT[head])} · ${esc(t.title)}
      <br><b>无缝</b>：按音频 chroma/DTW 对齐后渐入渐出（列表顺序不变）　·　<b>更换</b>：立刻换源从头播（仍不改列表顺序）
      <br>跨曲请用底部「衔接β」：本曲结束再接到下一首开头。</div>
      <div id="verBody"><div class="spinner"></div></div>`,
    onOpen: (m) => {
      $('#verBody', m).onclick = async (e) => {
        const tab = e.target.closest('[data-vtab]');
        if (tab) {
          verState.tab = tab.dataset.vtab;
          renderVersionBody(m);
          return;
        }
        const act = e.target.closest('[data-act]')?.dataset.act;
        const row = e.target.closest('[data-vbvid]');
        if (!row || !act) return;
        const hit = versionHitFromRow(row);
        if (versionHitIsCurrent(hit)) return;
        $('[data-m="ok"]', m)?.click();
        if (act === 'replace') await switchVersionReplace(hit);
        else await switchVersionSeamless(hit);
      };
      loadVersions(t, true)
        .then(() => {
          syncVersionPlayingFlags();
          const prefer = head === 'live' ? 'studio' : 'live';
          verState.tab = verState.data?.groups.find((g) => g.id === prefer)?.id || verState.data?.groups[0]?.id || '';
          renderVersionBody(m);
        })
        .catch((e) => {
          $('#verBody', m).innerHTML = `<div class="empty">加载失败：${esc(errMsg(e))}</div>`;
        });
    },
  });
}
$('#btnVersion').onclick = openVersionPanel;
$('#npVersion').onclick = openVersionPanel;
$('#npMixBeta')?.addEventListener('click', () => openCrossMixPanel());

function onTrackFail(msg) {
  const t = current();
  if (!t) return;
  player.cache.delete(t.id);
  toast(`无法播放「${t.title}」：${msg}`, 'error');
  player.fails++;
  setPlayIcon();
  // 单曲循环优先：失败时重试当前，不因随机/下一首跳走
  if (player.repeat === 'one' && player.fails < 3) {
    setTimeout(() => loadCurrent(true, 0, true), 900);
    return;
  }
  const ni = nextIndex(true);
  if (player.fails < 3 && ni >= 0 && ni !== player.index) {
    setTimeout(() => next(true), 900);
  } else {
    player.fails = 0;
  }
}

function togglePlay() {
  if (!current()) {
    if (table.tracks.length) playList(table.tracks, 0);
    return;
  }
  if (player.needsLoad) return loadCurrent(true, player.resumeAt);
  const soft = fx().crossfade && !fade;
  if (audio.paused) {
    if (soft) {
      audio._gain = 0;
      applyVolumes();
    }
    audio.play().catch(() => {});
    if (soft) rampGain(audio, 1, 450);
  } else if (soft) {
    const el = audio;
    rampGain(el, 0, 300).then(() => {
      el.pause();
      el._gain = 1;
      applyVolumes();
    });
  } else audio.pause();
}

function next(auto = false) {
  if (!player.queue.length) return;
  pendingCrossSeam = null;
  clearPendingVersionSeam(auto ? '' : '已取消版本无缝');

  // 优先级：单曲循环 > 列表循环 > 随机
  if (auto && player.repeat === 'one') {
    loadCurrent(true, 0);
    return;
  }

  const atEnd = player.index >= player.queue.length - 1;
  if (!atEnd) {
    player.index++;
    loadCurrent(true);
    return;
  }

  if (player.repeat === 'all') {
    if (player.shuffle) reshuffleCycle();
    else player.index = 0;
    loadCurrent(true);
    return;
  }

  // 未开循环：自动停在最后；手动下一首回到开头
  if (!auto) {
    player.index = 0;
    loadCurrent(false);
  } else setPlayIcon();
}

function prev() {
  if (!player.queue.length) return;
  if (audio.currentTime > 3 || player.index === 0) {
    audio.currentTime = 0;
    return;
  }
  clearPendingVersionSeam('已取消版本无缝');
  player.index--;
  loadCurrent(true);
}

function jumpTo(qi) {
  if (qi !== player.index) pendingCrossSeam = null;
  clearPendingVersionSeam(qi !== player.index ? '已取消版本无缝' : '');
  player.index = qi;
  loadCurrent(true);
}

let lastSessionSave = 0;
function saveSession(force = true) {
  if (!lib) return;
  if (!force && Date.now() - lastSessionSave < 5000) return;
  lastSessionSave = Date.now();
  lib.session = {
    queue: player.queue,
    index: player.index,
    shuffle: player.shuffle,
    repeat: player.repeat,
    position: audio.currentTime || player.resumeAt || 0,
  };
  save();
}

/* audio events */
onDeck('loadedmetadata', () => {
  if (player.pendingSeek) {
    audio.currentTime = player.pendingSeek;
    player.pendingSeek = 0;
  }
});
onDeck('playing', () => (player.fails = 0));
onDeck('play', setPlayIcon);
onDeck('pause', () => {
  setPlayIcon();
  saveSession();
});
onDeck('ended', () => {
  if (player.transitioning) return;
  // 单曲循环优先于随机 / 预载切歌
  if (player.repeat === 'one') {
    audio.currentTime = 0;
    audio.play().catch(() => loadCurrent(true, 0));
    return;
  }
  const ni = nextIndex(true);
  if (preload?.ready && ni >= 0 && preload.track === player.queue[ni]) swapToPreload();
  else next(true);
});
onDeck('error', () => {
  if (!audio.getAttribute('src') || !current()) return;
  const pos = audio.currentTime;
  if (player.urlIdx < player.urls.length - 1) {
    player.urlIdx++;
    player.pendingSeek = pos;
    audio.src = player.urls[player.urlIdx];
    audio.play().catch(() => {});
  } else if (!player.retried) {
    // 链接可能过期，重新取一次
    player.retried = true;
    player.cache.delete(current().id);
    loadCurrent(true, pos, true);
  } else onTrackFail('音频加载失败');
});

/* ================= now playing UI ================= */
const seek = $('#seek');
let seeking = false;

function setRange(el, ratio) {
  el.style.setProperty('--p', `${Math.max(0, Math.min(1, ratio)) * 100}%`);
}

function trackDuration() {
  return isFinite(audio.duration) && audio.duration > 0 ? audio.duration : current()?.duration || 0;
}

onDeck('timeupdate', () => {
  const dur = trackDuration();
  const s = fx();
  const remain = dur - audio.currentTime;
  if (dur > 0 && current() && !fade && !player.transitioning && !audio.paused) {
    // 衔接β only: wait until this song ends, then blend into the next song's intro
    if (
      pendingCrossSeam &&
      pendingCrossSeam.fromId === current()?.id &&
      remain <= (pendingCrossSeam.fadeSec || 3) + 0.4 &&
      remain > 0.15
    ) {
      const job = pendingCrossSeam;
      pendingCrossSeam = null;
      switchCrossTrackSeamless(job.track, { force: true });
    } else if (s.crossfade && remain <= s.sec && remain > 0.5 && dur > s.sec * 2.5 && !pendingCrossSeam) {
      // 单曲循环时 nextIndex 返回当前，不跨曲渐入
      const ni = nextIndex(true);
      if (ni >= 0 && ni !== player.index) {
        player.index = ni;
        loadCurrent(true, 0, false, { fadeSec: Math.min(s.sec, remain) });
      }
    } else if (s.gapless && !s.crossfade && remain <= 25 && player.repeat !== 'one') {
      const ni = nextIndex(true);
      if (preload && (ni < 0 || preload.track !== player.queue[ni])) discardPreload();
      if (!preload) preloadNext();
    }
  }
  if (!seeking) {
    for (const el of [seek, npSeek]) {
      el.value = dur ? (audio.currentTime / dur) * 1000 : 0;
      setRange(el, el.value / 1000);
    }
    $('#tCur').textContent = $('#npCur').textContent = fmtTime(audio.currentTime);
  }
  $('#tDur').textContent = '-' + fmtTime(dur - audio.currentTime);
  $('#npDur').textContent = fmtTime(dur);
  saveSession(false);
  if ('mediaSession' in navigator && dur) {
    try {
      navigator.mediaSession.setPositionState({ duration: dur, position: Math.min(audio.currentTime, dur), playbackRate: 1 });
    } catch (_) {}
  }
  tickDanmaku();
});
const npSeek = $('#npSeek');
for (const el of [seek, npSeek]) {
  el.addEventListener('input', () => {
    seeking = true;
    setRange(el, el.value / 1000);
    $('#tCur').textContent = $('#npCur').textContent = fmtTime((el.value / 1000) * trackDuration());
  });
  el.addEventListener('change', () => {
    seeking = false;
    seekTo((el.value / 1000) * trackDuration());
  });
}
function seekTo(pos) {
  if (player.needsLoad) {
    player.resumeAt = pos;
    return loadCurrent(true, pos);
  }
  audio.currentTime = pos;
  if (dm.list?.length) {
    let i = 0;
    while (i < dm.list.length && dm.list[i].t < pos - 0.15) i++;
    dm.cursor = i;
    clearDanmakuDom();
  }
}

function setPlayIcon() {
  const playing = !audio.paused && !!current();
  for (const btn of [$('#btnPlay'), ...$$('[data-ctl="play"]')]) {
    btn.innerHTML = icon(playing ? 'pause' : 'play');
    btn.title = playing ? '暂停' : '播放';
  }
  document.body.classList.toggle('paused', !playing);
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  api.setThumbarPlaying?.(playing);
}

function updateControls() {
  for (const s of [$('#btnShuffle'), $('[data-ctl="shuffle"]')]) {
    s.classList.toggle('on', player.shuffle);
    s.title =
      player.repeat === 'one' && player.shuffle
        ? '随机播放（单曲循环优先，开着也不跳曲）'
        : player.shuffle
          ? '随机播放：开'
          : '随机播放';
  }
  for (const r of [$('#btnRepeat'), $('[data-ctl="repeat"]')]) {
    r.classList.toggle('on', player.repeat !== 'off');
    r.innerHTML = icon(player.repeat === 'one' ? 'repeat1' : 'repeat');
    r.title = { off: '循环：关', all: '循环：列表（优先于随机顺序）', one: '循环：单曲（最高优先级）' }[player.repeat];
  }
}

function updateNowPlaying() {
  const t = current();
  const cover = $('#lcdCover');
  if (t) {
    setMarquee($('#lcdTitle'), t.title);
    setMarquee($('#lcdSub'), [t.artist, t.album].filter(Boolean).join(' — '));
    cover.style.backgroundImage = `url('${coverSrc(t.cover, 96)}')`;
    cover.classList.add('has-img');
    document.title = `${t.title} - Bili Music`;
    api.setWindowTitle?.(`${t.title} - Bili Music`);
    api.notifyPluginTrack?.(t);
    $('#btnLcdFav').classList.toggle('on', isFav(t.id));
    $('#tDur').textContent = fmtTime(t.duration);
    if ('mediaSession' in navigator) {
      const art = coverSrc(t.cover, 512);
      navigator.mediaSession.metadata = new MediaMetadata({
        title: t.title,
        artist: t.artist,
        album: t.album || (isPluginTrack(t) ? t.platform : 'Bilibili') || '',
        artwork: art ? [{ src: art, sizes: '512x512', type: 'image/jpeg' }] : [],
      });
    }
  } else {
    setMarquee($('#lcdTitle'), 'Bili Music');
    setMarquee($('#lcdSub'), '搜索 B 站，开始播放');
    cover.style.backgroundImage = '';
    cover.classList.remove('has-img');
    document.title = 'Bili Music';
    api.setWindowTitle?.('Bili Music');
    api.notifyPluginTrack?.(null);
    $('#btnLcdFav').classList.remove('on');
  }
  for (const el of [seek, npSeek]) {
    el.value = 0;
    setRange(el, 0);
  }
  $('#tCur').textContent = $('#npCur').textContent = '0:00';
  markPlaying();
  setPlayIcon();
  updateVersionBadge();
  updateNp();
}

/* ================= marquee ================= */
function setMarquee(el, text) {
  if (el.dataset.text === text) return;
  el.dataset.text = text;
  el.innerHTML = `<span class="mq"><span class="mq-t">${esc(text)}</span></span>`;
  fitMarquee(el);
}
function fitMarquee(el) {
  const text = el.dataset.text || '';
  const mq = $('.mq', el);
  if (!mq) return;
  el.classList.remove('scrolling');
  mq.innerHTML = `<span class="mq-t">${esc(text)}</span>`;
  const w = mq.scrollWidth;
  if (!el.clientWidth || w <= el.clientWidth + 1) return;
  mq.innerHTML = `<span class="mq-t">${esc(text)}</span><span class="mq-t">${esc(text)}</span>`;
  el.style.setProperty('--mq-dur', `${Math.max(6, (w + 56) / 32)}s`);
  el.classList.add('scrolling');
}
let mqTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(mqTimer);
  mqTimer = setTimeout(() => $$('.marquee[data-text]').forEach(fitMarquee), 150);
});

function isCurrentId(id) {
  const c = current();
  return !!c && (c.id === id || c.lazyId === id);
}

function markPlaying() {
  $$('.tr[data-id]', content).forEach((row) => {
    const on = isCurrentId(row.dataset.id);
    if (row.classList.contains('playing') === on) return;
    row.classList.toggle('playing', on);
    const ph = $('.play-hover', row);
    if (ph) ph.innerHTML = on ? eqHtml() : icon('play');
  });
}

if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', () => togglePlay());
  navigator.mediaSession.setActionHandler('pause', () => audio.pause());
  navigator.mediaSession.setActionHandler('previoustrack', prev);
  navigator.mediaSession.setActionHandler('nexttrack', () => next());
  navigator.mediaSession.setActionHandler('seekto', (d) => (audio.currentTime = d.seekTime));
}

/** 任务栏缩略图按钮 / 全局快捷键 / 多媒体键 */
api.onMediaCmd?.((cmd) => runShortcutAction(cmd));
api.onUpdateStatus?.((s) => {
  if (!s?.state) return;
  if (s.state === 'available') toast(`发现新版本，正在下载…`);
  if (s.state === 'ready') toast(`更新已就绪：${s.info?.version || ''}，可重启安装`);
  if (s.state === 'error' && /404|latest\.yml|Cannot find/i.test(s.message || '')) {
    /* 尚未发过 Release 时很常见，不打扰用户 */
  } else if (s.state === 'error') {
    console.warn('[update]', s.message);
  }
});

/* controls */
$('#btnPlay').onclick = togglePlay;
$('#btnNext').onclick = () => next();
$('#btnPrev').onclick = prev;
$('#btnShuffle').onclick = () => setShuffle(!player.shuffle);
$('#btnRepeat').onclick = () => {
  player.repeat = { off: 'all', all: 'one', one: 'off' }[player.repeat];
  updateControls();
  renderQueue();
  saveSession();
};
$('#btnLcdFav').onclick = () => current() && toggleFav([current()]);
$('#btnWatch').onclick = () => (current() ? openOriginalVideo(current()) : toast('先播放一首歌'));
$('#npWatch')?.addEventListener('click', () => (current() ? openOriginalVideo(current()) : toast('先播放一首歌')));
$('#btnDownload').onclick = (e) => {
  const t = current();
  if (!t) return toast('先播放一首歌');
  const r = e.currentTarget.getBoundingClientRect();
  showMenu(r.left - 40, r.bottom + 6, [
    { label: '仅下载音频 (.m4a)', icon: 'download', action: () => downloadTrack(t, 'audio') },
    { label: '下载原视频 (.mp4)', icon: 'video', action: () => downloadTrack(t, 'video') },
  ]);
};
$('#npDownload')?.addEventListener('click', (e) => {
  const t = current();
  if (!t) return toast('先播放一首歌');
  const r = e.currentTarget.getBoundingClientRect();
  showMenu(r.left - 40, r.top - 90, [
    { label: '仅下载音频 (.m4a)', icon: 'download', action: () => downloadTrack(t, 'audio') },
    { label: '下载原视频 (.mp4)', icon: 'video', action: () => downloadTrack(t, 'video') },
  ]);
});
$('#lcdCover').onclick = () => openNp();
$('.lcd-text').onclick = () => openNp();

/* ================= now playing view ================= */
const np = $('#np');
let npOpen = false;
let lrc = { id: null, lines: [], plain: '', match: null, query: '', loading: false, idx: -1 };
let lrcUserScroll = 0;
const lyricsCache = new Map();
const colorCache = new Map();

function openNp() {
  if (!current()) return;
  npOpen = true;
  hideMenu();
  np.classList.add('show');
  $$('.marquee', np).forEach(fitMarquee);
  applyNpTheme();
  renderLyrics();
  requestAnimationFrame(tickLyrics);
}
function closeNp() {
  npOpen = false;
  np.classList.remove('show');
  api.overlay('#ffffff', '#555555');
}
$('#npClose').onclick = closeNp;

function updateNp() {
  const t = current();
  if (!t) return npOpen && closeNp();
  setMarquee($('#npTitle'), t.title);
  setMarquee($('#npArtist'), [t.artist, t.album].filter(Boolean).join(' — '));
  setMarquee($('#npMiniTitle'), `${t.title} - ${t.artist}`);
  $('#npLabel').style.backgroundImage = `url('${coverSrc(t.cover, 300)}')`;
  applyNpBackground(t);
  $('#npFav').classList.toggle('on', isFav(t.id));
  if (npOpen) applyNpTheme();
  loadLyrics(t);
  loadDanmaku(t);
}

function coverColor(url) {
  if (!url) return Promise.resolve(null);
  if (colorCache.has(url)) return colorCache.get(url);
  const p = new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 24;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, 24, 24);
        const d = ctx.getImageData(0, 0, 24, 24).data;
        let r = 0, g = 0, b = 0, wsum = 0;
        for (let i = 0; i < d.length; i += 4) {
          const mx = Math.max(d[i], d[i + 1], d[i + 2]);
          const mn = Math.min(d[i], d[i + 1], d[i + 2]);
          const w = (mx - mn) / 255 + 0.08;
          r += d[i] * w;
          g += d[i + 1] * w;
          b += d[i + 2] * w;
          wsum += w;
        }
        resolve([r / wsum, g / wsum, b / wsum]);
      } catch (_) {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = thumb(url, 48);
  });
  colorCache.set(url, p);
  return p;
}

function rgbToHsl([r, g, b]) {
  r /= 255;
  g /= 255;
  b /= 255;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l * 100];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s * 100, l * 100];
}
function hslToHex(h, s, l) {
  s /= 100;
  l /= 100;
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

async function applyNpTheme() {
  const t = current();
  const rgb = t && (await coverColor(t.cover));
  if (!npOpen || current() !== t) return;
  const [h, s] = rgb ? rgbToHsl(rgb) : [240, 6];
  const sat = Math.min(s, 55);
  const top = hslToHex(h, sat, 24);
  np.style.setProperty('--np-bg', `linear-gradient(180deg, ${top} 0%, ${hslToHex((h + 20) % 360, sat, 16)} 55%, ${hslToHex(h, sat, 8)} 100%)`);
  api.overlay(top, '#ffffff');
}

/* lyrics */
const lyricOffset = () => lib.lyricOffsets?.[current()?.id] || 0;

async function loadLyrics(t) {
  if (lrc.id === t.id) return;
  const id = t.id;
  lrc = { id, lines: [], plain: '', match: null, query: '', loading: true, idx: -1 };
  renderLyrics();
  let res = lyricsCache.get(id);
  if (!res) {
    try {
      if (isPluginTrack(t) && api.sourceLyric) {
        const pluginLrc = await api.sourceLyric(t);
        if (pluginLrc && (pluginLrc.lines?.length || pluginLrc.plain)) {
          res = pluginLrc;
        }
      }
      if (!res) {
        const plain = { title: t.title, artist: t.artist, album: t.album, duration: t.duration };
        res = await api.findLyrics(plain, lib.lyricPicks?.[id] || null);
      }
      lyricsCache.set(id, res);
    } catch (e) {
      res = { lines: [], query: t.title, error: errMsg(e) };
    }
  }
  if (lrc.id !== id) return;
  lrc = { id, lines: res.lines || [], plain: res.plain || '', match: res.match, query: res.query || t.title, loading: false, idx: -1 };
  renderLyrics();
}

function renderLyrics() {
  const box = $('#npLyrics');
  if (lrc.loading) box.innerHTML = '<div class="lrc-empty">正在查找歌词…</div>';
  else if (lrc.lines.length)
    box.innerHTML =
      '<div class="lrc-pad"></div>' +
      lrc.lines
        .map((l, i) =>
          l.text
            ? `<div class="lrc-line" data-li="${i}"><div class="lrc-orig">${esc(l.text)}</div>${l.tr ? `<div class="lrc-trans">${esc(l.tr)}</div>` : ''}</div>`
            : `<div class="lrc-line gap" data-li="${i}"></div>`,
        )
        .join('') +
      '<div class="lrc-pad"></div>';
  else if (lrc.plain) box.innerHTML = `<div class="lrc-plain">${esc(lrc.plain.replace(/\[[^\]]*\]/g, ''))}</div>`;
  else box.innerHTML = `<div class="lrc-empty">没有找到歌词<div><button class="np-chip" data-lrc-search>手动搜索歌词</button></div></div>`;
  const m = lrc.match;
  $('#npLrcSource').textContent = m
    ? `歌词：${m.name} - ${(m.artists || []).join(' / ')}（${m.source === 'netease' ? '网易云' : m.source === 'plugin' ? '插件' : 'LRCLIB'}）`
    : '';
  const off = lyricOffset();
  $('#npOffset').textContent = `偏移 ${off > 0 ? '+' : ''}${off}s`;
  lrc.idx = -1;
  box.scrollTop = 0;
}

function tickLyrics() {
  if (!npOpen) return;
  if (lrc.lines.length) {
    const t = audio.currentTime - lyricOffset() + 0.15;
    let idx = -1;
    for (let i = 0; i < lrc.lines.length && lrc.lines[i].t <= t; i++) idx = i;
    if (idx !== lrc.idx) {
      const box = $('#npLyrics');
      $('.lrc-line.on', box)?.classList.remove('on');
      const el = $(`.lrc-line[data-li="${idx}"]`, box);
      if (el) {
        el.classList.add('on');
        if (Date.now() - lrcUserScroll > 3000)
          box.scrollTo({ top: el.offsetTop - box.clientHeight / 2 + el.offsetHeight / 2, behavior: lrc.idx < 0 ? 'auto' : 'smooth' });
      }
      lrc.idx = idx;
    }
  }
  requestAnimationFrame(tickLyrics);
}

$('#npLyrics').addEventListener('wheel', () => (lrcUserScroll = Date.now()), { passive: true });
$('#npLyrics').addEventListener('click', (e) => {
  if (e.target.closest('[data-lrc-search]')) return searchLyrics();
  const line = e.target.closest('.lrc-line[data-li]');
  if (!line) return;
  lrcUserScroll = 0;
  seekTo(Math.max(0, lrc.lines[Number(line.dataset.li)].t + lyricOffset()));
  if (audio.paused) togglePlay();
});

function setLyricOffset(delta) {
  const t = current();
  if (!t) return;
  lib.lyricOffsets ||= {};
  const v = Math.round((lyricOffset() + delta) * 10) / 10;
  if (v) lib.lyricOffsets[t.id] = v;
  else delete lib.lyricOffsets[t.id];
  save();
  $('#npOffset').textContent = `偏移 ${v > 0 ? '+' : ''}${v}s`;
  lrc.idx = -2;
}
$('#npOffMinus').onclick = () => setLyricOffset(-0.5);
$('#npOffPlus').onclick = () => setLyricOffset(0.5);
$('#npLrcSearch').onclick = () => searchLyrics();

/* ================= Bilibili danmaku (original XML pool) ================= */
const DM_MAX = 28; // hard cap; actual lanes follow danmaku band height
const DM_LANE_H = 22;
const dmCache = new Map();
let dm = { cid: null, list: [], cursor: 0, enabled: true, lanes: [] };
const dmBox = () => $('#npDanmaku');

function dmMaxOnScreen() {
  const box = dmBox();
  const h = Math.max(48, box?.clientHeight || 100);
  return Math.max(1, Math.min(DM_MAX, Math.floor((h - 6) / DM_LANE_H)));
}

function colorCss(n) {
  const c = (n >>> 0) & 0xffffff;
  return `#${c.toString(16).padStart(6, '0')}`;
}

function clearDanmakuDom() {
  const box = dmBox();
  if (box) box.innerHTML = '';
  dm.lanes = [];
}

function setDanmakuEnabled(on) {
  dm.enabled = !!on;
  lib.settings.danmaku = dm.enabled;
  save();
  $('#npDmToggle')?.classList.toggle('on', dm.enabled);
  const box = dmBox();
  box?.classList.toggle('off', !dm.enabled);
  if (!dm.enabled) clearDanmakuDom();
  else dm.cursor = 0;
}

async function loadDanmaku(t) {
  const box = dmBox();
  if (!box) return;
  $('#npDmToggle')?.classList.toggle('on', dm.enabled);
  box.classList.toggle('off', !dm.enabled);
  if (!t?.cid) {
    dm = { ...dm, cid: null, list: [], cursor: 0 };
    clearDanmakuDom();
    return;
  }
  if (dm.cid === t.cid && dm.list.length) {
    dm.cursor = 0;
    clearDanmakuDom();
    return;
  }
  dm.cid = t.cid;
  dm.list = [];
  dm.cursor = 0;
  clearDanmakuDom();
  try {
    let list = dmCache.get(t.cid);
    if (!list) {
      list = await api.danmaku(t.cid);
      dmCache.set(t.cid, list);
      if (dmCache.size > 40) dmCache.delete(dmCache.keys().next().value);
    }
    if (dm.cid !== t.cid) return;
    dm.list = list || [];
    // jump cursor near current playhead so mid-song open doesn't dump intro barrage
    const now = audio.currentTime || 0;
    let i = 0;
    while (i < dm.list.length && dm.list[i].t < now - 0.2) i++;
    dm.cursor = i;
  } catch (_) {
    dm.list = [];
  }
}

/** Pick a free lane; null if all busy (no overlap). */
function pickDmLane(durationSec, textLen) {
  const now = performance.now();
  const maxLanes = dmMaxOnScreen();
  if (!dm.lanes.length || dm.lanes.length !== maxLanes) {
    const prev = dm.lanes;
    dm.lanes = Array.from({ length: maxLanes }, (_, i) => prev[i] || 0);
  }
  const vw = window.innerWidth || 1200;
  const approxW = Math.min(vw * 0.85, Math.max(72, (textLen || 4) * 15));
  // Next bullet may enter only after previous has cleared enough horizontal gap
  const clearFrac = Math.min(0.62, (approxW + 56) / (vw + approxW + 1));
  const occupyMs = Math.max(420, durationSec * 1000 * clearFrac);

  for (let i = 0; i < maxLanes; i++) {
    if (dm.lanes[i] <= now) {
      dm.lanes[i] = now + occupyMs;
      return 4 + i * DM_LANE_H;
    }
  }
  return null;
}

/** @returns {boolean} whether a danmaku was shown */
function spawnDanmaku(item) {
  if (!dm.enabled || !npOpen || !item?.text) return false;
  const box = dmBox();
  if (!box || box.classList.contains('off')) return false;
  if (box.childElementCount >= dmMaxOnScreen()) return false;

  const dur = Math.max(6.5, Math.min(11, 7.5 + item.text.length * 0.07));
  const isFixed = item.mode === 4 || item.mode === 5;
  const top = pickDmLane(isFixed ? 3.2 : dur, item.text.length);
  if (top == null) return false;

  const el = document.createElement('div');
  el.className = 'np-dm';
  el.textContent = item.text;
  el.style.color = colorCss(item.color);
  el.style.top = `${top}px`;
  // Keep all styles inside the top band so lyrics/title stay clear
  if (isFixed) {
    el.classList.add('top');
    el.style.animation = 'none';
    el.style.opacity = '0.92';
    box.appendChild(el);
    setTimeout(() => el.remove(), 3200);
    return true;
  }
  el.style.animationDuration = `${dur}s`;
  box.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
  return true;
}

function tickDanmaku() {
  if (!dm.enabled || !dm.list.length || audio.paused) return;
  const box = dmBox();
  if (!box || box.classList.contains('off')) return;
  const now = audio.currentTime || 0;
  // seek backwards → rewound cursor
  if (dm.cursor > 0 && dm.list[Math.min(dm.cursor, dm.list.length) - 1]?.t > now + 1) {
    let i = 0;
    while (i < dm.list.length && dm.list[i].t < now - 0.15) i++;
    dm.cursor = i;
    clearDanmakuDom();
  }
  let n = 0;
  const cap = dmMaxOnScreen();
  while (dm.cursor < dm.list.length && dm.list[dm.cursor].t <= now + 0.05 && n < cap) {
    if (box.childElementCount >= cap) break;
    const item = dm.list[dm.cursor];
    if (item.t < now - 0.35) {
      dm.cursor++;
      continue;
    }
    if (!spawnDanmaku(item)) break; // lanes full — wait next tick, don't overlap
    dm.cursor++;
    n++;
  }
}

$('#npDmToggle')?.addEventListener('click', () => setDanmakuEnabled(!dm.enabled));

async function searchLyrics() {
  const t = current();
  if (!t) return;
  let results = [];
  const run = async (m) => {
    const q = $('#lrcQ', m).value.trim();
    if (!q) return;
    $('#lrcList', m).innerHTML = '<div class="spinner"></div>';
    results = await api.searchLyrics(q);
    $('#lrcList', m).innerHTML = results.length
      ? results
          .map(
            (c, i) => `<div class="lrc-res" data-ci="${i}"><div class="grow"><div>${esc(c.name)}</div>
            <div class="hint">${esc(c.artists.join(' / '))}${c.album ? ' · ' + esc(c.album) : ''}</div></div>
            <span class="hint">${fmtTime(c.duration)}</span><span class="src">${c.source === 'netease' ? '网易云' : 'LRCLIB'}</span></div>`,
          )
          .join('')
      : '<div class="hint" style="padding:20px;text-align:center">没有结果，换个关键词试试</div>';
  };
  await openModal({
    title: '搜索歌词',
    wide: true,
    okText: '搜索',
    cancelText: '关闭',
    body: `<div class="field"><label>歌名 + 歌手</label><input id="lrcQ" value="${esc(lrc.query || t.title)}"></div>
      <div class="hint">当前歌曲：${esc(t.title)}，时长 ${fmtTime(t.duration)}。现场版可以优先选带 Live 的结果。</div>
      <div class="lrc-results" id="lrcList"></div>`,
    onOpen: (m) => {
      run(m);
      $('#lrcList', m).addEventListener('click', (e) => {
        const row = e.target.closest('[data-ci]');
        if (!row) return;
        const c = results[Number(row.dataset.ci)];
        lib.lyricPicks ||= {};
        lib.lyricPicks[t.id] = { source: c.source, id: c.id, name: c.name, artists: c.artists };
        save();
        lyricsCache.delete(t.id);
        lrc.id = null;
        loadLyrics(t);
        $('[data-m="cancel"]', m).click();
      });
    },
    onOk: async (m) => {
      await run(m);
      return false;
    },
  });
}

/* bottom bar */
const npCtl = {
  play: togglePlay,
  prev,
  next: () => next(),
  shuffle: () => setShuffle(!player.shuffle),
  repeat: () => $('#btnRepeat').onclick(),
};
$$('[data-ctl]', np).forEach((b) => (b.onclick = () => npCtl[b.dataset.ctl]()));
$('#npFav').onclick = () => current() && toggleFav([current()]);
$('#npMore').onclick = (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  trackMenu(r.left, r.top - 260, [current()], {});
};
$('#npQueue').onclick = () => {
  closeNp();
  setQueueOpen(true);
};
$('#npVolume').addEventListener('input', (e) => setVolume(e.target.value / 100));
$('#npVolIcon').addEventListener('click', () => $('#volIcon').click());

const vol = $('#volume');
let lastVolume = 0.8;
function setVolume(v, persist = true) {
  v = Math.max(0, Math.min(1, v));
  masterVol = v * v;
  applyVolumes();
  for (const el of [vol, $('#npVolume')]) {
    el.value = Math.round(v * 100);
    setRange(el, v);
  }
  $('#volIcon').innerHTML = $('#npVolIcon').innerHTML = icon(v === 0 ? 'mute' : 'volume');
  if (persist && lib) {
    lib.settings.volume = v;
    save();
  }
}
vol.addEventListener('input', () => setVolume(vol.value / 100));
$('#volIcon').addEventListener('click', () => {
  if (Number(vol.value) > 0) {
    lastVolume = vol.value / 100;
    setVolume(0);
  } else setVolume(lastVolume || 0.8);
});
vol.addEventListener('wheel', (e) => setVolume(vol.value / 100 + (e.deltaY < 0 ? 0.05 : -0.05)), { passive: true });

/* ================= queue panel ================= */
function setQueueOpen(open) {
  const panel = $('#queuePanel');
  panel.classList.toggle('hidden', !open);
  $('#app').classList.toggle('queue-open', open);
  $('#btnQueue').classList.toggle('on', open);
  if (open) renderQueue();
}
$('#btnQueue').onclick = () => setQueueOpen($('#queuePanel').classList.contains('hidden'));
$('#btnCloseQueue').onclick = () => setQueueOpen(false);
$('#btnClearQueue').onclick = () => {
  const cur = current();
  player.queue = cur ? [cur] : [];
  player.index = cur ? 0 : -1;
  player.original = null;
  renderQueue();
  saveSession();
};
/* 窄屏浮层：点遮罩区域关闭 */
$('#content').addEventListener('click', (e) => {
  if (!$('#app').classList.contains('queue-open')) return;
  if (window.matchMedia('(max-width: 1100px)').matches) setQueueOpen(false);
});

function qItem(t, qi, isCur = false) {
  return `<div class="q-item ${isCur ? 'current' : ''}" data-qi="${qi}">
    <div class="t-cover" style="background-image:url('${esc(coverSrc(t.cover, 96))}')"></div>
    <div class="q-text"><div class="q-title">${esc(t.title)}</div><div class="q-sub">${esc(t.artist)}${isPluginTrack(t) ? ` · ${esc(t.platform)}` : ''}</div></div>
    <button class="t-more" data-qmore="${qi}">${icon('more')}</button>
  </div>`;
}

function renderQueue() {
  if ($('#queuePanel').classList.contains('hidden')) return;
  const cur = current();
  const upcoming = player.queue.slice(player.index + 1);
  $('#queueList').innerHTML =
    (cur ? `<div class="q-label">正在播放</div>${qItem(cur, player.index, true)}` : '') +
    `<div class="q-label">接下来${
      player.repeat === 'one' ? ' · 单曲循环' : ''
    }${player.repeat === 'all' ? ' · 列表循环' : ''}${player.shuffle ? ' · 随机' : ''}</div>` +
    (player.repeat === 'one'
      ? '<div class="hint" style="padding:8px">单曲循环中（优先于随机）</div>'
      : upcoming.length
        ? upcoming.map((t, k) => qItem(t, player.index + 1 + k)).join('')
        : '<div class="hint" style="padding:8px">没有更多歌曲</div>');
}

$('#queueList').addEventListener('click', (e) => {
  const more = e.target.closest('[data-qmore]');
  if (more) {
    const qi = Number(more.dataset.qmore);
    const r = more.getBoundingClientRect();
    trackMenu(r.left, r.bottom, [player.queue[qi]], { type: 'queue', qi });
    return;
  }
  const item = e.target.closest('[data-qi]');
  if (item) jumpTo(Number(item.dataset.qi));
});
$('#queueList').addEventListener('contextmenu', (e) => {
  const item = e.target.closest('[data-qi]');
  if (!item) return;
  e.preventDefault();
  const qi = Number(item.dataset.qi);
  trackMenu(e.clientX, e.clientY, [player.queue[qi]], { type: 'queue', qi });
});

function removeFromQueue(qi) {
  if (qi === player.index) return;
  const [t] = player.queue.splice(qi, 1);
  if (player.original) player.original = player.original.filter((x) => x !== t);
  if (qi < player.index) player.index--;
  renderQueue();
  saveSession();
}

/* ================= context menu ================= */
const menuEl = $('#ctxMenu');
let menuActions = [];

function buildMenu(items) {
  return items
    .filter(Boolean)
    .map((it) => {
      if (it.sep) return '<div class="menu-sep"></div>';
      const idx = menuActions.push(it.action) - 1;
      const sub = it.sub ? `<div class="menu submenu">${buildMenu(it.sub)}</div>` : '';
      return `<div class="menu-item ${it.danger ? 'danger' : ''}" ${it.sub ? '' : `data-mi="${idx}"`}>
        ${it.icon ? icon(it.icon) : '<span style="width:14px"></span>'}
        <span class="grow">${esc(it.label)}</span>${it.sub ? icon('chevron') : ''}${sub}</div>`;
    })
    .join('');
}

function showMenu(x, y, items) {
  menuActions = [];
  menuEl.innerHTML = buildMenu(items);
  menuEl.style.left = '0px';
  menuEl.style.top = '0px';
  menuEl.classList.remove('hidden');
  const r = menuEl.getBoundingClientRect();
  menuEl.style.left = `${Math.max(6, Math.min(x, innerWidth - r.width - 6))}px`;
  menuEl.style.top = `${Math.max(6, Math.min(y, innerHeight - r.height - 6))}px`;
  if (x + r.width * 2 > innerWidth) $$('.submenu', menuEl).forEach((s) => s.classList.add('left'));
}
function hideMenu() {
  menuEl.classList.add('hidden');
}
menuEl.addEventListener('click', (e) => {
  const it = e.target.closest('[data-mi]');
  if (!it) return;
  const fn = menuActions[Number(it.dataset.mi)];
  hideMenu();
  fn && fn();
});
document.addEventListener('mousedown', (e) => !menuEl.contains(e.target) && hideMenu(), true);
window.addEventListener('blur', hideMenu);
content.addEventListener('scroll', hideMenu, { passive: true });

function playlistSubItems(cb, excludeId) {
  const items = lib.playlists.filter((p) => p.id !== excludeId).map((pl) => ({ label: pl.name, icon: 'playlist', action: () => cb(pl) }));
  if (items.length) items.push({ sep: true });
  items.push({
    label: '新建歌单…',
    icon: 'plus',
    action: async () => {
      const pl = await promptPlaylist();
      if (pl) cb(pl);
    },
  });
  return items;
}

function trackMenu(x, y, tracks, ctx = {}) {
  const n = tracks.length;
  const one = n === 1;
  const t = tracks[0];
  const allFav = tracks.every((x) => isFav(x.id));
  showMenu(x, y, [
    ctx.type !== 'queue' && { label: one ? '播放' : `播放 ${n} 首`, icon: 'play', action: () => playList(tracks, 0) },
    ctx.type === 'queue' && ctx.qi !== player.index && { label: '播放', icon: 'play', action: () => jumpTo(ctx.qi) },
    ctx.type !== 'queue' && { label: '下一首播放', icon: 'queueNext', action: () => insertNext(tracks) },
    ctx.type !== 'queue' && { label: '添加到待播清单', icon: 'list', action: () => appendQueue(tracks) },
    { sep: true },
    { label: one ? '添加到歌单' : `将 ${n} 首添加到歌单`, icon: 'playlist', sub: playlistSubItems((pl) => addToPlaylist(pl, tracks), ctx.playlistId) },
    { label: allFav ? '取消喜爱' : '喜爱', icon: 'star', action: () => toggleFav(tracks) },
    one && !t.lazy && { label: '编辑歌曲信息…', icon: 'edit', action: () => editTrack(t) },
    one && current()?.id === t.id && { label: '版本：无缝 / 更换…', icon: 'versions', action: openVersionPanel },
    one &&
      current() &&
      current()?.id !== t.id && {
        label: '无缝衔接至此（Beta）',
        icon: 'shuffle',
        action: () => switchCrossTrackSeamless(t),
      },
    { sep: true },
    one && { label: '观看原视频', icon: 'video', action: () => openOriginalVideo(t) },
    one && {
      label: '下载',
      icon: 'download',
      sub: [
        { label: '仅下载音频 (.m4a)', icon: 'download', action: () => downloadTrack(t, 'audio') },
        { label: '下载原视频 (.mp4)', icon: 'video', action: () => downloadTrack(t, 'video') },
      ],
    },
    one && { label: '在 B 站打开', icon: 'external', action: () => api.open(trackUrl(t)) },
    one && {
      label: '复制链接',
      icon: 'link',
      action: () => {
        navigator.clipboard.writeText(trackUrl(t));
        toast('已复制链接');
      },
    },
    ctx.playlistId && {
      label: one ? '从歌单中删除' : `从歌单中删除 ${n} 首`,
      icon: 'trash',
      danger: true,
      action: () => removeFromPlaylist(ctx.playlistId, tracks),
    },
    ctx.type === 'favorites' && {
      label: '从喜爱中移除',
      icon: 'trash',
      danger: true,
      action: () => toggleFav(tracks),
    },
    ctx.type === 'queue' &&
      ctx.qi !== player.index && { label: '从待播清单移除', icon: 'trash', danger: true, action: () => removeFromQueue(ctx.qi) },
  ]);
}

function plMenu(x, y, pl) {
  showMenu(x, y, [
    { label: '播放', icon: 'play', action: () => playList(pl.tracks, 0) },
    { label: '随机播放', icon: 'shuffle', action: () => playList(pl.tracks, Math.floor(Math.random() * pl.tracks.length), { shuffle: true }) },
    { sep: true },
    { label: '编辑歌单…', icon: 'edit', action: () => promptPlaylist(pl) },
    { label: '从链接 / BV 号导入…', icon: 'link', action: () => importLinks(pl) },
    { sep: true },
    { label: '删除歌单', icon: 'trash', danger: true, action: () => deletePlaylist(pl) },
  ]);
}

/* ================= modals ================= */
function openModal({ title, body, okText = '确定', cancelText = '取消', wide = false, onOk, onOpen }) {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `<div class="modal ${wide ? 'wide' : ''}">
      <div class="modal-head">${esc(title)}</div>
      <div class="modal-body">${body}</div>
      <div class="modal-foot">
        ${cancelText ? `<button class="pill-btn" data-m="cancel">${cancelText}</button>` : ''}
        <button class="pill-btn primary" data-m="ok">${okText}</button>
      </div></div>`;
    $('#modalRoot').appendChild(mask);
    let busy = false;
    const close = (v) => {
      mask.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const ok = async () => {
      if (busy) return;
      busy = true;
      const okBtn = $('[data-m="ok"]', mask);
      okBtn.disabled = true;
      try {
        const r = onOk ? await onOk(mask) : true;
        if (r !== false) return close(r === undefined ? true : r);
      } catch (e) {
        toast(errMsg(e), 'error');
      }
      okBtn.disabled = false;
      busy = false;
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (!busy) close(null);
      } else if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
        e.preventDefault();
        ok();
      }
    };
    document.addEventListener('keydown', onKey, true);
    mask.addEventListener('mousedown', (e) => e.target === mask && !busy && close(null));
    $('[data-m="ok"]', mask).onclick = ok;
    const cancel = $('[data-m="cancel"]', mask);
    if (cancel) cancel.onclick = () => !busy && close(null);
    onOpen?.(mask);
    const first = $('input:not([type=checkbox]), textarea', mask);
    if (first) {
      first.focus();
      first.select?.();
    }
  });
}

async function promptPlaylist(pl = null) {
  const res = await openModal({
    title: pl ? '编辑歌单' : '新建歌单',
    okText: pl ? '保存' : '创建',
    body: `<div class="field"><label>名称</label><input id="mName" value="${esc(pl?.name || '')}" placeholder="例如：Live 现场合集" maxlength="60"></div>
           <div class="field"><label>描述（可选）</label><textarea id="mDesc" rows="3" maxlength="300">${esc(pl?.desc || '')}</textarea></div>`,
    onOk: (m) => {
      const name = $('#mName', m).value.trim();
      if (!name) {
        $('#mName', m).focus();
        return false;
      }
      return { name, desc: $('#mDesc', m).value.trim() };
    },
  });
  if (!res) return null;
  if (pl) {
    Object.assign(pl, res);
    save();
    renderNav();
    renderView();
    return pl;
  }
  const created = createPlaylist(res.name, res.desc);
  toast(`已创建歌单「${created.name}」`);
  return created;
}

async function editTrack(t) {
  const res = await openModal({
    title: '编辑歌曲信息',
    okText: '保存',
    body: `<div class="field"><label>歌名</label><input id="mT" value="${esc(t.title)}"></div>
           <div class="field"><label>艺人</label><input id="mA" value="${esc(t.artist)}"></div>
           <div class="field"><label>专辑 / 来源</label><input id="mAl" value="${esc(t.album)}"></div>
           <div class="hint">修改只影响本地显示，会同步到所有包含这首歌的歌单。</div>`,
    onOk: (m) => ({ title: $('#mT', m).value.trim() || t.title, artist: $('#mA', m).value.trim(), album: $('#mAl', m).value.trim() }),
  });
  if (res) {
    versionCache.delete(t.id);
    updateTrackEverywhere(t.id, res);
    updateVersionBadge();
  }
}

async function pickPages(info) {
  const res = await openModal({
    title: `选择分 P · ${info.title}`,
    wide: true,
    okText: '添加选中',
    body: `<div class="pages-toolbar">
        <label class="page-row" style="padding:4px 0"><input type="checkbox" id="pkAll" checked> 全选</label>
        <span class="grow"></span><span class="hint" id="pkCount">已选 ${info.pages.length} / ${info.pages.length}</span>
      </div>
      <div class="field" style="margin-top:0"><input id="pkFilter" placeholder="筛选分 P 标题…"></div>
      <div id="pkList">${info.pages
        .map(
          (p) => `<label class="page-row" data-name="${esc(p.part.toLowerCase())}"><input type="checkbox" value="${p.page}" checked>
          <span class="p-no">P${p.page}</span><span class="p-name">${esc(p.part)}</span><span class="p-dur">${fmtTime(p.duration)}</span></label>`,
        )
        .join('')}</div>`,
    onOpen: (m) => {
      const boxes = $$('#pkList input', m);
      const update = () => {
        const n = boxes.filter((b) => b.checked).length;
        $('#pkCount', m).textContent = `已选 ${n} / ${boxes.length}`;
        $('#pkAll', m).checked = n === boxes.length;
      };
      $('#pkList', m).addEventListener('change', update);
      $('#pkAll', m).addEventListener('change', (e) => {
        boxes.forEach((b) => {
          if (b.closest('.page-row').style.display !== 'none') b.checked = e.target.checked;
        });
        update();
      });
      $('#pkFilter', m).addEventListener('input', (e) => {
        const q = e.target.value.trim().toLowerCase();
        $$('#pkList .page-row', m).forEach((r) => (r.style.display = !q || r.dataset.name.includes(q) ? '' : 'none'));
      });
    },
    onOk: (m) => {
      const sel = $$('#pkList input', m)
        .filter((b) => b.checked)
        .map((b) => Number(b.value));
      if (!sel.length) {
        toast('至少选择一个分 P');
        return false;
      }
      return sel;
    },
  });
  if (!res) return [];
  return info.pages.filter((p) => res.includes(p.page));
}

async function importLinks(pl) {
  await openModal({
    title: `导入到「${pl.name}」`,
    wide: true,
    okText: '导入',
    body: `<div class="field"><label>每行一个 B 站视频链接、BV 号或 av 号（支持 b23.tv 短链）</label>
      <textarea id="mLinks" rows="8" placeholder="https://www.bilibili.com/video/BV1xx411c7mD\nBV1GJ411x7h7?p=3"></textarea>
      <div class="hint">链接里带 ?p=N 的只导入那一 P，否则导入全部分 P。</div></div>
      <div class="hint" id="mProgress"></div>`,
    onOk: async (m) => {
      const lines = $('#mLinks', m)
        .value.split(/[\n\s,，]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (!lines.length) return false;
      const tracks = [];
      let failed = 0;
      for (let i = 0; i < lines.length; i++) {
        $('#mProgress', m).textContent = `正在解析 ${i + 1} / ${lines.length}…`;
        try {
          const ref = await api.resolve(lines[i]);
          if (!ref) throw new Error('无法识别');
          tracks.push(...(await resolveTracks(ref.bvid, { mode: 'all', page: ref.page })));
        } catch (_) {
          failed++;
        }
      }
      if (tracks.length) addToPlaylist(pl, tracks);
      if (failed) toast(`${failed} 个链接解析失败`, 'error');
      return true;
    },
  });
}

function eventToAccelerator(e) {
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return null;
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('CommandOrControl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  const map = {
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ' ': 'Space',
    Escape: 'Esc',
  };
  const key = map[e.key] || (e.key.length === 1 ? e.key.toUpperCase() : e.key);
  if (!key || parts.includes(key)) return null;
  parts.push(key);
  return parts.join('+');
}

function formatAccel(accel) {
  let t = String(accel || '')
    .replace(/[§$]*CTRL[§$]*/gi, 'Ctrl')
    .replace(/[§$]+/g, '')
    .replace(/CommandOrControl/gi, 'Ctrl')
    .replace(/Control/gi, 'Ctrl')
    .replace(/\++/g, '+')
    .replace(/^\+|\+$/g, '');
  if (!t) return '未设置';
  return t.replace(/Command/g, 'Cmd').replace(/\+/g, ' + ');
}

async function openSettings() {
  const xf = !!lib.settings.crossfade;
  const sec = lib.settings.crossfadeSec || 6;
  const seam = seamlessFadeSec();
  const gap = lib.settings.gapless !== false;
  const loud = lib.settings.loudNorm !== false;
  const dmOn = lib.settings.danmaku !== false;
  const scInfo = (await api.getShortcuts?.()) || { config: {}, actions: [], defaults: {} };
  const sc = { ...(scInfo.defaults || {}), ...(lib.settings.shortcuts || {}), ...(scInfo.config || {}) };
  let pluginState = { dir: '', list: [] };
  let sourceState = { dir: '', list: [] };
  try {
    pluginState = (await api.listPlugins?.()) || pluginState;
  } catch (_) {}
  try {
    sourceState = (await api.listSources?.()) || sourceState;
  } catch (_) {}

  const shortcutRows = (scInfo.actions || [])
    .map(
      (a) => `<div class="sc-row" data-sc="${a.id}">
        <div class="sc-label">${esc(a.label)}</div>
        <button type="button" class="sc-key" data-accel="${esc(sc[a.id] || '')}">${esc(formatAccel(sc[a.id] || scInfo.defaults?.[a.id]))}</button>
        <span class="sc-status hint">正常</span>
      </div>`,
    )
    .join('');

  const pluginRows = (pluginState.list || [])
    .map(
      (p) => `<div class="plugin-row" data-pid="${esc(p.id)}">
        <label class="check-row" style="margin:0"><input type="checkbox" class="plugin-on" ${p.enabled && !p.error ? 'checked' : ''} ${p.error ? 'disabled' : ''}>
          <span><b>${esc(p.name)}</b>${p.version ? ` · ${esc(p.version)}` : ''}<div class="hint">${esc(p.error || p.description || p.file)}</div></span>
        </label>
        <button type="button" class="link-btn plugin-del" data-pid="${esc(p.id)}">删除</button>
      </div>`,
    )
    .join('');

  const sourceRows = (sourceState.list || [])
    .map(
      (p) => `<div class="plugin-row" data-sid="${esc(p.id)}">
        <label class="check-row" style="margin:0"><input type="checkbox" class="source-on" ${p.enabled && !p.error ? 'checked' : ''} ${p.error ? 'disabled' : ''}>
          <span><b>${esc(p.platform)}</b>${p.version ? ` · ${esc(p.version)}` : ''}${p.author ? ` · ${esc(p.author)}` : ''}<div class="hint">${esc(p.error || (p.hasMedia ? '可搜索 / 播放' : p.file))}</div></span>
        </label>
        <button type="button" class="link-btn source-del" data-sid="${esc(p.id)}">删除</button>
      </div>`,
    )
    .join('');

  await openModal({
    title: '设置',
    wide: true,
    okText: '保存',
    body: `<div class="settings-tabs">
        <button type="button" class="settings-tab on" data-stab="play">播放</button>
        <button type="button" class="settings-tab" data-stab="keys">快捷键</button>
        <button type="button" class="settings-tab" data-stab="sources">音源</button>
        <button type="button" class="settings-tab" data-stab="plugins">扩展</button>
        <button type="button" class="settings-tab" data-stab="data">账号与数据</button>
      </div>
      <div class="settings-pane on" data-spane="play">
        <div class="field"><label>播放过渡（可选）</label>
          <label class="check-row"><input type="checkbox" id="mFade" ${xf ? 'checked' : ''}> 渐入渐出 · 切歌时两首重叠淡化</label>
          <div class="fade-row" id="mFadeRow" style="${xf ? '' : 'opacity:.45'}">
            <span class="hint">时长</span>
            <input type="range" id="mFadeSec" min="2" max="12" step="1" value="${sec}">
            <span id="mFadeVal">${sec} 秒</span>
          </div>
          <label class="check-row"><input type="checkbox" id="mGap" ${gap ? 'checked' : ''}> 无缝衔接 · 关闭渐入渐出时，提前预载下一首（几乎无间隙）</label>
          <label class="check-row"><input type="checkbox" id="mLoud" ${loud ? 'checked' : ''}> 音量平衡 · 自动把不同歌曲响度调到相近水平</label>
          <div class="fade-row" style="margin-top:10px">
            <span class="hint">无缝淡化时长</span>
            <input type="range" id="mSeamSec" min="1" max="8" step="0.1" value="${seam}">
            <span id="mSeamVal">${seam.toFixed(1)} 秒</span>
          </div>
          <label class="check-row"><input type="checkbox" id="mDm" ${dmOn ? 'checked' : ''}> 全屏播放页显示弹幕</label>
          <div style="display:flex;gap:10px;margin-top:10px;flex-wrap:wrap">
            <button class="pill-btn" type="button" id="mClearAnal">清除音频分析缓存</button>
            <button class="pill-btn" type="button" id="mClearStream">清除音流缓存</button>
          </div>
          <div class="hint" id="mVelouraHint" style="margin-top:8px">正在检测 Veloura 引擎…</div>
          <div class="hint">任务栏图标悬停可显示上一首 / 播放暂停 / 下一首（Windows）。</div>
        </div>
      </div>
      <div class="settings-pane" data-spane="keys">
        <div class="field">
          <label class="check-row"><input type="checkbox" id="mScOn" ${sc.enabled !== false ? 'checked' : ''}> 启用全局快捷键（应用在后台也能用）</label>
          <div class="hint">点击右侧按键可重新录制。多媒体键（播放/上一首/下一首）会一并启用。</div>
          <div class="sc-table">${shortcutRows || '<div class="hint">无法加载快捷键配置</div>'}</div>
          <button type="button" class="pill-btn" id="mScReset" style="margin-top:10px">恢复默认快捷键</button>
        </div>
      </div>
      <div class="settings-pane" data-spane="sources">
        <div class="field">
          <label>MusicFree 兼容音源</label>
          <div class="hint">协议对齐 <a href="#" id="mSrcDoc">MusicFree 插件文档</a>。安装社区 .js 音源后，可在搜索里用「B站+插件 / 仅插件音源」。请自行鉴别插件安全性；勿用于商业用途。</div>
          <div class="plugin-table" id="mSourceList">${sourceRows || '<div class="plugin-empty">还没有音源 —— 打开目录会写入「示例音源」</div>'}</div>
          <div style="display:flex;gap:10px;margin-top:10px;flex-wrap:wrap">
            <button type="button" class="pill-btn primary" id="mSourceAdd">添加音源插件</button>
            <button type="button" class="pill-btn" id="mSourceDir">打开音源目录</button>
          </div>
          <div class="hint" style="margin-top:8px">目录：${esc(sourceState.dir || '')}</div>
        </div>
      </div>
      <div class="settings-pane" data-spane="plugins">
        <div class="field">
          <label>脚本扩展接口</label>
          <div class="hint">本地 .js 扩展，接收切歌 / 播放状态回调（与音源插件分开）。VST 宿主暂未接入。</div>
          <div class="plugin-table" id="mPluginList">${pluginRows || '<div class="plugin-empty">还没有扩展 —— 可打开目录查看示例，或点「添加扩展」</div>'}</div>
          <div style="display:flex;gap:10px;margin-top:10px;flex-wrap:wrap">
            <button type="button" class="pill-btn primary" id="mPluginAdd">添加扩展</button>
            <button type="button" class="pill-btn" id="mPluginDir">打开扩展目录</button>
          </div>
          <div class="hint" style="margin-top:8px">目录：${esc(pluginState.dir || '')}</div>
        </div>
      </div>
      <div class="settings-pane" data-spane="data">
        <div class="field"><label>版本与更新</label>
          <div class="hint" id="mVerHint">当前版本：…</div>
          <div class="hint" id="mUpdateHint" style="margin-top:6px">更新状态：—</div>
          <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:8px">
            <button type="button" class="pill-btn primary" id="mCheckUpdate">检查更新</button>
            <button type="button" class="pill-btn" id="mOpenReleases">打开 GitHub Releases</button>
            <button type="button" class="pill-btn hidden" id="mInstallUpdate">重启并安装</button>
          </div>
        </div>
        <div class="field"><label>B 站 Cookie（可选）</label>
          <textarea id="mCookie" rows="3" placeholder="SESSDATA=xxxx; bili_jct=xxxx">${esc(lib.settings.cookie || '')}</textarea>
          <div class="hint">推荐直接点左下角「登录 B 站」。Cookie 只保存在本机。</div></div>
        <div class="field"><label>运行日志</label>
          <div class="hint">出错时可打开日志发给开发者。单文件约 2MB，最多保留 3 份备份，合计约 8MB，超过 14 天的旧备份会自动删。</div>
          <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:8px">
            <button type="button" class="pill-btn" id="mOpenLog">打开日志目录</button>
            <button type="button" class="pill-btn" id="mClearLog">清空日志</button>
          </div>
          <div class="hint" id="mLogPath" style="margin-top:8px">正在读取路径…</div>
        </div>
        <div class="field"><label>数据备份</label>
          <div style="display:flex;gap:10px">
            <button class="pill-btn" id="mExport">${icon('download')}导出歌单</button>
            <button class="pill-btn" id="mImport">${icon('plus')}从备份导入</button>
            <input type="file" id="mFile" accept=".json" class="hidden">
          </div></div>
      </div>`,
    onOpen: (m) => {
      const showTab = (id) => {
        $$('.settings-tab', m).forEach((t) => t.classList.toggle('on', t.dataset.stab === id));
        $$('.settings-pane', m).forEach((p) => p.classList.toggle('on', p.dataset.spane === id));
      };
      $$('.settings-tab', m).forEach((t) => (t.onclick = () => showTab(t.dataset.stab)));

      const sync = () => {
        const on = $('#mFade', m).checked;
        $('#mFadeRow', m).style.opacity = on ? '1' : '0.45';
        $('#mFadeVal', m).textContent = `${$('#mFadeSec', m).value} 秒`;
        const sv = Number($('#mSeamSec', m).value) || 2.5;
        $('#mSeamVal', m).textContent = `${sv.toFixed(1)} 秒`;
      };
      $('#mFade', m).onchange = sync;
      $('#mFadeSec', m).oninput = sync;
      $('#mSeamSec', m).oninput = sync;
      $('#mClearAnal', m).onclick = () => {
        clearAudioAnalysis();
        toast('已清除音频分析缓存');
      };
      $('#mClearStream', m).onclick = () => {
        player.cache.clear();
        toast('已清除音流缓存');
      };
      const paintUpdate = (s) => {
        const el = $('#mUpdateHint', m);
        const btn = $('#mInstallUpdate', m);
        if (!el) return;
        el.textContent = `更新状态：${s?.message || s?.state || '—'}`;
        if (btn) btn.classList.toggle('hidden', s?.state !== 'ready');
      };
      api.appVersion?.().then((v) => {
        const el = $('#mVerHint', m);
        if (el) el.textContent = `当前版本：${v || '?'}`;
      });
      api.updateStatus?.().then(paintUpdate);
      $('#mCheckUpdate', m).onclick = async () => {
        paintUpdate({ message: '正在检查更新…' });
        const s = await api.checkUpdate?.();
        paintUpdate(s);
        if (s?.state === 'latest') toast('已是最新版本');
        else if (s?.state === 'dev') toast(s.message || '开发模式不检查更新');
        else if (s?.state === 'error') toast(s.message || '检查失败', 'error');
        else if (s?.state === 'available' || s?.state === 'downloading') toast('发现新版本，正在下载…');
        else if (s?.state === 'ready') toast('更新已就绪，可重启安装');
      };
      $('#mOpenReleases', m).onclick = () => api.openReleases?.();
      $('#mInstallUpdate', m).onclick = () => api.installUpdate?.();

      api.logPaths?.().then((p) => {
        const el = $('#mLogPath', m);
        if (el) el.textContent = p?.file ? `当前：${p.file}` : '日志尚未初始化';
      });
      $('#mOpenLog', m).onclick = () => api.openLogDir?.();
      $('#mClearLog', m).onclick = async () => {
        await api.clearLogs?.();
        toast('日志已清空');
        const p = await api.logPaths?.();
        const el = $('#mLogPath', m);
        if (el && p?.file) el.textContent = `当前：${p.file}`;
      };
      const hint = $('#mVelouraHint', m);
      if (hint && api.velouraStatus) {
        api.velouraStatus().then((s) => {
          if (s?.ok) hint.textContent = `Veloura ${s.data?.veloura || ''} 就绪 · FFmpeg ${s.data?.ffmpeg ? '已内置' : '缺失'}`;
          else hint.textContent = `Veloura 未就绪：${s?.error || '请重新安装或运行 npm run prepare:veloura'}`;
        });
      }

      let capturing = null;
      const onCapture = (e) => {
        if (!capturing) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') {
          capturing.classList.remove('capturing');
          capturing = null;
          return;
        }
        const accel = eventToAccelerator(e);
        if (!accel) return;
        capturing.dataset.accel = accel;
        capturing.textContent = formatAccel(accel);
        capturing.classList.remove('capturing');
        capturing = null;
        document.removeEventListener('keydown', onCapture, true);
      };
      $$('.sc-key', m).forEach((btn) => {
        btn.onclick = () => {
          if (capturing) capturing.classList.remove('capturing');
          capturing = btn;
          btn.classList.add('capturing');
          btn.textContent = '按下快捷键…';
          document.addEventListener('keydown', onCapture, true);
        };
      });
      $('#mScReset', m).onclick = () => {
        const d = scInfo.defaults || {};
        $$('.sc-row', m).forEach((row) => {
          const id = row.dataset.sc;
          const btn = $('.sc-key', row);
          if (!btn || !d[id]) return;
          btn.dataset.accel = d[id];
          btn.textContent = formatAccel(d[id]);
        });
        toast('已恢复默认，保存后生效');
      };

      const refreshPlugins = async () => {
        const state = (await api.listPlugins?.()) || { list: [] };
        const box = $('#mPluginList', m);
        if (!box) return;
        box.innerHTML = (state.list || [])
          .map(
            (p) => `<div class="plugin-row" data-pid="${esc(p.id)}">
              <label class="check-row" style="margin:0"><input type="checkbox" class="plugin-on" ${p.enabled && !p.error ? 'checked' : ''} ${p.error ? 'disabled' : ''}>
                <span><b>${esc(p.name)}</b>${p.version ? ` · ${esc(p.version)}` : ''}<div class="hint">${esc(p.error || p.description || p.file)}</div></span>
              </label>
              <button type="button" class="link-btn plugin-del" data-pid="${esc(p.id)}">删除</button>
            </div>`,
          )
          .join('') || '<div class="plugin-empty">还没有扩展</div>';
      };
      const refreshSources = async () => {
        const state = (await api.listSources?.()) || { list: [] };
        const box = $('#mSourceList', m);
        if (!box) return;
        box.innerHTML = (state.list || [])
          .map(
            (p) => `<div class="plugin-row" data-sid="${esc(p.id)}">
              <label class="check-row" style="margin:0"><input type="checkbox" class="source-on" ${p.enabled && !p.error ? 'checked' : ''} ${p.error ? 'disabled' : ''}>
                <span><b>${esc(p.platform)}</b>${p.version ? ` · ${esc(p.version)}` : ''}${p.author ? ` · ${esc(p.author)}` : ''}<div class="hint">${esc(p.error || (p.hasMedia ? '可搜索 / 播放' : p.file))}</div></span>
              </label>
              <button type="button" class="link-btn source-del" data-sid="${esc(p.id)}">删除</button>
            </div>`,
          )
          .join('') || '<div class="plugin-empty">还没有音源</div>';
      };
      $('#mSrcDoc', m).onclick = (e) => {
        e.preventDefault();
        api.open('https://musicfree.catcat.work/plugin/protocol.html');
      };
      $('#mSourceAdd', m).onclick = async () => {
        const meta = await api.addSource?.();
        if (meta) {
          toast(`已添加音源 ${meta.platform}`);
          await refreshSources();
        }
      };
      $('#mSourceDir', m).onclick = () => api.openSourcesDir?.();
      $('#mSourceList', m).onclick = async (e) => {
        const del = e.target.closest('.source-del');
        if (del) {
          await api.removeSource?.(del.dataset.sid);
          toast('已删除音源');
          await refreshSources();
          return;
        }
        const on = e.target.closest('.source-on');
        if (on) {
          const row = on.closest('[data-sid]');
          await api.setSourceEnabled?.(row.dataset.sid, on.checked);
        }
      };
      $('#mPluginAdd', m).onclick = async () => {
        const meta = await api.addPlugin?.();
        if (meta) {
          toast(`已添加 ${meta.name}`);
          await refreshPlugins();
        }
      };
      $('#mPluginDir', m).onclick = () => api.openPluginsDir?.();
      $('#mPluginList', m).onclick = async (e) => {
        const del = e.target.closest('.plugin-del');
        if (del) {
          await api.removePlugin?.(del.dataset.pid);
          toast('已删除扩展');
          await refreshPlugins();
          return;
        }
        const on = e.target.closest('.plugin-on');
        if (on) {
          const row = on.closest('[data-pid]');
          await api.setPluginEnabled?.(row.dataset.pid, on.checked);
        }
      };

      $('#mExport', m).onclick = () => {
        const blob = new Blob([JSON.stringify({ playlists: lib.playlists, favorites: lib.favorites }, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `bili-music-backup-${fmtDate(Date.now() / 1000)}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      };
      $('#mImport', m).onclick = () => $('#mFile', m).click();
      $('#mFile', m).onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
          const data = JSON.parse(await file.text());
          let n = 0;
          for (const p of data.playlists || []) {
            if (!p?.name || !Array.isArray(p.tracks)) continue;
            lib.playlists.push({ ...p, id: getPl(p.id) ? uid() : p.id || uid() });
            n++;
          }
          for (const t of data.favorites || []) if (t?.id && !isFav(t.id)) lib.favorites.push(t);
          save();
          renderNav();
          renderView();
          toast(`已导入 ${n} 个歌单`);
        } catch (err) {
          toast('备份文件格式不正确', 'error');
        }
      };
    },
    onOk: async (m) => {
      document.removeEventListener('keydown', () => {}, true);
      const cookie = $('#mCookie', m).value.trim();
      const changed = cookie !== (lib.settings.cookie || '');
      lib.settings.cookie = cookie;
      lib.settings.crossfade = $('#mFade', m).checked;
      lib.settings.crossfadeSec = Number($('#mFadeSec', m).value) || 6;
      lib.settings.seamlessSec = Math.max(1, Math.min(8, Number($('#mSeamSec', m).value) || 2.5));
      lib.settings.gapless = $('#mGap', m).checked;
      const dmOnSave = $('#mDm', m).checked;
      lib.settings.danmaku = dmOnSave;
      setDanmakuEnabled(dmOnSave);
      const loudOn = $('#mLoud', m).checked;
      if (loudOn !== (lib.settings.loudNorm !== false)) {
        lib.settings.loudNorm = loudOn;
        audioAnalysis.clear();
        for (const d of decks) d._trackGain = 1;
        if (current() && player.urls?.length) applyTrackLoudness(audio, current().id, player.urls);
        else applyVolumes();
      }

      const nextSc = { ...(scInfo.defaults || {}), enabled: $('#mScOn', m).checked };
      $$('.sc-row', m).forEach((row) => {
        const btn = $('.sc-key', row);
        if (btn?.dataset.accel) nextSc[row.dataset.sc] = btn.dataset.accel;
      });
      lib.settings.shortcuts = nextSc;
      const scResult = await api.applyShortcuts?.(nextSc);
      if (scResult?.failed?.length) {
        toast(`部分快捷键注册失败：${scResult.failed.map((f) => f.id).join('、')}`, 'error');
      }

      player.cache.clear();
      await api.save(lib);
      toast('设置已保存');
      if (changed) {
        await refreshAccount();
        loadHome();
        renderHomeIfVisible();
      }
    },
  });
}
$('#btnSettings').onclick = openSettings;
$('#btnSkin').onclick = openSkinPanel;

/* ================= skin / wallpaper ================= */
let skinDataUrl = null;

function skinOpacityPct() {
  const v = Number(lib?.settings?.skinOpacity);
  return Math.max(10, Math.min(100, Number.isFinite(v) ? v : 60));
}

function skinEnabled() {
  return !!(lib?.settings?.skinFile && lib.settings.skinEnabled !== false && skinDataUrl);
}

function skinOnNowPlaying() {
  return skinEnabled() && !!lib.settings.skinApplyNp;
}

function applySkinOpacityVar() {
  const a = skinOpacityPct() / 100;
  document.documentElement.style.setProperty('--skin-opacity', String(a));
  document.body.style.setProperty('--skin-opacity', String(a));
}

function applyNpBackground(t = current()) {
  const el = $('#npBgImg');
  if (!el) return;
  $('#np')?.classList.toggle('skin-np', skinOnNowPlaying());
  if (skinOnNowPlaying()) {
    el.style.backgroundImage = `url("${skinDataUrl}")`;
  } else if (t?.cover) {
    el.style.backgroundImage = `url('${thumb(t.cover, 200)}')`;
  } else {
    el.style.backgroundImage = '';
  }
}

function applySkinLayer() {
  const on = skinEnabled();
  applySkinOpacityVar();
  document.body.classList.toggle('has-skin', on);
  $('#btnSkin')?.classList.toggle('on', on);
  const layer = $('#skinLayer');
  if (layer) {
    layer.style.backgroundImage = on ? `url("${skinDataUrl}")` : '';
    layer.style.opacity = on ? '1' : '0';
  }
  applyNpBackground();
}

async function refreshSkin() {
  try {
    if (lib?.settings?.skinFile && lib.settings.skinEnabled !== false) {
      skinDataUrl = (await api.skinRead()) || skinDataUrl;
    } else if (!lib?.settings?.skinFile) {
      skinDataUrl = null;
    }
  } catch (e) {
    console.warn('skin read failed', e);
  }
  applySkinLayer();
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(fr.error || new Error('读取文件失败'));
    fr.readAsDataURL(file);
  });
}

async function openSkinPanel() {
  const hasFile = !!lib.settings?.skinFile;
  let previewUrl = skinDataUrl;
  if (hasFile && !previewUrl) {
    try {
      previewUrl = await api.skinRead();
      if (previewUrl) skinDataUrl = previewUrl;
    } catch (_) {}
  }
  const enabled = lib.settings.skinEnabled !== false && hasFile;
  const applyNp = !!lib.settings.skinApplyNp;
  const op = skinOpacityPct();
  await openModal({
    title: '自定义皮肤',
    okText: '完成',
    cancelText: '关闭',
    body: `
      <div class="hint" style="margin-bottom:10px">上传一张图片装饰主页。可选择是否同步到全屏播放页。</div>
      <div class="skin-preview ${previewUrl ? '' : 'empty'}" id="skinPreview" style="${previewUrl ? `background-image:url('${previewUrl}')` : ''}">${previewUrl ? '' : '还没有皮肤图片'}</div>
      <div class="skin-actions">
        <button class="pill-btn primary" type="button" id="skinPick">选择图片</button>
        <button class="pill-btn" type="button" id="skinClear" ${hasFile ? '' : 'disabled'}>清除皮肤</button>
        <input type="file" id="skinFile" accept="image/jpeg,image/png,image/webp,image/gif" hidden />
      </div>
      <label class="check-row"><input type="checkbox" id="skinEnabled" ${enabled ? 'checked' : ''} ${hasFile ? '' : 'disabled'}> 启用皮肤（装饰主页）</label>
      <label class="check-row"><input type="checkbox" id="skinApplyNp" ${applyNp ? 'checked' : ''} ${hasFile ? '' : 'disabled'}> 同时应用到播放页面</label>
      <div class="skin-opacity-row">
        <span>不透明度</span>
        <input type="range" id="skinOpacity" min="10" max="100" value="${op}" ${hasFile ? '' : 'disabled'} />
        <span id="skinOpacityVal">${op}%</span>
      </div>
      <div class="hint" style="margin-top:8px">100% 为完全显露原图（无白色遮罩）。建议横图 / 壁纸，最大 8MB；只保存在本机。</div>`,
    onOpen: (m) => {
      const preview = $('#skinPreview', m);
      const fileInput = $('#skinFile', m);
      const enabledEl = $('#skinEnabled', m);
      const applyNpEl = $('#skinApplyNp', m);
      const clearBtn = $('#skinClear', m);
      const opacityEl = $('#skinOpacity', m);
      const opacityVal = $('#skinOpacityVal', m);
      const setPreview = (url) => {
        if (url) {
          preview.classList.remove('empty');
          preview.style.backgroundImage = `url('${url}')`;
          preview.textContent = '';
        } else {
          preview.classList.add('empty');
          preview.style.backgroundImage = '';
          preview.textContent = '还没有皮肤图片';
        }
      };
      const syncOpacityUi = () => {
        const v = Number(opacityEl.value) || 60;
        opacityVal.textContent = `${v}%`;
        // 红条终点对准圆点中心（range 滑块行程会扣除 thumb 宽度）
        const thumb = 14;
        const track = Math.max(thumb + 1, opacityEl.clientWidth || 200);
        const t = thumb / track;
        const p = (Math.max(0, Math.min(100, v)) / 100) * (1 - t) + t / 2;
        opacityEl.style.setProperty('--p', `${(p * 100).toFixed(2)}%`);
      };
      syncOpacityUi();
      requestAnimationFrame(syncOpacityUi);
      $('#skinPick', m).onclick = () => fileInput.click();
      fileInput.onchange = async () => {
        const file = fileInput.files?.[0];
        fileInput.value = '';
        if (!file) return;
        if (!/^image\//.test(file.type)) return toast('请选择图片文件', 'error');
        if (file.size > 8 * 1024 * 1024) return toast('图片过大（最大 8MB）', 'error');
        try {
          toast('正在导入皮肤…');
          const dataUrl = await readFileAsDataUrl(file);
          const comma = dataUrl.indexOf(',');
          const dataBase64 = comma >= 0 ? dataUrl.slice(comma + 1) : '';
          if (!dataBase64) throw new Error('无法读取图片');
          const res = await api.skinSave({ dataBase64, mime: file.type || 'image/jpeg' });
          lib.settings.skinFile = res.file;
          lib.settings.skinEnabled = true;
          if (lib.settings.skinOpacity == null) lib.settings.skinOpacity = 60;
          save();
          skinDataUrl = dataUrl;
          setPreview(skinDataUrl);
          enabledEl.disabled = false;
          applyNpEl.disabled = false;
          opacityEl.disabled = false;
          enabledEl.checked = true;
          clearBtn.disabled = false;
          applySkinLayer();
          toast('皮肤已应用');
        } catch (e) {
          toast(errMsg(e), 'error');
        }
      };
      clearBtn.onclick = async () => {
        try {
          await api.skinClear();
          lib.settings.skinFile = '';
          lib.settings.skinEnabled = false;
          lib.settings.skinApplyNp = false;
          save();
          skinDataUrl = null;
          setPreview(null);
          enabledEl.checked = false;
          applyNpEl.checked = false;
          enabledEl.disabled = true;
          applyNpEl.disabled = true;
          opacityEl.disabled = true;
          clearBtn.disabled = true;
          applySkinLayer();
          toast('已清除皮肤');
        } catch (e) {
          toast(errMsg(e), 'error');
        }
      };
      enabledEl.onchange = () => {
        if (!lib.settings.skinFile) return;
        lib.settings.skinEnabled = enabledEl.checked;
        save();
        applySkinLayer();
      };
      applyNpEl.onchange = () => {
        lib.settings.skinApplyNp = applyNpEl.checked;
        save();
        applyNpBackground();
      };
      opacityEl.oninput = () => {
        syncOpacityUi();
        lib.settings.skinOpacity = Number(opacityEl.value) || 60;
        applySkinOpacityVar();
        applyNpBackground();
      };
      opacityEl.onchange = () => {
        lib.settings.skinOpacity = Number(opacityEl.value) || 60;
        save();
        applySkinLayer();
      };
    },
    onOk: async () => {
      await refreshSkin();
      return true;
    },
  });
}

/* ================= nav ================= */
function renderNav() {
  const item = (type, ic, label, extra = '', id = '') => {
    const active = view.type === type && (!id || view.id === id);
    return `<div class="nav-item ${active ? 'active' : ''}" data-view="${type}" ${id ? `data-id="${id}"` : ''}>${ic}<span class="label">${esc(label)}</span>${extra}</div>`;
  };
  $('#nav').innerHTML =
    item('home', icon('home'), '主页') +
    item('search', icon('bili'), '搜索 B 站') +
    `<div class="nav-section">资料库</div>` +
    item('recent', icon('clock'), '最近播放') +
    item('songs', icon('songs'), '歌曲') +
    item('favorites', icon('star'), '喜爱的歌曲') +
    `<div class="nav-section">歌单<button id="btnNewPl" title="新建歌单">${icon('plus')}</button></div>` +
    lib.playlists
      .map((pl) =>
        item('playlist', `<span class="mini-cover" style="background:${gradient(pl.id)}"></span>`, pl.name, `<span class="count">${pl.tracks.length}</span>`, pl.id),
      )
      .join('');
}

const nav = $('#nav');
nav.addEventListener('click', async (e) => {
  if (e.target.closest('#btnNewPl')) {
    const pl = await promptPlaylist();
    if (pl) navigate({ type: 'playlist', id: pl.id });
    return;
  }
  const it = e.target.closest('.nav-item');
  if (it) navigate({ type: it.dataset.view, id: it.dataset.id });
});
nav.addEventListener('contextmenu', (e) => {
  const it = e.target.closest('.nav-item[data-id]');
  if (!it) return;
  e.preventDefault();
  plMenu(e.clientX, e.clientY, getPl(it.dataset.id));
});
nav.addEventListener('dragover', (e) => {
  const it = e.target.closest('.nav-item[data-id]');
  if (!it || !dragState) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  $$('.drop-target', nav).forEach((x) => x !== it && x.classList.remove('drop-target'));
  it.classList.add('drop-target');
});
nav.addEventListener('dragleave', (e) => e.target.closest?.('.nav-item')?.classList.remove('drop-target'));
nav.addEventListener('drop', (e) => {
  const it = e.target.closest('.nav-item[data-id]');
  $$('.drop-target', nav).forEach((x) => x.classList.remove('drop-target'));
  if (!it || !dragState) return;
  e.preventDefault();
  addToPlaylist(getPl(it.dataset.id), dragState.tracks);
  dragState = null;
});

$('#sideSearch').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const kw = e.target.value.trim();
  if (!kw) return;
  search.keyword = kw;
  navigate({ type: 'search' });
  doSearch(1);
});

/* ================= views ================= */
let viewStack = [];
function navigate(v, { push = true } = {}) {
  if (push && view?.type && (view.type !== v.type || view.id !== v.id)) {
    viewStack.push({ type: view.type, id: view.id });
    if (viewStack.length > 40) viewStack.shift();
  }
  if (!push) {
    /* back */
  } else if (v.type === 'home') viewStack = [];
  view = v;
  renderNav();
  renderView(false);
}
function goBack() {
  const prev = viewStack.pop();
  if (prev) navigate(prev, { push: false });
  else navigate({ type: 'home' }, { push: false });
}
function backBtn() {
  return viewStack.length || view.type !== 'home'
    ? `<button class="back-btn" data-act="go-back" title="返回">${icon('chevronLeft')}<span>返回</span></button>`
    : '';
}

function renderView(keepScroll = true) {
  const st = content.scrollTop;
  switch (view.type) {
    case 'search':
      renderSearch();
      break;
    case 'playlist':
      renderPlaylist();
      break;
    case 'mix':
      renderMix();
      break;
    case 'history':
      renderHistory();
      break;
    case 'recent':
    case 'songs':
    case 'favorites':
      renderLibrary();
      break;
    default:
      renderHome();
  }
  content.scrollTop = keepScroll ? st : 0;
}

function rowHtml(t, i, favs) {
  const playing = isCurrentId(t.id);
  return `<div class="tr ${playing ? 'playing' : ''} ${table.selected.has(i) ? 'selected' : ''}" data-i="${i}" data-id="${esc(t.id)}" draggable="true">
    <span class="t-fav">${favs.has(t.id) ? icon('star') : ''}</span>
    <div class="t-main">
      <div class="t-cover" style="background-image:url('${esc(coverSrc(t.cover, 96))}')"><div class="play-hover">${playing ? eqHtml() : icon('play')}</div></div>
      <span class="t-title" title="${esc(t.title)}">${esc(t.title)}</span>
    </div>
    <span class="t-cell" title="${esc(t.artist)}">${esc(t.artist)}</span>
    <span class="t-cell" title="${esc(t.album)}">${esc(t.album || '—')}</span>
    <span class="t-dur">${fmtTime(t.duration)}</span>
    <button class="t-more" title="更多">${icon('more')}</button>
  </div>`;
}

function tracksHtml(tracks, ctx, emptyText = '这里还没有歌曲') {
  const sameTable = table.tracks === tracks;
  table = { tracks, ctx, selected: sameTable ? table.selected : new Set(), anchor: sameTable ? table.anchor : -1 };
  if (!tracks.length) return `<div class="empty">${icon('note')}${emptyText}</div>`;
  const favs = new Set(lib.favorites.map((t) => t.id));
  return `<div class="tracks">
    <div class="tr head"><span></span><span>歌曲</span><span>艺人 / UP 主</span><span>专辑 / 来源</span><span style="text-align:right">时长</span><span></span></div>
    ${tracks.map((t, i) => rowHtml(t, i, favs)).join('')}
  </div>`;
}

function headerHtml({ cover, name, sub, desc = '', right = '' }) {
  return `${backBtn()}<div class="pl-header">${cover}
    <div class="pl-meta">
      <div class="pl-name">${esc(name)}</div>
      <div class="pl-sub">${sub}</div>
      <div class="pl-desc">${esc(desc)}</div>
      <div class="pl-actions">
        <button class="circle-btn" data-act="shuffle" title="随机播放">${icon('shuffle')}</button>
        <button class="pill-btn primary" data-act="play">${icon('play')}播放</button>
        <span class="spacer"></span>${right}
      </div>
    </div></div>`;
}

const subLine = (tracks) => (tracks.length ? `${tracks.length} 首歌曲 · ${fmtTotal(tracks.reduce((s, t) => s + (t.duration || 0), 0))}` : '0 首歌曲');
const plCover = (pl) => `<div class="pl-cover" style="background:${gradient(pl.id)}"><div class="cover-name">${esc(pl.name)}</div></div>`;

function renderPlaylist() {
  const pl = getPl(view.id);
  if (!pl) return navigate({ type: 'home' });
  content.innerHTML = `<div class="page">
    ${headerHtml({
      cover: plCover(pl),
      name: pl.name,
      sub: subLine(pl.tracks),
      desc: pl.desc,
      right: `<button class="circle-btn" data-act="import" title="从链接导入">${icon('link')}</button>
              <button class="circle-btn" data-act="edit-pl" title="编辑">${icon('edit')}</button>
              <button class="circle-btn" data-act="pl-more" title="更多">${icon('more')}</button>`,
    })}
    ${tracksHtml(pl.tracks, { type: 'playlist', playlistId: pl.id }, '歌单是空的 —— 去「搜索 B 站」找些歌曲或 Live 添加进来吧')}
  </div>`;
}

const LIB_VIEWS = {
  recent: { name: '最近播放', icon: 'clock', grad: 'linear-gradient(150deg,#ffb199,#ff0844)' },
  songs: { name: '歌曲', icon: 'songs', grad: 'linear-gradient(150deg,#a1c4fd,#5b6cf9)' },
  favorites: { name: '喜爱的歌曲', icon: 'star', grad: 'linear-gradient(150deg,#ffd3a5,#fd6585)' },
};

function renderLibrary() {
  const cfg = LIB_VIEWS[view.type];
  let tracks;
  let empty = '这里还没有歌曲';
  if (view.type === 'recent') {
    tracks = historyTracks();
    empty = '还没有播放记录 —— 播一首歌后会出现在这里';
  } else if (view.type === 'songs') {
    tracks = allTracks().sort((a, b) => a.title.localeCompare(b.title, 'zh'));
  } else {
    tracks = lib.favorites;
    empty = '还没有喜爱的歌曲';
  }
  content.innerHTML = `<div class="page">
    ${headerHtml({
      cover: `<div class="pl-cover lib-cover" style="background:${cfg.grad}">${icon(cfg.icon, 'xl')}</div>`,
      name: cfg.name,
      sub: subLine(tracks),
      desc: view.type === 'recent' ? '按最近收听时间排列，相当于播放历史' : '',
    })}
    ${tracksHtml(tracks, { type: view.type }, empty)}
  </div>`;
}

/* ---------- home recommendations ---------- */
const home = { feed: [], feedPage: 1, feedLoading: false, feedError: '', because: [], ranking: [], mixes: {}, loaded: false, token: 0 };
const recLists = { feed: () => home.feed, rank: () => home.ranking, recent: () => recentTracks() };
const recentTracks = () => historyTracks().slice(0, 20);

const mesh = (c) =>
  `radial-gradient(at 18% 18%, ${c[1]} 0, transparent 55%), radial-gradient(at 85% 35%, ${c[2]} 0, transparent 55%), radial-gradient(at 40% 95%, ${c[3]} 0, transparent 60%), ${c[0]}`;

// 用 B 站音乐区搜索拼出来的主题歌单
const SEARCH_MIXES = {
  live: { title: 'Live 现场精选', caption: '现场', keyword: 'live 现场', max: 900 },
  fresh: { title: '新歌速递', caption: '最新发行', keyword: '官方MV', order: 'pubdate' },
  energy: { title: '能量充电', caption: '专属推荐', keyword: '燃曲 高燃', colors: ['#e0151b', '#ff9100', '#ff3d6e', '#ffcc00'] },
  relax: { title: '放松歌单', caption: '专属推荐', keyword: '放松 治愈 轻音乐', colors: ['#006d8f', '#00c2a8', '#2a7fff', '#0b3c5d'] },
  night: { title: '深夜听歌', caption: '专属推荐', keyword: '深夜 伤感', colors: ['#24123d', '#7b2ff7', '#d76d77', '#1a1a40'] },
};
const MIX_COLORS = {
  picks: ['#4a1bd6', '#ff4fa3', '#8a5bff', '#ff8a5b'],
  discover: ['#f6416c', '#ff9a9e', '#ff4b6e', '#c2185b'],
  loved: ['#ff6a00', '#ffb347', '#ff3d00', '#ffd27a'],
};

function seededRandom(seed) {
  let a = hashStr(seed);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function uniqTracks(list) {
  const seen = new Set();
  return list.filter((t) => t && !seen.has(t.id) && seen.add(t.id));
}
const artistsOf = (tracks) => {
  const names = [...new Set(tracks.map((t) => t.artist).filter(Boolean))];
  return names.slice(0, 8).join('、') + (names.length > 8 ? ' 等' : '');
};
function shortTitle(s) {
  const q = String(s).match(/[《「『]([^》」』]{1,30})[》」』]/);
  const t = q ? q[1] : String(s).replace(/【[^】]*】|\[[^\]]*\]/g, '').trim();
  return t.length > 18 ? t.slice(0, 18) + '…' : t;
}

function lazyTrack(r) {
  return { id: 'lazy_' + r.bvid, bvid: r.bvid, cid: 0, page: 1, title: r.title, artist: r.author, album: '', cover: r.cover, duration: r.duration, lazy: true };
}
const lazyCache = new WeakMap();
function lazyList(list) {
  if (!list) return [];
  if (!lazyCache.has(list)) lazyCache.set(list, list.map(lazyTrack));
  return lazyCache.get(list);
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}
/** 推荐里的视频还没取 cid，真正入库前先解析成正常歌曲（多 P 取第一 P） */
async function resolveLazy(tracks) {
  const out = await mapLimit(tracks, 4, async (t) => {
    if (!t.lazy) return t;
    try {
      const info = await getInfo(t.bvid);
      return makeTrack(info, info.pages[0]);
    } catch (_) {
      return null;
    }
  });
  return out.filter(Boolean);
}

let picksMemo = { key: '', tracks: [] };
function libraryPool() {
  return uniqTracks([...lib.favorites, ...allTracks(), ...lib.history]);
}
function getMix(id) {
  if (id === 'picks') {
    const pool = libraryPool();
    const key = `${new Date().toDateString()}|${pool.length}`;
    if (picksMemo.key !== key) {
      const rnd = seededRandom(key);
      const arr = pool.slice();
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      picksMemo = { key, tracks: arr.slice(0, 60) };
    }
    const tracks = picksMemo.tracks.length ? picksMemo.tracks : lazyList(home.feed);
    return { id, title: '你的精选集', big: '你的<br>精选集', caption: '专属推荐', tracks, art: 'mesh', colors: MIX_COLORS.picks };
  }
  if (id === 'loved') {
    const counts = lib.playCounts || {};
    let tracks = libraryPool()
      .filter((t) => counts[t.id])
      .sort((a, b) => counts[b.id] - counts[a.id])
      .slice(0, 50);
    if (tracks.length < 5) tracks = uniqTracks([...tracks, ...lib.favorites]);
    return { id, title: '爱不释耳', big: '爱不释耳', caption: '你最常听的歌', tracks, art: 'mesh', colors: MIX_COLORS.loved };
  }
  if (id === 'hot') return { id, title: '今日热门', big: '今日热门', caption: 'B 站音乐排行榜', tracks: lazyList(home.ranking), art: 'image' };
  if (id === 'discover')
    return { id, title: '音乐新发现', big: '音乐新发现', caption: '专属推荐', tracks: lazyList(home.mixes.discover), art: 'mesh', colors: MIX_COLORS.discover };
  if (id === 'feed') return { id, title: '为你推荐', big: '为你推荐', caption: '专属推荐', tracks: lazyList(home.feed), art: 'image' };
  if (/^b\d$/.test(id)) {
    const b = home.because[Number(id.slice(1))];
    if (!b) return null;
    const name = shortTitle(b.seed.title);
    return { id, title: `${name} 与相似歌曲`, big: name, caption: '因为你听过', tracks: lazyList(b.list), art: 'circles' };
  }
  const def = SEARCH_MIXES[id];
  if (!def) return null;
  return { id, title: def.title, big: def.title, caption: def.caption, tracks: lazyList(home.mixes[id]), art: def.colors ? 'mesh' : 'image', colors: def.colors };
}

async function loadSearchMix(key) {
  const token = home.token;
  const def = SEARCH_MIXES[key];
  try {
    const pages = await Promise.all(
      [1, 2].map((page) => api.search({ keyword: def.keyword, tids: 3, order: def.order || 'totalrank', page }).catch(() => ({ list: [] }))),
    );
    if (token !== home.token) return;
    const seen = new Set();
    home.mixes[key] = pages
      .flatMap((p) => p.list)
      .filter((v) => v.duration >= 60 && v.duration <= (def.max || 720) && !seen.has(v.bvid) && seen.add(v.bvid))
      .slice(0, 40);
    renderHomeIfVisible();
  } catch (_) {}
}

async function loadDiscover() {
  const token = home.token;
  try {
    const pages = await Promise.all([api.feed(7), api.feed(8)]);
    if (token !== home.token) return;
    const seen = new Set(home.feed.map((v) => v.bvid));
    home.mixes.discover = pages.flat().filter((v) => !seen.has(v.bvid) && seen.add(v.bvid));
    renderHomeIfVisible();
  } catch (_) {}
}

function recLookup(key) {
  const [name, i] = key.split(':');
  const list = name.startsWith('b') ? home.because[Number(name.slice(1))]?.list : recLists[name]?.();
  return list?.[Number(i)];
}

async function loadFeed(page = 1) {
  const token = home.token;
  home.feedLoading = true;
  home.feedError = '';
  renderHomeIfVisible();
  try {
    const list = await api.feed(page);
    if (token !== home.token) return;
    home.feed = list;
    home.feedPage = page;
  } catch (e) {
    if (token === home.token) home.feedError = errMsg(e);
  }
  if (token !== home.token) return;
  home.feedLoading = false;
  renderHomeIfVisible();
}

async function loadBecause() {
  const token = home.token;
  const seeds = [];
  const seen = new Set();
  const push = (t) => {
    if (seeds.length < 2 && t?.bvid && !seen.has(t.bvid)) {
      seen.add(t.bvid);
      seeds.push(t);
    }
  };
  lib.history.forEach(push);
  if (seeds.length < 2 && account) {
    try {
      (await api.history()).forEach(push);
    } catch (_) {}
  }
  const results = await Promise.all(
    seeds.map((seed) =>
      api
        .related(seed.bvid)
        .then((list) => ({ seed, list: list.filter((v) => v.bvid !== seed.bvid).slice(0, 20) }))
        .catch(() => null),
    ),
  );
  if (token !== home.token) return;
  home.because = results.filter((r) => r?.list.length);
  renderHomeIfVisible();
}

async function loadRanking() {
  const token = home.token;
  try {
    const list = await api.ranking();
    if (token === home.token) home.ranking = list.filter((v) => v.duration >= 60 && v.duration <= 900);
  } catch (_) {}
  renderHomeIfVisible();
}

function loadHome() {
  home.token++;
  home.loaded = true;
  home.because = [];
  home.mixes = {};
  loadFeed(1);
  loadBecause();
  loadRanking();
  loadDiscover();
  Object.keys(SEARCH_MIXES).forEach(loadSearchMix);
}

function renderHomeIfVisible() {
  if (view.type === 'home') renderView();
}

function scardHtml(r, key) {
  return `<div class="vcard sq" data-rk="${key}">
    <div class="vcard-cover" style="background-image:url('${thumb(r.cover, 300)}')">
      <div class="vcard-hover">
        <button class="vc-btn big" data-act="vc-play" title="播放">${icon('play')}</button>
        <button class="vc-btn" data-act="vc-more" title="更多">${icon('more')}</button>
      </div>
    </div>
    <div class="card-title" title="${esc(r.title)}">${esc(r.title)}</div>
    <div class="card-sub">${esc(r.author || r.artist)}${r.play != null ? ` · ${fmtCount(r.play)} 播放` : ''}</div>
  </div>`;
}

function sectionHead(id, title, { sub = '', extra = '' } = {}) {
  return `<div class="section-title">${title}${sub ? `<span class="section-sub">${sub}</span>` : ''}<span class="grow"></span>${extra}
      <button class="circle-btn" data-act="shelf-prev" data-shelf="${id}">${icon('chevronLeft')}</button>
      <button class="circle-btn" data-act="shelf-next" data-shelf="${id}">${icon('chevron')}</button></div>`;
}

function shelfHtml(id, title, list, opts = {}) {
  return sectionHead(id, title, opts) + `<div class="shelf" data-shelf="${id}">${list.map((r, i) => scardHtml(r, `${id}:${i}`)).join('')}</div>`;
}

function mixArtHtml(mix, { foot = true } = {}) {
  const cover = mix.tracks.find((t) => t.cover)?.cover;
  let bg = '';
  let inner = '';
  if (mix.art === 'mesh') {
    bg = `background:${mesh(mix.colors)}`;
    inner = `<div class="fc-big center">${mix.big}</div>`;
  } else if (mix.art === 'circles') {
    const covers = [...new Set(mix.tracks.map((t) => t.cover).filter(Boolean))].slice(0, 3);
    bg = 'background:linear-gradient(160deg,#5a5a62,#2c2c30)';
    inner = covers.map((c, i) => `<span class="fc-circle c${i}" style="background-image:url('${thumb(c, 240)}')"></span>`).join('');
  } else {
    bg = cover ? `background-image:url('${thumb(cover, 400, 540)}')` : 'background:#444';
    inner = `<div class="fc-shade"></div><div class="fc-big top">${mix.big}</div>`;
  }
  const footHtml = foot
    ? `<div class="fc-foot"><div class="fc-cap">${esc(mix.caption)}</div><div class="fc-name">${esc(mix.title)}</div>
        <div class="fc-desc">${esc(artistsOf(mix.tracks))}</div></div>`
    : '';
  return `<div class="fc-art fc-${mix.art}" style="${bg}"><span class="fc-logo">${icon('bili')}bilibili</span>${inner}${footHtml}</div>`;
}

function fcardHtml(mix) {
  return `<div class="fcard" data-mix="${mix.id}">${mixArtHtml(mix)}
    <button class="vc-btn big fc-play" data-act="mix-play" title="播放">${icon('play')}</button></div>`;
}

function mixRowHtml(id, title, ids) {
  const mixes = ids.map(getMix).filter((m) => m && m.tracks.length);
  if (!mixes.length) return '';
  return sectionHead(id, title) + `<div class="shelf tall" data-shelf="${id}">${mixes.map(fcardHtml).join('')}</div>`;
}

function feedShelfHtml() {
  const opts = {
    sub: account ? `根据 ${esc(account.name)} 的 B 站兴趣` : '登录后按你的 B 站喜好推荐',
    extra: `<button class="pill-btn small" data-act="feed-refresh" ${home.feedLoading ? 'disabled' : ''}>${icon('refresh')}换一批</button>`,
  };
  if (home.feedLoading && !home.feed.length) return sectionHead('feed', '为你推荐', opts) + '<div class="spinner"></div>';
  if (home.feedError && !home.feed.length) return sectionHead('feed', '为你推荐', opts) + `<div class="hint">推荐加载失败：${esc(home.feedError)}</div>`;
  return shelfHtml('feed', '为你推荐', home.feed, opts).replace('class="shelf"', `class="shelf ${home.feedLoading ? 'loading' : ''}"`);
}

function recentPlaylists() {
  const ids = lib.recentPlaylists || [];
  const ordered = ids.map(getPl).filter(Boolean);
  // 还没播放记录时，用全部歌单兜底
  if (!ordered.length) return lib.playlists.slice(0, 12);
  const rest = lib.playlists.filter((p) => !ids.includes(p.id));
  return [...ordered, ...rest].slice(0, 16);
}

function recentShelfHtml() {
  const historyCard = `<div class="card sq-pl" data-act="open-history">
      <div class="pl-cover lib-cover" style="background:linear-gradient(150deg,#ff9a9e,#ff0844)">${icon('clock', 'xl')}</div>
      <div class="card-title">最近播放</div>
      <div class="card-sub">${lib.history.length ? `${lib.history.length} 首歌曲` : '还没有播放记录'}</div>
    </div>`;
  const pls = recentPlaylists()
    .map(
      (pl) => `<div class="card sq-pl" data-pl="${pl.id}">${plCover(pl)}
        <div class="card-title">${esc(pl.name)}</div><div class="card-sub">歌单 · ${pl.tracks.length} 首</div></div>`,
    )
    .join('');
  return (
    sectionHead('recent', '最近播放') +
    `<div class="shelf" data-shelf="recent">${historyCard}${pls}
      <div class="card new sq-pl" data-act="new-pl"><div class="pl-cover">${icon('plus')}</div><div class="card-title">新建歌单</div><div class="card-sub">&nbsp;</div></div></div>`
  );
}

function renderHistory() {
  const tracks = historyTracks();
  content.innerHTML = `<div class="page">
    ${headerHtml({
      cover: `<div class="pl-cover lib-cover" style="background:linear-gradient(150deg,#ff9a9e,#ff0844)">${icon('clock', 'xl')}</div>`,
      name: '最近播放',
      sub: subLine(tracks),
      desc: '按最近收听时间排列，相当于播放历史',
    })}
    ${tracksHtml(tracks, { type: 'history' }, '还没有播放记录 —— 搜一首歌开始听吧')}
  </div>`;
}

function renderMix() {
  const mix = getMix(view.id);
  if (!mix) return navigate({ type: 'home' });
  content.innerHTML = `<div class="page">
    ${headerHtml({
      cover: `<div class="pl-cover mix-cover">${mixArtHtml(mix, { foot: false })}</div>`,
      name: mix.title,
      sub: `${esc(mix.caption)} · ${subLine(mix.tracks)}`,
      desc: artistsOf(mix.tracks),
      right: `<button class="pill-btn" data-act="mix-save">${icon('plus')}存为歌单</button>`,
    })}
    ${tracksHtml(mix.tracks, { type: 'mix' }, '正在加载推荐…')}
  </div>`;
}

async function saveMix(mix) {
  toast(`正在保存「${mix.title}」…`);
  const tracks = await resolveLazy(mix.tracks);
  if (!tracks.length) return toast('保存失败', 'error');
  const pl = createPlaylist(mix.title, `${mix.caption} · ${new Date().toLocaleDateString()}`);
  addToPlaylist(pl, tracks);
}

function renderHome() {
  if (!home.loaded) loadHome();
  const scrolls = new Map($$('.shelf', content).map((s) => [s.dataset.shelf, s.scrollLeft]));
  const banner = account
    ? ''
    : `<div class="login-banner">${icon('bili', 'xl')}
        <div class="grow"><div class="lb-title">登录 B 站账号</div><div class="lb-sub">获取根据你的观看兴趣生成的音乐推荐，还能解锁更高音质</div></div>
        <button class="pill-btn primary" data-act="login">登录</button></div>`;
  content.innerHTML = `<div class="page">
    <div class="page-title">主页</div>
    ${banner}
    ${mixRowHtml('feature', '专属精选推荐', ['picks', 'hot', 'b0', 'live', 'fresh'])}
    ${feedShelfHtml()}
    ${recentShelfHtml()}
    ${home.because.map((b, k) => shelfHtml(`b${k}`, `因为你听过「${esc(shortTitle(b.seed.title))}」`, b.list)).join('')}
    ${home.ranking.length ? shelfHtml('rank', '音乐区热门', home.ranking, { sub: 'B 站音乐排行榜' }) : ''}
    ${mixRowHtml('mixes', '专属推荐歌单', ['energy', 'relax', 'night', 'discover', 'loved'])}
  </div>`;
  table = { tracks: [], ctx: null, selected: new Set(), anchor: -1 };
  $$('.shelf', content).forEach((s) => scrolls.has(s.dataset.shelf) && (s.scrollLeft = scrolls.get(s.dataset.shelf)));
}

/* ---------- account ---------- */
let account = null;

function renderUser() {
  const btn = $('#btnUser');
  btn.innerHTML = account
    ? `<span class="avatar" style="background-image:url('${account.face}@64w_64h_1c.webp')"></span>
       <span class="grow user-name">${esc(account.name)}</span>${account.vip ? '<span class="vip">大会员</span>' : ''}`
    : `<span class="avatar placeholder">${icon('user')}</span><span class="grow user-name">登录 B 站</span>`;
  btn.title = account ? `已登录：${account.name}` : '登录 B 站账号';
}

async function refreshAccount() {
  try {
    account = lib.settings.cookie ? await api.me() : null;
  } catch (_) {
    account = null;
  }
  renderUser();
}

async function login() {
  const cookie = await api.login();
  if (!cookie) return;
  lib.settings.cookie = cookie;
  await api.save(lib);
  player.cache.clear();
  await refreshAccount();
  if (!account) return toast('登录失败，请重试', 'error');
  toast(`欢迎回来，${account.name}`);
  loadHome();
  renderView();
}

async function logout() {
  lib.settings.cookie = '';
  await api.save(lib);
  await api.logout();
  player.cache.clear();
  account = null;
  renderUser();
  loadHome();
  renderView();
  toast('已退出登录');
}

$('#btnUser').onclick = () => {
  if (!account) return login();
  const r = $('#btnUser').getBoundingClientRect();
  showMenu(r.left, r.top - 100, [
    { label: '在 B 站打开个人空间', icon: 'external', action: () => api.open(`https://space.bilibili.com/${account.mid}`) },
    { label: '刷新推荐', icon: 'refresh', action: () => (loadHome(), renderView()) },
    { sep: true },
    { label: '退出登录', icon: 'logout', danger: true, action: logout },
  ]);
};

/* ---------- search view ---------- */
function renderSearch() {
  const s = search;
  const scopes = [
    { id: 'all', label: 'B站+插件' },
    { id: 'bili', label: '仅 B 站' },
    { id: 'plugins', label: '仅插件音源' },
  ];
  content.innerHTML = `<div class="page">
    ${backBtn()}
    <div class="page-title">搜索</div>
    <div class="search-bar">
      <div class="search-input">${icon('search')}<input id="searchInput" value="${esc(s.keyword)}" placeholder="歌名、歌手，或粘贴 BV / 链接；可搜插件音源" spellcheck="false"></div>
      <button class="pill-btn primary" data-act="do-search">搜索</button>
    </div>
    <div class="chips">
      ${scopes.map((x) => `<button class="chip ${s.scope === x.id ? 'on' : ''}" data-scope="${x.id}">${x.label}</button>`).join('')}
      <span class="sep"></span>
      ${MODES.map((m) => `<button class="chip ${s.mode === m.id ? 'on' : ''}" data-mode="${m.id}">${m.icon ? icon(m.icon) : ''}${m.label}</button>`).join('')}
      <span class="sep"></span>
      ${ORDERS.map((o) => `<button class="chip ${s.order === o.id ? 'on' : ''}" data-order="${o.id}">${o.label}</button>`).join('')}
      <span class="sep"></span>
      <button class="chip ${s.music ? 'on' : ''}" data-act="toggle-music">仅音乐区</button>
    </div>
    <div class="results">${resultsHtml()}</div>
  </div>`;
  if (!s.keyword) $('#searchInput').focus();
}

function resultsHtml() {
  const s = search;
  if (s.loading && !s.list.length) return '<div class="spinner"></div>';
  if (s.error && !s.list.length) return `<div class="empty">${icon('x')}搜索失败：${esc(s.error)}</div>`;
  if (!s.list.length)
    return s.done
      ? `<div class="empty">${icon('search')}没有找到相关结果</div>`
      : `<div class="empty">${icon('bili')}输入关键词搜索 B 站或插件音源<br>合集 / 多 P 会自动拆成单曲 · 设置里可安装 MusicFree 兼容插件</div>`;
  const rows = s.list
    .map((r, i) => {
      const plugin = r.kind === 'plugin' || !!r.platform;
      const author = r.author || r.artist || '';
      return `<div class="res" data-ri="${i}">
      <div class="res-cover" style="background-image:url('${esc(coverSrc(r.cover, 256, 144))}')">
        <span class="dur">${fmtTime(r.duration)}</span>
        <div class="play-hover" data-act="res-play" title="播放">${icon('play')}</div>
      </div>
      <div class="res-info">
        <div class="res-title" title="${esc(r.title)}">${esc(r.title)}</div>
        <div class="res-meta">
          ${plugin ? `<span class="src-badge">${esc(r.platform || '插件')}</span>` : ''}
          <span>${esc(author)}</span>
          ${r.album ? `<span title="${esc(r.album)}">${esc(r.album.length > 28 ? r.album.slice(0, 28) + '…' : r.album)}</span>` : ''}
          ${r.play != null && !r.album && !plugin ? `<span>播放 ${fmtCount(r.play)}</span>` : ''}
          ${r.pubdate && !r.album && !plugin ? `<span>${fmtDate(r.pubdate)}</span>` : ''}
          ${r.pages > 1 && r.page ? `<span>P${r.page}/${r.pages}</span>` : ''}
        </div>
      </div>
      <div class="res-actions">
        <button class="circle-btn" data-act="res-next" title="下一首播放">${icon('queueNext')}</button>
        <button class="circle-btn" data-act="res-add" title="添加到歌单">${icon('plus')}</button>
        ${plugin ? '' : `<button class="circle-btn" data-act="res-open" title="在 B 站打开">${icon('external')}</button>`}
      </div>
    </div>`;
    })
    .join('');
  const more = s.page < s.numPages ? (s.loading ? '<div class="spinner"></div>' : '<button class="pill-btn load-more" data-act="load-more">加载更多</button>') : '';
  return rows + more;
}

function renderResultsOnly() {
  const el = view.type === 'search' && $('.results', content);
  if (el) el.innerHTML = resultsHtml();
}

const LINK_RE = /BV[0-9A-Za-z]{10}|\bav\d+|b23\.tv\//i;
const searchHitKey = (r) => (r.kind === 'plugin' || r.platform ? `src_${r.platform}_${r.sourceId || r.id}` : `${r.bvid}_${r.cid || r.page || 0}`);

function pluginHitToTrack(r) {
  return {
    id: r.id || `src_${r.platform}_${r.sourceId}`,
    sourceId: r.sourceId || r.id,
    platform: r.platform,
    kind: 'plugin',
    title: r.title,
    artist: r.artist || r.author || '',
    album: r.album || '',
    cover: r.cover || '',
    duration: r.duration || 0,
    url: r.url || '',
    _raw: r._raw || r,
  };
}

/** 把多 P / 合集拆成单曲列表，方便直接点某一首 */
function singlesFromInfo(info, meta = {}) {
  if (!info) return [];
  const base = {
    author: info.author,
    play: meta.play,
    pubdate: meta.pubdate,
    mid: info.mid || meta.mid,
  };
  // 分 P 合集：每 P 一首
  if (info.pages?.length > 1) {
    return info.pages.map((p) => ({
      ...base,
      bvid: info.bvid,
      title: p.part || `P${p.page}`,
      cover: info.cover,
      duration: p.duration || 0,
      pages: info.pages.length,
      page: p.page,
      cid: p.cid,
      album: info.title,
    }));
  }
  // 视频合集（ugc season）：每集一首
  if (info.season?.episodes?.length > 1) {
    return info.season.episodes.map((ep, i) => ({
      ...base,
      bvid: ep.bvid,
      title: ep.title || `第 ${i + 1} 集`,
      author: ep.author || info.author,
      cover: ep.cover || info.cover,
      duration: ep.duration || 0,
      pages: 1,
      page: 1,
      cid: ep.cid,
      album: info.season.title,
    }));
  }
  const p = info.pages?.[0];
  return [
    {
      ...base,
      bvid: info.bvid,
      title: info.title,
      cover: info.cover,
      duration: p?.duration || info.duration || 0,
      pages: 1,
      page: p?.page || 1,
      cid: p?.cid,
    },
  ];
}

async function expandSearchHits(list) {
  const chunks = await mapLimit(list, 5, async (r) => {
    try {
      const info = await getInfo(r.bvid);
      return singlesFromInfo(info, r);
    } catch (_) {
      return [{ ...r, pages: r.pages || 1, page: r.page || 1 }];
    }
  });
  const out = [];
  const seen = new Set();
  for (const item of chunks.flat()) {
    const k = searchHitKey(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

async function doSearch(page = 1) {
  const kw = search.keyword.trim();
  if (!kw) return;
  const token = ++search.token;
  search.loading = true;
  search.error = '';
  if (page === 1) {
    search.list = [];
    search.page = 1;
    search.numPages = 0;
    content.scrollTop = 0;
  }
  renderResultsOnly();
  try {
    if (LINK_RE.test(kw) && search.scope !== 'plugins') {
      const ref = await api.resolve(kw);
      if (!ref) throw new Error('无法识别该链接');
      const info = await getInfo(ref.bvid);
      if (token !== search.token) return;
      // 粘贴合集链接：若指定了分 P 只显示该首，否则展开全部
      const all = singlesFromInfo(info);
      if (ref.page) {
        const one = all.filter((x) => x.page === ref.page);
        search.list = one.length ? one : all;
      } else search.list = all;
      search.numPages = 1;
    } else {
      let biliList = [];
      let biliPages = 0;
      const wantBili = search.scope !== 'plugins';
      const wantPlugins = search.scope !== 'bili' && page === 1;

      if (wantBili) {
        const mode = MODES.find((m) => m.id === search.mode);
        const r = await api.search({
          keyword: mode.suffix ? `${kw} ${mode.suffix}` : kw,
          page,
          order: search.order,
          tids: search.music ? 3 : 0,
        });
        if (token !== search.token) return;
        const expanded = await expandSearchHits(r.list || []);
        if (token !== search.token) return;
        biliList = expanded;
        biliPages = r.numPages || 0;
      }

      let pluginList = [];
      if (wantPlugins && api.sourceSearch) {
        try {
          const bags = await api.sourceSearch(kw, 1, 'music');
          if (token !== search.token) return;
          pluginList = (bags || []).flatMap((b) =>
            (b.list || []).map((x) => ({
              ...x,
              kind: 'plugin',
              author: x.artist || x.author || b.platform,
              cover: x.cover || '',
            })),
          );
        } catch (e) {
          if (!wantBili) throw e;
          toast(`插件搜索：${errMsg(e)}`, 'error');
        }
      }

      const merged = page === 1 ? [...pluginList, ...biliList] : biliList;
      const seen = new Set(page === 1 ? [] : search.list.map(searchHitKey));
      const fresh = merged.filter((x) => {
        const k = searchHitKey(x);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      search.list = page === 1 ? fresh : search.list.concat(fresh);
      search.page = page;
      search.numPages = wantBili ? biliPages : 1;
    }
  } catch (e) {
    if (token === search.token) search.error = errMsg(e);
  }
  if (token !== search.token) return;
  search.loading = false;
  search.done = true;
  if (search.error && search.list.length) toast(search.error, 'error');
  renderResultsOnly();
}

content.addEventListener(
  'scroll',
  () => {
    if (view.type !== 'search' || search.loading || search.page >= search.numPages) return;
    if (content.scrollTop + content.clientHeight > content.scrollHeight - 300) doSearch(search.page + 1);
  },
  { passive: true },
);

async function withResult(r, fn, opts) {
  try {
    if (r?.kind === 'plugin' || (r?.platform && !r?.bvid)) {
      const tracks = [pluginHitToTrack(r)];
      if (tracks.length) fn(tracks);
      return;
    }
    const tracks = await resolveTracks(r.bvid, { page: r.page, cid: r.cid, ...opts });
    if (tracks.length) fn(tracks);
  } catch (e) {
    toast(errMsg(e), 'error');
  }
}

function resultMenu(x, y, r) {
  const plugin = r?.kind === 'plugin' || (r?.platform && !r?.bvid);
  const items = [
    { label: '播放', icon: 'play', action: () => withResult(r, (t) => playList(t), { mode: 'all' }) },
    { label: '下一首播放', icon: 'queueNext', action: () => withResult(r, insertNext, { mode: 'all' }) },
    { label: '添加到待播清单', icon: 'list', action: () => withResult(r, appendQueue, { mode: 'all' }) },
    { sep: true },
    { label: '添加到歌单', icon: 'playlist', sub: playlistSubItems((pl) => withResult(r, (t) => addToPlaylist(pl, t))) },
  ];
  if (!plugin) {
    items.push(
      { sep: true },
      { label: '观看原视频', icon: 'video', action: () => openOriginalVideo(r) },
      {
        label: '下载',
        icon: 'download',
        sub: [
          { label: '仅下载音频 (.m4a)', icon: 'download', action: () => downloadTrack(r, 'audio') },
          { label: '下载原视频 (.mp4)', icon: 'video', action: () => downloadTrack(r, 'video') },
        ],
      },
      { label: '在 B 站打开', icon: 'external', action: () => api.open(trackUrl(r)) },
      { label: '搜索这位 UP 主', icon: 'search', action: () => setSearch(r.author) },
    );
  } else {
    items.push({ sep: true }, { label: `来源：${r.platform || '插件'}`, icon: 'list', action: () => {} });
  }
  showMenu(x, y, items);
}

function setSearch(kw) {
  search.keyword = kw;
  $('#sideSearch').value = kw;
  navigate({ type: 'search' });
  doSearch(1);
}

/* ---------- content events ---------- */
function paintSelection() {
  $$('.tr[data-i]', content).forEach((row) => row.classList.toggle('selected', table.selected.has(Number(row.dataset.i))));
}
const selectedTracks = () => [...table.selected].sort((a, b) => a - b).map((i) => table.tracks[i]).filter(Boolean);

content.addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  const pl = view.type === 'playlist' ? getPl(view.id) : null;
  const resEl = e.target.closest('.res');
  const vc = e.target.closest('.vcard');
  const r = resEl ? search.list[Number(resEl.dataset.ri)] : vc ? recLookup(vc.dataset.rk) : null;

  switch (act) {
    case 'login':
      return login();
    case 'go-back':
      return goBack();
    case 'open-history':
      return navigate({ type: 'history' });
    case 'feed-refresh':
      return loadFeed(home.feedPage + 1);
    case 'shelf-prev':
    case 'shelf-next': {
      const shelf = $(`.shelf[data-shelf="${e.target.closest('[data-shelf]').dataset.shelf}"]`, content);
      return shelf?.scrollBy({ left: (act === 'shelf-next' ? 1 : -1) * shelf.clientWidth * 0.9, behavior: 'smooth' });
    }
    case 'vc-play':
      return withResult(r, (t) => playList(t), { mode: 'all' });
    case 'mix-play': {
      const mix = getMix(e.target.closest('[data-mix]').dataset.mix);
      return mix && playList(mix.tracks, 0);
    }
    case 'mix-save':
      return saveMix(getMix(view.id));
    case 'vc-more': {
      const b = e.target.closest('button').getBoundingClientRect();
      return resultMenu(b.left, b.bottom + 4, r);
    }
    case 'play':
      return playList(table.tracks, 0);
    case 'shuffle':
      return playList(table.tracks, Math.floor(Math.random() * table.tracks.length), { shuffle: true });
    case 'import':
      return importLinks(pl);
    case 'edit-pl':
      return promptPlaylist(pl);
    case 'pl-more': {
      const b = e.target.closest('button').getBoundingClientRect();
      return plMenu(b.left, b.bottom + 4, pl);
    }
    case 'new-pl': {
      const created = await promptPlaylist();
      if (created) navigate({ type: 'playlist', id: created.id });
      return;
    }
    case 'do-search':
      search.keyword = $('#searchInput').value.trim();
      return doSearch(1);
    case 'toggle-music':
      search.music = !search.music;
      renderSearch();
      return doSearch(1);
    case 'load-more':
      return doSearch(search.page + 1);
    case 'res-play':
      return withResult(r, (t) => playList(t), { mode: 'all' });
    case 'res-next':
      return withResult(r, insertNext, { mode: 'all' });
    case 'res-open':
      return api.open(trackUrl(r));
    case 'res-add': {
      const b = e.target.closest('button').getBoundingClientRect();
      return showMenu(b.left - 140, b.bottom + 4, playlistSubItems((p) => withResult(r, (t) => addToPlaylist(p, t))));
    }
  }

  const chip = e.target.closest('[data-mode],[data-order],[data-scope]');
  if (chip) {
    if (chip.dataset.mode) search.mode = chip.dataset.mode;
    if (chip.dataset.order) search.order = chip.dataset.order;
    if (chip.dataset.scope) search.scope = chip.dataset.scope;
    search.keyword = $('#searchInput').value.trim();
    renderSearch();
    return doSearch(1);
  }

  const card = e.target.closest('.card[data-pl]');
  if (card) return navigate({ type: 'playlist', id: card.dataset.pl });
  const fcard = e.target.closest('.fcard[data-mix]');
  if (fcard) return navigate({ type: 'mix', id: fcard.dataset.mix });
  if (vc && e.target.closest('.vcard-cover')) return withResult(r, (t) => playList(t), { mode: 'all' });

  const row = e.target.closest('.tr[data-i]');
  if (!row) return;
  const i = Number(row.dataset.i);
  if (e.target.closest('.t-more')) {
    if (!table.selected.has(i)) {
      table.selected = new Set([i]);
      paintSelection();
    }
    const b = e.target.closest('.t-more').getBoundingClientRect();
    return trackMenu(b.left - 160, b.bottom, selectedTracks(), table.ctx);
  }
  if (e.target.closest('.play-hover')) {
    if (isCurrentId(table.tracks[i].id)) return togglePlay();
    return playList(table.tracks, i);
  }
  if (e.ctrlKey || e.metaKey) {
    table.selected.has(i) ? table.selected.delete(i) : table.selected.add(i);
  } else if (e.shiftKey && table.anchor >= 0) {
    table.selected = new Set();
    const [a, b] = [Math.min(table.anchor, i), Math.max(table.anchor, i)];
    for (let k = a; k <= b; k++) table.selected.add(k);
  } else {
    table.selected = new Set([i]);
  }
  if (!e.shiftKey) table.anchor = i;
  paintSelection();
});

content.addEventListener('dblclick', (e) => {
  const row = e.target.closest('.tr[data-i]');
  if (row && !e.target.closest('button')) return playList(table.tracks, Number(row.dataset.i));
  const res = e.target.closest('.res');
  if (res && !e.target.closest('button')) withResult(search.list[Number(res.dataset.ri)], (t) => playList(t), { mode: 'all' });
  const vc = e.target.closest('.vcard');
  if (vc && !e.target.closest('button')) withResult(recLookup(vc.dataset.rk), (t) => playList(t), { mode: 'all' });
});

content.addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.tr[data-i]');
  if (row) {
    e.preventDefault();
    const i = Number(row.dataset.i);
    if (!table.selected.has(i)) {
      table.selected = new Set([i]);
      table.anchor = i;
      paintSelection();
    }
    return trackMenu(e.clientX, e.clientY, selectedTracks(), table.ctx);
  }
  const res = e.target.closest('.res');
  if (res) {
    e.preventDefault();
    return resultMenu(e.clientX, e.clientY, search.list[Number(res.dataset.ri)]);
  }
  const vc = e.target.closest('.vcard');
  if (vc) {
    e.preventDefault();
    return resultMenu(e.clientX, e.clientY, recLookup(vc.dataset.rk));
  }
  const card = e.target.closest('.card[data-pl]');
  if (card) {
    e.preventDefault();
    plMenu(e.clientX, e.clientY, getPl(card.dataset.pl));
  }
});

content.addEventListener('keydown', (e) => {
  if (e.target.id === 'searchInput' && e.key === 'Enter') {
    search.keyword = e.target.value.trim();
    $('#sideSearch').value = search.keyword;
    doSearch(1);
  }
});

/* drag: reorder inside playlist, or drop onto sidebar playlist */
content.addEventListener('dragstart', (e) => {
  const row = e.target.closest('.tr[data-i]');
  if (!row) return;
  const i = Number(row.dataset.i);
  if (!table.selected.has(i)) {
    table.selected = new Set([i]);
    table.anchor = i;
    paintSelection();
  }
  const indices = [...table.selected].sort((a, b) => a - b);
  dragState = { indices, tracks: indices.map((k) => table.tracks[k]), ctx: table.ctx };
  e.dataTransfer.effectAllowed = 'copyMove';
  e.dataTransfer.setData('text/plain', dragState.tracks.map((t) => t.title).join('\n'));
});
content.addEventListener('dragover', (e) => {
  const row = e.target.closest('.tr[data-i]');
  if (!row || !dragState?.ctx?.playlistId || dragState.ctx.playlistId !== table.ctx?.playlistId) return;
  e.preventDefault();
  $$('.drag-over', content).forEach((x) => x !== row && x.classList.remove('drag-over'));
  row.classList.add('drag-over');
});
content.addEventListener('drop', (e) => {
  const row = e.target.closest('.tr[data-i]');
  $$('.drag-over', content).forEach((x) => x.classList.remove('drag-over'));
  if (!row || !dragState?.ctx?.playlistId) return;
  e.preventDefault();
  const pl = getPl(dragState.ctx.playlistId);
  const target = pl.tracks[Number(row.dataset.i)];
  const moving = dragState.indices.map((k) => pl.tracks[k]);
  const rest = pl.tracks.filter((_, k) => !dragState.indices.includes(k));
  let at = rest.indexOf(target);
  if (at < 0) at = rest.length;
  rest.splice(at, 0, ...moving);
  pl.tracks = rest;
  table.selected = new Set(moving.map((t) => rest.indexOf(t)));
  dragState = null;
  save();
  renderView();
});
document.addEventListener('dragend', () => {
  dragState = null;
  $$('.drag-over, .drop-target').forEach((x) => x.classList.remove('drag-over', 'drop-target'));
});

/* ================= keyboard ================= */
function shortcutConfig() {
  const d = {
    enabled: true,
    playPause: 'CommandOrControl+Alt+Space',
    prev: 'CommandOrControl+Alt+Left',
    next: 'CommandOrControl+Alt+Right',
    volUp: 'CommandOrControl+Alt+Up',
    volDown: 'CommandOrControl+Alt+Down',
    like: 'CommandOrControl+Alt+V',
  };
  return { ...d, ...(lib.settings?.shortcuts || {}), enabled: lib.settings?.shortcuts?.enabled !== false };
}

function eventMatchesAccel(e, accel) {
  if (!accel) return false;
  const parts = String(accel)
    .replace(/[§$]*CTRL[§$]*/gi, 'Ctrl')
    .replace(/[§$]+/g, '')
    .replace(/CommandOrControl|Control|Ctrl/gi, 'Ctrl')
    .split('+')
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((p) => p && !/^[§$]+$/.test(p));
  const needCtrl = parts.some((p) => /^Ctrl$/i.test(p));
  const needAlt = parts.some((p) => /^Alt$/i.test(p));
  const needShift = parts.some((p) => /^Shift$/i.test(p));
  const key = parts.find((p) => !/^(Ctrl|Alt|Shift)$/i.test(p));
  if (!key) return false;
  if (needCtrl !== !!(e.ctrlKey || e.metaKey)) return false;
  if (needAlt !== !!e.altKey) return false;
  if (needShift !== !!e.shiftKey) return false;
  const codeMap = {
    Space: e.code === 'Space' || e.key === ' ',
    Left: e.key === 'ArrowLeft',
    Right: e.key === 'ArrowRight',
    Up: e.key === 'ArrowUp',
    Down: e.key === 'ArrowDown',
    Esc: e.key === 'Escape',
  };
  if (codeMap[key] != null) return codeMap[key];
  if (/^F\d{1,2}$/i.test(key)) return e.key.toUpperCase() === key.toUpperCase();
  return e.key.length === 1 && e.key.toUpperCase() === key.toUpperCase();
}

function runShortcutAction(action) {
  if (action === 'playPause' || action === 'toggle') return togglePlay();
  if (action === 'prev') return prev();
  if (action === 'next') return next();
  if (action === 'volUp') return setVolume((Number($('#volume')?.value) || 80) / 100 + 0.05);
  if (action === 'volDown') return setVolume((Number($('#volume')?.value) || 80) / 100 - 0.05);
  if (action === 'like') {
    const t = current();
    if (t) toggleFav([t]);
  }
}

function tryConfiguredShortcut(e) {
  const sc = shortcutConfig();
  if (!sc.enabled) return false;
  for (const action of ['playPause', 'prev', 'next', 'volUp', 'volDown', 'like']) {
    if (!eventMatchesAccel(e, sc[action])) continue;
    e.preventDefault();
    e.stopPropagation();
    runShortcutAction(action);
    return true;
  }
  return false;
}

document.addEventListener('keydown', (e) => {
  if ($('#modalRoot').children.length) return;
  if (e.key === 'Escape') {
    if (!menuEl.classList.contains('hidden')) hideMenu();
    else if (npOpen) closeNp();
    else if ($('#app').classList.contains('queue-open')) setQueueOpen(false);
  }
  const typing = /INPUT|TEXTAREA/.test(e.target.tagName) && e.target.type !== 'range';
  if (typing) return;
  if (tryConfiguredShortcut(e)) return;
  const k = e.key.toLowerCase();
  if (e.code === 'Space' && !e.ctrlKey && !e.altKey && !e.metaKey) {
    e.preventDefault();
    togglePlay();
  } else if (e.ctrlKey && e.key === 'ArrowRight') next();
  else if (e.ctrlKey && e.key === 'ArrowLeft') prev();
  else if (e.ctrlKey && e.key === 'ArrowUp') setVolume(vol.value / 100 + 0.05);
  else if (e.ctrlKey && e.key === 'ArrowDown') setVolume(vol.value / 100 - 0.05);
  else if (e.ctrlKey && k === 'f') {
    e.preventDefault();
    $('#sideSearch').focus();
    $('#sideSearch').select();
  } else if (e.ctrlKey && k === 'a' && table.tracks.length) {
    e.preventDefault();
    table.selected = new Set(table.tracks.map((_, i) => i));
    paintSelection();
  } else if (e.key === 'Delete' && table.ctx?.playlistId && table.selected.size) {
    removeFromPlaylist(table.ctx.playlistId, selectedTracks());
  } else if (e.key === 'Enter' && table.selected.size) {
    playList(table.tracks, Math.min(...table.selected));
  }
});

/* ================= init ================= */
(async function init() {
  hydrateIcons();
  lib = await api.load();
  dm.enabled = lib.settings?.danmaku !== false;
  $('#npDmToggle')?.classList.toggle('on', dm.enabled);
  dmBox()?.classList.toggle('off', !dm.enabled);
  lib.playlists ||= [];
  lib.favorites ||= [];
  lib.history ||= [];
  lib.recentPlaylists ||= [];
  lib.settings ||= {};
  if (!lib.initialized) {
    lib.initialized = true;
    if (!lib.playlists.length) lib.playlists.push({ id: uid(), name: '我的歌单', desc: '', tracks: [], createdAt: Date.now() });
    save();
  }
  setVolume(lib.settings.volume ?? 0.8, false);
  await refreshSkin();

  const s = lib.session;
  if (s?.queue?.length) {
    player.queue = s.queue;
    player.index = Math.min(Math.max(s.index, 0), s.queue.length - 1);
    player.shuffle = !!s.shuffle;
    player.repeat = s.repeat || 'off';
    player.resumeAt = s.position || 0;
    player.needsLoad = true;
  }
  updateControls();
  updateNowPlaying();
  if (player.needsLoad && current()) {
    const dur = current().duration || 0;
    seek.value = dur ? (player.resumeAt / dur) * 1000 : 0;
    setRange(seek, seek.value / 1000);
    $('#tCur').textContent = fmtTime(player.resumeAt);
  }
  renderUser();
  navigate({ type: 'home' });
  await refreshAccount();
  if (account) loadBecause();
  renderHomeIfVisible();
  window.addEventListener('beforeunload', () => {
    clearAudioAnalysis();
    player.cache.clear();
    dmCache.clear();
    infoCache.clear();
  });
  setInterval(() => {
    trimAnalysisMemory();
    pruneStreamCache(current()?.id);
    while (dmCache.size > 24) dmCache.delete(dmCache.keys().next().value);
  }, 120000);
})();
