# Task: KB-614 - Reduce verbose tool call logging in CLI

**Created:** 2026-03-31
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Low blast radius change removing verbose console.log statements. Only affects CLI output during AI merge operations. Reversible by restoring callbacks.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

Remove excessive tool call logging from the CLI merge operations. Currently, every tool invocation during AI-assisted merges is logged to the console via `onAgentTool` callbacks in both the dashboard command and task merge command. This creates noisy output that isn't necessary for normal operation.

## Dependencies

- **None**

## Context to Read First

- `packages/cli/src/commands/dashboard.ts` — See the `onAgentTool` callback in the `rawMerge` function (around line 177)
- `packages/cli/src/commands/task.ts` — See the `onAgentTool` callback in `runTaskMerge` function (around line 350)
- `packages/engine/src/merger.ts` — Review `MergerOptions` interface to confirm `onAgentTool` is optional

## File Scope

- `packages/cli/src/commands/dashboard.ts` (modify — remove tool call logging)
- `packages/cli/src/commands/task.ts` (modify — remove tool call logging)

## Steps

### Step 1: Remove tool call logging from dashboard.ts

- [ ] Locate the `rawMerge` function and its `onAgentTool` callback
- [ ] Remove the `onAgentTool` callback entirely (it's optional in `MergerOptions`)
- [ ] The line to remove: `onAgentTool: (name) => console.log(`[merger] tool: ${name}`),`
- [ ] Run tests for dashboard command: `pnpm test -- packages/cli/src/commands/dashboard.test.ts`

**Artifacts:**
- `packages/cli/src/commands/dashboard.ts` (modified)

### Step 2: Remove tool call logging from task.ts

- [ ] Locate the `runTaskMerge` function and its `onAgentTool` callback
- [ ] Remove the `onAgentTool` callback entirely
- [ ] The line to remove: `onAgentTool: (name) => console.log(`  [merge] tool: ${name}`),`
- [ ] Run tests for task command: `pnpm test -- packages/cli/src/commands/task.test.ts`

**Artifacts:**
- `packages/cli/src/commands/task.ts` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Verify no test failures related to removed logging
- [ ] Verify build passes: `pnpm build`

### Step 4: Documentation & Delivery

- [ ] No documentation updates needed (this is removing noise, not changing behavior)
- [ ] Create changeset for the CLI package:
  ```bash
  cat > .changeset/reduce-cli-tool-logging.md << 'EOF'
  ---
  "@dustinbyrne/kb": patch
  ---

  Reduce verbose tool call logging during AI merge operations
  EOF
  ```
- [ ] Include changeset in final commit

## Documentation Requirements

**Must Update:** None — this change reduces logging noise without affecting documented behavior.

**Check If Affected:** None.

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Changeset created
- [ ] Build passes

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-614): complete Step N — description`
- **Bug fixes:** `fix(KB-614): description`
- **Tests:** `test(KB-614): description`

## Do NOT

- Add new configuration options for this logging (not worth the complexity)
- Replace with "verbose mode" checks (out of scope, keep it simple)
- Modify files outside the File Scope
- Change behavior of `onAgentText` callbacks (text output should remain)
- Modify engine package code (the callbacks are already optional there)
