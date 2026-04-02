# Task: KB-127 - Add Quick Entry Box to List View

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a straightforward UI enhancement that mirrors existing functionality from the board view to the list view. The QuickEntryBox component already exists and is well-tested; we just need to integrate it into ListView and wire up the props.
**Score:** 3/8 — Blast radius: 1, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

Add a quick task entry box to the list view toolbar, matching the functionality already available on the board view's triage column. This allows users to rapidly create tasks by typing and pressing Enter, without opening the full New Task modal.

## Dependencies

- **None** — This is a self-contained UI enhancement

## Context to Read First

1. `packages/dashboard/app/components/QuickEntryBox.tsx` — The existing quick entry component to reuse
2. `packages/dashboard/app/components/ListView.tsx` — Where to add the quick entry box
3. `packages/dashboard/app/App.tsx` — Where to wire up the `onQuickCreate` prop
4. `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx` — Existing test patterns
5. `packages/dashboard/app/components/__tests__/ListView.test.tsx` — ListView test patterns to extend

## File Scope

- `packages/dashboard/app/components/ListView.tsx` (modified)
- `packages/dashboard/app/App.tsx` (modified)
- `packages/dashboard/app/components/__tests__/ListView.test.tsx` (modified)

## Steps

### Step 1: Add QuickEntryBox to ListView Component

- [ ] Add `onQuickCreate?: (description: string) => Promise<void>` prop to `ListViewProps` interface
- [ ] Import `QuickEntryBox` component at the top of the file
- [ ] Add the `QuickEntryBox` component to the toolbar area (next to the filter input, before the Columns button)
- [ ] Style it to fit the toolbar layout — use a compact inline style that matches the board's triage column quick entry
- [ ] Pass `onQuickCreate` and `addToast` props to `QuickEntryBox`
- [ ] Run targeted tests for ListView to verify no regressions

**Artifacts:**
- `packages/dashboard/app/components/ListView.tsx` (modified)

### Step 2: Wire Up Quick Create in App.tsx

- [ ] Pass `onQuickCreate={handleQuickCreate}` prop to the `ListView` component in the conditional render (where `view === "list"`)
- [ ] Verify the ListView now receives the same `handleQuickCreate` callback that Board receives
- [ ] Run dashboard tests to verify integration works

**Artifacts:**
- `packages/dashboard/app/App.tsx` (modified)

### Step 3: Add Tests for Quick Entry in ListView

- [ ] Add tests to `ListView.test.tsx` for:
  - QuickEntryBox renders when `onQuickCreate` is provided
  - QuickEntryBox does NOT render when `onQuickCreate` is not provided
  - Enter key in quick entry calls `onQuickCreate` with the description
  - Error handling shows toast when `onQuickCreate` fails
- [ ] Follow existing test patterns from `QuickEntryBox.test.tsx`
- [ ] Run ListView tests to verify they pass

**Artifacts:**
- `packages/dashboard/app/components/__tests__/ListView.test.tsx` (modified)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Build passes: `pnpm build`
- [ ] Manual verification: Switch to list view, type in quick entry box, press Enter — task should be created in triage

### Step 5: Documentation & Delivery

- [ ] No documentation updates needed — this is a UX parity feature matching existing board behavior
- [ ] No changeset needed — this is a minor UX improvement to internal dashboard (not published package)

## Completion Criteria

- [ ] Quick entry box appears in list view toolbar
- [ ] Typing and pressing Enter creates a task in triage column
- [ ] Input clears after successful creation
- [ ] Error toast shown on failure (input preserved for retry)
- [ ] All tests passing
- [ ] Build passes

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-127): complete Step N — description`
- **Bug fixes:** `fix(KB-127): description`
- **Tests:** `test(KB-127): description`

## Do NOT

- Expand scope to modify QuickEntryBox component itself (it's already well-designed)
- Add new dependencies or styling systems
- Change the quick entry behavior from what exists on the board view
- Skip tests or rely on typechecking as a substitute for real tests
