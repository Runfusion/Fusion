---
"@runfusion/fusion": minor
---

Surface `task.inReviewStall` in the dashboard. In-review tasks whose state matches a known stall code (merge-blocker, transient-merge-status-no-owner, merge-retries-exhausted, no-worktree-no-merge-confirmed) now show a "Stall" badge on the task card and a code-specific diagnostic row in the task detail modal, with a deep-link to the most recent self-healing "In-review stall surfaced" log entry.
