/**
 * 搜索结果只保留音乐，并在同一首歌有更高音质 / 其他音源时标出来。
 * 浏览器里挂到 globalThis.MusicFilter，Node 里走 module.exports。
 */
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else globalThis.MusicFilter = api;
})(function () {
  const NOT_MUSIC =
    /全剧情|剧情流程|游戏流程|全流程|攻略|实况|通关|试玩|游戏评测|游戏解说|(?<!歌词)解说|反应|reaction|教学|教程|音效合集|音效包|剧情向|流程（完结）|全收集|[一二三]周目|第[0-9一二三四五六七八九十百零]+[章节]/i;
  const LONG_OK = /live|现场|演唱会|音乐会|音乐节|巡演|\bost\b|原声|专辑|歌单|合集|纯享/i;
  const MUSIC_HINT =
    /歌曲|音乐|翻唱|演奏|伴奏|纯音乐|主题曲|片尾曲|片头曲|ost|原声|\bmv\b|live|现场|音源|无损|hi-?res|高音质|钢琴|吉他|小提琴|演唱|弹唱|原声带|\bbgm\b|flac|说唱|\brap\b/i;
  const SONGISH = /《|》|「|」|"|“|”/;
  const MUSIC_TIDS = new Set([3, 28, 29, 30, 31, 59, 130, 193, 194, 243, 244]);
  const KEY_STOP = new Set([
    '高音质',
    '无损',
    '原声',
    '纯享',
    '录音室',
    '录音棚',
    '官方',
    '音源',
    '翻唱',
    '现场',
    '歌曲',
    '音乐',
    '中文字幕',
    '完整版',
    '原版',
    '游戏音乐',
    '片尾曲',
    '片头曲',
    '主题曲',
    '官方版',
    '动态歌词',
  ]);

  const isPlugin = (v) => v?.kind === 'plugin' || (!!v?.platform && !v?.bvid);

  function textOf(v) {
    return `${v?.title || ''} ${v?.album || ''} ${v?.tag || ''} ${v?.typename || ''}`;
  }

  function mentions(v, keyword) {
    const parts = String(keyword || '')
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter((p) => p.length >= 2);
    if (!parts.length) return true;
    const blob = `${textOf(v)} ${v?.author || ''} ${v?.artist || ''} ${v?.desc || ''}`.toLowerCase();
    return parts.every((p) => blob.includes(p));
  }

  /** 游戏流程、攻略、超长非音乐稿件不要出现在搜索里 */
  function isMusicHit(v, keyword) {
    if (!v) return false;
    if (isPlugin(v)) return true;
    const text = textOf(v);
    if (NOT_MUSIC.test(text)) return false;
    const tid = Number(v.typeid ?? v.tid);
    const knownTid = (v.typeid != null && v.typeid !== '') || (v.tid != null && v.tid !== '');
    const inZone = MUSIC_TIDS.has(tid) || v.pid_v2 === 1003 || /音乐|翻唱|演奏|VOCALOID|MV/.test(v.typename || '');
    if (knownTid && !inZone && !/歌曲|音乐|翻唱|演奏|伴奏|纯音乐|主题曲|片尾曲|片头曲|ost|原声|\bmv\b|live|现场|音源/i.test(text)) {
      return false;
    }
    const dur = Number(v.duration) || 0;
    const pages = Number(v.pages) || 1;
    if (dur > 0 && dur < 15) return false;
    if (dur > 20 * 60 && pages <= 1 && !LONG_OK.test(text)) return false;
    if (keyword && !mentions(v, keyword)) return false;
    // 关键词只出现在标签里、标题也不像歌名时，多半是剪辑而不是歌
    if (keyword && !titleMentions(v, keyword)) {
      const title = v.title || '';
      if (!MUSIC_HINT.test(text) && !SONGISH.test(title) && !/[A-Za-z]{4,}/.test(title)) return false;
    }
    return true;
  }

  function titleMentions(v, keyword) {
    const parts = String(keyword || '')
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter((p) => p.length >= 2);
    if (!parts.length) return true;
    const title = `${v?.title || ''} ${v?.album || ''}`.toLowerCase();
    return parts.every((p) => title.includes(p));
  }

  function filterMusic(list, keyword) {
    return (list || []).filter((v) => isMusicHit(v, keyword));
  }

  function soften(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[（(\[【].*?[)）\]】]/g, '')
      .replace(/[\s'’"“”·.,，!！?？\-_~～:：/|]/g, '');
  }

  function songKeys(title) {
    const raw = String(title || '');
    const keys = new Set();
    const add = (s) => {
      const n = soften(s);
      if (n.length >= 3 && !KEY_STOP.has(n)) keys.add(n);
    };
    for (const m of raw.matchAll(/《([^》]{1,40})》|"([^"]{1,80})"|“([^”]{1,80})”|「([^」]{1,40})」/g)) {
      add(m[1] || m[2] || m[3] || m[4]);
    }
    const bare = raw.replace(/[【\[（(][^】\]）)]*[】\]）)]/g, ' ');
    for (const m of bare.matchAll(/[A-Za-z][A-Za-z0-9'’]*(?:\s+[A-Za-z][A-Za-z0-9'’]*){0,8}/g)) {
      const phrase = m[0].trim();
      if (phrase.replace(/[^A-Za-z0-9]/g, '').length >= 5) add(phrase);
    }
    for (const m of bare.matchAll(/[\u4e00-\u9fff]{3,12}/g)) add(m[0]);
    return [...keys];
  }

  function distinctiveKeys(title, kwNorm) {
    if (!kwNorm) return songKeys(title);
    return songKeys(title).filter((k) => k !== kwNorm && !k.includes(kwNorm));
  }

  function sharedRare(aKeys, bKeys, freq) {
    let best = 99;
    let hit = false;
    for (const x of aKeys) {
      for (const y of bKeys) {
        const same = x === y || (x.length >= 8 && y.length >= 8 && (x.includes(y) || y.includes(x)));
        if (!same) continue;
        const key = x.length <= y.length ? x : y;
        const n = freq.get(key) || freq.get(x) || freq.get(y) || 1;
        if (n < best) best = n;
        hit = true;
      }
    }
    // 系列名会命中一整页，歌名通常只出现两三次
    return hit && best <= 4;
  }

  function qualityScore(item) {
    const s = textOf(item);
    let n = 1;
    if (/无损|hi-?res|flac|\bwav\b/i.test(s)) n += 4;
    if (/高音质|高解析|百万级/i.test(s)) n += 2;
    if (/原声纯享|官方音源|官方音频|录音室|录音棚/i.test(s)) n += 2;
    if (isPlugin(item)) n += 3;
    if (/\bmv\b|混剪|\bgmv\b|音效|录屏/i.test(s)) n -= 2;
    if (/循环|单曲循环/.test(s)) n -= 3;
    const dur = Number(item.duration) || 0;
    if (dur > 12 * 60 && !/live|现场|演唱会|音乐会/.test(s)) n -= 3;
    return n;
  }

  function qualityLabel(item) {
    if (isPlugin(item)) return item.platform || '插件';
    const s = textOf(item);
    if (/无损|flac/i.test(s)) return '无损';
    if (/hi-?res/i.test(s)) return 'Hi-Res';
    if (/录音室|录音棚|官方音源|官方音频/i.test(s)) return '录音室';
    if (/高音质|高解析|原声纯享/i.test(s)) return '高音质';
    return '';
  }

  function betterTargetOk(src, dst) {
    const sd = Number(src.duration) || 0;
    const dd = Number(dst.duration) || 0;
    if (sd > 0 && sd < 8 * 60 && dd > 15 * 60 && !/live|现场|演唱会/.test(textOf(dst))) return false;
    return true;
  }

  /**
   * 给较差的那条挂上 betterIndex / betterLabel。
   * 插件音源和带无损 / Hi-Res / 录音室标记的结果会赢过普通搬运。
   */
  function annotateBetter(list, keyword) {
    const items = (list || []).map((item) => {
      const copy = {
        ...item,
        betterIndex: -1,
        betterLabel: '',
        qualityLabel: qualityLabel(item),
      };
      delete copy.better;
      return copy;
    });
    const kwNorm = soften(keyword);
    const keyList = items.map((item) => distinctiveKeys(`${item.title || ''} ${item.album || ''}`, kwNorm));
    const freq = new Map();
    for (const keys of keyList) {
      for (const k of new Set(keys)) freq.set(k, (freq.get(k) || 0) + 1);
    }
    const scores = items.map(qualityScore);
    const same = (i, j) => {
      if (sharedRare(keyList[i], keyList[j], freq)) return true;
      if (keyList[i].length || keyList[j].length) return false;
      if (kwNorm.length < 2) return false;
      return soften(items[i].title).includes(kwNorm) && soften(items[j].title).includes(kwNorm);
    };
    for (let i = 0; i < items.length; i++) {
      if (isPlugin(items[i])) continue;
      let best = -1;
      for (let j = 0; j < items.length; j++) {
        if (i === j) continue;
        if (scores[j] < 3 || scores[j] < scores[i] + 2) continue;
        if (!same(i, j) || !betterTargetOk(items[i], items[j])) continue;
        if (best < 0 || scores[j] > scores[best]) best = j;
      }
      if (best >= 0) {
        items[i].betterIndex = best;
        items[i].betterLabel = items[best].qualityLabel || '高音质';
      }
    }
    return items;
  }

  return { isMusicHit, filterMusic, annotateBetter, qualityScore, qualityLabel };
});
