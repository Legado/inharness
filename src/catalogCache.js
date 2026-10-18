'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

// Catalogo global de la maquina (no del proyecto): punto de arranque rapido
// para las skills, que asi no tienen que redescubrir modelos desde cero en
// el primer uso de un proyecto nuevo. Se reescribe en caliente cada vez que
// arranca inharness; es una comodidad, no algo critico.
function catalogPath() {
  return path.join(os.homedir(), '.inharness', 'catalog.json');
}

function writeCatalog(discovered) {
  let temporary;
  try {
    const file = catalogPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const payload = { schemaVersion: 1, generatedAt: new Date().toISOString(), clis: discovered };
    temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(payload, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
    return file;
  } catch (err) {
    console.warn(`inharness: no se pudo escribir el catalogo global (${err.message})`);
    return null;
  } finally {
    if (temporary) {
      try { fs.unlinkSync(temporary); } catch (err) { if (err.code !== 'ENOENT') console.warn(`inharness: no se pudo limpiar ${temporary} (${err.message})`); }
    }
  }
}

// Listo para las skills: devuelve el ultimo catalogo escrito, o null si no
// existe o no se puede parsear.
function readCatalog() {
  try {
    const data = JSON.parse(fs.readFileSync(catalogPath(), 'utf8').replace(/^\uFEFF/, ''));
    return data && typeof data === 'object' && !Array.isArray(data) && Array.isArray(data.clis) ? data : null;
  } catch {
    return null;
  }
}

module.exports = { writeCatalog, readCatalog };
