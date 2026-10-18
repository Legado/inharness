'use strict';

/**
 * Visibilidad en vivo del trabajo delegado a otro CLI.
 *
 * Cuando el orquestador (la skill) ejecuta una fila en Codex/Kimi, el proceso
 * corre hoy invisible detras de un Bash del propio CLI. Este modulo decide,
 * en este orden:
 *   1. pane     — estamos DENTRO de Windows Terminal (WT_SESSION) -> wt.exe
 *                 split-pane, el proceso corre visible al lado.
 *   2. tab      — hay wt.exe en el PATH pero no estamos dentro -> wt.exe
 *                 new-tab (o ventana nueva, eso lo resuelve wt.exe).
 *   3. fallback — no hay Windows Terminal -> misma ejecucion invisible y
 *                 sincrona de siempre (vía spawnCli), con el log en el mismo
 *                 formato para que el resto del flujo no note la diferencia.
 *
 * En pane/tab el proceso real corre en un helper de este mismo archivo
 * (`--inharness-pane-run`, disparado como `require.main`) que lo lanza con
 * spawn, lo pinta en la consola del pane/tab Y lo vuelca combinado al log,
 * cerrando con la linea sentinel `###INHARNESS_EXIT:<codigo>###`.
 *
 * La regla del wrapper `cmd.exe /d /s /c` para .cmd en Windows es LA MISMA
 * que aplica src/spawnCli.js (mismo contrato); se repite aquí porque el
 * camino del pane necesita el exe ya resuelto para pasarselo a wt.exe.
 * NUNCA se construye un string de shell a mano.
 */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnCli } = require('./spawnCli');

const SENTINEL_PREFIX = '###INHARNESS_EXIT:';
const SENTINEL_RE = /###INHARNESS_EXIT:(-?\d+)###[ \t]*\r?\n?$/;

/** True si este proceso corre dentro de Windows Terminal (WT_SESSION). */
function insideWindowsTerminal() {
  return Boolean(process.env.WT_SESSION);
}

/**
 * True si wt.exe es localizable en el PATH. False fuera de Windows o si
 * `where wt.exe` no lo encuentra. Nunca lanza excepcion.
 */
function hasWindowsTerminal() {
  if (os.platform() !== 'win32') return false;
  try {
    const result = spawnSync('where', ['wt.exe'], { encoding: 'utf8', windowsHide: true });
    return result.status === 0 && Boolean(result.stdout && result.stdout.trim());
  } catch {
    return false;
  }
}

/**
 * Mismo problema que ya resolvio discovery.js para spawnCli: muchos globales
 * npm en Windows son shims `.cmd` (p.ej. `kimi` tiene `kimi` Y `kimi.cmd` en
 * la carpeta de npm; el primero lo resuelve un shell POSIX, no CreateProcess
 * sin shell). Si el llamador pasa el nombre plano ("kimi") y no el ya
 * resuelto ("kimi.cmd"), `spawn` sin shell falla con ENOENT dentro del
 * pane/tab -- el proceso muere en milisegundos y la pestana se cierra sola
 * sin que el usuario llegue a verla. Por eso, antes de decidir el wrapper,
 * se prueba si existe `<command>.cmd` y si es asi se usa esa en su lugar.
 */
function resolveWindowsCmd(command) {
  if (os.platform() !== 'win32' || /\.(cmd|bat|exe)$/i.test(command)) return command;
  try {
    const probe = spawnSync('where', [`${command}.cmd`], { encoding: 'utf8', windowsHide: true });
    if (probe.status === 0 && probe.stdout && probe.stdout.trim()) return `${command}.cmd`;
  } catch {
    // sin suerte localizando el shim; se sigue con el nombre plano
  }
  return command;
}

// Misma regla que src/spawnCli.js: en Windows los .cmd/.bat necesitan pasar
// por cmd.exe /d /s /c; los .exe nativos no.
function wrapCmd(command, args) {
  const resolved = resolveWindowsCmd(command);
  if (os.platform() === 'win32' && /\.cmd$/i.test(resolved)) {
    return { exe: process.env.ComSpec || 'cmd.exe', finalArgs: ['/d', '/s', '/c', resolved, ...args] };
  }
  return { exe: resolved, finalArgs: args };
}

/**
 * Punto de entrada usado DENTRO del pane/tab: lanza el proceso real con su
 * salida combinada al log (terminando en la linea sentinel) y ademas al
 * console del pane/tab, para que el usuario lo vea en vivo. No se exporta:
 * solo se ejecuta como `node paneLauncher.js --inharness-pane-run <log> ...`.
 *
 * `inputFile`, si se da, es la ruta de un fichero con el contenido exacto
 * que hay que escribir en el stdin del proceso real. NO se reenvia el stdin
 * de este helper (el de la consola nueva que abre wt.exe): ese stdin nunca
 * recibe nada de wt.exe, que no reenvia el suyo al pane/tab que crea (son
 * consolas distintas) - intentarlo deja al proceso real colgado para
 * siempre esperando una entrada que nunca llega. Por eso el input viaja por
 * fichero, escrito por launchInPane ANTES de lanzar wt.exe.
 */
function runVisible(logFile, inputFile, exe, args) {
  const fd = fs.openSync(logFile, 'w');
  let lastWasNewline = true; // sin salida aun, la sentinel va en la 1a linea
  let finished = false;

  const finish = (code) => {
    if (finished) return;
    finished = true;
    const exitCode = typeof code === 'number' ? code : 1;
    try {
      fs.writeSync(fd, `${lastWasNewline ? '' : '\n'}${SENTINEL_PREFIX}${exitCode}###\n`);
      fs.closeSync(fd);
    } catch {
      // el log es lo de menos si el pane se esta cerrando
    }
    if (inputFile) {
      try {
        fs.unlinkSync(inputFile);
      } catch {
        // fichero temporal de un solo uso; si no se puede borrar no es grave
      }
    }
  };

  let child;
  try {
    child = spawn(exe, args, {
      cwd: process.cwd(),
      stdio: [inputFile ? 'pipe' : 'inherit', 'pipe', 'pipe'],
      windowsHide: false,
    });
  } catch {
    finish(1);
    return;
  }

  const forward = (chunk, target) => {
    lastWasNewline = chunk[chunk.length - 1] === 0x0a;
    try {
      fs.writeSync(fd, chunk);
    } catch {
      // ignorar: mejor perder una linea del log que tumbar el pane
    }
    target.write(chunk);
  };
  child.stdout.on('data', (c) => forward(c, process.stdout));
  child.stderr.on('data', (c) => forward(c, process.stderr));
  if (inputFile && child.stdin) {
    try {
      child.stdin.end(fs.readFileSync(inputFile));
    } catch {
      child.stdin.end();
    }
  }
  child.on('error', () => finish(1));
  child.on('close', (code) => finish(code));
}

/**
 * Lanza { command, args, cwd, input } (mismo contrato que spawnCli.js) con
 * visibilidad en vivo si hay Windows Terminal:
 *   - pane/tab: lanza wt.exe detached, NO bloquea, devuelve { mode, pid }.
 *   - fallback: ejecuta igual que spawnCli (invisible, sincrono) y devuelve
 *     { mode: 'fallback', pid: null }.
 * En ambos casos el log queda en logFile (stdout+stderr combinados + linea
 * sentinel). `title` etiqueta el pane/tab si el mecanismo lo soporta; si no,
 * se ignora sin fallar. Nunca lanza excepcion por falta de wt.exe.
 */
function launchInPane({ command, args = [], cwd, input, logFile, title }) {
  if (!command) throw new Error('launchInPane: command es obligatorio');
  if (!logFile) throw new Error('launchInPane: logFile es obligatorio');

  const absLog = path.resolve(logFile);
  fs.mkdirSync(path.dirname(absLog), { recursive: true });

  const usePane = insideWindowsTerminal();
  const useTab = !usePane && hasWindowsTerminal();

  const runFallback = () => {
    // Caída esperada, no un error: misma ejecución invisible de siempre.
    // Mismo problema de resolución de .cmd que en pane/tab (ver
    // resolveWindowsCmd): spawnCli tambien necesita el nombre ya resuelto.
    const result = spawnCli(resolveWindowsCmd(command), args, { cwd, input });
    const combined = `${result.stdout || ''}${result.stderr || ''}`;
    const code = typeof result.status === 'number' ? result.status : 1;
    const prefix = combined !== '' && !combined.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(absLog, `${combined}${prefix}${SENTINEL_PREFIX}${code}###\n`);
    return { mode: 'fallback', pid: null };
  };
  if (!usePane && !useTab) return runFallback();

  // El input viaja por fichero, nunca por el stdin de wt.exe: wt.exe no
  // reenvia su propio stdin al pane/tab que crea (son consolas distintas),
  // y escribirlo ahi deja al proceso real colgado para siempre esperando
  // una entrada que jamas llega (confirmado empiricamente). runVisible lo
  // lee de este fichero y lo escribe el en el stdin real del proceso.
  let inputFile;
  if (input !== undefined) {
    inputFile = path.join(os.tmpdir(), `inharness-input-${process.pid}-${Date.now()}.txt`);
    fs.writeFileSync(inputFile, input, 'utf8');
  }

  const { exe, finalArgs } = wrapCmd(command, args);
  const wtArgs = [
    // -w 0: reutiliza la ultima ventana de Windows Terminal activa si hay
    // alguna (misma pantalla de usuario) en vez de abrir una nueva cada vez
    // -- sin esto, invocar wt.exe desde fuera de una sesion de WT (como aqui)
    // crea SIEMPRE ventana nueva (confirmado en vivo con el usuario: 3
    // llamadas, 3 ventanas separadas, ninguna como pestana). Si no hay
    // ninguna ventana de WT abierta, "-w 0" simplemente crea la primera.
    '-w', '0',
    usePane ? 'split-pane' : 'new-tab',
    ...(title ? ['--title', title] : []),
    process.execPath,
    __filename,
    '--inharness-pane-run',
    absLog,
    ...(inputFile ? ['--inharness-input-file', inputFile] : []),
    '--',
    exe,
    ...finalArgs,
  ];

  let wt;
  try {
    // OJO: NUNCA windowsHide:true aqui. Toda esta funcion existe para que el
    // usuario VEA la ventana/pestana; windowsHide fuerza que nazca oculta
    // (confirmado: el proceso corria bien pero no se veia nada en pantalla).
    wt = spawn('wt.exe', wtArgs, {
      cwd,
      stdio: 'ignore',
      detached: true,
    });
  } catch {
    return runFallback();
  }
  wt.unref();

  return { mode: usePane ? 'pane' : 'tab', pid: wt.pid };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Espera a que el log termine en la linea sentinel. Funciona igual para
 * fallback (resuelve en la primera pasada) que para pane/tab. Al encontrarla
 * devuelve { ok, exitCode, output (log sin la sentinel), timedOut: false };
 * si supera timeoutMs, { ok: false, exitCode: null, output, timedOut: true }.
 */
async function waitForCompletion(logFile, { pollMs = 1000, timeoutMs = 600000 } = {}) {
  const absLog = path.resolve(logFile);
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    let content = '';
    try {
      content = fs.readFileSync(absLog, 'utf8');
    } catch {
      // el log aun no existe: el proceso del pane esta arrancando
    }
    const match = content.match(SENTINEL_RE);
    if (match) {
      const exitCode = parseInt(match[1], 10);
      return {
        ok: exitCode === 0,
        exitCode,
        output: content.slice(0, match.index).replace(/\r?\n$/, ''),
        timedOut: false,
      };
    }
    if (Date.now() >= deadline) {
      return { ok: false, exitCode: null, output: content, timedOut: true };
    }
    await sleep(pollMs);
  }
}

module.exports = { launchInPane, waitForCompletion, hasWindowsTerminal, insideWindowsTerminal };

// Entrada del helper que corre DENTRO del pane/tab. No forma parte de la API:
// launchInPane lo invoca como `node paneLauncher.js --inharness-pane-run ...`.
if (require.main === module) {
  const argv = process.argv.slice(2);
  const runIdx = argv.indexOf('--inharness-pane-run');
  if (runIdx !== -1) {
    const logFile = argv[runIdx + 1];
    let rest = argv.slice(runIdx + 2);
    let inputFile;
    if (rest[0] === '--inharness-input-file') {
      inputFile = rest[1];
      rest = rest.slice(2);
    }
    if (rest[0] === '--') rest = rest.slice(1);
    const [exe, ...childArgs] = rest;
    if (logFile && exe) runVisible(logFile, inputFile, exe, childArgs);
  }
}
