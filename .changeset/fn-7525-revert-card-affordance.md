---
"@runfusion/fusion": minor
---

summary: Add a Revert action to Done/Archived task cards to undo landed changes.
category: feature
dev: Wires onRevertTask through Board/List/Detail surfaces; calls POST /tasks/:id/revert in "auto" mode with a conflict-confirm AI-undo fallback (mode: "ai").
