'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseAssignment, normalizeState, collectState, redact, render, statusExit } = require('../src/status');

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'inharness-status-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, '.inharness', 'log'), { recursive: true });
  return { cwd, root: path.join(cwd, '.inharness') };
}

function log(root, id, cli, text, pid, exit) {
  const file = path.join(root, 'log', `${id}-${cli}.log`);
  fs.writeFileSync(file, text);
  if (pid !== undefined) fs.writeFileSync(`${file}.pid`, String(pid));
  if (exit !== undefined) fs.writeFileSync(`${file}.exit`, JSON.stringify(exit));
}

test('parseAssignment lee varias tablas, cabeceras variables y barras escapadas', () => {
  const rows = parseAssignment(`| Estado | ID | Alcance | CLI | Dep |
| :--- | ---: | --- | --- | --- |
| en curso | A1 | API \\| UI | codex | - |

texto libre

| id | CLI/Modelo | rol | ESTADO |
| --- | --- | --- | --- |
| B2 | kimi/modelo | pruebas | Hecho y verificado |
| C3 | claude | docs | bloqueada-cupo |
| D4 | claude | docs | fallido |
`);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].role, 'API | UI');
  assert.deepEqual(rows.map((row) => row.assignmentState), ['running', 'done', 'quota', 'failed']);
  assert.equal(rows[1].cliModel, 'kimi/modelo');
  assert.equal(parseAssignment('| id | estado |\n|---|---|\n| Z9 | hecha |\n')[0].assignmentState, 'done');
  assert.deepEqual(parseAssignment('| id | estado |\n| A1 | pendiente |\n| ID | STATUS |\n| B2 | ok |')
    .map((row) => row.assignmentState), ['pending', 'done']);
  assert.equal(normalizeState('bloqueada'), 'quota');
  assert.equal(normalizeState('cupo agotado'), 'quota');
  assert.equal(normalizeState('tarea hecha'), 'done');
});

test('assignment sin separadores conserva filas, estados y progreso entre tablas', (t) => {
  const { cwd, root } = fixture(t);
  const markdown = `## Reparto
| id | rol | tier | cli/modelo | ficheros | dep | estado |
| A1 | implementacion | alto | codex/base | src/a.js | - | hecho PR demo#1 + demo#2 |
| V1-V2 | verificacion | medio | kimi/base | test/a.js | A1 | hecho (no prod; fallo anterior documentado y revisado en auditoria) |
| B2 | pruebas | bajo | claude/base | test/b.js | A1 | en curso |
| C3 | revision | medio | codex/base | src/b.js | B2 | fallido |

- texto de lista entre tablas
texto plano | con barra | tampoco es tabla
## Seguimiento
| ID | alcance | cli/modelo | STATUS |
| W1-W9 | lote | kimi/base | pendiente |
| D4 | informe | claude/base | bloqueada por cupo |
| E5 | informe | codex/base | done \\| revisado |
| F6 | informe | kimi/base | ok |
| G7 | informe | claude/base | |
| H8 | informe | codex/base |
| I9 | informe | kimi/base | error | celda extra |
| J10 | informe | claude/base | running |

| id | estado |
|---|---|
| K11 | hecha |
`;
  fs.writeFileSync(path.join(root, 'assignment.md'), markdown);
  fs.writeFileSync(path.join(root, 'now.md'), 'Tarea actual: validar tablas\n');
  const exit = { exitCode: 1, aborted: false, startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:01:00Z' };
  log(root, 'A1', 'codex', 'fallo real\n', undefined, exit);
  log(root, 'V1', 'kimi', 'log individual\n');
  const parsed = parseAssignment(markdown);
  assert.equal(parsed.length, 13);
  assert.deepEqual(parsed.map((row) => row.assignmentState), [
    'done', 'done', 'running', 'failed', 'pending', 'quota', 'done', 'done', 'pending', 'pending', 'failed', 'running', 'done',
  ]);
  assert.equal(parsed.find((row) => row.id === 'E5').assignmentStatus, 'done | revisado');
  assert.equal(parsed.find((row) => row.id === 'H8').assignmentState, 'pending');
  const state = collectState(cwd);
  assert.equal(state.total, 14);
  assert.equal(state.completed, 4);
  assert.equal(state.rows.find((row) => row.id === 'A1').state, 'failed');
  assert.equal(state.rows.find((row) => row.id === 'A1').discrepancy, true);
  assert.equal(state.rows.find((row) => row.id === 'V1-V2').state, 'done');
  assert.equal(state.rows.find((row) => row.id === 'V1').role, 'sin fila');
  const panel = render(state, { ascii: true, columns: 100 });
  assert.match(panel, /\[###\.\.\.\.\.\.\.\] 4\/14/);
  assert.match(panel, /AHORA MISMO/);
  assert.match(panel, /Tarea actual: validar tablas/);
  assert.match(panel, /hecho \(no prod/);
  assert.ok(!panel.includes('hecho (no prod; fallo anterior documentado y revisado en auditoria)'));
});

test('collectState fusiona estados reales, discrepancias, logs sin fila y now.md', (t) => {
  const { cwd, root } = fixture(t);
  fs.writeFileSync(path.join(root, 'assignment.md'), `| id | estado | cli/modelo |
| --- | --- | --- |
| A1 | pendiente | codex/modelo |
| B2 | en curso | kimi/modelo |
| C3 | en curso | claude/modelo |
| D4 | hecho | codex/modelo |
| E5 | bloqueada-cupo | kimi/modelo |
`);
  const times = { startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:01:00.000Z' };
  log(root, 'A1', 'codex', 'primera\nsegunda\n', process.pid);
  log(root, 'B2', 'kimi', 'ok\n', undefined, { ...times, exitCode: 0, aborted: false });
  log(root, 'C3', 'claude', 'error\n', undefined, { ...times, exitCode: 1, aborted: false });
  log(root, 'D4', 'codex', 'sin cierre\n', 2147483647);
  log(root, 'F6', 'kimi', 'extra\n');
  fs.writeFileSync(path.join(root, 'now.md'), 'QUE HAGO: revisar\nESPERANDO: A1\nSIGUIENTE: cerrar\n');
  const state = collectState(cwd, Date.parse('2026-01-01T00:02:00.000Z'));
  assert.deepEqual(state.rows.map((row) => row.state), ['running', 'failed', 'dead', 'quota', 'pending', 'done']);
  assert.equal(state.rows.find((row) => row.id === 'A1').discrepancy, true);
  assert.equal(state.rows.find((row) => row.id === 'B2').elapsedSeconds, 60);
  assert.equal(state.rows.find((row) => row.id === 'F6').role, 'sin fila');
  assert.match(state.now.text, /ESPERANDO: A1/);
  assert.equal(state.counts.done, 1);
});

test('redact limpia secretos y controles antes de mostrar la salida', (t) => {
  const { cwd, root } = fixture(t);
  const secretLine = 'sk-demo123 sk-ant-demo123 ghp_demo123 gho_demo123 github_pat_demo123 xoxb-demo123 AKIAABCDEFGHIJKLMNOP eyJabc.def.ghi Bearer demo password=hunter2 secret=hidden token=hidden api_key=hidden';
  log(root, 'A1', 'codex', `\x1b[31m${secretLine}\x1b[0m\nlinea final\n`);
  const state = collectState(cwd);
  const output = state.rows[0].lastOutput;
  for (const secret of ['sk-demo123', 'sk-ant-demo123', 'ghp_demo123', 'xoxb-demo123', 'AKIAABCDEFGHIJKLMNOP', 'eyJabc', 'hunter2', '\x1b']) assert.ok(!output.includes(secret));
  assert.match(output, /\[redactado\]/);
  assert.match(redact('Bearer abc'), /Bearer \[redactado\]/);
});

test('render respeta NO_COLOR, ASCII y ancho de 60 columnas', (t) => {
  const { cwd, root } = fixture(t);
  log(root, 'A1', 'codex', 'salida '.repeat(40));
  const state = collectState(cwd);
  const old = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  t.after(() => { if (old === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = old; });
  const unicode = render(state, { columns: 60, color: true });
  assert.ok(!unicode.includes('\x1b'));
  assert.ok(unicode.includes('┌'));
  assert.ok(unicode.includes('…'));
  assert.ok(unicode.trimEnd().split('\n').every((line) => line.length <= 60));
  const ascii = render(state, { columns: 60, ascii: true, color: true });
  assert.ok(ascii.includes('+'));
  assert.ok(!/[┌●█…]/.test(ascii));
  assert.ok(ascii.trimEnd().split('\n').every((line) => line.length <= 60));
});

test('now.md ausente y symlinks hacia fuera no se leen', (t) => {
  const { cwd, root } = fixture(t);
  assert.match(collectState(cwd).now.text, /sin now\.md/);
  const outside = path.join(cwd, 'outside.txt');
  fs.writeFileSync(outside, 'password=outside-secret');
  for (const name of ['now.md', 'assignment.md']) {
    try { fs.symlinkSync(outside, path.join(root, name), 'file'); }
    catch (error) { if (error.code === 'EPERM') return; throw error; }
  }
  const state = collectState(cwd);
  assert.equal(state.total, 0);
  assert.ok(!JSON.stringify(state).includes('outside-secret'));
  try { fs.symlinkSync(outside, path.join(root, 'log', 'A1-codex.log'), 'file'); }
  catch (error) { if (error.code === 'EPERM') return; throw error; }
  assert.equal(collectState(cwd).total, 0);
});

test('exit abortado falla y now.md muestra como maximo 12 lineas', (t) => {
  const { cwd, root } = fixture(t);
  log(root, 'A1', 'codex', 'interrumpido\n', undefined, { exitCode: 0, aborted: true,
    startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:02.000Z' });
  fs.writeFileSync(path.join(root, 'now.md'), Array.from({ length: 15 }, (_, i) => `linea ${i}`).join('\n'));
  const state = collectState(cwd);
  assert.equal(state.rows[0].state, 'failed');
  assert.equal(state.now.text.split('\n').length, 12);
});

test('JSON de exit incompleto se ignora y CLI emite JSON valido', (t) => {
  const { cwd, root } = fixture(t);
  log(root, 'A1', 'codex', 'en curso\n', process.pid);
  fs.writeFileSync(path.join(root, 'log', 'A1-codex.log.exit'), '{');
  assert.equal(collectState(cwd).rows[0].state, 'running');
  let stdout = '';
  let stderr = '';
  const io = { stdout: { write: (s) => { stdout += s; }, isTTY: false }, stderr: { write: (s) => { stderr += s; } } };
  assert.equal(statusExit(['--cwd', cwd, '--json'], io), 0);
  assert.equal(JSON.parse(stdout).rows[0].state, 'running');
  assert.equal(statusExit(['--interval', '0'], io), 2);
  assert.match(stderr, /--interval/);
  stdout = '';
  assert.equal(statusExit(['--cwd', cwd, '--watch'], io), 0);
  assert.ok(!stdout.includes('\x1b'));
  assert.match(stderr, /stdout TTY/);
  const bin = path.join(__dirname, '..', 'bin', 'inharness.js');
  const result = spawnSync(process.execPath, [bin, 'status', '--cwd', cwd, '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).total, 1);
  const alias = spawnSync(process.execPath, [bin, 'watch', '--cwd', cwd, '--ascii'], { encoding: 'utf8' });
  assert.equal(alias.status, 0);
  assert.match(alias.stderr, /stdout TTY/);
});
