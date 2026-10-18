'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { resolveExecutable } = require('./resolveExe');

function parseNpmCmdShim(shimPath) {
  let source;
  try { source = fs.readFileSync(shimPath, 'utf8'); } catch { return null; }
  const lines = source.replace(/^\uFEFF/, '').trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const header = [
    /^@ECHO off$/i, /^GOTO start$/i, /^:find_dp0$/i,
    /^SET (?:dp0=%~dp0|"dp0=%~dp0")$/i, /^EXIT \/b$/i, /^:start$/i,
    /^SETLOCAL$/i, /^CALL :find_dp0$/i, /^IF EXIST "%dp0%\\node\.exe" \($/i,
    /^SET "_prog=%dp0%\\node\.exe"$/i, /^\) ELSE \($/i, /^SET "_prog=node"$/i,
    /^SET PATHEXT=%PATHEXT:;\.JS;=;%$/i, /^\)$/,
  ];
  if (lines.length !== header.length + 1 || !header.every((pattern, index) => pattern.test(lines[index]))) return null;
  const match = /^endLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & "%_prog%"\s+"%dp0%[\\/]([^"%\r\n\0]+)" %\*$/i.exec(lines[header.length]);
  if (!match) return null;

  const dir = path.dirname(path.resolve(shimPath));
  const script = path.resolve(dir, ...match[1].split(/[\\/]/));
  const node = path.join(dir, 'node.exe');
  try {
    return { script, node: fs.statSync(node).isFile() ? node : null };
  } catch {
    return { script, node: null };
  }
}

const cmdMeta = /([()\][%!^"`<>&|;, *?])/g;

function escapeForCmd(arg) {
  // Escape de cross-spawn (MIT): dos pasadas para la expansion adicional de un batch.
  let escaped = String(arg).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  escaped = `"${escaped}"`.replace(cmdMeta, '^$1');
  return escaped.replace(cmdMeta, '^$1');
}

function missingCommand(command) {
  return Object.assign(new Error(`No se encontro el ejecutable: ${command}`), { code: 'ENOENT' });
}

function buildSpawn(command, args, opts = {}) {
  const { platform = process.platform, env = process.env, nodePath = process.execPath } = opts;
  const file = resolveExecutable(command, { platform, env });
  if (!file) throw missingCommand(command);
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(file)) {
    return { file, args, windowsVerbatimArguments: false, via: 'direct' };
  }

  const shim = parseNpmCmdShim(file);
  if (shim) {
    return { file: shim.node || nodePath, args: [shim.script, ...args], windowsVerbatimArguments: false, via: 'npm-shim' };
  }

  // cmd.exe no garantiza transportar saltos de linea, NUL ni expansion de porcentajes.
  if ([file, ...args].some((arg) => /[\n\r\0%]/.test(arg))) {
    throw Object.assign(new Error(`Argumento inseguro para cmd.exe al ejecutar ${command}`), { code: 'EUNSAFEARG' });
  }
  const comspecKey = Object.keys(env).find((key) => key.toLowerCase() === 'comspec');
  const comspec = env[comspecKey] || 'cmd.exe';
  const cmd = resolveExecutable(comspec, { platform, env });
  if (!cmd) throw missingCommand(comspec);
  const line = [file.replace(cmdMeta, '^$1'), ...args.map(escapeForCmd)].join(' ');
  return { file: cmd, args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true, via: 'cmd' };
}

module.exports = { buildSpawn, parseNpmCmdShim, escapeForCmd };
