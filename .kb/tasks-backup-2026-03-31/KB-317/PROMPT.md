# Task: KB-317 - Archive Duplicate Task

**Created:** 2026-03-31
**Size:** S

## Review Level: 0 (None)

**Assessment:** This is a process task to archive a duplicate. No code changes, no review needed.
**Score:** 0/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 0

## Mission

KB-317 was created as a duplicate of KB-312 ("Tasks are being marked done but not moving columns"). Both tasks describe the same underlying bug: when workflow steps fail after `task_done()` is called, tasks get `status: "failed"` but remain stuck in the "in-progress" column instead of moving to "in-review" where users can see and take action.

KB-312 already has an approved specification and is in the "todo" column. This task (KB-317) should be archived to avoid duplicate work. No code changes are required.

## Dependencies

- **Task:** KB-312 (the original task with the approved specification)

## Context to Read First

1. `.fusion/tasks/KB-312/PROMPT.md` — The approved specification for the actual fix
2. `packages/core/src/types.ts` — Valid column transitions (archived is only reachable from done)

## File Scope

No files to modify. This task is purely administrative — archive the duplicate.

## Steps

### Step 1: Move KB-317 to Done Column

- [ ] Move task from "triage" to "done": `await store.moveTask("KB-317", "done")`
- [ ] Log entry: "Marked as duplicate of KB-312, preparing to archive"

**Artifacts:**
- Task column: "done" (updated by store)

### Step 2: Archive KB-317 as Duplicate

- [ ] Archive this task: `await store.archiveTask("KB-317", false)` (cleanup=false keeps files for reference)
- [ ] Log entry: "Archived as duplicate of KB-312"

**Artifacts:**
- Task column: "archived" (updated by store)

### Step 3: Verify Archive

- [ ] Confirm KB-317 is archived: `const task = await store.getTask("KB-317");` verify `task.column === "archived"`
- [ ] Confirm KB-312 remains in "todo" column and will be executed

## Documentation Requirements

**Must Update:**
- None

**Check If Affected:**
- None

## Completion Criteria

- [ ] KB-317 moved to "done" column
- [ ] KB-317 archived (column = "archived")
- [ ] KB-312 remains active in "todo" column
- [ ] No code changes made

## Git Commit Convention

No commits required for this administrative task.

## Do NOT

- Modify any code files
- Create a changeset
- Execute KB-312's work (that will be done separately)
- Delete KB-317's task directory (archive handles this)
