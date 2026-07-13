---
"@runfusion/fusion": patch
---

summary: `fn settings set mergeIntegrationWorktree <value>` now works instead of rejecting it as unknown.
category: fix
dev: Added `mergeIntegrationWorktree` to the CLI's `VALID_SETTINGS`/`PROJECT_ONLY_SETTINGS` whitelists and `ENUM_SETTINGS.mergeIntegrationWorktree: ["reuse-task-worktree", "cwd-integration-branch"]` in `packages/cli/src/commands/settings.ts`, plus the `runSettingsShow()` "Merge" display group. `mergeIntegrationWorktree` already had a default in `DEFAULT_PROJECT_SETTINGS` (`"reuse-task-worktree"`) and is consumed by the merge engine (`packages/engine/src/merger.ts`, `packages/engine/src/merger-integration-worktree.ts`), but was missing from the CLI whitelist — the one gap AIWO-040 explicitly deferred. The deprecated `"cwd-main"` legacy alias (`MergeIntegrationWorktreeMode` in `packages/core/src/types.ts`) is intentionally NOT added to `ENUM_SETTINGS`; `fn settings set mergeIntegrationWorktree cwd-main` is rejected with a clear "Invalid value" error, matching the pattern of every other enum setting in this file. `normalizeMergeIntegrationWorktreeMode()` remains the engine's read-time safety net for any pre-existing `"cwd-main"` config.
