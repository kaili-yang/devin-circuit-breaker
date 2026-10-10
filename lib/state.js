'use strict';
// I/O edge: per-session state files + append-only audit log.
// Hooks are short-lived processes, so every event loads and saves through here.
// Writes are atomic (tmp + rename) so a hook killed mid-write never leaves a torn file.

const fs = require('node:fs');
const path = require('node:path');
const { userDir } = require('./config');

class StateStore {
  constructor(root = path.join(userDir(), 'sessions')) {
    this.root = root;
    fs.mkdirSync(root, { recursive: true });
  }

  file(sessionId) {
    return path.join(this.root, `${String(sessionId).replace(/[^a-zA-Z0-9_.-]/g, '_')}.json`);
  }

  load(sessionId) {
    try {
      const f = this.file(sessionId);
      return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
    } catch {
      return null;
    }
  }

  save(sessionId, state) {
    const f = this.file(sessionId);
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, f);
  }

  delete(sessionId) {
    try { fs.unlinkSync(this.file(sessionId)); } catch { /* absent */ }
  }

  sessionIds() {
    return fs.readdirSync(this.root).filter((f) => f.endsWith('.json') && f !== 'events.jsonl').map((f) => f.slice(0, -5));
  }

  /** Most recently written session, for CLI commands run without an explicit id. */
  mostRecentSessionId() {
    const ids = this.sessionIds();
    if (!ids.length) return null;
    ids.sort((a, b) => fs.statSync(this.file(b)).mtimeMs - fs.statSync(this.file(a)).mtimeMs);
    return ids[0];
  }

  appendEvent(ev) {
    fs.appendFileSync(path.join(this.root, 'events.jsonl'), JSON.stringify(ev) + '\n');
  }

  readEvents(limit = 50) {
    const f = path.join(this.root, 'events.jsonl');
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).slice(-limit).map((l) => JSON.parse(l));
  }
}

module.exports = { StateStore };
