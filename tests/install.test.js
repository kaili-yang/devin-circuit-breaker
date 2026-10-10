'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { install, uninstall, EVENTS } = require('../lib/install');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cb-inst-'));
const read = (p) => JSON.parse(fs.readFileSync(path.join(p, '.devin', 'hooks.v1.json'), 'utf8'));

test('install registers all events; re-install is idempotent', () => {
  const p = tmp();
  install(p, '/opt/circuit-breaker');
  install(p, '/opt/circuit-breaker');
  const doc = read(p);
  for (const ev of EVENTS) {
    assert.equal(doc[ev].length, 1);
    assert.match(doc[ev][0].hooks[0].command, /^CIRCUIT_BREAKER_HOOK=1 node "\/opt\/circuit-breaker\/bin\/hook\.js"$/);
  }
});

test('install preserves foreign hooks; uninstall removes only ours', () => {
  const p = tmp();
  fs.mkdirSync(path.join(p, '.devin'));
  const foreign = { PreToolUse: [{ matcher: 'exec', hooks: [{ type: 'command', command: './audit.sh' }] }], Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'echo bye' }] }] };
  fs.writeFileSync(path.join(p, '.devin', 'hooks.v1.json'), JSON.stringify(foreign));
  install(p, '/opt/cb');
  let doc = read(p);
  assert.equal(doc.PreToolUse.length, 2);
  assert.equal(doc.PreToolUse[0].hooks[0].command, './audit.sh');
  assert.equal(doc.Stop.length, 1);
  const r = uninstall(p);
  assert.equal(r.removed, true);
  doc = read(p);
  assert.deepEqual(doc, foreign);
});

test('uninstall deletes the file when nothing else remains', () => {
  const p = tmp();
  install(p, '/opt/cb');
  uninstall(p);
  assert.equal(fs.existsSync(path.join(p, '.devin', 'hooks.v1.json')), false);
});

test('install path uses forward slashes even when given backslashes', () => {
  const p = tmp();
  const r = install(p, path.join('C:', 'plugins', 'circuit-breaker'));
  assert.doesNotMatch(r.command, /\\/);
});
