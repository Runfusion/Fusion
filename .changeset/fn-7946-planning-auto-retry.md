---
"@runfusion/fusion": minor
---

summary: Planning Mode now auto-retries a stuck AI generation up to 3 times before showing an error.
category: feature
dev: Bounded client-side auto-retry in PlanningModeModal reusing the existing /planning/:id/retry endpoint; counter resets on successful progress and is single-flighted across SSE onError, reopen, and the stuck poll.
