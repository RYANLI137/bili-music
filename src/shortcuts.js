'use strict';

const { globalShortcut } = require('electron');

const DEFAULTS = {
  enabled: true,
  playPause: 'CommandOrControl+Alt+Space',
  prev: 'CommandOrControl+Alt+Left',
  next: 'CommandOrControl+Alt+Right',
  volUp: 'CommandOrControl+Alt+Up',
  volDown: 'CommandOrControl+Alt+Down',
  like: 'CommandOrControl+Alt+V',
};

const ACTIONS = [
  { id: 'playPause', label: '播放 / 暂停' },
  { id: 'prev', label: '上一首' },
  { id: 'next', label: '下一首' },
  { id: 'volUp', label: '音量加' },
  { id: 'volDown', label: '音量减' },
  { id: 'like', label: '喜欢当前歌曲' },
];

const MEDIA_KEYS = [
  { accel: 'MediaPlayPause', action: 'playPause' },
  { accel: 'MediaPreviousTrack', action: 'prev' },
  { accel: 'MediaNextTrack', action: 'next' },
];

const MOD_ORDER = ['CommandOrControl', 'Alt', 'Shift', 'Super'];

let send = () => {};

function setSender(fn) {
  send = typeof fn === 'function' ? fn : () => {};
}

function looksCorrupted(s) {
  return /[§$]{2,}|§CTRL§|\$CTRL\$/i.test(String(s || ''));
}

/**
 * 统一成 Electron accelerator 写法。必须幂等：多次调用结果不变。
 * 旧版用 §CTRL§ 占位时，第二步 Ctrl 正则会再次命中占位符，导致
 * CommandOrControl 被撑成 $$$$$$Ctrl$$$$$$…（日志里的 conversion failure）。
 */
function canonAccel(s) {
  if (!s) return '';
  let t = String(s).trim();
  // 清掉历史占位符污染
  t = t.replace(/[§$]*CTRL[§$]*/gi, 'Ctrl');
  t = t.replace(/[§$]+/g, '');
  t = t.replace(/\s+/g, '');
  t = t.replace(/\++/g, '+').replace(/^\+|\+$/g, '');
  t = t.replace(/CommandOrControl/gi, 'Ctrl');
  t = t.replace(/Control/gi, 'Ctrl');
  t = t.replace(/Option/gi, 'Alt');
  t = t.replace(/\bMeta\b/gi, 'Command');
  t = t.replace(/\bSpacebar\b/gi, 'Space');

  const parts = t.split('+').filter(Boolean);
  const mods = new Set();
  let key = '';
  for (const raw of parts) {
    const p = raw.trim();
    const low = p.toLowerCase();
    if (low === 'ctrl' || low === 'control' || low === 'commandorcontrol') {
      mods.add('CommandOrControl');
    } else if (low === 'cmd' || low === 'command' || low === 'meta') {
      mods.add('CommandOrControl');
    } else if (low === 'alt' || low === 'option') {
      mods.add('Alt');
    } else if (low === 'shift') {
      mods.add('Shift');
    } else if (low === 'super') {
      mods.add('Super');
    } else if (p) {
      key = /^[a-z]$/i.test(p) ? p.toUpperCase() : p;
    }
  }
  if (!key || /^(Ctrl|Alt|Shift|Super|CommandOrControl|Command|Control|Meta)$/i.test(key)) return '';
  return [...MOD_ORDER.filter((m) => mods.has(m)), key].join('+');
}

function normalize(cfg = {}) {
  const raw = cfg && typeof cfg === 'object' ? cfg : {};
  const c = { ...DEFAULTS, enabled: raw.enabled !== false };
  for (const a of ACTIONS) {
    const incoming = raw[a.id];
    // 污染或空值 → 回退默认
    if (!incoming || looksCorrupted(incoming)) {
      c[a.id] = DEFAULTS[a.id];
      continue;
    }
    const fixed = canonAccel(incoming);
    c[a.id] = fixed || DEFAULTS[a.id];
  }
  // 迁移：旧默认 Ctrl+Alt+F5 → Ctrl+Alt+Space
  if (!raw.playPause || canonAccel(raw.playPause) === 'CommandOrControl+Alt+F5' || looksCorrupted(raw.playPause)) {
    c.playPause = DEFAULTS.playPause;
  }
  return c;
}

function unregisterAll() {
  try {
    globalShortcut.unregisterAll();
  } catch (_) {}
}

function registerOne(accel, action) {
  const a = canonAccel(accel);
  if (!a || looksCorrupted(a)) return { ok: false, error: '无效快捷键' };
  const alts = [...new Set([a, a.replace(/CommandOrControl/g, 'Control'), a.replace(/CommandOrControl/g, 'Ctrl')])];
  let lastErr = '已被其他程序占用';
  for (const accelTry of alts) {
    try {
      if (globalShortcut.isRegistered(accelTry)) {
        try {
          globalShortcut.unregister(accelTry);
        } catch (_) {}
      }
      const ok = globalShortcut.register(accelTry, () => {
        try {
          send(action);
        } catch (_) {}
      });
      if (ok) return { ok: true, accel: accelTry };
      lastErr = '已被其他程序占用';
    } catch (e) {
      lastErr = String(e?.message || e);
    }
  }
  return { ok: false, error: lastErr };
}

/** @returns {{ ok: boolean, failed: {id,accel,error}[], registered: string[], config: object }} */
function apply(cfg) {
  unregisterAll();
  const c = normalize(cfg);
  const failed = [];
  const registered = [];
  if (!c.enabled) return { ok: true, failed, registered, config: c };

  for (const a of ACTIONS) {
    const accel = c[a.id];
    if (!accel) continue;
    const r = registerOne(accel, a.id);
    if (!r.ok) failed.push({ id: a.id, accel, error: r.error });
    else registered.push(`${a.id}:${r.accel}`);
  }
  for (const m of MEDIA_KEYS) {
    try {
      globalShortcut.register(m.accel, () => send(m.action));
      registered.push(`media:${m.accel}`);
    } catch (_) {}
  }
  return { ok: failed.length === 0, failed, registered, config: c };
}

function displayAccel(accel) {
  return canonAccel(accel)
    .replace(/CommandOrControl/g, 'Ctrl')
    .replace(/Command/g, 'Cmd')
    .replace(/\+/g, ' + ') || '未设置';
}

module.exports = {
  DEFAULTS,
  ACTIONS,
  apply,
  normalize,
  canonAccel,
  unregisterAll,
  setSender,
  displayAccel,
};
