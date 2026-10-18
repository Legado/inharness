#!/usr/bin/env node
'use strict';

/**
 * PreToolUse hook para Codex (matcher "^Bash$" - verificado empiricamente
 * contra el app-server real, ver .inharness/codex-hooks-investigation/
 * REPORT.md). Bloquea invocaciones crudas de Codex/Kimi sin pasar por
 * src/paneLauncher.js mientras haya una delegacion activa de inharness.
 * Logica de deteccion compartida con el guard de Claude en
 * src/guardLogic.js.
 */

const { isRawInvocation, hasActiveRows, hasActiveDelegation } = require('./guardLogic');

const blockMessage =
  'inharness: delegacion activa; usa src/paneLauncher.js en lugar de invocar codex exec / kimi -p directamente.';

function evaluate(input) {
  if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'Bash') return null;
  const command = input.tool_input && input.tool_input.command;
  if (!isRawInvocation(command)) return null;
  if (!hasActiveDelegation(input.cwd)) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: blockMessage,
    },
  };
}

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    raw += chunk;
  });
  process.stdin.on('end', () => {
    try {
      const decision = evaluate(JSON.parse(raw));
      if (decision) process.stdout.write(`${JSON.stringify(decision)}\n`);
    } catch (error) {
      process.stderr.write(`inharness hook error: ${error.message}\n`);
      process.exitCode = 1;
    }
  });
}

module.exports = { evaluate, isRawInvocation, hasActiveRows };
