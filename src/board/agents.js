'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { safeFile, readInside, clean } = require('../status');

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const STATES = new Set(['running', 'done', 'failed', 'quota', 'waiting', 'pending']);
const KINDS = new Set(['orchestrator', 'row', 'subagent']);
const LIMIT = 16 * 1024;
const FIELDS = ['cli', 'model', 'provider', 'role', 'note'];

function validId(id) { return typeof id === 'string' && ID.test(id); }
function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
}
function validateAgent(agent) {
  if (!agent || typeof agent !== 'object' || Array.isArray(agent) || !validId(agent.id)) throw new Error('id de agente invalido');
  const allowed = new Set(['id', 'parent', 'kind', ...FIELDS, 'state', 'startedAt', 'updatedAt', 'finishedAt']);
  if (Object.keys(agent).some((key) => !allowed.has(key))) throw new Error('campo de agente desconocido');
  if (agent.parent !== null && (!validId(agent.parent) || agent.parent === agent.id)) throw new Error('parent invalido');
  if (!KINDS.has(agent.kind)) throw new Error('kind invalido');
  if (!STATES.has(agent.state)) throw new Error('state invalido');
  for (const key of FIELDS) {
    if (typeof agent[key] !== 'string' || Buffer.byteLength(agent[key]) > 4096) throw new Error(`${key} invalido`);
  }
  if (!validDate(agent.startedAt) || !validDate(agent.updatedAt)
    || (agent.finishedAt !== undefined && !validDate(agent.finishedAt))) throw new Error('fecha ISO invalida');
  if (Date.parse(agent.updatedAt) < Date.parse(agent.startedAt)) throw new Error('updatedAt anterior a startedAt');
  if (agent.finishedAt && Date.parse(agent.finishedAt) < Date.parse(agent.startedAt)) throw new Error('finishedAt anterior a startedAt');
  if ((agent.state === 'done' || agent.state === 'failed') !== Boolean(agent.finishedAt)) throw new Error('finishedAt incompatible con state');
  if (Buffer.byteLength(JSON.stringify(agent)) >= LIMIT) throw new Error('agente demasiado grande');
  return agent;
}
function agentDir(cwd) { return path.join(path.resolve(cwd), '.inharness', 'agents'); }
function safeDir(dir) {
  let at = path.parse(dir).root;
  for (const part of path.relative(at, dir).split(path.sep)) {
    at = path.join(at, part);
    try { const st = fs.lstatSync(at); if (st.isSymbolicLink() || !st.isDirectory()) return false; }
    catch { return false; }
  }
  return true;
}
function readAgents(cwd) {
  const dir = agentDir(cwd);
  if (!safeDir(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.json$/.test(name)) continue;
    const file = readInside(path.join(dir, name), path.join(path.resolve(cwd), '.inharness'), LIMIT - 1);
    if (!file) continue;
    try {
      const data = validateAgent(JSON.parse(file.text));
      if (`${data.id}.json` === name) out.push(data);
    } catch { /* registro parcial o invalido */ }
  }
  return out;
}
function reportAgent(cwd, fields, now = new Date()) {
  if (!validId(fields.id)) throw new Error('--id invalido');
  if (!STATES.has(fields.state)) throw new Error('--state invalido');
  if (FIELDS.some((key) => fields[key] !== undefined && typeof fields[key] !== 'string')) throw new Error('campo de texto invalido');
  try { if (!fs.statSync(cwd).isDirectory()) throw new Error(); }
  catch { throw new Error('--cwd invalido'); }
  const dir = agentDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  if (!safeDir(dir)) throw new Error('ruta de agents insegura');
  const root = path.join(path.resolve(cwd), '.inharness');
  const target = path.join(dir, `${fields.id}.json`);
  let targetExists = false;
  try { fs.lstatSync(target); targetExists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (targetExists && !safeFile(target, root)) throw new Error('registro de agente inseguro');
  const previous = readAgents(cwd).find((a) => a.id === fields.id);
  if (targetExists && !previous) throw new Error('registro de agente invalido');
  const stamp = now.toISOString();
  const agent = {
    id: fields.id,
    parent: fields.parent === undefined ? (previous ? previous.parent : null) : fields.parent,
    kind: fields.kind || (previous ? previous.kind : 'row'),
    ...Object.fromEntries(FIELDS.map((key) => [key, fields[key] === undefined ? (previous ? previous[key] : '') : clean(fields[key])])),
    state: fields.state,
    startedAt: previous ? previous.startedAt : stamp,
    updatedAt: stamp,
  };
  if (agent.state === 'done' || agent.state === 'failed') agent.finishedAt = previous && previous.state === agent.state ? previous.finishedAt : stamp;
  validateAgent(agent);
  const payload = `${JSON.stringify(agent)}\n`;
  if (Buffer.byteLength(payload) >= LIMIT) throw new Error('agente demasiado grande');
  const tmp = path.join(dir, `${fields.id}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, payload, { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, target);
  } finally { try { fs.unlinkSync(tmp); } catch { /* renombrado o ausente */ } }
  return agent;
}
function reportExit(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  const names = new Set(['id', 'state', 'parent', 'kind', 'cli', 'model', 'provider', 'role', 'note', 'cwd']);
  const fields = {};
  try {
    if (argv.includes('--help')) {
      io.stdout.write('Uso: inharness report --id X --state running|done|failed|quota|waiting|pending [--parent P] [--kind K] [--cli C] [--model M] [--provider P] [--role R] [--note N] [--cwd D]\n');
      return 0;
    }
    for (let i = 0; i < argv.length; i += 2) {
      const name = argv[i].slice(2);
      if (!argv[i].startsWith('--') || !names.has(name) || fields[name] !== undefined || i + 1 >= argv.length) throw new Error(`opcion invalida: ${argv[i]}`);
      fields[name] = argv[i + 1];
    }
    const cwd = fields.cwd || process.cwd();
    try { if (cwd.includes('\0') || !fs.statSync(cwd).isDirectory()) throw new Error(); }
    catch { throw new Error('--cwd invalido'); }
    delete fields.cwd;
    const agent = reportAgent(cwd, fields);
    io.stdout.write(`Agente ${agent.id}: ${agent.state}\n`);
    return 0;
  } catch (error) { io.stderr.write(`inharness report: ${error.message}\n`); return 2; }
}

module.exports = { validId, validateAgent, readAgents, reportAgent, reportExit, STATES, KINDS };
