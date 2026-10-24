'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectBoard, waves, tree } = require('../src/board/collect');
const { reportAgent } = require('../src/board/agents');
const { parseProcesses } = require('../src/board/procs');
const { render } = require('../src/board/render');
const { parseAssignment } = require('../src/status');

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'inharness-board-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const root = path.join(cwd, '.inharness');
  fs.mkdirSync(path.join(root, 'log'), { recursive: true });
  return { cwd, root };
}
test('oleadas, ciclos de dependencia y arbol de agentes con ciclos', () => {
  const rows = waves([{ id: 'A', dep: '' }, { id: 'B', dep: 'A' }, { id: 'C', dep: 'B' }, { id: 'D', dep: 'E' }, { id: 'E', dep: 'D' }]);
  assert.deepEqual(rows.map((r) => r.wave), [0, 1, 2, null, null]);
  assert.deepEqual(rows.map((r) => r.cycle), [false, false, false, true, true]);
  const agents = tree([{ id: 'O', parent: null }, { id: 'R', parent: 'O' }, { id: 'S', parent: 'R' }, { id: 'X', parent: 'Y' }, { id: 'Y', parent: 'X' }]);
  assert.equal(agents.length, 5);
  assert.deepEqual(agents.slice(0, 3).map((a) => a.level), [0, 1, 2]);
});
test('fusiona agentes, procesos, cupo y limpia secretos y controles de logs', (t) => {
  const { cwd, root } = fixture(t);
  fs.writeFileSync(path.join(root, 'assignment.md'), '| id | rol | tier | cli/modelo | ficheros | dep | estado |\n| A | API | alta | codex/m1 | src/a.js | - | en curso |\n| B | test | baja | kimi/m2 | test/a.js | A | pendiente |');
  fs.writeFileSync(path.join(root, 'now.md'), 'QUE HAGO: token=hunter2');
  fs.writeFileSync(path.join(root, 'log', 'A-codex.log'), 'inicio\n\x1b[31mquota sk-demo123\x1b[0m\nultima\x07\n');
  fs.utimesSync(path.join(root, 'log', 'A-codex.log'), new Date('2026-01-01T00:14:00Z'), new Date('2026-01-01T00:14:00Z'));
  reportAgent(cwd, { id: 'A', kind: 'row', cli: 'codex', state: 'running', note: 'Bearer secret' }, new Date('2026-01-01T00:00:00Z'));
  const model = collectBoard(cwd, Date.parse('2026-01-01T00:15:00Z'), { processes: [{ pid: 123, cli: 'codex', command: 'codex token=abc', elapsedSeconds: 25 }], catalog: { clis: [{ id: 'codex', models: [{ id: 'm1' }] }] } });
  assert.equal(model.rows.find((r) => r.id === 'B').wave, 1);
  assert.equal(model.agents[0].state, 'stale');
  assert.ok(model.agents.some((a) => a.id === 'B' && a.registered === false));
  assert.equal(model.processes[0].registered, false);
  assert.equal(model.providers.find((p) => p.cli === 'codex').quota, true);
  assert.ok(!JSON.stringify(model).includes('hunter2'));
  assert.ok(!JSON.stringify(model).includes('sk-demo123'));
  assert.ok(!JSON.stringify(model).includes('token=abc'));
  assert.ok(!JSON.stringify(model).includes('\x1b'));
  const live = collectBoard(cwd, Date.parse('2026-01-01T00:15:00Z'), { processes: [{ pid: 9, cli: 'codex', command: 'codex --id A', elapsedSeconds: 30 }], catalog: null });
  assert.equal(live.agents.find((a) => a.id === 'A').state, 'running');
});
test('parser de procesos Unix y Windows solo devuelve CLIs', () => {
  const unix = parseProcesses('PID ELAPSED COMMAND COMMAND\n 12 99 node node /x/codex/cli.js\n 13 5 bash bash\n 14 3 claude claude run', 'linux');
  assert.deepEqual(unix.map((p) => p.cli), ['codex', 'claude']);
  const win = parseProcesses(JSON.stringify([{ ProcessId: 5, Name: 'node.exe', CommandLine: 'node C:\\kimi\\cli.js', CreationDate: '2026-01-01T00:00:00Z' }]), 'win32', Date.parse('2026-01-01T00:01:00Z'));
  assert.equal(win[0].elapsedSeconds, 60);
});
test('render mantiene 80x24 y 120x40, ASCII y logs con ESC', (t) => {
  const { cwd, root } = fixture(t);
  fs.writeFileSync(path.join(root, 'log', 'A-codex.log'), '\x1b[2J\x1b[Hmal\x00 token=hunter2\n'.repeat(35));
  const model = collectBoard(cwd, Date.now(), { processes: [], catalog: null });
  model.events = Array.from({ length: 8 }, (_, i) => ({ at: `2026-01-01T00:00:0${i}Z`, text: `EVENT${i}` }));
  for (const [columns, rows] of [[80, 24], [120, 40]]) for (const screen of ['resumen', 'agentes', 'plan', 'registro']) {
    const output = render(model, { screen, columns, rows, ascii: true, color: true, openLog: true });
    const lines = output.trimEnd().split('\n');
    assert.equal(lines.length, rows);
    assert.ok(lines.every((s) => s.replace(/\x1b\[[0-9;]*m/g, '').length <= columns));
    assert.ok(!output.includes('\x1b[2J'));
    assert.ok(!output.includes('hunter2'));
    assert.ok(!/[^\x09\x0a\x0d\x20-\x7e]/.test(output.replace(/\x1b\[[0-9;]*m/g, '')));
    if (screen === 'resumen') assert.match(output, /EVENT7/);
  }
});
test('contadores incluyen IDs unicos de filas, subagentes y orquestador', (t) => {
  const { cwd, root } = fixture(t);
  fs.writeFileSync(path.join(root, 'assignment.md'), '| id | estado | cli/modelo |\n| A | en curso | codex/m |\n| D | hecho | kimi/m |');
  const start = new Date('2026-01-01T00:00:00Z');
  reportAgent(cwd, { id: 'O', kind: 'orchestrator', state: 'running' }, start);
  reportAgent(cwd, { id: 'A', kind: 'row', parent: 'O', cli: 'codex', state: 'running' }, start);
  reportAgent(cwd, { id: 'S', kind: 'subagent', parent: 'A', cli: 'codex', state: 'waiting' }, start);
  reportAgent(cwd, { id: 'D', kind: 'row', parent: 'O', cli: 'kimi', state: 'done' }, start);
  const model = collectBoard(cwd, Date.parse('2026-01-01T00:01:00Z'), { processes: [{ pid: 7, cli: 'codex', command: 'codex --id A' }], catalog: null });
  assert.equal(model.total, 4);
  assert.equal(model.completed, 1);
  assert.equal(model.counts.running, 2);
  assert.equal(model.counts.waiting, 1);
  assert.equal(model.counts.done, 1);
  assert.equal(model.agents.filter((a) => a.id === 'A').length, 1);
  assert.match(render(model, { ascii: true, columns: 80 }), /running:2  done:1/);
  assert.deepEqual(model.providers.find((p) => p.cli === 'codex').activeRows, ['A']);
});
test('AGENTES colapsa completadas, conserva ruta de padres y separa procesos libres', (t) => {
  const { cwd } = fixture(t);
  const start = new Date('2026-01-01T00:00:00Z');
  reportAgent(cwd, { id: 'O', kind: 'orchestrator', state: 'running' }, start);
  reportAgent(cwd, { id: 'A', kind: 'row', parent: 'O', state: 'running' }, start);
  reportAgent(cwd, { id: 'S', kind: 'subagent', parent: 'A', state: 'waiting' }, start);
  reportAgent(cwd, { id: 'D', kind: 'row', parent: 'O', state: 'done', role: 'FINALIZADA' }, start);
  const model = collectBoard(cwd, Date.parse('2026-01-01T00:02:00Z'), { catalog: null,
    processes: [{ pid: 99, cli: 'codex', command: 'codex independiente', elapsedSeconds: 12 }] });
  const collapsed = render(model, { screen: 'agentes', ascii: true, columns: 120, rows: 40 });
  assert.match(collapsed, /1 completadas \(ultimas: D\)/);
  assert.match(collapsed, /O > A > S/);
  assert.doesNotMatch(collapsed, /FINALIZADA/);
  assert.match(collapsed, /99 codex 12s/);
  assert.match(render(model, { screen: 'agentes', showDone: true, ascii: true, columns: 120, rows: 40 }), /FINALIZADA/);
});
test('AGENTES conserva resumen y marcos con muchas filas a 80x24', (t) => {
  const { cwd } = fixture(t);
  const model = collectBoard(cwd, Date.now(), { catalog: null, processes: [] });
  model.agents = [
    ...Array.from({ length: 10 }, (_, i) => ({ id: `R${i}`, state: 'running', kind: 'row', parent: null })),
    ...Array.from({ length: 30 }, (_, i) => ({ id: `D${i}`, state: 'done', kind: 'row', parent: null })),
    ...Array.from({ length: 10 }, (_, i) => ({ id: `P${i}`, state: 'pending', kind: 'row', parent: null })),
  ];
  model.processes = Array.from({ length: 10 }, (_, i) => ({ pid: i + 1, cli: 'codex', registered: false }));
  const output = render(model, { screen: 'agentes', showDone: true, ascii: true, columns: 80, rows: 24 });
  assert.match(output, /30 completadas/);
  assert.match(output, /PROCESOS CLI SIN FILA/);
  assert.equal(output.split('\n').filter((line) => /^\+- /.test(line)).length,
    output.split('\n').filter((line) => /^\+-+\+$/.test(line)).length);
});
test('dependencias aceptan cabeceras alternativas y separadores mixtos', () => {
  for (const header of ['dep', 'depende-de', 'depende de', 'depende']) {
    const rows = parseAssignment(`| id | estado | ${header} |\n| A | hecho | - |\n| B | pendiente | A + X/Y, - |`, { includePlan: true });
    const result = waves(rows);
    assert.deepEqual(result[1].dependencies, ['A', 'X', 'Y']);
    assert.equal(result[1].wave, 1);
  }
});
test('PLAN dibuja eje comun, barras temporales y pendientes resumidas', (t) => {
  const { cwd, root } = fixture(t);
  fs.writeFileSync(path.join(root, 'assignment.md'), '| id | estado | depende de |\n| A | en curso | - |\n| B | hecho | A |\n| C | pendiente | A + B |');
  reportAgent(cwd, { id: 'A', cli: 'codex', state: 'running' }, new Date('2026-01-01T00:00:00Z'));
  reportAgent(cwd, { id: 'B', state: 'running' }, new Date('2026-01-01T00:10:00Z'));
  reportAgent(cwd, { id: 'B', state: 'done' }, new Date('2026-01-01T00:30:00Z'));
  const model = collectBoard(cwd, Date.parse('2026-01-01T01:00:00Z'), { catalog: null,
    processes: [{ pid: 7, cli: 'codex', command: 'codex --id A' }] });
  const plan = render(model, { screen: 'plan', period: '1h', ascii: true, columns: 120, rows: 40 });
  assert.match(plan, /LINEA DE TIEMPO 1h 00:00 .. 01:00/);
  assert.match(plan, /A\s+#+.*running/);
  assert.match(plan, /B\s+\.*#+.*done/);
  assert.match(plan, /HECHAS ola 1/);
  assert.match(plan, /PLANIFICADO \(1\)/);
  assert.match(plan, /C espera: A, B/);
  assert.match(render(model, { screen: 'plan', ascii: true }), /LINEA DE TIEMPO 12h/);
});
test('RESUMEN usa dos columnas a 120 y paneles apilados a 80', (t) => {
  const { cwd } = fixture(t);
  const model = collectBoard(cwd, Date.now(), { catalog: null, processes: [] });
  const wide = render(model, { screen: 'resumen', ascii: true, columns: 120, rows: 40 });
  const narrow = render(model, { screen: 'resumen', ascii: true, columns: 80, rows: 24 });
  assert.match(wide, /AHORA.*PROVEEDORES/);
  assert.doesNotMatch(narrow, /AHORA.*PROVEEDORES/);
  assert.ok(narrow.indexOf('AHORA') < narrow.indexOf('EN MARCHA') && narrow.indexOf('EN MARCHA') < narrow.indexOf('PROVEEDORES'));
  for (const [value, columns, rows] of [[wide, 120, 40], [narrow, 80, 24]]) {
    const lines = value.trimEnd().split('\n');
    assert.equal(lines.length, rows);
    assert.ok(lines.every((line) => line.length <= columns));
    assert.ok(lines.some((line) => /ACTIVIDAD/.test(line)));
  }
  assert.doesNotMatch(narrow, /-- RESUMEN --/);
});
test('cupo? exige patron de log de las ultimas seis horas', (t) => {
  const { cwd, root } = fixture(t);
  const file = path.join(root, 'log', 'A-codex.log');
  fs.writeFileSync(file, 'HTTP 429');
  const now = Date.parse('2026-01-02T12:00:00Z');
  fs.utimesSync(file, new Date(now - 24 * 3600000), new Date(now - 24 * 3600000));
  let model = collectBoard(cwd, now, { catalog: null, processes: [] });
  assert.equal(model.providers.find((p) => p.cli === 'codex').quota, false);
  assert.doesNotMatch(render(model, { ascii: true }), /cupo\?/);
  fs.utimesSync(file, new Date(now - 3600000), new Date(now - 3600000));
  model = collectBoard(cwd, now, { catalog: null, processes: [] });
  assert.equal(model.providers.find((p) => p.cli === 'codex').quota, true);
  fs.writeFileSync(file, '2026-01-01T12:00:00Z HTTP 429\n2026-01-02T11:00:00Z trabajo normal');
  fs.utimesSync(file, new Date(now - 3600000), new Date(now - 3600000));
  model = collectBoard(cwd, now, { catalog: null, processes: [] });
  assert.equal(model.providers.find((p) => p.cli === 'codex').quota, false);
});
