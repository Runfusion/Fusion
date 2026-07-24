---
"@runfusion/fusion": patch
---

summary: A finished plan is never a dead end — read it, keep refining, and create the task at any time.
category: fix
dev: Validated planning sessions reopen on any new turn (submitResponse/rewind clear `validated`; validateSession stays the only terminalizer). Complete-without-task sessions resume into the full plan review workspace instead of the create-retry card, and the create-failure screen gains a Back to plan action. The one-task-per-session claim (`proposalClaimId`) is unchanged.
