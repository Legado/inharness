'use strict';

const fs = require('node:fs');
const path = require('node:path');

const HELP = `Uso: inharness status [--watch] [--interval <s>] [--cwd <dir>] [--json] [--ascii] [--no-color]
       inharness watch [--interval <s>] [--cwd <dir>] [--ascii] [--no-color]

--watch          Actualiza el panel cada 5 segundos (q o Ctrl+C para salir).
--interval <s>  Intervalo positivo de refresco; por defecto 5.
--cwd <dir>     Proyecto a observar; por defecto el directorio actual.
--json          Emite una instantanea normalizada y sale.
--ascii         Usa caracteres ASCII.
--no-color      Desactiva los colores.
`;

const STATES = ['running', 'failed', 'dead', 'quota', 'pending', 'done'];
const SYMBOLS = {
  running: ['●', '*', '32'], done: ['✔', '+', '32'], failed: ['✖', 'x', '31'],
  dead: ['☠', 'x', '31'], quota: ['⏸', '!', '33'], pending: ['◌', 'o', '2'],
};
const LOG_RE = /^([A-Za-z0-9][A-Za-z0-9_-]{0,63})-(codex|kimi|claude)\.log$/i;

function splitMarkdown(line) {
  const cells = [];
  let cell = '';
  let source = line.trim().replace(/^\|/, '');
  if (source.endsWith('|') && !/\\(?:\\\\)*\|$/.test(source)) source = source.slice(0, -1);
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\\' && source[i + 1] === '|') { cell += '|'; i += 1; }
    else if (source[i] === '|') { cells.push(cell.trim()); cell = ''; }
    else cell += source[i];
  }
  cells.push(cell.trim());
  return cells;
}

function normalizeState(value) {
  const s = String(value || '').trim().toLowerCase();
  if (/^(?:hecho|hecha|done|ok|completad[oa])\b/.test(s)) return 'done';
  if (/\bbloquead[ao]\b|\bquota\b|\bcupo\b/.test(s)) return 'quota';
  if (/fallid|\bfailed\b|\berror\b/.test(s)) return 'failed';
  if (/en\s+curso|\brunning\b|ejecutando/.test(s)) return 'running';
  if (/\b(?:hecho|hecha|done|ok)\b/.test(s)) return 'done';
  return 'pending';
}

function parseAssignment(markdown) {
  const rows = [];
  let columns = null;
  for (const line of String(markdown).split(/\r?\n/)) {
    if (!line.trimStart().startsWith('|')) { columns = null; continue; }
    const cells = splitMarkdown(line);
    const names = cells.map((s) => s.toLowerCase().replace(/\s+/g, '').replace(/[*`]/g, ''));
    if (names.includes('id') && (names.includes('estado') || names.includes('status'))) {
      columns = names;
      continue;
    }
    if (!columns || cells.every((s) => /^:?-{3,}:?$/.test(s))) continue;
    const get = (...names) => {
      for (const name of names) {
        const index = columns.indexOf(name);
        if (index >= 0) return cells[index] || '';
      }
      return '';
    };
    const id = get('id');
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) continue;
    const assignmentStatus = get('estado', 'status');
    rows.push({ id, role: get('rol', 'alcance'), cliModel: get('cli/modelo', 'cli'), dep: get('dep'),
      assignmentStatus, assignmentState: normalizeState(assignmentStatus) });
  }
  return rows;
}

function redact(value) {
  return String(value)
    .replace(/\b(?:sk-ant-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+|ghp_[A-Za-z0-9_]+|gho_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|xox[a-z]-[A-Za-z0-9-]+|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, '[redactado]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redactado]')
    .replace(/\b(password|secret|token|api_key)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1=[redactado]');
}

function clean(value) {
  return redact(String(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' '));
}

function safeFile(file, root) {
  const rel = path.relative(root, file);
  if (rel.startsWith('..') || path.isAbsolute(rel) || rel === '') return null;
  let cursor = root;
  try {
    if (!fs.lstatSync(cursor).isDirectory()) return null;
    for (const part of rel.split(path.sep)) {
      cursor = path.join(cursor, part);
      const st = fs.lstatSync(cursor);
      if (st.isSymbolicLink()) return null;
      if (cursor === file ? !st.isFile() : !st.isDirectory()) return null;
    }
    return fs.statSync(file);
  } catch { return null; }
}

function readInside(file, root, limit = 1024 * 1024) {
  const st = safeFile(file, root);
  if (!st || st.size > limit) return null;
  try { return { text: fs.readFileSync(file, 'utf8'), mtimeMs: st.mtimeMs }; } catch { return null; }
}

function logTail(file, root) {
  const st = safeFile(file, root);
  if (!st) return '';
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = Math.min(st.size, 65536);
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, st.size - size);
    return buffer.toString('utf8').split(/\r?\n/).map((line) => clean(line).trim()).filter(Boolean).slice(-2).join(' / ');
  } catch { return ''; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

function elapsed(start, end) {
  if (!Number.isFinite(start)) return null;
  return Math.max(0, Math.floor((end - start) / 1000));
}

function collectState(cwd = process.cwd(), now = Date.now()) {
  const project = path.resolve(cwd);
  const root = path.join(project, '.inharness');
  const assignment = readInside(path.join(root, 'assignment.md'), root);
  const rows = parseAssignment(assignment ? assignment.text : '');
  const nowFile = readInside(path.join(root, 'now.md'), root);
  const logs = path.join(root, 'log');
  const logNames = (() => {
    try {
      const st = fs.lstatSync(logs);
      return st.isDirectory() && !st.isSymbolicLink() ? fs.readdirSync(logs).filter((name) => LOG_RE.test(name)) : [];
    }
    catch { return []; }
  })();
  const found = new Map();
  for (const name of logNames) {
    const logFile = path.join(logs, name);
    const st = safeFile(logFile, root);
    if (!st) continue;
    const [, id, cli] = name.match(LOG_RE);
    const exitFile = readInside(`${logFile}.exit`, root);
    let exit = null;
    if (exitFile) {
      try {
        const parsed = JSON.parse(exitFile.text);
        if (parsed && typeof parsed === 'object' && (typeof parsed.exitCode === 'number' || parsed.exitCode === null)
          && typeof parsed.aborted === 'boolean') exit = parsed;
      } catch { /* escritura incompleta */ }
    }
    const pidFile = readInside(`${logFile}.pid`, root, 32);
    const pid = pidFile && /^\d+$/.test(pidFile.text.trim()) ? Number(pidFile.text.trim()) : null;
    const state = exit ? (exit.aborted || exit.exitCode !== 0 ? 'failed' : 'done')
      : Number.isSafeInteger(pid) && pid > 0 ? (pidAlive(pid) ? 'running' : 'dead') : 'pending';
    const started = exit && Number.isFinite(Date.parse(exit.startedAt)) ? Date.parse(exit.startedAt) : st.mtimeMs;
    const finished = exit && Number.isFinite(Date.parse(exit.finishedAt)) ? Date.parse(exit.finishedAt) : now;
    const entry = { id, cli: cli.toLowerCase(), state, elapsedSeconds: elapsed(started, finished), lastOutput: logTail(logFile, root) };
    const previous = found.get(id);
    if (!previous || st.mtimeMs > previous.mtimeMs) found.set(id, { ...entry, mtimeMs: st.mtimeMs });
  }
  const merged = rows.map((row) => {
    const actual = found.get(row.id);
    if (actual) found.delete(row.id);
    return { ...row, cli: actual ? actual.cli : '', state: actual ? actual.state : row.assignmentState,
      discrepancy: Boolean(actual && actual.state !== row.assignmentState), elapsedSeconds: actual ? actual.elapsedSeconds : null,
      lastOutput: actual ? actual.lastOutput : '' };
  });
  for (const row of found.values()) merged.push({ id: row.id, role: 'sin fila', cliModel: row.cli, dep: '',
    assignmentStatus: '', assignmentState: null, cli: row.cli, state: row.state, discrepancy: false,
    elapsedSeconds: row.elapsedSeconds, lastOutput: row.lastOutput });
  merged.sort((a, b) => STATES.indexOf(a.state) - STATES.indexOf(b.state) || a.id.localeCompare(b.id));
  const counts = Object.fromEntries(STATES.map((state) => [state, merged.filter((row) => row.state === state).length]));
  return { project: path.basename(project), generatedAt: new Date(now).toISOString(),
    now: { text: nowFile ? nowFile.text.split(/\r?\n/).slice(0, 12).map(clean).join('\n') : '(sin now.md: el orquestador no ha escrito su estado)',
      ageSeconds: nowFile ? elapsed(nowFile.mtimeMs, now) : null },
    counts, total: merged.length, completed: counts.done, rows: merged };
}

function duration(seconds) {
  if (seconds === null) return '-';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}

function clip(value, width, ascii) {
  const s = ascii ? String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]/g, '?') : String(value);
  if (s.length <= width) return s;
  return s.slice(0, Math.max(0, width - (ascii ? 3 : 1))) + (ascii ? '...' : '…');
}

function render(state, options = {}) {
  const width = Math.max(60, Number(options.columns) || 80);
  const ascii = Boolean(options.ascii);
  const color = Boolean(options.color) && !options.noColor && !process.env.NO_COLOR;
  const edge = ascii ? ['+', '-', '|'] : ['┌', '─', '│'];
  const paint = (s, code) => color ? `\x1b[${code}m${s}\x1b[0m` : s;
  const box = (title, lines) => {
    const inner = width - 4;
    const top = edge[0] + edge[1].repeat(width - 2) + (ascii ? '+' : '┐');
    const bottom = (ascii ? '+' : '└') + edge[1].repeat(width - 2) + (ascii ? '+' : '┘');
    return [top, ...[title, ...lines].map((line) => `${edge[2]} ${clip(line, inner, ascii).padEnd(inner)} ${edge[2]}`), bottom];
  };
  const filled = state.total ? Math.round(10 * state.completed / state.total) : 0;
  const bar = (ascii ? '#' : '█').repeat(filled) + (ascii ? '.' : '░').repeat(10 - filled);
  const output = [clip(`inharness status  ${clean(state.project)}  ${state.generatedAt}`, width, ascii)];
  const progress = `[${bar}] ${state.completed}/${state.total}`;
  const counters = STATES.map((s) => `${s}:${state.counts[s]}`).join(' ');
  if (`${progress}  ${counters}`.length <= width) output.push(`${progress}  ${counters}`);
  else output.push(progress, clip(counters, width, ascii));
  output.push('');
  output.push(...box(`AHORA MISMO  (${state.now.ageSeconds === null ? 'sin fecha' : `hace ${duration(state.now.ageSeconds)}`})`, state.now.text.split('\n')));
  output.push('');
  const narrow = width < 70;
  const sizes = narrow ? [10, 14, 14, 8] : [12, 18, 18, 10];
  const tailWidth = width - sizes.reduce((a, b) => a + b, 0);
  output.push(clip('ID'.padEnd(sizes[0]) + 'ESTADO'.padEnd(sizes[1]) + 'CLI/MODELO'.padEnd(sizes[2]) + 'TIEMPO'.padEnd(sizes[3]) + 'ULTIMA SALIDA', width, ascii));
  for (const row of state.rows.slice(0, 15)) {
    const [symbol, plain, code] = SYMBOLS[row.state] || SYMBOLS.pending;
    const badge = `${ascii ? plain : symbol} ${row.state}${row.discrepancy ? ' !' : ''}`;
    const line = clip(clean(row.id), sizes[0] - 2, ascii).padEnd(sizes[0])
      + paint(clip(badge, sizes[1] - 2, ascii).padEnd(sizes[1]), code)
      + clip(clean(row.cliModel || row.cli || '-'), sizes[2] - 2, ascii).padEnd(sizes[2])
      + clip(duration(row.elapsedSeconds), sizes[3] - 1, ascii).padEnd(sizes[3])
      + clip(clean(row.role === 'sin fila' ? `sin fila: ${row.lastOutput}` : row.lastOutput || row.assignmentStatus || '-'), tailWidth, ascii);
    output.push(line);
  }
  if (state.rows.length > 15) output.push(ascii ? `... y ${state.rows.length - 15} mas` : `… y ${state.rows.length - 15} más`);
  if (state.rows.some((row) => row.discrepancy)) output.push('! estado del log distinto de assignment.md');
  return output.join('\n') + '\n';
}

function parseStatusArgs(argv) {
  const options = { watch: false, interval: 5, cwd: process.cwd(), json: false, ascii: false, noColor: false };
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help' || token === '-h') return { help: true };
    if (!['--watch', '--interval', '--cwd', '--json', '--ascii', '--no-color'].includes(token)) throw new Error(`opcion desconocida: ${token}`);
    if (seen.has(token)) throw new Error(`opcion repetida: ${token}`);
    seen.add(token);
    if (token === '--interval' || token === '--cwd') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`falta valor de ${token}`);
      if (token === '--interval') {
        if (!/^(?:\d+)(?:\.\d+)?$/.test(value) || Number(value) <= 0 || Number(value) > 3600) throw new Error('--interval debe ser mayor que 0 y hasta 3600 segundos');
        options.interval = Number(value);
      } else options.cwd = value;
    } else options[token === '--no-color' ? 'noColor' : token.slice(2)] = true;
  }
  if (!options.cwd || options.cwd.includes('\0')) throw new Error('--cwd invalido');
  try { if (!fs.statSync(options.cwd).isDirectory()) throw new Error(); }
  catch { throw new Error('--cwd no existe o no es un directorio'); }
  return options;
}

function statusExit(argv, io = { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin }) {
  let options;
  try { options = parseStatusArgs(argv); } catch (error) {
    io.stderr.write(`inharness status: ${error.message}\nUse inharness status --help.\n`);
    return 2;
  }
  if (options.help) { io.stdout.write(HELP); return 0; }
  const snapshot = () => collectState(options.cwd);
  if (options.json) { io.stdout.write(`${JSON.stringify(snapshot())}\n`); return 0; }
  const locale = process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || process.env.PYTHONIOENCODING;
  const draw = () => io.stdout.write(render(snapshot(), { columns: io.stdout.columns, ascii: options.ascii || Boolean(locale && !/utf-?8/i.test(locale)),
    color: io.stdout.isTTY, noColor: options.noColor }));
  if (!options.watch || !io.stdout.isTTY) {
    if (options.watch && !io.stdout.isTTY) io.stderr.write('inharness status: --watch requiere stdout TTY; se imprime una sola vez.\n');
    draw();
    return 0;
  }
  io.stdout.write('\x1b[?1049h\x1b[?25l');
  const refresh = () => { io.stdout.write('\x1b[H\x1b[2J'); draw(); };
  const restore = () => {
    clearInterval(timer);
    io.stdout.write('\x1b[?25h\x1b[?1049l');
    if (io.stdin.isTTY) { io.stdin.setRawMode(false); io.stdin.pause(); }
    io.stdin.removeListener('data', onKey);
    process.removeListener('SIGINT', restore);
  };
  const onKey = (chunk) => { if (/[q\x03]/i.test(String(chunk))) restore(); };
  refresh();
  const timer = setInterval(refresh, options.interval * 1000);
  if (io.stdin.isTTY) { io.stdin.setRawMode(true); io.stdin.resume(); io.stdin.on('data', onKey); }
  process.on('SIGINT', restore);
  return 0;
}

module.exports = { parseAssignment, normalizeState, collectState, redact, render, parseStatusArgs, statusExit, HELP };
