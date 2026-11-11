'use strict';

/**
 * GitHub Releases + electron-updater
 * 仓库：https://github.com/RYANLI137/bili-music
 */

const { dialog } = require('electron');
const logger = require('./logger');

let autoUpdater = null;
let started = false;
let lastStatus = { state: 'idle', message: '' };

function getStatus() {
  return { ...lastStatus, version: require('../package.json').version };
}

function setStatus(state, message, extra = {}) {
  lastStatus = { state, message: message || '', ...extra, at: Date.now() };
  return lastStatus;
}

function send(win, channel, payload) {
  try {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  } catch (_) {}
}

function init(win) {
  if (started) return;
  started = true;

  // 开发态不检查（未打包）
  const { app } = require('electron');
  if (!app.isPackaged) {
    setStatus('dev', '开发模式不检查更新');
    return;
  }

  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (e) {
    logger.warn('electron-updater missing', e?.message || e);
    setStatus('error', '未安装 electron-updater');
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // 私有仓库才需要 token；公开仓库可不设
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) {
    autoUpdater.setFeedURL({
      provider: 'github',
      owner: 'RYANLI137',
      repo: 'bili-music',
      private: false,
      token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
    });
  }

  autoUpdater.on('checking-for-update', () => {
    setStatus('checking', '正在检查更新…');
    send(win, 'update:status', getStatus());
  });

  autoUpdater.on('update-available', (info) => {
    setStatus('available', `发现新版本 ${info.version}`, { info });
    send(win, 'update:status', getStatus());
    logger.info('update available', info.version);
  });

  autoUpdater.on('update-not-available', (info) => {
    setStatus('latest', `已是最新版 ${info?.version || ''}`.trim());
    send(win, 'update:status', getStatus());
  });

  autoUpdater.on('download-progress', (p) => {
    setStatus('downloading', `下载更新 ${Math.round(p.percent || 0)}%`, {
      percent: p.percent,
      transferred: p.transferred,
      total: p.total,
    });
    send(win, 'update:status', getStatus());
  });

  autoUpdater.on('update-downloaded', async (info) => {
    setStatus('ready', `更新 ${info.version} 已下载，重启后安装`, { info });
    send(win, 'update:status', getStatus());
    logger.info('update downloaded', info.version);
    const r = await dialog.showMessageBox(win, {
      type: 'info',
      title: '发现新版本',
      message: `Bili Music ${info.version} 已下载完成`,
      detail: '重启应用即可完成更新。也可以稍后在退出时自动安装。',
      buttons: ['立即重启', '稍后'],
      defaultId: 0,
      cancelId: 1,
    });
    if (r.response === 0) {
      try {
        autoUpdater.quitAndInstall(false, true);
      } catch (e) {
        logger.error('quitAndInstall failed', e);
      }
    }
  });

  autoUpdater.on('error', (err) => {
    const msg = String(err?.message || err);
    setStatus('error', msg);
    send(win, 'update:status', getStatus());
    logger.warn('updater error', msg);
  });

  // 启动稍后检查，避免拖慢首屏
  setTimeout(() => check(false), 8000);
}

function check(manual = false) {
  const { app } = require('electron');
  if (!app.isPackaged) {
    setStatus('dev', '开发模式不检查更新（请用安装包验证）');
    return Promise.resolve(getStatus());
  }
  if (!autoUpdater) {
    try {
      ({ autoUpdater } = require('electron-updater'));
    } catch (e) {
      return Promise.resolve(setStatus('error', '未安装 electron-updater'));
    }
  }
  setStatus('checking', manual ? '正在检查更新…' : '正在检查更新…');
  return autoUpdater
    .checkForUpdates()
    .then((r) => {
      if (!r) return getStatus();
      return getStatus();
    })
    .catch((e) => setStatus('error', String(e?.message || e)));
}

function quitAndInstall() {
  if (!autoUpdater) return false;
  autoUpdater.quitAndInstall(false, true);
  return true;
}

module.exports = { init, check, getStatus, quitAndInstall };
