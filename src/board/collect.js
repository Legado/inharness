'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseAssignment, safeFile, readInside, clean } = require('../status');
const { readAgents } = require('./agents');

const LOG = /^([A-Za-z0-9][A-Za-z0-9_-]{0,63})-(claude|codex|kimi)\.log$/i;
const QUOTA = /usage limit|quota|rate limit|\b429\b|cupo/i;
const STATES = ['running', 'done', 'failed', 'quota', 'pending', 'waiting', 'stale'];
const seconds = (start, end) => Number.isFinite(start) ? Math.max(0, Math.floor((end - start) / 1000)) : null;
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } }
function safeDirectory(dir) { try { const st = fs.lstatSync(dir); return st.isDirectory() && !st.isSymbolicLink(); } catch { return false; } }
function tail(file, root) {
  const st = safeFile(file, root);
  if (!st) return { lines: [], mtimeMs: null };
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = Math.min(st.size, 256 * 1024);
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, st.size - size);
    return { lines: buffer.toString('utf8').split(/\r?\n/).slice(-201).map((line) => clean(line).trim()).filter(Boolean), mtimeMs: st.mtimeMs };
  } catch { return { lines: [], mtimeMs: null }; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function validExit(file, root) {
  const data = readInside(file, root, 16384);
  if (!data) return null;
  try {
    const value = JSON.parse(data.text);
    return value && (typeof value.exitCode === 'number' || value.exitCode === null)
      && typeof value.aborted === 'boolean' ? value : null;
  } catch { return null; }
}
function readLogs(root, now) {
  const dir = path.join(root, 'log');
  if (!safeDirectory(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const match = name.match(LOG);
    if (!match) continue;
    const file = path.join(dir, name);
    const data = tail(file, root);
    if (data.mtimeMs === null) continue;
    const exit = validExit(`${file}.exit`, root);
    const pidFile = readInside(`${file}.pid`, root, 32);
    const pid = pidFile && /^\d+$/.test(pidFile.text.trim()) ? Number(pidFile.text.trim()) : null;
    const alive = Number.isSafeInteger(pid) && pid > 0 && pidAlive(pid);
    const startedAt = exit && Number.isFinite(Date.parse(exit.startedAt)) ? exit.startedAt : new Date(data.mtimeMs).toISOString();
    const finishedAt = exit && Number.isFinite(Date.parse(exit.finishedAt)) ? exit.finishedAt : null;
    const state = exit ? exit.aborted || exit.exitCode !== 0 ? 'failed' : 'done' : alive ? 'running' : pid ? 'failed' : 'pending';
    const quotaTimes = data.lines.filter((line) => QUOTA.test(line)).map((line) => {
      const stamp = line.match(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)/);
      const parsed = stamp ? Date.parse(stamp[0]) : NaN;
      return Number.isFinite(parsed) ? parsed : data.mtimeMs;
    });
    out.push({ id: match[1], cli: match[2].toLowerCase(), pid, state, startedAt, finishedAt,
      elapsedSeconds: seconds(Date.parse(startedAt), finishedAt ? Date.parse(finishedAt) : now),
      logFile: file, lastOutput: data.lines.at(-1) || '', logLines: data.lines.slice(-30),
      quota: quotaTimes.length > 0, quotaAt: quotaTimes.length ? new Date(Math.max(...quotaTimes)).toISOString() : null,
      logAt: new Date(data.mtimeMs).toISOString() });
  }
  return out;
}
function dependencies(dep) { return [...new Set(String(dep || '').split(/[,;+\/\s]+/).filter((x) => x && x !== '-' && x !== '—'))]; }
function waves(rows) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const memo = new Map();
  const visiting = new Set();
  const cycles = new Set();
  function depth(id, stack = []) {
    if (memo.has(id)) return memo.get(id);
    if (visiting.has(id)) {
      for (const member of stack.slice(stack.indexOf(id))) cycles.add(member);
      return null;
    }
    visiting.add(id);
    const deps = dependencies(byId.get(id).dep).filter((part) => byId.has(part));
    let n = 0;
    for (const dep of deps) {
      const value = depth(dep, [...stack, id]);
      if (value === null) n = null;
      else if (n !== null) n = Math.max(n, value + 1);
    }
    visiting.delete(id);
    memo.set(id, n);
    return n;
  }
  return rows.map((row) => ({ ...row, dependencies: dependencies(row.dep), wave: depth(row.id), cycle: cycles.has(row.id) }));
}
function tree(agents) {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const visited = new Set();
  const result = [];
  const walk = (agent, level, ancestry) => {
    if (ancestry.has(agent.id) || visited.has(agent.id)) return;
    visited.add(agent.id);
    result.push({ ...agent, level });
    for (const child of agents.filter((a) => a.parent === agent.id)) walk(child, level + 1, new Set([...ancestry, agent.id]));
  };
  for (const agent of agents) if (!agent.parent || !byId.has(agent.parent)) walk(agent, 0, new Set());
  for (const agent of agents) if (!visited.has(agent.id)) walk(agent, 0, new Set());
  return result;
}
function catalogFromHome() {
  const file = path.join(os.homedir(), '.inharness', 'catalog.json');
  const root = path.dirname(file);
  try {
    const st = safeFile(file, root);
    if (!st || st.size > 1024 * 1024) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && Array.isArray(data.clis) ? data : null;
  } catch { return null; }
}
function collectBoard(cwd = process.cwd(), now = Date.now(), deps = {}) {
  const project = path.resolve(cwd);
  const root = path.join(project, '.inharness');
  const assignment = readInside(path.join(root, 'assignment.md'), root);
  const planned = parseAssignment(assignment ? assignment.text : '', { includePlan: true }).map((row) => Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, typeof value === 'string' ? clean(value).slice(0, 4096) : value])));
  const logs = readLogs(root, now);
  const agents = readAgents(project).map((agent) => Object.fromEntries(Object.entries(agent).map(([key, value]) =>
    [key, ['cli', 'model', 'provider', 'role', 'note'].includes(key) ? clean(value) : value])));
  const processes = (deps.processes || []).map((p) => ({ pid: Number(p.pid), cli: clean(p.cli || ''),
    name: clean(p.name || ''), command: clean(p.command || '').slice(0, 160), elapsedSeconds: p.elapsedSeconds == null ? null : Number(p.elapsedSeconds) }));
  const logById = new Map();
  for (const log of logs) if (!logById.has(log.id) || log.logAt > logById.get(log.id).logAt) logById.set(log.id, log);
  const agentById = new Map(agents.map((a) => [a.id, a]));
  const ids = new Set([...planned.map((r) => r.id), ...logs.map((l) => l.id), ...agents.filter((a) => a.kind === 'row').map((a) => a.id)]);
  const rows = waves([...ids].map((id) => {
    const plan = planned.find((r) => r.id === id) || { id, role: 'sin fila', tier: '', files: '', cliModel: '', dep: '', assignmentState: 'pending' };
    const log = logById.get(id);
    const agent = agentById.get(id);
    const state = agent ? agent.state : log && log.state !== 'pending' ? log.state : plan.assignmentState;
    const startedAt = agent ? agent.startedAt : log ? log.startedAt : null;
    const finishedAt = agent ? agent.finishedAt || null : log ? log.finishedAt : null;
    return { ...plan, cli: agent && agent.cli || log && log.cli || (plan.cliModel.split('/')[0] || ''),
      model: agent && agent.model || plan.cliModel.split('/').slice(1).join('/'), provider: agent && agent.provider || '',
      state, startedAt, finishedAt, elapsedSeconds: seconds(startedAt ? Date.parse(startedAt) : NaN, finishedAt ? Date.parse(finishedAt) : now),
      pid: log ? log.pid : null, lastOutput: log ? log.lastOutput : '', logLines: log ? log.logLines : [], logAt: log ? log.logAt : null,
      note: agent ? agent.note : '' };
  }));
  const enriched = agents.map((a) => {
    const row = rows.find((r) => r.id === a.id);
    const hasProcess = processes.some((p) => p.cli === a.cli && (row && p.pid === row.pid || p.command.includes(a.id)));
    return { ...a, state: a.state === 'running' && now - Date.parse(a.updatedAt) > 600000 && !hasProcess && !(row && row.pid && pidAlive(row.pid)) ? 'stale' : a.state,
      elapsedSeconds: seconds(Date.parse(a.startedAt), a.finishedAt ? Date.parse(a.finishedAt) : now) };
  });
  for (const row of rows) {
    const agent = enriched.find((a) => a.id === row.id);
    if (agent) row.state = agent.state;
  }
  const orchestrator = enriched.find((a) => a.kind === 'orchestrator');
  const agentRows = rows.filter((row) => !enriched.some((a) => a.id === row.id)).map((row) => ({
    id: row.id, parent: orchestrator ? orchestrator.id : null, kind: 'row', cli: row.cli, model: row.model,
    provider: row.provider, role: row.role, note: '', state: row.state, elapsedSeconds: row.elapsedSeconds,
    startedAt: row.startedAt, finishedAt: row.finishedAt, registered: false,
  }));
  const nowFile = readInside(path.join(root, 'now.md'), root, 65536);
  const nowPanel = { text: nowFile ? nowFile.text.split(/\r?\n/).slice(0, 12).map(clean).join('\n') : '(sin now.md)',
    ageSeconds: nowFile ? seconds(nowFile.mtimeMs, now) : null };
  const allAgents = tree([...enriched, ...agentRows]);
  const counts = Object.fromEntries(STATES.map((s) => [s, allAgents.filter((a) => a.state === s).length]));
  const total = allAgents.length;
  const catalog = deps.catalog === undefined ? catalogFromHome() : deps.catalog;
  const providers = ['claude', 'codex', 'kimi'].map((cli) => {
    const related = allAgents.filter((a) => a.cli === cli);
    const used = logs.filter((l) => l.cli === cli).sort((a, b) => b.logAt.localeCompare(a.logAt));
    const recentQuota = used.find((l) => l.quotaAt && now - Date.parse(l.quotaAt) >= 0 && now - Date.parse(l.quotaAt) <= 6 * 3600000);
    const activeRows = rows.filter((r) => r.cli === cli && ['running', 'waiting', 'quota', 'stale'].includes(r.state));
    const listed = catalog && catalog.clis && catalog.clis.find((c) => c.id === cli);
    return { cli, active: related.filter((r) => r.state === 'running').length, activeRows: activeRows.map((r) => r.id),
      done: related.filter((r) => r.state === 'done').length, total: related.length,
      failed: related.filter((r) => r.state === 'failed').length, quota: Boolean(recentQuota),
      quotaAt: recentQuota ? recentQuota.quotaAt : null, lastUse: used[0] && used[0].logAt || null,
      models: [...new Set(related.map((r) => r.model).filter(Boolean))].slice(0, 8),
      availableModels: listed && Array.isArray(listed.models) ? listed.models.length : null };
  });
  const events = [...enriched.map((a) => ({ at: a.updatedAt, text: `${a.id}: ${a.state}${a.note ? ` - ${clean(a.note)}` : ''}` })),
    ...logs.map((l) => ({ at: l.logAt, text: `${l.id}/${l.cli} ${l.state}: ${l.lastOutput || '-'}` }))]
    .sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8);
  const first = [...rows.map((r) => r.startedAt), ...enriched.map((a) => a.startedAt)].filter(Boolean).sort()[0] || null;
  const attached = processes.map((p) => ({ ...p, registered: rows.some((r) => r.pid === p.pid) || enriched.some((a) => p.command.includes(a.id) && a.cli === p.cli) }));
  return { project: path.basename(project), generatedAt: new Date(now).toISOString(), firstStartedAt: first,
    elapsedSeconds: first ? seconds(Date.parse(first), now) : null, now: nowPanel, counts, total,
    completed: counts.done, rows, agents: allAgents, processes: attached, providers, events };
}

module.exports = { collectBoard, waves, tree, dependencies, readLogs };
