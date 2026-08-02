---
"@runfusion/fusion": patch
---

summary: Show why a task needs approval — the Plan Review replan-cap reason now survives to the board.
category: fix
dev: `updateTask` never merged `awaitingApprovalReason`, so every writer dropped it and `isReviewBudgetExhaustedApproval` UI was dead. Set persists, null clears, and leaving `awaiting-approval` auto-clears a stale reason.
