---
"@runfusion/fusion": patch
---

summary: `fn settings set` now accepts seven more real merge/handoff `ProjectSettings` keys instead of rejecting them as unknown.
category: fix
dev: Added `pushAfterMerge`, `pushRemote`, `autoResolveReviewComments`, `mergeStrategy`, `directMergeCommitStrategy`, `mergeAdvanceAutoSync`, and `owningNodeHandoffPolicy` to the CLI's `VALID_SETTINGS`/`PROJECT_ONLY_SETTINGS` whitelists (and the appropriate `BOOLEAN_SETTINGS`/`STRING_SETTINGS`/`ENUM_SETTINGS` array) in `packages/cli/src/commands/settings.ts`, plus the `runSettingsShow()` "Merge"/"Node Routing" display groups. All seven already had defaults in `DEFAULT_PROJECT_SETTINGS` and are consumed by the merge engine, but were missing from the CLI whitelist. `requirePrApproval` was intentionally NOT added — it was hard-moved to workflow settings in U4 (`MovedProjectSettingsKey` in `packages/core/src/settings-schema.ts`) and has no default in `DEFAULT_PROJECT_SETTINGS`; use `fn_workflow_settings` instead.
