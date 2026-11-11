const { parseTitle } = require('./lyrics');
const bili = require('./bili');

const CAT = {
  studio: { id: 'studio', label: '录音室', order: 1 },
  live: { id: 'live', label: 'Live 现场', order: 2 },
  cover: { id: 'cover', label: '翻唱', order: 3 },
  mv: { id: 'mv', label: 'MV', order: 4 },
  instrumental: { id: 'instrumental', label: '伴奏 / 纯音乐', order: 5 },
  other: { id: 'other', label: '其他', order: 6 },
};

// 「合集」不再直接丢掉：后面会拆成单曲再匹配
const REJECT =
  /教学|教程|鼓谱|动态鼓谱|贝斯谱|吉他谱|钢琴谱|练歌房|KTV|karaoke|库乐队|react|reaction|弹幕|精选\d|歌曲精选|盘点|听歌指南|解说|军训|联谊|决赛|十佳|讲台|校园草坪/i;

/** Clear FX / AI / edit — keep out of studio. Original album audio stays in studio. */
const NOT_STUDIO =
  /8\s*[Dd]|环绕音?|全景声|降调|升调|变调|变速|卡点|踩点|夜店|\bDJ\s*版|remix|混音|二混|夜芯|鬼畜|倒放|慢速|加速|1\.5\s*x|0\.8\s*x|Lo-?fi|lofi|\bSUNO\b|\bUdio\b|AI\s*(翻|生成|翻唱|制作)|reimagined|speed\s*up|slowed|抖音卡点|热播卡点|混剪|串烧|联唱|medley/i;

const STUDIO_POS =
  /录音室|录音棚|录音版|原版|官方音频|官方音源|同名专辑|纯享|studio|专辑版|Hi-?Res|无损|原曲|完整版|高品质|flac|wav|音质/i;

function classify(title, album = '') {
  const s = `${title} ${album}`;
  if (/翻唱|翻自|cover(?!\s*art)|女声版|男声版|女版|男版|俄语翻唱|日语翻唱|中文翻唱/i.test(s)) return 'cover';
  if (/伴奏|纯音乐|instrumental|inst\.|off\s*vocal|和声伴奏|鼓谱|贝斯谱|吉他谱|钢琴伴奏/i.test(s)) return 'instrumental';
  if (/\bMV\b|\bPV\b|官方MV|音乐视频/i.test(s) && !/附MV|带MV/i.test(s)) return 'mv';
  if (/live|现场|演唱会|音乐节|巡演|巡回|tour|万人合唱|官摄/i.test(s)) return 'live';
  if (NOT_STUDIO.test(s)) return 'other';
  // Prefer studio for originals / hi-res / plain title matches
  if (STUDIO_POS.test(s)) return 'studio';
  return 'studio';
}

const DIGIT_MAP = {
  零: '0',
  一: '1',
  二: '2',
  两: '2',
  三: '3',
  四: '4',
  五: '5',
  六: '6',
  七: '7',
  八: '8',
  九: '9',
  十: '10',
  点: '.',
};

function soften(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[：:]/g, '.')
    .replace(/[：:．。]/g, '.')
    .replace(/[（(\[【].*?[)）\]】]/g, '')
    .replace(/[十点半]/g, (c) => DIGIT_MAP[c] || c)
    .replace(/[\s'’"“”·.,，!！?？\-_~～]/g, '');
}

function nameHit(title, names) {
  const t = soften(title);
  return names.some((n) => {
    const g = soften(n);
    return g && (t.includes(g) || g.includes(t.slice(0, Math.min(t.length, g.length))));
  });
}

/** 从标题 / 专辑 / UP 主里尽量补全歌手名 */
function guessSong(track) {
  const g = parseTitle(track);
  const blob = `${track.album || ''} ${track.title || ''}`;
  if (!g.artist) {
    // 「陶喆 录音室作品」「周杰伦 - xxx」
    const m = blob.match(/([\u4e00-\u9fffA-Za-z·]{2,12})\s*(?:录音室|同名专辑|作品合集|歌曲)/);
    if (m) g.artist = m[1];
  }
  // 十点半 ↔ 10:30 互为别名
  const alts = new Set(g.names);
  for (const n of [...alts]) {
    if (/10[:：.]?30|十点半/.test(n)) {
      alts.add(n.replace(/10[:：.]?30/g, '十点半'));
      alts.add(n.replace(/十点半/g, '10:30'));
    }
  }
  g.names = [...alts];
  return g;
}

function mapHit(v, cat, extra = {}) {
  return {
    bvid: v.bvid,
    title: v.title,
    author: v.author,
    cover: v.cover,
    duration: v.duration,
    play: v.play,
    pubdate: v.pubdate,
    page: v.page || extra.page || 1,
    cid: v.cid || extra.cid || 0,
    album: v.album || extra.album || '',
    cat,
    catLabel: CAT[cat].label,
  };
}

async function searchOnce(keyword) {
  try {
    const r = await bili.search({ keyword, tids: 3, order: 'totalrank' });
    return r.list || [];
  } catch (_) {
    return [];
  }
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

/** 多 P / 合集拆成单曲候选 */
async function expandVersionHit(v) {
  try {
    const info = await bili.videoInfo(v.bvid);
    if (info.pages?.length > 1) {
      return info.pages.map((p) => ({
        bvid: info.bvid,
        title: p.part || `P${p.page}`,
        author: info.author,
        cover: info.cover,
        duration: p.duration || 0,
        play: v.play,
        pubdate: v.pubdate,
        page: p.page,
        cid: p.cid,
        album: info.title,
      }));
    }
    if (info.season?.episodes?.length > 1) {
      return info.season.episodes.map((ep, i) => ({
        bvid: ep.bvid,
        title: ep.title || `第 ${i + 1} 集`,
        author: ep.author || info.author,
        cover: ep.cover || info.cover,
        duration: ep.duration || 0,
        play: v.play,
        pubdate: v.pubdate,
        page: 1,
        cid: ep.cid,
        album: info.season.title,
      }));
    }
    const p = info.pages?.[0];
    return [
      {
        bvid: info.bvid,
        title: info.title,
        author: info.author,
        cover: info.cover,
        duration: p?.duration || info.duration || v.duration || 0,
        play: v.play,
        pubdate: v.pubdate,
        page: p?.page || 1,
        cid: p?.cid,
        album: '',
      },
    ];
  } catch (_) {
    return [{ ...v, page: 1, cid: v.cid || 0, album: '' }];
  }
}

const hitKey = (v) => `${v.bvid}_${v.cid || v.page || 0}`;

/**
 * 为当前歌曲找可切换的版本，按录音室 / Live / 翻唱 / MV / 伴奏 分组。
 * 合集 / 多 P 会拆成单曲再匹配。
 * @returns {{ song: string, artist: string, groups: {id,label,list}[], current?: object }}
 */
async function findVersions(track) {
  const g = guessSong(track);
  const song = g.name;
  if (!song || song.length < 2) return { song: '', artist: '', groups: [] };

  const base = [g.artist, song].filter(Boolean).join(' ');
  const queries = [...new Set([base, song, `${base} live`, `${base} 翻唱`, `${song} 翻唱`, `${base} 伴奏`, `${base} MV`])];

  const bags = await Promise.all(queries.map(searchOnce));
  const seenBv = new Set();
  const raw = [];
  for (const v of bags.flat()) {
    if (!v?.bvid || seenBv.has(v.bvid)) continue;
    if (REJECT.test(v.title)) continue;
    // 超长稿件多半是合集，留给展开后再按单曲时长筛
    const maybeCollection = v.duration > 900 || (track.duration && v.duration > track.duration * 2.2 && v.duration > 480);
    if (!maybeCollection) {
      if (v.duration < 60 || v.duration > 900) continue;
      if (!nameHit(v.title, g.names)) continue;
    }
    seenBv.add(v.bvid);
    raw.push(v);
  }

  const expandedBags = await mapPool(raw.slice(0, 36), 5, (v) => expandVersionHit(v));
  const seen = new Set();
  const byCat = Object.fromEntries(Object.keys(CAT).map((k) => [k, []]));

  // 把当前这首也塞进去，方便在列表里高亮
  if (track.bvid) {
    const cat = classify(track.title, track.album);
    const cur = {
      bvid: track.bvid,
      title: track.title,
      author: track.artist,
      cover: track.cover,
      duration: track.duration,
      page: track.page || 1,
      cid: track.cid || 0,
      album: track.album || '',
      cat,
      catLabel: CAT[cat].label,
      current: true,
    };
    seen.add(hitKey(cur));
    byCat[cur.cat].push(cur);
  }

  for (const s of expandedBags.flat()) {
    if (!s?.bvid) continue;
    const key = hitKey(s);
    if (seen.has(key)) continue;
    if (s.duration < 45 || s.duration > 900) continue;
    if (REJECT.test(s.title)) continue;
    // 歌名要对上分 P / 单曲标题（合集总标题对不上也没关系）
    if (!nameHit(s.title, g.names)) continue;
    if (track.duration && s.duration > track.duration * 2.2 && s.duration > 480) continue;
    seen.add(key);
    const cat = classify(s.title, s.album);
    byCat[cat].push(mapHit(s, cat));
  }

  // 每组按播放量排，截断
  for (const list of Object.values(byCat)) {
    list.sort((a, b) => (b.current ? 1 : 0) - (a.current ? 1 : 0) || (b.play || 0) - (a.play || 0));
    if (list.length > 28) list.length = 28;
  }

  const groups = Object.values(CAT)
    .sort((a, b) => a.order - b.order)
    .map((c) => ({ id: c.id, label: c.label, list: byCat[c.id] }))
    .filter((grp) => grp.list.length);

  return { song, artist: g.artist, groups };
}

module.exports = { findVersions, classify, guessSong, CAT };
