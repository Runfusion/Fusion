---
"@runfusion/fusion": patch
---

Restore canonical mergeDetails.commitSha for tasks FN-3794, FN-3814, FN-3829 whose attribution had been overwritten by self-healing reconciliation prior to the FN-3862 fix. Adds an idempotent restoration script (`scripts/restore-merge-sha-fn-3878.mjs`) for operators to re-verify or repair similar drift.
