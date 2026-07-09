---
"@runfusion/fusion": patch
---

summary: All `fn task` subcommands now retry a momentarily locked board database and exit promptly instead of hanging or leaking.
category: fix
dev: Generalizes the FN-7731 CLI retryOnLock + closeProjectStore pattern across the ~26 runTask* handlers in packages/cli/src/commands/task.ts; honors FUSION_CLI_LOCK_RETRY_MS; closes both cached and uncached CWD-fallback stores; multi-step flows (create/retry/delete/merge/imports) retry each discrete write independently instead of the whole flow.
