'use strict';

const path = require('path');
const fs = require('fs');

/** Embed the pink headphone icon into the Windows exe (shortcuts use this). */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const exe = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  const icon = path.join(context.packager.projectDir, 'build', 'icon.ico');
  if (!fs.existsSync(exe) || !fs.existsSync(icon)) {
    console.warn('skip icon embed, missing', exe, icon);
    return;
  }
  let rcedit;
  try {
    const mod = require('rcedit');
    rcedit = typeof mod === 'function' ? mod : mod.rcedit || mod.default;
  } catch (_) {
    rcedit = null;
  }
  if (typeof rcedit !== 'function') {
    console.warn('rcedit not installed; exe keeps the default Electron icon');
    return;
  }
  await rcedit(exe, {
    icon,
    'version-string': {
      ProductName: 'Bili Music',
      FileDescription: 'Bili Music',
      CompanyName: 'Bili Music',
      LegalCopyright: 'Bili Music',
    },
  });
  console.log('embedded icon ->', exe);
  // Refuse to ship obvious personal data if it ever lands in the app dir
  const banned = ['library.json', 'cookies.txt', '.env'];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else if (banned.includes(name.toLowerCase()) || /sessdata/i.test(name)) {
        fs.unlinkSync(p);
        console.warn('removed personal file from package:', p);
      }
    }
  };
  walk(context.appOutDir);
};
