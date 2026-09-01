---
"@runfusion/fusion": patch
---

summary: Fix a code review revision producing no fix steps after a Retry, leaving the card stuck in review.
category: fix
dev: A new workflow-graph run now clears the task-keyed abort markers (`userCanceledTaskIds`, `pausedAborted`, `pausedAbortProvenance`) at run birth. Nothing cleared them on the review path, and `awaitAbortInFlightTaskWork` stamps `markPausedAborted` unconditionally, so the dashboard Retry's pause/hard-cancel/unpause left leftovers that the NEXT run read as its own — the FN-249 cancellation exit swallowed the REVISE and `genuinePauseAbort` misclassified it as a pause abort.
