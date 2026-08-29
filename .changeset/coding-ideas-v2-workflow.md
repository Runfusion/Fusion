---
"@runfusion/fusion": minor
---

summary: Add the Coding (Ideas) V2 workflow, with verification and documentation as visible review steps.
category: feature
dev: New selectable built-in `builtin:coding-ideas-v2` clones `BUILTIN_CODING_IDEAS_WORKFLOW_IR` without mutating it, keeps the manual `ideas` intake (`autoTriage: false`), and moves Testing/Verification and Documentation & Delivery out of the planner's implementation checklist into `in-review` gates: `steps → verification → documentation-delivery → code-review → completion-summary → merge-gate`. Both write-capable gates precede Code Review because `execute-workflow-graph.ts` refuses write-capable nodes once an APPROVE exists (`workspace-review-seal-required`); the readonly `completion-summary` runs after it. Remediation edges re-enter at `verification` so a REVISE replays documentation before re-review. `packages/engine/src/__tests__/coding-ideas-v2-review-seal.test.ts` runs the production `workflowNodeRequiresWorktree` classifier over the graph as a ratchet against re-introducing the ordering defect.
