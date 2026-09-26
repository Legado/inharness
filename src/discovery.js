'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnCli } = require('./spawnCli');

/**
 * Paso 0 del protocolo (ver orchestration/cli-registry.md del POC):
 * descubrimiento en caliente, nunca una lista de modelos hardcodeada.
 * Verifica también que la autenticación sea por suscripción, no por API key.
 *
 * La SINTAXIS de invocacion (flags en src/headless.js) si esta fijada en
 * codigo - no es razonable "auto-extraerla" del --help (texto libre, no
 * estructurado) con la misma fiabilidad que el catalogo de modelos (JSON).
 * Lo que si podemos hacer: avisar cuando la version instalada no es la
 * ultima que probamos de verdad, en vez de asumir en silencio que la
 * sintaxis vieja sigue siendo valida.
 */
const LAST_VERIFIED_VERSION = {
  codex: '0.157.1',
  kimi: '2.1.1',
  claude: '2.1.268',
};

function versionNote(id, versionString) {
  const verified = LAST_VERIFIED_VERSION[id];
  if (!verified) return { verified: false, note: 'sin version de referencia registrada' };
  const matches = (versionString || '').includes(verified);
  return matches
    ? { verified: true, note: null }
    : { verified: false, note: `version distinta a la ultima verificada (${verified}) - la sintaxis de invocacion podria haber cambiado` };
}

function detectCodex() {
  const version = spawnCli('codex.cmd', ['--version']);
  if (!version.ok) return { id: 'codex', installed: false };

  const status = spawnCli('codex.cmd', ['login', 'status']);
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
    // No es fatal: el orquestador recibira una lista vacia y lo señalamos.
  }

  return {
    id: 'codex',
    installed: true,
    version: version.stdout.trim(),
    versionCheck: versionNote('codex', version.stdout),
    subscriptionOk,
    authRaw: statusText.trim(),
    models,
  };
}

function detectKimi() {
  const version = spawnCli('kimi', ['--version']);
  if (!version.ok) return { id: 'kimi', installed: false };

  const list = spawnCli('kimi', ['provider', 'list']);
  const subscriptionOk = /source=oauth/i.test(list.stdout);

  let models = [];
  const listJson = spawnCli('kimi', ['provider', 'list', '--json']);
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

  return {
    id: 'kimi',
    installed: true,
    version: version.stdout.trim(),
    versionCheck: versionNote('kimi', version.stdout),
    subscriptionOk,
    authRaw: list.stdout.trim(),
    models,
  };
}

function detectClaude() {
  const version = spawnCli('claude', ['--version']);
  if (!version.ok) return { id: 'claude', installed: false };

  // Heuristica: si hay ANTHROPIC_API_KEY seteada, puede estar en modo API
  // en vez de suscripcion. No hay (todavia) un comando de status mas fino
  // que comprobemos aqui - ver TODO en orchestration/cli-registry.md.
  const subscriptionOk = !process.env.ANTHROPIC_API_KEY;

  const models = [
    { id: 'haiku', displayName: 'Haiku (rapido/barato)', meta: { tier: 'fast' } },
    { id: 'sonnet', displayName: 'Sonnet (equilibrado)', meta: { tier: 'balanced' } },
    { id: 'opus', displayName: 'Opus (maximo razonamiento)', meta: { tier: 'frontier' } },
  ];

  return {
    id: 'claude',
    installed: true,
    version: version.stdout.trim(),
    versionCheck: versionNote('claude', version.stdout),
    subscriptionOk,
    authRaw: subscriptionOk ? 'sin ANTHROPIC_API_KEY (suscripcion por defecto)' : 'ANTHROPIC_API_KEY seteada',
    models,
  };
}

function discoverAll() {
  return [detectClaude(), detectCodex(), detectKimi()];
}

module.exports = { discoverAll, detectCodex, detectKimi, detectClaude };
