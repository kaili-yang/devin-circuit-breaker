#!/usr/bin/env node
'use strict';
/*
 * End-to-end harness. Spawns bin/hook.js as a real child process and pipes each
 * Devin lifecycle event to its stdin EXACTLY as Devin would, then asserts the
 * exit code (2 = blocked, 0 = allowed) and stdout. Also drives bin/cli.js.
 * Zero dependencies. Pattern: sentinel-hooks/claude-code-guardrails tests/red-team.js
 *
 * Run: node tests/harness.js        (exits 1 on any failure)
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const HOOK = path.join(ROOT, 'bin', 'hook.js');
const CLI = path.join(ROOT, 'bin', 'cli.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-e2e-home-'));
const PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-e2e-proj-'));
const ENV = { ...process.env, CIRCUIT_BREAKER_HOME: HOME, DEVIN_PROJECT_DIR: PROJECT, DEVIN_PLUGIN_ROOT: ROOT };
const SID = `e2e-${Date.now()}`;

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); } else { fail++; console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const hook = (payload) => {
  const r = spawnSync('node', [HOOK], { input: JSON.stringify(payload), env: ENV, encoding: 'utf8', timeout: 5000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const cli = (...a) => spawnSync('node', [CLI, ...a], { env: ENV, encoding: 'utf8' }).stdout;
const ev = (hook_event_name, extra = {}) => ({ hook_event_name, session_id: SID, ...extra });
const post = (tool, input, ok, output = '') => ev('PostToolUse', { tool_name: tool, tool_input: input, tool_response: { success: ok, output, error: ok ? null : 'exit 1' } });
const pre = (tool, input) => ev('PreToolUse', { tool_name: tool, tool_input: input });

console.log('--- configure via CLI (as the /circuit-breaker:configure skill would) ---');
cli('set', 'loop.warnAt', '2'); cli('set', 'loop.blockAt', '3'); cli('set', 'limits.costUsd', '0.5');
const written = JSON.parse(fs.readFileSync(path.join(PROJECT, '.devin', 'circuit-breaker.json'), 'utf8'));
check('config file written', written.loop.blockAt === 3 && written.limits.costUsd === 0.5);
check('cli rejects invalid value', spawnSync('node', [CLI, 'set', 'mode', 'yolo'], { env: ENV, encoding: 'utf8' }).status === 1);

console.log('--- SessionStart ---');
let r = hook(ev('SessionStart'));
check('exit 0', r.code === 0);
check('banner injected', r.out.includes('[circuit-breaker] armed (mode=enforce)'), r.out);

console.log('--- healthy calls pass silently ---');
r = hook(pre('exec', { command: 'npm test' }));
check('PreToolUse allowed, no output', r.code === 0 && r.out === '', `${r.code} ${r.out}`);
r = hook(post('exec', { command: 'npm test' }, true, 'ok'));
check('PostToolUse silent', r.code === 0 && r.out === '');

console.log('--- dead loop: npm install fails 3x ---');
r = hook(post('exec', { command: 'npm install', shell_id: 'a' }, false, 'ERR'));
check('1st failure silent', r.out === '');
r = hook(post('exec', { command: 'npm install', shell_id: 'b' }, false, 'ERR'));
check('2nd failure -> WARNING', r.out.includes('WARNING') && r.out.includes('npm install'), r.out);
r = hook(post('exec', { command: 'npm install', shell_id: 'c' }, false, 'ERR'));
check('3rd failure -> TRIPPED', r.out.includes('TRIPPED') && r.out.includes('BLOCKED'), r.out);

console.log('--- open breaker denies the next tool call ---');
r = hook(pre('edit', { file_path: 'a.ts' }));
check('decision=block', r.out.includes('"decision":"block"'), r.out);
check('exit code 2', r.code === 2, String(r.code));
r = hook(pre('exec', { command: `node "${CLI}" reset` }));
check('own CLI exempt from block', r.code === 0 && r.out === '');

console.log('--- status / events ---');
let s = cli('status', SID);
check('status shows OPEN (loop)', /status\s+OPEN \(loop/.test(s), s);
check('status shows repeating signature', s.includes('exec:npm install'), s);

console.log('--- chat override ---');
r = hook(ev('UserPromptSubmit', { prompt: 'circuit breaker override, try pnpm instead' }));
check('override acknowledged', r.out.includes('Override accepted'), r.out);
r = hook(pre('exec', { command: 'pnpm install' }));
check('tools allowed again', r.code === 0 && r.out === '');
r = hook(post('exec', { command: 'pnpm install' }, true, 'done'));
check('half-open closes on success', /status\s+CLOSED/.test(cli('status', SID)), cli('status', SID));

console.log('--- cost cap via large output ---');
r = hook(post('read', { file_path: 'huge.log' }, true, 'x'.repeat(200_000))); // ~50k tok read * $3/M = $0.15... need more
r = hook(post('read', { file_path: 'huge2.log' }, true, 'x'.repeat(600_000))); // cumulative ~200k tok = $0.60 > $0.50
check('cost trip message', r.out.includes('estimated cost') && r.out.includes('TRIPPED'), r.out.slice(0, 200));
r = hook(pre('read', { file_path: 'x' }));
check('blocked on cost', r.code === 2);

console.log('--- CLI reset ---');
s = cli('reset', SID);
check('reset reports previous trigger', s.includes('was open: cost'), s);
r = hook(pre('read', { file_path: 'x' }));
check('allowed after reset', r.code === 0);

console.log('--- audit trail ---');
s = cli('events', '30');
for (const t of ['session_start', 'warn', 'trip', 'override', 'reset']) check(`events contains ${t}`, s.includes(t), s);

console.log('--- fail-open ---');
r = spawnSync('node', [HOOK], { input: 'not json', env: ENV, encoding: 'utf8' });
check('garbage stdin -> exit 0, no output', r.status === 0 && r.stdout === '');
r = spawnSync('node', [HOOK], { input: '', env: ENV, encoding: 'utf8' });
check('empty stdin -> exit 0', r.status === 0);
r = spawnSync('node', [HOOK], { input: JSON.stringify(ev('PreToolUse')), env: { ...ENV, CIRCUIT_BREAKER_MODE: 'explode' }, encoding: 'utf8' });
check('invalid config -> fail-safe, never blocks', r.status === 0);
r = spawnSync('node', [HOOK], { input: JSON.stringify(pre('exec', {})), env: { ...ENV, CIRCUIT_BREAKER_DISABLE: '1' }, encoding: 'utf8' });
check('DISABLE=1 -> no-op', r.status === 0 && r.stdout === '');

console.log('--- project install/uninstall fallback ---');
s = cli('install');
const hooksFile = path.join(PROJECT, '.devin', 'hooks.v1.json');
check('hooks.v1.json written', fs.existsSync(hooksFile) && s.includes('registered 5 hooks'));
cli('install');
check('idempotent', JSON.parse(fs.readFileSync(hooksFile, 'utf8')).PreToolUse.length === 1);
cli('uninstall');
check('uninstall removes file', !fs.existsSync(hooksFile));

console.log('--- timing ---');
const t = Date.now(); for (let i = 0; i < 10; i++) hook(pre('exec', { command: 'ls' }));
const perCall = (Date.now() - t) / 10;
check(`hook latency ${perCall.toFixed(0)}ms < 300ms`, perCall < 300);

fs.rmSync(HOME, { recursive: true, force: true });
fs.rmSync(PROJECT, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
