'use strict';

// Lanza una fila delegada visible en Windows Terminal (pane/tab) o, si no hay wt.exe, invisible y sincrona.
// El estado viaja por ficheros junto al log: <log>.pid (helper vivo) y <log>.exit (resultado atomico).

const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveExecutable } = require('./resolveExe');
const { buildSpawn } = require('./winArgs');

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_OUTPUT_CHARS = 1000000;
const JOB_FLAG = '--inharness-job';

function insideWindowsTerminal() {
  return Boolean(process.env.WT_SESSION);
}

function findWindowsTerminal() {
  if (process.platform !== 'win32') return null;
  const found = resolveExecutable('wt.exe');
  if (found) return found;
  // El alias de la Store es un reparse point: stat da EACCES y resolveExecutable no lo ve.
  const base = process.env.LOCALAPPDATA;
  if (!base || !path.isAbsolute(base)) return null;
  const alias = path.join(base, 'Microsoft', 'WindowsApps', 'wt.exe');
  try {
    fs.lstatSync(alias);
    return alias;
  } catch {
    return null;
  }
}

function hasWindowsTerminal() {
  try {
    return Boolean(findWindowsTerminal());
  } catch {
    return false;
  }
}

function invalid(message, code = 'EINVAL') {
  return Object.assign(new Error(`launchInPane: ${message}`), { code });
}

const hasNul = (s) => s.includes('\0');

function parsePid(text) {
  const pid = Number(text);
  return Number.isInteger(pid) && pid > 0 && pid <= 0x7fffffff ? pid : NaN;
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function realpathOfNearest(p) {
  let current = p;
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), path.relative(current, p));
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return p;
      current = parent;
    }
  }
}

function validate({ command, args, cwd, input, logFile, title, timeoutMs }) {
  if (typeof command !== 'string' || !command || hasNul(command)) throw invalid('command debe ser un string no vacio sin NUL');
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string' || hasNul(a))) {
    throw invalid('args debe ser un array de strings sin NUL');
  }
  if (cwd !== undefined && (typeof cwd !== 'string' || !cwd || hasNul(cwd))) throw invalid('cwd invalido');
  const absCwd = path.resolve(cwd === undefined ? process.cwd() : cwd);
  let st;
  try { st = fs.statSync(absCwd); } catch { st = null; }
  if (!st || !st.isDirectory()) throw invalid(`cwd no existe o no es un directorio: ${absCwd}`, 'ENOTDIR');
  if (input !== undefined && input !== null && typeof input !== 'string') throw invalid('input debe ser string');
  if (title !== undefined && title !== null && typeof title !== 'string') throw invalid('title debe ser string');
  if (timeoutMs !== undefined && timeoutMs !== null && !(Number.isFinite(timeoutMs) && timeoutMs > 0)) {
    throw invalid('timeoutMs debe ser un numero positivo');
  }
  if (typeof logFile !== 'string' || !logFile || hasNul(logFile)) throw invalid('logFile debe ser un string no vacio sin NUL');
  const absLog = path.resolve(absCwd, logFile);
  // Tambien por ruta real: un symlink dentro de cwd no debe sacar el log fuera.
  if (!isInside(absCwd, absLog) || !isInside(realpathOfNearest(absCwd), realpathOfNearest(absLog))) {
    throw invalid(`logFile debe quedar dentro de cwd: ${logFile}`, 'EBADLOG');
  }
  return { absCwd, absLog };
}

// Relanzar sobre un log cuya ejecucion sigue viva dejaria que la vieja pise el .exit de la nueva.
function assertNotRunning(absLog) {
  const pidFile = `${absLog}.pid`;
  let pid;
  try {
    pid = parsePid(fs.readFileSync(pidFile, 'utf8'));
  } catch {
    return;
  }
  // La antiguedad del fichero no demuestra que haya terminado una ejecucion larga.
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (fs.existsSync(`${absLog}.exit`)) return;
  if (processAlive(pid)) throw invalid(`ya hay una ejecucion viva con este log (pid ${pid}): ${absLog}`, 'EBUSY');
}

function prepareLog(absCwd, absLog) {
  assertNotRunning(absLog);
  fs.mkdirSync(path.dirname(absLog), { recursive: true });
  for (let dir = path.dirname(absLog); ; dir = path.dirname(dir)) {
    if (path.basename(dir) === '.inharness') {
      try {
        fs.writeFileSync(path.join(dir, '.gitignore'), '*\n', { flag: 'wx' });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    if (path.relative(absCwd, dir) === '') break;
  }
  fs.writeFileSync(absLog, '');
  for (const suffix of ['.exit', '.pid']) fs.rmSync(absLog + suffix, { force: true });
}

function writeExitFile(absLog, data) {
  const tmp = `${absLog}.exit.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, `${absLog}.exit`);
}

const resolveCommand = (command, cwd) => (/[\\/]/.test(command) ? path.resolve(cwd, command) : command);
const startupMessage = (command, error) => `[inharness] no se pudo arrancar ${command}: ${error.message}\n`;

function sanitizeTitle(title) {
  const clean = String(title || '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/;/g, ',')
    .replace(/^[\s-]+/, '')
    .trim()
    .slice(0, 80)
    .trim();
  return clean || 'inharness';
}

// wt.exe parte su linea de comandos en ';': las rutas que viajan por ella lo escapan como '\;'.
const escapeWt = (s) => s.replace(/;/g, '\\;');

function createJobFile(job) {
  const dir = path.join(os.tmpdir(), 'inharness-jobs');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`directorio de jobs inseguro: ${dir}`);
  if (process.platform !== 'win32' && typeof process.getuid === 'function') {
    if (st.uid !== process.getuid()) throw new Error(`directorio de jobs ajeno: ${dir}`);
    if (st.mode & 0o077) fs.chmodSync(dir, 0o700);
  }
  const file = path.join(dir, `${crypto.randomBytes(16).toString('hex')}.json`);
  const fd = fs.openSync(file, 'wx', 0o600);
  let written = false;
  try {
    fs.writeFileSync(fd, JSON.stringify(job));
    written = true;
  } finally {
    try { fs.closeSync(fd); } finally { if (!written) fs.rmSync(file, { force: true }); }
  }
  return file;
}

function runFallback({ command, args, absCwd, input, absLog, timeoutMs }) {
  const startedAt = new Date().toISOString();
  const exit = { exitCode: null, signal: null, error: null, aborted: false, startedAt, finishedAt: null };
  let spec;
  try {
    spec = buildSpawn(resolveCommand(command, absCwd), args);
  } catch (error) {
    fs.writeFileSync(absLog, startupMessage(command, error));
    Object.assign(exit, { exitCode: 127, error: error.message, finishedAt: new Date().toISOString() });
    writeExitFile(absLog, exit);
    return;
  }
  const limit = timeoutMs || DEFAULT_TIMEOUT_MS;
  const result = spawnSync(spec.file, spec.args, {
    cwd: absCwd,
    input: input == null ? undefined : input,
    timeout: limit,
    maxBuffer: 1024 * 1024 * 256,
    windowsHide: true,
    windowsVerbatimArguments: spec.windowsVerbatimArguments,
  });
  const chunks = [result.stdout, result.stderr].filter(Boolean);
  if (result.error) {
    const timedOut = result.error.code === 'ETIMEDOUT';
    const message = timedOut ? `tiempo agotado tras ${limit} ms` : result.error.message;
    const neverStarted = !timedOut && result.status === null && result.signal === null && !result.pid;
    chunks.push(Buffer.from(neverStarted ? startupMessage(command, result.error) : `[inharness] ${message}\n`));
    Object.assign(exit, { error: message, aborted: timedOut, exitCode: neverStarted ? 127 : result.status });
  } else {
    exit.exitCode = result.status;
  }
  exit.signal = result.signal || null;
  fs.writeFileSync(absLog, Buffer.concat(chunks));
  exit.finishedAt = new Date().toISOString();
  writeExitFile(absLog, exit);
}

function launchInPane({ command, args = [], cwd, input, logFile, title, timeoutMs } = {}) {
  const { absCwd, absLog } = validate({ command, args, cwd, input, logFile, title, timeoutMs });
  prepareLog(absCwd, absLog);
  const result = (mode, pid) => ({ mode, pid, logFile: absLog, exitFile: `${absLog}.exit` });
  const fallback = () => {
    // Reservar antes de ejecutar: dos lanzamientos concurrentes no deben compartir log ni .exit.
    try {
      fs.writeFileSync(`${absLog}.pid`, String(process.pid), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code === 'EEXIST') throw invalid(`ya hay una ejecucion viva con este log: ${absLog}`, 'EBUSY');
      throw error;
    }
    try {
      runFallback({ command, args, absCwd, input, absLog, timeoutMs });
    } finally {
      fs.rmSync(`${absLog}.pid`, { force: true });
    }
    return result('fallback', null);
  };

  if (process.env.INHARNESS_FORCE_FALLBACK === '1') return fallback();
  const usePane = insideWindowsTerminal();
  let wtExe = null;
  try { wtExe = findWindowsTerminal(); } catch { wtExe = null; }
  if (!wtExe) return fallback();

  const cleanTitle = sanitizeTitle(title);
  let jobFile;
  try {
    jobFile = createJobFile({
      command, args, cwd: absCwd, input: input == null ? null : input, logFile: absLog, title: cleanTitle,
      timeoutMs: timeoutMs || null,
    });
  } catch {
    return fallback();
  }
  const wtArgs = ['-w', '0', usePane ? 'split-pane' : 'new-tab', '--title', cleanTitle,
    escapeWt(process.execPath), escapeWt(__filename), JOB_FLAG, escapeWt(jobFile)];

  let wt;
  try {
    // Nunca windowsHide: la pestana naceria oculta.
    wt = spawn(wtExe, wtArgs, { cwd: absCwd, stdio: 'ignore', detached: true });
  } catch {
    wt = null;
  }
  if (!wt || !wt.pid) {
    if (wt) wt.on('error', () => {});
    fs.rmSync(jobFile, { force: true });
    return fallback();
  }
  wt.on('error', () => {});
  wt.unref();
  return result(usePane ? 'pane' : 'tab', wt.pid);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readTail(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return { output: '', outputTruncated: false };
  }
  try {
    const size = fs.fstatSync(fd).size;
    const maxBytes = MAX_OUTPUT_CHARS * 4;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    let read = 0;
    while (read < buf.length) {
      const n = fs.readSync(fd, buf, read, buf.length - read, start + read);
      if (n === 0) break;
      read += n;
    }
    let text = buf.subarray(0, read).toString('utf8');
    if (start > 0) text = text.replace(/^�+/, '');
    if (text.length > MAX_OUTPUT_CHARS) {
      text = text.slice(-MAX_OUTPUT_CHARS);
      if (/^[\uDC00-\uDFFF]/.test(text)) text = text.slice(1);
      return { output: text, outputTruncated: true };
    }
    return { output: text, outputTruncated: start > 0 };
  } finally {
    fs.closeSync(fd);
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

async function waitForCompletion(logFile, { pollMs = 1000, timeoutMs = 600000, startTimeoutMs = 60000, cwd } = {}) {
  if (typeof logFile !== 'string' || !logFile || hasNul(logFile)) throw new Error('waitForCompletion: logFile invalido');
  const absLog = path.resolve(cwd || process.cwd(), logFile);
  const begin = Date.now();
  let deadStreak = 0;

  const fromExit = (exit) => ({
    ok: exit.exitCode === 0 && !exit.aborted,
    exitCode: exit.exitCode ?? null,
    signal: exit.signal ?? null,
    aborted: Boolean(exit.aborted),
    error: exit.error ?? null,
    ...readTail(absLog),
    timedOut: false,
  });
  const failed = (extra) => ({
    ok: false, exitCode: null, signal: null, aborted: false, error: null, ...readTail(absLog), timedOut: false, ...extra,
  });

  for (;;) {
    const exit = readJson(`${absLog}.exit`);
    if (exit) return fromExit(exit);

    const pidText = (() => { try { return fs.readFileSync(`${absLog}.pid`, 'utf8'); } catch { return null; } })();
    const pid = parsePid(pidText);
    if (Number.isInteger(pid) && pid > 0) {
      deadStreak = processAlive(pid) ? 0 : deadStreak + 1;
      if (deadStreak >= 2) {
        // Ultima mirada por si el helper escribio .exit justo antes de morir.
        const late = readJson(`${absLog}.exit`);
        if (late) return fromExit(late);
        return failed({ aborted: true, error: `el helper (pid ${pid}) termino sin escribir el resultado` });
      }
    } else if (startTimeoutMs > 0 && Date.now() - begin >= startTimeoutMs) {
      return failed({ aborted: true, error: `el helper no arranco en ${startTimeoutMs} ms` });
    }

    if (Date.now() - begin >= timeoutMs) return failed({ timedOut: true });
    await sleep(pollMs);
  }
}

module.exports = { launchInPane, waitForCompletion, hasWindowsTerminal, insideWindowsTerminal };

// ---- Helper que corre dentro de la pestana: node paneLauncher.js --inharness-job <ruta> ----

function lingerMs(ok) {
  const raw = process.env.INHARNESS_PANE_LINGER_MS;
  const n = raw === undefined || raw === '' ? NaN : Number(raw);
  if (Number.isFinite(n) && n >= 0) return n;
  return ok ? 2000 : 15000;
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    try {
      const taskkill = resolveExecutable('taskkill.exe');
      if (taskkill) {
        const result = spawnSync(taskkill, ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
        if (!result.error && result.status === 0) return;
      }
    } catch { /* matar al hijo aunque falle taskkill */ }
  }
  try { child.kill('SIGTERM'); } catch { /* ya muerto */ }
}

function runJob(jobPath) {
  let job;
  try {
    job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
  } finally {
    try { fs.rmSync(jobPath, { force: true }); } catch { /* el job es de un solo uso */ }
  }
  if (!job || typeof job.command !== 'string' || !Array.isArray(job.args) || typeof job.logFile !== 'string'
    || !path.isAbsolute(job.logFile) || typeof job.cwd !== 'string' || !path.isAbsolute(job.cwd) || hasNul(job.cwd)) {
    throw new Error('job file con formato invalido');
  }
  const absLog = job.logFile;
  if (hasNul(absLog) || !isInside(job.cwd, absLog) || !isInside(realpathOfNearest(job.cwd), realpathOfNearest(absLog))) {
    throw invalid(`logFile debe quedar dentro de cwd: ${absLog}`, 'EBADLOG');
  }
  // Reservar antes de truncar evita que dos helpers compartan log y resultado.
  try {
    fs.writeFileSync(`${absLog}.pid`, String(process.pid), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code === 'EEXIST') throw invalid(`EBUSY: ya hay un helper para este log: ${absLog}`, 'EBUSY');
    throw error;
  }
  const startedAt = new Date().toISOString();
  let logFd = null;
  let child = null;
  let finished = false;
  let timer = null;

  const log = (chunk) => {
    if (logFd === null) return;
    try { fs.writeSync(logFd, chunk); } catch { /* mejor perder una linea que el pane */ }
  };
  const say = (text, stream = process.stderr) => { log(text); try { stream.write(text); } catch { /* consola cerrada */ } };
  const exitAfterFlush = () => {
    let pending = 2;
    const drained = () => { if (--pending === 0) process.exit(); };
    for (const stream of [process.stdout, process.stderr]) {
      try {
        if (stream.destroyed) drained(); else stream.write('', drained);
      } catch { drained(); }
    }
  };

  const finish = (fields, { linger = true } = {}) => {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    const exit = { exitCode: null, signal: null, error: null, aborted: false, ...fields, startedAt, finishedAt: new Date().toISOString() };
    if (logFd !== null) { try { fs.closeSync(logFd); } catch { /* ya cerrado */ } logFd = null; }
    try {
      writeExitFile(absLog, exit);
    } catch (error) {
      try { process.stderr.write(`[inharness] no se pudo escribir ${absLog}.exit: ${error.message}\n`); } catch { /* */ }
    }
    const ok = exit.exitCode === 0 && !exit.aborted;
    process.exitCode = typeof exit.exitCode === 'number' ? exit.exitCode : 1;
    const wait = linger ? lingerMs(ok) : 0;
    if (wait > 0) {
      const status = ok ? 'terminado' : `fallo (codigo ${exit.exitCode}${exit.error ? `: ${exit.error}` : ''})`;
      try { process.stderr.write(`\n[inharness] ${status}. Esta pestana se cierra en ${Math.round(wait / 1000)} s.\n`); } catch { /* */ }
      setTimeout(exitAfterFlush, wait);
    } else {
      exitAfterFlush();
    }
  };
  const internalError = (error) => {
    if (finished) process.exit(1);
    killTree(child);
    say(`[inharness] error interno: ${error && error.message}\n`);
    finish({ exitCode: 1, error: `error interno: ${error && error.message}` });
  };
  process.on('uncaughtException', internalError);
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', ...(process.platform === 'win32' ? ['SIGBREAK'] : [])];
  for (const sig of signals) {
    process.on(sig, () => {
      killTree(child);
      say(`\n[inharness] abortado (${sig})\n`);
      finish({ aborted: true, signal: sig, error: `abortado por ${sig}` }, { linger: false });
    });
  }

  try {
    logFd = fs.openSync(absLog, 'w');
    fs.rmSync(`${absLog}.exit`, { force: true });
  } catch (error) {
    internalError(error);
    return;
  }
  try { process.stdout.write(`[inharness] ${job.title || 'inharness'}\n`); } catch { /* */ }

  let spec;
  try {
    spec = buildSpawn(resolveCommand(job.command, job.cwd), job.args);
    child = spawn(spec.file, spec.args, {
      cwd: job.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: false,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
    });
  } catch (error) {
    say(startupMessage(job.command, error));
    finish({ exitCode: 127, error: error.message });
    return;
  }
  const forward = (source, stream) => (chunk) => {
    log(chunk);
    try {
      if (!stream.write(chunk)) {
        source.pause();
        stream.once('drain', () => source.resume());
      }
    } catch { /* consola cerrada */ }
  };
  child.stdout.on('data', forward(child.stdout, process.stdout));
  child.stderr.on('data', forward(child.stderr, process.stderr));
  child.stdin.on('error', () => {});
  child.on('error', (error) => {
    if (child.pid === undefined) {
      say(startupMessage(job.command, error));
      finish({ exitCode: 127, error: error.message });
    } else {
      say(`[inharness] error del proceso: ${error.message}\n`);
    }
  });
  child.on('close', (code, signal) => finish({ exitCode: code, signal: signal || null }));
  if (job.timeoutMs > 0) {
    timer = setTimeout(() => {
      killTree(child);
      say(`\n[inharness] tiempo agotado tras ${job.timeoutMs} ms\n`);
      finish({ aborted: true, error: `tiempo agotado tras ${job.timeoutMs} ms` });
    }, job.timeoutMs);
  }
  child.stdin.end(typeof job.input === 'string' ? job.input : undefined);
}

if (require.main === module) {
  const idx = process.argv.indexOf(JOB_FLAG);
  if (idx !== -1 && process.argv[idx + 1]) {
    try {
      runJob(process.argv[idx + 1]);
    } catch (error) {
      // Sin job legible no hay log donde escribir: al menos que se vea en la pestana.
      process.stderr.write(`[inharness] no se pudo ejecutar el job: ${error.message}\n`);
      process.exitCode = 1;
      setTimeout(() => {}, lingerMs(false));
    }
  }
}
