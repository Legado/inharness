'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { handoffArgs, handoffSpec } = require('../src/handoff');

test('handoffArgs fija los argumentos de cada CLI', () => {
  assert.deepEqual(handoffArgs('claude'), []);
  assert.deepEqual(handoffArgs('codex'), ['--no-daemon']);
  assert.deepEqual(handoffArgs('kimi', '/home/u'), ['--agent-file', path.join('/home/u', '.kimi-code', 'agents', 'inharness.md')]);
});

test('handoffArgs rechaza un CLI desconocido', () => {
  assert.throws(() => handoffArgs('otro'), /CLI desconocido/);
});

test('handoffSpec lanza un ejecutable nativo directo y con los argumentos fijos', () => {
  const spec = handoffSpec({ id: 'codex', resolvedCmd: process.execPath });
  assert.equal(spec.via, 'direct');
  assert.equal(spec.file, process.execPath);
  assert.deepEqual(spec.args, ['--no-daemon']);
});

test('handoffSpec lanza con ENOENT claro si el binario no existe', () => {
  assert.throws(() => handoffSpec({ id: 'claude', resolvedCmd: 'inharness-no-existe-xyz' }), (err) => err.code === 'ENOENT');
});
