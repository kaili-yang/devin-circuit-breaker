'use strict';
// Config: defaults < user file < project file < env. Always returns a complete,
// validated config; an invalid merge falls back to defaults in `observe` mode
// (fail-safe: a typo in config must never brick a session).
// Pattern: tokenward/src/config.ts (merge one level into nested objects).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const VERSION = require('../package.json').version;

const DEFAULT_CONFIG = Object.freeze({
  mode: 'enforce', // observe | warn | enforce
  warnAtPercent: 80,
  limits: {
    costUsd: 10,
    tokens: 500000,
    minutes: 60,
    tokensPerMinute: 60000,
  },
  loop: {
    warnAt: 3,
    blockAt: 4,
    window: 8,
    ignoreTools: ['read', 'grep', 'glob', 'get_output', 'todo_write', 'mcp_list_tools', 'mcp_list_servers', 'skill'],
    exemptCommands: ['jest', 'vitest', 'pytest', 'npm test', 'pnpm test', 'yarn test', 'go test', 'cargo test', 'node --test', 'mocha', 'make test', 'tsc', 'eslint'],
  },
  pricing: {
    // Blended list-price defaults (USD per million tokens). Devin does not tell
    // hooks which model served a turn, so this is a single configurable rate.
    inputUsdPerMTok: 3,
    outputUsdPerMTok: 15,
    charsPerToken: 4,
  },
});

function userDir() {
  if (process.env.CIRCUIT_BREAKER_HOME) return process.env.CIRCUIT_BREAKER_HOME;
  if (process.platform === 'win32' && process.env.APPDATA) return path.join(process.env.APPDATA, 'devin', 'circuit-breaker');
  return path.join(os.homedir(), '.config', 'devin', 'circuit-breaker');
}
const userConfigPath = () => path.join(userDir(), 'config.json');
const projectConfigPath = (projectDir) => path.join(projectDir, '.devin', 'circuit-breaker.json');

function readJsonSafe(file) {
  try {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined;
  } catch {
    return undefined;
  }
}

function merge(base, over) {
  if (!over || typeof over !== 'object') return base;
  return {
    mode: over.mode ?? base.mode,
    warnAtPercent: over.warnAtPercent ?? base.warnAtPercent,
    limits: { ...base.limits, ...(over.limits || {}) },
    loop: { ...base.loop, ...(over.loop || {}) },
    pricing: { ...base.pricing, ...(over.pricing || {}) },
  };
}

function fromEnv(env) {
  const num = (v) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
  const over = { limits: {}, loop: {} };
  if (env.CIRCUIT_BREAKER_MODE) over.mode = env.CIRCUIT_BREAKER_MODE;
  const map = {
    CIRCUIT_BREAKER_MAX_COST: ['limits', 'costUsd'],
    CIRCUIT_BREAKER_MAX_TOKENS: ['limits', 'tokens'],
    CIRCUIT_BREAKER_MAX_MINUTES: ['limits', 'minutes'],
    CIRCUIT_BREAKER_TOKENS_PER_MINUTE: ['limits', 'tokensPerMinute'],
    CIRCUIT_BREAKER_LOOP: ['loop', 'blockAt'],
  };
  for (const [k, [sec, key]] of Object.entries(map)) {
    const v = num(env[k]);
    if (v !== undefined) over[sec][key] = v;
  }
  // blockAt from env without warnAt: keep warnAt one below.
  if (over.loop.blockAt !== undefined && env.CIRCUIT_BREAKER_LOOP_WARN === undefined) over.loop.warnAt = Math.max(2, over.loop.blockAt - 1);
  return over;
}

function validate(c) {
  const errs = [];
  if (!['observe', 'warn', 'enforce'].includes(c.mode)) errs.push(`mode must be observe|warn|enforce (got "${c.mode}")`);
  if (!(c.warnAtPercent > 0 && c.warnAtPercent < 100)) errs.push('warnAtPercent must be in (0,100)');
  for (const [k, v] of Object.entries(c.limits)) if (!(typeof v === 'number' && v > 0)) errs.push(`limits.${k} must be > 0`);
  if (!(c.loop.warnAt >= 2)) errs.push('loop.warnAt must be >= 2');
  if (!(c.loop.blockAt >= c.loop.warnAt)) errs.push('loop.blockAt must be >= loop.warnAt');
  if (!(c.loop.window >= c.loop.blockAt)) errs.push('loop.window must be >= loop.blockAt');
  if (!Array.isArray(c.loop.ignoreTools) || !Array.isArray(c.loop.exemptCommands)) errs.push('loop.ignoreTools / exemptCommands must be arrays');
  for (const [k, v] of Object.entries(c.pricing)) if (!(typeof v === 'number' && v >= 0)) errs.push(`pricing.${k} must be >= 0`);
  return errs;
}

/** @returns {{config: object, sources: string[], errors: string[]}} */
function loadConfig(projectDir, env = process.env) {
  const sources = ['defaults'];
  const user = readJsonSafe(userConfigPath());
  if (user) sources.push(userConfigPath());
  const project = projectDir ? readJsonSafe(projectConfigPath(projectDir)) : undefined;
  if (project) sources.push(projectConfigPath(projectDir));
  const envOver = fromEnv(env);
  if (envOver.mode || Object.keys(envOver.limits).length || Object.keys(envOver.loop).length) sources.push('env');

  const config = merge(merge(merge(DEFAULT_CONFIG, user), project), envOver);
  const errors = validate(config);
  if (errors.length) return { config: merge(DEFAULT_CONFIG, { mode: 'observe' }), sources: ['defaults (fail-safe)'], errors };
  return { config, sources, errors: [] };
}

/** Write one dotted key into a config file, validating the merged result first. */
function setConfigValue(file, dottedKey, rawValue) {
  const existing = readJsonSafe(file) || {};
  const parts = dottedKey.split('.');
  let cur = existing;
  for (const p of parts.slice(0, -1)) {
    if (typeof cur[p] !== 'object' || cur[p] === null) cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = coerce(rawValue);
  const errs = validate(merge(DEFAULT_CONFIG, existing));
  if (errs.length) throw new Error(errs.join('; '));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(existing, null, 2) + '\n');
  return merge(DEFAULT_CONFIG, existing);
}

function coerce(raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) return Number(raw);
  if (typeof raw === 'string' && /^[[{]/.test(raw)) { try { return JSON.parse(raw); } catch { /* keep string */ } }
  return raw;
}

module.exports = { VERSION, DEFAULT_CONFIG, loadConfig, setConfigValue, validate, merge, fromEnv, userDir, userConfigPath, projectConfigPath, readJsonSafe };
