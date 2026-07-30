---
"@runfusion/fusion": patch
---

summary: Declare the pending-review park as a step in the Legacy coding workflow, so it is visible in the editor.
category: internal
dev: Adds a `review-handoff` seam node (`review-pending-handoff`) plus `execute --outcome:review-pending--> review-pending-handoff --success--> end` to BUILTIN_CODING_WORKFLOW_IR. Inert — no seam returns `review-pending` yet; the behavior move lands separately once the step-session chain can surface the exit.
