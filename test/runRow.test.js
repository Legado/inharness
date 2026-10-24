'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const RUN_ROW = path.join(__dirname, '..', 'src', 'runRow.js');
const NASTY = 'linea 1 con "comillas" y \'simples\'; echo PWNED\nlinea 2 & %PATH% ^ | > <\n';

// CLI falso: vuelca argv y stdin en $FAKE_OUT. En Windows usa un shim con el formato de npm (que buildSpawn ejecuta sin cmd.exe).
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inharness-rr-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  const work = path.join(root, 'work');
  fs.mkdirSync(bin);
  fs.mkdirSync(work);
  fs.writeFileSync(path.join(bin, 'fake.js'), [
    "let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>s+=c);",
    "process.stdin.on('end',()=>{require('fs').writeFileSync(process.env.FAKE_OUT,JSON.stringify({argv:process.argv.slice(2),stdin:s}));",
    "process.stdout.write('hecho\\n');process.exitCode=+(process.env.FAKE_EXIT||0);});",
  ].join(''));
  for (const name of ['codex', 'kimi', 'claude']) {
    if (process.platform === 'win32') {
      fs.writeFileSync(path.join(bin, `${name}.cmd`), [
        '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0',
        'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"',
        '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
        'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\fake.js" %*',
      ].join('\r\n'));
    } else {
      const sh = path.join(bin, name);
      fs.writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${path.join(bin, 'fake.js')}" "$@"\n`);
      fs.chmodSync(sh, 0o755);
    }
  }
  const out = path.join(root, 'out.json');
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    INHARNESS_FORCE_FALLBACK: '1',
    FAKE_OUT: out,
  };
  const run = (args, extraEnv = {}) => {
    const r = spawnSync(process.execPath, [RUN_ROW, ...args], { cwd: work, env: { ...env, ...extraEnv }, encoding: 'utf8' });
    let json = null;
    try { json = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* sin JSON */ }
    return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
  };
  const prompt = (name, text) => {
    const file = path.join(work, name);
    fs.writeFileSync(file, text);
    return file;
  };
  const dump = () => JSON.parse(fs.readFileSync(out, 'utf8'));
  return { root, work, bin, env, run, prompt, dump };
}

test('ayuda y errores de uso devuelven 2 con mensaje en stderr', (t) => {
  const { run, prompt } = setup(t);
  assert.equal(run(['--help']).code, 0);
  assert.match(run(['--help']).stdout, /uso:/);
  const p = prompt('p.md', 'hola');
  const bad = [
    [[], /./],
    [['nada', '--id', '1', '--cli', 'codex'], /subcomando/],
    [['launch', '--cli', 'codex', '--model', 'm', '--prompt-file', p], /falta --id/],
    [['launch', '--id', '../x', '--cli', 'codex', '--model', 'm', '--prompt-file', p], /--id invalido/],
    [['launch', '--id', '-x', '--cli', 'codex', '--model', 'm', '--prompt-file', p], /--id invalido/],
    [['launch', '--id', 'a/b', '--cli', 'codex', '--model', 'm', '--prompt-file', p], /--id invalido/],
    [['launch', '--id', 'x'.repeat(65), '--cli', 'codex', '--model', 'm', '--prompt-file', p], /--id invalido/],
    [['launch', '--id', '1', '--cli', 'gemini', '--model', 'm', '--prompt-file', p], /--cli/],
    [['launch', '--id', '1', '--cli', 'codex', '--prompt-file', p], /falta --model/],
    [['launch', '--id', '1', '--cli', 'codex', '--model', '-x', '--prompt-file', p], /--model invalido/],
    [['launch', '--id', '1', '--cli', 'codex', '--model', 'm'], /falta --prompt-file/],
    [['launch', '--id', '1', '--cli', 'codex', '--model', 'm', '--prompt-file', 'no-existe.md'], /--prompt-file/],
    [['launch', '--id', '1', '--cli', 'codex', '--model', 'm', '--prompt-file', p, '--effort', 'enorme'], /--effort/],
    [['launch', '--id', '1', '--cli', 'codex', '--model', 'm', '--prompt-file', p, '--sandbox', 'danger-full-access'], /--sandbox/],
    [['launch', '--id', '1', '--cli', 'kimi', '--model', 'm', '--prompt-file', p, '--effort', 'high'], /solo vale para codex/],
    [['launch', '--id', '1', '--cli', 'codex', '--model', 'm', '--prompt-file', p, '--timeout-ms', '-5'], /--timeout-ms/],
    [['launch', '--id', '1', '--cli', 'codex', '--model', 'm', '--prompt-file', p, '--raro', 'x'], /desconocida/],
    [['launch', '--id', '1', '--cli', 'codex', '--model'], /falta el valor/],
    [['status', '--id', '1', '--cli', 'codex', '--cwd', path.join(p, 'nada')], /--cwd/],
  ];
  for (const [args, re] of bad) {
    const r = run(args);
    assert.equal(r.code, 2, `${args.join(' ')} -> ${r.code} ${r.stderr}`);
    if (args.length) assert.match(r.stderr, re);
  }
});

test('prompt vacio se rechaza', (t) => {
  const { run, prompt } = setup(t);
  const r = run(['launch', '--id', '1', '--cli', 'codex', '--model', 'm', '--prompt-file', prompt('v.md', '  \n')]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /vacio/);
});

test('codex: launch + wait + status; prompt con comillas, ; y saltos llega intacto por stdin', (t) => {
  const { run, prompt, dump, work } = setup(t);
  const p = prompt('3.md', NASTY);
  const l = run(['launch', '--id', '3', '--cli', 'codex', '--model', 'gpt-x', '--effort', 'high', '--prompt-file', p]);
  assert.equal(l.code, 0, l.stderr);
  assert.equal(l.json.mode, 'fallback');
  assert.equal(l.json.id, '3');
  assert.equal(l.json.log, path.join(work, '.inharness', 'log', '3-codex.log'));
  const d = dump();
  assert.equal(d.stdin, NASTY);
  assert.deepEqual(d.argv, ['exec', '-m', 'gpt-x', '-c', 'model_reasoning_effort=high', '--sandbox', 'workspace-write',
    '--skip-git-repo-check', '-C', work, '-', '--output-last-message', path.join(work, '.inharness', 'log', '3-codex-last.txt')]);
  assert.equal(fs.readFileSync(path.join(work, '.inharness', '.gitignore'), 'utf8'), '*\n');

  const s = run(['status', '--id', '3', '--cli', 'codex']);
  assert.deepEqual([s.code, s.json.state, s.json.exitCode], [0, 'done', 0]);
  const w = run(['wait', '--id', '3', '--cli', 'codex', '--timeout-ms', '5000']);
  assert.equal(w.code, 0);
  assert.equal(w.json.ok, true);
  assert.match(w.json.outputTail, /hecho/);
});

test('codex: sin --effort omite -c y --sandbox read-only se respeta', (t) => {
  const { run, prompt, dump } = setup(t);
  const l = run(['launch', '--id', 'a_b-1', '--cli', 'codex', '--model', 'm', '--sandbox', 'read-only', '--prompt-file', prompt('p.md', 'x')]);
  assert.equal(l.code, 0, l.stderr);
  const { argv } = dump();
  assert.ok(!argv.includes('-c'));
  assert.equal(argv[argv.indexOf('--sandbox') + 1], 'read-only');
});

test('claude: prompt por stdin y flags fijos, sin --bare', (t) => {
  const { run, prompt, dump, work } = setup(t);
  const l = run(['launch', '--id', '6', '--cli', 'claude', '--model', 'sonnet', '--prompt-file', prompt('6.md', NASTY)]);
  assert.equal(l.code, 0, l.stderr);
  const d = dump();
  assert.equal(d.stdin, NASTY);
  assert.deepEqual(d.argv, ['-p', '--model', 'sonnet', '--permission-mode', 'acceptEdits', '--add-dir', work]);
});

test('kimi: prompt corto llega como argumento intacto', (t) => {
  const { run, prompt, dump } = setup(t);
  // Sin saltos de linea ni %: un shim .cmd generico los rechazaria; el real de npm no pasa por cmd.exe.
  const text = 'hola "x" \'y\'; echo PWNED & ^ | > <';
  const l = run(['launch', '--id', '4', '--cli', 'kimi', '--model', 'kimi-for-coding', '--prompt-file', prompt('4.md', text)]);
  assert.equal(l.code, 0, l.stderr);
  assert.deepEqual(dump().argv, ['-m', 'kimi-code/kimi-for-coding', '-p', text]);
  assert.equal(dump().stdin, '');
});

test('kimi: prompt con saltos de linea y comillas llega intacto (shim npm, sin cmd.exe)', (t) => {
  const { run, prompt, dump } = setup(t);
  const l = run(['launch', '--id', '4', '--cli', 'kimi', '--model', 'k', '--prompt-file', prompt('4.md', NASTY)]);
  assert.equal(l.code, 0, l.stderr);
  assert.equal(dump().argv[3], NASTY);
});

test('kimi: prompt de mas de 20000 caracteres va como instruccion corta con la ruta del fichero', (t) => {
  const { run, prompt, dump } = setup(t);
  const l = run(['launch', '--id', '5', '--cli', 'kimi', '--model', 'k', '--prompt-file', prompt('grande.md', 'a'.repeat(20001))]);
  assert.equal(l.code, 0, l.stderr);
  assert.deepEqual(dump().argv, ['-m', 'kimi-code/k', '-p', 'Lee el fichero "grande.md" y ejecuta por completo su contenido']);
  const exact = run(['launch', '--id', '5', '--cli', 'kimi', '--model', 'k', '--prompt-file', prompt('justo.md', 'a'.repeat(20000))]);
  assert.equal(dump().argv[3].length, 20000, exact.stderr);
});

test('wait: fila fallida devuelve 1 con exitCode y cola del log; status sin log es unknown', (t) => {
  const { run, prompt } = setup(t);
  assert.equal(run(['status', '--id', '9', '--cli', 'kimi']).json.state, 'unknown');
  run(['launch', '--id', '9', '--cli', 'kimi', '--model', 'k', '--prompt-file', prompt('p.md', 'x')], { FAKE_EXIT: '3' });
  const w = run(['wait', '--id', '9', '--cli', 'kimi', '--timeout-ms', '5000']);
  assert.equal(w.code, 1);
  assert.equal(w.json.ok, false);
  assert.equal(w.json.exitCode, 3);
  assert.equal(run(['status', '--id', '9', '--cli', 'kimi']).json.exitCode, 3);
});

test('wait: timeout sin fichero de fin devuelve timedOut y 1; status de log recien creado es running', (t) => {
  const { run, work } = setup(t);
  const log = path.join(work, '.inharness', 'log', '7-codex.log');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, '');
  assert.equal(run(['status', '--id', '7', '--cli', 'codex']).json.state, 'running');
  const w = run(['wait', '--id', '7', '--cli', 'codex', '--timeout-ms', '300']);
  assert.equal(w.code, 1);
  assert.equal(w.json.timedOut, true);
});

test('status: helper muerto sin .exit es aborted; .exit con aborted tambien', (t) => {
  const { run, work } = setup(t);
  const log = path.join(work, '.inharness', 'log', '8-codex.log');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, '');
  fs.writeFileSync(`${log}.pid`, '2147483646');
  assert.equal(run(['status', '--id', '8', '--cli', 'codex']).json.state, 'aborted');
  fs.writeFileSync(`${log}.exit`, JSON.stringify({ exitCode: null, aborted: true }));
  assert.equal(run(['status', '--id', '8', '--cli', 'codex']).json.state, 'aborted');
});

test('rechaza flags repetidos, vacios, ids raros y opciones ignoradas por subcomando', (t) => {
  const { run, prompt } = setup(t);
  const launch = ['launch', '--id', '1', '--cli', 'codex', '--model', 'm', '--prompt-file', prompt('p.md', 'hola')];
  for (const args of [
    [...launch, '--id', '2'], [...launch, '--title', ''],
    ['status', '--id', '', '--cli', 'codex'], ['status', '--id', '..', '--cli', 'codex'],
    ['status', '--id', 'ñ', '--cli', 'codex'], ['status', '--id', '1', '--cli', 'codex', '--model', '-x'],
    ['status', '--id', '1', '--cli', 'codex', '--timeout-ms', '1'],
    ['wait', '--id', '1', '--cli', 'codex', '--sandbox', 'x'],
    [...launch, '--timeout-ms', '2147483648'],
    [...launch.slice(0, 6), '', '--prompt-file', 'p.md'],
  ]) assert.equal(run(args).code, 2, JSON.stringify(args));
  for (const cli of ['codex', 'kimi', 'claude']) {
    assert.equal(run(['launch', '--id', '1', '--cli', cli, '--model', '--help', '--prompt-file', 'p.md']).code, 2);
  }
});

test('rutas de salida last-message y sidecars no siguen enlaces, ni siquiera rotos', (t) => {
  const { run, prompt, work, root } = setup(t);
  const dir = path.join(work, '.inharness', 'log');
  fs.mkdirSync(dir, { recursive: true });
  const outside = path.join(root, 'target');
  const p = prompt('p.md', 'hola');
  for (const suffix of ['1-codex-last.txt', '1-codex.log.exit', '1-codex.log.pid']) {
    const link = path.join(dir, suffix);
    if (process.platform === 'win32') fs.mkdirSync(outside);
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'file');
    if (process.platform === 'win32') fs.rmdirSync(outside);
    const r = run(['launch', '--id', '1', '--cli', 'codex', '--model', 'm', '--prompt-file', p]);
    assert.equal(r.code, 2, r.stderr);
    assert.equal(fs.existsSync(outside), false);
    fs.unlinkSync(link);
  }
});

test('un helper real vivo impide un segundo launch y devuelve EBUSY como error de uso', async (t) => {
  const { run, prompt, work, env } = setup(t);
  const log = path.join(work, '.inharness', 'log', '1-codex.log');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const job = path.join(work, 'job.json');
  fs.writeFileSync(job, JSON.stringify({ command: process.execPath, args: ['-e', 'setTimeout(()=>{},1500)'],
    cwd: work, input: 'hola', logFile: log, timeoutMs: 5000 }));
  const helper = spawn(process.execPath, [path.join(path.dirname(RUN_ROW), 'paneLauncher.js'), '--inharness-job', job],
    { cwd: work, env: { ...env, INHARNESS_PANE_LINGER_MS: '0' }, stdio: 'ignore' });
  const closed = new Promise((resolve, reject) => { helper.once('error', reject); helper.once('close', resolve); });
  t.after(async () => { if (helper.exitCode === null) helper.kill(); await closed; });
  const until = Date.now() + 3000;
  while (!fs.existsSync(`${log}.pid`) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fs.existsSync(`${log}.pid`), true);
  const r = run(['launch', '--id', '1', '--cli', 'codex', '--model', 'm', '--prompt-file', prompt('p.md', 'hola')]);
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /ejecucion viva/);
  assert.equal(await closed, 0);
});

test('cwd explicito y enlace interno del prompt funcionan; title queda como dato', (t) => {
  const { run, prompt, dump, work } = setup(t);
  const p = prompt('p.md', NASTY);
  const sub = path.join(work, 'sub');
  fs.mkdirSync(sub);
  fs.symlinkSync(work, path.join(sub, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  const r = run(['launch', '--id', 'x'.repeat(64), '--cli', 'codex', '--model', 'm', '--cwd', work,
    '--prompt-file', 'sub/link/p.md', '--title', '; echo PWNED & %PATH%\n']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim().split('\n').length, 1);
  assert.equal(dump().stdin, NASTY);
  assert.equal(dump().argv.includes(p), false);
});

test('runRow rechaza batch generico antes de pasar valores a cmd.exe', { skip: process.platform !== 'win32' }, (t) => {
  const { run, prompt, bin, work } = setup(t);
  fs.writeFileSync(path.join(bin, 'kimi.cmd'), '@echo off\r\necho PWNED > marker\r\n');
  const r = run(['launch', '--id', '1', '--cli', 'kimi', '--model', 'k', '--prompt-file', prompt('p.md', 'x&ver')]);
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /cmd.exe/);
  assert.equal(fs.existsSync(path.join(work, 'marker')), false);
});

test('wait: JSON completo, cola de 4000, aborto y errores de arranque visibles', (t) => {
  const { run, work, env, prompt } = setup(t);
  const log = path.join(work, '.inharness', 'log', '1-codex.log');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, 'x'.repeat(5000));
  fs.writeFileSync(`${log}.exit`, JSON.stringify({ aborted: true, exitCode: null, signal: 'SIGTERM', error: 'cerrado' }));
  const r = run(['wait', '--id', '1', '--cli', 'codex']);
  assert.equal(r.code, 1);
  assert.deepEqual(r.json, { id: '1', cli: 'codex', ok: false, exitCode: null, aborted: true, timedOut: false,
    error: 'cerrado', outputTail: 'x'.repeat(4000) });
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path');
  const l = run(['launch', '--id', '2', '--cli', 'codex', '--model', 'm', '--prompt-file', prompt('p.md', 'x')], { [pathKey]: '' });
  assert.equal(l.code, 0, l.stderr);
  const w = run(['wait', '--id', '2', '--cli', 'codex']);
  assert.equal(w.code, 1);
  assert.equal(w.json.exitCode, 127);
  assert.match(w.json.error, /ejecutable|ENOENT/);
  assert.match(w.json.outputTail, /no se pudo arrancar/);
});

test('recetas de las tres skills: launch, wait y status invocables en fallback', (t) => {
  const { run, prompt, work } = setup(t);
  fs.mkdirSync(path.join(work, '.inharness', 'prompts'), { recursive: true });
  prompt('.inharness/prompts/3.md', NASTY);
  let guard;
  for (const name of ['claude/SKILL.md', 'codex/SKILL.md', 'kimi/inharness.md']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'skills', name), 'utf8');
    assert.doesNotMatch(source, /npm root -g|node -e|paneLauncher/);
    if (!name.startsWith('claude')) assert.doesNotMatch(source, /[^\x00-\x7f]/);
    assert.match(source, /Busca primero paralelismo real/);
    const block = source.match(/\*\*Guardarrail tecnico:\*\*[\s\S]*?Kimi no tiene hooks\./)[0];
    if (guard) assert.equal(block, guard);
    guard = block;
    const lines = source.split(/\r?\n/).filter(line => line.startsWith('node "$HOME/.inharness/runtime/runRow.js"'));
    assert.equal(lines.length, 6, name);
    for (const line of lines) {
      const args = line.slice('node "$HOME/.inharness/runtime/runRow.js" '.length).split(/\s+/);
      const r = run(args);
      assert.equal(r.code, 0, `${name}: ${line}: ${r.stderr}`);
      assert.equal(r.stdout.trim().split('\n').length, 1);
      assert.ok(r.json);
    }
  }
});

test('prompt: rechaza binarios, UTF-8 invalido, directorios y ficheros enormes', (t) => {
  const { run, prompt, work } = setup(t);
  for (const file of [prompt('nul.md', 'a\0b'), prompt('invalid.md', Buffer.from([0xc3, 0x28])),
    prompt('binary.md', Buffer.from([1, 2, 3])), prompt('big.md', 'a'.repeat(1024 * 1024 + 1)), work]) {
    const r = run(['launch', '--id', '1', '--cli', 'codex', '--model', 'm', '--prompt-file', file]);
    assert.equal(r.code, 2, `${file}: ${r.stderr}`);
  }
});

test('rutas externas y junctions no permiten leer prompts ni estado ni escribir last-message fuera de cwd', (t) => {
  const { run, prompt, work, root } = setup(t);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  const secret = path.join(outside, 'secret.md');
  fs.writeFileSync(secret, 'secreto');
  const args = ['launch', '--id', '1', '--cli', 'codex', '--model', 'm', '--prompt-file'];
  assert.equal(run([...args, secret]).code, 2);
  const link = path.join(work, 'linked');
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(run([...args, path.join(link, 'secret.md')]).code, 2);
  const p = prompt('p.md', 'hola');
  const state = path.join(work, '.inharness');
  fs.symlinkSync(outside, state, process.platform === 'win32' ? 'junction' : 'dir');
  for (const cmd of ['wait', 'status']) assert.equal(run([cmd, '--id', '1', '--cli', 'codex']).code, 2);
  assert.equal(run([...args, p]).code, 2);
  assert.deepEqual(fs.readdirSync(outside), ['secret.md']);
});

test('EBUSY devuelve 2 sin truncar el log de la primera ejecucion', (t) => {
  const { run, prompt, work } = setup(t);
  const log = path.join(work, '.inharness', 'log', '1-codex.log');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, 'primera fila');
  fs.writeFileSync(`${log}.pid`, String(process.pid));
  const r = run(['launch', '--id', '1', '--cli', 'codex', '--model', 'm', '--prompt-file', prompt('p.md', 'hola')]);
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /ejecucion viva/);
  assert.equal(fs.readFileSync(log, 'utf8'), 'primera fila');
});

test('Kimi: 20000 comillas exceden CreateProcess y usan la ruta citada sin ejecutar su contenido', (t) => {
  const { run, prompt, dump } = setup(t);
  const file = prompt('lee; esto & %PATH%.md', '"'.repeat(20000));
  const r = run(['launch', '--id', '1', '--cli', 'kimi', '--model', 'k', '--prompt-file', file]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(dump().argv[3], 'Lee el fichero "lee; esto & %PATH%.md" y ejecuta por completo su contenido');
});

test('fallback nunca es silencioso: visible false y aviso en stderr y JSON', (t) => {
  const { run, prompt } = setup(t);
  const r = run(['launch', '--id', '1', '--cli', 'codex', '--model', 'm', '--prompt-file', prompt('p.md', 'hola')]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.mode, 'fallback');
  assert.equal(r.json.visible, false);
  assert.match(r.json.warning, /SIN VENTANA.*INHARNESS_FORCE_FALLBACK/);
  assert.match(r.stderr, /\[inharness\] AVISO: SIN VENTANA/);
});
