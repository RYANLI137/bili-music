#!/usr/bin/env python3
"""JSON-lines bridge: Electron main <-> veloura-audio AutoMix / SLM."""

from __future__ import annotations

import json
import sys
import traceback
from pathlib import Path


def _ok(data=None, **extra):
    out = {"ok": True}
    if data is not None:
        out["data"] = data
    out.update(extra)
    return out


def _err(msg: str, **extra):
    out = {"ok": False, "error": str(msg)}
    out.update(extra)
    return out


def _track(payload: dict):
    from veloura.audio import AudioTrack

    source = payload.get("path") or payload.get("url") or payload.get("source")
    title = payload.get("title") or (Path(str(source)).name if source else "track")
    # SLM can plan from metadata alone; AutoMix needs a real path/url for beat windows.
    if not source:
        source = f"meta://{title}"
    return AudioTrack.from_source(
        source,
        title=title,
        duration=float(payload.get("duration") or 0) or None,
        artist=payload.get("artist") or payload.get("author") or None,
        album=payload.get("album") or None,
        trim_start=float(payload.get("trim_start") or 0) or 0.0,
        trim_end=float(payload.get("trim_end") or 0) or 0.0,
    )


def cmd_status(_req: dict):
    import veloura

    ffmpeg = None
    try:
        import imageio_ffmpeg

        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception as exc:  # noqa: BLE001
        ffmpeg = f"missing: {exc}"
    return _ok(
        {
            "veloura": getattr(veloura, "__version__", "unknown"),
            "python": sys.version.split()[0],
            "ffmpeg": ffmpeg,
            "bridge": "1.0.0",
        }
    )


def cmd_doctor(_req: dict):
    # Best-effort; don't fail hard if CLI internals change.
    try:
        from veloura.cli import doctor  # type: ignore

        doctor.main([])  # may print; we still return structured status
    except Exception:
        pass
    return cmd_status(_req)


def cmd_plan_slm(req: dict):
    from veloura.audio import plan_slm_transition, transition_preset

    preset = req.get("preset") or "automix"
    config = transition_preset(preset)
    current = _track(req["current"])
    nxt = _track(req["next"])
    plan = plan_slm_transition(current, nxt, config)
    return _ok(
        {
            "engine": "veloura-slm",
            "preset": preset,
            "crossfade_seconds": plan.crossfade_seconds,
            "confidence": plan.confidence,
            "reason": plan.reason,
            "bpm_delta": plan.bpm_delta,
            "safety_capped": plan.safety_capped,
            "mode": "fade",
            "fadeSec": plan.crossfade_seconds,
            "toStart": float(getattr(nxt, "trim_start", 0) or 0),
            "syncRate": 1.0,
        }
    )


def cmd_plan_automix(req: dict):
    from veloura.audio import prepare_automix_transition_pair, transition_preset

    preset = req.get("preset") or "automix"
    config = transition_preset(preset)
    current = _track(req["current"])
    nxt = _track(req["next"])
    analysis_seconds = float(req.get("analysis_seconds") or 36)
    timeout = req.get("timeout")
    plan = prepare_automix_transition_pair(
        current,
        nxt,
        config,
        analysis_seconds=analysis_seconds,
        timeout=None if timeout is None else float(timeout),
    )
    return _ok(
        {
            "engine": "veloura-automix",
            "preset": preset,
            "crossfade_seconds": plan.crossfade_seconds,
            "confidence": plan.confidence,
            "reason": plan.reason,
            "current_trim_end": plan.current_trim_end,
            "next_trim_start": plan.next_trim_start,
            "next_tempo": plan.next_tempo,
            "mode": "beat" if (plan.confidence or 0) >= 0.45 else "fade",
            "fadeSec": plan.crossfade_seconds,
            "toStart": float(plan.next_trim_start or 0),
            "syncRate": float(plan.next_tempo or 1.0),
            "fromFadeTrim": float(plan.current_trim_end or 0),
        }
    )


HANDLERS = {
    "status": cmd_status,
    "doctor": cmd_doctor,
    "plan_slm": cmd_plan_slm,
    "plan_automix": cmd_plan_automix,
    "plan": cmd_plan_automix,
}


def main() -> int:
    # Single-shot: one JSON object on argv or stdin.
    raw = None
    if len(sys.argv) > 1:
        raw = " ".join(sys.argv[1:])
    else:
        raw = sys.stdin.read()
    raw = (raw or "").strip()
    if not raw:
        print(json.dumps(_err("empty request"), ensure_ascii=False))
        return 2
    try:
        req = json.loads(raw)
    except json.JSONDecodeError as exc:
        print(json.dumps(_err(f"invalid json: {exc}"), ensure_ascii=False))
        return 2
    cmd = (req.get("cmd") or "status").strip().lower()
    handler = HANDLERS.get(cmd)
    if not handler:
        print(json.dumps(_err(f"unknown cmd: {cmd}", cmds=sorted(HANDLERS)), ensure_ascii=False))
        return 2
    try:
        result = handler(req)
    except Exception as exc:  # noqa: BLE001
        result = _err(str(exc), trace=traceback.format_exc(limit=6))
        print(json.dumps(result, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
