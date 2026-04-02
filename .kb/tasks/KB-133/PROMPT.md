# Task: KB-133 - Mobile header overflow menu and collapsible search

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This is a localized dashboard UI change, but it adds new responsive interaction state, accessibility behavior, and test coverage across a shared header component. The blast radius stays mostly inside the dashboard header, yet the implementation must preserve existing desktop behavior and app-level callbacks.
**Score:** 4/8 — Blast radius: 1, Pattern novelty: 2, Security: 0, Reversibility: 1

## Mission

Improve the dashboard header on small screens so it remains usable in mobile view without wrapping or dropping controls off-screen. On mobile only, the board search should collapse to an icon that expands into the existing text search when tapped, and lower-priority header actions should move into an accessible overflow menu, while desktop layout, existing callbacks, board/list switching, and search semantics continue to work exactly as they do today.

## Dependencies

- **Task:** KB-134 (before KB-133 starts, the base branch or working tree must already have the unrelated dashboard verification regressions fixed so root `pnpm test` and `pnpm build` can pass cleanly again. Based on the current failure set, that dependency must cover the known non-KB-133 failures in `packages/dashboard/app/components/Header.test.tsx`, `packages/dashboard/app/hooks/useTerminal.test.ts`, `packages/dashboard/src/terminal-service.test.ts`, and `packages/dashboard/src/__tests__/typecheck.test.ts`; KB-134 does not have a fully specified PROMPT.md yet, so verify these concrete outcomes directly before implementation begins)

## Context to Read First

- `AGENTS.md` — root test/build commands and changeset policy for private vs published packages
- `packages/dashboard/app/components/Header.tsx` — current header structure, icon order, search rendering, and callback surface
- `packages/dashboard/app/styles.css` — current header styling, `@media (max-width: 768px)` mobile overrides, and the older `640px/480px` search-wrap rules that currently allow the header to break on mobile
- `packages/dashboard/app/components/__tests__/Header.test.tsx` — primary Header behavior coverage to extend for mobile interactions
- `packages/dashboard/app/components/Header.test.tsx` — legacy Header regression file; KB-134 is expected to normalize its branding expectations before KB-133 starts, so read it to avoid breaking it but do not treat branding-only cleanup as part of KB-133
- `packages/dashboard/app/components/__tests__/App.test.tsx` — app-level expectations for header actions and view switching, plus the current stray `onOpenUsage` prop passed into `<Header>`; for KB-133, treat `HeaderProps` in `Header.tsx` as the authoritative callback surface unless KB-134 intentionally changes that contract first
- `packages/dashboard/app/components/CustomModelDropdown.tsx` — reference pattern for click-outside dismissal and keyboard-close behavior on floating UI
- `packages/dashboard/app/hooks/useTheme.ts` — reference pattern for subscribing to `window.matchMedia(...)` changes without leaking listeners
- `packages/dashboard/app/__tests__/mobile-scroll-snap.test.ts` — example stylesheet-level regression test that reads `styles.css` directly
- `packages/dashboard/README.md` — dashboard feature documentation to update after the mobile header behavior changes

## File Scope

- `packages/dashboard/app/components/Header.tsx`
- `packages/dashboard/app/styles.css`
- `packages/dashboard/app/components/__tests__/Header.test.tsx`
- `packages/dashboard/app/__tests__/mobile-header-controls.test.ts`
- `packages/dashboard/README.md`

## Steps

### Step 0: Preflight

- [ ] Required files and paths exist
- [ ] Dependencies satisfied

### Step 1: Add mobile-only header interaction states

- [ ] Update `packages/dashboard/app/components/Header.tsx` so the component renders a single control set per viewport using a `window.matchMedia("(max-width: 768px)")` listener; do not leave duplicate desktop/mobile buttons simultaneously discoverable in the DOM, and keep the board/list view toggle inline on mobile rather than moving it into overflow
- [ ] On mobile board view, replace the always-expanded `.header-search` with an icon trigger that opens a focused text-entry state for the existing `searchQuery` / `onSearchChange` flow; the trigger must be keyboard-focusable and expose expanded/collapsed state with ARIA, and if `searchQuery` is already non-empty the mobile search stays visibly expanded until cleared or explicitly closed so an active filter is never hidden
- [ ] Add an accessible mobile overflow menu in `Header.tsx` for actions that no longer fit inline on small screens; the overflow trigger should have a stable accessible name such as `More header actions`, menu items should use the existing action titles as visible labels, the menu must expose only the callbacks defined in the current `HeaderProps` contract (`onOpenGitHubImport`, `onOpenPlanning`, `onToggleTerminal`, `onToggleEnginePause`, `onToggleGlobalPause`, `onOpenSettings`), and it must close on outside click, `Escape`, and after selecting an action
- [ ] Extend component tests in `packages/dashboard/app/components/__tests__/Header.test.tsx` to cover the new mobile viewport behavior, including mocked `matchMedia`, a keyboard-focusable mobile search trigger with a stable accessible name such as `Open search`, expanded/collapsed ARIA state, mobile search open/close behavior, overflow menu toggle/dismissal, and callback dispatch from menu items; keep `packages/dashboard/app/components/Header.test.tsx` passing as a regression check, but do not use KB-133 for the branding-only cleanup owned by KB-134
- [ ] Run targeted tests for changed files with `pnpm --filter @kb/dashboard exec vitest run app/components/__tests__/Header.test.tsx app/components/Header.test.tsx`

**Artifacts:**
- `packages/dashboard/app/components/Header.tsx` (modified)
- `packages/dashboard/app/components/__tests__/Header.test.tsx` (modified)

### Step 2: Lock the responsive layout in CSS

- [ ] Refactor the header-related rules in `packages/dashboard/app/styles.css` so mobile behavior is driven from the existing `@media (max-width: 768px)` breakpoint: keep the desktop inline header/search layout intact, remove the current mobile wrap-based fallback for header search, and add explicit styles for the mobile search trigger/panel and overflow menu/popover
- [ ] Preserve current desktop semantics: desktop still shows the inline board search and visible header icon row, while mobile keeps the header on a single row without action icons spilling off-screen or wrapping under the brand
- [ ] Add a stylesheet regression test at `packages/dashboard/app/__tests__/mobile-header-controls.test.ts` that reads `styles.css` directly and asserts the mobile media block contains the new header mobile selectors/rules needed for the collapsed search and overflow menu
- [ ] Run targeted tests for changed files with `pnpm --filter @kb/dashboard exec vitest run app/__tests__/mobile-header-controls.test.ts app/components/__tests__/Header.test.tsx app/components/Header.test.tsx`

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)
- `packages/dashboard/app/__tests__/mobile-header-controls.test.ts` (new)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Before final verification, confirm the working tree or rebased base branch already includes KB-134’s concrete outcomes: the unrelated failures in `packages/dashboard/app/components/Header.test.tsx`, `packages/dashboard/app/hooks/useTerminal.test.ts`, `packages/dashboard/src/terminal-service.test.ts`, and `packages/dashboard/src/__tests__/typecheck.test.ts` are no longer present
- [ ] Run full test suite with `pnpm test`
- [ ] Fix all failures
- [ ] Build passes with `pnpm build`

### Step 4: Documentation & Delivery

- [ ] Update `packages/dashboard/README.md` to note that the dashboard header now uses a mobile overflow menu and icon-triggered board search on small screens
- [ ] Confirm no changeset is needed because this task only changes the private `@kb/dashboard` package
- [ ] Out-of-scope findings created as new tasks via `task_create` tool

## Documentation Requirements

**Must Update:**
- `packages/dashboard/README.md` — document the mobile header behavior so future header/UI work does not regress the overflow menu or collapsed search interaction

**Check If Affected:**
- `README.md` — update only if the top-level dashboard feature summary should mention improved mobile header usability

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Documentation updated

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-133): complete Step N — description`
- **Bug fixes:** `fix(KB-133): description`
- **Tests:** `test(KB-133): description`

## Do NOT

- Expand task scope into desktop header redesign, list-view toolbar changes, or unrelated mobile cleanup already tracked by other tasks
- Hide functionality behind unlabeled controls — the mobile overflow/search UI must remain keyboard- and screen-reader-accessible
- Change the meaning of existing Header callbacks or move search state ownership out of the existing `searchQuery` / `onSearchChange` contract
- Reintroduce or add a Usage action as part of this task unless KB-134 explicitly changes `HeaderProps` first; the current stray `onOpenUsage` wiring in `App.tsx` is not the contract KB-133 should implement against
- Silence or skip unrelated failing tests instead of waiting for or incorporating the KB-134 dependency
- Skip tests
- Modify files outside the File Scope without good reason
- Commit without the task ID prefix
