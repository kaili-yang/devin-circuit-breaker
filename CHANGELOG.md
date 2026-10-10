# Changelog

## v2.0.0 — 2026-10-09

Full rewrite as a zero-dependency, zero-build Devin plugin, modelled on burnstop,
tokenward, agent-loop-detector and claude-code-self-critic (see docs/RESEARCH.md).

### Breaker
- Five triggers evaluated in order: loop (identical failing calls), estimated cost,
  estimated tokens, token rate (60 s window), session time.
- opossum-style states `closed -> open -> half_open`; override doubles the breached
  budget limit for the session, half-open closes on the next successful call.
- Budget triggers warn once at 80 % before tripping; loop warns at 3x, trips at 4x.
- Test-runner commands exempt from loop detection; read-only tools never count.

### Plugin surface
- `hooks.json` for SessionStart / PreToolUse / PostToolUse / UserPromptSubmit / SessionEnd.
- Skills `/circuit-breaker:status`, `:configure`, `:reset`; always-on `AGENTS.md`.
- Chat override: saying "circuit breaker override" clears an open breaker.
- Own CLI is never blocked, so `reset` works while open.
- `cli.js install|uninstall` registers hooks in `.devin/hooks.v1.json` without plugin support.

### Safety
- Fail open on bad input, internal error or >2 s runtime.
- Invalid config falls back to defaults in `observe` mode.
- Per-session state with atomic writes; append-only `events.jsonl` audit log.

### Tests
- 42 `node:test` unit/integration tests, 34-check end-to-end harness that spawns the
  hook with real stdin and asserts exit codes.
