---
"@runfusion/fusion": minor
---

summary: You now get a mailbox notice whenever a task is deleted by someone other than you.
category: feature
dev: Adds `packages/core/src/task-delete-notice.ts` — a store-scoped `registerTaskDeleteNoticeMailbox` DI seam (mirroring the archive-worktree-disposer pattern) that the engine runtime wires to its `MessageStore`. Fires for `callerKind` `agent-tool` and `api-unattributed` only; `operator-ui`, `operator-cli`, and `engine` stay silent. Sent via `sendMessageOnce` keyed `task-delete-notice:<taskId>`, from all three `task:deleted` emission sites (SQLite `deleteTaskImpl`/`deleteTaskIfImpl`, PG `deleteTaskBackendImpl`), always after the delete transaction commits and always swallowing its own failures so a mailbox write can never fail a delete. Notification only — no delete gating. Prose lives in the mailbox body; run-audit metadata is unchanged.
