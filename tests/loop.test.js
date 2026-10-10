'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const loop = require('../lib/loop');
const { DEFAULT_CONFIG } = require('../lib/config');

const L = { ...DEFAULT_CONFIG.loop, warnAt: 3, blockAt: 4, window: 8 };

test('normalizeCommand drops flags and collapses whitespace', () => {
  assert.equal(loop.normalizeCommand('node  --test x --verbose'), 'node x');
  assert.equal(loop.normalizeCommand('cat a'), 'cat a');
  assert.notEqual(loop.normalizeCommand('cat a'), loop.normalizeCommand('cat b'));
});

test('signatureOf: exec keyed by normalized command, ignores shell_id', () => {
  assert.equal(loop.signatureOf('exec', { command: 'npm install', shell_id: 'a' }), loop.signatureOf('exec', { command: 'npm install --force', shell_id: 'b' }));
});

test('signatureOf: edit keyed by path + old_string, not new_string', () => {
  const a = loop.signatureOf('edit', { file_path: 'x.ts', old_string: 'foo', new_string: '1' });
  const b = loop.signatureOf('edit', { file_path: 'x.ts', old_string: 'foo', new_string: '2' });
  const c = loop.signatureOf('edit', { file_path: 'x.ts', old_string: 'bar', new_string: '1' });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('signatureOf: stable JSON for arbitrary input', () => {
  assert.equal(loop.signatureOf('t', { b: 1, a: [2, 1] }), loop.signatureOf('t', { a: [2, 1], b: 1 }));
});

test('record: identical failures accumulate, success resets', () => {
  let w = [];
  let r;
  for (let i = 0; i < 3; i++) { r = loop.record(w, 'exec', { command: 'make' }, false, L); w = r.window; }
  assert.equal(r.repeats, 3);
  assert.equal(loop.level(r.repeats, L), 1);
  r = loop.record(w, 'exec', { command: 'make' }, false, L);
  assert.equal(loop.level(r.repeats, L), 2);
  r = loop.record(r.window, 'exec', { command: 'make' }, true, L);
  assert.equal(r.repeats, 0);
});

test('record: ignored tools never count', () => {
  let w = [];
  for (let i = 0; i < 10; i++) w = loop.record(w, 'read', { file_path: 'a' }, false, L).window;
  assert.equal(w.length, 0);
});

test('record: test runners are exempt (red->green reruns are not loops)', () => {
  let w = [];
  let r;
  for (let i = 0; i < 6; i++) { r = loop.record(w, 'exec', { command: 'npx jest tests/' }, false, L); w = r.window; }
  assert.equal(r.repeats, 0);
  assert.equal(r.sig, null);
});

test('record: interleaved different failures do not count toward each other', () => {
  let w = [];
  let r;
  for (let i = 0; i < 3; i++) {
    r = loop.record(w, 'exec', { command: 'a' }, false, L); w = r.window;
    r = loop.record(w, 'exec', { command: 'b' }, false, L); w = r.window;
  }
  assert.equal(r.repeats, 3); // b failed 3 times within window 8
  assert.equal(r.sig, 'exec:b');
});

test('record: window bounds the memory', () => {
  let w = [];
  for (let i = 0; i < 50; i++) w = loop.record(w, 'exec', { command: `c${i}` }, false, L).window;
  assert.equal(w.length, L.window);
});
