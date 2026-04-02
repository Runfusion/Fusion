# Task: KB-037 - Add smartConflictResolution toggle to dashboard settings UI

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a straightforward UI addition to expose the existing `smartConflictResolution` setting from the core package. The setting was added in KB-023 with a default of `true`. This task adds the dashboard UI toggle to control it, following the same pattern as other boolean toggles in the Merge section.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Add a UI toggle in the dashboard Settings panel to allow users to enable/disable smart automatic merge conflict resolution. The `smartConflictResolution` setting (already in `@kb/core`) is the preferred alias for `autoResolveConflicts` and controls whether lock files, generated files, and trivial whitespace conflicts are resolved automatically without AI intervention. This task exposes that setting in the Merge section with a checkbox and descriptive text explaining the feature.

## Dependencies

- **Task:** KB-023 — The `smartConflictResolution` setting must be added to `packages/core/src/types.ts` (already complete)
- **Task:** KB-027 — The `autoResolveConflicts` toggle should be implemented first to establish the pattern in the Merge section (can be done in parallel or before)

## Context to Read First

- `packages/core/src/types.ts` — Verify `smartConflictResolution` exists in `Settings` interface (line ~189) and `DEFAULT_SETTINGS` (line ~207)
- `packages/dashboard/app/components/SettingsModal.tsx` — Existing settings UI with Merge section containing `autoMerge` and `includeTaskIdInCommit` toggles
- `packages/dashboard/app/components/__tests__/SettingsModal.test.tsx` — Test patterns for settings fields (see existing checkbox tests for `includeTaskIdInCommit` and `recycleWorktrees`)
- `packages/dashboard/app/api.ts` — `fetchSettings()` and `updateSettings()` API functions

## File Scope

- `packages/dashboard/app/components/SettingsModal.tsx` (modify — add toggle in Merge section)
- `packages/dashboard/app/components/__tests__/SettingsModal.test.tsx` (modify — add tests for the new toggle)

## Steps

### Step 0: Preflight

- [ ] Verify `smartConflictResolution?: boolean` exists in `Settings` interface in `packages/core/src/types.ts` (~line 189)
- [ ] Verify `smartConflictResolution: true` exists in `DEFAULT_SETTINGS` in `packages/core/src/types.ts` (~line 207)
- [ ] Verify KB-023 is complete (the setting must exist in core types)
- [ ] If the setting does NOT exist, **STOP** — the core types are not as expected

### Step 1: Add smartConflictResolution Toggle to Merge Section

- [ ] Add `smartConflictResolution` checkbox in the "merge" case of `renderSectionFields()` (after the `includeTaskIdInCommit` checkbox or after `autoResolveConflicts` if KB-027 is complete)
- [ ] Use `checkbox-label` class for the label (consistent with other toggles)
- [ ] Label text: "Smart conflict resolution"
- [ ] Description text (small element): "When enabled, lock files (package-lock.json, pnpm-lock.yaml, etc.) are resolved using 'ours' strategy, generated files (dist/*, *.gen.ts) using 'theirs' strategy, and trivial whitespace conflicts are auto-resolved without spawning an AI agent. Complex code conflicts still require AI review."
- [ ] Checked state: `form.smartConflictResolution !== false` (defaults to true per `DEFAULT_SETTINGS`)
- [ ] onChange handler: `setForm((f) => ({ ...f, smartConflictResolution: e.target.checked }))`
- [ ] Ensure the setting is included in the save payload (automatically included via `...form` spread in `handleSave`)

**Artifacts:**
- `packages/dashboard/app/components/SettingsModal.tsx` (modified — new checkbox in Merge section)

### Step 2: Add Tests for smartConflictResolution Toggle

- [ ] Add `smartConflictResolution: true` to `defaultSettings` mock in `SettingsModal.test.tsx`
- [ ] Add test: "shows Smart conflict resolution checkbox in Merge section"
  - Render SettingsModal, click "Merge" section
  - Verify checkbox exists via `getByLabelText` with label text "Smart conflict resolution"
  - Verify checkbox has `type="checkbox"`
- [ ] Add test: "toggling smartConflictResolution checkbox sends false in save payload when unchecked"
  - Navigate to Merge section, uncheck the box, click Save
  - Wait for `updateSettings` to be called
  - Verify payload contains `smartConflictResolution: false`
- [ ] Add test: "smartConflictResolution defaults to enabled (true) when setting is true"
  - Mock `fetchSettings` to return `smartConflictResolution: true`
  - Navigate to Merge section, verify checkbox is checked via `toBeChecked()` or checked attribute
- [ ] Add test: "smartConflictResolution checkbox submits true in save payload when checked"
  - Mock `fetchSettings` to return `smartConflictResolution: false`
  - Navigate to Merge section, check the box, click Save
  - Verify payload contains `smartConflictResolution: true`
- [ ] Run targeted tests: `pnpm test -- packages/dashboard/app/components/__tests__/SettingsModal.test.tsx`

**Artifacts:**
- `packages/dashboard/app/components/__tests__/SettingsModal.test.tsx` (modified — new test cases)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Run build: `pnpm build` — must pass

### Step 4: Documentation & Delivery

- [ ] Verify the toggle appears correctly in the Merge section alongside existing toggles
- [ ] No changes needed to AGENTS.md — this is a dashboard UI-only change (setting already documented in KB-023)
- [ ] No changeset needed — dashboard is not published (only `@dustinbyrne/kb` gets changesets)
- [ ] If KB-027 was completed first, verify both toggles (`autoResolveConflicts` and `smartConflictResolution`) appear correctly together

## Documentation Requirements

**Must Update:**
- None — this is a dashboard UI-only change (the setting was documented in AGENTS.md during KB-023)

**Check If Affected:**
- `packages/dashboard/README.md` — Update if there's a settings/feature section that lists available toggles

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Build passes (`pnpm build`)
- [ ] The "Smart conflict resolution" checkbox appears in the Merge section
- [ ] Checkbox is checked by default (when `smartConflictResolution` is true or undefined)
- [ ] Unchecking the checkbox and saving sends `smartConflictResolution: false` to `updateSettings`
- [ ] Checking the checkbox and saving sends `smartConflictResolution: true` to `updateSettings`
- [ ] Helpful description text explains what files are auto-resolved (lock files with 'ours', generated files with 'theirs', whitespace conflicts)
- [ ] UI follows the same pattern as other checkbox toggles in the Merge section (`autoMerge`, `includeTaskIdInCommit`)

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-037): complete Step N — description`
- **Bug fixes:** `fix(KB-037): description`
- **Tests:** `test(KB-037): description`

## Do NOT

- Modify `packages/core/src/types.ts` — the setting already exists from KB-023
- Modify the API routes or server-side settings handling — that flows through existing infrastructure
- Change the default behavior of `smartConflictResolution` — it defaults to `true` in `DEFAULT_SETTINGS`
- Skip tests for the toggle behavior
- Use a different label class than `checkbox-label` (breaking consistency with other toggles)
- Place the toggle outside the Merge section (it belongs with other merge-related settings)
- Remove or hide the `autoResolveConflicts` toggle if present (both settings can coexist; `smartConflictResolution` takes precedence when both are set)
