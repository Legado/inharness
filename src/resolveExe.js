'use strict';

const fs = require('node:fs');
const path = require('node:path');

function envValue(env, name, isWin) {
  const key = isWin ? Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase()) : name;
  return env[key];
}

function resolveExecutable(name, opts = {}) {
  const { platform = process.platform, env = process.env } = opts;
  const isWin = platform === 'win32';
  if (typeof name !== 'string' || !name || name.includes('\0')) return null;

  const extensions = isWin
    ? (envValue(env, 'PATHEXT', true) || '.COM;.EXE;.BAT;.CMD').split(';')
      .map((ext) => ext.trim()).filter((ext) => /^\.[a-z0-9]+$/i.test(ext))
    : [];
  const validExtension = (file) => extensions.some((ext) => ext.toLowerCase() === path.extname(file).toLowerCase());
  const candidates = (file) => {
    if (!isWin) return [file];
    return [...(validExtension(file) ? [file] : []), ...extensions.map((ext) => file + ext)];
  };
  const findFile = (file) => {
    for (const candidate of candidates(file)) {
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        if (isWin) {
          if (!validExtension(candidate)) continue;
        } else {
          fs.accessSync(candidate, fs.constants.X_OK);
        }
        return path.resolve(candidate);
      } catch {
        // Una entrada inaccesible no impide buscar en el resto de PATH.
      }
    }
    return null;
  };

  if (/[\\/]/.test(name) || path.isAbsolute(name)) return findFile(path.resolve(name));

  const canonical = (dir) => {
    try { return fs.realpathSync(dir); } catch { return path.resolve(dir); }
  };
  const normalize = (dir) => isWin ? canonical(dir).toLowerCase() : canonical(dir);
  const cwd = normalize(process.cwd());
  for (let dir of (envValue(env, 'PATH', isWin) || '').split(isWin ? ';' : ':')) {
    if (isWin && dir.startsWith('"') && dir.endsWith('"')) dir = dir.slice(1, -1);
    // Las entradas relativas tambien dependen del cwd y no son una fuente de confianza.
    if (!dir || !path.isAbsolute(dir) || normalize(dir) === cwd) continue;
    const found = findFile(path.join(dir, name));
    if (found) return found;
  }
  return null;
}

module.exports = { resolveExecutable };
