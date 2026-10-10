'use strict';
// Route a Devin hook event to the pure core and render the hook output.
// Pattern: tokenward/src/hooks/dispatch.ts + burnstop hook.render().
//
// Devin hook output contract (docs/cli/extensibility/hooks):
//   PreToolUse        -> {decision:"block", reason}  (+ exit 2)       denies the call
//   PostToolUse / SessionStart / UserPromptSubmit
//                     -> {hookSpecificOutput:{hookEventName, additionalContext}} injects text
// Everything else -> {} (proceed).

const breaker = require('./breaker');
const { loadConfig } = require('./config');
const { fmtUsd, fmtTok } = require('./meter');

const OVERRIDE_RE = /\bcircuit[- ]?breaker\b[^.\n]*\b(override|reset|continue|resume|继续|重置|解除)\b|\b(override|reset|解除)\b[^.\n]*\bcircuit[- ]?breaker\b/i;

/** Our own CLI must never be blocked, or the user cannot reset (burnstop). */
function isOwnCli(payload) {
  if (payload.tool_name !== 'exec') return false;
  const cmd = String((payload.tool_input && payload.tool_input.command) || '').toLowerCase();
  return cmd.includes('circuit-breaker') && cmd.includes('cli.js');
}

/**
 * @param {object} payload   parsed stdin JSON
 * @param {{store: import('./state').StateStore, projectDir: string, env?: object, now?: () => number}} deps
 * @returns {{output: object, exitCode: number, events: object[]}}
 */
function dispatch(payload, deps) {
  const now = deps.now ? deps.now() : Date.now();
  const env = deps.env || process.env;
  if (env.CIRCUIT_BREAKER_DISABLE === '1') return done({});

  const { config, sources, errors } = loadConfig(deps.projectDir, env);
  const sessionId = payload.session_id || 'unknown-session';
  const store = deps.store;
  const events = [];
  const log = (type, extra = {}) => events.push({ at: new Date(now).toISOString(), type, session: sessionId, ...extra });
  const flush = (output, exitCode = 0) => { for (const e of events) store.appendEvent(e); return done(output, exitCode, events); };

  let state = store.load(sessionId) || breaker.freshState(now);

  switch (payload.hook_event_name) {
    case 'SessionStart': {
      state = breaker.freshState(now);
      store.save(sessionId, state);
      log('session_start', { mode: config.mode, sources });
      return flush(context('SessionStart', banner(config, errors)));
    }

    case 'SessionEnd': {
      log('session_end', { reason: payload.reason, tokens: state.tokens, costUsd: state.costUsd, status: state.status });
      return flush({});
    }

    case 'UserPromptSubmit': {
      if (state.status === breaker.OPEN && payload.prompt && OVERRIDE_RE.test(payload.prompt)) {
        const r = breaker.override(state, config, now);
        store.save(sessionId, r.state);
        log('override', { trigger: r.previous, via: 'chat' });
        return flush(context('UserPromptSubmit',
          `[circuit-breaker] Override accepted (was open: ${r.previous}). Breaker is half-open: one more trip re-opens it. Do not repeat the call that tripped it; try a different approach.`));
      }
      return flush({});
    }

    case 'PreToolUse': {
      if (state.status !== breaker.OPEN) return flush({});
      if (isOwnCli(payload)) return flush({});
      if (config.mode !== 'enforce') return flush({});
      return flush({ decision: 'block', reason: blockReason(state) }, 2);
    }

    case 'PostToolUse': {
      const ok = !(payload.tool_response && (payload.tool_response.success === false || payload.tool_response.error));
      state = breaker.applyToolResult(state, config, {
        tool: payload.tool_name || 'unknown',
        input: payload.tool_input,
        output: payload.tool_response && payload.tool_response.output,
        ok,
      }, now);
      const wasOpen = state.status === breaker.OPEN;
      const r = breaker.evaluate(state, config, now);
      store.save(sessionId, r.state);
      const v = r.verdict;

      if (v.kind === 'trip' && !wasOpen) {
        log('trip', { trigger: v.trigger, value: v.value, limit: v.limit, mode: config.mode, reopened: v.reopened, tool: payload.tool_name });
        if (config.mode === 'observe') return flush({});
        return flush(context('PostToolUse', tripMessage(v, config)));
      }
      if (v.kind === 'warn') {
        log('warn', { trigger: v.trigger, value: v.value, limit: v.limit, mode: config.mode });
        if (config.mode === 'observe') return flush({});
        return flush(context('PostToolUse', `[circuit-breaker] WARNING: ${v.reason}`));
      }
      return flush({});
    }

    default:
      return flush({});
  }
}

// ---- rendering ---------------------------------------------------------------

const done = (output, exitCode = 0, events = []) => ({ output, exitCode, events });
const context = (event, text) => ({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });

function banner(c, errors) {
  const L = c.limits;
  const lines = [
    `[circuit-breaker] armed (mode=${c.mode}). Limits: ${fmtUsd(L.costUsd)} est. · ${fmtTok(L.tokens)} tok est. · ${L.minutes} min · loop: warn ${c.loop.warnAt}x / trip ${c.loop.blockAt}x identical failures · ${fmtTok(L.tokensPerMinute)} tok/min.`,
    `If you see a [circuit-breaker] WARNING, stop retrying and report to the user. If it TRIPS, summarize and wait; the user can say "circuit breaker override".`,
  ];
  if (errors.length) lines.push(`Config invalid, running fail-safe observe mode: ${errors.join('; ')}`);
  return lines.join('\n');
}

function tripMessage(v, c) {
  const again = v.reopened ? ' (re-tripped after an override)' : '';
  if (c.mode === 'enforce') {
    return `[circuit-breaker] TRIPPED${again}: ${v.reason}. Further tool calls are BLOCKED. Summarize what you did and what is failing, then stop and wait for the user. They can reply "circuit breaker override", or run the circuit-breaker reset skill.`;
  }
  return `[circuit-breaker] TRIPPED${again}: ${v.reason}. (mode=warn, not blocking) Pause, report progress and estimated cost to the user, and ask whether to continue.`;
}

function blockReason(state) {
  return `Circuit breaker is open (${state.openedBy}: ${state.openReason}). Tool calls are blocked until the user replies "circuit breaker override" or runs: node "$DEVIN_PLUGIN_ROOT/bin/cli.js" reset`;
}

module.exports = { dispatch, isOwnCli, OVERRIDE_RE };
