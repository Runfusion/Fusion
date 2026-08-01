---
"@runfusion/fusion": patch
---

summary: Review stalls are surfaced again on boards with renamed columns.
category: fix
dev: #2951 converted `surfaceInReviewStalls` to read the project's review columns but its conflict resolution dropped the per-card `reviewColumns` argument to `getInReviewStallReason` — and the test proving it — so the sweep resolved lanes and then surfaced nothing. Both restored.
