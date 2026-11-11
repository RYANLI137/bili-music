const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

/**
 * 脚本插件接口（放在 userData/plugins）：
 * module.exports = {
 *   name: '插件名',
 *   description: '说明',
 *   version: '1.0.0',
 *   onTrack(track) {},
 *   onPlayState(playing) {},
 *   onCommand(cmd, payload) {},
 * };
 */

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function pluginsDir(userData) {
  return ensureDir(path.join(userData, 'plugins'));
}

function safeId(name) {
  return String(name || 'plugin')
    .replace(/[^\w\u4e00-\u9fff.-]+/g, '_')
    .slice(0, 64);
}

function readMeta(filePath) {
  const base = path.basename(filePath);
  const id = base.replace(/\.js$/i, '');
  let mod = null;
  try {
    delete require.cache[require.resolve(filePath)];
    mod = require(filePath);
  } catch (e) {
    return {
      id,
      file: base,
      path: filePath,
      name: id,
      description: '',
      version: '',
      error: String(e?.message || e),
      enabled: false,
    };
  }
  return {
    id,
    file: base,
    path: filePath,
    name: mod?.name || id,
    description: mod?.description || '',
    version: mod?.version || '',
    error: '',
    enabled: true,
    _mod: mod,
  };
}

function list(userData, enabledMap = {}) {
  const dir = pluginsDir(userData);
  const files = fs.readdirSync(dir).filter((f) => /\.js$/i.test(f));
  return files.map((f) => {
    const meta = readMeta(path.join(dir, f));
    const override = enabledMap[meta.id];
    if (override === false) meta.enabled = false;
    if (override === true && !meta.error) meta.enabled = true;
    delete meta._mod;
    return meta;
  });
}

function loadEnabled(userData, enabledMap = {}) {
  const dir = pluginsDir(userData);
  const files = fs.readdirSync(dir).filter((f) => /\.js$/i.test(f));
  const loaded = [];
  for (const f of files) {
    const full = path.join(dir, f);
    const meta = readMeta(full);
    const on = enabledMap[meta.id] !== false && !meta.error;
    if (!on || !meta._mod) continue;
    loaded.push(meta);
  }
  return loaded;
}

function emit(loaded, hook, ...args) {
  for (const p of loaded || []) {
    try {
      const fn = p._mod?.[hook];
      if (typeof fn === 'function') fn(...args);
    } catch (_) {}
  }
}

function addFromPath(userData, srcPath) {
  if (!srcPath || !/\.js$/i.test(srcPath)) throw new Error('请选择 .js 插件文件');
  if (!fs.existsSync(srcPath)) throw new Error('文件不存在');
  const dir = pluginsDir(userData);
  const base = safeId(path.basename(srcPath, path.extname(srcPath))) + '.js';
  const dest = path.join(dir, base);
  fs.copyFileSync(srcPath, dest);
  const meta = readMeta(dest);
  delete meta._mod;
  return meta;
}

function remove(userData, id) {
  const dir = pluginsDir(userData);
  const target = path.join(dir, `${safeId(id)}.js`);
  if (!fs.existsSync(target)) {
    const hit = fs.readdirSync(dir).find((f) => f.replace(/\.js$/i, '') === id);
    if (!hit) throw new Error('插件不存在');
    fs.unlinkSync(path.join(dir, hit));
    return true;
  }
  fs.unlinkSync(target);
  return true;
}

function writeExample(userData) {
  const dir = pluginsDir(userData);
  const file = path.join(dir, 'example-logger.js');
  if (fs.existsSync(file)) return file;
  fs.writeFileSync(
    file,
    `/** Bili Music 示例插件 —— 可删可改 */
module.exports = {
  name: '播放日志',
  description: '在控制台打印切歌 / 播放状态（示例）',
  version: '1.0.0',
  onTrack(track) {
    console.log('[plugin] track', track?.title, track?.artist);
  },
  onPlayState(playing) {
    console.log('[plugin] playing', playing);
  },
  onCommand(cmd, payload) {
    console.log('[plugin] command', cmd, payload);
  },
};
`,
    'utf8',
  );
  return file;
}

module.exports = {
  pluginsDir,
  list,
  loadEnabled,
  emit,
  addFromPath,
  remove,
  writeExample,
  pathToFileURL,
};
