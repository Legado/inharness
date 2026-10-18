'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveExecutable } = require('../src/resolveExe');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inharness-resolve-'));
  const original = process.cwd();
  t.after(() => {
    process.chdir(original);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('no busca en cwd ni en entradas vacias o relativas', () => {
  assert.equal(resolveExecutable('package.json', { env: { PATH: `${process.cwd()}${path.delimiter}.${path.delimiter}${path.delimiter}src` } }), null);
});

test('Windows respeta PATHEXT, su orden y Path sin distinguir mayusculas', { skip: process.platform !== 'win32' }, (t) => {
  const dir = fixture(t);
  const cwd = path.join(dir, 'cwd');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(cwd);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(cwd, 'planted.cmd'), 'planted');
  fs.writeFileSync(path.join(bin, 'tool'), 'shim sh');
  fs.writeFileSync(path.join(bin, 'tool.cmd'), 'cmd');
  fs.writeFileSync(path.join(bin, 'tool.exe'), 'exe');
  fs.writeFileSync(path.join(bin, 'tool.cmd.exe'), 'exe');
  process.chdir(cwd);
  const env = { pAtH: `;.;${cwd};bin;"${bin}";;`, pAtHeXt: '.EXE;.CMD' };
  assert.equal(resolveExecutable('planted', { env }), null);
  assert.equal(resolveExecutable('tool', { env }), path.join(bin, 'tool.EXE'));
  assert.equal(resolveExecutable('tool.cmd', { env }), path.join(bin, 'tool.cmd'));
  assert.equal(resolveExecutable('tool', { env: { Path: bin, PATHEXT: '.CMD;.EXE' } }), path.join(bin, 'tool.CMD'));
  assert.equal(resolveExecutable('tool', { env: { Path: bin, PATHEXT: '.BAT' } }), null);
  assert.equal(resolveExecutable('tool', { env: { Path: bin } }), path.join(bin, 'tool.EXE'));
  assert.equal(resolveExecutable(path.join(bin, 'tool'), { env: { PATHEXT: '.CMD' } }), path.join(bin, 'tool.CMD'));
  assert.equal(resolveExecutable('./planted', { env }), path.join(cwd, 'planted.CMD'));
  assert.equal(resolveExecutable('missing-inharness-command', { env }), null);
  fs.mkdirSync(path.join(bin, 'directory.exe'));
  assert.equal(resolveExecutable('directory.exe', { env }), null);
  fs.rmSync(path.join(bin, 'tool.exe'));
  assert.equal(resolveExecutable('tool', { env }), path.join(bin, 'tool.CMD'));
});

test('Windows ignora shims sin extension y extensiones fuera de PATHEXT', { skip: process.platform !== 'win32' }, (t) => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, 'only-sh'), '#!/bin/sh');
  fs.writeFileSync(path.join(dir, 'tool.txt'), 'text');
  assert.equal(resolveExecutable('only-sh', { env: { PATH: dir } }), null);
  assert.equal(resolveExecutable(path.join(dir, 'only-sh')), null);
  assert.equal(resolveExecutable(path.join(dir, 'tool.txt')), null);
});

test('POSIX exige fichero regular y X_OK, admite rutas explicitas y excluye cwd', { skip: process.platform === 'win32' }, (t) => {
  const dir = fixture(t);
  const executable = path.join(dir, 'tool');
  fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'plain'), 'no executable', { mode: 0o600 });
  fs.mkdirSync(path.join(dir, 'directory'));
  assert.equal(resolveExecutable('tool', { env: { PATH: `:.:${dir}::` } }), executable);
  assert.equal(resolveExecutable(executable), executable);
  assert.equal(resolveExecutable('plain', { env: { PATH: dir } }), null);
  assert.equal(resolveExecutable('directory', { env: { PATH: dir } }), null);
  assert.equal(resolveExecutable('missing', { env: { PATH: dir } }), null);
  process.chdir(dir);
  assert.equal(resolveExecutable('tool', { env: { PATH: `:.:${dir}` } }), null);
  assert.equal(resolveExecutable('./tool'), executable);
});

test('nombres vacios, NUL y rutas inexistentes devuelven null', () => {
  assert.equal(resolveExecutable(''), null);
  assert.equal(resolveExecutable('bad\0name'), null);
  assert.equal(resolveExecutable(path.join(os.tmpdir(), 'inharness-missing-executable-430118')), null);
});
