'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isRawInvocation, hasActiveRows, hasActiveDelegation, candidateDirs, shouldBlock, BLOCK_MESSAGE } = require('../src/guardLogic');

test('detecta invocaciones en posicion de comando, no menciones', () => {
  const yes = [
    'codex exec -', 'codex.cmd exec -m x -', 'codex e -',
    'cd x && codex.cmd exec -', 'FOO=1 kimi -m a -p "hola"',
    'C:/Users/U/AppData/Roaming/npm/codex.cmd exec -', 'echo hi | codex exec -',
    'env FOO=1 kimi --prompt hola',
  ];
  const no = [
    'git commit -m "codex exec"', 'grep "kimi -p" README.md', 'echo codex exec',
    'cat codex-exec-notes.md', 'codex --version', 'kimi --version',
    'node runRow.js launch --cli codex', 'node paneLauncher.js codex exec -',
    'INHARNESS_ALLOW_RAW=1 codex exec -',
  ];
  for (const command of yes) assert.equal(isRawInvocation(command), true, command);
  for (const command of no) assert.equal(isRawInvocation(command), false, command);
});

test('lee estado en varias tablas y columnas', () => {
  assert.equal(hasActiveRows('| id | estado |\n| --- | --- |\n| A | hecho, commit x |\n\n| estado | id |\n| --- | --- |\n| parcial | B |'), true);
  assert.equal(hasActiveRows('| estado | id |\n| --- | --- |\n| hecho | A |\n\n| id | estado |\n| --- | --- |\n| B | fallido |'), false);
  assert.equal(hasActiveRows('Texto en curso sin tabla'), false);
});

test('assignment viejo deja de bloquear', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inharness-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, '.inharness');
  fs.mkdirSync(dir);
  const assignment = path.join(dir, 'assignment.md');
  fs.writeFileSync(assignment, '| id | estado |\n| --- | --- |\n| R2 | en curso |\n');
  const now = Date.now();
  assert.equal(hasActiveDelegation(root, { now, staleMs: 1000 }), true);
  const old = new Date(now - 2000);
  fs.utimesSync(assignment, old, old);
  assert.equal(hasActiveDelegation(root, { now, staleMs: 1000 }), false);
  const previous = process.env.INHARNESS_STALE_HOURS;
  process.env.INHARNESS_STALE_HOURS = '0.0000001';
  try { assert.equal(hasActiveDelegation(root, { now }), false); } finally {
    if (previous === undefined) delete process.env.INHARNESS_STALE_HOURS;
    else process.env.INHARNESS_STALE_HOURS = previous;
  }
});

test('ambos hooks permiten, deniegan y sobreviven a errores', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inharness-hooks-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, '.inharness');
  fs.mkdirSync(dir);
  const assignment = path.join(dir, 'assignment.md');
  fs.writeFileSync(assignment, '| estado |\n| --- |\n| en curso |\n');
  for (const script of ['claudeGuardHook.js', 'codexPreToolUse.cjs']) {
    const scriptPath = path.join(__dirname, '..', 'src', script);
    const payload = { cwd: root, tool_name: 'Bash', hook_event_name: 'PreToolUse', tool_input: { command: 'codex exec -' } };
    const run = (input) => spawnSync(process.execPath, [scriptPath], { input, encoding: 'utf8' });
    const denied = run(JSON.stringify(payload));
    assert.equal(denied.status, 0, script);
    assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny', script);
    assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecisionReason, BLOCK_MESSAGE);
    const allowed = run(JSON.stringify({ ...payload, tool_input: { command: 'git status' } }));
    assert.equal(allowed.status, 0, script);
    assert.notEqual(allowed.stdout.includes('deny'), true, script);
    const invalid = run('{bad');
    assert.equal(invalid.status, 0, script);
    assert.match(invalid.stderr, /inharness hook error:/);
    fs.unlinkSync(assignment);
    fs.mkdirSync(assignment);
    const broken = run(JSON.stringify(payload));
    assert.equal(broken.status, 0, script);
    assert.match(broken.stderr, /inharness hook error:/);
    assert.notEqual(broken.stdout.includes('deny'), true, script);
    fs.rmdirSync(assignment);
    fs.writeFileSync(assignment, '| estado |\n| --- |\n| en curso |\n');
  }
});

test('detecta envoltorios, shells -c y flags globales de codex', () => {
  for (const command of [
    'npx codex exec -m a x', 'timeout 600 codex exec x', 'codex -m gpt-6 exec x',
    'bash -c "codex exec x"', 'powershell -Command "codex.ps1 exec x"', 'cmd /c codex exec x',
    'node /a/codex.js exec x', 'time codex e foo',
  ]) assert.equal(isRawInvocation(command), true, command);
  for (const command of ['codex --version', 'codex login', 'echo codex exec', 'bash -c "ls"', 'node script.js']) {
    assert.equal(isRawInvocation(command), false, command);
  }
});

test('reparto en texto libre (sin tabla) tambien cuenta como delegacion activa', () => {
  assert.equal(hasActiveRows('F1 claude HECHO\nF2 codex en curso\nF4 codex pendiente'), true);
  assert.equal(hasActiveRows('F1 claude HECHO\nF2 codex HECHO'), false);
});

test('regresion fte-manager: texto libre con filas sin estado, cwd padre y cd/-C', (t) => {
  const markdown = [
    '# Estado (2026-10-18)',
    'F1 claude  HECHO: proyecto enlazado',
    'F5 claude opus  PARCIAL: harness',
    'PENDIENTE (delegar via runRow en pestanas):',
    ' P1 cerrar las 33 diferencias de orden',
    ' P2 HECHO (claude): CAST',
  ].join('\n');
  assert.equal(hasActiveRows(markdown), true);
  assert.equal(hasActiveRows('F1 claude HECHO\nF2 codex hecho, commit x\nF3 kimi fallido'), false);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inharness-cand-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'proyecto');
  fs.mkdirSync(path.join(project, '.inharness'), { recursive: true });
  fs.mkdirSync(path.join(project, 'sub'));
  fs.writeFileSync(path.join(project, '.inharness', 'assignment.md'), markdown);
  const fwd = project.split(path.sep).join('/');
  const raw = 'codex.cmd exec -m gpt -c x=1 --sandbox workspace-write - < .inharness/prompts/P1.md > .inharness/log/P1-codex.log 2>&1';
  // El comando exacto que se colo: subshell en segundo plano, heredoc previo y cwd del proyecto.
  const exact = `mkdir -p .inharness/prompts && cat > .inharness/prompts/P1.md <<'EOF'\nprompt\nEOF\n(${raw}; echo $? > x) &\necho lanzado`;
  assert.equal(shouldBlock(exact, project), true);
  assert.equal(shouldBlock(raw, path.join(project, 'sub')), true, 'subcarpeta');
  assert.equal(shouldBlock(`cd "${fwd}" && ${raw}`, root), true, 'cd desde la carpeta padre');
  assert.equal(shouldBlock(`codex exec -C "${fwd}" -`, root), true, '-C');
  if (process.platform === 'win32') {
    const gitBash = fwd.replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
    assert.equal(shouldBlock(`cd ${gitBash} && ${raw}`, root), true, 'ruta Git Bash');
  }
  assert.equal(shouldBlock(raw, root), false, 'carpeta sin delegacion');
  assert.equal(shouldBlock(`node "$HOME/.inharness/runtime/runRow.js" launch --id P1 --cli codex --model m --prompt-file p.md`, project), false);
  assert.equal(shouldBlock(`cat > p.md <<'EOF'\nusa runRow\nEOF\n${raw}`, project), true, 'mencionar runRow no exime');
  assert.ok(candidateDirs(`cd "${fwd}" && codex exec -`, root).includes(path.resolve(project)));
});

test('el hook de Claude tambien cubre la herramienta PowerShell', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inharness-ps-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.inharness'));
  fs.writeFileSync(path.join(root, '.inharness', 'assignment.md'), 'P1 codex pendiente\n');
  const script = path.join(__dirname, '..', 'src', 'claudeGuardHook.js');
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8', input: JSON.stringify({
    cwd: root, tool_name: 'PowerShell', hook_event_name: 'PreToolUse', tool_input: { command: 'codex.cmd exec -m x -' },
  }) });
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
});
