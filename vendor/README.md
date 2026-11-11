# Bundled engines

## `veloura-runtime/` (generated)

Built by `npm run prepare:veloura` — embeddable CPython + [veloura-audio](https://pypi.org/project/veloura-audio/) + FFmpeg (`imageio-ffmpeg`).

Copied into the Windows installer as `resources/veloura-runtime` so end users do **not** need to install Python.

## `bridge/veloura_bridge.py`

JSON stdin/stdout bridge used by `src/veloura.js`.
