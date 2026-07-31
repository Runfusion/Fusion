---
"@runfusion/fusion": patch
---

summary: Fix node-override handling on workflows whose terminal node is not named "end".
category: fix
dev: `updateTask({ nodeId })` passes through `validateNodeOverrideChange` twice. The outer call resolved terminality via `resolveTaskWorkflowIrSync` (the default workflow under PostgreSQL); the inner call passed no options and fell to the literal `nodeId === "end"`. Both now resolve the task's own workflow via the new `isTaskTerminalNodeIdAsync`, and `branch-and-pr-entities.ts` leaves the sync-resolver call-site allow-list.
