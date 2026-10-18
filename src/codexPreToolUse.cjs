#!/usr/bin/env node
'use strict';

const { isRawInvocation, hasActiveRows, shouldBlock, BLOCK_MESSAGE } = require('./guardLogic');

function evaluate(input) {
  if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'Bash') return null;
  const command = input.tool_input && input.tool_input.command;
  if (!shouldBlock(command, input.cwd)) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: BLOCK_MESSAGE,
    },
  };
}

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { raw += chunk; });
  process.stdin.on('end', () => {
    try {
      const decision = evaluate(JSON.parse(raw));
      if (decision) process.stdout.write(`${JSON.stringify(decision)}\n`);
    } catch (err) {
      process.stderr.write(`inharness hook error: ${err.message}\n`);
    }
    process.exitCode = 0;
  });
  process.stdin.on('error', (err) => {
    process.stderr.write(`inharness hook error: ${err.message}\n`);
    process.exitCode = 0;
  });
}

module.exports = { evaluate, isRawInvocation, hasActiveRows };
