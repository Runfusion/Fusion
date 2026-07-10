---
"@runfusion/fusion": patch
---

summary: CLI research/settings-import/agent-export/git/project commands close board stores promptly and retry a locked database.
category: fix
dev: Applies the FN-7731/FN-7738/FN-7704 CLI resolveProjectPathOnly + closeProjectStore/asLocalProjectContext + retryOnLock pattern to packages/cli/src/commands/research.ts, settings-import.ts, agent-export.ts, git.ts, and project.ts; path-only callers stop leaking the cached resolveProject TaskStore, getTaskCounts closes its per-project store, agent export closes its AgentStore, and importSettings/createExport retry FUSION_CLI_LOCK_RETRY_MS. The research non-wait fire-and-forget run path is intentionally exempted so it is not truncated; GlobalSettingsStore is file-backed and left unchanged.
