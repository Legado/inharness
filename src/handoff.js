'use strict';

const { spawn } = require('node:child_process');
const os = require('node:os');

/**
 * Traspasa el control del terminal a la sesion interactiva REAL del CLI
 * elegido como orquestador - nunca la simulamos desde aqui. El usuario
 * sigue trabajando exactamente como siempre en ese CLI; cuando quiera
 * modo multiagente, invoca la skill/agente "inharness" ya instalada dentro
 * de esa herramienta (ver README).
 */
function handoff(cliId) {
  const isWin = os.platform() === 'win32';

  let exe;
  let args = [];

  if (cliId === 'claude') {
    exe = 'claude';
  } else if (cliId === 'codex') {
    // --no-daemon: sin esto, el app-server compartido de Codex puede fallar
    // con "the CLI package does not match this platform or executable" al
    // lanzarlo asi (visto en pruebas reales de este traspaso).
    exe = isWin ? 'cmd.exe' : 'codex.cmd';
    args = isWin ? ['/d', '/s', '/c', 'codex.cmd', '--no-daemon'] : ['--no-daemon'];
  } else if (cliId === 'kimi') {
    exe = 'kimi';
    args = ['--agent-file', require('node:path').join(os.homedir(), '.kimi-code', 'agents', 'inharness.md')];
  } else {
    throw new Error(`CLI desconocido: ${cliId}`);
  }

  const child = spawn(exe, args, { stdio: 'inherit', cwd: process.cwd() });
  return new Promise((resolve) => {
    child.on('exit', (code) => resolve(code ?? 0));
    child.on('error', (err) => {
      console.error(`No se pudo lanzar ${cliId}: ${err.message}`);
      resolve(1);
    });
  });
}

module.exports = { handoff };
