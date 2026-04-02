# Task: KB-027 - Add dashboard UI toggle for autoResolveConflicts setting

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a straightforward UI addition to expose the existing `autoResolveConflicts` setting from the core package. The setting already exists in `packages/core/src/types.ts` with a default of `true`. This task only adds the dashboard UI toggle to control it.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Add a UI toggle in the dashboard Settings panel to allow users to enable/disable automatic merge conflict resolution. The `autoResolveConflicts` setting (already in `@kb/core`) controls whether lock files, generated files, and trivial whitespace conflicts are resolved automatically without AI intervention. This task exposes that setting in the Merge section with a checkbox and descriptive text explaining the feature.

## Dependencies

- **None** — The `autoResolveConflicts` setting already exists in `packages/core/src/types.ts`

## Context to Read First

- `packages/core/src/types.ts` — Verify `autoResolveConflicts` exists in `Settings` interface (line ~186) and `DEFAULT_SETTINGS` (line ~204)
- `packages/dashboard/app/components/SettingsModal.tsx` — Existing settings UI with sections (General, Scheduling, Worktrees, Commands, Merge, Model, Authentication)
- `packages/dashboard/app/components/__tests__/SettingsModal.test.tsx` — Test patterns for settings fields
- `packages/dashboard/app/api.ts` — `fetchSettings()` and `updateSettings()` API functions

## File Scope

- `packages/dashboard/app/components/SettingsModal.tsx` (modify — add toggle in Merge section)
- `packages/dashboard/app/components/__tests__/SettingsModal.test.tsx` (modify — add tests for the new toggle)

## Steps

### Step 0: Preflight

- [ ] Verify `autoResolveConflicts?: boolean` exists in `Settings` interface in `packages/core/src/types.ts` (~line 186)
- [ ] Verify `autoResolveConflicts: true` exists in `DEFAULT_SETTINGS` in `packages/core/src/types.ts` (~line 204)
- [ ] If the setting does NOT exist, **STOP** — the core types are not as expected

### Step 1: Add autoResolveConflicts Toggle to Merge Section

- [ ] Add `autoResolveConflicts` checkbox in the "merge" case of `renderSectionFields()` (after the `includeTaskIdInCommit` checkbox)
- [ ] Use `checkbox-label` class for the label
- [ ] Label text: "Auto-resolve conflicts in lock files and generated files"
- [ ] Description text (small element): "When enabled, lock files (package-lock.json, pnpm-lock.yaml, etc.), generated files (dist/*, *.gen.ts), and trivial whitespace conflicts are resolved automatically without AI intervention. Complex code conflicts still require AI review."
- [ ] Checked state: `form.autoResolveConflicts !== false` (defaults to true per `DEFAULT_SETTINGS`)
- [ ] onChange handler: `setForm((f) => ({ ...f, autoResolveConflicts: e.target.checked }))`
- [ ] Ensure the setting is included in the save payload (should be automatically spread via `...form`)

**Artifacts:**
- `packages/dashboard/app/components/SettingsModal.tsx` (modified — new checkbox in Merge section)

### Step 2: Add Tests for autoResolveConflicts Toggle

- [ ] Add `autoResolveConflicts: true` to `defaultSettings` mock in `SettingsModal.test.tsx`
- [ ] Add test: "shows Auto-resolve conflicts checkbox in Merge section"
  - Render SettingsModal, click "Merge" section
  - Verify checkbox exists via `getByLabelText` with the label text
  - Verify checkbox has `type="checkbox"`
- [ ] Add test: "toggling autoResolveConflicts checkbox sends false in save payload when unchecked"
  - Navigate to Merge section, uncheck the box, click Save
  - Wait for `updateSettings` to be called
  - Verify payload contains `autoResolveConflicts: false`
- [ ] Add test: "autoResolveConflicts defaults to enabled (true) when setting is true"
  - Mock `fetchSettings` to return `autoResolveConflicts: true`
  - Navigate to Merge section, verify checkbox is checked
- [ ] Run targeted tests: `pnpm test -- packages/dashboard/app/components/__tests__/SettingsModal.test.tsx`

**Artifacts:**
- `packages/dashboard/app/components/__tests__/SettingsModal.test.tsx` (modified — new test cases)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Run build: `pnpm build` — must pass

### Step 4: Documentation & Delivery

- [ ] Verify the toggle appears correctly in the Merge section alongside existing toggles (Auto-merge, Include task ID in commit scope)
- [ ] No changes needed to AGENTS.md (this is a dashboard-only UI change, not a new setting)
- [ ] No changeset needed (dashboard is not published — only `@dustinbyrne/kb` gets changesets)

## Documentation Requirements

**Must Update:**
- None — this is a dashboard UI-only change

**Check If Affected:**
- `packages/dashboard/README.md` — Update if there's a settings/feature section that lists available toggles

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Build passes (`pnpm build`)
- [ ] The "Auto-resolve conflicts in lock files and generated files" checkbox appears in the Merge section
- [ ] Checkbox is checked by default (when `autoResolveConflicts` is true or undefined)
- [ ] Unchecking the checkbox and saving sends `autoResolveConflicts: false` to `updateSettings`
- [ ] Helpful description text explains what files are auto-resolved (lock files, generated files, whitespace)

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-027): complete Step N — description`
- **Bug fixes:** `fix(KB-027): description`
- **Tests:** `test(KB-027): description`

## Do NOT

- Modify `packages/core/src/types.ts` — the setting already exists
- Modify the API routes or server-side settings handling — that flows through existing infrastructure
- Change the default behavior of `autoResolveConflicts` — it defaults to `true` in `DEFAULT_SETTINGS`
- Skip tests for the toggle behavior
- Use a different label class than `checkbox-label` (breaking consistency with other toggles)
- Place the toggle outside the Merge section (it belongs with other merge-related settings)
