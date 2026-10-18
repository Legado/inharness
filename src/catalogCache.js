'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Catalogo global de la maquina (no del proyecto): punto de arranque rapido
// para las skills, que asi no tienen que redescubrir modelos desde cero en
// el primer uso de un proyecto nuevo. Se reescribe en caliente cada vez que
// arranca inharness; es una comodidad, no algo critico.
function catalogPath() {
  return path.join(os.homedir(), '.inharness', 'catalog.json');
}

function writeCatalog(discovered) {
  try {
    const file = catalogPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const payload = { generatedAt: new Date().toISOString(), clis: discovered };
    fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    return file;
  } catch (err) {
    console.warn(`inharness: no se pudo escribir el catalogo global (${err.message})`);
    return null;
  }
}

// Listo para las skills: devuelve el ultimo catalogo escrito, o null si no
// existe o no se puede parsear.
function readCatalog() {
  try {
    return JSON.parse(fs.readFileSync(catalogPath(), 'utf8'));
  } catch {
    return null;
  }
}

module.exports = { writeCatalog, readCatalog };
