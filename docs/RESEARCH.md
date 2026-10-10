# Research: how mature projects build agent circuit breakers

Date: 2026-10-09. Repos were cloned into `../research/` and read; findings below drove the rewrite.

## 1. Which "plugin form" applies to Devin

Devin Desktop is a VS Code fork, so VS Code extensions *run* in it — but the VS Code
extension API has no hook into Devin's agent loop. It cannot see tool calls, deny them,
or inject context. **Only Devin hooks can halt the agent**, and a Devin plugin
(`.devin-plugin/plugin.json` + `hooks.json` + `skills/`) is how hooks ship.

Devin's hook protocol (stdin JSON → stdout JSON, `decision: block` / exit 2, `${DEVIN_PLUGIN_ROOT}`)
is deliberately Claude Code–compatible. So the directly transferable prior art is
**Claude Code hook plugins**, not VS Code extensions. That is what we studied.

## 2. Reference projects

| Project | Stars / signal | What we took |
|---|---|---|
| [phuryn/burnstop](https://github.com/phuryn/burnstop) — "budget fuse for Claude Code" | closest analog: token/$ cap + loop halt, ships as plugin | pure `evaluate()` → `render()` split; warn at 80% then halt; **never block the plugin's own CLI** so the user can always reset; per-session state keyed by `session_id` under the user dir; honest "bounded overshoot" docs |
| [cryptosaras/tokenward](https://github.com/cryptosaras/tokenward) — enforce cost caps | TS, 40 files, tests | single `dispatch` entry routed by event name; `runHook` fail-open wrapper with self-timeout; `observe` mode that logs what it *would* block; idempotent `install`/`uninstall` that preserves foreign hooks; config precedence project > user > defaults |
| [nadimtuhin/claude-code-self-critic](https://github.com/nadimtuhin/claude-code-self-critic) | stuck-detector hook | **pure cores, I/O at the edges, thin hooks** layout; command normalization (drop flag tokens); 3-level escalating nudges; test-runner exemption (red→green reruns are not loops) |
| [Princeu3/agent-loop-detector](https://github.com/Princeu3/agent-loop-detector) | zero-dep TS loop guard | hash `(tool, args)`; identical-call window; warn first, **enforce only if the warning is ignored**; idle/status-only tool list |
| [sentinel-hooks/claude-code-guardrails](https://github.com/sentinel-hooks/claude-code-guardrails) | 113-case red-team harness | test the hook **as a real subprocess** with real stdin and exit codes; harness works against any hook |
| [Belkins/cost-guardian](https://github.com/Belkins/cost-guardian) | native plugin, `/budget set --enforcement warn\|confirm\|block` | enforcement modes; product contract: call the numbers **estimates**, never "actual spend"; tests use temp HOME |
| [nodeshift/opossum](https://github.com/nodeshift/opossum) — 1.7k★ Node circuit breaker | the canonical library | state vocabulary `closed / open / half-open`; half-open = probe after reset, re-open fast if it fails again |
| [disler/claude-code-hooks-mastery](https://github.com/disler/claude-code-hooks-mastery) — 3.9k★ | canonical hook examples | hooks are small scripts, one per concern, JSON in/out |
| [anthropics/claude-code#30150](https://github.com/anthropics/claude-code/issues/30150) | upstream bug triage | the #2 bug class is "model retries the identical failing call"; proposed fix is exactly `(tool_name, args_hash)` repetition detection + inject a corrective message |

## 3. The one thing we cannot copy: real token counts

burnstop/tokenward read **real** usage from Claude Code's local JSONL transcripts
(`message.usage`). Devin has no equivalent:

- Hook payloads carry `tool_input` / `tool_response` but no usage field (docs, verified).
- Devin Desktop stores sessions in `~/Library/Application Support/Devin/User/acp-messages/*.db`
  (SQLite, `messages(kind,payload)`); we dumped one — 262 rows, **zero** token/usage keys.
- Real usage exists only server-side (`/session-stats`) or via enterprise OTel (`devin.token.usage`).

Therefore this plugin **estimates** tokens from byte size (`chars / 4`; CJK text under-counts)
and prices them with a configurable per-MTok rate. Tool *input* is text the model wrote
(priced as output tokens); tool *output* is text the model will read (priced as input tokens).
Loop detection, time limit, and rate spike do not depend on this estimate and are exact.

## 4. Design decisions derived from the above

1. **Zero dependencies, zero build step** (burnstop, sentinel, self-critic). Plain Node ≥ 18 CommonJS.
   `devin plugins install --local .` works immediately; nothing to compile.
2. **Pure core / thin edges**: `lib/breaker.js`, `lib/loop.js`, `lib/meter.js` have no I/O.
   `lib/state.js` and `bin/*.js` are the only files that touch disk/stdio.
3. **Fail open**: any internal error, bad JSON, or >2 s runtime → exit 0, no output (tokenward `_wrap`).
   The only way the agent is blocked is an explicit `decision: block`.
4. **Escalate, don't ambush** (agent-loop-detector, self-critic): identical failing call → warn at
   `loop.warnAt`, open the breaker at `loop.blockAt`. Budget/time caps warn at 80 % then trip.
5. **Three modes** (tokenward/cost-guardian): `observe` (log only), `warn` (nudge the agent, never deny),
   `enforce` (deny tool calls while open). Default `enforce`, because the user asked for automatic tripping.
6. **Never block our own CLI** (burnstop): `exec` calls containing `circuit-breaker` + `cli.js` always pass,
   so `reset` works while the breaker is open.
7. **opossum states**: `closed → open` on trip; `override`/`reset` → `half_open`; first successful
   non-trivial call closes it; a second trip while half-open re-opens with a sharper message.
8. **Red-team style harness** (`tests/harness.js`): spawns `bin/hook.js` with real stdin and asserts
   exit codes + output, exactly as Devin would run it.
9. **Idempotent installer** (tokenward): `cli.js install` merges into `.devin/hooks.v1.json`, never
   duplicates, preserves other hooks; `uninstall` removes only our entries. Plugin install path is
   `hooks.json` + `${DEVIN_PLUGIN_ROOT}`.
