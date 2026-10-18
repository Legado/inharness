'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

function runtimeDir() {
  return path.join(os.homedir(), '.inharness', 'runtime');
}

function writeAtomic(file, content) {
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
}

function installRuntime({ silent = false } = {}) {
  try {
    const destination = runtimeDir();
    const source = __dirname;
    const files = fs.readdirSync(source).filter((name) => /\.(?:js|cjs)$/.test(name) && fs.statSync(path.join(source, name)).isFile());
    const version = JSON.parse(fs.readFileSync(path.join(source, '..', 'package.json'), 'utf8')).version;
    fs.mkdirSync(destination, { recursive: true });
    const updated = [];
    for (const name of [...files, 'VERSION']) {
      const content = name === 'VERSION' ? `${version}\n` : fs.readFileSync(path.join(source, name));
      const target = path.join(destination, name);
      let existing;
      try { existing = fs.readFileSync(target); } catch (err) { if (err.code !== 'ENOENT') throw err; }
      if (existing && existing.equals(Buffer.isBuffer(content) ? content : Buffer.from(content))) continue;
      writeAtomic(target, content);
      updated.push(name);
    }
    if (updated.length && !silent) console.log(`inharness: runtime actualizado (${updated.length} ficheros)`);
    return updated;
  } catch (err) {
    console.warn(`inharness: no se pudo instalar el runtime (${err.message})`);
    return [];
  }
}

module.exports = { runtimeDir, installRuntime };
