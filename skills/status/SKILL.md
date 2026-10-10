---
name: status
description: Show circuit breaker state for this session - limits, estimated tokens/cost, elapsed time, whether it is open, and recent trips
---

Run and show the user the output verbatim in a code block:

```bash
node "$DEVIN_PLUGIN_ROOT/bin/cli.js" status
node "$DEVIN_PLUGIN_ROOT/bin/cli.js" events 10
```

If `$DEVIN_PLUGIN_ROOT` is empty in your shell, find the plugin path with `devin plugins info circuit-breaker` and substitute it.

Remind the user that token and cost figures are estimates from byte size (Devin hooks do not expose real usage); loop, rate and time triggers are exact.
