---
name: configure
description: Change circuit breaker thresholds (cost, tokens, repetition count, time limit, rate) or mode (observe/warn/enforce) for this project or globally
---

Translate the user's request into `set` commands. Project scope is the default and writes `<project>/.devin/circuit-breaker.json`; add `--user` to write `~/.config/devin/circuit-breaker/config.json` instead.

| Key | Meaning | Default |
|---|---|---|
| `mode` | `observe` (log only) / `warn` (nudge agent, never block) / `enforce` (block tool calls while open) | `enforce` |
| `limits.costUsd` | estimated USD per session | `10` |
| `limits.tokens` | estimated tokens per session | `500000` |
| `limits.minutes` | session wall-clock limit | `60` |
| `limits.tokensPerMinute` | burst limit | `60000` |
| `loop.warnAt` | identical failing calls before a warning | `3` |
| `loop.blockAt` | identical failing calls before the breaker opens | `4` |
| `loop.window` | how many recent calls are considered | `8` |
| `warnAtPercent` | warn when a budget reaches this % | `80` |
| `pricing.inputUsdPerMTok` / `outputUsdPerMTok` | rate used for estimates | `3` / `15` |

Examples:

```bash
node "$DEVIN_PLUGIN_ROOT/bin/cli.js" set limits.costUsd 5
node "$DEVIN_PLUGIN_ROOT/bin/cli.js" set loop.blockAt 3
node "$DEVIN_PLUGIN_ROOT/bin/cli.js" set mode warn
node "$DEVIN_PLUGIN_ROOT/bin/cli.js" set --user limits.minutes 120
node "$DEVIN_PLUGIN_ROOT/bin/cli.js" init        # full editable config file
```

Show the user the printed effective config. Changes take effect on the next tool call; no restart needed.
