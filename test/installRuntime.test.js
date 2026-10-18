'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runtimeDir, installRuntime } = require('../src/installRuntime');

function withHome(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inharness-runtime-'));
  const oldHome = process.env.HOME;
  const oldProfile = process.env.USERPROFILE;
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  t.after(() => {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test('copia todos los scripts y version; segunda llamada conserva mtime', (t) => {
  const root = withHome(t);
  assert.equal(runtimeDir(), path.join(root, '.inharness', 'runtime'));
  const first = installRuntime({ silent: true });
  const sources = fs.readdirSync(path.join(__dirname, '..', 'src')).filter((name) => /\.(?:js|cjs)$/.test(name));
  assert.deepEqual(first.slice().sort(), [...sources, 'VERSION'].sort());
  const file = path.join(runtimeDir(), 'guardLogic.js');
  assert.deepEqual(fs.readFileSync(file), fs.readFileSync(path.join(__dirname, '..', 'src', 'guardLogic.js')));
  assert.equal(fs.readFileSync(path.join(runtimeDir(), 'VERSION'), 'utf8').trim(), require('../package.json').version);
  const before = fs.statSync(file).mtimeMs;
  assert.deepEqual(installRuntime({ silent: true }), []);
  assert.equal(fs.statSync(file).mtimeMs, before);
  fs.writeFileSync(file, 'viejo');
  assert.deepEqual(installRuntime({ silent: true }), ['guardLogic.js']);
  assert.deepEqual(fs.readFileSync(file), fs.readFileSync(path.join(__dirname, '..', 'src', 'guardLogic.js')));
});

test('si el destino no puede escribirse, avisa y devuelve lista vacia', (t) => {
  const root = withHome(t);
  fs.writeFileSync(path.join(root, '.inharness'), 'ocupado');
  const oldWarn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(message);
  try { assert.deepEqual(installRuntime({ silent: true }), []); } finally { console.warn = oldWarn; }
  assert.match(warnings[0], /no se pudo instalar el runtime/);
});
