# Task: KB-332 - Rename Task ID Prefix and Branch Naming

**Created:** 2026-03-31
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** Mechanical rename affecting task ID generation defaults and git branch naming patterns. Blast radius is moderate (~20 source files, ~100+ test references). Changes are straightforward but require coordinated updates across core, CLI, engine, and dashboard packages. Full test suite must pass.
**Score:** 4/8 — Blast radius: 2, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Update the default task ID prefix from `KB-` to `FN-` and git branch naming from `kb/{id}` to `fusion/{id}` as part of the comprehensive rebrand from "kb" to "Fusion". This ensures new tasks use the FN-XXX format and branches use the fusion/ prefix while maintaining backward compatibility with existing KB- tasks.

## Dependencies

- **Task:** KB-330 (internal packages renamed to @fusion/*) — must be complete to avoid naming confusion during the transition

## Context to Read First

Read these files to understand current ID generation and branch naming patterns:

1. `packages/core/src/store.ts` — Task ID generation in `allocateId()` method (line 540)
2. `packages/core/src/types.ts` — Settings type definition with `taskPrefix` documentation (line 551-553)
3. `packages/cli/src/commands/task.ts` — Branch naming in CLI commands (line 1008)
4. `packages/dashboard/src/routes.ts` — Branch naming in dashboard API (line 2947)
5. `packages/engine/src/merger.ts` — Branch naming in merger (line 541)
6. `packages/engine/src/executor.ts` — Branch naming in executor (lines 347, 990)

Verify current test expectations:
```bash
grep -rn '"KB-' --include="*.test.ts" --include="*.test.tsx" packages/
grep -rn '"kb/' --include="*.test.ts" --include="*.test.tsx" packages/
```

## File Scope

**Source files to modify (production code):**
- `packages/core/src/store.ts` — Change default prefix from "KB" to "FN" in `allocateId()`
- `packages/core/src/types.ts` — Update JSDoc comment for `taskPrefix` default
- `packages/core/src/store.ts` — Change branch pattern from `kb/${id}` to `fusion/${id}` (line 1180)
- `packages/cli/src/commands/task.ts` — Change branch pattern from `kb/${id}` to `fusion/${id}` (line 1008)
- `packages/dashboard/src/routes.ts` — Change branch pattern from `kb/${id}` to `fusion/${id}` (line 2947)
- `packages/engine/src/merger.ts` — Change branch pattern from `kb/${id}` to `fusion/${id}` (line 541)
- `packages/engine/src/executor.ts` — Change branch pattern from `kb/${id}` to `fusion/${id}` (lines 347, 990)

**Test files to update:**
- `packages/core/src/store.test.ts` — Update tests expecting "KB-" IDs to expect "FN-"
- `packages/cli/src/commands/dashboard.test.ts` — Update branch naming tests
- `packages/cli/src/commands/task.test.ts` — Update branch naming tests
- `packages/dashboard/app/components/PlanningModeModal.test.tsx` — Update branch references
- `packages/dashboard/app/components/__tests__/GitManagerModal.test.tsx` — Update branch references
- `packages/dashboard/app/hooks/__tests__/useTasks.test.ts` — Update branch references
- `packages/dashboard/app/utils/worktreeGrouping.test.ts` — Update branch references
- `packages/dashboard/app/utils/worktreeGrouping.ts` — Update JSDoc comments
- `packages/engine/src/executor.test.ts` — Update branch naming tests
- `packages/engine/src/notifier.test.ts` — Update branch references in mock data

**Documentation files (check if affected):**
- `packages/engine/src/executor.ts` — JSDoc comments mentioning `kb/kb-042` pattern
- `packages/engine/src/worktree-pool.ts` — JSDoc comments mentioning branch naming

## Steps

### Step 1: Update Default Task Prefix (KB- → FN-)

Change the default task ID prefix from "KB" to "FN" in core settings and ID generation:

- [ ] `packages/core/src/store.ts` line 540: Change `const prefix = settings?.taskPrefix || "KB";` to `const prefix = settings?.taskPrefix || "FN";`
- [ ] `packages/core/src/types.ts` line 552: Update JSDoc from `Defaults to "KB"` to `Defaults to "FN"`

**Verification:**
```bash
grep -n 'taskPrefix || "KB"' packages/core/src/store.ts
grep -n 'Defaults to "KB"' packages/core/src/types.ts
```
Expected: No matches (both changed to FN)

**Artifacts:**
- `packages/core/src/store.ts` (modified)
- `packages/core/src/types.ts` (modified)

### Step 2: Update Branch Naming Pattern (kb/ → fusion/)

Update all hardcoded branch naming patterns from `kb/${id}` to `fusion/${id}`:

- [ ] `packages/core/src/store.ts` line 1180: Change `` `kb/${id.toLowerCase()}` `` to `` `fusion/${id.toLowerCase()}` ``
- [ ] `packages/cli/src/commands/task.ts` line 1008: Change `` `kb/${id.toLowerCase()}` `` to `` `fusion/${id.toLowerCase()}` ``
- [ ] `packages/dashboard/src/routes.ts` line 2947: Change `` `kb/${task.id.toLowerCase()}` `` to `` `fusion/${task.id.toLowerCase()}` ``
- [ ] `packages/engine/src/merger.ts` line 541: Change `` `kb/${taskId.toLowerCase()}` `` to `` `fusion/${taskId.toLowerCase()}` ``
- [ ] `packages/engine/src/executor.ts` line 347: Change `` `kb/${task.id.toLowerCase()}` `` to `` `fusion/${task.id.toLowerCase()}` ``
- [ ] `packages/engine/src/executor.ts` line 990: Change `` `kb/${taskId.toLowerCase()}` `` to `` `fusion/${taskId.toLowerCase()}` ``

**Verification:**
```bash
grep -rn '`kb/' --include="*.ts" --include="*.tsx" packages/ | grep -v "node_modules" | grep -v ".worktrees" | grep -v "/dist/" | grep -v ".test."
```
Expected: Only references to `.fusion/` data directory (handled in KB-334), no `kb/${` patterns

**Artifacts:**
- `packages/core/src/store.ts` (modified)
- `packages/cli/src/commands/task.ts` (modified)
- `packages/dashboard/src/routes.ts` (modified)
- `packages/engine/src/merger.ts` (modified)
- `packages/engine/src/executor.ts` (modified)

### Step 3: Update JSDoc Comments and Documentation

Update code documentation that references the old branch naming pattern:

- [ ] `packages/engine/src/executor.ts`: Update JSDoc comment at line 1011 from `` `kb/kb-042` `` to `` `fusion/fn-042` ``
- [ ] `packages/engine/src/executor.ts`: Update JSDoc comment at line 1013 from `` `kb/kb-041` `` to `` `fusion/fn-041` ``
- [ ] `packages/engine/src/worktree-pool.ts`: Update JSDoc comment at line 114 from `` `kb/kb-042` `` to `` `fusion/fn-042` ``
- [ ] `packages/engine/src/worktree-pool.ts`: Update JSDoc comment at line 115 from `` `kb/kb-041` `` to `` `fusion/fn-041` ``
- [ ] `packages/dashboard/app/utils/worktreeGrouping.ts`: Update JSDoc comment from `kb/kb-001` to `fusion/fn-001`

**Artifacts:**
- `packages/engine/src/executor.ts` (modified)
- `packages/engine/src/worktree-pool.ts` (modified)
- `packages/dashboard/app/utils/worktreeGrouping.ts` (modified)

### Step 4: Update Test Files

Update all test expectations to use the new FN- prefix and fusion/ branch pattern:

- [ ] `packages/core/src/store.test.ts`: Update tests expecting "KB-001" to expect "FN-001" (lines 247, 690, 702-703, etc.)
- [ ] `packages/core/src/store.test.ts`: Update tests with "KB-999" dependencies to "FN-999"
- [ ] `packages/core/src/store.test.ts`: Update test description at line 688 from "default prefix produces KB-001 IDs" to "default prefix produces FN-001 IDs"
- [ ] `packages/cli/src/commands/dashboard.test.ts`: Update branch naming test at line 253 from `kb/{task-id-lower}` to `fusion/{task-id-lower}`
- [ ] `packages/cli/src/commands/dashboard.test.ts`: Update expected branch name at line 375 from `"kb/kb-093"` to `"fusion/kb-093"`
- [ ] `packages/cli/src/commands/task.test.ts`: Update any branch naming assertions
- [ ] `packages/dashboard/app/components/PlanningModeModal.test.tsx`: Update mock branch at line 475 from `"kb/kb-999"` to `"fusion/kb-999"`
- [ ] `packages/dashboard/app/components/__tests__/GitManagerModal.test.tsx`: Update mock branch at line 129 from `"kb/kb-001"` to `"fusion/kb-001"`
- [ ] `packages/dashboard/app/hooks/__tests__/useTasks.test.ts`: Update mock branch at line 417 from `"kb/kb-001"` to `"fusion/kb-001"`
- [ ] `packages/dashboard/app/utils/worktreeGrouping.test.ts`: Update test expectations for branch parsing
- [ ] `packages/engine/src/executor.test.ts`: Update branch expectations at lines 713, 2949
- [ ] `packages/engine/src/notifier.test.ts`: Update mock branches at lines 181, 210, 365, 384, 417

**Verification:**
```bash
grep -rn '"KB-' --include="*.test.ts" --include="*.test.tsx" packages/ | grep -v "node_modules" | grep -v ".worktrees" | grep -v "/dist/" | wc -l
```
Expected: 0 (or only references that specifically test backward compatibility with existing tasks)

```bash
grep -rn '"kb/' --include="*.test.ts" --include="*.test.tsx" packages/ | grep -v "node_modules" | grep -v ".worktrees" | grep -v "/dist/" | wc -l
```
Expected: 0 (or only references that specifically test backward compatibility)

**Artifacts:**
- All test files listed above (modified)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm install` to ensure dependencies are current
- [ ] Run `pnpm build` to verify all packages compile successfully
- [ ] Run `pnpm test` to verify all tests pass
- [ ] Fix any failing tests related to ID format or branch naming

**Common issues to watch for:**
- Tests that assert on exact task ID strings (e.g., expect(task.id).toBe("KB-001"))
- Tests that assert on exact branch names (e.g., expect(branch).toBe("kb/kb-001"))
- Integration tests that create real git branches

**Artifacts:**
- All builds pass
- All tests pass

### Step 6: Documentation & Delivery

- [ ] Create changeset for this change:
```bash
cat > .changeset/rename-task-prefix-and-branches.md << 'EOF'
---
"@fusion/core": minor
"@fusion/dashboard": minor
"@fusion/engine": minor
"@dustinbyrne/kb": minor
---

Rename default task ID prefix from KB- to FN- and branch naming from kb/ to fusion/
EOF
```
- [ ] Verify new tasks get FN-XXX IDs by creating a test task (if possible)
- [ ] Document that existing KB- tasks remain unchanged (forward-only change)
- [ ] Out-of-scope findings: If you discover references to `.fusion/` data directory, those are handled in KB-334 — do not modify

**Artifacts:**
- `.changeset/rename-task-prefix-and-branches.md` (new)

## Completion Criteria

- [ ] Default task prefix changed from "KB" to "FN" in `allocateId()`
- [ ] JSDoc for `taskPrefix` updated to reflect new default
- [ ] All branch naming patterns updated from `kb/${id}` to `fusion/${id}` (6 source locations)
- [ ] All JSDoc comments updated to show `fusion/fn-XXX` examples
- [ ] All test files updated to expect FN- IDs and fusion/ branches
- [ ] `pnpm build` passes for all packages
- [ ] `pnpm test` passes with zero failures
- [ ] Changeset file created for the change

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step 1:** `feat(KB-332): change default task prefix from KB to FN`
- **Step 2:** `feat(KB-332): change branch naming from kb/ to fusion/`
- **Step 3:** `docs(KB-332): update JSDoc comments for new naming patterns`
- **Step 4:** `test(KB-332): update test expectations for FN- prefix and fusion/ branches`
- **Step 5:** `test(KB-332): verify build and tests pass`
- **Step 6:** `chore(KB-332): add changeset for task prefix and branch rename`

## Do NOT

- Change existing task IDs (KB-XXX tasks remain as-is; this is forward-looking only)
- Rename the `.fusion/` data directory (handled in KB-334)
- Rename package names (handled in KB-330)
- Rename environment variables (handled in KB-333)
- Update user documentation files like AGENTS.md (handled in KB-335)
- Skip running the full test suite
- Modify files in `.worktrees/` directories (these are ephemeral)
