#!/usr/bin/env node
'use strict';
// Hook entry point. Devin pipes the lifecycle event as JSON on stdin; we print a
// JSON decision on stdout and exit 2 to block, 0 otherwise.
//
// FAIL OPEN (tokenward _wrap.ts): any internal error, unparseable input, or a
// run longer than HOOK_TIMEOUT_MS resolves to "proceed" (exit 0, no output). The
// only way the agent is interrupted is an explicit decision from dispatch().

const { dispatch } = require('../lib/dispatch');
const { StateStore } = require('../lib/state');

const HOOK_TIMEOUT_MS = 2000;

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

async function main() {
  let settled = false;
  const finish = (output, code) => {
    if (settled) return;
    settled = true;
    if (output && Object.keys(output).length) process.stdout.write(JSON.stringify(output));
    process.exit(code);
  };
  const timer = setTimeout(() => finish(null, 0), HOOK_TIMEOUT_MS);
  timer.unref();

  try {
    const raw = await readStdin();
    if (!raw.trim()) return finish(null, 0);
    const payload = JSON.parse(raw);
    const r = dispatch(payload, {
      store: new StateStore(),
      projectDir: process.env.DEVIN_PROJECT_DIR || process.cwd(),
    });
    if (process.env.CIRCUIT_BREAKER_DEBUG) {
      for (const e of r.events) process.stderr.write(`[circuit-breaker] ${JSON.stringify(e)}\n`);
    }
    finish(r.output, r.exitCode);
  } catch (err) {
    if (process.env.CIRCUIT_BREAKER_DEBUG) process.stderr.write(`[circuit-breaker] fail-open: ${err && err.message}\n`);
    finish(null, 0);
  }
}

main();
