'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const B = require('../lib/breaker');
const meter = require('../lib/meter');
const { DEFAULT_CONFIG, merge } = require('../lib/config');

const T0 = 1_700_000_000_000;
const cfg = (over) => merge(DEFAULT_CONFIG, over);
const call = (tool, input, ok = true, output = '') => ({ tool, input, ok, output });

function run(config, calls, now = T0) {
  let s = B.freshState(now);
  let v;
  for (const c of calls) {
    s = B.applyToolResult(s, config, c, now);
    ({ state: s, verdict: v } = B.evaluate(s, config, now));
  }
  return { s, v };
}

// ---- meter ---------------------------------------------------------------
test('meter: ~4 chars per token, read vs written split, cost from per-MTok rates', () => {
  const p = DEFAULT_CONFIG.pricing;
  assert.equal(meter.estimateTokens('x'.repeat(400), 4), 100);
  const t = meter.tokensForCall({ command: 'ls' }, 'y'.repeat(4000), p);
  assert.equal(t.read, 1000);
  assert.equal(t.written, Math.ceil(JSON.stringify({ command: 'ls' }).length / 4));
  assert.ok(Math.abs(meter.costUsd({ read: 1e6, written: 0 }, p) - 3) < 1e-9);
  assert.ok(Math.abs(meter.costUsd({ read: 0, written: 1e6 }, p) - 15) < 1e-9);
});

test('meter: tokensInWindow and pruneSamples respect the window', () => {
  const samples = [{ at: T0 - 70_000, tokens: 5 }, { at: T0 - 30_000, tokens: 7 }, { at: T0, tokens: 1 }];
  assert.equal(meter.tokensInWindow(samples, T0, 60_000), 8);
  assert.equal(meter.pruneSamples(samples, T0, 60_000).length, 2);
});

// ---- triggers ------------------------------------------------------------
test('allow: normal usage under every limit', () => {
  const { s, v } = run(cfg({}), [call('read', { file_path: 'a' }, true, 'x'.repeat(4000)), call('edit', { file_path: 'a' }), call('exec', { command: 'npm test' })]);
  assert.equal(v.kind, 'allow');
  assert.equal(s.status, B.CLOSED);
  assert.ok(s.tokens.read > 900);
});

test('loop: warn at warnAt, trip at blockAt, latched OPEN', () => {
  const c = cfg({ loop: { warnAt: 3, blockAt: 4 } });
  const fail = () => call('exec', { command: 'npm install' }, false, 'ERR');
  let r = run(c, [fail(), fail()]);
  assert.equal(r.v.kind, 'allow');
  r = run(c, [fail(), fail(), fail()]);
  assert.equal(r.v.kind, 'warn');
  assert.equal(r.v.trigger, 'loop');
  r = run(c, [fail(), fail(), fail(), fail()]);
  assert.equal(r.v.kind, 'trip');
  assert.equal(r.v.trigger, 'loop');
  assert.equal(r.s.status, B.OPEN);
  // still open on the next evaluate, counters dropping does not matter
  assert.equal(B.evaluate(r.s, c, T0).verdict.kind, 'open');
});

test('loop: warn is emitted once, not on every call', () => {
  const c = cfg({ loop: { warnAt: 2, blockAt: 10, window: 12 } });
  const fail = () => call('exec', { command: 'x' }, false);
  let s = B.freshState(T0);
  const kinds = [];
  for (let i = 0; i < 5; i++) { s = B.applyToolResult(s, c, fail(), T0); const r = B.evaluate(s, c, T0); s = r.state; kinds.push(r.verdict.kind); }
  assert.deepEqual(kinds, ['allow', 'warn', 'allow', 'allow', 'allow']);
});

test('cost: warn at 80%, trip at 100% (estimate)', () => {
  // $1 per read char, output tokens free: 80 chars = $80 (80%) -> warn; 100 chars -> trip
  const c2 = cfg({ limits: { costUsd: 100 }, pricing: { inputUsdPerMTok: 1_000_000, outputUsdPerMTok: 0, charsPerToken: 1 } });
  let r = run(c2, [call('read', {}, true, 'x'.repeat(80))]);
  assert.equal(r.v.kind, 'warn'); assert.equal(r.v.trigger, 'cost');
  r = run(c2, [call('read', {}, true, 'x'.repeat(100))]);
  assert.equal(r.v.kind, 'trip'); assert.equal(r.v.trigger, 'cost');
});

test('tokens: trip when estimated total >= limit', () => {
  const c = cfg({ limits: { tokens: 100, costUsd: 1e9 }, pricing: { charsPerToken: 1 } });
  const r = run(c, [call('read', {}, true, 'x'.repeat(100))]);
  assert.equal(r.v.trigger, 'tokens');
  assert.equal(r.v.kind, 'trip');
});

test('rate: trip when tokens in last 60s exceed tokensPerMinute', () => {
  const c = cfg({ limits: { tokensPerMinute: 1000, tokens: 1e9, costUsd: 1e9 }, pricing: { charsPerToken: 1 } });
  let s = B.freshState(T0);
  s = B.applyToolResult(s, c, call('read', {}, true, 'x'.repeat(600)), T0 - 50_000);
  s = B.applyToolResult(s, c, call('read', {}, true, 'x'.repeat(600)), T0);
  const r = B.evaluate(s, c, T0);
  assert.equal(r.verdict.trigger, 'rate');
  // same volume spread over >60s does not trip
  let s2 = B.freshState(T0 - 120_000);
  s2 = B.applyToolResult(s2, c, call('read', {}, true, 'x'.repeat(600)), T0 - 90_000);
  s2 = B.applyToolResult(s2, c, call('read', {}, true, 'x'.repeat(600)), T0);
  assert.equal(B.evaluate(s2, c, T0).verdict.kind, 'allow');
});

test('time: warn at 80%, trip past the limit', () => {
  const c = cfg({ limits: { minutes: 10 } });
  const s = B.freshState(T0);
  assert.equal(B.evaluate(s, c, T0 + 8 * 60_000).verdict.trigger, 'time');
  assert.equal(B.evaluate(s, c, T0 + 8 * 60_000).verdict.kind, 'warn');
  assert.equal(B.evaluate(s, c, T0 + 11 * 60_000).verdict.kind, 'trip');
});

// ---- state machine ---------------------------------------------------------
test('override: OPEN -> HALF_OPEN, breached limit relaxed and persisted in state', () => {
  const c = cfg({ limits: { tokens: 100, costUsd: 1e9 }, pricing: { charsPerToken: 1 } });
  let { s } = run(c, [call('read', {}, true, 'x'.repeat(120))]);
  assert.equal(s.status, B.OPEN);
  const o = B.override(s, c, T0);
  assert.equal(o.previous, 'tokens');
  assert.equal(o.state.status, B.HALF_OPEN);
  assert.equal(o.state.overrides, 1);
  const total = o.state.tokens.read + o.state.tokens.written; // 120 read + the `{}` input
  assert.equal(B.effectiveLimits(o.state, c).tokens, Math.max(100, total) * 2);
  assert.equal(B.evaluate(o.state, c, T0).verdict.kind, 'allow');
});

test('half-open: closes on first successful real call, re-opens on new trip', () => {
  const c = cfg({ loop: { warnAt: 2, blockAt: 2, window: 8 } });
  const fail = () => call('exec', { command: 'make' }, false);
  let { s } = run(c, [fail(), fail()]);
  assert.equal(s.status, B.OPEN);
  s = B.override(s, c, T0).state;
  const closed = B.applyToolResult(s, c, call('exec', { command: 'ls' }, true), T0);
  assert.equal(closed.status, B.CLOSED);
  const re = run(c, [fail(), fail()]); // fresh run shape, but prove reopened flag from half-open
  let h = B.override(re.s, c, T0).state;
  h = B.applyToolResult(h, c, fail(), T0); h = B.applyToolResult(h, c, fail(), T0);
  const v = B.evaluate(h, c, T0).verdict;
  assert.equal(v.kind, 'trip'); assert.equal(v.reopened, true);
});

test('reset: zeroes counters, keeps override count, OPEN -> HALF_OPEN', () => {
  const c = cfg({ limits: { tokens: 10, costUsd: 1e9 }, pricing: { charsPerToken: 1 } });
  let { s } = run(c, [call('read', {}, true, 'x'.repeat(50))]);
  s.overrides = 2;
  const r = B.reset(s, T0);
  assert.equal(r.status, B.HALF_OPEN);
  assert.equal(r.tokens.read, 0);
  assert.equal(r.overrides, 2);
});
