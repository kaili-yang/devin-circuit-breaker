# circuit-breaker — a Devin plugin that stops runaway sessions

Install it and Devin sessions get a fuse. The breaker **trips** on:

| Trigger | What it watches | Exact? |
|---|---|---|
| **loop** | the same tool call (same command / same edit target) failing N times — the classic "retry the identical `npm install` all night" burn | yes |
| **cost** | estimated USD for the session | estimate |
| **tokens** | estimated tokens for the session | estimate |
| **rate** | estimated tokens in the last 60 s (burst) | estimate |
| **time** | session wall-clock minutes | yes |

Budget triggers warn the agent at 80 %, then trip. Loop detection warns at 3 identical
failures and trips at 4 (both configurable). When open, in `enforce` mode every tool
call is denied until you say **"circuit breaker override"** in chat or run reset.

Zero dependencies. Zero build. Node ≥ 18. Designed after
[burnstop](https://github.com/phuryn/burnstop), [tokenward](https://github.com/cryptosaras/tokenward),
[agent-loop-detector](https://github.com/Princeu3/agent-loop-detector) and
[claude-code-self-critic](https://github.com/nadimtuhin/claude-code-self-critic) — see [docs/RESEARCH.md](docs/RESEARCH.md).

## Install

**As a plugin** (Devin CLI / Devin Desktop, requires `devin auth login`):

```bash
devin plugins install kaili-yang/devin-circuit-breaker          # from GitHub
devin plugins install --local /path/to/devin-circuit-breaker    # or a local checkout, edits are live
```

This registers five hooks (`SessionStart`, `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `SessionEnd`),
an always-on rule (`AGENTS.md`) and three skills: `/circuit-breaker:status`, `/circuit-breaker:configure`, `/circuit-breaker:reset`.

**Without plugin support** — register the hooks directly in a project:

```bash
node /path/to/circuit-breaker/bin/cli.js install      # writes <project>/.devin/hooks.v1.json (idempotent)
node /path/to/circuit-breaker/bin/cli.js uninstall
```

Verify inside a session with `/hooks`.

> Plugin hooks in Devin are currently "best effort and fail open" (Devin docs). The breaker is a
> safety net for accidents and loops, not a billing control — pair it with your plan's usage limits.

## Configure

Defaults: `enforce` mode, $10 / 500k tokens / 60 min / 60k tok/min, loop warn 3× trip 4×.

```bash
node "$DEVIN_PLUGIN_ROOT/bin/cli.js" set limits.costUsd 5          # project: <project>/.devin/circuit-breaker.json
node "$DEVIN_PLUGIN_ROOT/bin/cli.js" set loop.blockAt 3
node "$DEVIN_PLUGIN_ROOT/bin/cli.js" set mode warn                 # observe | warn | enforce
node "$DEVIN_PLUGIN_ROOT/bin/cli.js" set --user limits.minutes 120 # global: ~/.config/devin/circuit-breaker/config.json
node "$DEVIN_PLUGIN_ROOT/bin/cli.js" init                          # dump a full config file to edit
```

Or just ask Devin: *"set the circuit breaker cost limit to $5"* — the `configure` skill runs these for you.

| Key | Default | Meaning |
|---|---|---|
| `mode` | `enforce` | `observe` logs only · `warn` nudges the agent, never blocks · `enforce` blocks tool calls while open |
| `limits.costUsd` / `limits.tokens` | `10` / `500000` | per-session estimates |
| `limits.minutes` | `60` | wall clock |
| `limits.tokensPerMinute` | `60000` | burst |
| `loop.warnAt` / `loop.blockAt` / `loop.window` | `3` / `4` / `8` | identical failing calls in the recent window |
| `loop.ignoreTools` | read, grep, glob, … | never counted as loops |
| `loop.exemptCommands` | jest, pytest, go test, … | re-running tests is not a loop |
| `warnAtPercent` | `80` | early warning for budget triggers |
| `pricing.inputUsdPerMTok` / `outputUsdPerMTok` / `charsPerToken` | `3` / `15` / `4` | estimation rates |

Precedence: defaults < user file < project file < env (`CIRCUIT_BREAKER_MODE`, `_MAX_COST`, `_MAX_TOKENS`,
`_MAX_MINUTES`, `_TOKENS_PER_MINUTE`, `_LOOP`, `_DISABLE=1`, `_DEBUG=1`). An invalid config falls back to
defaults in `observe` mode — a typo can never brick a session.

## What the agent sees

```
[circuit-breaker] WARNING: the same call has failed 3x: exec:npm install. Stop. You have attempted
the same action repeatedly and it keeps failing. Re-read the last error ... try a DIFFERENT approach.

[circuit-breaker] TRIPPED: the same call failed 4x in a row: exec:npm install. Further tool calls
are BLOCKED. Summarize what you did and what is failing, then stop and wait for the user.
```

Recover with any of: type `circuit breaker override` in chat · `/circuit-breaker:reset` ·
`node "$DEVIN_PLUGIN_ROOT/bin/cli.js" reset`. The CLI itself is never blocked (so you cannot get locked out).
After an override the breaker is **half-open**: it closes on the next successful call and re-opens
immediately on another trip. The breached budget limit is doubled for the rest of the session.

## Honest limits

- **Tokens and cost are estimates** (`chars / 4` at a flat per-MTok rate). Devin hooks carry no usage
  field and Devin stores no local transcript with usage (we checked the ACP SQLite store). Real figures
  live in `/session-stats`. Loop, rate-shape and time triggers do not depend on the estimate.
- The breaker trips **after** the call that crossed the line (PostToolUse) and denies from the **next** call.
- Agents can only be governed on the hook surface Devin exposes; a plugin cannot kill a running subagent.

## Layout

```
.devin-plugin/plugin.json   manifest
hooks.json                  5 lifecycle hooks -> bin/hook.js  (${DEVIN_PLUGIN_ROOT})
AGENTS.md                   always-on rule telling the agent how to react
skills/{status,configure,reset}/SKILL.md
bin/hook.js                 stdin -> dispatch -> stdout; fails OPEN (exit 0) on any error / 2 s timeout
bin/cli.js                  status | reset | set | init | config | events | install | uninstall
lib/breaker.js              pure state machine: closed -> open -> half_open; evaluate() in trigger order
lib/loop.js                 pure: signature normalisation, failing-call window, escalation levels
lib/meter.js                pure: byte-size token estimate, pricing, 60 s rate window
lib/config.js               defaults / merge / validate / fail-safe
lib/state.js                per-session JSON state (atomic writes) + events.jsonl audit log
lib/install.js              idempotent .devin/hooks.v1.json merge/unmerge
tests/*.test.js             42 node:test unit + integration tests (temp HOME, never your real config)
tests/harness.js            34 end-to-end checks that spawn bin/hook.js with real stdin, like Devin does
```

```bash
npm test            # unit + integration
npm run test:all    # + end-to-end harness
```

## License

MIT
