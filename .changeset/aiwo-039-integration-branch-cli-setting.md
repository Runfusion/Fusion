---
"@runfusion/fusion": patch
---

summary: `fn settings set integrationBranch <branch>` now works instead of rejecting as unknown.
category: fix
dev: Added `integrationBranch` to the CLI's `VALID_SETTINGS`/`PROJECT_ONLY_SETTINGS`/`STRING_SETTINGS` whitelists in `packages/cli/src/commands/settings.ts` and to the `runSettingsShow()` "Merge" display group, so the documented `ProjectSettings.integrationBranch` field (consumed first by the engine's `resolveIntegrationBranch()`) is settable directly instead of requiring the `settings export` → hand-edit → `settings import --merge` workaround. `baseBranch` was intentionally NOT added — it is a per-Task/Mission field, not a `ProjectSettings` key.
---
