'use strict';
// Loop detection. Pure functions, no I/O.
//
// A "loop" is the same (tool, normalized input) failing repeatedly inside a
// sliding window of recent non-trivial calls. This is the #2 failure class in
// anthropics/claude-code#30150 and the signature of an overnight token burn.
//
// Borrowed: signature normalization that drops flag tokens (claude-code-self-critic
// stuck-core), identical-call window + warn-then-enforce (agent-loop-detector),
// test-runner exemption so red->green reruns are not treated as a loop.

/** Drop flag tokens and collapse whitespace: `node --test x --verbose` == `node --test x`. */
function normalizeCommand(cmd) {
  return String(cmd || '')
    .trim()
    .split(/\s+/)
    .filter((t) => t && !t.startsWith('-'))
    .join(' ');
}

/** Stable, identifying signature for a tool call. */
function signatureOf(toolName, input) {
  if (input === null || input === undefined) return `${toolName}:`;
  if (typeof input === 'string') return `${toolName}:${input.trim()}`;
  if (typeof input !== 'object') return `${toolName}:${String(input)}`;
  if (typeof input.command === 'string') return `${toolName}:${normalizeCommand(input.command)}`;
  const key = input.file_path ?? input.path ?? input.url ?? input.pattern ?? input.notebook_path;
  if (typeof key === 'string') {
    // For edits include what was targeted, not the replacement: retrying the
    // same old_string with a different new_string is still the same stuck edit.
    const target = typeof input.old_string === 'string' ? `#${input.old_string.slice(0, 80)}` : '';
    return `${toolName}:${key.trim()}${target}`;
  }
  return `${toolName}:${stableJson(input)}`;
}

function stableJson(obj) {
  if (Array.isArray(obj)) return `[${obj.map(stableJson).join(',')}]`;
  if (obj && typeof obj === 'object') return `{${Object.keys(obj).sort().map((k) => `${k}:${stableJson(obj[k])}`).join(',')}}`;
  return JSON.stringify(obj);
}

function isExemptCommand(input, exemptCommands) {
  const cmd = input && typeof input.command === 'string' ? input.command : '';
  if (!cmd) return false;
  return exemptCommands.some((p) => cmd.includes(p));
}

/**
 * Record one finished tool call into the window.
 * @returns {{window: Array<{sig:string, ok:boolean}>, repeats: number, sig: string|null}}
 */
function record(window, toolName, input, ok, loopCfg) {
  if (loopCfg.ignoreTools.includes(toolName)) return { window, repeats: 0, sig: null };
  if (isExemptCommand(input, loopCfg.exemptCommands)) return { window, repeats: 0, sig: null };
  const sig = signatureOf(toolName, input);
  const next = [...window, { sig, ok }].slice(-loopCfg.window);
  // A success of this very signature means it is no longer stuck.
  if (ok) return { window: next, repeats: 0, sig };
  const repeats = next.filter((e) => e.sig === sig && !e.ok).length;
  return { window: next, repeats, sig };
}

/** 0 = fine, 1 = warn, 2 = block. */
function level(repeats, loopCfg) {
  if (repeats >= loopCfg.blockAt) return 2;
  if (repeats >= loopCfg.warnAt) return 1;
  return 0;
}

const NUDGES = [
  null,
  'Stop. You have attempted the same action repeatedly and it keeps failing. Re-read the last error, question your assumption, and try a DIFFERENT approach instead of repeating this call.',
  'Repeated attempts are not progressing; the approach is likely wrong. Summarize what you tried and why each failed, then ask the user before doing anything else.',
];

module.exports = { normalizeCommand, signatureOf, stableJson, isExemptCommand, record, level, NUDGES };
