---
"@runfusion/fusion": patch
---

summary: Recover stalled review checks without repeating failed reviews or requiring green non-blocking CI.
category: fix
dev: Bound delayed post-merge rechecks, fence pre-merge reseeding, and preserve actionable deterministic review failures.
