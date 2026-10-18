#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { shouldBlock, BLOCK_MESSAGE } = require('./guardLogic');

function main() {
  try {
    const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
    const command = payload.tool_input && payload.tool_input.command;
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : process.cwd();
    if ((payload.tool_name === 'Bash' || payload.tool_name === 'PowerShell') && shouldBlock(command, cwd)) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: {
        hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: BLOCK_MESSAGE,
      } }));
    } else {
      process.stdout.write(JSON.stringify({ continue: true }));
    }
  } catch (err) {
    process.stderr.write(`inharness hook error: ${err.message}\n`);
    process.stdout.write(JSON.stringify({ continue: true }));
  }
  process.exitCode = 0;
}

if (require.main === module) main();

module.exports = { main };
