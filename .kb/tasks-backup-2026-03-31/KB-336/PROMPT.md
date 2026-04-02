# Task: KB-336 - Rename Data Directory from .fusion to .fusion

**Created:** 2026-03-31
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** Mechanical rename with moderate blast radius affecting core storage paths, test expectations, CLI output, and documentation strings. Pattern is consistent but touches many files across all packages. Full test suite must pass.
**Score:** 4/8 — Blast radius: 2, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Rename the data directory from `.fusion` to `.fusion` to complete the comprehensive rebrand from "kb" to "Fusion". This involves:

1. Changing the hardcoded directory name in `TaskStore` from `.fusion` to `.fusion`
2. Updating the default root directory in `AgentStore` from `.fusion` to `.fusion`
3. Updating `AutomationStore` to use `.fusion` directory
4. Updating engine triage attachment path construction
5. Updating dashboard file service and routes
6. Updating all test file path expectations
7. Updating CLI output messages that reference `.fusion`
8. Updating JSDoc comments that document the directory structure

**Important:** This change only affects where new projects store their data. Existing projects with `.fusion/` directories will continue to work (the system will auto-create `.fusion/` for new projects). Existing `.fusion/` directories are NOT migrated automatically.

## Dependencies

- **Task:** KB-330 (Rename internal packages from @kb/* to @fusion/*) — Must be complete first
- **Task:** KB-332 (Rename task ID prefix and branch naming) — Must be complete first to avoid confusion

## Context to Read First

Read these files to understand current data directory usage:

1. `packages/core/src/store.ts` — TaskStore constructor with `.fusion` path (line ~55)
2. `packages/core/src/agent-store.ts` — AgentStore default rootDir (line ~87)
3. `packages/core/src/automation-store.ts` — AutomationStore paths (lines ~33, ~41)
4. `packages/core/src/db.ts` — Database initialization and directory creation
5. `packages/core/src/db-migrate.ts` — Migration logic that references `.fusion`
6. `packages/engine/src/triage.ts` — Attachment path construction (line ~1045)
7. `packages/dashboard/src/file-service.ts` — Task directory resolution (line ~99)
8. `packages/dashboard/src/routes.ts` — PROMPT.md path construction (line ~1646)
9. `packages/cli/src/commands/task.ts` — CLI output referencing `.fusion/tasks/`
10. `packages/cli/src/extension.ts` — Extension output referencing `.fusion`

Run these commands to find all occurrences:
```bash
# Find hardcoded .fusion strings in non-test source files
grep -rn '"\.fusion"' --include="*.ts" --include="*.tsx" packages/ | grep -v "node_modules" | grep -v "/dist/" | grep -v ".test.ts" | grep -v ".test.tsx"

# Find all .fusion references in test files
grep -rn '"\.fusion"' --include="*.test.ts" --include="*.test.tsx" packages/ | wc -l
```

## File Scope

**Core source files (hardcoded directory names):**
- `packages/core/src/store.ts` — Change `.fusion` to `.fusion` in constructor (line ~55)
- `packages/core/src/agent-store.ts` — Change default rootDir from `.fusion` to `.fusion` (line ~87)
- `packages/core/src/automation-store.ts` — Change `.fusion` to `.fusion` in paths (lines ~33, ~41)
- `packages/core/src/db.ts` — Update directory creation message and JSDoc
- `packages/core/src/db-migrate.ts` — Update migration comments and strings

**Engine source files:**
- `packages/engine/src/triage.ts` — Update attachment path construction from `.fusion` to `.fusion` (line ~1045)

**CLI source files (output messages):**
- `packages/cli/src/commands/task.ts` — Update all `.fusion/tasks/` references in console.log output (lines ~46, ~244, ~438, ~481, ~513, ~1415)
- `packages/cli/src/commands/dashboard.ts` — Update `.fusion/tasks/` reference in console.log (line ~691)
- `packages/cli/src/extension.ts` — Update `.fusion/tasks/` references in tool output (lines ~102, ~290)
- `packages/cli/src/bin.ts` — Update configDir from `.fusion` to `.fusion` (line ~31)

**Dashboard source files:**
- `packages/dashboard/app/components/SettingsModal.tsx` — Update JSDoc comment referencing `.fusion/config.json`
- `packages/dashboard/src/file-service.ts` — Update task directory path (line ~99)
- `packages/dashboard/src/routes.ts` — Update PROMPT.md path construction (line ~1646)

**Test files (path expectations):**
- `packages/core/src/store.test.ts` — Update all `.fusion` path expectations to `.fusion`
- `packages/core/src/db.test.ts` — Update all `.fusion` path expectations
- `packages/core/src/db-migrate.test.ts` — Update all `.fusion` path expectations
- `packages/core/src/automation-store.test.ts` — Update all `.fusion` path expectations
- `packages/core/src/__tests__/store-sort.test.ts` — Update `.fusion` path expectations
- `packages/core/src/agent-store.test.ts` — Update `.fusion` path expectations
- `packages/engine/src/triage.test.ts` — Update all `.fusion` path expectations

**Documentation (check if affected):**
- `AGENTS.md` — Multiple `.fusion` references (handled in KB-335; do NOT modify in this task)
- `README.md` — Multiple `.fusion` references (handled in KB-335; do NOT modify in this task)

## Steps

### Step 1: Update Core Source Files

Change the hardcoded data directory name from `.fusion` to `.fusion`:

- [ ] In `packages/core/src/store.ts` line 55:
  - Change `this.kbDir = join(rootDir, ".fusion");` to `this.kbDir = join(rootDir, ".fusion");`
- [ ] In `packages/core/src/agent-store.ts` line 87:
  - Change `this.rootDir = options.rootDir ?? ".fusion";` to `this.rootDir = options.rootDir ?? ".fusion";`
- [ ] In `packages/core/src/automation-store.ts`:
  - Line 33: Change `this.automationsDir = join(rootDir, ".fusion", "automations");` to `this.automationsDir = join(rootDir, ".fusion", "automations");`
  - Line 41: Change `const kbDir = join(this.rootDir, ".fusion");` to `const kbDir = join(this.rootDir, ".fusion");`
- [ ] In `packages/core/src/db.ts`:
  - Update comment at line 198: `// Ensure .fusion directory exists` → `// Ensure .fusion directory exists`
  - Update JSDoc at line 342: `@param kbDir - Path to the \`.fusion\` directory` → `@param kbDir - Path to the \`.fusion\` directory`
- [ ] In `packages/core/src/db-migrate.ts`:
  - Update comment at line 4: `Detects legacy data (.fusion/tasks/, .fusion/config.json, etc.)` → `Detects legacy data (.fusion/tasks/, .fusion/config.json, etc.)`
  - Update comment at line 444: `Note: .fusion/tasks/ is NOT renamed` → `Note: .fusion/tasks/ is NOT renamed`

**Verification:**
```bash
grep -rn '"\.fusion"' --include="*.ts" --include="*.tsx" packages/core/src/ | grep -v "node_modules" | grep -v "/dist/" | grep -v ".test.ts"
```
Expected: Only references in JSDoc explaining legacy migration, no hardcoded paths

**Artifacts:**
- `packages/core/src/store.ts` (modified)
- `packages/core/src/agent-store.ts` (modified)
- `packages/core/src/automation-store.ts` (modified)
- `packages/core/src/db.ts` (modified)
- `packages/core/src/db-migrate.ts` (modified)

### Step 2: Update Engine Source Files

- [ ] In `packages/engine/src/triage.ts` line ~1045:
  - Change `join(rootDir, ".fusion", "tasks", taskId, "attachments", att.filename)` to `join(rootDir, ".fusion", "tasks", taskId, "attachments", att.filename)`

**Verification:**
```bash
grep -rn '"\.fusion"' --include="*.ts" --include="*.tsx" packages/engine/src/ | grep -v "node_modules" | grep -v "/dist/" | grep -v ".test.ts" | grep -v ".test.tsx"
```
Expected: No hardcoded `.fusion` references

**Artifacts:**
- `packages/engine/src/triage.ts` (modified)

### Step 3: Update Dashboard Source Files

- [ ] In `packages/dashboard/src/file-service.ts` line ~99:
  - Change `return resolve(join(rootDir, ".fusion", "tasks", taskId));` to `return resolve(join(rootDir, ".fusion", "tasks", taskId));`
- [ ] In `packages/dashboard/src/routes.ts` line ~1646:
  - Change `const promptPath = join(store.getRootDir(), ".fusion", "tasks", task.id, "PROMPT.md");` to `const promptPath = join(store.getRootDir(), ".fusion", "tasks", task.id, "PROMPT.md");`
- [ ] In `packages/dashboard/app/components/SettingsModal.tsx` line ~17:
  - Update JSDoc comment from `Project-specific settings stored in .fusion/config.json` to `Project-specific settings stored in .fusion/config.json`

**Verification:**
```bash
grep -rn '"\.fusion"' --include="*.ts" --include="*.tsx" packages/dashboard/ | grep -v "node_modules" | grep -v "/dist/" | grep -v ".test.ts" | grep -v ".test.tsx"
```
Expected: No hardcoded `.fusion` references

**Artifacts:**
- `packages/dashboard/src/file-service.ts` (modified)
- `packages/dashboard/src/routes.ts` (modified)
- `packages/dashboard/app/components/SettingsModal.tsx` (modified)

### Step 4: Update CLI Source Files

Update all user-facing output that references `.fusion`:

- [ ] In `packages/cli/src/commands/task.ts`:
  - Line ~46: Change `` `    Path:   .fusion/tasks/${task.id}/`, `` to `` `    Path:   .fusion/tasks/${task.id}/`, ``
  - Line ~244: Change `join(cwd, ".fusion", "tasks", id, "agent.log")` to `join(cwd, ".fusion", "tasks", id, "agent.log")`
  - Line ~438: Change `` `.fusion/tasks/${id}/attachments/${attachment.filename}` `` to `` `.fusion/tasks/${id}/attachments/${attachment.filename}` ``
  - Line ~481: Change `` `.fusion/tasks/${newTask.id}/` `` to `` `.fusion/tasks/${newTask.id}/` ``
  - Line ~513: Change `` `.fusion/tasks/${newTask.id}/` `` to `` `.fusion/tasks/${newTask.id}/` ``
  - Line ~1415: Change `` `    Path:   .fusion/tasks/${task.id}/` `` to `` `    Path:   .fusion/tasks/${task.id}/` ``

- [ ] In `packages/cli/src/commands/dashboard.ts` line ~691:
  - Change `` `  Tasks stored in .fusion/tasks/` `` to `` `  Tasks stored in .fusion/tasks/` ``

- [ ] In `packages/cli/src/extension.ts`:
  - Line ~102: Change `` `Path: .fusion/tasks/${task.id}/` `` to `` `Path: .fusion/tasks/${task.id}/` ``
  - Line ~290: Change `` `Path: .fusion/tasks/${params.id}/attachments/${attachment.filename}` `` to `` `Path: .fusion/tasks/${params.id}/attachments/${attachment.filename}` ``

- [ ] In `packages/cli/src/bin.ts` line ~31:
  - Change `configDir: ".fusion"` to `configDir: ".fusion"`

**Artifacts:**
- `packages/cli/src/commands/task.ts` (modified)
- `packages/cli/src/commands/dashboard.ts` (modified)
- `packages/cli/src/extension.ts` (modified)
- `packages/cli/src/bin.ts` (modified)

### Step 5: Update Test Files

Update all test expectations that reference `.fusion` paths:

**Core package tests:**
- [ ] In `packages/core/src/store.test.ts`:
  - Update all `join(rootDir, ".fusion", ...)` to `join(rootDir, ".fusion", ...)` (lines 38, 171, 186, 200, 216, 250, 256, 285, 341, 449, 1397, 1415, 1437, 1461, 1483, 1501, 1514, 1542, 1570, 1588, 1598, 2182, 2676, 2814, 2871, 2922, 2945, 2964, 2979, 2994)

- [ ] In `packages/core/src/db.test.ts`:
  - Update all `join(tmpDir, ".fusion")` to `join(tmpDir, ".fusion")` (lines 19, 38, 595, 608, 620, 630)
  - Update test description at line 38: `"creates the .fusion directory if missing"` → `"creates the .fusion directory if missing"`

- [ ] In `packages/core/src/db-migrate.test.ts`:
  - Update all `join(tmpDir, ".fusion")` to `join(tmpDir, ".fusion")` (lines 19, 80, 124)

- [ ] In `packages/core/src/automation-store.test.ts`:
  - Update all `join(rootDir, ".fusion", "automations")` to `join(rootDir, ".fusion", "automations")` (lines 43, 50, 185, 367)

- [ ] In `packages/core/src/__tests__/store-sort.test.ts`:
  - Update `join(rootDir, ".fusion", "tasks")` to `join(rootDir, ".fusion", "tasks")` (line 35)

- [ ] In `packages/core/src/agent-store.test.ts`:
  - Update any `.fusion` references to `.fusion` (check file for occurrences)

**Engine package tests:**
- [ ] In `packages/engine/src/triage.test.ts`:
  - Update all `join(cwd, ".fusion", ...)` to `join(cwd, ".fusion", ...)` (lines 224, 256, 281, 305, 447)

**Verification:**
```bash
grep -rn '"\.fusion"' --include="*.test.ts" --include="*.test.tsx" packages/ | wc -l
```
Expected: 0 (all test references updated)

**Artifacts:**
- All test files listed above (modified)

### Step 6: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm install` to ensure dependencies are current
- [ ] Run `pnpm build` to verify all packages compile successfully
- [ ] Run `pnpm test` to verify all tests pass
- [ ] Fix any failing tests related to path expectations

**Verification checklist:**
- [ ] No hardcoded `".fusion"` strings remain in non-test source files (excluding JSDoc explaining legacy format)
- [ ] All test files updated with `.fusion` paths
- [ ] `pnpm build` passes for all packages
- [ ] `pnpm test` passes with zero failures

**Common issues to watch for:**
- Tests that assert on exact file paths
- Tests that check directory existence
- Mock filesystem paths in tests

**Artifacts:**
- All builds pass
- All tests pass

### Step 7: Documentation & Delivery

- [ ] Create changeset for this minor-level change (new feature - branding update):
```bash
cat > .changeset/rename-data-directory.md << 'EOF'
---
"@dustinbyrne/kb": minor
"@fusion/core": minor
"@fusion/dashboard": minor
"@fusion/engine": minor
---

Rename data directory from .fusion to .fusion
EOF
```
- [ ] Verify no `".fusion"` references remain in source code (excluding comments explaining legacy migration)
- [ ] Out-of-scope findings: If you discover any `.fusion` references in documentation (AGENTS.md, README.md), those are handled in KB-335 — do NOT modify them in this task

**Artifacts:**
- `.changeset/rename-data-directory.md` (new)

## Completion Criteria

- [ ] `TaskStore` hardcoded `.fusion` changed to `.fusion`
- [ ] `AgentStore` default rootDir changed from `.fusion` to `.fusion`
- [ ] `AutomationStore` paths updated to `.fusion`
- [ ] Engine triage attachment path updated to `.fusion`
- [ ] Dashboard file service and routes updated to `.fusion`
- [ ] All CLI output messages updated to show `.fusion/` instead of `.fusion/`
- [ ] All JSDoc comments updated to reference `.fusion/`
- [ ] All test files updated with `.fusion` path expectations
- [ ] `pnpm build` passes for all packages
- [ ] `pnpm test` passes with zero failures
- [ ] Changeset file created for the change

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step 1:** `feat(KB-336): rename data directory in core source files`
- **Step 2:** `feat(KB-336): update engine triage to use .fusion directory`
- **Step 3:** `feat(KB-336): update dashboard to use .fusion directory`
- **Step 4:** `feat(KB-336): update CLI output to reference .fusion directory`
- **Step 5:** `test(KB-336): update test expectations for .fusion paths`
- **Step 6:** `test(KB-336): verify build and tests pass`
- **Step 7:** `chore(KB-336): add changeset for data directory rename`

## Do NOT

- Rename existing `.fusion/` directories (this is forward-looking for new projects)
- Implement automatic migration from `.fusion` to `.fusion` (migration is handled separately if needed)
- Update AGENTS.md or README.md documentation (handled in KB-335)
- Skip running the full test suite
- Modify files in `.worktrees/` or `node_modules/` directories
- Commit lockfile or changeset without the task ID prefix
