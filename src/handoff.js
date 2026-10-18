'use strict';

const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const { buildSpawn } = require('./winArgs');

// Argumentos fijos con los que se entrega la terminal a cada CLI. Codex lleva
// --no-daemon porque sin el, el app-server compartido puede fallar con "the CLI
// package does not match this platform or executable".
function handoffArgs(id, homedir = os.homedir()) {
  if (id === 'claude') return [];
  if (id === 'codex') return ['--no-daemon'];
  if (id === 'kimi') return ['--agent-file', path.join(homedir, '.kimi-code', 'agents', 'inharness.md')];
  throw new Error(`CLI desconocido: ${id}`);
}

// Spec listo para spawn (sin shell ni cmd.exe para los shims de npm).
function handoffSpec(cli, homedir) {
  const { id, resolvedCmd } = cli;
  return buildSpawn(resolvedCmd, handoffArgs(id, homedir));
}

function handoff(cli) {
  let spec;
  try {
    spec = handoffSpec(cli);
  } catch (err) {
    console.error(`No se pudo lanzar ${cli.id}: ${err.message}`);
    return Promise.resolve(1);
  }

  const child = spawn(spec.file, spec.args, {
    stdio: 'inherit',
    cwd: process.cwd(),
    windowsVerbatimArguments: spec.windowsVerbatimArguments,
  });
  return new Promise((resolve) => {
    child.on('exit', (code) => resolve(code ?? 0));
    child.on('error', (err) => {
      console.error(`No se pudo lanzar ${cli.id}: ${err.message}`);
      resolve(1);
    });
  });
}

module.exports = { handoff, handoffSpec, handoffArgs };
