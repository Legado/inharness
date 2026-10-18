#!/usr/bin/env node
'use strict';

/**
 * PreToolUse hook para Claude Code: bloquea invocaciones crudas de
 * Codex/Kimi por Bash (sin pasar por src/paneLauncher.js) mientras haya una
 * delegacion activa de inharness en el directorio de trabajo. Fuera de una
 * delegacion activa, no bloquea nada - el uso normal de codex/kimi en Bash
 * no se ve afectado. Logica de deteccion compartida con el guard de Codex
 * en src/guardLogic.js.
 *
 * Lee el payload del hook por stdin: { tool_name, tool_input: { command } }.
 * Para bloquear, imprime JSON con hookSpecificOutput.permissionDecision =
 * "deny" y sale con codigo 0.
 */

const fs = require('node:fs');
const { isRawInvocation, hasActiveDelegation } = require('./guardLogic');

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function allow() {
  process.stdout.write(JSON.stringify({ continue: true }));
  process.exit(0);
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

function main() {
  const raw = readStdin();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return allow();
  }

  if (payload.tool_name !== 'Bash') return allow();
  const command = (payload.tool_input && payload.tool_input.command) || '';
  if (!isRawInvocation(command)) return allow();

  const cwd = typeof payload.cwd === 'string' ? payload.cwd : process.cwd();
  if (!hasActiveDelegation(cwd)) return allow();

  deny(
    'inharness: hay una delegacion activa en .inharness/assignment.md. ' +
      'No invoques Codex/Kimi crudo por Bash - usa src/paneLauncher.js ' +
      '(launchInPane) para que la fila sea visible en un pane/tab, como pide ' +
      'el Paso 3 de la skill.',
  );
}

main();
