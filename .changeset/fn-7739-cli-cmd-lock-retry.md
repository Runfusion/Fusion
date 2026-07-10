---
"@runfusion/fusion": patch
---

summary: `fn backup`/`memory-backup`/`mcp`/`db vacuum` now retry a locked board database and exit promptly instead of hanging.
category: fix
dev: Applies the FN-7731/FN-7738 CLI retryOnLock + closeProjectStore/asLocalProjectContext pattern to packages/cli/src/commands/backup.ts, memory-backup.ts, mcp.ts, and db.ts; closes cached, uncached CWD-fallback, and ad-hoc MCP secrets TaskStores on every exit path; retries MCP settings writes and DB VACUUM; honors FUSION_CLI_LOCK_RETRY_MS. GlobalSettingsStore is file-backed and left unchanged.
