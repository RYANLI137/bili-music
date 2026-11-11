'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

function runtimeRoots() {
  const roots = [];
  try {
    const { app } = require('electron');
    if (app?.isPackaged) roots.push(path.join(process.resourcesPath, 'veloura-runtime'));
    roots.push(path.join(app.getAppPath(), 'vendor', 'veloura-runtime'));
  } catch (_) {}
  roots.push(path.join(__dirname, '..', 'vendor', 'veloura-runtime'));
  return roots;
}

function findRuntime() {
  for (const root of runtimeRoots()) {
    const py = path.join(root, 'python.exe');
    const bridge = path.join(root, 'veloura_bridge.py');
    if (fs.existsSync(py) && fs.existsSync(bridge)) return { root, py, bridge };
  }
  return null;
}

let cachedStatus = null;
let cachedFfmpeg = null;

function runBridge(req, timeoutMs = 45000) {
  const rt = findRuntime();
  if (!rt) {
    return Promise.resolve({ ok: false, error: 'veloura-runtime missing (run npm run prepare:veloura)' });
  }
  const payload = JSON.stringify(req);
  return new Promise((resolve) => {
    const child = spawn(rt.py, [rt.bridge], {
      cwd: rt.root,
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
        VELOURA_CACHE_DIR: path.join(os.tmpdir(), 'bili-music-veloura-cache'),
      },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch (_) {}
      resolve({ ok: false, error: 'veloura timeout' });
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: String(e.message || e) });
    });
    child.on('close', () => {
      clearTimeout(timer);
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop() || '';
      try {
        resolve(JSON.parse(line));
      } catch (_) {
        resolve({ ok: false, error: stderr.trim() || line || 'invalid veloura response' });
      }
    });
    child.stdin.write(payload);
    child.stdin.end();
  });
}

async function status(force = false) {
  if (cachedStatus && !force) return cachedStatus;
  cachedStatus = await runBridge({ cmd: 'status' }, 15000);
  if (cachedStatus?.ok && cachedStatus.data?.ffmpeg && !String(cachedStatus.data.ffmpeg).startsWith('missing')) {
    cachedFfmpeg = cachedStatus.data.ffmpeg;
  }
  return cachedStatus;
}

function resolveFfmpeg() {
  if (cachedFfmpeg && fs.existsSync(cachedFfmpeg)) return cachedFfmpeg;
  const rt = findRuntime();
  if (!rt) return null;
  const r = spawnSync(rt.py, ['-c', 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())'], {
    cwd: rt.root,
    windowsHide: true,
    encoding: 'utf8',
    timeout: 20000,
  });
  const p = (r.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop();
  if (p && fs.existsSync(p)) {
    cachedFfmpeg = p;
    return p;
  }
  return null;
}

function ffmpegHeaders(headers = {}) {
  return (
    Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n') + '\r\n'
  );
}

/** Cut a short analysis window with bundled FFmpeg (not full-track download). */
function extractWindow(url, dest, { start = 0, duration = 36, headers = {} } = {}) {
  const ffmpeg = resolveFfmpeg();
  if (!ffmpeg) return Promise.reject(new Error('bundled ffmpeg missing'));
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  if (headers && Object.keys(headers).length) args.push('-headers', ffmpegHeaders(headers));
  if (start > 0.25) args.push('-ss', String(Math.max(0, start)));
  args.push('-i', url, '-t', String(Math.max(4, duration)), '-vn', '-c:a', 'aac', '-b:a', '192k', dest);
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true });
    let err = '';
    child.stderr.on('data', (d) => {
      err += d.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 && fs.existsSync(dest) && fs.statSync(dest).size > 1024) resolve(dest);
      else reject(new Error(err.trim() || `ffmpeg exit ${code}`));
    });
  });
}

async function planTransition({
  current,
  next,
  preset = 'automix',
  mode = 'automix',
  timeoutMs = 55000,
} = {}) {
  if (!current || !next) return { ok: false, error: 'current/next required' };
  const cmd = mode === 'slm' ? 'plan_slm' : 'plan_automix';
  return runBridge(
    {
      cmd,
      preset,
      current,
      next,
      analysis_seconds: 36,
      timeout: Math.max(8, Math.min(25, Math.floor(timeoutMs / 1000) - 5)),
    },
    timeoutMs,
  );
}

module.exports = {
  findRuntime,
  status,
  runBridge,
  planTransition,
  extractWindow,
  resolveFfmpeg,
};
