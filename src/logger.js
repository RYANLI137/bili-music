/**
 * 简易滚动日志（参考 electron-log / winston 的 size-rotate 思路）
 * - 当前文件超过 maxFileBytes → 轮转为 .1 .2 …
 * - 最多保留 maxFiles 个备份
 * - 启动时按天数清掉过旧备份
 * - 总占用粗控：超 maxTotalBytes 时从最旧删起
 */
const fs = require('fs');
const path = require('path');
const util = require('util');

const DEFAULTS = {
  maxFileBytes: 2 * 1024 * 1024, // 单文件 2MB
  maxFiles: 3, // main.log + .1 .2 .3
  maxTotalBytes: 8 * 1024 * 1024, // 目录合计约 8MB
  maxAgeDays: 14, // 备份超过 14 天删除
  keepLinesOnTrim: 2000, // 紧急裁剪时保留末尾行数
};

let opts = { ...DEFAULTS };
let logDir = '';
let logFile = '';
let writeStream = null;
let bytesWritten = 0;
let rotating = false;
let hooked = false;
const queue = [];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function safeStat(p) {
  try {
    return fs.statSync(p);
  } catch (_) {
    return null;
  }
}

function listLogFiles() {
  if (!logDir) return [];
  try {
    return fs
      .readdirSync(logDir)
      .filter((f) => /^main\.log(\.\d+)?$/i.test(f))
      .map((f) => {
        const full = path.join(logDir, f);
        const st = safeStat(full);
        return { name: f, path: full, size: st?.size || 0, mtime: st?.mtimeMs || 0 };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch (_) {
    return [];
  }
}

/** 删过期 / 超总大小的备份（不动正在写的 main.log） */
function pruneArchives() {
  if (!logDir) return;
  const now = Date.now();
  const maxAge = opts.maxAgeDays * 86400000;
  const files = listLogFiles();
  for (const f of files) {
    if (f.name === 'main.log') continue;
    if (maxAge > 0 && now - f.mtime > maxAge) {
      try {
        fs.unlinkSync(f.path);
      } catch (_) {}
    }
  }
  let total = listLogFiles().reduce((s, f) => s + f.size, 0);
  if (total <= opts.maxTotalBytes) return;
  const archives = listLogFiles()
    .filter((f) => f.name !== 'main.log')
    .sort((a, b) => a.mtime - b.mtime); // 最旧先删
  for (const f of archives) {
    if (total <= opts.maxTotalBytes) break;
    try {
      fs.unlinkSync(f.path);
      total -= f.size;
    } catch (_) {}
  }
}

function closeStream() {
  if (!writeStream) return;
  try {
    writeStream.end();
  } catch (_) {}
  writeStream = null;
}

function openStream() {
  closeStream();
  ensureDir(logDir);
  const st = safeStat(logFile);
  bytesWritten = st?.size || 0;
  writeStream = fs.createWriteStream(logFile, { flags: 'a', encoding: 'utf8' });
  writeStream.on('error', () => {});
}

/** size-based rotate: main.log → .1 → .2 → … 超出 maxFiles 丢弃 */
function rotate() {
  if (rotating || !logFile) return;
  rotating = true;
  try {
    closeStream();
    for (let i = opts.maxFiles; i >= 1; i--) {
      const src = i === 1 ? logFile : `${logFile}.${i - 1}`;
      const dest = `${logFile}.${i}`;
      if (!fs.existsSync(src)) continue;
      try {
        if (i === opts.maxFiles) fs.unlinkSync(src);
        else {
          try {
            fs.unlinkSync(dest);
          } catch (_) {}
          fs.renameSync(src, dest);
        }
      } catch (_) {}
    }
    // 若 rename 失败留下过大文件，裁剪末尾
    const st = safeStat(logFile);
    if (st && st.size > opts.maxFileBytes) {
      try {
        const text = fs.readFileSync(logFile, 'utf8');
        const lines = text.split(/\r?\n/);
        const kept = lines.slice(-opts.keepLinesOnTrim).join('\n');
        fs.writeFileSync(logFile, kept.endsWith('\n') ? kept : kept + '\n', 'utf8');
      } catch (_) {
        try {
          fs.writeFileSync(logFile, '', 'utf8');
        } catch (_) {}
      }
    }
    pruneArchives();
    openStream();
  } finally {
    rotating = false;
  }
}

function flushQueue() {
  if (!writeStream || !queue.length) return;
  const batch = queue.splice(0, queue.length).join('');
  try {
    writeStream.write(batch);
  } catch (_) {}
}

function writeLine(level, args) {
  const msg = args.map((a) => (typeof a === 'string' ? a : util.inspect(a, { depth: 4, breakLength: 120 }))).join(' ');
  const line = `[${stamp()}] [${level}] ${msg}\n`;
  if (!logFile) {
    queue.push(line);
    if (queue.length > 200) queue.splice(0, queue.length - 200);
    return;
  }
  if (bytesWritten >= opts.maxFileBytes) rotate();
  try {
    if (!writeStream) openStream();
    writeStream.write(line);
    bytesWritten += Buffer.byteLength(line);
    if (bytesWritten >= opts.maxFileBytes) rotate();
  } catch (_) {
    queue.push(line);
  }
}

function formatArgs(args) {
  return [...args];
}

const api = {
  info: (...args) => writeLine('INFO', formatArgs(args)),
  warn: (...args) => writeLine('WARN', formatArgs(args)),
  error: (...args) => writeLine('ERROR', formatArgs(args)),
  debug: (...args) => writeLine('DEBUG', formatArgs(args)),
};

function hookConsole() {
  if (hooked) return;
  hooked = true;
  const levels = [
    ['log', 'INFO'],
    ['info', 'INFO'],
    ['warn', 'WARN'],
    ['error', 'ERROR'],
    ['debug', 'DEBUG'],
  ];
  for (const [method, level] of levels) {
    const orig = console[method].bind(console);
    console[method] = (...args) => {
      try {
        writeLine(level, args);
      } catch (_) {}
      orig(...args);
    };
  }
}

function hookProcess() {
  process.on('uncaughtException', (err) => {
    writeLine('ERROR', ['uncaughtException', err?.stack || err]);
  });
  process.on('unhandledRejection', (reason) => {
    writeLine('ERROR', ['unhandledRejection', reason?.stack || reason]);
  });
}

function init(userData, custom = {}) {
  opts = { ...DEFAULTS, ...custom };
  logDir = ensureDir(path.join(userData, 'logs'));
  logFile = path.join(logDir, 'main.log');
  pruneArchives();
  openStream();
  flushQueue();
  hookConsole();
  hookProcess();
  writeLine('INFO', [`logger ready · file≤${Math.round(opts.maxFileBytes / 1024)}KB · keep≤${opts.maxFiles} · total≤${Math.round(opts.maxTotalBytes / 1024)}KB · age≤${opts.maxAgeDays}d`]);
  // 隔一段时间再 prune（运行中备份变多时）
  setInterval(() => {
    try {
      pruneArchives();
      const st = safeStat(logFile);
      if (st && st.size >= opts.maxFileBytes) rotate();
    } catch (_) {}
  }, 30 * 60 * 1000).unref?.();
  return { dir: logDir, file: logFile };
}

function getPaths() {
  return { dir: logDir, file: logFile };
}

function clear() {
  closeStream();
  for (const f of listLogFiles()) {
    try {
      fs.unlinkSync(f.path);
    } catch (_) {}
  }
  openStream();
  bytesWritten = 0;
  writeLine('INFO', ['log cleared by user']);
  return true;
}

module.exports = { init, clear, getPaths, ...api, DEFAULTS };
