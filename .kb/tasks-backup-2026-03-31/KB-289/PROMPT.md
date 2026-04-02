# Task: KB-289 - Disable AI Title Generation for Tasks

**Created:** 2026-03-31
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a focused change to remove AI title generation while keeping titles optional for manual entry. UI/CLI already handle missing titles gracefully.
**Score:** 3/8 — Blast radius: 1 (localized to task creation), Pattern novelty: 0 (removing existing code), Security: 1 (no new attack surface), Reversibility: 2 (can re-enable by reverting changes)

## Mission

Remove the AI-powered title generation feature from kb. When users create tasks without providing a title, the system should simply leave the title field empty rather than calling an AI agent to generate one from the description. The UI and CLI already gracefully handle missing titles by falling back to the description.

This simplifies the codebase, removes an unnecessary AI call during task creation, and aligns with the principle that tasks don't need titles - the description is sufficient.

## Dependencies

- **None**

## Context to Read First

- `/Users/eclipxe/Projects/kb/packages/core/src/store.ts` - Contains `generateTitleFromDescription` function (line ~2289) and its usage in `createTask` (line ~386)
- `/Users/eclipxe/Projects/kb/packages/core/src/store.test.ts` - Tests for task creation including title generation
- `/Users/eclipxe/Projects/kb/packages/core/src/types.ts` - `Task` and `TaskCreateInput` types showing `title` is already optional

## File Scope

- `packages/core/src/store.ts` - Remove `generateTitleFromDescription` function and its call in `createTask`
- `packages/core/src/store.test.ts` - Update tests that verify AI title generation behavior

## Steps

### Step 1: Remove AI Title Generation from Store

- [ ] Remove the `generateTitleFromDescription` function call from `createTask` (store.ts line ~386)
- [ ] Change `createTask` to simply not set a title when none is provided (remove the AI generation fallback)
- [ ] Remove the entire `generateTitleFromDescription` function and its helper code (lines ~2289-2400)
- [ ] Remove the `TITLE_GENERATION_PROMPT` constant
- [ ] Remove the `initEngine()` call and `engineReady` promise related to title generation
- [ ] Keep the `createKbAgent` dynamic import code if used elsewhere, otherwise remove it
- [ ] Run targeted tests for the store module

**Artifacts:**
- `packages/core/src/store.ts` (modified) - AI title generation removed

### Step 2: Update Tests

- [ ] Read existing tests in `packages/core/src/store.test.ts` related to title generation
- [ ] Remove or modify tests that expect AI-generated titles
- [ ] Add/update tests to verify that tasks created without titles have `title: undefined`
- [ ] Ensure tests verify the task description is preserved correctly
- [ ] Run core package tests to verify all pass

**Artifacts:**
- `packages/core/src/store.test.ts` (modified) - Tests updated for new behavior

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`
- [ ] Manually verify: create a task via CLI (`kb task create "test description"`) and confirm no title is generated
- [ ] Verify dashboard shows description as the task label when no title exists

### Step 4: Documentation & Delivery

- [ ] Create changeset file for the change (patch level - user-facing behavioral change)
- [ ] Verify no dashboard UI changes needed (it already handles missing titles)
- [ ] Verify no CLI changes needed (it already handles missing titles)

**Changeset:**
```bash
cat > .changeset/disable-ai-title-generation.md << 'EOF'
---
"@dustinbyrne/kb": patch
---

Disable AI title generation for tasks. Tasks no longer automatically generate titles from descriptions via AI. The title field remains optional for manual entry, and the UI/CLI continue to display the description when no title is present.
EOF
```

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Changeset created
- [ ] Manual verification confirms tasks created without titles have no title field set

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-289): complete Step N — description`
- **Bug fixes:** `fix(KB-289): description`
- **Tests:** `test(KB-289): description`

## Do NOT

- Modify the Task or TaskCreateInput types (title is already optional)
- Change UI code (it already handles missing titles gracefully)
- Change CLI code (it already handles missing titles gracefully)
- Modify the planning mode title generation (that uses a different code path)
- Add a new setting to toggle this behavior (the user wants it permanently disabled)
- Expand scope to remove titles entirely (keep them optional for manual use)
