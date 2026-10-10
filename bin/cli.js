#!/usr/bin/env node
'use strict';
// Management CLI. Also what the /circuit-breaker:* skills run.
// Never blocked by the PreToolUse hook (dispatch.isOwnCli), so `reset` always works.

const fs = require('node:fs');
const path = require('node:path');
const cfg = require('../lib/config');
const breaker = require('../lib/breaker');
const { fmtUsd, fmtTok, tokensInWindow } = require('../lib/meter');
const { StateStore } = require('../lib/state');
const installer = require('../lib/install');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const projectDir = process.env.DEVIN_PROJECT_DIR || process.cwd();
const [, , cmd = 'help', ...args] = process.argv;
const out = (s = '') => process.stdout.write(s + '\n');

function status() {
  const store = new StateStore();
  const { config, sources, errors } = cfg.loadConfig(projectDir);
  const id = args[0] || store.mostRecentSessionId();
  out(`circuit-breaker v${cfg.VERSION}`);
  out(`  mode         ${config.mode}`);
  out(`  config       ${sources.join(' < ')}`);
  if (errors.length) out(`  CONFIG ERRORS ${errors.join('; ')}`);
  const L = config.limits;
  out(`  limits       ${fmtUsd(L.costUsd)} est. | ${fmtTok(L.tokens)} tok est. | ${L.minutes} min | ${fmtTok(L.tokensPerMinute)} tok/min | loop warn ${config.loop.warnAt}x trip ${config.loop.blockAt}x`);
  if (!id) return out('  session      (none recorded yet)');
  const s = store.load(id);
  if (!s) return out(`  session      ${id} (no state)`);
  const eff = breaker.effectiveLimits(s, config);
  const mins = Math.round((Date.now() - s.startedAt) / 60000);
  out(`  session      ${id}`);
  out(`  status       ${s.status.toUpperCase()}${s.openedBy ? ` (${s.openedBy}: ${s.openReason})` : ''}  overrides=${s.overrides}`);
  out(`  est. tokens  ${fmtTok(s.tokens.read + s.tokens.written)} (read ${fmtTok(s.tokens.read)}, written ${fmtTok(s.tokens.written)}) / ${fmtTok(eff.tokens)}`);
  out(`  est. cost    ${fmtUsd(s.costUsd)} / ${fmtUsd(eff.costUsd)}`);
  out(`  elapsed      ${mins} / ${eff.minutes} min   rate ${fmtTok(tokensInWindow(s.samples, Date.now(), 60000))}/min   calls ${s.calls}`);
  if (s.lastRepeat && s.lastRepeat.repeats >= 2) out(`  repeating    ${s.lastRepeat.repeats}x ${s.lastRepeat.sig}`);
}

function reset() {
  const store = new StateStore();
  if (args[0] === '--all') { for (const id of store.sessionIds()) store.delete(id); return out('cleared all session state'); }
  const id = args[0] || store.mostRecentSessionId();
  if (!id) return out('no session to reset');
  const prev = store.load(id);
  const next = breaker.reset(prev, Date.now());
  store.save(id, next);
  store.appendEvent({ at: new Date().toISOString(), type: 'reset', session: id, trigger: prev && prev.openedBy, via: 'cli' });
  out(`reset ${id}${prev && prev.openedBy ? ` (was open: ${prev.openedBy})` : ''} -> ${next.status}`);
}

function set() {
  const user = args[0] === '--user';
  const [key, value] = user ? args.slice(1) : args;
  if (!key || value === undefined) { process.stderr.write('usage: set [--user] <key> <value>   e.g. set limits.costUsd 5 | set mode warn | set loop.blockAt 3\n'); process.exit(1); }
  const file = user ? cfg.userConfigPath() : cfg.projectConfigPath(projectDir);
  try {
    const merged = cfg.setConfigValue(file, key, value);
    out(`wrote ${file}`);
    out(JSON.stringify({ mode: merged.mode, limits: merged.limits, loop: { warnAt: merged.loop.warnAt, blockAt: merged.loop.blockAt } }, null, 2));
  } catch (e) { process.stderr.write(`invalid: ${e.message}\n`); process.exit(1); }
}

function init() {
  const user = args.includes('--user');
  const file = user ? cfg.userConfigPath() : cfg.projectConfigPath(projectDir);
  if (fs.existsSync(file) && !args.includes('--force')) return out(`${file} exists (use --force to overwrite)`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg.DEFAULT_CONFIG, null, 2) + '\n');
  out(`wrote ${file}`);
}

function events() {
  for (const e of new StateStore().readEvents(Number(args[0] || 20))) {
    const extra = Object.entries(e).filter(([k]) => !['at', 'type', 'session'].includes(k)).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ');
    out(`${e.at}  ${e.type.padEnd(13)} ${String(e.session).slice(0, 12).padEnd(12)} ${extra}`);
  }
}

function help() {
  out(`circuit-breaker v${cfg.VERSION}

  status [session]          limits, estimated usage, breaker state
  reset [session|--all]     clear an open breaker (default: most recent session)
  set [--user] <key> <val>  e.g. set limits.costUsd 5 | set loop.blockAt 3 | set mode warn|enforce|observe
  init [--user] [--force]   write a full default config file to edit by hand
  config                    print effective merged config + sources
  events [n]                last n audit events
  install | uninstall       register/remove hooks in <project>/.devin/hooks.v1.json (no plugin install needed)

Config files: ~/.config/devin/circuit-breaker/config.json  <  <project>/.devin/circuit-breaker.json  <  env
Env: CIRCUIT_BREAKER_MODE MAX_COST MAX_TOKENS MAX_MINUTES TOKENS_PER_MINUTE LOOP DISABLE=1 DEBUG=1 HOME`);
}

switch (cmd) {
  case 'status': status(); break;
  case 'reset': reset(); break;
  case 'set': set(); break;
  case 'init': init(); break;
  case 'events': events(); break;
  case 'config': out(JSON.stringify(cfg.loadConfig(projectDir), null, 2)); break;
  case 'install': { const r = installer.install(projectDir, PLUGIN_ROOT); out(`registered ${r.events.length} hooks in ${r.target}\n  ${r.command}\nverify in a session with /hooks`); break; }
  case 'uninstall': { const r = installer.uninstall(projectDir); out(r.removed ? `removed circuit-breaker hooks from ${r.target}` : `nothing to remove in ${r.target}`); break; }
  case '--version': case '-v': out(cfg.VERSION); break;
  default: help();
}
