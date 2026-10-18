'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnCli } = require('../src/spawnCli');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inharness-spawn-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('comando inexistente devuelve error ENOENT sin lanzar', () => {
  const result = spawnCli('inharness-missing-command-543219', []);
  assert.equal(result.ok, false);
  assert.equal(result.status, null);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.equal(result.error.code, 'ENOENT');
});

test('ejecucion nativa conserva stdin, cwd, stdout, stderr y status', (t) => {
  const dir = fixture(t);
  const script = path.join(dir, 'probe.js');
  fs.writeFileSync(script, "process.stdout.write(JSON.stringify({ cwd: process.cwd(), input: require('node:fs').readFileSync(0, 'utf8'), args: process.argv.slice(2) })); process.stderr.write('diagnostico');");
  const input = 'entrada & %PATH%\n"texto"\r\n日本😀';
  const result = spawnCli(process.execPath, [script, 'a&b', 'a;b'], { cwd: dir, input });
  assert.equal(result.ok, true, result.error && result.error.message);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.error, null);
  assert.deepEqual(JSON.parse(result.stdout), { cwd: dir, input, args: ['a&b', 'a;b'] });
  assert.equal(result.stderr, 'diagnostico');
  const fail = spawnCli(process.execPath, ['-e', 'process.exitCode = 7;']);
  assert.equal(fail.ok, false);
  assert.equal(fail.status, 7);
  assert.equal(fail.error, null);
});

test('timeout devuelve el error de spawnSync', () => {
  const result = spawnCli(process.execPath, ['-e', 'setTimeout(() => {}, 10000);'], { timeoutMs: 50 });
  assert.equal(result.ok, false);
  assert.equal(result.status, null);
  assert.equal(result.error.code, 'ETIMEDOUT');
});

test('Windows: shim npm por nombre y por ruta, argumentos y stdin de extremo a extremo', { skip: process.platform !== 'win32' }, (t) => {
  const dir = fixture(t);
  const script = path.join(dir, 'probe.js');
  fs.writeFileSync(script, "process.stdout.write(JSON.stringify({ args: process.argv.slice(2), input: require('node:fs').readFileSync(0, 'utf8') }));");
  const shim = path.join(dir, 'probe.cmd');
  fs.writeFileSync(shim, [
    '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start',
    'SETLOCAL', 'CALL :find_dp0', 'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\probe.js" %*', '',
  ].join('\r\n'));
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') || 'PATH';
  const oldPath = process.env[pathKey];
  process.env[pathKey] = `${dir};${oldPath || ''}`;
  t.after(() => { if (oldPath === undefined) delete process.env[pathKey]; else process.env[pathKey] = oldPath; });
  const args = ['', 'x&echo PWNED>PWNED', '%PATH%', '"texto"', 'uno\ndos\r\ntres', 'x'.repeat(20000)];
  const input = 'stdin\ncon & | % y "comillas" 日本';
  for (const command of [shim, 'probe']) {
    const result = spawnCli(command, args, { cwd: dir, input });
    assert.equal(result.ok, true, result.error && result.error.message);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.error, null);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, JSON.stringify({ args, input }));
    assert.equal(fs.existsSync(path.join(dir, 'PWNED')), false);
  }
});

test('Windows: EUNSAFEARG se devuelve con la misma forma de error', { skip: process.platform !== 'win32' }, (t) => {
  const dir = fixture(t);
  const batch = path.join(dir, 'arbitrary.cmd');
  fs.writeFileSync(batch, '@echo off\r\necho %*\r\n');
  const result = spawnCli(batch, ['%PATH%']);
  assert.equal(result.ok, false);
  assert.equal(result.status, null);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.equal(result.error.code, 'EUNSAFEARG');
});
