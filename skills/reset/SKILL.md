---
name: reset
description: Clear an open (tripped) circuit breaker so the session can continue
---

Only run this when the user explicitly asked to continue past a tripped breaker.

```bash
node "$DEVIN_PLUGIN_ROOT/bin/cli.js" reset
```

The command prints which trigger had opened the breaker. Tell the user, and if the trigger was `loop`, propose a different approach rather than repeating the call that caused it. The breaker is now half-open: another trip re-opens it immediately.
