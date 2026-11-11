/**
 * MixEngine — Mixxx AutoDJ–inspired analysis & transition planner.
 * Reference: https://github.com/mixxxdj/mixxx (AnalyzerSilence / AutoDJProcessor)
 * Runtime is JS for zero-toolchain Windows installs; matching C++ lives in native/mixengine/.
 */
(function (global) {
  const TARGET_RMS = 0.11;
  const SILENCE_LIN = Math.pow(10, -60 / 20); // Mixxx N-60dB
  const MAX_CACHE = 10;

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function envelopeMono(channel, sampleRate, envRate = 80) {
    const win = Math.max(1, Math.floor(sampleRate / envRate));
    const out = new Float32Array(Math.floor(channel.length / win));
    for (let i = 0; i < out.length; i++) {
      let s = 0;
      const base = i * win;
      for (let j = 0; j < win; j++) {
        const v = channel[base + j] || 0;
        s += v * v;
      }
      out[i] = Math.sqrt(s / win);
    }
    return { env: out, rate: sampleRate / win };
  }

  function onsetFromEnv(env) {
    const onset = new Float32Array(env.length);
    for (let i = 1; i < env.length; i++) {
      const d = env[i] - env[i - 1];
      onset[i] = d > 0 ? d : 0;
    }
    for (let i = 1; i < onset.length - 1; i++) {
      onset[i] = (onset[i - 1] + onset[i] * 2 + onset[i + 1]) * 0.25;
    }
    return onset;
  }

  /** Mixxx AnalyzerSilence: first/last non-silent frame → intro/outro cues */
  function detectSilence(channel, sampleRate, duration) {
    const n = channel.length || 0;
    if (!n || !sampleRate) {
      return { firstSound: 0, lastSound: duration || 0, introEnd: 0, outroStart: duration || 0 };
    }
    const step = Math.max(1, Math.floor(sampleRate / 200));
    let first = -1;
    let last = -1;
    for (let i = 0; i < n; i += step) {
      const v = Math.abs(channel[i]);
      if (v >= SILENCE_LIN) {
        if (first < 0) first = i;
        last = i;
      }
    }
    if (first < 0) {
      return { firstSound: 0, lastSound: duration || 0, introEnd: 0, outroStart: Math.max(0, (duration || 0) - 8) };
    }
    const firstSound = first / sampleRate;
    const lastSound = Math.min(duration || last / sampleRate, (last + step) / sampleRate);
    const body = Math.max(0, lastSound - firstSound);
    const introPad = clamp(Math.min(12, body * 0.12), 2, 12);
    const outroPad = clamp(Math.min(14, body * 0.14), 3, 14);
    const introEnd = clamp(firstSound + introPad, firstSound, Math.max(firstSound, lastSound - 4));
    const outroStart = clamp(lastSound - outroPad, introEnd + 2, lastSound);
    return { firstSound, lastSound, introEnd, outroStart };
  }

  function buildBeatGrid(onset, rate, duration) {
    if (!onset?.length || !rate || duration < 8) {
      return { bpm: 0, beatInterval: 0, beats: [], phrases: [] };
    }
    const minBpm = 70;
    const maxBpm = 180;
    const minLag = Math.max(2, Math.floor((60 / maxBpm) * rate));
    const maxLag = Math.min(Math.floor(onset.length / 3), Math.floor((60 / minBpm) * rate));
    const a0 = Math.floor(onset.length * 0.15);
    const a1 = Math.floor(onset.length * 0.85);
    let bestLag = 0;
    let bestScore = -1;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let s = 0;
      for (let i = a0; i + lag < a1; i += 2) s += onset[i] * onset[i + lag];
      if (s > bestScore) {
        bestScore = s;
        bestLag = lag;
      }
    }
    if (bestLag < 2) return { bpm: 0, beatInterval: 0, beats: [], phrases: [] };

    let bpm = (60 * rate) / bestLag;
    if (bpm < 85) bpm *= 2;
    else if (bpm > 165) bpm /= 2;
    bpm = clamp(bpm, minBpm, maxBpm);
    const beatInterval = 60 / bpm;

    let bestPhase = 0;
    let phaseScore = -1;
    const steps = 32;
    for (let s = 0; s < steps; s++) {
      const phase = (beatInterval * s) / steps;
      let sc = 0;
      for (let t = phase; t < duration - 0.05; t += beatInterval) {
        const i = Math.floor(t * rate);
        if (i >= 0 && i < onset.length) sc += onset[i];
      }
      if (sc > phaseScore) {
        phaseScore = sc;
        bestPhase = phase;
      }
    }

    const beats = [];
    for (let t = bestPhase; t < duration - 0.02; t += beatInterval) beats.push(+t.toFixed(4));
    const phrases = [];
    for (let i = 0; i < beats.length; i += 8) phrases.push(beats[i]);
    return { bpm, beatInterval, beats, phrases };
  }

  function downsampleCurve(arr, maxLen = 480) {
    if (!arr?.length) return null;
    if (arr.length <= maxLen) return arr instanceof Float32Array ? arr : Float32Array.from(arr);
    const out = new Float32Array(maxLen);
    const step = arr.length / maxLen;
    for (let i = 0; i < maxLen; i++) {
      const a = Math.floor(i * step);
      const b = Math.min(arr.length, Math.floor((i + 1) * step));
      let s = 0;
      let n = 0;
      for (let j = a; j < b; j++) {
        s += arr[j];
        n++;
      }
      out[i] = n ? s / n : 0;
    }
    return out;
  }

  function nearestTime(list, t) {
    if (!list?.length) return t;
    let best = list[0];
    let bestD = Math.abs(best - t);
    for (let i = 1; i < list.length; i++) {
      const d = Math.abs(list[i] - t);
      if (d < bestD) {
        bestD = d;
        best = list[i];
      }
    }
    return best;
  }

  /** Full PCM → analysis features. Does not retain the PCM buffer. */
  function analyzePcm(channel, sampleRate, duration, opts = {}) {
    const loudNorm = opts.loudNorm !== false;
    const start = Math.floor(channel.length * 0.15);
    const end = Math.floor(channel.length * 0.85);
    let sum = 0;
    let n = 0;
    for (let i = start; i < end; i += 48) {
      sum += channel[i] * channel[i];
      n++;
    }
    const rms = Math.sqrt(sum / Math.max(1, n));
    const gain = loudNorm ? clamp(TARGET_RMS / Math.max(rms, 1e-5), 0.4, 2.6) : 1;
    const { env, rate } = envelopeMono(channel, sampleRate, 80);
    const onset = onsetFromEnv(env);
    const grid = buildBeatGrid(onset, rate, duration);
    const silence = detectSilence(channel, sampleRate, duration);
    return {
      gain,
      env,
      onset,
      rate,
      duration,
      bpm: grid.bpm,
      beatInterval: grid.beatInterval,
      beats: grid.beats,
      phrases: grid.phrases,
      firstSound: silence.firstSound,
      lastSound: silence.lastSound,
      introEnd: silence.introEnd,
      outroStart: silence.outroStart,
      compact: false,
      touchedAt: Date.now(),
    };
  }

  /** Drop high-res curves to free heap; keep cues / grid / loudness. */
  function compactAnalysis(a) {
    if (!a || a.compact) return a;
    const rate = a.rate || 80;
    const env = downsampleCurve(a.env, 400);
    const onset = downsampleCurve(a.onset, 400);
    const newRate = env && a.env?.length ? (rate * env.length) / a.env.length : rate;
    a.env = env;
    a.onset = onset;
    a.rate = newRate;
    a.compact = true;
    a.touchedAt = Date.now();
    return a;
  }

  function emptyAnalysis(extra = {}) {
    return {
      gain: 1,
      env: null,
      onset: null,
      rate: 80,
      bpm: 0,
      beatInterval: 0,
      beats: [],
      phrases: [],
      duration: 0,
      firstSound: 0,
      lastSound: 0,
      introEnd: 0,
      outroStart: 0,
      compact: true,
      touchedAt: Date.now(),
      ...extra,
    };
  }

  /**
   * Mixxx-style fitness → transition decision:
   * cut | beat | fade
   */
  function scoreFitness(fromA, toA) {
    const fromBpm = fromA?.bpm || 0;
    const toBpm = toA?.bpm || 0;
    let bpmRatio = 1;
    let bpmScore = 0.35;
    if (fromBpm > 0 && toBpm > 0) {
      bpmRatio = fromBpm / toBpm;
      const r = bpmRatio > 1 ? bpmRatio : 1 / bpmRatio;
      if (r <= 1.03) bpmScore = 1;
      else if (r <= 1.08) bpmScore = 0.82;
      else if (r <= 1.15) bpmScore = 0.55;
      else if (r <= 1.3) bpmScore = 0.3;
      else bpmScore = 0.1;
    }
    const gridScore = (fromA?.beats?.length ? 0.5 : 0) + (toA?.beats?.length ? 0.5 : 0);
    const silenceScore =
      (toA?.introEnd > 0 || toA?.firstSound > 0.05 ? 0.5 : 0.25) +
      (fromA?.outroStart > 0 ? 0.5 : 0.25);
    const score = clamp(bpmScore * 0.55 + gridScore * 0.25 + silenceScore * 0.2, 0, 1);
    return { score, bpmRatio, bpmScore, gridScore };
  }

  /**
   * Plan dual-deck handoff (inspired by Mixxx AutoDJ FullIntroOutro / FixedSkipSilence).
   * @returns {{ mode, fadeSec, fromFadeBegin, fromFadeEnd, toStart, syncRate, confidence, reason }}
   */
  function planTransition(fromA, toA, fromPos, opts = {}) {
    const preferSec = Number(opts.fadeSec);
    const userFade = Number.isFinite(preferSec) && preferSec > 0 ? preferSec : 2.5;
    const fitness = scoreFitness(fromA, toA);
    const fromDur = fromA?.duration || Math.max(fromPos + 30, 60);
    const toDur = toA?.duration || 60;
    const outroStart = fromA?.outroStart > 0 ? fromA.outroStart : Math.max(0, fromDur - 10);
    const outroEnd = fromA?.lastSound > 0 ? fromA.lastSound : fromDur;
    const introStart = Math.max(0, toA?.firstSound || 0);
    const introEnd = toA?.introEnd > 0 ? toA.introEnd : Math.min(toDur * 0.12, 10);
    const allowCut = !!opts.allowCut;
    const crossTrack = !!opts.crossTrack;

    let syncRate = 1;
    if (fitness.bpmRatio >= 0.92 && fitness.bpmRatio <= 1.08 && Math.abs(fitness.bpmRatio - 1) >= 0.025) {
      syncRate = fitness.bpmRatio;
    }

    const nearPhrase =
      fromA?.phrases?.length &&
      Math.abs(nearestTime(fromA.phrases, fromPos) - fromPos) < (fromA.beatInterval || 0.5) * 1.2;

    let mode = 'fade';
    let reason = 'intro/outro crossfade';
    // Hard cuts only when explicitly allowed (same-song) — never default for mid-song / cross-track
    if (allowCut && fitness.score >= 0.88 && nearPhrase && Math.abs(syncRate - 1) < 0.03) {
      mode = 'cut';
      reason = 'phrase-compatible hard cut';
    } else if (fitness.score >= 0.55 && fromA?.beats?.length && toA?.beats?.length) {
      mode = 'beat';
      reason = 'beat-aligned overlap';
    }
    if (crossTrack && mode === 'cut') {
      mode = 'fade';
      reason = 'cross-track prefers outro/intro fade';
    }

    let fadeSec = userFade;
    let fromFadeBegin = fromPos;
    let fromFadeEnd = fromPos + fadeSec;
    let toStart = introStart;

    if (mode === 'cut') {
      fadeSec = clamp(userFade * 0.45, 0.35, 0.9);
      const bt = fromA?.beats?.length ? nearestTime(fromA.beats, fromPos) : fromPos;
      fromFadeBegin = bt;
      fromFadeEnd = bt + fadeSec;
      toStart = toA?.beats?.length ? nearestTime(toA.beats, introStart) : introStart;
    } else if (mode === 'beat') {
      fadeSec = clamp(Math.max(userFade, 2), 1.5, 6);
      if (crossTrack) {
        fromFadeBegin = fromPos < outroStart - 1.5 ? outroStart : Math.max(fromPos, outroStart);
        fromFadeEnd = Math.min(outroEnd, fromFadeBegin + fadeSec);
        fadeSec = Math.max(1.5, fromFadeEnd - fromFadeBegin);
        toStart = introStart;
        if (toA?.beats?.length) toStart = nearestTime(toA.beats, introStart);
      } else {
        fromFadeBegin = fromPos;
        fromFadeEnd = fromPos + fadeSec;
        if (toA?.beats?.length) toStart = nearestTime(toA.beats, introStart);
        else toStart = introStart;
      }
    } else {
      // Mixxx / Veloura style: blend across outro into next intro
      const outroLen = Math.max(1.5, outroEnd - outroStart);
      const introLen = Math.max(1.5, introEnd - introStart);
      fadeSec = clamp(Math.min(outroLen, introLen, Math.max(userFade, 3)), 2, 10);
      if (fromPos < outroStart - 1.5) {
        fromFadeBegin = outroStart;
        fromFadeEnd = Math.min(outroEnd, fromFadeBegin + fadeSec);
        fadeSec = Math.max(2, fromFadeEnd - fromFadeBegin);
      } else {
        fromFadeBegin = Math.max(fromPos, outroStart);
        fromFadeEnd = Math.min(outroEnd, fromFadeBegin + fadeSec);
        fadeSec = Math.max(1.5, fromFadeEnd - fromFadeBegin);
      }
      toStart = introStart;
    }

    toStart = clamp(toStart, 0, Math.max(0, toDur - 4));
    return {
      mode,
      fadeSec,
      fromFadeBegin,
      fromFadeEnd,
      toStart,
      syncRate,
      confidence: fitness.score,
      reason,
      fitness,
    };
  }

  class AnalysisCache {
    constructor(max = MAX_CACHE) {
      this.max = max;
      this.map = new Map();
    }
    has(id) {
      return this.map.has(id);
    }
    get(id) {
      const v = this.map.get(id);
      if (v && typeof v.then !== 'function') v.touchedAt = Date.now();
      return v;
    }
    set(id, value) {
      if (this.map.has(id)) this.map.delete(id);
      this.map.set(id, value);
      this.prune();
    }
    delete(id) {
      this.map.delete(id);
    }
    clear() {
      this.map.clear();
    }
    get size() {
      return this.map.size;
    }
    touchKeep(ids = []) {
      const keep = new Set(ids.filter(Boolean));
      for (const [id, v] of this.map) {
        if (keep.has(id)) {
          if (v && typeof v.then !== 'function') v.touchedAt = Date.now();
        } else if (v && typeof v.then !== 'function' && !v.compact) {
          compactAnalysis(v);
        }
      }
      this.prune();
    }
    prune() {
      while (this.map.size > this.max) {
        let oldestId = null;
        let oldestAt = Infinity;
        for (const [id, v] of this.map) {
          if (typeof v?.then === 'function') continue;
          const t = v?.touchedAt || 0;
          if (t < oldestAt) {
            oldestAt = t;
            oldestId = id;
          }
        }
        if (!oldestId) {
          // drop first settled or first key
          oldestId = this.map.keys().next().value;
        }
        if (!oldestId) break;
        this.map.delete(oldestId);
      }
    }
  }

  const MixEngine = {
    TARGET_RMS,
    SILENCE_LIN,
    MAX_CACHE,
    envelopeMono,
    onsetFromEnv,
    detectSilence,
    buildBeatGrid,
    analyzePcm,
    compactAnalysis,
    emptyAnalysis,
    scoreFitness,
    planTransition,
    nearestTime,
    downsampleCurve,
    AnalysisCache,
  };

  global.MixEngine = MixEngine;
  if (typeof module !== 'undefined' && module.exports) module.exports = MixEngine;
})(typeof window !== 'undefined' ? window : globalThis);
