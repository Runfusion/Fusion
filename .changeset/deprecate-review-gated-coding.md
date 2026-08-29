---
"@runfusion/fusion": patch
---

summary: Retire the Coding (review-gated) workflow, superseded by Coding (Ideas) V2.
category: internal
dev: Adds `builtin:review-gated-coding` to `DEPRECATED_BUILTIN_WORKFLOW_IDS`, the registry's official retirement mechanism: it disappears from new selection and from `toggleEligibleBuiltinWorkflowIds()` while `getBuiltinWorkflow` still resolves it, so tasks that already selected it keep working. It shipped with a success path that could never complete (`code-review -> documentation-delivery` places a write-capable node after a passed review, refused as `workspace-review-seal-required`).
