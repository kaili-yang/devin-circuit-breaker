'use strict';
// The circuit breaker. Pure: (state, config, event) -> (state', verdict). No I/O.
//
// States follow opossum: CLOSED (normal) -> OPEN (tripped, tool calls denied in
// enforce mode) -> HALF_OPEN (after override/reset: probing; closes on the first
// successful real call, re-opens immediately on a new trip).
//
// Triggers, evaluated in this order (first hit wins):
//   loop        same (tool,args) failing N times in the window   -> exact
//   cost        estimated USD >= limits.costUsd                   -> estimate
//   tokens      estimated tokens >= limits.tokens                 -> estimate
//   rate        estimated tokens in last 60 s > tokensPerMinute   -> estimate
//   time        session minutes > limits.minutes                  -> exact
// Budget-type triggers also WARN once at warnAtPercent (burnstop: 80%).

const loop = require('./loop');
const meter = require('./meter');

const CLOSED = 'closed', OPEN = 'open', HALF_OPEN = 'half_open';
const MINUTE = 60_000;

function freshState(nowMs) {
  return {
    v: 1,
    status: CLOSED,
    startedAt: nowMs,
    tokens: { read: 0, written: 0 },
    costUsd: 0,
    samples: [],      // [{at, tokens}] for the rate window
    window: [],       // loop window [{sig, ok}]
    calls: 0,
    openedBy: null,   // trigger id
    openedAt: null,
    openReason: null,
    warned: {},       // {cost:true, tokens:true, time:true, loop:true}
    relaxed: {},      // per-session limit overrides written by override()
    overrides: 0,
  };
}

/** Limits in force for this session: config limits with any per-session relaxations. */
const effectiveLimits = (state, config) => ({ ...config.limits, ...(state.relaxed || {}) });

/** Fold one finished tool call into state. Returns the new state (does not evaluate). */
function applyToolResult(state, config, call, nowMs) {
  const s = clone(state);
  const t = meter.tokensForCall(call.input, call.output, config.pricing);
  s.tokens.read += t.read;
  s.tokens.written += t.written;
  s.costUsd = meter.costUsd(s.tokens, config.pricing);
  s.samples = meter.pruneSamples([...s.samples, { at: nowMs, tokens: t.read + t.written }], nowMs, MINUTE);
  s.calls += 1;

  const r = loop.record(s.window, call.tool, call.input, call.ok, config.loop);
  s.window = r.window;
  s.lastRepeat = { sig: r.sig, repeats: r.repeats };

  // Half-open probe succeeded -> close.
  if (s.status === HALF_OPEN && call.ok && r.sig) s.status = CLOSED;
  return s;
}

/**
 * Evaluate the current state. Mutates nothing; returns {state, verdict}.
 * verdict.kind: 'allow' | 'warn' | 'trip' | 'open' (already open)
 */
function evaluate(state, config, nowMs) {
  const s = clone(state);
  const L = effectiveLimits(s, config);
  const pct = config.warnAtPercent / 100;

  if (s.status === OPEN) return { state: s, verdict: { kind: 'open', trigger: s.openedBy, reason: s.openReason } };

  const trip = (trigger, reason, value, limit) => {
    s.status = OPEN;
    s.openedBy = trigger;
    s.openedAt = nowMs;
    s.openReason = reason;
    return { state: s, verdict: { kind: 'trip', trigger, reason, value, limit, reopened: state.status === HALF_OPEN } };
  };
  const warn = (trigger, reason, value, limit) => {
    if (s.warned[trigger]) return null;
    s.warned[trigger] = true;
    return { state: s, verdict: { kind: 'warn', trigger, reason, value, limit } };
  };

  // 1. loop (exact)
  const rep = s.lastRepeat || { repeats: 0, sig: null };
  const lvl = loop.level(rep.repeats, config.loop);
  if (lvl === 2) return trip('loop', `the same call failed ${rep.repeats}x in a row: ${rep.sig}`, rep.repeats, config.loop.blockAt);
  if (lvl === 1) {
    const w = warn('loop', `the same call has failed ${rep.repeats}x: ${rep.sig}. ${loop.NUDGES[1]}`, rep.repeats, config.loop.blockAt);
    if (w) return w;
  }

  // 2. cost (estimate)
  if (s.costUsd >= L.costUsd) return trip('cost', `estimated cost ${meter.fmtUsd(s.costUsd)} >= limit ${meter.fmtUsd(L.costUsd)}`, s.costUsd, L.costUsd);
  if (s.costUsd >= L.costUsd * pct) {
    const w = warn('cost', `estimated cost ${meter.fmtUsd(s.costUsd)} is ${Math.round((s.costUsd / L.costUsd) * 100)}% of the ${meter.fmtUsd(L.costUsd)} limit`, s.costUsd, L.costUsd);
    if (w) return w;
  }

  // 3. tokens (estimate)
  const total = s.tokens.read + s.tokens.written;
  if (total >= L.tokens) return trip('tokens', `estimated tokens ${meter.fmtTok(total)} >= limit ${meter.fmtTok(L.tokens)}`, total, L.tokens);
  if (total >= L.tokens * pct) {
    const w = warn('tokens', `estimated tokens ${meter.fmtTok(total)} is ${Math.round((total / L.tokens) * 100)}% of the ${meter.fmtTok(L.tokens)} limit`, total, L.tokens);
    if (w) return w;
  }

  // 4. rate (estimate)
  const rate = meter.tokensInWindow(s.samples, nowMs, MINUTE);
  if (rate > L.tokensPerMinute) return trip('rate', `${meter.fmtTok(rate)} estimated tokens in the last minute > limit ${meter.fmtTok(L.tokensPerMinute)}/min`, rate, L.tokensPerMinute);

  // 5. time (exact)
  const mins = (nowMs - s.startedAt) / MINUTE;
  if (mins > L.minutes) return trip('time', `session running ${Math.round(mins)} min > limit ${L.minutes} min`, mins, L.minutes);
  if (mins >= L.minutes * pct) {
    const w = warn('time', `session has run ${Math.round(mins)} of ${L.minutes} min`, mins, L.minutes);
    if (w) return w;
  }

  return { state: s, verdict: { kind: 'allow' } };
}

/**
 * Clear the trip but keep counters. The breached budget limit is doubled for the
 * rest of this session (persisted in state.relaxed) so it does not re-trip at once.
 */
function override(state, config, nowMs) {
  const s = clone(state);
  const by = s.openedBy;
  const L = effectiveLimits(s, config);
  s.status = HALF_OPEN;
  s.overrides += 1;
  s.openedBy = null; s.openedAt = null; s.openReason = null;
  s.window = []; s.lastRepeat = null; s.samples = [];
  s.warned = {};
  if (by === 'cost') s.relaxed.costUsd = Math.max(L.costUsd, s.costUsd) * 2;
  if (by === 'tokens') s.relaxed.tokens = Math.max(L.tokens, s.tokens.read + s.tokens.written) * 2;
  if (by === 'rate') s.relaxed.tokensPerMinute = L.tokensPerMinute * 2;
  if (by === 'time') s.startedAt = nowMs;
  return { state: s, previous: by };
}

/** Full reset: zero everything, keep override count for the audit trail. */
function reset(state, nowMs) {
  const s = freshState(nowMs);
  s.overrides = state ? state.overrides : 0;
  s.status = state && state.status === OPEN ? HALF_OPEN : CLOSED;
  return s;
}

const clone = (o) => JSON.parse(JSON.stringify(o));

module.exports = { CLOSED, OPEN, HALF_OPEN, freshState, effectiveLimits, applyToolResult, evaluate, override, reset };
