'use strict';

const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { dialog, BrowserWindow } = require('electron');
const bili = require('./bili');
const veloura = require('./veloura');
const logger = require('./logger');

function safeName(s) {
  return (
    String(s || 'bilibili')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'bilibili'
  );
}

function headerArg() {
  return `Referer: ${bili.REFERER}\r\nUser-Agent: ${bili.UA}\r\n`;
}

function runFfmpeg(args, onProgress) {
  const ffmpeg = veloura.resolveFfmpeg();
  if (!ffmpeg) return Promise.reject(new Error('未找到 FFmpeg，请先运行 npm run prepare:veloura'));
  return new Promise((resolve, reject) => {
    logger.info('ffmpeg', args.filter((a, i) => !(i > 0 && args[i - 1] === '-headers')).join(' '));
    const child = spawn(ffmpeg, ['-hide_banner', '-y', ...args], { windowsHide: true });
    let err = '';
    child.stderr.on('data', (d) => {
      const s = d.toString('utf8');
      err += s;
      if (onProgress && /time=/.test(s)) onProgress('downloading');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(true);
      else reject(new Error((err.trim().split(/\r?\n/).slice(-3).join(' ') || `ffmpeg exit ${code}`).slice(0, 300)));
    });
  });
}

async function downloadAudio({ bvid, cid, dest }, onProgress) {
  const media = await bili.mediaUrl(bvid, cid);
  const url = media.audio?.urls?.[0] || media.combined?.urls?.[0];
  if (!url) throw new Error('没有可用的音频流');
  const h = headerArg();
  onProgress?.('fetch');
  try {
    await runFfmpeg(['-headers', h, '-i', url, '-vn', '-c:a', 'copy', dest], onProgress);
  } catch (_) {
    await runFfmpeg(['-headers', h, '-i', url, '-vn', '-c:a', 'aac', '-b:a', '192k', dest], onProgress);
  }
  return dest;
}

async function downloadVideo({ bvid, cid, dest }, onProgress) {
  const media = await bili.mediaUrl(bvid, cid);
  const h = headerArg();
  onProgress?.('fetch');
  if (media.combined?.urls?.[0]) {
    await runFfmpeg(['-headers', h, '-i', media.combined.urls[0], '-c', 'copy', dest], onProgress);
    return dest;
  }
  const vUrl = media.video?.urls?.[0];
  const aUrl = media.audio?.urls?.[0];
  if (!vUrl) throw new Error('没有可用的视频流（可能需登录大会员）');
  if (!aUrl) {
    await runFfmpeg(['-headers', h, '-i', vUrl, '-c', 'copy', dest], onProgress);
    return dest;
  }
  try {
    await runFfmpeg(['-headers', h, '-i', vUrl, '-headers', h, '-i', aUrl, '-c', 'copy', '-shortest', dest], onProgress);
  } catch (_) {
    await runFfmpeg(
      ['-headers', h, '-i', vUrl, '-headers', h, '-i', aUrl, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', dest],
      onProgress,
    );
  }
  return dest;
}

async function pickSavePath(win, { title, kind }) {
  const name = safeName(title);
  const ext = kind === 'video' ? 'mp4' : 'm4a';
  const r = await dialog.showSaveDialog(win || BrowserWindow.getFocusedWindow(), {
    title: kind === 'video' ? '下载原视频' : '下载音频',
    defaultPath: path.join(os.homedir(), 'Downloads', `${name}.${ext}`),
    filters:
      kind === 'video'
        ? [{ name: 'MP4 视频', extensions: ['mp4'] }]
        : [
            { name: 'M4A 音频', extensions: ['m4a'] },
            { name: '所有文件', extensions: ['*'] },
          ],
  });
  if (r.canceled || !r.filePath) return null;
  return r.filePath;
}

let videoWin = null;

function openVideoWindow(parent, { bvid, cid, page = 1, title }) {
  if (!bvid) throw new Error('缺少视频 BV 号');
  if (videoWin && !videoWin.isDestroyed()) {
    videoWin.focus();
    videoWin.webContents.send('video:load', { bvid, cid: cid || '', page: page || 1, title: title || '' });
    return true;
  }
  videoWin = new BrowserWindow({
    width: 560,
    height: 380,
    minWidth: 360,
    minHeight: 260,
    show: true,
    title: title ? `${title} · 原视频` : '原视频',
    parent: parent || undefined,
    autoHideMenuBar: true,
    backgroundColor: '#0b0b0c',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload-video.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  videoWin.on('closed', () => {
    videoWin = null;
  });
  const q = new URLSearchParams({
    bvid: String(bvid || ''),
    cid: String(cid || ''),
    page: String(page || 1),
    title: String(title || ''),
  });
  videoWin.loadFile(path.join(__dirname, '..', 'renderer', 'video.html'), { search: `?${q}` });
  return true;
}

module.exports = {
  downloadAudio,
  downloadVideo,
  pickSavePath,
  openVideoWindow,
  safeName,
};
