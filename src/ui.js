'use strict';

// OJO: aqui NO se usa rl.question() repetido - con stdin por pipe (no TTY),
// llamadas sucesivas a question() sobre el mismo readline.Interface se
// cuelgan (bug/quirk conocido de pausa-reanudacion del stream en Node).
// El patron robusto para ambos casos (TTY y pipe) es consumir el propio
// iterador asincrono de lineas del interface.
const readline = require('node:readline');

let rl = null;
let iterator = null;
function getIterator() {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    iterator = rl[Symbol.asyncIterator]();
  }
  return iterator;
}
function closeRl() {
  if (rl) {
    rl.close();
    rl = null;
    iterator = null;
  }
}

function renderDiscovery(discovered) {
  console.log('\nDeteccion de CLIs (suscripcion, no API):');
  for (const d of discovered) {
    if (!d.installed) {
      console.log(`  ✗ ${d.id.padEnd(8)} no instalado`);
      continue;
    }
    const mark = d.subscriptionOk ? '✔' : '⚠';
    const authNote = d.subscriptionOk ? d.authRaw : `${d.authRaw} (modo API detectado, se excluye)`;
    console.log(`  ${mark} ${d.id.padEnd(8)} ${d.version || ''}  — ${authNote}  [${d.models.length} modelos]`);

  }
  console.log('');
}

async function ask(question) {
  process.stdout.write(question);
  const { value, done } = await getIterator().next();
  return done ? '' : value.trim();
}

async function chooseFromList(question, items) {
  console.log(question);
  items.forEach((item, i) => console.log(`  ${i + 1}) ${item}`));
  const answer = await ask('> ');
  const idx = parseInt(answer, 10) - 1;
  if (Number.isNaN(idx) || idx < 0 || idx >= items.length) return null;
  return idx;
}

module.exports = { renderDiscovery, ask, chooseFromList, closeRl };
