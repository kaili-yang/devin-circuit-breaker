'use strict';
// Token / cost / rate accounting. Pure functions, no I/O.
//
// Devin hooks do not expose real token usage (see docs/RESEARCH.md §3), so every
// number here is an ESTIMATE from byte size. Never present it as actual spend.
//   - tool_input  = text the model WROTE  -> priced as output tokens
//   - tool_response.output = text the model will READ -> priced as input tokens

function estimateTokens(text, charsPerToken) {
  if (text === undefined || text === null) return 0;
  const s = typeof text === 'string' ? text : JSON.stringify(text);
  return Math.ceil(s.length / (charsPerToken || 4));
}

/** @returns {{written:number, read:number}} tokens for one tool call. */
function tokensForCall(toolInput, toolOutput, pricing) {
  return {
    written: estimateTokens(toolInput, pricing.charsPerToken),
    read: estimateTokens(toolOutput, pricing.charsPerToken),
  };
}

function costUsd(tokens, pricing) {
  return (tokens.read * pricing.inputUsdPerMTok + tokens.written * pricing.outputUsdPerMTok) / 1e6;
}

/** Sum of samples within the trailing window. samples: [{at:ms, tokens}] */
function tokensInWindow(samples, nowMs, windowMs) {
  const cutoff = nowMs - windowMs;
  let sum = 0;
  for (const s of samples) if (s.at >= cutoff) sum += s.tokens;
  return sum;
}

/** Drop samples outside the window and cap the array (bounded state). */
function pruneSamples(samples, nowMs, windowMs, max = 500) {
  const cutoff = nowMs - windowMs;
  const kept = samples.filter((s) => s.at >= cutoff);
  return kept.length > max ? kept.slice(-max) : kept;
}

const fmtUsd = (n) => `$${n.toFixed(n < 1 ? 3 : 2)}`;
const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(Math.round(n)));

module.exports = { estimateTokens, tokensForCall, costUsd, tokensInWindow, pruneSamples, fmtUsd, fmtTok };
