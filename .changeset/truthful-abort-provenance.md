---
"@runfusion/fusion": patch
---

summary: Task logs no longer report engine-initiated aborts as operator "hard-cancel" pauses.
category: fix
dev: `awaitAbortInFlightTaskWork` derives pause-abort provenance from `options.userCanceled` — operator withdrawals keep `hard-cancel`, engine/lifecycle teardowns get the new `engine-abort` member of `PausedAbortProvenance`. Benign-abort classifiers in `handleGraphFailure` accept both via `isGenericAbortProvenance()`, so recovery behaviour is unchanged.
