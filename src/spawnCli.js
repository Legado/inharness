'use strict';

const { spawnSync } = require('node:child_process');
const { buildSpawn } = require('./winArgs');

// Los shims npm se ejecutan con Node; solo los batch arbitrarios necesitan cmd.exe.
function spawnCli(command, args, opts = {}) {
  let spec;
  try {
    spec = buildSpawn(command, args);
  } catch (error) {
    return { ok: false, status: null, stdout: '', stderr: '', error };
  }

  const result = spawnSync(spec.file, spec.args, {
    encoding: 'utf8',
    cwd: opts.cwd,
    input: opts.input,
    timeout: opts.timeoutMs || 10 * 60 * 1000,
    maxBuffer: 1024 * 1024 * 64,
    windowsHide: true,
    windowsVerbatimArguments: spec.windowsVerbatimArguments,
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
