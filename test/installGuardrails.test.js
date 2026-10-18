'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { installGuardrails } = require('../src/installGuardrails');
const { runtimeDir } = require('../src/installRuntime');

function withHome(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inharness-install-'));
  const oldHome = process.env.HOME;
  const oldProfile = process.env.USERPROFILE;
  const oldOptOut = process.env.INHARNESS_NO_GUARDRAILS;
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  delete process.env.INHARNESS_NO_GUARDRAILS;
  t.after(() => {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
    if (oldOptOut === undefined) delete process.env.INHARNESS_NO_GUARDRAILS; else process.env.INHARNESS_NO_GUARDRAILS = oldOptOut;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function config(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }

test('instalacion limpia crea Claude y deja Codex ausente', (t) => {
  const home = withHome(t);
  assert.deepEqual(installGuardrails({ silent: true }), ['claude']);
  const claude = path.join(home, '.claude', 'settings.json');
  assert.equal(config(claude).hooks.PreToolUse[0].hooks[0].timeout, 5);
  assert.equal(fs.existsSync(`${claude}.bak-inharness`), false);
  assert.equal(fs.existsSync(path.join(home, '.codex', 'hooks.json')), false);
});

test('instala Claude y Codex, preserva hooks ajenos y no reescribe', (t) => {
  const home = withHome(t);
  const claude = path.join(home, '.claude', 'settings.json');
  const codex = path.join(home, '.codex', 'hooks.json');
  fs.mkdirSync(path.dirname(claude));
  fs.mkdirSync(path.dirname(codex));
  const unrelated = { matcher: 'Read', hooks: [{ type: 'command', command: 'echo other' }] };
  fs.writeFileSync(claude, `\uFEFF${JSON.stringify({ hooks: { PreToolUse: [unrelated] }, custom: true })}`);
  fs.writeFileSync(codex, JSON.stringify({ hooks: { PreToolUse: [unrelated] }, custom: true }));
  assert.deepEqual(installGuardrails({ silent: true }), ['claude', 'codex']);
  for (const [file, marker, matcher] of [[claude, 'claudeGuardHook.js', 'Bash'], [codex, 'codexPreToolUse.cjs', '^Bash$']]) {
    const data = config(file);
    assert.equal(data.custom, true);
    assert.deepEqual(data.hooks.PreToolUse[0], unrelated);
    const group = data.hooks.PreToolUse[1];
    assert.equal(group.matcher, matcher);
    assert.match(group.hooks[0].command, new RegExp(marker));
    assert.ok(group.hooks[0].command.includes(runtimeDir().replace(/\\/g, '/')));
    assert.ok(fs.existsSync(`${file}.bak-inharness`));
  }
  assert.match(config(codex).hooks.PreToolUse[1].hooks[0].commandWindows, /; exit \$LASTEXITCODE$/);
  assert.ok(config(codex).hooks.PreToolUse[1].hooks[0].commandWindows.includes(process.execPath));
  const before = [fs.statSync(claude).mtimeMs, fs.statSync(codex).mtimeMs];
  const backups = [fs.readFileSync(`${claude}.bak-inharness`), fs.readFileSync(`${codex}.bak-inharness`)];
  assert.deepEqual(installGuardrails({ silent: true }), []);
  assert.deepEqual([fs.statSync(claude).mtimeMs, fs.statSync(codex).mtimeMs], before);
  assert.deepEqual([fs.readFileSync(`${claude}.bak-inharness`), fs.readFileSync(`${codex}.bak-inharness`)], backups);
});

test('migra rutas antiguas dentro del grupo y conserva sus otros campos', (t) => {
  const home = withHome(t);
  for (const [dir, file, marker, matcher] of [['.claude', 'settings.json', 'claudeGuardHook.js', 'Bash'], ['.codex', 'hooks.json', 'codexPreToolUse.cjs', '^Bash$']]) {
    const target = path.join(home, dir, file);
    fs.mkdirSync(path.dirname(target));
    fs.writeFileSync(target, JSON.stringify({ hooks: { PreToolUse: [{ matcher, custom: 7, hooks: [{ type: 'command', command: `node "/old/${marker}"`, commandWindows: `old/${marker}`, timeout: dir === '.claude' ? 5 : 10 }, { type: 'command', command: 'echo other' }] }] } }));
  }
  assert.deepEqual(installGuardrails({ silent: true }), ['claude', 'codex']);
  for (const [dir, file, marker] of [['.claude', 'settings.json', 'claudeGuardHook.js'], ['.codex', 'hooks.json', 'codexPreToolUse.cjs']]) {
    const group = config(path.join(home, dir, file)).hooks.PreToolUse[0];
    assert.equal(group.custom, 7);
    assert.equal(group.hooks.length, 2);
    assert.equal(group.hooks[1].command, 'echo other');
    assert.ok(group.hooks[0].command.includes(runtimeDir().replace(/\\/g, '/')));
    assert.ok(group.hooks[0].command.includes(marker));
    assert.ok(group.hooks[0].commandWindows.includes(runtimeDir().replace(/\\/g, '/')));
  }
});

test('JSON corrupto se conserva, opt-out no toca nada, Codex ausente no se crea', (t) => {
  const home = withHome(t);
  const claude = path.join(home, '.claude', 'settings.json');
  const codex = path.join(home, '.codex', 'hooks.json');
  fs.mkdirSync(path.dirname(claude));
  fs.mkdirSync(path.dirname(codex));
  fs.writeFileSync(claude, '{bad');
  fs.writeFileSync(codex, '{bad');
  const oldWarn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(message);
  try { assert.deepEqual(installGuardrails({ silent: true }), []); } finally { console.warn = oldWarn; }
  assert.equal(fs.readFileSync(claude, 'utf8'), '{bad');
  assert.equal(fs.readFileSync(codex, 'utf8'), '{bad');
  assert.equal(warnings.length, 2);
  process.env.INHARNESS_NO_GUARDRAILS = '1';
  assert.deepEqual(installGuardrails({ silent: true }), []);
  assert.equal(fs.readFileSync(claude, 'utf8'), '{bad');
});

test('regresion: $ y ` en HOME no se expanden en la shell del hook', (t) => {
  const home = path.join(withHome(t), 'h$x`y');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'hooks.json'), '{}');
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  require('../src/installRuntime').installRuntime({ silent: true });
  assert.deepEqual(installGuardrails({ silent: true }), ['claude', 'codex']);
  const hook = config(path.join(home, '.codex', 'hooks.json')).hooks.PreToolUse[0].hooks[0];
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } });
  const run = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', hook.commandWindows], { input, encoding: 'utf8' })
    : spawnSync('/bin/sh', ['-c', hook.command], { input, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
});
