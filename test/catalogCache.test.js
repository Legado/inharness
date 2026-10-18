'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeCatalog, readCatalog } = require('../src/catalogCache');

test('catalogo global round trip y lectura defensiva', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'inharness-catalog-'));
  const oldHome = process.env.HOME;
  const oldProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  t.after(() => {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
    fs.rmSync(home, { recursive: true, force: true });
  });
  assert.equal(readCatalog(), null);
  const file = writeCatalog([{ id: 'codex' }]);
  assert.equal(file, path.join(home, '.inharness', 'catalog.json'));
  assert.equal(readCatalog().schemaVersion, 1);
  assert.deepEqual(readCatalog().clis, [{ id: 'codex' }]);
  for (const content of ['{bad', '[]', '{}', '{"clis":{}}']) {
    fs.writeFileSync(file, content);
    assert.equal(readCatalog(), null, content);
  }
});
