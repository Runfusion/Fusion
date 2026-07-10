---
"@runfusion/fusion": patch
---

summary: Fix `fn agent stop`/`fn agent start` hanging up to 60s per retry instead of exiting.
category: fix
dev: Root cause was non-deterministic CLI process exit, not a DB lock — `resolveProject()` cached an unclosed `TaskStore` and `createAgentStore()` never closed the `AgentStore` it opened, leaving SQLite handles alive after the command's real work finished. Added `resolveProjectPathOnly`/`closeProjectStore` in `project-context.ts` so path-only callers never leak a `TaskStore`, explicit `AgentStore.close()` on every exit/return path in `agent.ts` (since `process.exit()` does not run pending `finally` blocks), and a bounded fast-fail timeout around the state-store write (default 10s, override via `FUSION_AGENT_CMD_TIMEOUT_MS`) so a genuinely stuck operation fails fast with a clear error and non-zero exit instead of hanging.
