'use strict';
// Idempotent, reversible registration into <project>/.devin/hooks.v1.json.
// Fallback for environments where `devin plugins install` is unavailable.
// Pattern: tokenward/src/install.ts — replace only our own entries, preserve
// everything else, always write forward-slash paths (Windows runs hooks via bash).

const fs = require('node:fs');
const path = require('node:path');

const EVENTS = ['SessionStart', 'PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'SessionEnd'];
// Entries we wrote are recognised by this env prefix, not by path: the plugin
// directory can live anywhere (and be renamed) without breaking uninstall.
const MARKER = 'CIRCUIT_BREAKER_HOOK=1';

function hookCommand(pluginRoot) {
  const p = path.join(pluginRoot, 'bin', 'hook.js').split(path.sep).join('/');
  return `${MARKER} node "${p}"`;
}

const isOurs = (group) => Array.isArray(group.hooks) && group.hooks.some((h) => typeof h.command === 'string' && h.command.includes(MARKER));

function install(projectDir, pluginRoot) {
  const target = path.join(projectDir, '.devin', 'hooks.v1.json');
  let doc = {};
  try { if (fs.existsSync(target)) doc = JSON.parse(fs.readFileSync(target, 'utf8')); } catch { doc = {}; }
  const entry = { matcher: '', hooks: [{ type: 'command', command: hookCommand(pluginRoot), timeout: 5 }] };
  for (const ev of EVENTS) {
    const groups = Array.isArray(doc[ev]) ? doc[ev].filter((g) => !isOurs(g)) : [];
    doc[ev] = [...groups, entry];
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(doc, null, 2) + '\n');
  return { target, command: entry.hooks[0].command, events: EVENTS };
}

function uninstall(projectDir) {
  const target = path.join(projectDir, '.devin', 'hooks.v1.json');
  if (!fs.existsSync(target)) return { target, removed: false };
  let doc;
  try { doc = JSON.parse(fs.readFileSync(target, 'utf8')); } catch { return { target, removed: false }; }
  let removed = false;
  for (const ev of Object.keys(doc)) {
    if (!Array.isArray(doc[ev])) continue;
    const kept = doc[ev].filter((g) => !isOurs(g));
    if (kept.length !== doc[ev].length) removed = true;
    if (kept.length) doc[ev] = kept; else delete doc[ev];
  }
  if (Object.keys(doc).length) fs.writeFileSync(target, JSON.stringify(doc, null, 2) + '\n');
  else fs.unlinkSync(target);
  return { target, removed };
}

module.exports = { install, uninstall, hookCommand, EVENTS, MARKER };
