#!/usr/bin/env node
'use strict';

const { discoverAll } = require('../src/discovery');
const { renderDiscovery, chooseFromList, closeRl } = require('../src/ui');
const { handoff } = require('../src/handoff');
const { syncSkills } = require('../src/syncSkills');

async function main() {
  console.log('inharness — elige orquestador, luego trabajas ahi normal');

  // Instala/actualiza las skills nativas en cada CLI antes de nada -
  // idempotente y silencioso si ya estan al dia, para no anadir un paso de
  // "setup" que el usuario tenga que recordar.
  syncSkills();

  const discovered = discoverAll();
  renderDiscovery(discovered);

  const available = discovered.filter((d) => d.installed && d.subscriptionOk);
  if (available.length === 0) {
    console.log('No hay ningun CLI disponible por suscripcion. Abortando.');
    closeRl();
    process.exit(1);
  }

  const idx = await chooseFromList('¿Con que CLI quieres trabajar (orquestador)?', available.map((d) => d.id));
  closeRl();
  if (idx === null) {
    console.log('Opcion invalida. Abortando.');
    process.exit(1);
  }

  const chosen = available[idx].id;
  console.log(`\nEntrando en ${chosen}. Trabaja normal — cuando quieras modo multiagente, invoca la skill/agente "inharness" (en Claude: /inharness; en Codex: $inharness; en Kimi: ya viene cargado).\n`);

  const code = await handoff(chosen);
  process.exit(code);
}

main().catch((err) => {
  console.error('Error inesperado:', err);
  closeRl();
  process.exit(1);
});
