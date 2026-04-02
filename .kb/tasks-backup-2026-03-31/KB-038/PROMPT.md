# Task: KB-038 - Add Collapsible Steps Toggle to Task Card

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a localized UI enhancement to TaskCard component. No API changes, no database migrations, no security implications. Reversible by simple CSS/JS toggle.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Add a collapsible toggle to the task card on the dashboard that displays the list of task steps when expanded. This allows users to quickly see step progress without opening the full task detail modal. The steps section should be collapsed by default to keep the card compact, with a smooth expand/collapse animation.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/TaskCard.tsx` — The card component to modify
- `packages/dashboard/app/styles.css` — Card and progress bar styling (search for `.card-*` classes)
- `packages/core/src/types.ts` — `TaskStep` interface (has `name: string` and `status: StepStatus`)
- `packages/dashboard/app/components/TaskDetailModal.tsx` — Reference for how steps are rendered (see `step-progress-wrapper` pattern)
- `packages/dashboard/app/components/__tests__/TaskCard.test.tsx` — Existing test patterns

## File Scope

- `packages/dashboard/app/components/TaskCard.tsx` (modify)
- `packages/dashboard/app/styles.css` (add styles for steps toggle)
- `packages/dashboard/app/components/__tests__/TaskCard.test.tsx` (add tests)

## Steps

### Step 1: Add Steps Toggle State and UI to TaskCard

- [ ] Import `ChevronDown` from `lucide-react` (already used elsewhere in the component)
- [ ] Add local state `showSteps: boolean` (default false) using `useState`
- [ ] Add a clickable toggle button in the card that shows step count when steps exist
- [ ] Toggle should display: "X steps" with a chevron icon that rotates when expanded
- [ ] Only show the toggle when `task.steps.length > 0`
- [ ] Add conditional rendering of steps list when `showSteps` is true

**Implementation details:**
- Place the toggle below the progress bar (after the existing `.card-progress` section)
- Use a flex container with `align-items: center` and `gap: 4px`
- Chevron should rotate 180deg when expanded using CSS transform transition
- The step list should show each step with its status indicator (small colored dot + step name)

**Artifacts:**
- `packages/dashboard/app/components/TaskCard.tsx` (modified)

### Step 2: Add CSS Styles for Steps Toggle and List

- [ ] Add `.card-steps-toggle` class: flex container, cursor pointer, hover state, small font (11px), muted color
- [ ] Add `.card-steps-toggle-icon` class: transition transform 0.2s ease
- [ ] Add `.card-steps-toggle-icon.expanded` with `transform: rotate(180deg)`
- [ ] Add `.card-steps-list` class: margin-top 8px, flex column, gap 4px, max-height with overflow
- [ ] Add `.card-step-item` class: flex container with gap 6px, align-items center, font-size 12px
- [ ] Add `.card-step-dot` class: 6px circle colored by status (use same colors as detail modal: pending=#30363d, in-progress=#58a6ff, done=#3fb950, skipped=#484f58)
- [ ] Add `.card-step-name` class: truncate with ellipsis, color var(--text-muted)
- [ ] Add `.card-step-name.completed` for done steps (strikethrough or muted)

**Color mapping (match TaskDetailModal.tsx):**
- `done`: `var(--color-success, #3fb950)`
- `in-progress`: `var(--todo, #58a6ff)`
- `skipped`: `var(--text-dim, #484f58)`
- `pending`: `var(--border, #30363d)`

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Add test: "does not show steps toggle when task has no steps"
- [ ] Add test: "shows steps toggle with count when task has steps"
- [ ] Add test: "clicking toggle expands and shows step list"
- [ ] Add test: "clicking toggle again collapses step list"
- [ ] Add test: "step list renders correct number of steps"
- [ ] Add test: "completed steps have strikethrough or muted style"
- [ ] Run `pnpm test` and ensure all tests pass
- [ ] Run `pnpm build` and ensure build succeeds

**Artifacts:**
- `packages/dashboard/app/components/__tests__/TaskCard.test.tsx` (modified)

### Step 4: Documentation & Delivery

- [ ] No documentation updates required (self-explanatory UI feature)
- [ ] Create changeset for the feature:
  ```bash
  cat > .changeset/add-task-steps-toggle.md << 'EOF'
  ---
  "@dustinbyrne/kb": minor
  ---

  Add collapsible steps toggle to task cards on the dashboard
  EOF
  ```
- [ ] Verify the toggle works on hover, focus, and click
- [ ] Verify keyboard accessibility (toggle is focusable, Enter/Space triggers)

## Documentation Requirements

**Check If Affected:**
- `AGENTS.md` — No changes needed
- `README.md` — No changes needed (user-facing feature, self-explanatory)

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Build succeeds (`pnpm build`)
- [ ] Steps toggle appears on cards with steps
- [ ] Toggle expands/collapses smoothly
- [ ] Step status colors match the detail modal

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step 1:** `feat(KB-038): add steps toggle state and UI to TaskCard`
- **Step 2:** `feat(KB-038): add CSS styles for steps toggle and list`
- **Step 3:** `test(KB-038): add tests for steps toggle functionality`
- **Step 4:** `feat(KB-038): add changeset for steps toggle feature`

## Do NOT

- Modify the Task type or API
- Change the existing progress bar behavior
- Auto-expand steps on any condition (keep it manual toggle only)
- Add animations that impact performance (keep CSS transitions simple)
- Modify other components (TaskDetailModal, Board, etc.) unless necessary for this feature
- Add persistence for the expanded state (not needed, reset on re-render)
