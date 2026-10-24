'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readAgents, reportAgent, validateAgent, reportExit } = require('../src/board/agents');

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'inharness-board-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}
test('report conserva inicio, escribe atomico y termina done/failed', (t) => {
  const cwd = fixture(t);
  const a = reportAgent(cwd, { id: 'A1', kind: 'subagent', parent: 'O1', cli: 'codex', state: 'running', note: 'arranca' }, new Date('2026-01-01T00:00:00Z'));
  const b = reportAgent(cwd, { id: 'A1', state: 'done', note: 'termina' }, new Date('2026-01-01T00:01:00Z'));
  assert.equal(b.startedAt, a.startedAt);
  assert.equal(b.finishedAt, '2026-01-01T00:01:00.000Z');
  assert.equal(b.parent, 'O1');
  assert.deepEqual(readAgents(cwd), [b]);
  assert.deepEqual(fs.readdirSync(path.join(cwd, '.inharness', 'agents')), ['A1.json']);
  const c = reportAgent(cwd, { id: 'A1', state: 'failed' }, new Date('2026-01-01T00:02:00Z'));
  assert.equal(c.finishedAt, '2026-01-01T00:02:00.000Z');
});
test('rechaza ids, fechas, estados, JSON invalido y symlinks', (t) => {
  const cwd = fixture(t);
  for (const id of ['../escape', 'a/b', '', 'a'.repeat(65)]) assert.throws(() => reportAgent(cwd, { id, state: 'running' }));
  assert.throws(() => reportAgent(cwd, { id: 'OK', state: 'unknown' }));
  assert.throws(() => reportAgent(cwd, { id: 'OK', state: 'running', parent: '../X' }));
  const dir = path.join(cwd, '.inharness', 'agents');
  fs.writeFileSync(path.join(dir, 'bad.json'), '{');
  fs.writeFileSync(path.join(dir, 'wrong.json'), JSON.stringify({ id: 'other' }));
  assert.deepEqual(readAgents(cwd), []);
  const invalid = { id: 'A', parent: null, kind: 'row', cli: '', model: '', provider: '', role: '', note: '', state: 'done', startedAt: '2026-99-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
  assert.throws(() => validateAgent(invalid));
  const outside = path.join(cwd, 'outside.json');
  fs.writeFileSync(outside, '{"secret":"outside"}');
  try { fs.symlinkSync(outside, path.join(dir, 'link.json'), 'file'); }
  catch (e) { if (e.code === 'EPERM') return; throw e; }
  assert.deepEqual(readAgents(cwd), []);
  assert.throws(() => reportAgent(cwd, { id: 'link', state: 'running' }));
});
test('reportExit valida opciones y responde en espanol', (t) => {
  const cwd = fixture(t);
  let out = ''; let err = '';
  const io = { stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } } };
  assert.equal(reportExit(['--id', 'O1', '--state', 'running', '--kind', 'orchestrator', '--cwd', cwd], io), 0);
  assert.match(out, /Agente O1: running/);
  assert.equal(reportExit(['--id', '../x', '--state', 'done', '--cwd', cwd], io), 2);
  assert.match(err, /invalido/);
});
