---
"@runfusion/fusion": patch
---

summary: Review stalls are surfaced, and judged consistently, on boards with renamed columns.
category: fix
dev: The three stall signals disagreed about a row's lane — two took a singular `reviewColumn` (first-per-role) and `getInReviewStallReason` had no seam and used the literal. All three now take a `reviewColumns` membership set, resolved once per row via `resolveReviewColumns`, and `surfaceInReviewStalls` reads the project's review columns instead of the literal `in-review`.
