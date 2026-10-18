'use strict';

/**
 * Logica compartida entre los guards de Claude Code (src/claudeGuardHook.js)
 * y Codex (src/codexPreToolUse.cjs). Un solo sitio para decidir "es una
 * invocacion cruda prohibida" y "hay una delegacion activa" evita que las
 * dos implementaciones diverjan con el tiempo.
 *
 * Verificado empiricamente contra Codex 0.160.0 real (ver
 * .inharness/codex-hooks-investigation/REPORT.md de la auditoria): el
 * parser de "fila activa" por columna de tabla (en vez de buscar palabras
 * sueltas como "en curso") sobrevive a reordenar columnas y a estados en
 * texto libre ("parcial", "hecho, commit ..."), y es el que de verdad se
 * probo contra el hook real.
 */

const fs = require('node:fs');
const path = require('node:path');

const BLOCK_MESSAGE = 'inharness: hay una delegacion activa; usa node ~/.inharness/runtime/runRow.js launch --id <id> --cli <codex|kimi> ... (ver las skills). Salida de emergencia: INHARNESS_ALLOW_RAW=1. La delegacion caduca a las 12 h.';

function segments(command) {
  const result = [];
  let segment = '';
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (char === quote) { quote = null; segment += char; continue; }
    if (!quote && (char === '"' || char === "'")) { quote = char; segment += char; continue; }
    if ((!quote || quote === '"') && command.slice(i, i + 2) === '$(') {
      result.push(segment); segment = ''; i++; continue;
    }
    if (!quote && /[;&|\r\n`()]/.test(char)) {
      result.push(segment); segment = ''; continue;
    }
    segment += char;
  }
  result.push(segment);
  return result;
}

function tokens(segment) {
  return segment.match(/"[^"]*"|'[^']*'|[^\s]+/g) || [];
}

const WRAPPERS = new Set(['npx', 'timeout', 'time', 'nohup', 'command', 'exec', 'sudo', 'nice', 'stdbuf']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'cmd', 'powershell', 'pwsh']);
const unquote = (word) => word.replace(/^["']|["']$/g, '');

function exeName(word) {
  return unquote(word).replace(/\\/g, '/').split('/').pop().replace(/\.(?:cmd|exe|ps1|js|mjs|cjs)$/i, '').toLowerCase();
}

/** true si el primer ejecutable de algun segmento invoca Codex o Kimi crudo. */
function isRawInvocation(command, depth = 0) {
  if (typeof command !== 'string' || depth > 3) return false;
  if (/paneLauncher|runRow/i.test(command) || command.includes('INHARNESS_ALLOW_RAW=1')) return false;
  for (const segment of segments(command)) {
    const words = tokens(segment.trim());
    for (;;) {
      if (!words.length) break;
      const head = exeName(words[0]);
      if (/^[A-Za-z_][A-Za-z_0-9]*=/.test(words[0]) || head === 'env') { words.shift(); continue; }
      if (WRAPPERS.has(head) || head === 'node') {
        words.shift();
        // opciones y duraciones del envoltorio (timeout 600, npx -y, nice -n 5)
        while (words.length && (/^-/.test(words[0]) || /^\d+[smhd]?$/.test(words[0]))) words.shift();
        continue;
      }
      break;
    }
    if (!words.length) continue;
    const executable = exeName(words.shift());
    if (SHELLS.has(executable)) {
      const at = words.findIndex((word) => /^(?:-c|-lc|-command|\/c)$/i.test(word));
      if (at !== -1 && words[at + 1] && isRawInvocation(unquote(words.slice(at + 1).join(' ')), depth + 1)) return true;
      continue;
    }
    if (executable === 'codex') {
      const sub = words.find((word) => !word.startsWith('-') && !/^\d+$/.test(word) && !/^(?:gpt|o\d)/.test(word));
      if (/^(?:exec|e)$/.test(sub || '')) return true;
    }
    if (executable === 'kimi' && words.some((word) => /^(?:-p|--prompt)(?:=.*)?$/.test(word))) return true;
  }
  return false;
}

/**
 * true si el markdown de assignment.md tiene alguna fila cuyo estado no
 * sea terminal ("hecho"/"fallido" al inicio, admite sufijos como "hecho,
 * commit 5066029"). Busca la columna "estado" por cabecera, no por
 * posicion fija - sobrevive a que la tabla cambie de orden de columnas.
 * Ignora filas de separador (---|---) y resetea la columna detectada al
 * salir de un bloque de tabla (soporta varias tablas en el mismo fichero).
 */
function hasActiveRows(markdown) {
  if (!/^\s*\|.*\bestado\b/im.test(markdown)) {
    // Sin tabla con columna estado (reparto en texto libre): cualquier fila con id (F2, R1...) en curso/pendiente cuenta.
    return markdown.split(/\r?\n/).some((line) => /^\s*[-*]?\s*[A-Za-z]{1,3}\d+\b/.test(line) && /\b(?:en curso|pendiente)\b/i.test(line));
  }
  let statusColumn = -1;
  for (const line of markdown.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) {
      statusColumn = -1;
      continue;
    }
    const cells = line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim());
    const headerColumn = cells.findIndex((cell) => cell.toLowerCase() === 'estado');
    if (headerColumn !== -1) {
      statusColumn = headerColumn;
      continue;
    }
    if (statusColumn === -1 || cells.every((cell) => /^:?-+:?$/.test(cell))) continue;
    const status = cells[statusColumn] || '';
    if (!/^(?:hecho|fallido)\b/i.test(status)) return true;
  }
  return false;
}

/** true si cwd tiene un assignment reciente con alguna fila activa. */
function hasActiveDelegation(cwd, { now = Date.now(), staleMs } = {}) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return false;
  const assignmentPath = path.join(cwd, '.inharness', 'assignment.md');
  let markdown;
  try {
    const hours = Number(process.env.INHARNESS_STALE_HOURS);
    const lifetime = staleMs === undefined ? (Number.isFinite(hours) && hours > 0 ? hours : 12) * 60 * 60 * 1000 : staleMs;
    if (now - fs.statSync(assignmentPath).mtimeMs > lifetime) return false;
    markdown = fs.readFileSync(assignmentPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return false;
    throw err;
  }
  return hasActiveRows(markdown);
}

module.exports = { isRawInvocation, hasActiveRows, hasActiveDelegation, BLOCK_MESSAGE };
