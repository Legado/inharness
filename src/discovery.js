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
  return [detectClaude(), detectCodex(), detectKimi()];
}

module.exports = { discoverAll, detectCodex, detectKimi, detectClaude };
