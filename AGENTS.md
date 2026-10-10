# circuit-breaker plugin (always-on rule)

A circuit breaker watches this session through hooks: identical failing tool calls, estimated cost/token caps, token rate, and session time.

- `[circuit-breaker] WARNING` in a tool result: stop retrying the same call. Report progress and estimated cost to the user and ask how to proceed.
- `[circuit-breaker] TRIPPED` or a tool call denied by the breaker: do not look for workarounds. Summarize what you did and what is failing, then wait. The user can reply "circuit breaker override" or ask you to run the `/circuit-breaker:reset` skill.
- Never issue the exact same failing command more than twice in a row; change approach or ask.
- Limits are configurable: use `/circuit-breaker:status` and `/circuit-breaker:configure`.
