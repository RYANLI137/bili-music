/**
 * SEAM — version seamless alignment + sample-accurate handoff.
 * Pipeline: chroma → key-shift → coarse/fine DTW → onset refine → piecewise TimeMap
 * Execute: AudioBufferSourceNode equal-power crossfade → HTMLMediaElement takeover
 */
(function (global) {
  const HOP_SEC = 0.093;
  const COARSE_DS = 6;
  const FINE_BAND_SEC = 2.5;
  const ONSET_WIN = 0.28;
  const MAX_DUR_RATIO = 1.2;
  const SMOOTH_FADE = 1.8;
  const INSTANT_FADE = 0.08;

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  /* ---------- tiny radix-2 FFT (real → complex mag) ---------- */
  function fftMag(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        [re[i], re[j]] = [re[j], re[i]];
        [im[i], im[j]] = [im[j], im[i]];
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      const wlenRe = Math.cos(ang);
      const wlenIm = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let wRe = 1;
        let wIm = 0;
        for (let j = 0; j < len / 2; j++) {
          const uRe = re[i + j];
          const uIm = im[i + j];
          const vRe = re[i + j + len / 2] * wRe - im[i + j + len / 2] * wIm;
          const vIm = re[i + j + len / 2] * wIm + im[i + j + len / 2] * wRe;
          re[i + j] = uRe + vRe;
          im[i + j] = uIm + vIm;
          re[i + j + len / 2] = uRe - vRe;
          im[i + j + len / 2] = uIm - vIm;
          const nWRe = wRe * wlenRe - wIm * wlenIm;
          wIm = wRe * wlenIm + wIm * wlenRe;
          wRe = nWRe;
        }
      }
    }
    const mag = new Float32Array(n / 2);
    for (let i = 0; i < mag.length; i++) mag[i] = Math.hypot(re[i], im[i]);
    return mag;
  }

  function nextPow2(n) {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
  }

  /** 12-chroma + delta (24) + SuperFlux onset + rms per frame */
  function chromaFromBuffer(audioBuf) {
    const sr = audioBuf.sampleRate;
    const ch = audioBuf.numberOfChannels > 1
      ? mixdown(audioBuf)
      : audioBuf.getChannelData(0);
    const hop = Math.max(256, Math.round(sr * HOP_SEC));
    const nfft = nextPow2(hop * 2);
    const frames = Math.max(1, Math.floor((ch.length - nfft) / hop) + 1);
    const chroma = new Float32Array(frames * 24);
    const onset = new Float32Array(frames);
    const rms = new Float32Array(frames);
    const prevMag = [null, null];
    const hann = new Float32Array(nfft);
    for (let i = 0; i < nfft; i++) hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (nfft - 1)));

    for (let f = 0; f < frames; f++) {
      const base = f * hop;
      const re = new Float32Array(nfft);
      const im = new Float32Array(nfft);
      let e = 0;
      for (let i = 0; i < nfft; i++) {
        const v = (ch[base + i] || 0) * hann[i];
        re[i] = v;
        e += v * v;
      }
      rms[f] = Math.sqrt(e / nfft);
      const mag = fftMag(re, im);

      // chroma: map bins to pitch class
      const c12 = new Float32Array(12);
      for (let bin = 1; bin < mag.length; bin++) {
        const freq = (bin * sr) / nfft;
        if (freq < 80 || freq > 5000) continue;
        const midi = 69 + 12 * Math.log2(freq / 440);
        if (!isFinite(midi)) continue;
        const pc = ((Math.round(midi) % 12) + 12) % 12;
        c12[pc] += mag[bin];
      }
      let cSum = 1e-9;
      for (let i = 0; i < 12; i++) cSum += c12[i];
      for (let i = 0; i < 12; i++) c12[i] /= cSum;

      const off = f * 24;
      for (let i = 0; i < 12; i++) {
        chroma[off + i] = c12[i];
        const prev = f > 0 ? chroma[(f - 1) * 24 + i] : c12[i];
        chroma[off + 12 + i] = c12[i] - prev;
      }

      // SuperFlux-ish: flux vs max of previous two mags
      let flux = 0;
      if (prevMag[0]) {
        const ref = prevMag[1] || prevMag[0];
        for (let i = 1; i < mag.length; i++) {
          const m = Math.max(prevMag[0][i] || 0, ref[i] || 0);
          const d = mag[i] - m;
          if (d > 0) flux += d;
        }
      }
      onset[f] = flux;
      prevMag[1] = prevMag[0];
      prevMag[0] = mag;
    }

    // smooth onset
    for (let i = 1; i < frames - 1; i++) {
      onset[i] = (onset[i - 1] + onset[i] * 2 + onset[i + 1]) * 0.25;
    }

    return {
      chroma,
      onset,
      rms,
      frames,
      hopSec: hop / sr,
      duration: audioBuf.duration,
      sampleRate: sr,
    };
  }

  function mixdown(buf) {
    const n = buf.length;
    const out = new Float32Array(n);
    const chs = buf.numberOfChannels;
    for (let c = 0; c < chs; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) out[i] += d[i] / chs;
    }
    return out;
  }

  function rotateChroma12(frame24, shift) {
    const out = new Float32Array(24);
    for (let i = 0; i < 12; i++) {
      out[i] = frame24[(i + shift) % 12];
      out[12 + i] = frame24[12 + ((i + shift) % 12)];
    }
    return out;
  }

  function estimateShift(featA, featB) {
    const a = featA.chroma;
    const b = featB.chroma;
    const n = Math.min(featA.frames, featB.frames, 400);
    let best = 0;
    let bestScore = -Infinity;
    for (let sh = 0; sh < 12; sh++) {
      let s = 0;
      for (let f = 0; f < n; f++) {
        const fa = f * 24;
        const fb = Math.floor((f / n) * Math.min(featB.frames, n)) * 24;
        for (let i = 0; i < 12; i++) s += a[fa + i] * b[fb + ((i + sh) % 12)];
      }
      if (s > bestScore) {
        bestScore = s;
        best = sh;
      }
    }
    return best;
  }

  function frameCost(a, ai, b, bi, shift, silencePen) {
    const fa = ai * 24;
    const fb = bi * 24;
    let dot = 0;
    let ea = 0;
    let eb = 0;
    for (let i = 0; i < 24; i++) {
      const av = a[fa + i];
      const bv = i < 12 ? b[fb + ((i + shift) % 12)] : b[fb + 12 + ((i - 12 + shift) % 12)];
      dot += av * bv;
      ea += av * av;
      eb += bv * bv;
    }
    const sim = dot / (Math.sqrt(ea * eb) + 1e-9);
    let cost = 1 - sim;
    if (silencePen) {
      // caller may pass rms — handled outside when needed
    }
    return cost;
  }

  function downsampleFeat(feat, ds) {
    const frames = Math.floor(feat.frames / ds);
    const chroma = new Float32Array(frames * 24);
    const rms = new Float32Array(frames);
    const onset = new Float32Array(frames);
    for (let f = 0; f < frames; f++) {
      const a = f * ds;
      const b = Math.min(feat.frames, a + ds);
      for (let i = a; i < b; i++) {
        for (let k = 0; k < 24; k++) chroma[f * 24 + k] += feat.chroma[i * 24 + k];
        rms[f] += feat.rms[i];
        onset[f] += feat.onset[i];
      }
      const n = b - a;
      for (let k = 0; k < 24; k++) chroma[f * 24 + k] /= n;
      rms[f] /= n;
      onset[f] /= n;
    }
    return { chroma, rms, onset, frames, hopSec: feat.hopSec * ds, duration: feat.duration };
  }

  /** Global DTW → path as list of [i,j] */
  function dtwPath(featA, featB, shift, bandCenter, bandRadius) {
    const n = featA.frames;
    const m = featB.frames;
    if (n < 2 || m < 2) return [[0, 0], [n - 1, m - 1]];

    const INF = 1e12;
    const cost = new Float32Array(n * m);
    const costs = [];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < m; j++) {
        if (bandRadius != null && bandCenter) {
          const cj = bandCenter[i];
          if (Math.abs(j - cj) > bandRadius) {
            cost[i * m + j] = INF;
            continue;
          }
        }
        let c = frameCost(featA.chroma, i, featB.chroma, j, shift);
        // silence penalty: silent vs loud
        const ra = featA.rms[i];
        const rb = featB.rms[j];
        if ((ra < 0.01) !== (rb < 0.01)) c += 0.85;
        cost[i * m + j] = c;
        if (c < INF / 2) costs.push(c);
      }
    }
    // σ-normalize
    let mean = 0;
    for (const c of costs) mean += c;
    mean /= Math.max(1, costs.length);
    let var_ = 0;
    for (const c of costs) var_ += (c - mean) * (c - mean);
    const sig = Math.sqrt(var_ / Math.max(1, costs.length)) + 1e-6;
    for (let i = 0; i < n * m; i++) {
      if (cost[i] < INF / 2) cost[i] = (cost[i] - mean) / sig + 1; // pair≈1
    }

    const dp = new Float32Array(n * m);
    const bt = new Int8Array(n * m); // 1=diag 2=up 3=left
    dp.fill(INF);
    dp[0] = cost[0];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < m; j++) {
        if (i === 0 && j === 0) continue;
        if (cost[i * m + j] >= INF / 2) continue;
        let best = INF;
        let dir = 1;
        if (i > 0 && j > 0 && dp[(i - 1) * m + (j - 1)] < best) {
          best = dp[(i - 1) * m + (j - 1)];
          dir = 1;
        }
        if (i > 0 && dp[(i - 1) * m + j] < best) {
          best = dp[(i - 1) * m + j];
          dir = 2;
        }
        if (j > 0 && dp[i * m + (j - 1)] < best) {
          best = dp[i * m + (j - 1)];
          dir = 3;
        }
        // band-center attraction
        if (bandCenter && bandRadius != null) {
          const pull = Math.abs(j - bandCenter[i]) / (bandRadius + 1);
          best += pull * 0.08;
        }
        dp[i * m + j] = best + cost[i * m + j];
        bt[i * m + j] = dir;
      }
    }

    const path = [];
    let i = n - 1;
    let j = m - 1;
    while (i > 0 || j > 0) {
      path.push([i, j]);
      const dir = bt[i * m + j] || 1;
      if (dir === 1) {
        i--;
        j--;
      } else if (dir === 2) i--;
      else j--;
      if (path.length > n + m + 8) break;
    }
    path.push([0, 0]);
    path.reverse();
    return path;
  }

  function refineAnchorsWithOnsets(featA, featB, path, hopSec) {
    const anchors = [];
    const step = Math.max(1, Math.floor(path.length / 48));
    const win = Math.max(2, Math.round(ONSET_WIN / hopSec));
    for (let p = 0; p < path.length; p += step) {
      const [i0, j0] = path[p];
      const a0 = Math.max(0, i0 - win);
      const a1 = Math.min(featA.frames, i0 + win + 1);
      const b0 = Math.max(0, j0 - win);
      const b1 = Math.min(featB.frames, j0 + win + 1);
      const qa = featA.onset.subarray(a0, a1);
      const qb = featB.onset.subarray(b0, b1);
      let bestOff = 0;
      let best = -1;
      const qLen = Math.min(qa.length, 2 * win + 1);
      if (qLen < 4 || qb.length < qLen) {
        anchors.push({ src: i0 * hopSec, dst: j0 * hopSec });
        continue;
      }
      let qe = 0;
      for (let k = 0; k < qLen; k++) qe += qa[k] * qa[k];
      const qn = Math.sqrt(qe) + 1e-9;
      for (let off = 0; off <= qb.length - qLen; off++) {
        let dot = 0;
        let he = 0;
        for (let k = 0; k < qLen; k++) {
          const y = qb[off + k];
          dot += qa[k] * y;
          he += y * y;
        }
        const sc = dot / (qn * (Math.sqrt(he) + 1e-9));
        if (sc > best) {
          best = sc;
          bestOff = off;
        }
      }
      // parabolic peak
      let frac = 0;
      if (bestOff > 0 && bestOff < qb.length - qLen) {
        const y0 = best;
        // neighbor scores
        const scoreAt = (off) => {
          let dot = 0;
          let he = 0;
          for (let k = 0; k < qLen; k++) {
            const y = qb[off + k];
            dot += qa[k] * y;
            he += y * y;
          }
          return dot / (qn * (Math.sqrt(he) + 1e-9));
        };
        const ym = scoreAt(bestOff - 1);
        const yp = scoreAt(bestOff + 1);
        const denom = ym - 2 * y0 + yp;
        if (Math.abs(denom) > 1e-9) frac = clamp((ym - yp) / (2 * denom), -0.5, 0.5);
      }
      const jRef = b0 + bestOff + qLen / 2 + frac;
      anchors.push({ src: i0 * hopSec, dst: jRef * hopSec });
    }
    // ensure ends
    if (!anchors.length || anchors[0].src > hopSec) anchors.unshift({ src: 0, dst: 0 });
    anchors.push({
      src: (featA.frames - 1) * hopSec,
      dst: (featB.frames - 1) * hopSec,
    });
    return anchors;
  }

  function fitSegments(anchors) {
    if (anchors.length < 3) {
      return { anchors, segments: null };
    }
    const segments = [];
    let start = 0;
    const slopeOf = (a, b) => (b.dst - a.dst) / Math.max(1e-6, b.src - a.src);
    for (let i = 1; i < anchors.length; i++) {
      const longSeg = anchors[i].src - anchors[start].src >= 20;
      const s0 = slopeOf(anchors[start], anchors[Math.min(i, start + 1)]);
      const s1 = slopeOf(anchors[i - 1], anchors[i]);
      if (longSeg || (i > start + 2 && Math.abs(s1 - s0) / Math.max(0.2, Math.abs(s0)) > 0.03)) {
        segments.push(fitSeg(anchors, start, i - 1));
        start = i - 1;
      }
    }
    segments.push(fitSeg(anchors, start, anchors.length - 1));

    // cross-val gate: segment model must beat linear interpolation on leave-one-out
    let segErr = 0;
    let linErr = 0;
    let n = 0;
    for (let i = 1; i < anchors.length - 1; i++) {
      const t = anchors[i].src;
      const truth = anchors[i].dst;
      const left = anchors[i - 1];
      const right = anchors[i + 1];
      const lin =
        left.dst +
        ((right.dst - left.dst) * (t - left.src)) / Math.max(1e-6, right.src - left.src);
      const seg = mapWithSegments(segments, t);
      segErr += Math.abs(seg - truth);
      linErr += Math.abs(lin - truth);
      n++;
    }
    if (n > 0 && segErr > linErr * 0.92) {
      return { anchors, segments: null }; // fallback to anchor lerp
    }
    return { anchors, segments };
  }

  function fitSeg(anchors, i0, i1) {
    // robust slope/offset via first-last + median residual
    const a = anchors[i0];
    const b = anchors[i1];
    let slope = (b.dst - a.dst) / Math.max(1e-6, b.src - a.src);
    let offset = a.dst - slope * a.src;
    const res = [];
    for (let i = i0; i <= i1; i++) {
      res.push(anchors[i].dst - (slope * anchors[i].src + offset));
    }
    res.sort((x, y) => x - y);
    const med = res[Math.floor(res.length / 2)] || 0;
    offset += med;
    return { src0: a.src, src1: b.src, slope, offset };
  }

  function mapWithSegments(segments, t) {
    if (!segments?.length) return t;
    let seg = segments[0];
    for (const s of segments) {
      if (t >= s.src0) seg = s;
    }
    return seg.slope * t + seg.offset;
  }

  function lerpAnchors(anchors, t) {
    if (!anchors?.length) return t;
    if (t <= anchors[0].src) return anchors[0].dst;
    for (let i = 1; i < anchors.length; i++) {
      if (t <= anchors[i].src) {
        const a = anchors[i - 1];
        const b = anchors[i];
        const u = (t - a.src) / Math.max(1e-6, b.src - a.src);
        return a.dst + (b.dst - a.dst) * u;
      }
    }
    return anchors[anchors.length - 1].dst;
  }

  function buildTimeMap(featA, featB, opts = {}) {
    const ratio =
      Math.max(featA.duration, featB.duration) / Math.max(1e-3, Math.min(featA.duration, featB.duration));
    if (ratio > MAX_DUR_RATIO) {
      return {
        ok: false,
        reason: 'duration-ratio',
        mapTime: (t) => (t / featA.duration) * featB.duration,
        slopeAt: () => featB.duration / featA.duration,
      };
    }
    const shift = estimateShift(featA, featB);
    const coarseA = downsampleFeat(featA, COARSE_DS);
    const coarseB = downsampleFeat(featB, COARSE_DS);
    const coarsePath = dtwPath(coarseA, coarseB, shift, null, null);

    // expand coarse path to fine band centers
    const bandCenter = new Int32Array(featA.frames);
    const coarseHop = coarseA.hopSec;
    for (let i = 0; i < featA.frames; i++) {
      const t = i * featA.hopSec;
      let cj = 0;
      for (let k = 0; k < coarsePath.length; k++) {
        if (coarsePath[k][0] * coarseHop <= t) cj = coarsePath[k][1];
      }
      bandCenter[i] = Math.round((cj * coarseHop) / featB.hopSec);
    }
    const bandRadius = Math.max(3, Math.round(FINE_BAND_SEC / featA.hopSec));
    const finePath = dtwPath(featA, featB, shift, bandCenter, bandRadius);
    const anchors = refineAnchorsWithOnsets(featA, featB, finePath, featA.hopSec);
    const fitted = fitSegments(anchors);

    const map = {
      ok: true,
      shift,
      anchors: fitted.anchors,
      segments: fitted.segments,
      hopSec: featA.duration,
      mapTime(t) {
        const raw = fitted.segments ? mapWithSegments(fitted.segments, t) : lerpAnchors(fitted.anchors, t);
        return clamp(raw, 0, Math.max(0, featB.duration - 0.05));
      },
      slopeAt(t) {
        if (fitted.segments?.length) {
          let seg = fitted.segments[0];
          for (const s of fitted.segments) if (t >= s.src0) seg = s;
          return clamp(seg.slope, 0.92, 1.08);
        }
        const a = fitted.anchors;
        if (a.length < 2) return 1;
        for (let i = 1; i < a.length; i++) {
          if (t <= a[i].src) {
            return clamp((a[i].dst - a[i - 1].dst) / Math.max(1e-6, a[i].src - a[i - 1].src), 0.92, 1.08);
          }
        }
        return 1;
      },
    };
    return map;
  }

  /* ---------- buffer / pair cache ---------- */
  const bufferCache = new Map(); // id -> { audioBuf, feat, urlsKey, at }
  const pairCache = new Map(); // src|dst -> map

  function pairKey(a, b) {
    return `${a}|${b}`;
  }

  async function ensureDecoded(id, urls, getCtx) {
    if (!id || !urls?.length) return null;
    const key = urls[0];
    const hit = bufferCache.get(id);
    if (hit && hit.urlsKey === key) {
      hit.at = Date.now();
      return hit;
    }
    const r = await fetch(urls[0]);
    if (!r.ok) throw new Error('fetch ' + r.status);
    const ab = await r.arrayBuffer();
    const ctx = getCtx();
    const audioBuf = await ctx.decodeAudioData(ab.slice(0));
    const feat = chromaFromBuffer(audioBuf);
    const entry = { audioBuf, feat, urlsKey: key, at: Date.now() };
    bufferCache.set(id, entry);
    while (bufferCache.size > 6) {
      let oldest = null;
      let oldestAt = Infinity;
      for (const [k, v] of bufferCache) {
        if (v.at < oldestAt) {
          oldestAt = v.at;
          oldest = k;
        }
      }
      if (oldest) bufferCache.delete(oldest);
      else break;
    }
    return entry;
  }

  async function prepPair(srcId, srcUrls, dstId, dstUrls, getCtx) {
    const key = pairKey(srcId, dstId);
    if (pairCache.has(key)) return pairCache.get(key);
    const [src, dst] = await Promise.all([
      ensureDecoded(srcId, srcUrls, getCtx),
      ensureDecoded(dstId, dstUrls, getCtx),
    ]);
    if (!src || !dst) return null;
    const map = buildTimeMap(src.feat, dst.feat);
    const prep = { key, map, src, dst, status: map.ok ? 'gold' : 'green', at: Date.now() };
    pairCache.set(key, prep);
    // drop stale pairs not involving current ids
    for (const [k] of pairCache) {
      if (!k.includes(srcId) && !k.includes(dstId) && pairCache.size > 8) pairCache.delete(k);
    }
    return prep;
  }

  function clearPairsFor(trackId) {
    for (const k of [...pairCache.keys()]) {
      if (k.includes(trackId)) pairCache.delete(k);
    }
  }

  /**
   * Sample-accurate equal-power crossfade via ABSN, then hand off to HTMLMediaElement.
   * Falls back to element-only equal-power if buffer missing or |slope-1| large.
   */
  async function crossfadeAbsn(opts) {
    const {
      ctx,
      fromEl,
      toEl,
      toBuffer,
      map,
      fadeSec = SMOOTH_FADE,
      masterVol = 1,
      connectGain, // (sourceNode) => GainNode already in graph OR create
      applyVolumes,
      setDeckGain, // (el, g) => void for element path
    } = opts;

    const srcT0 = fromEl.currentTime || 0;
    const dstT0 = map.mapTime(srcT0);
    // Version handoff must not pitch-shift; treat near-1 slopes as 1
    const rawSlope = map.slopeAt(srcT0) || 1;
    const slope = Math.abs(rawSlope - 1) < 0.04 ? 1 : rawSlope;
    const useAbsn = toBuffer && Math.abs(slope - 1) < 0.025;

    const fade = Math.max(INSTANT_FADE, fadeSec);
    const t0 = ctx.currentTime + 0.05;

    if (useAbsn) {
      const gOut = ctx.createGain();
      const gIn = ctx.createGain();
      gOut.gain.value = masterVol * (fromEl._trackGain || 1);
      gIn.gain.value = 0.0001;
      // tap: we can't easily insert before existing MediaElementSource without rewiring.
      // Instead duck fromEl via its deck gain and play ABSN to destination.
      const absn = ctx.createBufferSource();
      absn.buffer = toBuffer;
      absn.connect(gIn);
      gIn.connect(ctx.destination);

      const n = Math.max(32, Math.min(128, Math.round(fade * 28)));
      const outC = new Float32Array(n);
      const inC = new Float32Array(n);
      const fromLvl = Math.max(0.0001, masterVol * (fromEl._trackGain || 1));
      const toLvl = Math.max(0.0001, masterVol * (toEl._trackGain || 1));
      for (let i = 0; i < n; i++) {
        const r = i / (n - 1);
        outC[i] = fromLvl * Math.cos((r * Math.PI) / 2);
        inC[i] = toLvl * Math.sin((r * Math.PI) / 2);
      }

      // Duck the playing element through its _gain while ABSN rises
      fromEl._gain = 1;
      toEl._gain = 0;
      if (applyVolumes) applyVolumes();

      try {
        // Prefer scheduling on element's WebAudio gain if provided
        if (typeof connectGain === 'function') {
          const fromG = connectGain(fromEl);
          const toGProxy = gIn.gain;
          if (fromG) {
            fromG.cancelScheduledValues(t0);
            fromG.setValueCurveAtTime(outC, t0, fade);
          }
          toGProxy.cancelScheduledValues(t0);
          toGProxy.setValueCurveAtTime(inC, t0, fade);
        } else {
          gIn.gain.setValueCurveAtTime(inC, t0, fade);
        }
      } catch (_) {
        gIn.gain.linearRampToValueAtTime(toLvl, t0 + fade);
      }

      absn.start(t0, Math.max(0, dstT0));

      // During fade, keep fromEl playing; duck via _gain curve on JS clock aligned to audio clock
      const wall0 = performance.now();
      await new Promise((resolve) => {
        const timer = setInterval(() => {
          const p = Math.min(1, (performance.now() - wall0) / (fade * 1000));
          // map-lock: if element drifts, we still use wall progress for gains
          fromEl._gain = Math.cos((p * Math.PI) / 2);
          if (applyVolumes) applyVolumes();
          if (p >= 1) {
            clearInterval(timer);
            resolve();
          }
        }, 16);
      });

      // Buffer continues ~0.15s; warm element to buffer playhead, 25ms micro handoff
      const handoffPos = dstT0 + fade * slope;
      toEl._gain = 0;
      if (applyVolumes) applyVolumes();
      try {
        toEl.playbackRate = 1;
      } catch (_) {}
      toEl.currentTime = clamp(handoffPos, 0, (toBuffer.duration || handoffPos) - 0.05);
      await toEl.play().catch(() => {});
      await new Promise((r) => setTimeout(r, 30));
      // micro equal-power 25ms
      const micro = 0.025;
      const mt0 = performance.now();
      await new Promise((resolve) => {
        const timer = setInterval(() => {
          const p = Math.min(1, (performance.now() - mt0) / (micro * 1000));
          toEl._gain = Math.sin((p * Math.PI) / 2);
          // ABSN gain naturally ends; silence it
          try {
            gIn.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.01);
          } catch (_) {}
          if (applyVolumes) applyVolumes();
          if (p >= 1) {
            clearInterval(timer);
            resolve();
          }
        }, 10);
      });
      try {
        absn.stop();
      } catch (_) {}
      try {
        absn.disconnect();
        gIn.disconnect();
      } catch (_) {}
      fromEl.pause();
      fromEl._gain = 1;
      toEl._gain = 1;
      if (applyVolumes) applyVolumes();
      return { mode: 'absn', dstT0, slope, fade };
    }

    // Element path with continuous mapTime lock + local slope
    toEl._gain = 0;
    if (applyVolumes) applyVolumes();
    try {
      toEl.playbackRate = slope;
    } catch (_) {}
    toEl.currentTime = dstT0;
    await toEl.play().catch(() => {});
    const wall0 = performance.now();
    const srcTStart = fromEl.currentTime || srcT0;
    await new Promise((resolve) => {
      const timer = setInterval(() => {
        const p = Math.min(1, (performance.now() - wall0) / (fade * 1000));
        const srcNow = fromEl.currentTime || srcTStart;
        const want = map.mapTime(srcNow);
        const localSlope = map.slopeAt(srcNow);
        try {
          if (Math.abs((toEl.playbackRate || 1) - localSlope) > 0.01) toEl.playbackRate = localSlope;
        } catch (_) {}
        if (Math.abs(toEl.currentTime - want) > 0.045) {
          try {
            toEl.currentTime = want;
          } catch (_) {}
        }
        fromEl._gain = Math.cos((p * Math.PI) / 2);
        toEl._gain = Math.sin((p * Math.PI) / 2);
        if (applyVolumes) applyVolumes();
        if (p >= 1) {
          clearInterval(timer);
          resolve();
        }
      }, 20);
    });
    fromEl.pause();
    fromEl._gain = 1;
    toEl._gain = 1;
    try {
      toEl.playbackRate = 1;
    } catch (_) {}
    if (applyVolumes) applyVolumes();
    return { mode: 'element-maplock', dstT0, slope, fade };
  }

  const Seam = {
    HOP_SEC,
    SMOOTH_FADE,
    INSTANT_FADE,
    chromaFromBuffer,
    buildTimeMap,
    ensureDecoded,
    prepPair,
    pairKey,
    clearPairsFor,
    crossfadeAbsn,
    bufferCache,
    pairCache,
    statusOf(srcId, dstId) {
      return pairCache.get(pairKey(srcId, dstId))?.status || null;
    },
  };

  global.Seam = Seam;
  if (typeof module !== 'undefined' && module.exports) module.exports = Seam;
})(typeof window !== 'undefined' ? window : globalThis);
