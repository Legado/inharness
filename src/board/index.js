'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { findWindowsTerminal } = require('../paneLauncher');
const { getProcesses } = require('./procs');
const { collectBoard } = require('./collect');
const { render, SCREENS } = require('./render');

const HELP = `Uso: inharness board [--open] [--once] [--json] [--screen resumen|agentes|plan|registro] [--interval <s>] [--cwd <dir>] [--ascii] [--no-color]
       inharness dashboard [las mismas opciones]

1-4 pantallas; Tab siguiente; p pausa; r refresca; d completadas; t periodo; ? ayuda; q o Ctrl+C sale.
En REGISTRO: flechas o j/k eligen fila; Enter abre el log; Esc vuelve.
`;
function parseBoardArgs(argv) {
  const options = { cwd: process.cwd(), interval: 2, screen: 'resumen', open: false, once: false, json: false, ascii: false, noColor: false };
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help' || token === '-h') return { help: true };
    if (!['--cwd', '--interval', '--screen', '--open', '--once', '--json', '--ascii', '--no-color'].includes(token) || seen.has(token)) throw new Error(`opcion invalida o repetida: ${token}`);
    seen.add(token);
    if (['--cwd', '--interval', '--screen'].includes(token)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`falta valor de ${token}`);
      options[token.slice(2)] = value;
    } else options[token === '--no-color' ? 'noColor' : token.slice(2)] = true;
  }
  if (!/^(?:\d+)(?:\.\d+)?$/.test(String(options.interval)) || Number(options.interval) <= 0 || Number(options.interval) > 3600) throw new Error('--interval debe ser mayor que 0 y hasta 3600');
  options.interval = Number(options.interval);
  if (!SCREENS.includes(options.screen)) throw new Error('--screen invalida');
  try { if (options.cwd.includes('\0') || !fs.statSync(options.cwd).isDirectory()) throw new Error(); }
  catch { throw new Error('--cwd invalido'); }
  if (options.open && (options.once || options.json)) throw new Error('--open no se combina con --once o --json');
  return options;
}
function boardExit(argv, io = { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin }) {
  let options;
  try { options = parseBoardArgs(argv); }
  catch (error) { io.stderr.write(`inharness board: ${error.message}\n`); return 2; }
  if (options.help) { io.stdout.write(HELP); return 0; }
  if (options.open) {
    const args = [path.join(__dirname, '..', '..', 'bin', 'inharness.js'), 'board', '--cwd', path.resolve(options.cwd), '--interval', String(options.interval)];
    if (options.ascii) args.push('--ascii');
    if (options.noColor) args.push('--no-color');
    if (options.screen !== 'resumen') args.push('--screen', options.screen);
    const wt = findWindowsTerminal();
    if (!wt) { io.stdout.write(`Abre otra terminal y ejecuta: ${[process.execPath, ...args].map((s) => `"${s.replace(/"/g, '\\"')}"`).join(' ')}\n`); return 0; }
    try {
      const child = spawn(wt, ['-w', 'inharness', 'new-tab', '--title', 'inharness board', process.execPath, ...args],
        { cwd: path.resolve(options.cwd), stdio: 'ignore', detached: true, windowsHide: false });
      child.on('error', () => io.stderr.write('inharness board: no se pudo abrir Windows Terminal\n'));
      child.unref();
      io.stdout.write('Tablero abierto en una pestana de Windows Terminal.\n');
      return 0;
    } catch (error) { io.stderr.write(`inharness board: ${error.message}\n`); return 1; }
  }
  const snapshot = () => collectBoard(options.cwd, Date.now(), { processes: getProcesses() });
  if (options.json) { io.stdout.write(`${JSON.stringify(snapshot())}\n`); return 0; }
  let selected = 0;
  let openLog = false;
  let help = false;
  let showDone = false;
  let period = '12h';
  const draw = () => render(snapshot(), { screen: options.screen, columns: io.stdout.columns || 80, rows: io.stdout.rows || 24,
    ascii: options.ascii, color: Boolean(io.stdout.isTTY) && !options.noColor, selected, openLog, help, showDone, period });
  if (options.once || !io.stdout.isTTY || !io.stdin || !io.stdin.isTTY) { io.stdout.write(draw()); return 0; }
  let paused = false;
  let closed = false;
  let timer;
  const refresh = () => {
    if (closed) return;
    io.stdout.write('\x1b[H\x1b[2J');
    io.stdout.write(draw());
  };
  const restore = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    io.stdin.removeListener('data', onKey);
    process.removeListener('SIGINT', restore);
    if (io.stdin.setRawMode) io.stdin.setRawMode(false);
    io.stdin.pause();
    io.stdout.write('\x1b[?25h\x1b[?1049l');
  };
  const onKey = (chunk) => {
    const key = String(chunk);
    if (key === 'q' || key === '\x03') { restore(); return; }
    if (key === '?') help = !help;
    else if (key === '\t') { options.screen = SCREENS[(SCREENS.indexOf(options.screen) + 1) % SCREENS.length]; help = false; }
    else if (/^[1-4]$/.test(key)) { options.screen = SCREENS[Number(key) - 1]; help = false; }
    else if (key === 'p') paused = !paused;
    else if (key === 'd' && options.screen === 'agentes') showDone = !showDone;
    else if (key === 't' && options.screen === 'plan') period = { '12h': '1h', '1h': 'todo', todo: '12h' }[period];
    else if (key === '\r' && options.screen === 'registro') openLog = true;
    else if (key === '\x1b') openLog = false;
    else if (options.screen === 'registro' && (key === 'j' || key === '\x1b[B')) selected = Math.min(Math.max(0, snapshot().rows.length - 1), selected + 1);
    else if (options.screen === 'registro' && (key === 'k' || key === '\x1b[A')) selected = Math.max(0, selected - 1);
    if (key === 'r' || key !== 'p') refresh();
  };
  io.stdout.write('\x1b[?1049h\x1b[?25l');
  io.stdin.setRawMode(true);
  io.stdin.resume();
  io.stdin.on('data', onKey);
  process.on('SIGINT', restore);
  refresh();
  timer = setInterval(() => { if (!paused) refresh(); }, options.interval * 1000);
  return 0;
}

module.exports = { boardExit, parseBoardArgs, HELP };
