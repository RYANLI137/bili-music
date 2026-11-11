const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const NE_HEADERS = { 'User-Agent': UA, Referer: 'https://music.163.com/' };

const NOISE =
  /(4K|8K|1080P|720P|\d+FPS|60帧|HI-?RES|无损|高音质|超清|高清|杜比|DOLBY|全景声|官方|完整版|纯享版?|中字|中日字幕|中英字幕|双语字幕|歌词|动态歌词|MV|PV|附MV|首发|修复|自制|原版|纯享|直拍|现场版?|LIVE|演唱会|音乐节|巡演|巡回|WORLD TOUR|TOUR|\b(19|20)\d{2}\b)/gi;
const VERSION = /demo|伴奏|inst\b|instrumental|karaoke|off vocal|remix|cover|翻自|翻唱|dj|钢琴版|女声版|男声版|加速|降调|片段/i;

/** 从 B 站标题里猜出「歌名」和「歌手」 */
function parseTitle(track) {
  const raw = String(track.title || '');
  const quoted = raw.match(/[《「『]([^》」』]{1,40})[》」』]/);
  let name;
  let artist = '';
  if (quoted) {
    name = quoted[1];
    artist = raw
      .slice(0, quoted.index)
      .replace(/【[^】]*】|\[[^\]]*\]/g, '')
      .replace(NOISE, '')
      .replace(/[|｜:：,，\s]+$/g, '')
      .trim();
  } else {
    let s = raw
      .replace(/【[^】]*】|\[[^\]]*\]|（[^）]*）|\([^)]*\)|〔[^〕]*〕/g, ' ')
      .replace(/^\s*(P?\d{1,3}[.、\s-]+)/i, '')
      .replace(NOISE, ' ');
    const parts = s.split(/\s+[-–—|｜/]\s+|[|｜]/).map((x) => x.trim()).filter(Boolean);
    if (parts.length >= 2) {
      // 「歌手 - 歌名」和「歌名 - 歌手」都很常见，两种都试
      artist = parts[0];
      name = parts[1];
      return finish({ name, artist, alt: parts[0], raw, track });
    }
    name = parts[0] || s;
  }
  return finish({ name, artist, raw, track });
}

function finish({ name, artist, alt, raw, track }) {
  name = name.replace(/\s+/g, ' ').trim();
  artist = artist.replace(/\s+/g, ' ').trim();
  if (artist.length > 20) artist = '';
  const live = /live|现场|演唱会|音乐节/i.test(raw + (track.album || ''));
  return { name, artist, names: [name, alt].filter(Boolean), live };
}

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[（(\[【].*?[)）\]】]/g, '')
    .replace(/[\s'’"“”·.,，!！?？\-_~～]/g, '');

function score(c, track, guess) {
  const n = norm(c.name);
  if (!n) return -1;
  let s = -1;
  for (const name of guess.names) {
    const g = norm(name);
    if (g) s = Math.max(s, n === g ? 6 : n.includes(g) || g.includes(n) ? 3 : -1);
  }
  if (s < 0) return s;
  if (VERSION.test(c.name) && !VERSION.test(track.title)) s -= 4;
  if (c.source === 'netease') s += 0.5;
  const context = norm([track.title, track.album, track.artist, guess.artist].join(' '));
  if (c.artists.some((a) => a && context.includes(norm(a)))) s += 4;
  const d = Math.abs((c.duration || 0) - (track.duration || 0));
  if (track.duration && c.duration) s += d < 4 ? 3 : d < 12 ? 2 : d < 30 ? 1 : 0;
  const cLive = /live|现场/i.test(c.name);
  if (cLive === guess.live) s += 1;
  if (c.synced === false) s -= 3;
  return s;
}

async function neteaseSearch(q) {
  const r = await fetch(`https://music.163.com/api/cloudsearch/pc?type=1&limit=12&s=${encodeURIComponent(q)}`, {
    headers: NE_HEADERS,
    signal: AbortSignal.timeout(12000),
  });
  const j = await r.json();
  return (j.result?.songs || []).map((s) => ({
    source: 'netease',
    id: String(s.id),
    name: s.name,
    artists: (s.ar || []).map((a) => a.name),
    album: s.al?.name || '',
    duration: Math.round((s.dt || 0) / 1000),
  }));
}

async function lrclibSearch(q) {
  const r = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}`, {
    headers: { 'User-Agent': 'BiliMusic/1.0' },
    signal: AbortSignal.timeout(12000),
  });
  const list = await r.json();
  return (Array.isArray(list) ? list : []).slice(0, 12).map((s) => ({
    source: 'lrclib',
    id: String(s.id),
    name: s.trackName,
    artists: [s.artistName],
    album: s.albumName || '',
    duration: Math.round(s.duration || 0),
    synced: !!s.syncedLyrics,
  }));
}

async function search(q) {
  const [a, b] = await Promise.allSettled([neteaseSearch(q), lrclibSearch(q)]);
  return [...(a.value || []), ...(b.value || [])];
}

function parseLrc(text) {
  const map = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const stamps = [...line.matchAll(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)];
    if (!stamps.length) continue;
    const content = line.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of stamps) {
      const frac = m[3] ? Number(m[3]) / 10 ** m[3].length : 0;
      const t = Math.round((Number(m[1]) * 60 + Number(m[2]) + frac) * 100) / 100;
      map.set(t, content);
    }
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([t, text]) => ({ t, text }));
}

function merge(lrc, tlrc) {
  const lines = parseLrc(lrc);
  const trans = parseLrc(tlrc);
  if (trans.length) {
    for (const l of lines) {
      const tr = trans.find((x) => Math.abs(x.t - l.t) < 0.3);
      if (tr && tr.text && tr.text !== l.text) l.tr = tr.text;
    }
  }
  // 去掉作词作曲之类的空行，但保留间奏空行用于分段
  return lines.filter((l, i) => l.text || (i > 0 && lines[i - 1].text));
}

async function getLyrics(source, id) {
  if (source === 'netease') {
    const r = await fetch(`https://music.163.com/api/song/lyric?id=${id}&lv=1&tv=-1&os=pc`, {
      headers: NE_HEADERS,
      signal: AbortSignal.timeout(12000),
    });
    const j = await r.json();
    if (j.nolyric || j.uncollected) return { lines: [], plain: '纯音乐，请欣赏' };
    const lines = merge(j.lrc?.lyric, j.tlyric?.lyric);
    if (!lines.length && j.lrc?.lyric) return { lines: [], plain: j.lrc.lyric };
    return { lines };
  }
  const r = await fetch(`https://lrclib.net/api/get/${id}`, {
    headers: { 'User-Agent': 'BiliMusic/1.0' },
    signal: AbortSignal.timeout(12000),
  });
  const j = await r.json();
  if (j.instrumental) return { lines: [], plain: '纯音乐，请欣赏' };
  const lines = merge(j.syncedLyrics);
  return lines.length ? { lines } : { lines: [], plain: j.plainLyrics || '' };
}

/** 自动为一首 B 站歌曲匹配歌词；pick 为用户手动选过的候选 */
async function find(track, pick) {
  const guess = parseTitle(track);
  let best = pick || null;
  if (!best) {
    const queries = [...new Set([[guess.artist, guess.name].filter(Boolean).join(' '), ...guess.names])].filter(Boolean);
    let candidates = [];
    for (const q of queries) {
      candidates = (await search(q)).map((c) => ({ ...c, score: score(c, track, guess) }));
      candidates.sort((a, b) => b.score - a.score);
      if (candidates[0]?.score >= 7) break;
    }
    best = candidates[0]?.score >= 5 ? candidates[0] : null;
  }
  if (!best) return { query: [guess.artist, guess.name].filter(Boolean).join(' '), lines: [], match: null };
  const lyr = await getLyrics(best.source, best.id);
  const match = { source: best.source, id: best.id, name: best.name, artists: best.artists };
  return { query: [guess.artist, guess.name].filter(Boolean).join(' '), match, ...lyr };
}

module.exports = { find, search, getLyrics, parseTitle };
