'use strict';
// Integration of dispatch + state store + config files (in-process, temp dirs).
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { dispatch } = require('../lib/dispatch');
const { StateStore } = require('../lib/state');
const { projectConfigPath } = require('../lib/config');

let home, project, store;
const SID = 'sess-1';
const T0 = 1_700_000_000_000;
let clock = T0;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-home-'));
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-proj-'));
  process.env.CIRCUIT_BREAKER_HOME = home;
  store = new StateStore(path.join(home, 'sessions'));
  clock = T0;
});
afterEach(() => {
  delete process.env.CIRCUIT_BREAKER_HOME;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
});

const deps = (env = {}) => ({ store, projectDir: project, env: { CIRCUIT_BREAKER_HOME: home, ...env }, now: () => clock });
const configure = (o) => { fs.mkdirSync(path.dirname(projectConfigPath(project)), { recursive: true }); fs.writeFileSync(projectConfigPath(project), JSON.stringify(o)); };
const start = () => dispatch({ hook_event_name: 'SessionStart', session_id: SID }, deps());
const pre = (tool, input) => dispatch({ hook_event_name: 'PreToolUse', session_id: SID, tool_name: tool, tool_input: input }, deps());
const post = (tool, input, ok, output = '') => dispatch({ hook_event_name: 'PostToolUse', session_id: SID, tool_name: tool, tool_input: input, tool_response: { success: ok, output, error: ok ? null : 'boom' } }, deps());
const prompt = (text) => dispatch({ hook_event_name: 'UserPromptSubmit', session_id: SID, prompt: text }, deps());
const ctx = (r) => r.output.hookSpecificOutput && r.output.hookSpecificOutput.additionalContext;

test('SessionStart: fresh state + banner; SessionEnd logs totals', () => {
  const r = start();
  assert.match(ctx(r), /\[circuit-breaker\] armed \(mode=enforce\)/);
  assert.equal(store.load(SID).calls, 0);
  dispatch({ hook_event_name: 'SessionEnd', session_id: SID, reason: 'exit' }, deps());
  assert.deepEqual(store.readEvents().map((e) => e.type), ['session_start', 'session_end']);
});

test('healthy session: nothing emitted, counters accumulate', () => {
  start();
  assert.deepEqual(post('read', { file_path: 'a' }, true, 'x'.repeat(4000)).output, {});
  assert.deepEqual(pre('exec', { command: 'npm test' }).output, {});
  assert.ok(store.load(SID).tokens.read >= 1000);
});

test('dead loop in enforce mode: warn -> trip -> PreToolUse blocked with exit 2', () => {
  configure({ loop: { warnAt: 2, blockAt: 3 } });
  start();
  const fail = () => post('exec', { command: 'npm install', shell_id: String(Math.random()) }, false, 'ERR');
  assert.deepEqual(fail().output, {});
  assert.match(ctx(fail()), /WARNING: the same call has failed 2x: exec:npm install/);
  assert.match(ctx(fail()), /TRIPPED: the same call failed 3x in a row: exec:npm install[\s\S]*BLOCKED/);
  const b = pre('edit', { file_path: 'x' });
  assert.equal(b.output.decision, 'block');
  assert.equal(b.exitCode, 2);
  assert.match(b.output.reason, /loop/);
  // trip is logged once even though the agent keeps failing
  fail();
  assert.equal(store.readEvents().filter((e) => e.type === 'trip').length, 1);
});

test('own CLI is never blocked while open (so reset always works)', () => {
  configure({ loop: { warnAt: 2, blockAt: 2 } });
  post('exec', { command: 'make' }, false); post('exec', { command: 'make' }, false);
  assert.equal(pre('exec', { command: 'ls' }).output.decision, 'block');
  assert.deepEqual(pre('exec', { command: 'node "/plugins/circuit-breaker/bin/cli.js" reset' }).output, {});
});

test('warn mode: trips are reported but never block', () => {
  configure({ mode: 'warn', loop: { warnAt: 2, blockAt: 2 } });
  post('exec', { command: 'make' }, false);
  assert.match(ctx(post('exec', { command: 'make' }, false)), /TRIPPED[\s\S]*mode=warn, not blocking/);
  assert.deepEqual(pre('exec', { command: 'make' }).output, {});
});

test('observe mode: silent, but the audit log records the trip', () => {
  configure({ mode: 'observe', loop: { warnAt: 2, blockAt: 2 } });
  post('exec', { command: 'make' }, false);
  assert.deepEqual(post('exec', { command: 'make' }, false).output, {});
  assert.deepEqual(pre('exec', {}).output, {});
  assert.equal(store.readEvents().filter((e) => e.type === 'trip').length, 1);
});

test('cost cap (estimate) trips and blocks', () => {
  configure({ limits: { costUsd: 1 }, pricing: { inputUsdPerMTok: 1_000_000, outputUsdPerMTok: 0, charsPerToken: 1 } });
  assert.match(ctx(post('read', { file_path: 'big' }, true, 'z'.repeat(2))), /estimated cost \$2\.00 >= limit \$1\.00/);
  assert.equal(pre('read', {}).exitCode, 2);
});

test('time limit trips once the session exceeds limits.minutes', () => {
  configure({ limits: { minutes: 10 } });
  start();
  clock = T0 + 11 * 60_000;
  const r = post('exec', { command: 'ls' }, true);
  assert.match(ctx(r), /session running 11 min > limit 10 min/);
  assert.equal(pre('exec', {}).exitCode, 2);
});

test('chat override: "circuit breaker override" -> half-open, tools allowed, re-trip re-opens', () => {
  configure({ loop: { warnAt: 2, blockAt: 2 } });
  post('exec', { command: 'make' }, false); post('exec', { command: 'make' }, false);
  assert.equal(pre('exec', {}).exitCode, 2);
  assert.match(ctx(prompt('ok, circuit breaker override and try yarn')), /Override accepted \(was open: loop\)/);
  assert.equal(pre('exec', {}).exitCode, 0);
  assert.equal(store.load(SID).status, 'half_open');
  assert.deepEqual(prompt('circuit breaker reset').output, {}); // not open -> ignored
  post('exec', { command: 'make' }, false);
  assert.match(ctx(post('exec', { command: 'make' }, false)), /re-tripped after an override/);
});

test('CIRCUIT_BREAKER_DISABLE=1 is a no-op kill switch', () => {
  const r = dispatch({ hook_event_name: 'SessionStart', session_id: SID }, deps({ CIRCUIT_BREAKER_DISABLE: '1' }));
  assert.deepEqual(r.output, {});
  assert.equal(store.load(SID), null);
});

test('sessions are isolated', () => {
  configure({ loop: { warnAt: 2, blockAt: 2 } });
  post('exec', { command: 'x' }, false); post('exec', { command: 'x' }, false);
  const other = dispatch({ hook_event_name: 'PreToolUse', session_id: 'other', tool_name: 'exec', tool_input: {} }, deps());
  assert.deepEqual(other.output, {});
});

test('corrupt state file is tolerated (fresh state)', () => {
  fs.writeFileSync(store.file(SID), '{{{');
  assert.deepEqual(pre('exec', {}).output, {});
});
