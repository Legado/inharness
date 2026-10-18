'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const Module = require('node:module');
const { spawnSync, spawn } = require('node:child_process');
const pl = require('../src/paneLauncher');

const HELPER = path.join(__dirname, '..', 'src', 'paneLauncher.js');
const LIVE = process.env.INHARNESS_LIVE_WT === '1';
const CORPUS = ['a;b', '"comillas"', "'simples'", 'x&echo PWNED>PWNED', '%PATH%', 'a^b', '!x!', 'termina\\',
  'ñ 日本 😀', 'l1\nl2\r\nl3', '', ' ; '];
const INPUT = 'primera;linea\nsegunda "x" & %PATH%\n;\n';

function workdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inharness-pl;test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dump = path.join(dir, 'dump.js');
  fs.writeFileSync(dump, [
    "let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>s+=c);",
    "process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({argv:process.argv.slice(2),stdin:s,cwd:process.cwd()})+'\\n');",
    "process.stderr.write('ERR\\n');if(process.env.DUMP_SLEEP)setTimeout(()=>{},+process.env.DUMP_SLEEP);process.exitCode=+(process.env.DUMP_EXIT||0);});",
  ].join(''));
  return { dir, dump };
}

function withEnv(t, vars) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });
}

const dumpLine = (out) => JSON.parse(out.split('\n').find((l) => l.startsWith('{"argv"')));
const readExit = (log) => JSON.parse(fs.readFileSync(`${log}.exit`, 'utf8'));

test('valida la entrada con errores claros', (t) => {
  const { dir } = workdir(t);
  const base = { command: process.execPath, cwd: dir, logFile: 'x.log' };
  const bad = [
    [{ ...base, command: '' }, /command/],
    [{ ...base, command: 'a\0b' }, /command/],
    [{ ...base, args: 'x' }, /args/],
    [{ ...base, args: ['ok', 'a\0'] }, /args/],
    [{ ...base, args: [1] }, /args/],
    [{ ...base, cwd: path.join(dir, 'no-existe') }, /cwd/],
    [{ ...base, cwd: path.join(dir, 'dump.js') }, /cwd/],
    [{ ...base, input: Buffer.from('x') }, /input/],
    [{ ...base, timeoutMs: -1 }, /timeoutMs/],
    [{ ...base, logFile: '' }, /logFile/],
  ];
  for (const [opts, message] of bad) assert.throws(() => pl.launchInPane(opts), { message });
  for (const logFile of ['../fuera.log', path.join(os.tmpdir(), 'fuera.log'), '.', 'sub/../../fuera.log']) {
    assert.throws(() => pl.launchInPane({ ...base, logFile }), { code: 'EBADLOG' });
  }
  assert.throws(() => pl.launchInPane(), { message: /command/ });
});

test('un enlace dentro de cwd no saca el log fuera', (t) => {
  const { dir } = workdir(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'inharness-pl-out-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(dir, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => pl.launchInPane({ command: process.execPath, cwd: dir, logFile: 'link/x.log' }), { code: 'EBADLOG' });
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('fallback: corpus intacto, .gitignore en .inharness y sin restos de una ejecucion anterior', (t) => {
  const { dir, dump } = workdir(t);
  withEnv(t, { INHARNESS_FORCE_FALLBACK: '1' });
  const log = path.join(dir, '.inharness', 'log', 'f.log');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, 'VIEJO');
  fs.writeFileSync(`${log}.exit`, '{"exitCode":99}');
  fs.writeFileSync(`${log}.pid`, '1');
  const r = pl.launchInPane({ command: process.execPath, args: [dump, ...CORPUS], cwd: dir, input: INPUT, logFile: '.inharness/log/f.log' });
  assert.deepEqual(r, { mode: 'fallback', pid: null, logFile: log, exitFile: `${log}.exit`, reason: 'INHARNESS_FORCE_FALLBACK=1' });
  assert.equal(fs.readFileSync(path.join(dir, '.inharness', '.gitignore'), 'utf8'), '*\n');
  assert.equal(fs.existsSync(`${log}.pid`), false);
  const got = dumpLine(fs.readFileSync(log, 'utf8'));
  assert.deepEqual(got.argv, CORPUS);
  assert.equal(got.stdin, INPUT);
  assert.equal(fs.realpathSync(got.cwd), fs.realpathSync(dir));
  assert.match(fs.readFileSync(log, 'utf8'), /ERR\n$/);
  assert.doesNotMatch(fs.readFileSync(log, 'utf8'), /VIEJO/);
  const exit = readExit(log);
  assert.equal(exit.exitCode, 0);
  assert.equal(exit.aborted, false);
  assert.ok(exit.startedAt && exit.finishedAt);
  assert.equal(fs.existsSync(path.join(dir, 'PWNED')), false);
});

test('fallback: no pisa un .gitignore existente y reporta codigo, 127 y timeout', async (t) => {
  const { dir, dump } = workdir(t);
  withEnv(t, { INHARNESS_FORCE_FALLBACK: '1', DUMP_EXIT: '3', DUMP_SLEEP: undefined });
  fs.mkdirSync(path.join(dir, '.inharness'));
  fs.writeFileSync(path.join(dir, '.inharness', '.gitignore'), 'propio\n');
  pl.launchInPane({ command: process.execPath, args: [dump], cwd: dir, logFile: '.inharness/c.log' });
  assert.equal(fs.readFileSync(path.join(dir, '.inharness', '.gitignore'), 'utf8'), 'propio\n');
  let w = await pl.waitForCompletion('.inharness/c.log', { cwd: dir, pollMs: 10 });
  assert.equal(w.ok, false);
  assert.equal(w.exitCode, 3);

  pl.launchInPane({ command: 'inharness-no-existe-' + crypto.randomBytes(4).toString('hex'), cwd: dir, logFile: 'm.log' });
  w = await pl.waitForCompletion(path.join(dir, 'm.log'), { pollMs: 10 });
  assert.equal(w.exitCode, 127);
  assert.match(w.error, /No se encontro/);
  assert.match(w.output, /\[inharness\] no se pudo arrancar/);

  process.env.DUMP_SLEEP = '30000';
  process.env.DUMP_EXIT = '0';
  pl.launchInPane({ command: process.execPath, args: [dump], cwd: dir, logFile: 't.log', timeoutMs: 500 });
  w = await pl.waitForCompletion(path.join(dir, 't.log'), { pollMs: 10 });
  assert.equal(w.ok, false);
  assert.equal(w.aborted, true);
  assert.match(w.error, /tiempo agotado/);
});

function writeJob(job) {
  const dir = path.join(os.tmpdir(), 'inharness-jobs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${crypto.randomBytes(16).toString('hex')}.json`);
  fs.writeFileSync(file, JSON.stringify(job));
  return file;
}

function runHelper(jobFile, env = {}) {
  return spawnSync(process.execPath, [HELPER, '--inharness-job', jobFile], {
    encoding: 'utf8', windowsHide: true, timeout: 30000, env: { ...process.env, INHARNESS_PANE_LINGER_MS: '0', DUMP_EXIT: '0', DUMP_SLEEP: '', ...env },
  });
}

test('helper: borra el job, escribe .pid, log, consola y .exit atomico', (t) => {
  const { dir, dump } = workdir(t);
  const log = path.join(dir, 'h.log');
  const job = writeJob({ command: process.execPath, args: [dump, ...CORPUS], cwd: dir, input: INPUT, logFile: log, title: 'prueba' });
  const res = runHelper(job);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(fs.existsSync(job), false);
  assert.match(res.stdout, /^\[inharness\] prueba\n/);
  const got = dumpLine(fs.readFileSync(log, 'utf8'));
  assert.deepEqual(got.argv, CORPUS);
  assert.equal(got.stdin, INPUT);
  assert.equal(fs.realpathSync(got.cwd), fs.realpathSync(dir));
  assert.match(res.stdout, /"argv"/);
  assert.equal(Number(fs.readFileSync(`${log}.pid`, 'utf8')) > 0, true);
  const exit = readExit(log);
  assert.equal(exit.exitCode, 0);
  assert.equal(exit.aborted, false);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
});

test('helper: codigo de salida, comando inexistente (127) y timeout', (t) => {
  const { dir, dump } = workdir(t);
  let log = path.join(dir, 'e.log');
  let res = runHelper(writeJob({ command: process.execPath, args: [dump], cwd: dir, input: null, logFile: log }), { DUMP_EXIT: '5' });
  assert.equal(res.status, 5);
  assert.equal(readExit(log).exitCode, 5);

  log = path.join(dir, 'n.log');
  res = runHelper(writeJob({ command: 'inharness-no-existe-zz', args: [], cwd: dir, logFile: log }));
  assert.equal(readExit(log).exitCode, 127);
  assert.match(readExit(log).error, /No se encontro/);
  assert.match(fs.readFileSync(log, 'utf8'), /no se pudo arrancar inharness-no-existe-zz/);
  assert.match(res.stderr, /no se pudo arrancar/);

  log = path.join(dir, 's.log');
  runHelper(writeJob({ command: process.execPath, args: [dump], cwd: dir, logFile: log, timeoutMs: 500 }), { DUMP_SLEEP: '30000' });
  const exit = readExit(log);
  assert.equal(exit.aborted, true);
  assert.match(exit.error, /tiempo agotado/);
});

test('helper: job invalido o inexistente falla con mensaje y sin colgarse', (t) => {
  const { dir } = workdir(t);
  const job = writeJob({ command: 1 });
  let res = runHelper(job);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /no se pudo ejecutar el job/);
  assert.equal(fs.existsSync(job), false);
  res = runHelper(path.join(dir, 'no-existe.json'));
  assert.notEqual(res.status, 0);
});

test('helper POSIX: SIGTERM mata al hijo y deja .exit con aborted', { skip: process.platform === 'win32' }, async (t) => {
  const { dir, dump } = workdir(t);
  const log = path.join(dir, 'k.log');
  const job = writeJob({ command: process.execPath, args: [dump], cwd: dir, logFile: log });
  const child = spawn(process.execPath, [HELPER, '--inharness-job', job], { env: { ...process.env, DUMP_SLEEP: '30000' }, stdio: 'ignore' });
  while (!fs.existsSync(`${log}.pid`)) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 300));
  child.kill('SIGTERM');
  await new Promise((r) => child.on('close', r));
  const exit = readExit(log);
  assert.equal(exit.aborted, true);
  assert.equal(exit.signal, 'SIGTERM');
});

test('waitForCompletion: proceso muerto sin .exit -> aborted en pocos sondeos', async (t) => {
  const { dir } = workdir(t);
  const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  fs.writeFileSync(path.join(dir, 'd.log'), 'parcial');
  fs.writeFileSync(path.join(dir, 'd.log.pid'), gone.stdout);
  const t0 = Date.now();
  const w = await pl.waitForCompletion('d.log', { cwd: dir, pollMs: 50, timeoutMs: 10000 });
  assert.equal(w.aborted, true);
  assert.equal(w.ok, false);
  assert.equal(w.timedOut, false);
  assert.equal(w.output, 'parcial');
  assert.ok(Date.now() - t0 < 2000);
});

test('waitForCompletion: proceso vivo sin .exit espera hasta timeout; sin helper corta por startTimeoutMs', async (t) => {
  const { dir } = workdir(t);
  fs.writeFileSync(path.join(dir, 'v.log.pid'), String(process.pid));
  let w = await pl.waitForCompletion(path.join(dir, 'v.log'), { pollMs: 20, timeoutMs: 200 });
  assert.equal(w.timedOut, true);
  assert.equal(w.aborted, false);
  w = await pl.waitForCompletion(path.join(dir, 'nada.log'), { pollMs: 20, timeoutMs: 5000, startTimeoutMs: 100 });
  assert.equal(w.aborted, true);
  assert.match(w.error, /no arranco/);
  w = await pl.waitForCompletion(path.join(dir, 'nada.log'), { pollMs: 20, timeoutMs: 100, startTimeoutMs: 0 });
  assert.equal(w.timedOut, true);
});

test('waitForCompletion: recorta la salida a 1.000.000 caracteres', async (t) => {
  const { dir } = workdir(t);
  const log = path.join(dir, 'big.log');
  fs.writeFileSync(log, 'ñ'.repeat(1500000) + 'FIN');
  fs.writeFileSync(`${log}.exit`, JSON.stringify({ exitCode: 0, aborted: false }));
  const w = await pl.waitForCompletion(log);
  assert.equal(w.ok, true);
  assert.equal(w.outputTruncated, true);
  assert.equal(w.output.length, 1000000);
  assert.ok(w.output.endsWith('ñFIN'));
  fs.writeFileSync(log, 'corto');
  assert.deepEqual((await pl.waitForCompletion(log)).outputTruncated, false);
  await assert.rejects(pl.waitForCompletion(''), /logFile/);
});

test('EBUSY protege tambien un PID vivo antiguo; permite un resultado terminado o un PID muerto', (t) => {
  const { dir } = workdir(t);
  withEnv(t, { INHARNESS_FORCE_FALLBACK: '1' });
  const opts = { command: process.execPath, args: ['-e', '0'], cwd: dir, logFile: 'busy.log' };
  const log = path.join(dir, 'busy.log');

  fs.writeFileSync(`${log}.pid`, String(process.pid));
  assert.throws(() => pl.launchInPane(opts), { code: 'EBUSY' });

  fs.writeFileSync(`${log}.exit`, '{"exitCode":0}');
  assert.equal(pl.launchInPane(opts).mode, 'fallback');

  fs.writeFileSync(`${log}.pid`, String(process.pid));
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  fs.rmSync(`${log}.exit`, { force: true });
  fs.utimesSync(`${log}.pid`, old, old);
  assert.throws(() => pl.launchInPane(opts), { code: 'EBUSY' });
  const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  assert.equal(gone.status, 0);
  fs.writeFileSync(`${log}.pid`, gone.stdout);
  fs.utimesSync(`${log}.pid`, old, old);
  assert.equal(pl.launchInPane(opts).mode, 'fallback');
});

test('deteccion de Windows Terminal', (t) => {
  assert.equal(typeof pl.hasWindowsTerminal(), 'boolean');
  if (process.platform !== 'win32') assert.equal(pl.hasWindowsTerminal(), false);
  withEnv(t, { WT_SESSION: 'x' });
  assert.equal(pl.insideWindowsTerminal(), true);
  delete process.env.WT_SESSION;
  assert.equal(pl.insideWindowsTerminal(), false);
});

test('fallback: admite nombres con prefijo .. y autoignora el propio cwd .inharness', (t) => {
  const { dir } = workdir(t);
  withEnv(t, { INHARNESS_FORCE_FALLBACK: '1' });
  const opts = { command: process.execPath, args: ['-e', '0'], cwd: dir, logFile: '..valid/x.log' };
  assert.equal(pl.launchInPane(opts).mode, 'fallback');
  const cwd = path.join(dir, '.inharness');
  fs.mkdirSync(cwd);
  pl.launchInPane({ ...opts, cwd, logFile: 'x.log' });
  assert.equal(fs.readFileSync(path.join(cwd, '.gitignore'), 'utf8'), '*\n');
  if (process.platform === 'win32') {
    pl.launchInPane({ ...opts, cwd, logFile: path.join(cwd.toUpperCase(), 'case.log') });
    assert.equal(readExit(path.join(cwd, 'case.log')).exitCode, 0);
  }
});

test('waitForCompletion: el recorte no parte un par UTF-16', async (t) => {
  const { dir } = workdir(t);
  const log = path.join(dir, 'emoji.log');
  fs.writeFileSync(log, '\u{1f600}'.repeat(500000) + 'X');
  fs.writeFileSync(`${log}.exit`, '{"exitCode":0}');
  const w = await pl.waitForCompletion(log);
  assert.equal(w.outputTruncated, true);
  assert.ok(w.output.length <= 1000000);
  assert.equal(w.output.length, 999999);
  assert.equal(w.output.codePointAt(0), 0x1f600);
  assert.ok(w.output.endsWith('\u{1f600}X'));
});

test('helper: un segundo job no trunca el log ni pisa el resultado del primero', async (t) => {
  const { dir } = workdir(t);
  const log = path.join(dir, 'shared.log');
  const ready = path.join(dir, 'ready');
  const release = path.join(dir, 'release');
  const code = "const fs=require('node:fs');console.log('FIRST');fs.writeFileSync('ready','');"
    + "const timer=setInterval(()=>{if(fs.existsSync('release')){clearInterval(timer);console.log('FIRST-END');}},10);";
  const child = spawn(process.execPath, [HELPER, '--inharness-job', writeJob({
    command: process.execPath, args: ['-e', code], cwd: dir, logFile: log,
  })], { env: { ...process.env, INHARNESS_PANE_LINGER_MS: '0' }, stdio: 'ignore', windowsHide: true });
  const done = new Promise((resolve) => child.on('close', resolve));
  t.after(() => { if (child.exitCode === null) child.kill(); });
  try {
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.ok(fs.existsSync(ready), 'el primer hijo debe arrancar');
    const pid = fs.readFileSync(`${log}.pid`, 'utf8');
    const res = runHelper(writeJob({
      command: process.execPath, args: ['-e', "console.log('SECOND');process.exitCode=7"], cwd: dir, logFile: log,
    }));
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /EBUSY/);
    assert.equal(fs.readFileSync(`${log}.pid`, 'utf8'), pid);
    assert.equal(fs.existsSync(`${log}.exit`), false);
  } finally {
    fs.writeFileSync(release, '');
    await done;
  }
  assert.equal(fs.readFileSync(log, 'utf8'), 'FIRST\nFIRST-END\n');
  assert.equal(readExit(log).exitCode, 0);
});

test('helper: rechaza un log que escapa por junction antes de escribir sidecars', (t) => {
  const { dir } = workdir(t);
  const cwd = path.join(dir, 'project');
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(cwd);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(cwd, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  const res = runHelper(writeJob({
    command: process.execPath, args: ['-e', "console.log('OUTSIDE')"], cwd, logFile: path.join(cwd, 'link', 'x.log'),
  }));
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /logFile debe quedar dentro/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

function isolatedLauncher(overrides) {
  const mod = { exports: {} };
  const localRequire = Module.createRequire(HELPER);
  const wrapper = vm.runInThisContext(Module.wrap(fs.readFileSync(HELPER, 'utf8')), { filename: HELPER });
  wrapper(mod.exports, (id) => overrides[id] || localRequire(id), mod, HELPER, path.dirname(HELPER));
  return mod.exports;
}

test('un fallo al escribir el job no deja el prompt temporal abandonado', { skip: process.platform !== 'win32' }, (t) => {
  const { dir } = workdir(t);
  withEnv(t, { INHARNESS_FORCE_FALLBACK: undefined });
  let failed = false;
  const mockedFs = Object.create(fs);
  mockedFs.writeSync = (fd, data, ...rest) => {
    if (!failed && typeof data === 'string' && data.includes('PRIVATE-PROMPT')) {
      failed = true;
      fs.writeSync(fd, data.slice(0, -1));
      throw Object.assign(new Error('disco lleno'), { code: 'ENOSPC' });
    }
    return fs.writeSync(fd, data, ...rest);
  };
  mockedFs.writeFileSync = (file, data, ...rest) => {
    if (typeof file === 'number' && typeof data === 'string' && data.includes('PRIVATE-PROMPT')) {
      return mockedFs.writeSync(file, data);
    }
    return fs.writeFileSync(file, data, ...rest);
  };
  const launcher = isolatedLauncher({
    'node:fs': mockedFs,
    'node:os': { tmpdir: () => dir },
    './resolveExe': { resolveExecutable: () => process.execPath },
  });
  const result = launcher.launchInPane({ command: process.execPath, args: ['-e', '0'], cwd: dir, logFile: 'x.log', input: 'PRIVATE-PROMPT' });
  assert.equal(failed, true);
  assert.equal(result.mode, 'fallback');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'inharness-jobs')), []);
});

test('waitForCompletion: un .pid corrupto tampoco anula startTimeoutMs', async (t) => {
  const { dir } = workdir(t);
  const log = path.join(dir, 'bad-pid.log');
  for (const value of ['', 'not-a-pid', '999999999999999999999999']) {
    fs.writeFileSync(`${log}.pid`, value);
    const result = await pl.waitForCompletion(log, { pollMs: 10, startTimeoutMs: 30, timeoutMs: 150 });
    assert.equal(result.aborted, true, JSON.stringify({ value, result }));
    assert.equal(result.timedOut, false);
    assert.match(result.error, /no arranco/);
  }
});

test('helper Windows: si taskkill falla, mata al hijo antes del linger', { skip: process.platform !== 'win32' }, async (t) => {
  const { dir } = workdir(t);
  const preload = path.join(dir, 'preload.cjs');
  fs.writeFileSync(preload,
    `const r=require(${JSON.stringify(path.join(__dirname, '..', 'src', 'resolveExe.js'))});`
    + "const old=r.resolveExecutable;r.resolveExecutable=(n,...a)=>n==='taskkill.exe'?process.execPath:old(n,...a);"
    + "const cp=require('node:child_process');const oldSync=cp.spawnSync;"
    + "cp.spawnSync=(f,a,o)=>a[0]==='/T'?{status:1}:oldSync(f,a,o);");
  const log = path.join(dir, 'kill.log');
  const pidFile = path.join(dir, 'child.pid');
  const job = writeJob({ command: process.execPath, cwd: dir, logFile: log, timeoutMs: 500,
    args: ['-e', "require('node:fs').writeFileSync('child.pid',String(process.pid));setTimeout(()=>{},30000)"],
  });
  const helper = spawn(process.execPath, ['-r', preload, HELPER, '--inharness-job', job], {
    env: { ...process.env, INHARNESS_PANE_LINGER_MS: '500' }, stdio: 'ignore', windowsHide: true,
  });
  const done = new Promise((resolve) => helper.on('close', resolve));
  let pid;
  try {
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(`${log}.exit`) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    assert.ok(fs.existsSync(`${log}.exit`));
    assert.equal(helper.exitCode, null, 'la comprobacion debe ocurrir durante linger');
    assert.equal(readExit(log).aborted, true);
    pid = Number(fs.readFileSync(pidFile, 'utf8'));
    const stoppedBy = Date.now() + 200;
    let alive = true;
    while (alive && Date.now() < stoppedBy) {
      try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
      if (alive) await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(alive, false, 'taskkill fallido no debe dejar al hijo vivo');
  } finally {
    if (pid) { try { process.kill(pid); } catch { /* ya muerto */ } }
    if (helper.exitCode === null) helper.kill();
    await done;
  }
});

test('helper: espera a vaciar stdout asincrono antes de salir', (t) => {
  const { dir } = workdir(t);
  const preload = path.join(dir, 'async-output.cjs');
  fs.writeFileSync(preload,
    "const write=process.stdout.write.bind(process.stdout);"
    + "process.stdout.write=(chunk,encoding,callback)=>{"
    + "if(typeof encoding==='function'){callback=encoding;encoding=undefined;}"
    + "setTimeout(()=>write(chunk,encoding,callback),100);return true;};");
  const log = path.join(dir, 'async.log');
  const job = writeJob({ command: process.execPath, args: ['-e', "console.log('PENDING-OUTPUT')"], cwd: dir, logFile: log });
  const res = spawnSync(process.execPath, ['-r', preload, HELPER, '--inharness-job', job], {
    env: { ...process.env, INHARNESS_PANE_LINGER_MS: '0' }, encoding: 'utf8', timeout: 5000, windowsHide: true,
  });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(fs.readFileSync(log, 'utf8'), 'PENDING-OUTPUT\n');
  assert.match(res.stdout, /PENDING-OUTPUT\n/);
});

test('VIVO wt: tab con corpus, rutas con ";" y cierre del helper', { skip: !LIVE || !pl.hasWindowsTerminal() }, async (t) => {
  const { dir, dump } = workdir(t);
  withEnv(t, { INHARNESS_PANE_LINGER_MS: '0', WT_SESSION: undefined, INHARNESS_FORCE_FALLBACK: undefined });
  const r = pl.launchInPane({ command: process.execPath, args: [dump, ...CORPUS], cwd: dir, input: INPUT, logFile: 'lo;g/v.log', title: 'inharness test;vivo' });
  assert.equal(r.mode, 'tab');
  let w = await pl.waitForCompletion(r.logFile, { pollMs: 200, timeoutMs: 30000 });
  assert.equal(w.ok, true, JSON.stringify(w));
  assert.deepEqual(dumpLine(w.output).argv, CORPUS);
  assert.equal(dumpLine(w.output).stdin, INPUT);

  withEnv(t, { DUMP_SLEEP: '60000' });
  const r2 = pl.launchInPane({ command: process.execPath, args: [dump], cwd: dir, logFile: 'k.log', title: 'inharness test cierre' });
  while (!fs.existsSync(`${r2.logFile}.pid`)) await new Promise((res) => setTimeout(res, 100));
  const pid = fs.readFileSync(`${r2.logFile}.pid`, 'utf8');
  spawnSync('taskkill.exe', ['/T', '/F', '/PID', pid], { stdio: 'ignore' });
  const t0 = Date.now();
  w = await pl.waitForCompletion(r2.logFile, { pollMs: 500 });
  assert.equal(w.aborted, true);
  assert.ok(Date.now() - t0 < 5000);
  const jobs = path.join(os.tmpdir(), 'inharness-jobs');
  assert.deepEqual(fs.existsSync(jobs) ? fs.readdirSync(jobs) : [], []);
});

test('waitForStart detecta si el helper reservo el log o no arranco', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inharness-start-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'a.log');
  assert.equal(await pl.waitForStart(log, { timeoutMs: 300, pollMs: 50 }), false);
  setTimeout(() => fs.writeFileSync(`${log}.pid`, '1'), 100);
  assert.equal(await pl.waitForStart(log, { timeoutMs: 3000, pollMs: 50 }), true);
});
