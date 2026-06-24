---
"@runfusion/fusion": major
---

**Breaking:** the `WorkflowOptionalStep` type, previously exported from `@runfusion/fusion`, is removed — any consumer importing it must migrate to `optional-group` nodes / `ResolvedWorkflowOptionalStep`.

Retire the legacy optional-step DECLARATION model now that optional steps are graph-native `optional-group` nodes. Remove the `WorkflowOptionalStep` type and the `WorkflowIrV2.optionalSteps` IR field, drop the workflow node editor's optional-step declaration authoring panel (sidebar section, mobile tab, and collapse state), and stop threading an `optionalSteps` array through `flowToIr`/`serializeGraph`. A legacy persisted `optionalSteps` key on an old v2 workflow row is now tolerated (ignored, not validated) at parse so old rows still load as v2, and the rollback-downgrade heuristic still treats such a row as v2. The per-task optional-step toggle surfaces are unchanged — they continue to list and toggle optional steps sourced from `optional-group` nodes via `resolveWorkflowOptionalSteps` (`ResolvedWorkflowOptionalStep`).
