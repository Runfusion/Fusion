---
"@runfusion/fusion": patch
---

summary: Approving a replanned plan no longer resumes the task at its stale workflow position.
category: fix
dev: approve-plan now clears workflowIrPin, workflowIrPinNodeId and workflowIrPinColumnId in the same writes that persist the approval. A card returned for revision (Plan Review REVISE, return comment, spec/revise) kept the pin of its plan-replan or earlier implementation node, which advanced-triage self-healing and planner recovery could follow instead of the fresh Plan Review continuation.
