---
"@runfusion/fusion": patch
---

summary: Workflows no longer die at the review handoff on boards with a renamed review lane.
category: fix
dev: The `review-handoff` seam transitioned to the literal `in-review`; post-U12 `moveTask` rejects a destination the workflow does not declare, so the transition threw `TransitionRejectionError` and killed the walk mid-run. The seam now asks for `columnRole: "review"` and the runtime primitive (which holds the store) resolves it against the task's own selection.
