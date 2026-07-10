---
"@runfusion/fusion": patch
---

summary: `fn branch-group`/`fn pr` now retry a locked board database and exit promptly instead of hanging or leaking.
category: fix
dev: Applies the FN-7731 CLI retryOnLock + closeProjectStore pattern to packages/cli/src/commands/branch-group.ts and pr.ts (agent/node audited and left unchanged); honors FUSION_CLI_LOCK_RETRY_MS; closes both cached and uncached CWD-fallback stores on every exit path.
