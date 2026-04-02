# Task: KB-653 - Truncate board titles to 140 characters

**Created:** 2026-04-01
**Size:** S

## Review Level: 0 (None)

**Assessment:** Simple UI change with localized blast radius. Standard truncation pattern already exists elsewhere in the codebase.
**Score:** 1/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 1

## Mission

Truncate task titles displayed on the board (TaskCard component) to a maximum of 140 characters. When a title exceeds this limit, display an ellipsis (…) and show the full title in a tooltip on hover. This prevents overly long titles from breaking the board layout while preserving full accessibility.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/TaskCard.tsx` — The component where titles are rendered
- `packages/dashboard/app/components/__tests__/TaskCard.test.tsx` — Existing tests to understand testing patterns
- `packages/dashboard/app/components/TaskDetailModal.tsx` — Contains an existing `truncate()` utility function for reference

## File Scope

- `packages/dashboard/app/components/TaskCard.tsx` — Add truncation logic to title display
- `packages/dashboard/app/components/__tests__/TaskCard.test.tsx` — Add tests for title truncation

## Steps

### Step 1: Implement Title Truncation

- [ ] Create or import a `truncate` utility function (max 140 chars, add "…" suffix when truncated)
- [ ] Modify the `.card-title` div in TaskCard.tsx to truncate the displayed text
- [ ] Add a `title` attribute to the `.card-title` div so the full text appears as a tooltip on hover
- [ ] Truncate both `task.title` and `task.description` fallbacks to 140 characters

**Artifacts:**
- `packages/dashboard/app/components/TaskCard.tsx` (modified)

### Step 2: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run existing TaskCard tests to ensure no regressions: `pnpm test packages/dashboard/app/components/__tests__/TaskCard.test.tsx`
- [ ] Add new test cases for title truncation:
  - Title under 140 characters displays unchanged
  - Title exactly 140 characters displays unchanged
  - Title over 140 characters is truncated with ellipsis
  - Description fallback (when no title) is also truncated
  - Tooltip contains the full untruncated text
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

### Step 3: Documentation & Delivery

- [ ] Update relevant documentation (none needed for this change)
- [ ] Create a changeset file for this fix

## Documentation Requirements

**Check If Affected:**
- `AGENTS.md` — No changes needed (simple UI fix)

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Board titles truncate at 140 characters with ellipsis
- [ ] Full title visible on hover via tooltip
- [ ] Changeset file included in commit

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-653): complete Step N — description`
- **Bug fixes:** `fix(KB-653): description`
- **Tests:** `test(KB-653): description`

## Do NOT

- Expand task scope (don't change title limits elsewhere)
- Skip tests
- Modify files outside the File Scope
- Commit without the task ID prefix
