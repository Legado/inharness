'use strict';

const { spawnSync } = require('node:child_process');
const os = require('node:os');

/**
 * Ejecuta un binario de CLI de forma robusta en Windows/macOS/Linux.
 * En Windows, los .cmd/.bat necesitan pasar por cmd.exe; los .exe nativos no.
 * Nunca se construye un string de shell a mano (evita el bug de rutas con
 * backslash que rompió a Kimi cuando se invocó desde un string de bash).
 *
 * OJO: los .cmd envueltos en cmd.exe heredan su límite clásico de línea de
 * comandos (~8191 caracteres). Un prompt largo como argumento revienta ese
 * límite en silencio (el proceso falla sin stdout/stderr utiles). Por eso
 * `opts.input` existe: para CLIs que soportan leer el prompt por stdin
 * (Codex con "-" como argumento), evitando el límite por completo.
 */
function spawnCli(command, args, opts = {}) {
  const isWin = os.platform() === 'win32';
  const needsCmdWrapper = isWin && /\.cmd$/i.test(command);

  let exe = command;
  let finalArgs = args;

  if (needsCmdWrapper) {
    exe = process.env.ComSpec || 'cmd.exe';
    finalArgs = ['/d', '/s', '/c', command, ...args];
  }

  const result = spawnSync(exe, finalArgs, {
    encoding: 'utf8',
    cwd: opts.cwd,
    input: opts.input,
    timeout: opts.timeoutMs || 10 * 60 * 1000,
    maxBuffer: 1024 * 1024 * 64,
    windowsHide: true,
  });

  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error || null,
  };
}

module.exports = { spawnCli };
