'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { boardExit, parseBoardArgs } = require('../src/board');
const { reportAgent } = require('../src/board/agents');

test('--once, --json, --screen, alias dashboard y --open sin WT', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'inharness-board-cli-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const root = path.join(cwd, '.inharness');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'assignment.md'), '| id | estado |\n| A | pendiente |');
  const bin = path.join(__dirname, '..', 'bin', 'inharness.js');
  const once = spawnSync(process.execPath, [bin, 'board', '--once', '--ascii', '--screen', 'plan', '--cwd', cwd], { encoding: 'utf8' });
  assert.equal(once.status, 0);
  assert.match(once.stdout, /LINEA DE TIEMPO/);
  assert.ok(!once.stdout.includes('\x1b[?1049h'));
  const json = spawnSync(process.execPath, [bin, 'dashboard', '--json', '--cwd', cwd], { encoding: 'utf8' });
  assert.equal(json.status, 0);
  assert.equal(JSON.parse(json.stdout).rows[0].id, 'A');
  const report = spawnSync(process.execPath, [bin, 'report', '--id', 'A', '--state', 'done', '--cwd', cwd], { encoding: 'utf8' });
  assert.equal(report.status, 0);
  assert.equal(JSON.parse(spawnSync(process.execPath, [bin, 'board', '--json', '--cwd', cwd], { encoding: 'utf8' }).stdout).rows[0].state, 'done');
  assert.throws(() => parseBoardArgs(['--screen', 'unknown']));
  if (process.platform !== 'win32') {
    let out = '';
    assert.equal(boardExit(['--open', '--cwd', cwd], { stdout: { write: (s) => { out += s; } }, stderr: { write() {} } }), 0);
    assert.match(out, /Abre otra terminal/);
  }
});
test('teclas d y t cambian completadas y periodo en el TUI', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'inharness-board-keys-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  reportAgent(cwd, { id: 'D', state: 'done', role: 'EXPANDIDA' });
  function session(screen) {
    let output = '';
    const stdin = new EventEmitter();
    stdin.isTTY = true;
    stdin.setRawMode = () => {};
    stdin.resume = () => {};
    stdin.pause = () => {};
    const stdout = { isTTY: true, columns: 120, rows: 40, write: (s) => { output += s; } };
    assert.equal(boardExit(['--cwd', cwd, '--screen', screen, '--no-color'], { stdin, stdout, stderr: { write() {} } }), 0);
    return { stdin, get output() { return output; } };
  }
  const agents = session('agentes');
  assert.doesNotMatch(agents.output, /EXPANDIDA/);
  agents.stdin.emit('data', Buffer.from('d'));
  assert.match(agents.output, /EXPANDIDA/);
  agents.stdin.emit('data', Buffer.from('q'));
  const plan = session('plan');
  assert.match(plan.output, /LINEA DE TIEMPO 12h/);
  plan.stdin.emit('data', Buffer.from('t'));
  assert.match(plan.output, /LINEA DE TIEMPO 1h/);
  plan.stdin.emit('data', Buffer.from('t'));
  assert.match(plan.output, /LINEA DE TIEMPO todo/);
  plan.stdin.emit('data', Buffer.from('q'));
});
