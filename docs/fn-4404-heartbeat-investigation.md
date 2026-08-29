# FN-4404 heartbeat investigation (blocked)

## Status

Blocked during preflight due missing source data.

## Evidence collected

- `.fusion/fusion.db` exists and is readable.
- `sqlite3 .fusion/fusion.db "SELECT COUNT(*) FROM agents;"` returned `0`.
- Querying for `name = 'Technical Writer'` returned no rows.
- `fn_list_agents({ includeEphemeral: true })` returned no agents.

## Why this blocks FN-4404

The task requires measuring `Technical Writer` runtime config, `lastHeartbeatAt`, and heartbeat-run history, then classifying against engine/dashboard staleness thresholds. With no agent rows and no heartbeat runs present, there is no measurable state to classify and no evidence for Case A/B/C.

## Unblock requirements

Provide a project/runtime state (or DB snapshot) that contains:

1. A `Technical Writer` agent record in the agent store.
2. Corresponding heartbeat-run records for that agent.

Once available, the investigation can be completed per PROMPT.md Steps 1–5.
