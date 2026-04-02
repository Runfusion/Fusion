# Task: KB-602 - Audit and fix file-based operations for database-backed task system

**Created:** 2026-03-31
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** Medium complexity task involving audit of file operations, defensive fixes across multiple methods, and comprehensive test coverage. Changes are localized to store.ts but affect multiple operations.
**Score:** 5/8 — Blast radius: 2, Pattern novelty: 1, Security: 1, Reversibility: 1

## Mission

Audit all file-based operations in the TaskStore to ensure they work correctly with the SQLite-backed storage system. After the database migration, task metadata lives in SQLite but blob files (PROMPT.md, agent.log, attachments) remain on disk. Some operations assume task directories always exist, which fails when directories are missing (e.g., after manual deletion, archive cleanup, or migration edge cases). 

This task systematically identifies all file-writing operations that need defensive directory creation and all file-reading operations that need graceful handling of missing files. The goal is to make the file operations resilient to missing directories while keeping SQLite as the primary source of truth for task metadata.

## Dependencies

- **None** (related to KB-601 which fixes a specific instance, but this is a broader audit)

## Context to Read First

- `packages/core/src/store.ts` — Read `atomicWriteTaskJson` (line ~392), `appendAgentLog` (line ~1853), `addAttachment` (line ~1757), and methods that read PROMPT.md (lines ~745, ~1061, ~1086, ~1119)
- `packages/core/src/store.ts` — Review `readTaskJson` (line ~365) to understand SQLite-first read pattern
- `packages/core/src/store.test.ts` — Review existing test patterns for file operations
- `.fusion/fusion.db` — SQLite database is primary store (WAL mode, `tasks` table holds metadata)
- `AGENTS.md` — SQLite Storage Architecture section explains hybrid model

## File Scope

- `packages/core/src/store.ts` — Defensive fixes for file operations
- `packages/core/src/store.test.ts` — Tests for missing directory scenarios

## Steps

### Step 1: Audit All File-Based Operations

- [ ] Identify all file WRITE operations that may fail if directory doesn't exist:
  - `atomicWriteTaskJson` - writes task.json backup (line ~398-401)
  - `appendAgentLog` - writes to agent.log (line ~1865-1866)
  - `addAttachment` - writes to attachments/ directory (line ~1759)
  - `writeFile(join(dir, "PROMPT.md"), ...)` - in `specifyTask` (line ~608), `rewriteTask` (line ~651), `respecifyTask` (line ~709), `updateTask` (line ~924)
  - `restoreFromArchive` - writes PROMPT.md (line ~2318)

- [ ] Identify all file READ operations that need graceful handling:
  - `readPrompt` - reads PROMPT.md (line ~744-746)
  - `parseStepsFromPrompt` - reads PROMPT.md (line ~1061)
  - `parseDependenciesFromPrompt` - reads PROMPT.md (line ~1086)
  - `parseFileScopeFromPrompt` - reads PROMPT.md (line ~1119)
  - `getAgentLogs` - reads agent.log (line ~2168)
  - `getAttachment` - returns attachment path (line ~1791)

- [ ] Document findings in a comment at the top of the class or in the method documentation

**Artifacts:**
- `packages/core/src/store.ts` (documentation/comments only)

### Step 2: Add Defensive Directory Creation to Write Operations

- [ ] Fix `atomicWriteTaskJson` - add `mkdir(dir, { recursive: true })` before writing task.json.tmp
- [ ] Fix `appendAgentLog` - add `mkdir(dir, { recursive: true })` before appending to agent.log
- [ ] Fix `addAttachment` - already has mkdir (verify it runs before any file write)
- [ ] Verify all PROMPT.md writes go through paths that ensure directory exists:
  - `createTask` - already creates directory (line ~597)
  - `specifyTask` - check directory exists before write
  - `rewriteTask` - check directory exists before write
  - `respecifyTask` - check directory exists before write
  - `updateTask` - check directory exists before write (when prompt is updated)
  - `restoreFromArchive` - already creates directory (line ~2284)

**Artifacts:**
- `packages/core/src/store.ts` (modified with defensive mkdir calls)

### Step 3: Ensure Graceful Handling of Missing Files in Read Operations

- [ ] Verify `readPrompt` returns `undefined` gracefully when PROMPT.md missing (already uses `existsSync`)
- [ ] Verify `parseStepsFromPrompt` returns `[]` when PROMPT.md missing (already uses `existsSync`)
- [ ] Verify `parseDependenciesFromPrompt` returns `[]` when PROMPT.md missing (already uses `existsSync`)
- [ ] Verify `parseFileScopeFromPrompt` returns `[]` when PROMPT.md missing (already uses `existsSync`)
- [ ] Verify `getAgentLogs` returns `[]` when agent.log missing (already uses `existsSync`)
- [ ] Verify `getAttachment` throws ENOENT error when attachment missing (already correct)
- [ ] Verify `readTaskJson` falls back to file only after SQLite lookup (already correct)

**Artifacts:**
- `packages/core/src/store.ts` (any needed fixes for graceful handling)

### Step 4: Add Comprehensive Tests for Missing Directory Scenarios

- [ ] Add test for `pauseTask` with missing directory (KB-601 scenario)
- [ ] Add test for `updateStep` with missing directory
- [ ] Add test for `addSteeringComment` with missing directory
- [ ] Add test for `appendAgentLog` with missing directory
- [ ] Add test for `addAttachment` with missing directory
- [ ] Add test for `updateTask` with prompt update and missing directory
- [ ] Add test for `specifyTask` with missing directory (edge case: directory deleted mid-operation)

Each test should:
1. Create a task (which creates directory)
2. Manually delete the task directory
3. Call the operation
4. Verify operation succeeds and directory is recreated
5. Verify data integrity (SQLite is source of truth)

**Artifacts:**
- `packages/core/src/store.test.ts` (new test cases)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Run build: `pnpm build`
- [ ] Verify no regression in existing functionality

### Step 6: Documentation & Delivery

- [ ] Create changeset file for the patch fix
- [ ] Update any relevant documentation about the hybrid storage model
- [ ] Document out-of-scope findings as new tasks if needed

**Changeset:**
```bash
cat > .changeset/fix-file-operations-database-storage.md << 'EOF'
---
"@dustinbyrne/kb": patch
---

Fix file-based operations to work correctly with database-backed storage. Task directories are now created on-demand when file operations need them, preventing ENOENT errors when directories are missing.
EOF
```

## Documentation Requirements

**Must Update:**
- None — internal resilience improvement

**Check If Affected:**
- `AGENTS.md` — SQLite Storage Architecture section if examples need updating

## Completion Criteria

- [ ] All file WRITE operations create directories defensively
- [ ] All file READ operations handle missing files gracefully
- [ ] All tests passing
- [ ] Build passes
- [ ] Changeset created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-602): complete Step N — description`
- **Bug fixes:** `fix(KB-602): description`
- **Tests:** `test(KB-602): description`

## Do NOT

- Change the primary storage model (SQLite remains primary)
- Remove file-based backup of task.json (needed for backward compatibility)
- Modify the watcher logic (file system watching is separate concern)
- Skip any file operation without testing it
- Expand scope to non-file operations

## Implementation Notes

### Pattern for Defensive Directory Creation

Use this pattern when fixing write operations:

```typescript
// Before writing to any file in the task directory
await mkdir(dir, { recursive: true });
// Then proceed with file write
await writeFile(filePath, content);
```

### SQLite-First Read Pattern (Already Implemented)

The `readTaskJson` method already follows the correct pattern:
1. Try SQLite first (`readTaskFromDb`)
2. Fall back to file only if not in DB
3. This ensures the database is the source of truth

### Operations That Need Defensive mkdir

1. `atomicWriteTaskJson` - called by most update operations
2. `appendAgentLog` - called frequently during execution
3. `specifyTask` / `rewriteTask` / `respecifyTask` / `updateTask` when writing PROMPT.md

### Operations Already Safe

1. `createTask` - creates directory explicitly
2. `addAttachment` - already has mkdir
3. `restoreFromArchive` - creates directory explicitly
4. `duplicateTask` - creates new directory
