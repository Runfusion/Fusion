# Task: FN-678 - Refinement: KB-653

**Created:** 2026-04-01
**Size:** S

## Review Level: 0 (None)

**Assessment:** Simple UI fix to add the missing title truncation that was supposed to be implemented in KB-653. Localized change with clear acceptance criteria.
**Score:** 1/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 1

## Mission

KB-653 specified that task titles on the board (TaskCard component) should be truncated to 140 characters with an ellipsis and show the full title in a tooltip on hover. However, the current TaskCard.tsx implementation displays titles raw without any truncation:

```jsx
<div className="card-title">
  {task.title || task.description || task.id}
</div>
```

This refinement implements the missing truncation logic and tooltip functionality to prevent overly long titles from breaking the board layout while preserving full accessibility.

## Dependencies

- **Task:** KB-653 (original truncation specification — must be complete)

## Context to Read First

- `packages/dashboard/app/components/TaskCard.tsx` — The component where titles are rendered (see line ~496, the `.card-title` div)
- `packages/dashboard/app/components/__tests__/TaskCard.test.tsx` — Existing tests (see the "TaskCard title display" test section around line 2123)
- `packages/dashboard/app/components/TaskDetailModal.tsx` — Contains an existing `truncate()` utility function at line 101 for reference

## File Scope

- `packages/dashboard/app/components/TaskCard.tsx` — Add truncation logic and tooltip to title display
- `packages/dashboard/app/components/__tests__/TaskCard.test.tsx` — Update tests to verify truncation behavior

## Steps

### Step 1: Implement Title Truncation and Tooltip

- [ ] Add a `truncate` utility function directly in TaskCard.tsx (or import from TaskDetailModal if properly exported). The function should: take a string and max length, return the string unchanged if under limit, or truncated with "…" suffix if over limit
- [ ] Modify the `.card-title` div in TaskCard.tsx to:
  - Truncate `task.title` to 140 characters (if present)
  - Truncate `task.description` to 140 characters (when used as fallback)
  - Add a `title` attribute containing the full untruncated text for tooltip display
- [ ] Ensure the truncation logic handles edge cases: empty strings, undefined values, exact 140-char strings

**Artifacts:**
- `packages/dashboard/app/components/TaskCard.tsx` (modified)

### Step 2: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Update the existing "TaskCard title display" test section in TaskCard.test.tsx:
  - Add test: "truncates titles longer than 140 characters with ellipsis"
  - Add test: "shows full title in tooltip via title attribute"
  - Add test: "does not truncate titles exactly 140 characters"
  - Add test: "truncates description fallback when no title present"
  - Update existing "no truncation" test to reflect new behavior (or remove if conflicting)
- [ ] Run TaskCard-specific tests: `pnpm test packages/dashboard/app/components/__tests__/TaskCard.test.tsx`
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

**Artifacts:**
- `packages/dashboard/app/components/__tests__/TaskCard.test.tsx` (modified)

### Step 3: Documentation & Delivery

- [ ] Create a changeset file for this fix (patch-level change to @gsxdsm/fusion)
- [ ] Verify the fix visually by checking that:
  - Long titles (>140 chars) display with "…" at the end
  - Hovering shows the full title in browser tooltip
  - Short titles (<140 chars) display unchanged
  - The board layout is not broken by long titles

**Artifacts:**
- `.changeset/truncate-board-titles.md` (new)

## Documentation Requirements

**Must Update:**
- None (this is a bug fix for previously specified behavior)

**Check If Affected:**
- `AGENTS.md` — No changes needed (simple UI fix)

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Board titles truncate at 140 characters with ellipsis
- [ ] Full title visible on hover via tooltip (title attribute)
- [ ] Changeset file included in commit

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(FN-678): complete Step N — description`
- **Bug fixes:** `fix(FN-678): description`
- **Tests:** `test(FN-678): description`

## Do NOT

- Expand task scope beyond board title truncation
- Skip tests
- Modify files outside the File Scope
- Change truncation length from 140 characters (match KB-653 spec)
- Commit without the task ID prefix
