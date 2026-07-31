---
"@runfusion/fusion": patch
---

summary: A task awaiting manual plan approval is no longer planned, reviewed, or started before you approve it.
category: fix
dev: U7 (workflow-owned lifecycle) — `isTaskBlockedOnApproval` is now consulted by the three planning-lane advance surfaces that re-derived their own weaker check from `paused`/`userPaused`: `issueRelease` (plus its in-txn `moveTaskIf` predicate), both plan-review continuation seeders (`seedPreReleasePlanReviewContinuation`, `evaluateStrandedHoldContinuation`), and the drain classifier `resolvePlanningContinuationCandidate` (skip, never orphan). The gap was the status-only hold shape (`status: "awaiting-approval"`, no pause flag) the manual gate writes. Operator force-promote (`allowUnplanned`) still waives it.
