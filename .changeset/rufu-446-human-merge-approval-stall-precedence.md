---
"@runfusion/fusion": patch
---

summary: A card waiting on your merge decision is no longer badged a stall or failed after ~100 minutes.
category: fix
dev: The review-lane stall classifier had let the `completed-review-status-none` arm (FN-9317) land above the FN-514 delivery-lock exemption, so a card with the lock armed was badged `completed-review-status-none` every `taskStuckTimeoutMs` and terminalized at `inReviewStallDeadlockThreshold`. The exemption is now evaluated for that arm before it is claimed, and stays arm-scoped rather than an early return: a locked card still reports `no-worktree-no-merge-confirmed`, `merge-retries-exhausted`, `merge-blocker`, and `non-retryable-provider-error` whenever one of those refusals is also true.
