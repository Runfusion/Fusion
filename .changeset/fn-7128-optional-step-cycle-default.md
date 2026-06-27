---
"@runfusion/fusion": minor
---

summary: Code Review and Browser Verification now cycle fixes until they pass, defaulting to up to 3 fix passes.
category: feature
dev: Raises the `maxPostReviewFixes` default from 1 to 3 — the budget governing the FN-7066 pre-merge optional-step fix loop and the self-healing in-review recovery loop. The optional step re-runs each pass and the task only proceeds once it passes (APPROVE/APPROVE_WITH_NOTES) or the budget is exhausted. Per-step configurable/unbounded budgets are tracked separately (FN-7129).
