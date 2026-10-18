'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildSpawn, parseNpmCmdShim, escapeForCmd } = require('../src/winArgs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inharness-win args-&-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'node_modules', 'fake cli', 'main.js');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
  const shim = path.join(dir, 'fake.cmd');
  const source = [
    '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start',
    'SETLOCAL', 'CALL :find_dp0', '', 'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\fake cli\\main.js" %*', '',
  ].join('\r\n');
  fs.writeFileSync(shim, source);
  return { dir, script, shim, source };
}

function execute(spec, cwd) {
  return spawnSync(spec.file, spec.args, {
    cwd, encoding: 'utf8', windowsHide: true,
    windowsVerbatimArguments: spec.windowsVerbatimArguments,
  });
}

test('reconoce el formato cmd-shim y normaliza el script sin ejecutar el batch', (t) => {
  const { dir, script, shim, source } = fixture(t);
  assert.deepEqual(parseNpmCmdShim(shim), { script, node: null });
  fs.writeFileSync(path.join(dir, 'node.exe'), 'fixture');
  assert.deepEqual(parseNpmCmdShim(shim), { script, node: path.join(dir, 'node.exe') });
  fs.writeFileSync(shim, source.replace('@ECHO off', '@echo OFF').replace('SET dp0=%~dp0', 'SET "dp0=%~dp0"'));
  assert.equal(parseNpmCmdShim(shim).script, script);
  fs.writeFileSync(shim, source.replace('fake cli\\main.js', 'fake cli\\..\\fake cli\\main.js'));
  assert.equal(parseNpmCmdShim(shim).script, script);
  fs.writeFileSync(shim, source + 'echo EXTRA\r\n');
  assert.equal(parseNpmCmdShim(shim), null);
  fs.writeFileSync(shim, source.replace('main.js', '%EVIL%.js'));
  assert.equal(parseNpmCmdShim(shim), null);
  fs.writeFileSync(shim, '@echo off\r\necho arbitrary %*\r\n');
  assert.equal(parseNpmCmdShim(shim), null);
  assert.equal(parseNpmCmdShim(path.join(dir, 'missing.cmd')), null);
});

test('buildSpawn devuelve una ruta absoluta para el ejecutable nativo y ENOENT claro', () => {
  const args = ['a;b', '%PATH%', 'linea\nlinea'];
  assert.deepEqual(buildSpawn(process.execPath, args), {
    file: process.execPath, args, windowsVerbatimArguments: false, via: 'direct',
  });
  assert.throws(() => buildSpawn('inharness-no-command-294971', [], { env: { PATH: '' } }), {
    code: 'ENOENT', message: /inharness-no-command-294971/,
  });
  assert.equal(typeof escapeForCmd('a "b"\\'), 'string');
});

test('Windows: shim npm conserva el corpus adversarial completo y 20000 caracteres', { skip: process.platform !== 'win32' }, (t) => {
  const { dir, script, shim } = fixture(t);
  const args = ['', 'a b', '"comillas"', '\\', 'termina\\', 'x&echo PWNED', 'a|b', 'a>b', '^',
    '%PATH%', '!x!', '(x)', 'a;b', 'a,b', '*?', '`', '$HOME', 'ñ', '日本', '😀',
    'primera\nsegunda\r\ntercera', 'x&echo PWNED>PWNED', 'x'.repeat(20000)];
  const spec = buildSpawn(shim, args);
  assert.deepEqual(spec, { file: process.execPath, args: [script, ...args], windowsVerbatimArguments: false, via: 'npm-shim' });
  const result = execute(spec, dir);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), args);
  assert.equal(result.stdout, JSON.stringify(args));
  assert.equal(fs.existsSync(path.join(dir, 'PWNED')), false);
  fs.copyFileSync(process.execPath, path.join(dir, 'node.exe'));
  const localSpec = buildSpawn('fake', ['local'], { env: { Path: dir } });
  assert.equal(localSpec.file, path.join(dir, 'node.exe'));
  const localResult = execute(localSpec, dir);
  assert.ifError(localResult.error);
  assert.equal(localResult.status, 0, localResult.stderr);
  assert.deepEqual(JSON.parse(localResult.stdout), ['local']);
});

test('Windows: batch arbitrario transporta espacios, comillas y metacaracteres sin comandos extra', { skip: process.platform !== 'win32' }, (t) => {
  const { dir, script } = fixture(t);
  const batch = path.join(dir, 'arbitrary & batch.bat');
  fs.writeFileSync(batch, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  const args = ['', 'a b', '"comillas"', '\\', 'termina\\', 'x&echo PWNED>PWNED', 'a|b', 'a>b',
    '^', '!x!', '(x)', '[x]', 'a<b', 'a;b', 'a,b', '*?', '`', '$HOME', 'ñ日本😀',
    'a\\"b', 'x\\\\"y', 'spaced trailing \\', '")&echo PWNED>PWNED&rem "'];
  assert.equal(parseNpmCmdShim(batch), null);
  const spec = buildSpawn(batch, args);
  assert.equal(spec.via, 'cmd');
  assert.equal(spec.windowsVerbatimArguments, true);
  assert.deepEqual(spec.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(path.isAbsolute(spec.file), true);
  const result = execute(spec, dir);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), JSON.stringify(args));
  assert.equal(fs.existsSync(path.join(dir, 'PWNED')), false);
});

test('Windows: batch arbitrario rechaza LF, CR, NUL y porcentajes antes del spawn', { skip: process.platform !== 'win32' }, (t) => {
  const { dir } = fixture(t);
  for (const ext of ['cmd', 'bat']) {
    const batch = path.join(dir, `arbitrary.${ext}`);
    fs.writeFileSync(batch, '@echo off\r\necho %*\r\n');
    for (const arg of ['a\nb', 'a\rb', 'a\0b', '%PATH%', '%']) {
      assert.throws(() => buildSpawn(batch, [arg]), { code: 'EUNSAFEARG' });
    }
  }
  const batch = path.join(dir, '%PATH%.cmd');
  fs.writeFileSync(batch, '@echo off\r\necho %*\r\n');
  assert.throws(() => buildSpawn(batch, []), { code: 'EUNSAFEARG' });
});
