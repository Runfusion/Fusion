# Task: KB-660 - Fix Git Manager Dialog Rendering Off-Screen

**Created:** 2026-04-01
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Straightforward CSS fix for modal positioning and overflow handling. Low blast radius, well-understood pattern from PlanningModal.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

Fix the Git Manager dialog so it renders correctly within the viewport on all screen sizes. The modal currently renders partially off-screen on smaller viewports because it lacks proper flex layout and overflow containment that other modals (like PlanningModal) have implemented.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/GitManagerModal.tsx` — The modal component (uses `.gm-modal` class)
- `packages/dashboard/app/styles.css` — CSS styles around lines 9760-9830 for `.gm-modal`, `.gm-layout`, `.gm-content`
- Reference: PlanningModal styling around line 7139 in `packages/dashboard/app/styles.css` — uses `.planning-modal-overlay` with `align-items: center` and `.planning-modal` with proper flex/overflow

## File Scope

- `packages/dashboard/app/styles.css` — Modify `.gm-modal` and mobile responsive styles

## Steps

### Step 1: Analyze Current Modal Layout

- [ ] Verify the issue: `.gm-modal` lacks `display: flex` and `overflow: hidden`
- [ ] Compare with `.planning-modal` which properly handles overflow
- [ ] Identify the root cause: content exceeds viewport due to `min-height: 400px` on `.gm-content` without proper modal containment

### Step 2: Fix Desktop Modal Styles

- [ ] Add `display: flex; flex-direction: column;` to `.gm-modal`
- [ ] Add `overflow: hidden;` to `.gm-modal`
- [ ] Ensure `.gm-layout` properly fills available height with `flex: 1; min-height: 0;`
- [ ] Verify `.gm-content` scrolls correctly with `overflow-y: auto;`

### Step 3: Fix Mobile Responsive Styles

- [ ] Update mobile `.gm-modal` styles (around line 10858) to use `height: 100vh` instead of `max-height: 100vh` for full coverage
- [ ] Ensure `.gm-layout` on mobile properly stacks with `flex-direction: column`
- [ ] Reduce `.gm-content` `min-height` on mobile from `300px` to `200px` to prevent overflow

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Verify all tests pass
- [ ] Build passes: `pnpm build`

### Step 5: Documentation & Delivery

- [ ] Update CSS comments if needed to document the modal layout pattern
- [ ] Create changeset for the fix

## Documentation Requirements

**Check If Affected:**
- `packages/dashboard/app/components/__tests__/GitManagerModal.test.tsx` — verify no test updates needed for CSS-only change

## Completion Criteria

- [ ] Git Manager modal renders fully within viewport on desktop (900px wide, centered/positioned correctly)
- [ ] Git Manager modal renders fully within viewport on mobile (full screen, no off-screen content)
- [ ] Modal content scrolls properly when content exceeds available height
- [ ] All sections (Status, Changes, Commits, Branches, Worktrees, Stashes, Remotes) remain accessible
- [ ] All tests passing
- [ ] Build passes

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-660): complete Step N — description`
- **Bug fixes:** `fix(KB-660): description`
- **Tests:** `test(KB-660): description`

## Do NOT

- Expand task scope beyond the positioning/overflow fix
- Skip tests
- Modify TypeScript/React code — this is a CSS-only fix
- Change modal functionality or behavior beyond the off-screen rendering issue
