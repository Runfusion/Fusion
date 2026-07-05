---
"@runfusion/fusion": minor
---

summary: AI-undo tasks now default to a configurable, stricter review workflow.
category: feature
dev: New project setting `aiUndoTaskWorkflowId` (default `builtin:review-heavy`) selects the workflow for AI-undo board tasks created by `POST /api/tasks/:id/revert` (`mode: "ai"`, the `auto` conflict fallback, and the workspace conflict fallback all share the `createAiUndoResult()` closure, so all three inherit this default). A blank/unset value means the created task inherits the project default workflow (pre-FN-7556 behavior). The route validates the configured id via `getWorkflowDefinition`/`isBuiltinWorkflowId` and falls back to inherit (with a logged warning) on a blank or unknown value, so a misconfigured id never breaks AI-undo task creation. The engine's `createAiUndoTask` helper stays pure — it only forwards a `workflowId` it is given, never resolves the setting itself. The Settings Modal UI field for this setting is a deliberate follow-up task; the value is settable today only via the settings API.
