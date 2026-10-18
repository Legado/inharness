'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SYNC = path.join(__dirname, '..', 'src', 'syncSkills.js');

test('reinstala una skill cambiada aunque lleve el marcador de la version actual', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'inharness-sync-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const sync = () => spawnSync(process.execPath, ['-e', `require(${JSON.stringify(SYNC)}).syncSkills({ silent: true })`],
    { env, encoding: 'utf8' });
  assert.equal(sync().status, 0);
  const dest = path.join(home, '.claude', 'skills', 'inharness', 'SKILL.md');
  const fresh = fs.readFileSync(dest, 'utf8');
  assert.match(fresh, /REGLA DURA/);
  fs.writeFileSync(dest, fresh.replace('REGLA DURA', 'texto viejo'));
  assert.equal(sync().status, 0);
  assert.equal(fs.readFileSync(dest, 'utf8'), fresh);
});
