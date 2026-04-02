# Task: KB-623 - Add Overflow Scrolling to Task Dialog Tabs on Mobile

**Created:** 2026-03-31
**Size:** S

## Review Level: 0 (None)

**Assessment:** This is a focused CSS-only change to enable horizontal scrolling for task dialog tabs on mobile viewports. No logic changes, no API changes, minimal blast radius.
**Score:** 0/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 0

## Mission

Fix the task detail dialog tabs so they scroll horizontally within their container on mobile instead of forcing the entire window to scroll horizontally. The tabs (Definition, Activity, Agent Log, Steering, Comments, Model) currently overflow on narrow viewports, causing poor UX. The fix should make the tab bar itself scrollable while keeping the rest of the modal content behaving normally.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/TaskDetailModal.tsx` — The task dialog component with tab structure
- `packages/dashboard/app/styles.css` — Contains `.detail-tabs` and `.detail-tab` styles plus mobile responsive section at `@media (max-width: 768px)`

## File Scope

- `packages/dashboard/app/styles.css` — Modify mobile responsive styles for `.detail-tabs`

## Steps

### Step 1: Add Mobile Tab Overflow CSS

- [ ] Add `overflow-x: auto` to `.detail-tabs` within the `@media (max-width: 768px)` section
- [ ] Add `-webkit-overflow-scrolling: touch` for smooth iOS scrolling
- [ ] Add `scrollbar-width: none` and `::-webkit-scrollbar { display: none; }` to hide the scrollbar visually (clean mobile look)
- [ ] Ensure `.detail-tab` keeps `flex-shrink: 0` so tabs don't squish on mobile
- [ ] Remove or adjust `flex: 1` from `.detail-tab` in mobile context since it causes uneven spacing when scrolling

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 2: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Verify all tests pass
- [ ] Build passes: `pnpm build`

**Manual verification (since this is CSS-only mobile behavior):**
- Open dashboard in browser
- Open any task detail dialog
- Resize viewport to mobile width (< 768px) or use DevTools mobile emulation
- Confirm all 6 tabs (Definition, Activity, Agent Log, Steering, Comments, Model) are accessible by swiping/scrolling the tab bar horizontally
- Confirm the modal window itself does not scroll horizontally
- Confirm no visual scrollbar appears (clean mobile UX)

### Step 3: Documentation & Delivery

- [ ] Update relevant documentation (none required for this CSS fix)
- [ ] Out-of-scope findings created as new tasks via `task_create` tool (if any issues discovered)

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Tabs scroll horizontally within their container on mobile (< 768px)
- [ ] No horizontal window scrolling occurs
- [ ] Clean visual appearance (no visible scrollbar)

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-623): complete Step N — description`
- **Bug fixes:** `fix(KB-623): description`
- **Tests:** `test(KB-623): description`

## Do NOT

- Expand task scope beyond the tab overflow fix
- Skip tests
- Modify files outside `packages/dashboard/app/styles.css`
- Commit without the task ID prefix
- Change the desktop (> 768px) tab behavior — keep existing layout
