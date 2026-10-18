'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Desde el runtime copiado (~/.inharness/runtime) no hay ../package.json: cae al fichero VERSION.
const PKG_VERSION = (() => {
  try { return require('../package.json').version; } catch { /* copia en el runtime */ }
  try { return fs.readFileSync(path.join(__dirname, 'VERSION'), 'utf8').trim(); } catch { return 'unknown'; }
})();
const MARKER = `<!-- inharness-version: ${PKG_VERSION} -->`;

/**
 * Instala/actualiza las skills empaquetadas en las carpetas nativas de cada
 * CLI. Se ejecuta en cada arranque de `inharness`, es idempotente y en
 * silencio si ya esta al dia - nada de un paso de "setup" aparte que el
 * usuario tenga que recordar (eso seria friccion).
 */
const TARGETS = [
  {
    cli: 'claude',
    files: [{ from: ['claude', 'SKILL.md'], to: [os.homedir(), '.claude', 'skills', 'inharness', 'SKILL.md'] }],
  },
  {
    cli: 'codex',
    files: [
      { from: ['codex', 'SKILL.md'], to: [os.homedir(), '.codex', 'skills', 'inharness', 'SKILL.md'] },
      { from: ['codex', 'agents', 'openai.yaml'], to: [os.homedir(), '.codex', 'skills', 'inharness', 'agents', 'openai.yaml'] },
    ],
  },
  {
    cli: 'kimi',
    files: [{ from: ['kimi', 'inharness.md'], to: [os.homedir(), '.kimi-code', 'agents', 'inharness.md'] }],
  },
];

// Contenido exacto, no solo el marcador: un cambio de texto sin subir la version tambien debe llegar.
function isUpToDate(targetPath, srcPath) {
  try {
    return fs.readFileSync(targetPath, 'utf8') === stampedContent(srcPath);
  } catch {
    return false;
  }
}

function stampedContent(srcPath) {
  const raw = fs.readFileSync(srcPath, 'utf8');
  // El marcador de version va como comentario HTML al final - invisible
  // para el modelo que lea el archivo como instrucciones, legible para
  // nosotros al decidir si hace falta reinstalar.
  return `${raw.trimEnd()}\n\n${MARKER}\n`;
}

function syncSkills({ silent = false } = {}) {
  let updated = [];
  for (const target of TARGETS) {
    for (const file of target.files) {
      const srcPath = path.join(__dirname, '..', 'skills', ...file.from);
      const destPath = path.join(...file.to);
      if (!fs.existsSync(srcPath)) continue;
      if (isUpToDate(destPath, srcPath)) continue;
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, stampedContent(srcPath), 'utf8');
      updated.push(target.cli);
    }
  }
  updated = [...new Set(updated)];
  if (updated.length && !silent) {
    console.log(`inharness: skills instaladas/actualizadas (v${PKG_VERSION}) en: ${updated.join(', ')}`);
  }
  return updated;
}

module.exports = { syncSkills, PKG_VERSION };
