'use strict';
// Version parity (burnstop tests/test_version.py): package.json, the plugin
// manifest and the top CHANGELOG heading must agree. Bump them together.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const manifest = require(path.join(root, '.devin-plugin', 'plugin.json'));
const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');

test('package.json, plugin.json and CHANGELOG agree on the version', () => {
  const top = changelog.match(/^## v(\d+\.\d+\.\d+)/m);
  assert.ok(top, 'CHANGELOG needs a "## vX.Y.Z" heading');
  assert.equal(manifest.version, pkg.version);
  assert.equal(top[1], pkg.version);
});

test('hooks.json references bin/hook.js via ${DEVIN_PLUGIN_ROOT} for every event', () => {
  const hooks = require(path.join(root, 'hooks.json'));
  for (const ev of ['SessionStart', 'PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'SessionEnd']) {
    assert.ok(Array.isArray(hooks[ev]) && hooks[ev].length === 1, ev);
    assert.match(hooks[ev][0].hooks[0].command, /\$\{DEVIN_PLUGIN_ROOT\}\/bin\/hook\.js/);
  }
});

test('every skill has name + description frontmatter', () => {
  for (const d of fs.readdirSync(path.join(root, 'skills'))) {
    const md = fs.readFileSync(path.join(root, 'skills', d, 'SKILL.md'), 'utf8');
    assert.match(md, /^---\r?\nname: \S+\r?\ndescription: .+\r?\n---/, d);
  }
});
