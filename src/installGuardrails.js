'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { runtimeDir } = require('./installRuntime');

const CLAUDE_GUARD_MARKER = 'claudeGuardHook.js';
const CODEX_GUARD_MARKER = 'codexPreToolUse.cjs';

// Las rutas van entre comillas dobles: sin escapar, un $ o ` del HOME se expandiria en sh/PowerShell.
const shQuote = (value) => `"${value.replace(/[$`"\\]/g, '\\$&')}"`;
const psQuote = (value) => `"${value.replace(/[$`"\u201C\u201D\u201E]/g, '`$&')}"`;

function readConfig(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('JSON debe ser un objeto');
    return { data, exists: true };
  } catch (err) {
    if (err.code === 'ENOENT') return { data: {}, exists: false };
    console.warn(`inharness: no se pudo leer ${file} (${err.message})`);
    return null;
  }
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

function installGuard(file, marker, matcher, desired, create) {
  const read = readConfig(file);
  if (!read || (!create && !read.exists)) return false;
  try {
    const config = read.data;
    if (config.hooks !== undefined && (!config.hooks || typeof config.hooks !== 'object' || Array.isArray(config.hooks))) throw new Error('hooks debe ser un objeto');
    const groups = config.hooks && config.hooks.PreToolUse;
    if (groups !== undefined && !Array.isArray(groups)) throw new Error('PreToolUse debe ser una lista');
    let found = false;
    let changed = false;
    for (const group of groups || []) {
      if (!group || group.matcher !== matcher || !Array.isArray(group.hooks)) continue;
      for (const hook of group.hooks) {
        if (!hook || hook.type !== 'command' || typeof hook.command !== 'string' || !hook.command.includes(marker)) continue;
        found = true;
        for (const key of ['command', 'commandWindows']) {
          const wanted = key === 'commandWindows' && desired[key] === undefined && hook[key] !== undefined ? desired.command : desired[key];
          if (wanted !== undefined && hook[key] !== wanted) {
            hook[key] = wanted;
            changed = true;
          }
        }
      }
    }
    if (!found) {
      config.hooks = config.hooks || {};
      config.hooks.PreToolUse = groups || [];
      config.hooks.PreToolUse.push({ matcher, hooks: [desired] });
      changed = true;
    }
    if (!changed) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const backup = `${file}.bak-inharness`;
    if (read.exists) {
      try { fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL); } catch (err) { if (err.code !== 'EEXIST') throw err; }
    }
    writeAtomic(file, `${JSON.stringify(config, null, 2)}\n`);
    return true;
  } catch (err) {
    console.warn(`inharness: no se pudo instalar el hook en ${file} (${err.message})`);
    return false;
  }
}

function installClaudeGuard() {
  const guardPath = path.join(runtimeDir(), CLAUDE_GUARD_MARKER).replace(/\\/g, '/');
  return installGuard(path.join(os.homedir(), '.claude', 'settings.json'), CLAUDE_GUARD_MARKER, 'Bash', {
    type: 'command', command: `node ${shQuote(guardPath)}`, timeout: 5,
  }, true);
}

function installCodexGuard() {
  const guardPath = path.join(runtimeDir(), CODEX_GUARD_MARKER).replace(/\\/g, '/');
  return installGuard(path.join(os.homedir(), '.codex', 'hooks.json'), CODEX_GUARD_MARKER, '^Bash$', {
    type: 'command',
    command: `node ${shQuote(guardPath)}`,
    commandWindows: `& ${psQuote(process.execPath)} ${psQuote(guardPath)}; exit $LASTEXITCODE`,
    timeout: 10,
    statusMessage: 'inharness: comprobar delegacion activa',
  }, false);
}

function installGuardrails({ silent = false } = {}) {
  if (process.env.INHARNESS_NO_GUARDRAILS === '1') return [];
  const installed = [];
  if (installClaudeGuard()) installed.push('claude');
  if (installCodexGuard()) installed.push('codex');
  if (!silent) {
    for (const name of installed) console.log(`inharness: hook de ${name} instalado/actualizado`);
    if (installed.includes('codex')) console.log('inharness: confirma el hook de Codex en /hooks; hasta entonces queda untrusted.');
  }
  return installed;
}

module.exports = { installGuardrails, installClaudeGuard, installCodexGuard };
