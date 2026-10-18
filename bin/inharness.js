#!/usr/bin/env node
'use strict';

const { discoverAll } = require('../src/discovery');
const { writeCatalog } = require('../src/catalogCache');
const { renderDiscovery, chooseFromList, closeRl } = require('../src/ui');
const { handoff } = require('../src/handoff');
const { syncSkills } = require('../src/syncSkills');
const { installGuardrails } = require('../src/installGuardrails');
const { installRuntime } = require('../src/installRuntime');

function safeStartup(name, action) {
  try { return action(); } catch (err) { console.warn(`inharness: ${name} fallo (${err.message})`); return null; }
}

async function main() {
  console.log('inharness — elige orquestador, luego trabajas ahi normal');

  // Instala/actualiza las skills nativas en cada CLI antes de nada -
  // idempotente y silencioso si ya estan al dia, para no anadir un paso de
  // "setup" que el usuario tenga que recordar.
  safeStartup('syncSkills', syncSkills);

  // Guardarraíl técnico (no solo una regla de prompt): bloquea invocar
  // Codex/Kimi crudo por Bash mientras hay una fila activa de inharness.
  // Idempotente; en Codex deja el hook "untrusted" hasta que el usuario lo
  // confirme en /hooks (ver mensaje que imprime installGuardrails).
  safeStartup('installRuntime', installRuntime);
  safeStartup('installGuardrails', installGuardrails);

  const discovered = discoverAll();
  // Refresco en caliente del catalogo global: las skills lo leen como punto
  // de arranque rapido. Falla silencioso (warn), nunca tumba el arranque.
  safeStartup('writeCatalog', () => writeCatalog(discovered));
  renderDiscovery(discovered);

  const available = discovered.filter((d) => d.installed && d.subscriptionOk);
  if (available.length === 0) {
    console.log('No hay ningun CLI disponible por suscripcion. Abortando.');
    closeRl();
    process.exitCode = 1;
    return;
  }

  const idx = await chooseFromList('¿Con que CLI quieres trabajar (orquestador)?', available.map((d) => d.id));
  closeRl();
  if (idx === null) {
    console.log('Opcion invalida. Abortando.');
    process.exitCode = 1;
    return;
  }

  const chosenCli = available[idx];
  console.log(`\nEntrando en ${chosenCli.id}. Trabaja normal — cuando quieras modo multiagente, invoca la skill/agente "inharness" (en Claude: /inharness; en Codex: $inharness; en Kimi: ya viene cargado).\n`);

  const code = await handoff(chosenCli);
  process.exitCode = code;
}

main().catch((err) => {
  console.error('Error inesperado:', err);
  closeRl();
  process.exitCode = 1;
});
