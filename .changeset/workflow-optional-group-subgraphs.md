---
"@runfusion/fusion": minor
---

Workflow editor: optional steps are now graph-native. A new `optional-group` container node (foreach/loop-style) holds a subgraph the executor runs once when the group is enabled for a task (per-task `enabledWorkflowSteps` + workflow `defaultOn`) and bypasses when disabled. All seven built-in add-ons (documentation-review, qa-check, security-audit, performance-review, accessibility-check, browser-verification, frontend-ux-design) are insertable from the node-editor palette as a node or wrapped in an optional-group. The built-in coding and stepwise-coding workflows now express `browser-verification` as an optional-group. Optional-group enable resolution correctly handles id collisions with add-on template ids, so a group's enable state is not silently bypassed during task creation/update. (The legacy declaration-based optional-steps model is retired in a sibling changeset; only the `workflow-step` seam infrastructure removal remains a follow-up.)
