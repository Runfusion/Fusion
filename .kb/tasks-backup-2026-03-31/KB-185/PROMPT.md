# Task: KB-185 - Determine which settings should be project specific and which should be global - store global settings in the users ~/.pi directory properly and read from there for global settings

**Created:** 2026-03-30
**Size:** L

## Review Level: 3 (Full)

**Assessment:** This change touches core configuration architecture across multiple packages (core, dashboard, engine). It requires careful design of the settings hierarchy (global vs project-specific), backward compatibility handling, and UI updates to distinguish between setting scopes. Changes affect how settings are stored, merged, and displayed.

**Score:** 7/8 — Blast radius: 2 (multi-package changes), Pattern novelty: 2 (new architectural pattern), Security: 2 (filesystem access to home directory), Reversibility: 1 (migration reversible but creates files in ~/.pi)

## Mission

Implement a two-tier settings hierarchy that separates user-specific global settings (stored in `~/.pi/kb/settings.json`) from project-specific settings (stored in `.fusion/config.json`). Global settings apply across all kb projects for the current user, while project settings override globals for that specific project. The dashboard UI must distinguish between these scopes and provide clear UX for managing both.

## Dependencies

- **None**

## Context to Read First

- `packages/core/src/types.ts` — Current `Settings` interface and `DEFAULT_SETTINGS`
- `packages/core/src/store.ts` — `TaskStore.getSettings()` and `updateSettings()` methods
- `packages/dashboard/src/routes.ts` — Settings API endpoints (GET/PUT /settings)
- `packages/dashboard/app/components/SettingsModal.tsx` — Current settings UI
- `packages/engine/src/pi.ts` — How settings are used when creating AI agents
- `packages/cli/src/commands/dashboard.ts` — How settings are read at engine startup

## File Scope

### New Files
- `packages/core/src/global-settings.ts` — Global settings storage and retrieval
- `packages/core/src/global-settings.test.ts` — Tests for global settings

### Modified Files
- `packages/core/src/types.ts` — Split Settings into GlobalSettings + ProjectSettings
- `packages/core/src/store.ts` — Merge global + project settings in getSettings()
- `packages/core/src/index.ts` — Export new types and GlobalSettingsStore
- `packages/dashboard/src/routes.ts` — Add global settings endpoints, update PUT /settings
- `packages/dashboard/app/components/SettingsModal.tsx` — UI sections for global vs project settings
- `packages/dashboard/app/api.ts` — Add fetchGlobalSettings, updateGlobalSettings

## Settings Classification

### Global Settings (move to ~/.pi/kb/settings.json)
These are user preferences that should persist across all projects:
- `themeMode` — User's UI theme preference (dark/light/system)
- `colorTheme` — User's color theme preference (default/ocean/forest/etc)
- `defaultProvider` — Default AI model provider (anthropic/openai/etc)
- `defaultModelId` — Default AI model ID
- `defaultThinkingLevel` — Default thinking effort level
- `ntfyEnabled` — Enable push notifications
- `ntfyTopic` — ntfy.sh topic for notifications

### Project Settings (stay in .fusion/config.json)
These are project workflow and resource settings:
- `taskPrefix` — Task ID prefix (e.g., "KB")
- `maxConcurrent` — Max concurrent AI agents
- `maxWorktrees` — Max worktrees for this project
- `pollIntervalMs` — Scheduler poll interval
- `groupOverlappingFiles` — File overlap serialization
- `autoMerge` — Auto-merge completed tasks
- `mergeStrategy` — direct or pull-request
- `recycleWorktrees` — Worktree pooling
- `worktreeNaming` — random/task-id/task-title
- `worktreeInitCommand` — Post-creation setup command
- `testCommand` — Custom test command
- `buildCommand` — Custom build command
- `includeTaskIdInCommit` — Commit message format
- `autoResolveConflicts` — Auto-resolve lock/generated files
- `smartConflictResolution` — Alias for autoResolveConflicts
- `requirePlanApproval` — Manual spec approval required
- `globalPause` — Emergency stop (runtime state)
- `enginePaused` — Soft pause (runtime state)

## Steps

### Step 1: Design Settings Types

- [ ] Create `GlobalSettings` interface in `types.ts` with global-only fields
- [ ] Create `ProjectSettings` interface in `types.ts` with project-only fields
- [ ] Create `MergedSettings` type that combines both (project overrides global)
- [ ] Update `DEFAULT_SETTINGS` to `DEFAULT_GLOBAL_SETTINGS` and `DEFAULT_PROJECT_SETTINGS`
- [ ] Export all new types from `index.ts`
- [ ] Update existing `Settings` type to be the merged view (backward compatibility)

**Artifacts:**
- `packages/core/src/types.ts` (modified)
- `packages/core/src/index.ts` (modified)

### Step 2: Implement Global Settings Store

- [ ] Create `GlobalSettingsStore` class in `global-settings.ts`
- [ ] Store location: `~/.pi/kb/settings.json` (create dirs as needed)
- [ ] Methods: `getSettings()`, `updateSettings(patch)`, `init()`
- [ ] Proper error handling for missing dirs/files
- [ ] File locking/atomic writes (follow pattern from TaskStore)
- [ ] Write comprehensive tests in `global-settings.test.ts`

**Artifacts:**
- `packages/core/src/global-settings.ts` (new)
- `packages/core/src/global-settings.test.ts` (new)

### Step 3: Update TaskStore to Merge Settings

- [ ] Add `globalSettingsStore` property to TaskStore
- [ ] Modify `getSettings()` to merge: global ← project overrides
- [ ] Modify `updateSettings()` to only save project-level fields to `.fusion/config.json`
- [ ] Add new `updateGlobalSettings()` method that delegates to GlobalSettingsStore
- [ ] Ensure backward compatibility: existing projects without global settings continue to work
- [ ] Add tests for settings merging behavior in `store.test.ts`

**Artifacts:**
- `packages/core/src/store.ts` (modified)
- `packages/core/src/store.test.ts` (modified)

### Step 4: Update Dashboard API Routes

- [ ] Add GET `/settings/global` endpoint returning GlobalSettings
- [ ] Add PUT `/settings/global` endpoint to update GlobalSettings
- [ ] Modify GET `/settings` to return both scopes or keep as merged view
- [ ] Modify PUT `/settings` to reject global-only fields with 400 error + helpful message
- [ ] Add GET `/settings/scopes` endpoint returning { global: GlobalSettings, project: ProjectSettings }
- [ ] Update tests in `routes.test.ts`

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)
- `packages/dashboard/src/routes.test.ts` (modified)

### Step 5: Update Dashboard Frontend API

- [ ] Add `fetchGlobalSettings()` function
- [ ] Add `updateGlobalSettings(settings)` function
- [ ] Add `fetchSettingsByScope()` function
- [ ] Update `Settings` type imports if structure changed

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified)

### Step 6: Update Settings Modal UI

- [ ] Add "Global" section to sidebar (user-level settings)
- [ ] Add "Project" section to sidebar (project-level settings)
- [ ] Show visual indicator (globe icon vs folder icon) for scope
- [ ] Load both scopes on mount, display merged values appropriately
- [ ] When saving, route each setting to the correct scope endpoint
- [ ] Show warning when editing global settings ("This affects all projects")
- [ ] Add inline indicators showing which scope provides each value

**Artifacts:**
- `packages/dashboard/app/components/SettingsModal.tsx` (modified)

### Step 7: Update Engine to Respect Global Settings

- [ ] Verify engine reads settings via TaskStore.getSettings() (should work automatically)
- [ ] Ensure model selection falls back to global defaults correctly
- [ ] Test that global theme settings are respected

**Artifacts:**
- `packages/engine/src/pi.ts` (verify no changes needed, or minimal)

### Step 8: Migration and Backward Compatibility

- [ ] On first read, if ~/.pi/kb/settings.json doesn't exist, create it with defaults
- [ ] Document migration path: users can manually move settings if desired
- [ ] Ensure existing .fusion/config.json files continue to work (no forced migration)
- [ ] Add log message when creating global settings file for first time

### Step 9: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` in packages/core — all pass
- [ ] Run `pnpm test` in packages/dashboard — all pass
- [ ] Run `pnpm test` in packages/engine — all pass
- [ ] Run `pnpm test` in packages/cli — all pass
- [ ] Manual verification: Start dashboard, verify settings load correctly
- [ ] Verify global settings save to ~/.pi/kb/settings.json
- [ ] Verify project settings save to .fusion/config.json
- [ ] Verify merging works (global value visible, project override takes precedence)
- [ ] Build passes: `pnpm build`

### Step 10: Documentation & Delivery

- [ ] Update AGENTS.md Settings section to document global vs project settings
- [ ] Document the two file locations and their purposes
- [ ] Create changeset for the feature (minor bump for @dustinbyrne/kb)
- [ ] Out-of-scope findings: None expected

**Artifacts:**
- `.changeset/global-project-settings.md` (new)
- `AGENTS.md` (modified)

## Documentation Requirements

**Must Update:**
- `AGENTS.md` — Add "Settings Hierarchy" section explaining:
  - Global settings location: ~/.pi/kb/settings.json
  - Project settings location: .fusion/config.json
  - Merge behavior: project overrides global
  - Which settings belong to each scope

**Check If Affected:**
- `README.md` — Update if it mentions settings configuration
- `packages/dashboard/README.md` — Update settings API docs

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test` in all packages)
- [ ] Build passes (`pnpm build`)
- [ ] TypeScript type checking passes (`pnpm typecheck` where available)
- [ ] Global settings correctly persist to ~/.pi/kb/settings.json
- [ ] Project settings correctly persist to .fusion/config.json
- [ ] Settings merging works correctly (project overrides global)
- [ ] Dashboard UI distinguishes global vs project settings
- [ ] Backward compatibility: existing projects work without migration
- [ ] Documentation updated

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-185): complete Step N — description`
- **Bug fixes:** `fix(KB-185): description`
- **Tests:** `test(KB-185): description`
- **Documentation:** `docs(KB-185): description`

Example commits:
- `feat(KB-185): complete Step 1 — design settings types and split interfaces`
- `feat(KB-185): complete Step 2 — implement GlobalSettingsStore`
- `test(KB-185): add tests for global settings store`
- `feat(KB-185): complete Step 6 — update settings modal with scope indicators`

## Do NOT

- Expand scope to include automatic migration of existing settings (manual migration is acceptable)
- Break backward compatibility with existing .fusion/config.json files
- Store sensitive data (tokens, passwords) in global settings (keep using AuthStorage)
- Change the behavior of existing settings endpoints without deprecation notice
- Modify engine scheduling or agent behavior beyond settings reading
- Skip test coverage for the GlobalSettingsStore
- Use synchronous file operations (follow existing async patterns)
- Hardcode home directory paths (use `os.homedir()`)
