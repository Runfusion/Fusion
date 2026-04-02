# Task: KB-036 - Add Worktree/Branch Naming Setting

**Created:** 2026-03-30
**Size:** M

## Review Level: 1 (Plan Only)

**Assessment:** This is a straightforward settings addition with UI changes. The pattern is consistent with existing settings like `recycleWorktrees`. No complex logic or security implications.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

Add a new setting that controls how worktree directory names are generated when `recycleWorktrees` is NOT enabled. Currently, fresh worktrees get random human-friendly names like "swift-falcon". This task adds an option to generate worktree names from task metadata (task ID or task title) for better traceability.

## Dependencies

- **None**

## Context to Read First

- `packages/core/src/types.ts` — Settings interface and DEFAULT_SETTINGS
- `packages/engine/src/executor.ts` — Worktree creation logic (see `execute()` method around line 215-280)
- `packages/engine/src/worktree-names.ts` — Current name generation functions
- `packages/dashboard/app/components/SettingsModal.tsx` — UI for settings (see "worktrees" section around line 200-230)

## File Scope

- `packages/core/src/types.ts` — Add new setting type and default
- `packages/engine/src/executor.ts` — Use setting for worktree naming
- `packages/dashboard/app/components/SettingsModal.tsx` — Add UI control for new setting
- `packages/engine/src/executor.test.ts` — Add tests for new naming behavior

## Steps

### Step 1: Add Setting Type and Default

- [ ] Add `worktreeNaming?: "random" | "task-id" | "task-title"` to `Settings` interface in `packages/core/src/types.ts`
- [ ] Add `worktreeNaming: "random"` to `DEFAULT_SETTINGS` in same file
- [ ] Run `pnpm build` to verify types compile

**Artifacts:**
- `packages/core/src/types.ts` (modified)

### Step 2: Update Executor to Use Setting

- [ ] Modify `execute()` method in `packages/engine/src/executor.ts` to check `settings.worktreeNaming`
- [ ] When `worktreeNaming` is `"task-id"`, use task ID as worktree name (e.g., `kb-042`)
- [ ] When `worktreeNaming` is `"task-title"`, use slugified task title (e.g., `fix-login-bug` from "Fix login bug")
- [ ] When `worktreeNaming` is `"random"` or undefined, keep existing `generateWorktreeName()` behavior
- [ ] Ensure the setting ONLY affects fresh worktrees (not pooled/recycled ones)
- [ ] Run targeted tests: `pnpm test -- packages/engine/src/executor.test.ts`

**Artifacts:**
- `packages/engine/src/executor.ts` (modified)

### Step 3: Add Dashboard UI Control

- [ ] Add radio button group or select dropdown in SettingsModal "worktrees" section
- [ ] Place the new control below the "Recycle worktrees" checkbox
- [ ] Label: "Worktree naming style" with options:
  - "Random names (e.g., swift-falcon)" → value: "random"
  - "Task ID (e.g., kb-042)" → value: "task-id"
  - "Task title (e.g., fix-login-bug)" → value: "task-title"
- [ ] Add descriptive small text explaining the setting only applies when recycling is off
- [ ] Ensure the control is disabled or shows a hint when `recycleWorktrees` is enabled
- [ ] Run dashboard tests: `pnpm test -- packages/dashboard/app/components/__tests__/SettingsModal.test.tsx`

**Artifacts:**
- `packages/dashboard/app/components/SettingsModal.tsx` (modified)

### Step 4: Add Executor Tests

- [ ] Add test case in `packages/engine/src/executor.test.ts` for `worktreeNaming: "task-id"`
- [ ] Add test case for `worktreeNaming: "task-title"`
- [ ] Add test case verifying "random" mode still uses `generateWorktreeName()`
- [ ] Add test case verifying pooled worktrees ignore the setting (recycle mode)
- [ ] Run full engine test suite: `pnpm test -- packages/engine`

**Artifacts:**
- `packages/engine/src/executor.test.ts` (modified)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`
- [ ] Manual verification: Open dashboard settings, verify new control appears and saves correctly

### Step 6: Documentation & Delivery

- [ ] Update `AGENTS.md` settings documentation section to include the new `worktreeNaming` setting
- [ ] Create changeset file for the change (minor bump - new feature)
- [ ] Verify no out-of-scope findings

**Artifacts:**
- `.changeset/add-worktree-naming-setting.md` (new)

## Documentation Requirements

**Must Update:**
- `AGENTS.md` — Add `worktreeNaming` to the settings section with description and valid values

**Check If Affected:**
- No other documentation references worktree naming specifically

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Documentation updated
- [ ] Changeset created
- [ ] Dashboard shows and saves the new setting correctly

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-036): complete Step N — description`
- **Bug fixes:** `fix(KB-036): description`
- **Tests:** `test(KB-036): description`

## Do NOT

- Change the default behavior (random naming) — keep backward compatibility
- Affect pooled/recycled worktrees — this setting only applies to fresh worktrees
- Add complex slugification logic — use simple lowercase + replace spaces/special chars with hyphens
- Skip adding tests for the new setting
- Modify branch naming (branches stay as `kb/{task-id}` regardless of this setting)
