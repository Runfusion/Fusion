# Task: KB-338 - Fix Flaky Test: Race Condition in ID Allocation During Parallel createTask Calls

**Created:** 2026-03-31
**Size:** S

## Review Level: 2 (Plan and Code)

**Assessment:** This is a focused bug fix in the TaskStore ID allocation logic. The fix requires understanding the existing locking mechanism (`configLock` / `withConfigLock`) and applying it correctly to prevent the race condition. Low blast radius, well-established patterns in the codebase.
**Score:** 4/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 1

## Mission

Fix the pre-existing flaky test "produces valid config.json with unique sequential IDs after 5 parallel createTask calls" in `store.test.ts`. The test expects `nextId` to be 6 after creating 5 tasks in parallel, but sometimes returns 5 due to a race condition in the `allocateId()` method.

The root cause: `allocateId()` uses a SQLite transaction to atomically read and increment `nextId` in the database, but then synchronizes to `config.json` asynchronously **outside** of the `configLock`. When multiple tasks are created in parallel, they can all read the same `nextId` value from the DB before any writes to `config.json`, causing the final `config.json` to have a stale (lower) value than expected.

The fix: Wrap the entire `allocateId()` operation (or at minimum the config.json sync) in the `withConfigLock()` to serialize concurrent ID allocations.

## Dependencies

- **None**

## Context to Read First

1. `packages/core/src/store.ts` — Focus on:
   - `allocateId()` method (around line 536) — the method with the race condition
   - `withConfigLock()` method (around line 319-333) — existing locking pattern to use
   - `createTask()` method (around line 565) — caller of `allocateId()`

2. `packages/core/src/store.test.ts` — The flaky test:
   - "produces valid config.json with unique sequential IDs after 5 parallel createTask calls" (around line 235-259)

3. `packages/core/src/db.ts` — Understanding of `db.transaction()` behavior (SQLite transactions are synchronous)

## File Scope

- `packages/core/src/store.ts` — Modify `allocateId()` to use `withConfigLock()`
- `packages/core/src/store.test.ts` — Verify the fix (test already exists, ensure it passes consistently)

## Steps

### Step 1: Analyze and Fix the Race Condition

- [ ] Read `allocateId()` method to understand current implementation
- [ ] Read `withConfigLock()` method to understand the locking pattern
- [ ] Apply `withConfigLock()` to `allocateId()` to serialize the entire operation
- [ ] Ensure the fix handles the mixed sync/async nature correctly:
  - The SQLite transaction (`db.transaction()`) is synchronous
  - The `config.json` sync is async
  - The lock must wrap both to prevent the race

**Key implementation detail:** The `db.transaction()` call is synchronous and returns the task ID immediately. However, the subsequent `readConfig()` and `writeFile()` calls for `config.json` sync are async. The race occurs because multiple async operations can interleave between the DB transaction and the config write.

The fix should structure `allocateId()` like:
```typescript
private async allocateId(): Promise<string> {
  return this.withConfigLock(async () => {
    const id = this.db.transaction(() => {
      // ... existing transaction logic ...
    });
    
    // Sync config.json to disk for backward compatibility
    try {
      const config = await this.readConfig();
      await writeFile(this.configPath, JSON.stringify(config, null, 2));
    } catch {
      // Non-fatal
    }
    
    return id;
  });
}
```

**Artifacts:**
- `packages/core/src/store.ts` (modified)

### Step 2: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run the specific flaky test multiple times to verify it passes consistently:
  ```bash
  cd packages/core && pnpm test -- --run --reporter=verbose store.test.ts -t "produces valid config.json with unique sequential IDs"
  ```
- [ ] Run the specific test at least 10 times to ensure flakiness is resolved:
  ```bash
  for i in {1..10}; do pnpm test -- --run store.test.ts -t "produces valid config.json with unique sequential IDs" || echo "FAILED RUN $i"; done
  ```
- [ ] Run the full test suite for the `@kb/core` package:
  ```bash
  pnpm --filter @kb/core test
  ```
- [ ] Fix any failures introduced by the change

### Step 3: Documentation & Delivery

- [ ] No documentation updates needed (bug fix, no API change)
- [ ] Create changeset file for the fix (patch level):
  ```bash
  cat > .changeset/fix-id-allocation-race-condition.md << 'EOF'
  ---
  "@dustinbyrne/kb": patch
  ---

  Fix race condition in parallel task creation that could result in incorrect nextId in config.json.
  EOF
  ```
- [ ] If any new issues discovered during testing, create follow-up tasks via `task_create`

## Documentation Requirements

**Must Update:**
- None (bug fix)

**Check If Affected:**
- `AGENTS.md` — Check if TaskStore ID allocation is documented; update if race condition behavior is mentioned

## Completion Criteria

- [ ] All steps complete
- [ ] Flaky test passes consistently (10 consecutive successful runs)
- [ ] All tests passing
- [ ] Changeset file created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-338): complete Step N — description`
- **Bug fixes:** `fix(KB-338): description`
- **Tests:** `test(KB-338): description`

Example commits:
- `fix(KB-338): wrap allocateId in configLock to prevent race condition`
- `test(KB-338): verify flaky test passes consistently`
- `chore(KB-338): add changeset for race condition fix`

## Do NOT

- Expand task scope beyond fixing the race condition
- Skip running the test multiple times to verify flakiness is resolved
- Modify other tests unless they are genuinely broken by the fix
- Change the test expectation (the test is correct, the code was wrong)
- Add new dependencies or complex refactoring
- Ignore test failures — even if unrelated, investigate first
