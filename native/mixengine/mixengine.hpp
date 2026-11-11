#pragma once
// MixEngine — Mixxx-inspired analysis helpers (silence / BPM fitness / transition plan).
// Spec mirror of renderer/mixengine.js for optional native builds.
// Reference: https://github.com/mixxxdj/mixxx

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <string>
#include <vector>

namespace mixengine {

constexpr float kSilenceLin = 0.001f; // ~-60 dB
constexpr float kTargetRms = 0.11f;

struct SilenceCues {
  double firstSound = 0;
  double lastSound = 0;
  double introEnd = 0;
  double outroStart = 0;
};

struct BeatGrid {
  double bpm = 0;
  double beatInterval = 0;
  std::vector<double> beats;
  std::vector<double> phrases;
};

struct Fitness {
  double score = 0;
  double bpmRatio = 1;
};

struct TransitionPlan {
  std::string mode; // cut | beat | fade
  double fadeSec = 1;
  double fromFadeBegin = 0;
  double fromFadeEnd = 0;
  double toStart = 0;
  double syncRate = 1;
  double confidence = 0;
};

inline double clampd(double v, double lo, double hi) {
  return std::max(lo, std::min(hi, v));
}

inline SilenceCues detectSilence(const float* samples, size_t n, double sampleRate, double duration) {
  SilenceCues out;
  if (!samples || n == 0 || sampleRate <= 0) {
    out.lastSound = duration;
    out.outroStart = std::max(0.0, duration - 8.0);
    return out;
  }
  const size_t step = std::max<size_t>(1, static_cast<size_t>(sampleRate / 200.0));
  int64_t first = -1;
  int64_t last = -1;
  for (size_t i = 0; i < n; i += step) {
    if (std::fabs(samples[i]) >= kSilenceLin) {
      if (first < 0) first = static_cast<int64_t>(i);
      last = static_cast<int64_t>(i);
    }
  }
  if (first < 0) {
    out.lastSound = duration;
    out.outroStart = std::max(0.0, duration - 8.0);
    return out;
  }
  out.firstSound = first / sampleRate;
  out.lastSound = std::min(duration, (last + static_cast<int64_t>(step)) / sampleRate);
  const double body = std::max(0.0, out.lastSound - out.firstSound);
  const double introPad = clampd(std::min(12.0, body * 0.12), 2.0, 12.0);
  const double outroPad = clampd(std::min(14.0, body * 0.14), 3.0, 14.0);
  out.introEnd = clampd(out.firstSound + introPad, out.firstSound, std::max(out.firstSound, out.lastSound - 4.0));
  out.outroStart = clampd(out.lastSound - outroPad, out.introEnd + 2.0, out.lastSound);
  return out;
}

inline Fitness scoreFitness(double fromBpm, double toBpm, bool fromHasBeats, bool toHasBeats) {
  Fitness f;
  double bpmScore = 0.35;
  if (fromBpm > 0 && toBpm > 0) {
    f.bpmRatio = fromBpm / toBpm;
    double r = f.bpmRatio > 1 ? f.bpmRatio : 1.0 / f.bpmRatio;
    if (r <= 1.03) bpmScore = 1;
    else if (r <= 1.08) bpmScore = 0.82;
    else if (r <= 1.15) bpmScore = 0.55;
    else if (r <= 1.3) bpmScore = 0.3;
    else bpmScore = 0.1;
  }
  const double gridScore = (fromHasBeats ? 0.5 : 0.0) + (toHasBeats ? 0.5 : 0.0);
  f.score = clampd(bpmScore * 0.55 + gridScore * 0.45, 0.0, 1.0);
  return f;
}

inline TransitionPlan planTransition(
    double fromPos,
    double fromDur,
    double toDur,
    double fromBpm,
    double toBpm,
    double outroStart,
    double outroEnd,
    double introStart,
    double introEnd,
    bool fromHasBeats,
    bool toHasBeats,
    double userFadeSec) {
  TransitionPlan p;
  const Fitness fit = scoreFitness(fromBpm, toBpm, fromHasBeats, toHasBeats);
  p.confidence = fit.score;
  p.syncRate = 1.0;
  if (fit.bpmRatio >= 0.92 && fit.bpmRatio <= 1.08 && std::fabs(fit.bpmRatio - 1.0) >= 0.025) {
    p.syncRate = fit.bpmRatio;
  }
  const double fadePref = userFadeSec > 0 ? userFadeSec : 1.0;

  if (fit.score >= 0.78 && std::fabs(p.syncRate - 1.0) < 0.04) {
    p.mode = "cut";
    p.fadeSec = clampd(fadePref * 0.35, 0.12, 0.45);
    p.fromFadeBegin = fromPos;
    p.fromFadeEnd = fromPos + p.fadeSec;
    p.toStart = introStart;
  } else if (fit.score >= 0.55 && fromHasBeats && toHasBeats) {
    p.mode = "beat";
    p.fadeSec = clampd(fadePref, 0.5, 2.5);
    p.fromFadeBegin = fromPos;
    p.fromFadeEnd = fromPos + p.fadeSec;
    p.toStart = introStart;
  } else {
    p.mode = "fade";
    const double outroLen = std::max(1.0, outroEnd - outroStart);
    const double introLen = std::max(1.0, introEnd - introStart);
    p.fadeSec = clampd(std::min({outroLen, introLen, std::max(fadePref, 2.0)}), 1.0, 8.0);
    if (fromPos < outroStart - 1.0) {
      p.fromFadeBegin = fromPos;
      p.fromFadeEnd = fromPos + p.fadeSec;
    } else {
      p.fromFadeBegin = std::max(fromPos, outroStart);
      p.fromFadeEnd = std::min(outroEnd, p.fromFadeBegin + p.fadeSec);
      p.fadeSec = std::max(0.6, p.fromFadeEnd - p.fromFadeBegin);
    }
    p.toStart = introStart;
  }
  p.toStart = clampd(p.toStart, 0.0, std::max(0.0, toDur - 4.0));
  (void)fromDur;
  return p;
}

} // namespace mixengine
