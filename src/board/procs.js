'use strict';

const { execFile } = require('node:child_process');
const { clean } = require('../status');

let cached = [];
let refreshedAt = 0;
let pending = false;
const CLI = /(?:^|[\\/\s'"-])(claude|codex|kimi)(?:\.exe|\.cmd|\.js)?(?:$|[\\/\s'"-])/i;

function classify(name, command) {
  const match = `${name || ''} ${command || ''}`.match(CLI);
  return match ? match[1].toLowerCase() : null;
}
function parseProcesses(output, platform = process.platform, now = Date.now()) {
  try {
    const entries = platform === 'win32' ? [JSON.parse(output)].flat() : output.split(/\r?\n/).slice(1).map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
      return match && { ProcessId: Number(match[1]), etimes: Number(match[2]), Name: match[3], CommandLine: match[4] };
    }).filter(Boolean);
    return entries.map((item) => {
      const pid = Number(item.ProcessId);
      const cli = classify(item.Name, item.CommandLine);
      const created = item.CreationDate ? Date.parse(item.CreationDate) : NaN;
      return { pid, cli, name: clean(item.Name || ''), command: clean(item.CommandLine || '').slice(0, 160),
        elapsedSeconds: Number.isFinite(item.etimes) ? item.etimes : Number.isFinite(created) ? Math.max(0, Math.floor((now - created) / 1000)) : null };
    }).filter((item) => Number.isSafeInteger(item.pid) && item.pid > 0 && item.cli);
  } catch { return []; }
}
function getProcesses(now = Date.now()) {
  if (!pending && now - refreshedAt >= 10000) {
    pending = true;
    const win = process.platform === 'win32';
    const command = win ? 'powershell' : 'ps';
    const args = win ? ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Where-Object {$_.Name -match '^(claude|codex|kimi|node)'} | Select ProcessId,Name,CommandLine,CreationDate | ConvertTo-Json"]
      : ['-eo', 'pid,etimes,comm,args'];
    execFile(command, args, { timeout: 4000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (!error) cached = parseProcesses(stdout, process.platform, Date.now());
      refreshedAt = Date.now();
      pending = false;
    });
  }
  return cached;
}

module.exports = { parseProcesses, getProcesses };
