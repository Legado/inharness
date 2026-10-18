'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/**
 * Instala, de forma idempotente, los guardarraíles técnicos que impiden
 * invocar Codex/Kimi crudo por Bash mientras hay una delegación activa de
 * inharness (ver Paso 3 de las skills). Esto NO es una instrucción de
 * prompt que un orquestador pueda olvidar seguir — es un hook real que
 * bloquea la llamada antes de que se ejecute.
 *
 * - Claude Code: hook PreToolUse en ~/.claude/settings.json (verificado en
 *   vivo: bloquea de inmediato, sin reinicio).
 * - Codex: hook PreToolUse en ~/.codex/hooks.json, verificado empíricamente
 *   contra el app-server real (ver .inharness/codex-hooks-investigation/).
 *   OJO: un hook nuevo queda "untrusted" la primera vez — Codex no lo
 *   ejecuta hasta que el usuario lo confirma en `/hooks` dentro de una
 *   sesión de Codex. Esto no se puede automatizar (es una puerta de
 *   seguridad deliberada de Codex), así que esta función deja el hook
 *   instalado pero avisa de ese paso pendiente.
 * - Kimi Code: no tiene mecanismo de hooks hoy. No hay guardarraíl técnico
 *   posible para Kimi todavía — solo queda la regla de prompt en su skill.
 *
 * Nunca sobreescribe hooks ajenos: lee, comprueba si el guard de inharness
 * ya está presente (por una marca en el propio comando), y si no lo está,
 * lo añade preservando el resto. En Codex, hace un backup de una sola vez
 * (`hooks.json.bak-inharness`) antes de la primera escritura.
 */

const CLAUDE_GUARD_MARKER = 'claudeGuardHook.js';
const CODEX_GUARD_MARKER = 'codexPreToolUse.cjs';

function repoRoot() {
  return path.join(__dirname, '..');
}

function readJsonSafe(filePath) {
  try {
    return { ok: true, data: JSON.parse(fs.readFileSync(filePath, 'utf8')) };
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: true, data: null };
    return { ok: false, error: err };
  }
}

function hasGuard(preToolUseGroups, matcher, marker) {
  return (preToolUseGroups || []).some(
    (group) =>
      group.matcher === matcher &&
      (group.hooks || []).some((h) => h.type === 'command' && h.command && h.command.includes(marker)),
  );
}

/** Devuelve true si instaló/actualizó algo, false si ya estaba o no se pudo. */
function installClaudeGuard() {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  const read = readJsonSafe(settingsPath);
  if (!read.ok) {
    console.warn(`inharness: no se pudo leer ${settingsPath} (${read.error.message}) - hook de Claude no instalado`);
    return false;
  }
  const settings = read.data || {};
  settings.hooks = settings.hooks || {};
  settings.hooks.PreToolUse = settings.hooks.PreToolUse || [];
  if (hasGuard(settings.hooks.PreToolUse, 'Bash', CLAUDE_GUARD_MARKER)) return false;

  const guardPath = path.join(repoRoot(), 'src', 'claudeGuardHook.js').replace(/\\/g, '/');
  settings.hooks.PreToolUse.push({
    matcher: 'Bash',
    hooks: [{ type: 'command', command: `node "${guardPath}"`, timeout: 5 }],
  });

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return true;
}

/** Devuelve true si instaló/actualizó algo, false si ya estaba, no hay Codex, o no se pudo. */
function installCodexGuard() {
  const codexDir = path.join(os.homedir(), '.codex');
  const hooksPath = path.join(codexDir, 'hooks.json');
  const backupPath = path.join(codexDir, 'hooks.json.bak-inharness');

  const read = readJsonSafe(hooksPath);
  if (!read.ok) {
    console.warn(`inharness: no se pudo leer ${hooksPath} (${read.error.message}) - hook de Codex no instalado`);
    return false;
  }
  if (read.data === null) return false; // Codex no usa hooks.json en esta maquina; no forzar su creacion

  const config = read.data;
  config.hooks = config.hooks || {};
  config.hooks.PreToolUse = config.hooks.PreToolUse || [];
  if (hasGuard(config.hooks.PreToolUse, '^Bash$', CODEX_GUARD_MARKER)) return false;

  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(hooksPath, backupPath);
  }

  const guardPathPosix = path.join(repoRoot(), 'src', 'codexPreToolUse.cjs').replace(/\\/g, '/');
  const guardPathWin = path.join(repoRoot(), 'src', 'codexPreToolUse.cjs');
  config.hooks.PreToolUse.push({
    matcher: '^Bash$',
    hooks: [
      {
        type: 'command',
        command: `node "${guardPathPosix}"`,
        commandWindows: `& "${process.execPath}" "${guardPathWin}"; exit $LASTEXITCODE`,
        timeout: 10,
        statusMessage: 'inharness: comprobar delegacion activa',
      },
    ],
  });

  fs.writeFileSync(hooksPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return true;
}

function installGuardrails({ silent = false } = {}) {
  const installed = [];
  if (installClaudeGuard()) installed.push('claude');
  if (installCodexGuard()) installed.push('codex');

  if (installed.length && !silent) {
    console.log(`inharness: guardarrailes PreToolUse instalados/actualizados en: ${installed.join(', ')}`);
    if (installed.includes('codex')) {
      console.log(
        'inharness: en Codex, el hook nuevo queda "untrusted" hasta que lo confirmes dentro de una sesion de Codex con /hooks - sin eso no se ejecuta.',
      );
    }
  }
  return installed;
}

module.exports = { installGuardrails, installClaudeGuard, installCodexGuard };
