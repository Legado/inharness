'use strict';

// CLI estable para que las skills lancen/esperen filas de Codex y Kimi sin comillado ni rutas del paquete.
// Uso: node runRow.js launch|wait|status --id N --cli codex|kimi [...]. Ningun valor llega a una shell.

const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const { launchInPane, waitForCompletion, waitForStart } = require('./paneLauncher');
const { buildSpawn } = require('./winArgs');

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const SANDBOXES = ['workspace-write', 'read-only'];
const CLIS = ['codex', 'kimi', 'claude'];
const KIMI_MAX_ARG_CHARS = 20000;
const MAX_PROMPT_BYTES = 1024 * 1024;
const TAIL_CHARS = 4000;
const DEFAULT_WAIT_MS = 600000;
const FLAGS = ['id', 'cli', 'model', 'effort', 'prompt-file', 'cwd', 'sandbox', 'title', 'timeout-ms'];

const HELP = `uso: node runRow.js <launch|wait|status> --id <id> --cli <codex|kimi|claude> [opciones]

launch  --model <m> --prompt-file <f> [--effort low|medium|high|xhigh|max|ultra (solo codex)]
        [--sandbox workspace-write|read-only (solo codex)] [--cwd <dir>] [--title <t>] [--timeout-ms <n>]
wait    [--cwd <dir>] [--timeout-ms <n>] (por defecto ${DEFAULT_WAIT_MS})
status  [--cwd <dir>]

Prompt: fichero UTF-8 dentro de cwd (tambien por ruta real), maximo 1 MiB.
Estado y logs sin enlaces. Timeout maximo: 2147483647 ms.
Log: <cwd>/.inharness/log/<id>-<cli>.log
launch: pane (dentro de WT) o tab en la ventana "inharness" (fuera de WT); espera a que la pestana arranque.
        Sin ventana: mode fallback, visible false y warning (tambien en stderr). Pestana que no arranca: codigo 1.
Salida: una linea JSON. Codigos: 0 ok, 1 fallo de la fila, 2 error de uso.
`;

class UsageError extends Error {}
const usage = (message) => new UsageError(message);

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === '--help' || token === '-h') { opts.help = true; continue; }
    if (!token.startsWith('--') || !FLAGS.includes(token.slice(2))) throw usage(`opcion desconocida: ${token}`);
    const name = token.slice(2);
    if (i + 1 >= rest.length) throw usage(`falta el valor de ${token}`);
    if (name in opts) throw usage(`opcion repetida: ${token}`);
    opts[name] = rest[i + 1];
    i += 1;
  }
  return { command, opts };
}

function positiveInt(value, name) {
  if (!/^[0-9]{1,12}$/.test(value) || Number(value) <= 0 || Number(value) > 2147483647) {
    throw usage(`${name} debe ser un entero entre 1 y 2147483647`);
  }
  return Number(value);
}

function common(opts) {
  if (opts.id === undefined) throw usage('falta --id');
  if (!ID_RE.test(opts.id)) throw usage('--id invalido: use letras, digitos, "_" o "-" (maximo 64, sin empezar por "_" ni "-")');
  if (opts.cli === undefined) throw usage('falta --cli');
  if (!CLIS.includes(opts.cli)) throw usage(`--cli debe ser ${CLIS.join(', ')}`);
  const cwdArg = opts.cwd === undefined ? process.cwd() : opts.cwd;
  if (!cwdArg || cwdArg.includes('\0')) throw usage('--cwd invalido');
  let cwd = path.resolve(cwdArg);
  let st = null;
  try { st = fs.statSync(cwd); } catch { /* se informa abajo */ }
  if (!st || !st.isDirectory()) throw usage(`--cwd no existe o no es un directorio: ${cwd}`);
  try { cwd = fs.realpathSync(cwd); } catch (error) { throw usage(`--cwd inaccesible: ${error.message}`); }
  return { id: opts.id, cli: opts.cli, cwd, logRel: path.join('.inharness', 'log', `${opts.id}-${opts.cli}.log`) };
}

function inside(cwd, file) {
  const rel = path.relative(cwd, file);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function checkStatePath(cwd, file) {
  if (!inside(cwd, file)) throw usage('la ruta de estado debe quedar dentro de --cwd');
  let current = cwd;
  for (const part of path.relative(cwd, file).split(path.sep)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw usage(`ruta de estado con enlace: ${current}`);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      if (error instanceof UsageError) throw error;
      throw usage(`ruta de estado inaccesible: ${error.message}`);
    }
  }
}

function readPrompt(file, cwd) {
  if (!file || file.includes('\0')) throw usage('--prompt-file invalido');
  const abs = path.resolve(cwd, file);
  if (!inside(cwd, abs)) throw usage('--prompt-file debe quedar dentro de --cwd');
  let text;
  let fd;
  try {
    if (!inside(cwd, fs.realpathSync(abs))) throw usage('--prompt-file apunta fuera de --cwd');
    fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw usage('--prompt-file debe ser un fichero regular');
    if (st.size > MAX_PROMPT_BYTES) throw usage('--prompt-file supera 1 MiB');
    // Leer con limite tambien si el fichero crece despues del stat.
    const buffer = Buffer.alloc(MAX_PROMPT_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const n = fs.readSync(fd, buffer, size, buffer.length - size, null);
      if (!n) break;
      size += n;
    }
    if (size > MAX_PROMPT_BYTES) throw usage('--prompt-file supera 1 MiB');
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, size));
  } catch (error) {
    throw usage(`no se puede leer --prompt-file ${abs}: ${error.message}`);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  if (!text.trim()) throw usage(`--prompt-file esta vacio: ${abs}`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw usage('--prompt-file contiene controles binarios (NUL u otros)');
  return { text, abs };
}

function spawnLength(spec) {
  let spawn;
  try { spawn = buildSpawn(spec.command, spec.args); } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
  if (spawn.via === 'cmd') throw usage('el CLI requiere cmd.exe; use un ejecutable nativo o un shim npm reconocido');
  // Cota de la serializacion de libuv, incluyendo comillas y barras finales.
  return [spawn.file, ...spawn.args].map((arg) => arg.replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\*)$/, '$1$1').length + 2).reduce((sum, n) => sum + n + 1, 0);
}

function buildLaunch(opts, base) {
  if (opts.model === undefined) throw usage('falta --model');
  if (!MODEL_RE.test(opts.model)) throw usage('--model invalido');
  if (opts['prompt-file'] === undefined) throw usage('falta --prompt-file');
  const timeoutMs = opts['timeout-ms'] === undefined ? undefined : positiveInt(opts['timeout-ms'], '--timeout-ms');
  if (opts.title !== undefined && (!opts.title.trim() || opts.title.includes('\0'))) throw usage('--title invalido');
  if (base.cli !== 'codex') {
    for (const name of ['effort', 'sandbox']) if (opts[name] !== undefined) throw usage(`--${name} solo vale para codex`);
  }
  if (opts.effort !== undefined && !EFFORTS.includes(opts.effort)) throw usage(`--effort debe ser ${EFFORTS.join('|')}`);
  if (opts.sandbox !== undefined && !SANDBOXES.includes(opts.sandbox)) throw usage(`--sandbox debe ser ${SANDBOXES.join('|')}`);
  const prompt = readPrompt(opts['prompt-file'], base.cwd);

  const spec = { cwd: base.cwd, logFile: base.logRel, timeoutMs, title: opts.title || `inharness ${base.id} ${base.cli}` };
  if (base.cli === 'codex') {
    const last = path.join(base.cwd, '.inharness', 'log', `${base.id}-codex-last.txt`);
    const args = ['exec', '-m', opts.model];
    if (opts.effort !== undefined) args.push('-c', `model_reasoning_effort=${opts.effort}`);
    args.push('--sandbox', opts.sandbox || 'workspace-write', '--skip-git-repo-check', '-C', base.cwd, '-',
      '--output-last-message', last);
    return { ...spec, command: 'codex', args, input: prompt.text };
  }
  if (base.cli === 'claude') {
    // Prompt por stdin; nunca --bare (forzaria API key).
    const args = ['-p', '--model', opts.model, '--permission-mode', 'acceptEdits', '--add-dir', base.cwd];
    return { ...spec, command: 'claude', args, input: prompt.text };
  }
  // Conserva -p de Kimi: argumento si cabe, si no instruccion corta con la ruta citada.
  const kimi = { ...spec, command: 'kimi', args: ['-m', `kimi-code/${opts.model}`, '-p', prompt.text] };
  if (prompt.text.length > KIMI_MAX_ARG_CHARS || spawnLength(kimi) > 32766) {
    const shown = JSON.stringify(path.relative(base.cwd, prompt.abs));
    kimi.args[3] = `Lee el fichero ${shown} y ejecuta por completo su contenido`;
  }
  return kimi;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

function statusOf(absLog) {
  const exit = readJson(`${absLog}.exit`);
  if (exit) return { state: exit.aborted ? 'aborted' : 'done', exitCode: exit.exitCode ?? null };
  let pid = NaN;
  try { pid = parseInt(fs.readFileSync(`${absLog}.pid`, 'utf8'), 10); } catch { /* aun sin helper */ }
  if (Number.isInteger(pid) && pid > 0) return alive(pid) ? { state: 'running', exitCode: null } : { state: 'aborted', exitCode: null };
  // launchInPane crea el log vacio antes de que el helper arranque.
  return fs.existsSync(absLog) ? { state: 'running', exitCode: null } : { state: 'unknown', exitCode: null };
}

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

async function main(argv) {
  const { command, opts } = parseArgs(argv);
  if (command === undefined || command === '--help' || command === '-h' || opts.help) {
    process.stdout.write(HELP);
    return command === undefined && !opts.help ? 2 : 0;
  }
  if (!['launch', 'wait', 'status'].includes(command)) throw usage(`subcomando desconocido: ${command}`);
  const allowed = command === 'launch' ? FLAGS : ['id', 'cli', 'cwd', ...(command === 'wait' ? ['timeout-ms'] : [])];
  for (const name of Object.keys(opts)) if (!allowed.includes(name)) throw usage(`--${name} no vale para ${command}`);
  const base = common(opts);
  const absLog = path.join(base.cwd, base.logRel);
  for (const file of [absLog, `${absLog}.pid`, `${absLog}.exit`, path.join(base.cwd, '.inharness', '.gitignore')]) {
    checkStatePath(base.cwd, file);
  }

  if (command === 'launch') {
    checkStatePath(base.cwd, path.join(base.cwd, '.inharness', 'log', `${base.id}-codex-last.txt`));
    const spec = buildLaunch(opts, base);
    if (spawnLength(spec) > 32766) throw usage('la linea del CLI supera el limite de CreateProcess');
    const r = launchInPane(spec);
    const out = { id: base.id, cli: base.cli, mode: r.mode, pid: r.pid, log: r.logFile };
    if (r.mode === 'fallback') {
      // Nunca en silencio: el usuario espera ver la fila en una pestana.
      out.visible = false;
      out.warning = `SIN VENTANA: la fila se ejecuto invisible (${r.reason}). Dilo al usuario.`;
      process.stderr.write(`[inharness] AVISO: ${out.warning}\n`);
      emit(out);
      return 0;
    }
    const startMs = Number(process.env.INHARNESS_START_TIMEOUT_MS);
    const started = await waitForStart(r.logFile, { timeoutMs: Number.isFinite(startMs) && startMs > 0 ? startMs : 20000 });
    out.window = r.window;
    out.visible = started;
    if (!started) {
      // Que no arranque tarde una ejecucion que ya se dio por fallida.
      try { fs.rmSync(r.jobFile, { force: true }); } catch { /* el helper ya lo tomo */ }
      out.warning = `wt.exe acepto la orden pero la pestana no arranco (ventana "${r.window}"). Dilo al usuario; `
        + 'relanza con INHARNESS_FORCE_FALLBACK=1 solo si acepta ejecucion sin ventana.';
      process.stderr.write(`[inharness] ERROR: ${out.warning}\n`);
      emit(out);
      return 1;
    }
    emit(out);
    return 0;
  }
  if (command === 'wait') {
    const timeoutMs = opts['timeout-ms'] === undefined ? DEFAULT_WAIT_MS : positiveInt(opts['timeout-ms'], '--timeout-ms');
    const r = await waitForCompletion(base.logRel, { cwd: base.cwd, timeoutMs });
    emit({
      id: base.id, cli: base.cli, ok: r.ok, exitCode: r.exitCode, aborted: r.aborted, timedOut: r.timedOut,
      error: r.error, outputTail: (r.output || '').slice(-TAIL_CHARS),
    });
    return r.ok ? 0 : 1;
  }
  emit({ id: base.id, cli: base.cli, ...statusOf(absLog) });
  return 0;
}

module.exports = { main, parseArgs, statusOf };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    const isUsage = error instanceof UsageError || ['EINVAL', 'ENOTDIR', 'EBADLOG', 'EBUSY', 'EUNSAFEARG'].includes(error.code);
    process.stderr.write(`runRow: ${error.message}\n${isUsage ? 'Use --help para ver la ayuda.\n' : ''}`);
    process.exitCode = isUsage ? 2 : 1;
  });
}
