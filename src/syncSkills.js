'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PKG_VERSION = require('../package.json').version;
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

function isUpToDate(targetPath) {
  try {
    const content = fs.readFileSync(targetPath, 'utf8');
    return content.includes(MARKER);
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
      if (isUpToDate(destPath)) continue;
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
