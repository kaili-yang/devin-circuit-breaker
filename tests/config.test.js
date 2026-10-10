'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cfg = require('../lib/config');

let home, project;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-home-'));
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-proj-'));
  process.env.CIRCUIT_BREAKER_HOME = home; // never touch the real ~/.config
});
afterEach(() => {
  delete process.env.CIRCUIT_BREAKER_HOME;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
});
const env = (extra = {}) => ({ CIRCUIT_BREAKER_HOME: home, ...extra });
const writeJson = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); };

test('defaults when nothing is configured', () => {
  const { config, sources, errors } = cfg.loadConfig(project, env());
  assert.equal(config.mode, 'enforce');
  assert.equal(config.limits.costUsd, 10);
  assert.deepEqual(sources, ['defaults']);
  assert.deepEqual(errors, []);
});

test('precedence: user < project < env', () => {
  writeJson(cfg.userConfigPath(), { mode: 'warn', limits: { costUsd: 20, minutes: 5 } });
  writeJson(cfg.projectConfigPath(project), { limits: { costUsd: 3 } });
  let { config, sources } = cfg.loadConfig(project, env());
  assert.equal(config.mode, 'warn');          // from user
  assert.equal(config.limits.costUsd, 3);     // project wins
  assert.equal(config.limits.minutes, 5);     // user preserved
  assert.equal(sources.length, 3);
  ({ config } = cfg.loadConfig(project, env({ CIRCUIT_BREAKER_MAX_COST: '1.5', CIRCUIT_BREAKER_MODE: 'observe', CIRCUIT_BREAKER_LOOP: '3' })));
  assert.equal(config.limits.costUsd, 1.5);
  assert.equal(config.mode, 'observe');
  assert.equal(config.loop.blockAt, 3);
  assert.equal(config.loop.warnAt, 2);
});

test('invalid merged config fails safe to observe-mode defaults', () => {
  const { config, errors } = cfg.loadConfig(project, env({ CIRCUIT_BREAKER_MODE: 'explode' }));
  assert.ok(errors.length > 0);
  assert.equal(config.mode, 'observe');
});

test('malformed JSON file is ignored, not fatal', () => {
  fs.mkdirSync(path.dirname(cfg.projectConfigPath(project)), { recursive: true });
  fs.writeFileSync(cfg.projectConfigPath(project), '{ nope');
  assert.equal(cfg.loadConfig(project, env()).config.mode, 'enforce');
});

test('setConfigValue writes dotted keys with coercion and validates', () => {
  const f = cfg.projectConfigPath(project);
  cfg.setConfigValue(f, 'limits.costUsd', '5');
  cfg.setConfigValue(f, 'mode', 'warn');
  cfg.setConfigValue(f, 'loop.exemptCommands', '["pytest"]');
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { limits: { costUsd: 5 }, mode: 'warn', loop: { exemptCommands: ['pytest'] } });
  assert.throws(() => cfg.setConfigValue(f, 'loop.blockAt', '1'), /blockAt/);
  assert.throws(() => cfg.setConfigValue(f, 'mode', 'yolo'), /mode/);
});
