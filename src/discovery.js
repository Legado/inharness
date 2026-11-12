'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnCli } = require('./spawnCli');

// Intenta localizar un CLI por nombre. En Windows los globales npm son .cmd;
// probamos primero el nombre plano (funciona en Linux/Mac y a veces en Win)
// y luego la variante .cmd para no romper en ninguna plataforma.
function resolveCmd(name) {
  const plain = spawnCli(name, ['--version']);
  if (plain.ok) return { cmd: name, version: plain.stdout.trim() };
  if (os.platform() === 'win32') {
    const dotCmd = spawnCli(name + '.cmd', ['--version']);
    if (dotCmd.ok) return { cmd: name + '.cmd', version: dotCmd.stdout.trim() };
  }
  return null;
}

function detectCodex() {
  const resolved = resolveCmd('codex');
  if (!resolved) return { id: 'codex', installed: false };
  const { cmd, version } = resolved;

  const status = spawnCli(cmd, ['login', 'status']);
  const statusText = `${status.stdout}${status.stderr}`;
  const subscriptionOk = /logged in/i.test(statusText);

  let models = [];
  try {
    const cachePath = path.join(os.homedir(), '.codex', 'models_cache.json');
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    models = (raw.models || [])
      .filter((m) => m.visibility !== 'hidden')
      .map((m) => ({
        id: m.slug,
        displayName: m.display_name,
        meta: {
          priority: m.priority,
          default_reasoning_level: m.default_reasoning_level,
          supported_reasoning_levels: (m.supported_reasoning_levels || []).map((r) => r.effort),
          speed_tiers: m.additional_speed_tiers || [],
        },
      }));
  } catch {
    // Cache no disponible todavia (primer uso de codex en esta maquina).
  }

  return { id: 'codex', installed: true, version, resolvedCmd: cmd, subscriptionOk, authRaw: statusText.trim(), models };
}

function detectKimi() {
  const resolved = resolveCmd('kimi');
  if (!resolved) return { id: 'kimi', installed: false };
  const { cmd, version } = resolved;

  const list = spawnCli(cmd, ['provider', 'list']);
  const subscriptionOk = /source=oauth/i.test(list.stdout);

  let models = [];
  const listJson = spawnCli(cmd, ['provider', 'list', '--json']);
  try {
    const parsed = JSON.parse(listJson.stdout);
    models = Object.entries(parsed.models || {}).map(([alias, m]) => ({
      id: alias,
      displayName: m.displayName,
      meta: {
        defaultEffort: m.defaultEffort || null,
        supportEfforts: m.supportEfforts || null,
        maxContextSize: m.maxContextSize || null,
      },
    }));
  } catch {
    // sin catalogo parseable; se reporta vacio
  }

  return { id: 'kimi', installed: true, version, resolvedCmd: cmd, subscriptionOk, authRaw: list.stdout.trim(), models };
}

// Antigravity CLI (agy): sustituto de Gemini CLI para suscripciones Google AI Free/Pro/Ultra
// (Gemini CLI dejo de servirlas el 2026-06-18). La sesion vive en el llavero del SO, asi que
// no hay "login status": se descarta el modo API key y se confia en la sesion cacheada.
function parseAgyModels(output) {
  const seen = new Set();
  for (const line of String(output || '').split(/\r?\n/)) {
    const slug = line.trim().replace(/^[-*]\s+/, '').split(/\s+/)[0];
    if (/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(slug) && /[-.\d]/.test(slug)) seen.add(slug);
  }
  return [...seen].map((id) => ({ id, displayName: id, meta: {} }));
}

function agyUsesApiKey(env = process.env, home = os.homedir()) {
  if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY || env.AGY_ADC_AUTH === 'true') return true;
  try {
    const file = path.join(home, '.gemini', 'antigravity-cli', 'settings.json');
    return JSON.parse(fs.readFileSync(file, 'utf8')).modelProvider === 'gemini';
  } catch {
    return false;
  }
}

function detectAgy() {
  const resolved = resolveCmd('agy');
  if (!resolved) return { id: 'agy', installed: false };
  const { cmd, version } = resolved;

  const apiKey = agyUsesApiKey();
  const subscriptionOk = !apiKey;
  const list = spawnCli(cmd, ['models'], { timeoutMs: 15000 });

  return {
    id: 'agy',
    installed: true,
    version,
    resolvedCmd: cmd,
    subscriptionOk,
    authRaw: apiKey ? 'modo API key/ADC (GEMINI_API_KEY, AGY_ADC_AUTH o modelProvider=gemini)' : 'sin API key (sesion Google cacheada en el llavero)',
    models: list.ok ? parseAgyModels(list.stdout) : [],
  };
}

function detectClaude() {
  const resolved = resolveCmd('claude');
  if (!resolved) return { id: 'claude', installed: false };
  const { cmd, version } = resolved;

  // Heuristica: si hay ANTHROPIC_API_KEY seteada, puede estar en modo API.
  const subscriptionOk = !process.env.ANTHROPIC_API_KEY;

  const models = [
    { id: 'haiku', displayName: 'Haiku (rapido/barato)', meta: { tier: 'fast' } },
    { id: 'sonnet', displayName: 'Sonnet (equilibrado)', meta: { tier: 'balanced' } },
    { id: 'opus', displayName: 'Opus (maximo razonamiento)', meta: { tier: 'frontier' } },
  ];

  return {
    id: 'claude',
    installed: true,
    version,
    resolvedCmd: cmd,
    subscriptionOk,
    authRaw: subscriptionOk ? 'sin ANTHROPIC_API_KEY (suscripcion por defecto)' : 'ANTHROPIC_API_KEY seteada',
    models,
  };
}

function discoverAll() {
  return [detectClaude(), detectCodex(), detectKimi(), detectAgy()];
}

module.exports = { discoverAll, detectCodex, detectKimi, detectClaude, detectAgy, parseAgyModels, agyUsesApiKey };
