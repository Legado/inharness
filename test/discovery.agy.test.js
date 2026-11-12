'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseAgyModels, agyUsesApiKey } = require('../src/discovery');

test('parseAgyModels extrae slugs de la salida de `agy models` e ignora cabeceras', () => {
  const out = 'Available models:\n\n  gemini-3.8-flash-medium  Gemini Flash\n- gemini-3.8-pro-high\nclaude-sonnet-4.6\n';
  assert.deepEqual(parseAgyModels(out).map((m) => m.id), ['gemini-3.8-flash-medium', 'gemini-3.8-pro-high', 'claude-sonnet-4.6']);
  assert.deepEqual(parseAgyModels(''), []);
});

test('agyUsesApiKey detecta API key, ADC y modelProvider=gemini', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'inharness-agy-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  assert.equal(agyUsesApiKey({}, home), false);
  assert.equal(agyUsesApiKey({ GEMINI_API_KEY: 'x' }, home), true);
  assert.equal(agyUsesApiKey({ GOOGLE_API_KEY: 'x' }, home), true);
  assert.equal(agyUsesApiKey({ AGY_ADC_AUTH: 'true' }, home), true);
  const dir = path.join(home, '.gemini', 'antigravity-cli');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ modelProvider: 'gemini' }));
  assert.equal(agyUsesApiKey({}, home), true);
  fs.writeFileSync(path.join(dir, 'settings.json'), '{no json');
  assert.equal(agyUsesApiKey({}, home), false);
});
