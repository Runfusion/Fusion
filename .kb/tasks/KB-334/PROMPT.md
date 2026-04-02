# Task: KB-334 - Rename Task ID Prefix and Branch Naming from KB-XXX/kb/ to FN-XXX/fusion/

**Created:** 2026-03-31
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This is a mechanical rename affecting multiple files across packages. The pattern is consistent but the blast radius spans core, cli, engine, and dashboard packages. Tests must be updated to match new defaults.
**Score:** 5/8 — Blast radius: 2, Pattern novelty: 0, Security: 1, Reversibility: 2

## Mission

Rename the task ID prefix from "KB" to "FN" and branch naming pattern from `kb/` to `fusion/` to align with the new project branding. This involves:

1. Changing the default `taskPrefix` setting from "KB" to "FN" (produces FN-001, FN-002, etc.)
2. Updating all hardcoded branch naming from `kb/${taskId.toLowerCase()}` to `fusion/${taskId.toLowerCase()}`
3. Updating the Settings UI placeholder from "KB" to "FN"
4. Updating all affected tests to use the new naming conventions

Existing tasks retain their original KB-XXX IDs (handled by the `taskPrefix` setting which only affects new tasks). Existing branches are not renamed (this only affects new branch creation).

## Dependencies

- **Task:** KB-330 (Rename internal packages from @kb/* to @fusion/*) — Must be complete first

## Context to Read First

Read these files to understand current task ID generation and branch naming patterns:

1. `packages/core/src/types.ts` — `DEFAULT_PROJECT_SETTINGS` with `taskPrefix`, and `ProjectSettings` interface documentation
2. `packages/core/src/store.ts` — `allocateId()` method (line ~540) uses `|| "KB"` fallback, and `mergeTask()` branch naming (line ~1180)
3. `packages/cli/src/commands/dashboard.ts` — `getTaskBranchName()` function (line ~73)
4. `packages/cli/src/commands/task.ts` — Branch naming in task creation (line ~1008)
5. `packages/dashboard/src/routes.ts` — Branch naming in merge endpoint (line ~2947)
6. `packages/engine/src/executor.ts` — Branch naming in worktree creation (lines ~347, ~990)
7. `packages/engine/src/merger.ts` — Branch naming in merge flow (line ~541)
8. `packages/dashboard/app/components/SettingsModal.tsx` — taskPrefix input placeholder

Run these commands to find all occurrences:
```bash
# Find fallback KB string in allocateId()
grep -rn '|| "KB"' packages/core/src/ packages/cli/src/ packages/engine/src/ packages/dashboard/src/

# Find branch naming patterns in source files (excluding tests)
grep -rn '`kb/' packages/core/src/ packages/cli/src/ packages/engine/src/ packages/dashboard/src/ | grep -v ".test.ts" | grep -v ".test.tsx"

# Find all test file occurrences of branch patterns
grep -rn '"kb/' packages/ --include="*.test.ts" --include="*.test.tsx" | wc -l
```

## File Scope

**Core settings (default prefix change):**
- `packages/core/src/types.ts` — Change `taskPrefix: undefined` to `taskPrefix: "FN"` in `DEFAULT_PROJECT_SETTINGS`

**Branch naming (kb/ → fusion/):**
- `packages/core/src/store.ts` — Update `mergeTask()` branch naming (line ~1180)
- `packages/cli/src/commands/dashboard.ts` — Update `getTaskBranchName()` function
- `packages/cli/src/commands/task.ts` — Update task creation branch naming
- `packages/dashboard/src/routes.ts` — Update merge endpoint branch naming
- `packages/engine/src/executor.ts` — Update worktree branch naming (2 locations)
- `packages/engine/src/merger.ts` — Update merge flow branch naming

**UI updates:**
- `packages/dashboard/app/components/SettingsModal.tsx` — Update placeholder from "KB" to "FN"

**Test files (must match new behavior):**
- `packages/core/src/store.test.ts` — Update all KB-XXX references to FN-XXX, kb/ to fusion/
- `packages/cli/src/commands/dashboard.test.ts` — Update all test expectations
- `packages/cli/src/commands/task.test.ts` — Update test expectations
- `packages/dashboard/src/routes.test.ts` — Update test expectations
- `packages/dashboard/src/github.test.ts` — Update test expectations
- `packages/engine/src/executor.test.ts` — Update test expectations
- `packages/engine/src/notifier.test.ts` — Update test expectations
- `packages/engine/src/worktree-pool.test.ts` — Update kb/kb-042, kb/kb-099, kb/kb-001 patterns
- `packages/engine/src/pr-comment-handler.test.ts` — Update headBranch patterns
- `packages/engine/src/pr-monitor.test.ts` — Update headBranch patterns
- `packages/dashboard/app/components/PlanningModeModal.test.tsx` — Update test expectations
- `packages/dashboard/app/components/__tests__/GitManagerModal.test.tsx` — Update test expectations
- `packages/dashboard/app/components/__tests__/TaskDetailModal.test.tsx` — Update headBranch patterns
- `packages/dashboard/app/components/__tests__/TaskCard.test.tsx` — Update headBranch patterns
- `packages/dashboard/app/hooks/__tests__/useTasks.test.ts` — Update test expectations

## Steps

### Step 1: Update Default Task Prefix Setting

Change the default task prefix from "KB" to "FN" in the core types. Note: The `allocateId()` method uses `|| "KB"` fallback when settings are undefined. Setting a default value of "FN" in `DEFAULT_PROJECT_SETTINGS` ensures new projects use FN-XXX. Existing projects with `undefined` taskPrefix will continue getting KB-XXX until they explicitly configure "FN".

- [ ] In `packages/core/src/types.ts`, modify `DEFAULT_PROJECT_SETTINGS`:
  - Change `taskPrefix: undefined` to `taskPrefix: "FN"`
  - The `allocateId()` method will now default to "FN" for new projects
- [ ] Run `pnpm build` in `packages/core` to verify no type errors

**Artifacts:**
- `packages/core/src/types.ts` (modified)

### Step 2: Update Branch Naming Pattern (kb/ → fusion/)

Update all hardcoded branch naming patterns across the codebase.

- [ ] In `packages/core/src/store.ts` line ~1180, change:
  - `const branch = \`kb/${id.toLowerCase()}\`;` → `const branch = \`fusion/${id.toLowerCase()}\`;`
- [ ] In `packages/cli/src/commands/dashboard.ts` line ~73, change `getTaskBranchName()`:
  - `return \`kb/${taskId.toLowerCase()}\`;` → `return \`fusion/${taskId.toLowerCase()}\`;`
- [ ] In `packages/cli/src/commands/task.ts` line ~1008, change:
  - `const branchName = \`kb/${id.toLowerCase()}\`;` → `const branchName = \`fusion/${id.toLowerCase()}\`;`
- [ ] In `packages/dashboard/src/routes.ts` line ~2947, change:
  - `const branchName = \`kb/${task.id.toLowerCase()}\`;` → `const branchName = \`fusion/${task.id.toLowerCase()}\`;`
- [ ] In `packages/engine/src/executor.ts` lines ~347 and ~990, change both occurrences:
  - `\`kb/${task.id.toLowerCase()}\`` → `\`fusion/${task.id.toLowerCase()}\``
  - `\`kb/${taskId.toLowerCase()}\`` → `\`fusion/${taskId.toLowerCase()}\``
- [ ] In `packages/engine/src/merger.ts` line ~541, change:
  - `const branch = \`kb/${taskId.toLowerCase()}\`;` → `const branch = \`fusion/${taskId.toLowerCase()}\`;`

**Verification command:**
```bash
grep -rn '`kb/' packages/core/src/ packages/cli/src/ packages/engine/src/ packages/dashboard/src/ | grep -v ".test.ts" | grep -v ".test.tsx" | wc -l
```
Expected: 0 (all source occurrences replaced)

**Artifacts:**
- All branch naming source files (modified)

### Step 3: Update Settings UI Placeholder

Update the task prefix input placeholder in the dashboard settings.

- [ ] In `packages/dashboard/app/components/SettingsModal.tsx` line ~339:
  - Change `placeholder="KB"` to `placeholder="FN"`
- [ ] Verify the change appears correctly in the UI

**Artifacts:**
- `packages/dashboard/app/components/SettingsModal.tsx` (modified)

### Step 4: Update All Test Files

Update test expectations to match the new FN-XXX task IDs and fusion/ branch naming.

**Core package tests:**
- [ ] In `packages/core/src/store.test.ts`:
  - Update all `"KB-001"`, `"KB-002"`, etc. to `"FN-001"`, `"FN-002"`, etc.
  - Update all `headBranch: "kb/kb-001"` to `headBranch: "fusion/fn-001"`
  - Update `execSync` mock expectations for branch names
  - Update the test "default prefix produces KB-001 IDs" → "default prefix produces FN-001 IDs"

**CLI package tests:**
- [ ] In `packages/cli/src/commands/dashboard.test.ts`:
  - Update all `headBranch: "kb/kb-093"` to `headBranch: "fusion/fn-093"`
  - Update `getTaskBranchName("KB-093")` expectations to `getTaskBranchName("FN-093")`
  - Update all `git branch -d "kb/kb-093"` expectations to `git branch -d "fusion/fn-093"`

- [ ] In `packages/cli/src/commands/task.test.ts`:
  - Update all `headBranch: "kb/kb-001"` to `headBranch: "fusion/fn-001"`
  - Update mock expectations for branch-related git commands

**Dashboard package tests:**
- [ ] In `packages/dashboard/src/routes.test.ts`:
  - Update all `headBranch: "kb/kb-001"` to `headBranch: "fusion/fn-001"`

- [ ] In `packages/dashboard/src/github.test.ts`:
  - Update all `headRefName: "kb/kb-093"` to `headRefName: "fusion/fn-093"`
  - Update all `head: "kb/kb-093"` to `head: "fusion/fn-093"`

- [ ] In `packages/dashboard/app/components/PlanningModeModal.test.tsx`:
  - Update `branch: "kb/kb-999"` to `branch: "fusion/fn-999"`

- [ ] In `packages/dashboard/app/components/__tests__/GitManagerModal.test.tsx`:
  - Update `branch: "kb/kb-001"` to `branch: "fusion/fn-001"`

- [ ] In `packages/dashboard/app/components/__tests__/TaskDetailModal.test.tsx`:
  - Update `headBranch: "kb/kb-099"` to `headBranch: "fusion/fn-099"`

- [ ] In `packages/dashboard/app/components/__tests__/TaskCard.test.tsx`:
  - Update `headBranch: "kb/kb-129"` to `headBranch: "fusion/fn-129"`

- [ ] In `packages/dashboard/app/hooks/__tests__/useTasks.test.ts`:
  - Update `branch: "kb/kb-001"` to `branch: "fusion/fn-001"`

**Engine package tests:**
- [ ] In `packages/engine/src/executor.test.ts`:
  - Update all references to `kb/kb-064`, `kb/kb-065`, `kb/kb-dep` to `fusion/fn-064`, `fusion/fn-065`, `fusion/fn-dep`

- [ ] In `packages/engine/src/notifier.test.ts`:
  - Update all `branch: "kb/kb-001"` to `branch: "fusion/fn-001"`

- [ ] In `packages/engine/src/worktree-pool.test.ts`:
  - Update all `kb/kb-042`, `kb/kb-099`, `kb/kb-001` to `fusion/fn-042`, `fusion/fn-099`, `fusion/fn-001`
  - Update `git checkout -B "kb/kb-042" main` to `git checkout -B "fusion/fn-042" main`
  - Update `git checkout -B "kb/kb-042" kb/kb-041` to `git checkout -B "fusion/fn-042" fusion/fn-041`

- [ ] In `packages/engine/src/pr-comment-handler.test.ts`:
  - Update `headBranch: "kb/kb-001"` to `headBranch: "fusion/fn-001"`

- [ ] In `packages/engine/src/pr-monitor.test.ts`:
  - Update `headBranch: "kb/kb-001"` to `headBranch: "fusion/fn-001"`

**Verification command:**
```bash
# Check for remaining kb/ patterns in tests
grep -rn '"kb/' packages/ --include="*.test.ts" --include="*.test.tsx" | wc -l
```
Expected: 0 after all test updates

**Artifacts:**
- All test files (modified)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm install` to ensure dependencies are clean
- [ ] Run `pnpm build` to verify all packages compile successfully
- [ ] Run `pnpm test` to verify all tests pass
- [ ] Fix any build or test failures

**Verification checklist:**
- [ ] No remaining `kb/` branch naming in source files (excluding tests that explicitly test the new pattern)
- [ ] No remaining `|| "KB"` fallback in source files (the fallback can remain, but default is now FN)
- [ ] All tests pass with new FN-XXX and fusion/ patterns

**Artifacts:**
- `pnpm-lock.yaml` (may update if package versions changed)
- All builds pass
- All tests pass

### Step 6: Documentation & Delivery

- [ ] Create changeset for this minor-level change (new feature - branding update):
```bash
cat > .changeset/rename-task-prefix-branch.md << 'EOF'
---
"@dustinbyrne/kb": minor
"@fusion/core": minor
"@fusion/dashboard": minor
"@fusion/engine": minor
---

Rename default task ID prefix from KB to FN and branch naming from kb/ to fusion/
EOF
```
- [ ] Verify no hardcoded KB-XXX references remain in non-test source files (excluding comments explaining the taskPrefix setting)
- [ ] Out-of-scope findings: If you discover any KB-XXX references that should be preserved (e.g., documentation about migration), document them in the task log

**Artifacts:**
- `.changeset/rename-task-prefix-branch.md` (new)

## Completion Criteria

- [ ] `taskPrefix` default changed to "FN" in `DEFAULT_PROJECT_SETTINGS`
- [ ] All `kb/${taskId.toLowerCase()}` patterns changed to `fusion/${taskId.toLowerCase()}` in source files
- [ ] SettingsModal placeholder updated to "FN"
- [ ] All test files updated with new FN-XXX and fusion/ patterns
- [ ] `pnpm build` passes for all packages
- [ ] `pnpm test` passes with zero failures
- [ ] Changeset file created for the change

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step 1:** `feat(KB-334): change default taskPrefix from KB to FN`
- **Step 2:** `feat(KB-334): update branch naming from kb/ to fusion/`
- **Step 3:** `feat(KB-334): update settings UI placeholder to FN`
- **Step 4:** `test(KB-334): update test expectations for FN-XXX and fusion/`
- **Step 5:** `test(KB-334): verify build and tests pass`
- **Step 6:** `chore(KB-334): add changeset for task prefix rename`

## Do NOT

- Rename existing task directories or data files (`.fusion/` is handled in KB-336)
- Rename existing Git branches (only new branches use the fusion/ prefix)
- Change the `@dustinbyrne/kb` package name (handled in KB-331/KB-333)
- Modify the workflow step ID prefix (WS-XXX remains unchanged)
- Update documentation that references historical KB-XXX task IDs as examples
- Skip running the full test suite
- Commit lockfile or changeset without the task ID prefix
