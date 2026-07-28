---
"@runfusion/fusion": patch
---

summary: Deny now withholds task-creating tools from agent sessions, and retried creates no longer duplicate.
category: fix
dev: Adds `isAgentTaskCreateToolAvailable` and `isAgentDelegateTaskToolAvailable` in `@fusion/engine` agent-tools. The outer execution session (`executor.ts`) and per-step workflow sessions (`step-session-executor.ts`) omit `fn_task_create` under `deny` and `fn_delegate_task` under both `deny` and `upon_validation` (delegation reaches the same `createAgentTask` primitive but has no proposal channel, so leaving it available would bypass operator validation). Suppression emits an `agent:task-create-withheld` run-audit event and appends a prompt section naming `fn_task_log` as the fallback, so the withheld tool reads as policy rather than malfunction. Execute-time refusals are retained as defense in depth. The pi extension's `isEphemeralCallerAgent` now fails closed, but that lane remains unenforced because pi's extension context carries no agent identity — documented as a known gap. Separately, the deterministic content-fingerprint duplicate window goes 60s -> 10m; the store query in `branch-and-pr-entities.ts` carried its own independent `60s`/`5m` clamp that capped the effective window, so both sites now share `FINGERPRINT_WINDOW_DEFAULT_MS`/`FINGERPRINT_WINDOW_MAX_MS`.
