const crypto = require('crypto');
const zlib = require('zlib');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const REFERER = 'https://www.bilibili.com/';

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39,
  12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63,
  57, 62, 11, 36, 20, 34, 44, 52,
];

let cookies = {};
let userCookie = '';
let wbiCache = { key: '', time: 0 };

function setUserCookie(str) {
  userCookie = (str || '').trim();
}

function cookieHeader() {
  const all = { ...cookies };
  for (const part of userCookie.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) all[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return Object.entries(all)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

async function ensureBuvid() {
  if (cookies.buvid3) return;
  try {
    const r = await fetch('https://api.bilibili.com/x/frontend/finger/spi', {
      headers: { 'User-Agent': UA, Referer: REFERER },
    });
    const j = await r.json();
    if (j.code === 0) {
      cookies.buvid3 = j.data.b_3;
      cookies.buvid4 = encodeURIComponent(j.data.b_4);
    }
  } catch (_) {
    /* fall through without buvid */
  }
  if (!cookies.buvid3) {
    cookies.buvid3 = `${crypto.randomUUID().toUpperCase()}${Math.floor(Math.random() * 1e5)}infoc`;
  }
  cookies.b_nut = Math.floor(Date.now() / 1000);
}

async function request(url, params = {}) {
  await ensureBuvid();
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(qs ? `${url}?${qs}` : url, {
    headers: { 'User-Agent': UA, Referer: REFERER, Origin: 'https://www.bilibili.com', Cookie: cookieHeader() },
  });
  const text = await r.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch (_) {
    throw new Error(`B 站返回异常 (HTTP ${r.status})`);
  }
  if (j.code !== 0) throw new Error(j.message || `B 站接口错误 ${j.code}`);
  return j.data;
}

async function getMixinKey() {
  if (wbiCache.key && Date.now() - wbiCache.time < 30 * 60 * 1000) return wbiCache.key;
  await ensureBuvid();
  const r = await fetch('https://api.bilibili.com/x/web-interface/nav', {
    headers: { 'User-Agent': UA, Referer: REFERER, Cookie: cookieHeader() },
  });
  const j = await r.json();
  const { img_url, sub_url } = j.data.wbi_img;
  const name = (u) => u.slice(u.lastIndexOf('/') + 1, u.lastIndexOf('.'));
  const raw = name(img_url) + name(sub_url);
  const key = MIXIN_KEY_ENC_TAB.map((i) => raw[i]).join('').slice(0, 32);
  wbiCache = { key, time: Date.now() };
  return key;
}

async function signWbi(params) {
  const key = await getMixinKey();
  const all = { ...params, wts: Math.floor(Date.now() / 1000) };
  const query = Object.keys(all)
    .sort()
    .map((k) => {
      const v = String(all[k]).replace(/[!'()*]/g, '');
      return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
    })
    .join('&');
  const w_rid = crypto.createHash('md5').update(query + key).digest('hex');
  return { ...all, w_rid };
}

const stripHtml = (s) =>
  (s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

const fixPic = (p) => (p ? (p.startsWith('//') ? 'https:' + p : p.replace(/^http:/, 'https:')) : '');

function parseDuration(d) {
  if (typeof d === 'number') return d;
  const parts = String(d || '0').split(':').map(Number);
  return parts.reduce((acc, n) => acc * 60 + (n || 0), 0);
}

/**
 * order: totalrank(综合) | click(播放) | pubdate(最新) | dm(弹幕) | stow(收藏)
 * tids: 0 全部, 3 音乐区
 */
async function search({ keyword, page = 1, order = 'totalrank', tids = 0, duration = 0 }) {
  const params = await signWbi({
    search_type: 'video',
    keyword,
    page,
    page_size: 30,
    order,
    tids,
    duration,
  });
  const data = await request('https://api.bilibili.com/x/web-interface/wbi/search/type', params);
  const list = (data.result || []).map((v) => ({
    bvid: v.bvid,
    aid: v.aid,
    title: stripHtml(v.title),
    author: v.author,
    mid: v.mid,
    cover: fixPic(v.pic),
    duration: parseDuration(v.duration),
    play: v.play,
    pubdate: v.pubdate,
    tag: v.tag,
    desc: v.description,
  }));
  return { list, page: data.page, numPages: data.numPages, numResults: data.numResults };
}

async function videoInfo(bvid) {
  const v = await request('https://api.bilibili.com/x/web-interface/view', { bvid });
  const season = v.ugc_season;
  return {
    bvid: v.bvid,
    aid: v.aid,
    title: v.title,
    author: v.owner?.name,
    mid: v.owner?.mid,
    cover: fixPic(v.pic),
    duration: v.duration,
    desc: v.desc,
    pages: (v.pages || []).map((p) => ({
      cid: p.cid,
      page: p.page,
      part: p.part,
      duration: p.duration,
    })),
    // B 站「合集」：多个独立稿件组成的系列
    season: season
      ? {
          id: season.id,
          title: season.title,
          episodes: (season.sections || [])
            .flatMap((s) => s.episodes || [])
            .map((ep) => ({
              bvid: ep.bvid,
              cid: ep.cid,
              title: ep.title,
              cover: fixPic(ep.arc?.pic || season.cover || v.pic),
              duration: ep.page?.duration || ep.arc?.duration || 0,
              author: ep.arc?.author?.name || v.owner?.name,
            }))
            .filter((ep) => ep.bvid),
        }
      : null,
  };
}

const rankCdn = (u) => (/mcdn|szbdyd/.test(u) ? 2 : /akamaized|mirrorakam|mirroraliov|mirrorcosov/.test(u) ? 1 : 0);
const streamUrls = (c) =>
  [c.baseUrl || c.base_url, ...(c.backupUrl || c.backup_url || [])].filter(Boolean).sort((a, b) => rankCdn(a) - rankCdn(b));

async function playurl(bvid, cid) {
  const params = await signWbi({ bvid, cid, fnval: 4048, fnver: 0, fourk: 1, qn: 0 });
  return request('https://api.bilibili.com/x/player/wbi/playurl', params);
}

async function audioUrl(bvid, cid) {
  const data = await playurl(bvid, cid);
  const dash = data.dash;
  let candidates = [];
  if (dash) {
    // 杜比音频是 E-AC-3，Chromium 解不了，所以不要
    if (dash.flac?.audio) candidates.push(dash.flac.audio);
    if (dash.audio?.length) candidates.push(...dash.audio);
  }
  candidates = candidates.filter(Boolean).sort((a, b) => (QUALITY_RANK[b.id] || 0) - (QUALITY_RANK[a.id] || 0) || b.bandwidth - a.bandwidth);
  if (!candidates.length && data.durl?.length) {
    const d = data.durl[0];
    const urls = [d.url, ...(d.backup_url || [])];
    return { urls, streams: [{ id: 0, bandwidth: 0, urls }] };
  }
  if (!candidates.length) throw new Error('没有可用的音频流');
  const streams = candidates.map((c) => ({
    id: c.id,
    bandwidth: c.bandwidth,
    urls: streamUrls(c),
  }));
  return { urls: streams.flatMap((s) => s.urls), streams };
}

/** 下载 / 预览用：同时给出音视频 DASH 流 */
async function mediaUrl(bvid, cid) {
  const data = await playurl(bvid, cid);
  const dash = data.dash || {};
  const audios = [];
  if (dash.flac?.audio) audios.push(dash.flac.audio);
  if (dash.audio?.length) audios.push(...dash.audio);
  audios.sort((a, b) => (QUALITY_RANK[b.id] || 0) - (QUALITY_RANK[a.id] || 0) || (b.bandwidth || 0) - (a.bandwidth || 0));
  const videos = (dash.video || []).slice().sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
  const audio = audios[0] ? { id: audios[0].id, bandwidth: audios[0].bandwidth, urls: streamUrls(audios[0]) } : null;
  const video = videos[0]
    ? { id: videos[0].id, bandwidth: videos[0].bandwidth, width: videos[0].width, height: videos[0].height, urls: streamUrls(videos[0]) }
    : null;
  let combined = null;
  if (data.durl?.length) {
    const d = data.durl[0];
    combined = { urls: [d.url, ...(d.backup_url || [])].filter(Boolean) };
  }
  return { audio, video, combined };
}

// 30216=64K 30232=132K 30280=192K 30251=Hi-Res 无损
const QUALITY_RANK = { 30216: 1, 30232: 2, 30280: 3, 30251: 4 };

/** 从链接 / BV 号 / av 号里解析 bvid 和分 P */
function parseLink(text) {
  const s = String(text || '').trim();
  const bv = s.match(/BV[0-9A-Za-z]{10}/);
  const p = s.match(/[?&]p=(\d+)/);
  if (bv) return { bvid: bv[0], page: p ? Number(p[1]) : null };
  const av = s.match(/av(\d+)/i);
  if (av) return { aid: av[1], page: p ? Number(p[1]) : null };
  return null;
}

async function resolveLink(text) {
  const s = String(text || '').trim();
  if (/b23\.tv\//.test(s)) {
    const url = s.match(/https?:\/\/b23\.tv\/[^\s]+/)?.[0];
    if (url) {
      const r = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': UA } });
      return resolveLink(r.url);
    }
  }
  const parsed = parseLink(s);
  if (!parsed) return null;
  if (parsed.aid && !parsed.bvid) {
    const v = await request('https://api.bilibili.com/x/web-interface/view', { aid: parsed.aid });
    parsed.bvid = v.bvid;
  }
  return parsed;
}

// 旧版音乐分区 tid（3 为一级分区）；新版分区体系里音乐的一级分区是 1003
const MUSIC_TIDS = new Set([3, 28, 29, 30, 31, 59, 130, 193, 194, 243, 244]);
const isMusic = (v) => MUSIC_TIDS.has(v.tid) || v.pid_v2 === 1003;

const mapArchive = (v) => ({
  bvid: v.bvid,
  title: stripHtml(v.title),
  author: v.owner?.name || v.author?.name || v.author || '',
  cover: fixPic(v.pic || v.cover),
  duration: parseDuration(v.duration),
  play: v.stat?.view,
  pubdate: v.pubdate,
});

/** 音乐分区个性化推荐（带登录 Cookie 时按账号兴趣推荐），page 递增即换一批 */
async function musicFeed(page = 1) {
  const data = await request('https://api.bilibili.com/x/web-interface/region/feed/rcmd', {
    display_id: page,
    request_cnt: 15,
    from_region: 1003,
    device: 'web',
    plat: 30,
  });
  return (data.archives || []).filter((v) => v.goto === 'av' || !v.goto).map(mapArchive);
}

async function related(bvid) {
  const list = await request('https://api.bilibili.com/x/web-interface/archive/related', { bvid });
  return (list || []).filter(isMusic).map(mapArchive);
}

async function musicRanking() {
  const data = await request('https://api.bilibili.com/x/web-interface/ranking/v2', { rid: 3, type: 'all' });
  return (data.list || []).slice(0, 30).map(mapArchive);
}

/** 账号的观看历史里和音乐相关的视频，用作推荐种子 */
async function musicHistory() {
  const data = await request('https://api.bilibili.com/x/web-interface/history/cursor', { ps: 30, type: 'archive' });
  const re = /音乐|翻唱|演奏|MV|VOCALOID|电音|乐评|现场|说唱|人声|乐器|唱/i;
  return (data.list || [])
    .filter((h) => h.history?.bvid && re.test(h.tag_name || ''))
    .map((h) => ({ bvid: h.history.bvid, title: h.title, author: h.author_name, cover: fixPic(h.cover) }));
}

async function me() {
  await ensureBuvid();
  const r = await fetch('https://api.bilibili.com/x/web-interface/nav', {
    headers: { 'User-Agent': UA, Referer: REFERER, Cookie: cookieHeader() },
  });
  const j = await r.json();
  if (!j.data?.isLogin) return null;
  return { mid: j.data.mid, name: j.data.uname, face: fixPic(j.data.face), vip: j.data.vipStatus === 1 };
}

function decodeXmlEntities(s) {
  return String(s || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function parseDanmakuXml(text) {
  const list = [];
  const re = /<d p="([^"]+)">([\s\S]*?)<\/d>/g;
  let m;
  while ((m = re.exec(text))) {
    const parts = m[1].split(',');
    const t = parseFloat(parts[0]);
    const mode = Number(parts[1]) || 1;
    const color = Number(parts[3]);
    const content = decodeXmlEntities(m[2]).trim();
    if (!content || !isFinite(t)) continue;
    // skip code / advanced pools that clutter a music UI
    if (mode >= 7) continue;
    list.push({
      t,
      mode,
      color: isFinite(color) ? color : 16777215,
      text: content.slice(0, 80),
    });
  }
  list.sort((a, b) => a.t - b.t);
  return list;
}

/** Fetch original Bilibili danmaku for a video cid (XML pool). */
async function danmaku(cid) {
  if (!cid) return [];
  await ensureBuvid();
  const urls = [
    `https://comment.bilibili.com/${cid}.xml`,
    `https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}`,
  ];
  for (const url of urls) {
    try {
      const r = await fetch(url, {
        headers: {
          'User-Agent': UA,
          Referer: REFERER,
          Cookie: cookieHeader(),
          'Accept-Encoding': 'gzip, deflate',
        },
      });
      if (!r.ok) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      let text = '';
      try {
        text = buf.toString('utf8');
        if (!/<d\s/i.test(text)) throw new Error('not xml');
      } catch (_) {
        try {
          text = zlib.inflateSync(buf).toString('utf8');
        } catch (_) {
          try {
            text = zlib.inflateRawSync(buf).toString('utf8');
          } catch (_) {
            continue;
          }
        }
      }
      const list = parseDanmakuXml(text);
      if (list.length) return list;
    } catch (_) {}
  }
  return [];
}

module.exports = {
  search,
  videoInfo,
  audioUrl,
  mediaUrl,
  playurl,
  resolveLink,
  musicFeed,
  related,
  musicRanking,
  musicHistory,
  me,
  danmaku,
  setUserCookie,
  UA,
  REFERER,
};
