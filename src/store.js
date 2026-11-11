const fs = require('fs');
const path = require('path');

class Store {
  constructor(dir) {
    this.file = path.join(dir, 'library.json');
    this.data = { playlists: [], favorites: [], recent: [], settings: { volume: 0.8, cookie: '' } };
    try {
      const loaded = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { ...this.data, ...loaded, settings: { ...this.data.settings, ...(loaded.settings || {}) } };
    } catch (_) {
      /* first run */
    }
    this.timer = null;
  }

  get() {
    return this.data;
  }

  set(data) {
    this.data = data;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 300);
  }

  flush() {
    clearTimeout(this.timer);
    const tmp = this.file + '.tmp';
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }
}

module.exports = Store;
