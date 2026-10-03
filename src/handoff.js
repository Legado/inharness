'use strict';

const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

function handoff(cli) {
  const isWin = os.platform() === 'win32';
  const { id, resolvedCmd } = cli;
  const usesCmdWrapper = isWin && /\.cmd$/i.test(resolvedCmd);

  let exe;
  let args = [];

  if (id === 'claude') {
    if (usesCmdWrapper) {
      exe = process.env.ComSpec || 'cmd.exe';
      args = ['/d', '/s', '/c', resolvedCmd];
    } else {
      exe = resolvedCmd;
    }
  } else if (id === 'codex') {
    // --no-daemon: sin esto, el app-server compartido de Codex puede fallar
    // con "the CLI package does not match this platform or executable".
    if (usesCmdWrapper) {
      exe = process.env.ComSpec || 'cmd.exe';
      args = ['/d', '/s', '/c', resolvedCmd, '--no-daemon'];
    } else {
      exe = resolvedCmd;
      args = ['--no-daemon'];
    }
  } else if (id === 'kimi') {
    const agentFile = path.join(os.homedir(), '.kimi-code', 'agents', 'inharness.md');
    if (usesCmdWrapper) {
      exe = process.env.ComSpec || 'cmd.exe';
      args = ['/d', '/s', '/c', resolvedCmd, '--agent-file', agentFile];
    } else {
      exe = resolvedCmd;
      args = ['--agent-file', agentFile];
    }
  } else {
    throw new Error(`CLI desconocido: ${id}`);
  }

  const child = spawn(exe, args, { stdio: 'inherit', cwd: process.cwd() });
  return new Promise((resolve) => {
    child.on('exit', (code) => resolve(code ?? 0));
    child.on('error', (err) => {
      console.error(`No se pudo lanzar ${id}: ${err.message}`);
      resolve(1);
    });
  });
}

module.exports = { handoff };
