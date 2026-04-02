# Task: KB-013 - Add Step Progress Bar to Task Detail Modal

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This is a UI feature that adds a new component to an existing modal. It requires careful styling for hover tooltips and segment bars, but doesn't touch complex backend logic or security-sensitive code.
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 2

## Mission

Add a visual step progress view to the task detail modal that displays all task steps as a segmented progress bar. Each segment represents one step with color-coded status. Hovering over segments reveals step details (name and status). This gives users immediate visibility into task execution progress without reading the full agent log.

## Dependencies

- **None**

## Context to Read First

- `/Users/eclipxe/Projects/kb/packages/core/src/types.ts` — TaskStep interface (`name`, `status: "pending" | "in-progress" | "done" | "skipped"`)
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/TaskDetailModal.tsx` — existing modal component structure and tabs pattern
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/TaskCard.tsx` — existing card progress bar for reference (lines 72-85)
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/styles.css` — existing CSS patterns, tooltip styling (see `.card-dep-badge[data-tooltip]:hover::after` pattern)

## File Scope

- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/TaskDetailModal.tsx` (modify — add step progress section)
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/styles.css` (modify — add step progress styles)
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/__tests__/TaskDetailModal.test.tsx` (modify — add tests for step progress)

## Steps

### Step 1: Design Step Progress Component

Create the step progress UI within TaskDetailModal that renders all steps as segments.

- [ ] Add a new section between the Dependencies and Activity sections in TaskDetailModal (only when Definition tab is active)
- [ ] Create segmented progress bar where each step is a colored segment:
  - `done` → `--color-success` (#3fb950, green)
  - `in-progress` → `--todo` (#58a6ff, blue)
  - `pending` → `var(--border)` (#30363d, gray)
  - `skipped` → `var(--text-dim)` (#484f58, muted)
- [ ] Display step count label (e.g., "3/6 steps complete") next to the progress bar
- [ ] Add hover tooltip showing step name and status for each segment (use same pattern as `.card-dep-badge` tooltip)
- [ ] Handle edge case: empty steps array shows "(no steps defined)" message

**Artifacts:**
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/TaskDetailModal.tsx` (modified)

### Step 2: Add CSS Styling

Add styles for the step progress bar and tooltips to styles.css.

- [ ] Add `.detail-step-progress` container styles (margin, padding)
- [ ] Add `.step-progress-bar` flex container for segments
- [ ] Add `.step-progress-segment` styles (flex: 1, height, transition, border-radius)
- [ ] Add `.step-progress-segment` hover state (slight brightness increase)
- [ ] Add `.step-progress-segment` gap between segments (2px)
- [ ] Add `.step-progress-label` styles (font-size, color, font-family mono)
- [ ] Add `.step-progress-tooltip` using the same CSS pattern as `.card-dep-badge[data-tooltip]:hover::after`
- [ ] Add status modifier classes for segment colors (or use inline styles for dynamic colors)
- [ ] Ensure responsive behavior: segments remain clickable/tappable on mobile

**Artifacts:**
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/styles.css` (modified)

### Step 3: Write Tests

Add comprehensive tests for the step progress functionality.

- [ ] Test: renders step progress section when steps exist
- [ ] Test: shows "(no steps defined)" when steps array is empty
- [ ] Test: renders correct number of segments matching step count
- [ ] Test: segments have correct colors based on step status (done, in-progress, pending, skipped)
- [ ] Test: displays correct completion count (e.g., "2/4 steps complete")
- [ ] Test: tooltip appears with step name on segment hover (verify data-tooltip attribute exists with step name)
- [ ] Test: handles all four status values correctly
- [ ] Test: step progress only renders in Definition tab, not Agent Log tab

**Artifacts:**
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/__tests__/TaskDetailModal.test.tsx` (modified)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`
- [ ] Typecheck passes: `pnpm typecheck`

### Step 5: Documentation & Delivery

- [ ] No documentation updates needed (UI feature is self-documenting)
- [ ] Out-of-scope findings created as new tasks via `task_create` tool if any issues discovered

## Implementation Details

### Step Status Colors
Use these CSS variable mappings for consistency with the dashboard theme:
- `done`: `var(--color-success)` or `#3fb950`
- `in-progress`: `var(--todo)` or `#58a6ff`
- `pending`: `var(--border)` or `#30363d`
- `skipped`: `var(--text-dim)` or `#484f58`

### Tooltip Pattern
Copy the tooltip pattern from `.card-dep-badge[data-tooltip]:hover::after` in styles.css:
```css
.step-progress-segment[data-tooltip]:hover::after {
  content: attr(data-tooltip);
  position: absolute;
  bottom: 100%;
  left: 50%;
  transform: translateX(-50%);
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 11px;
  white-space: nowrap;
  z-index: 10;
  pointer-events: none;
  margin-bottom: 4px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}
```

### Component Structure
Add this structure within the Definition tab content, after Dependencies section:
```tsx
<div className="detail-step-progress">
  <h4>Progress</h4>
  <div className="step-progress-wrapper">
    <div className="step-progress-bar">
      {task.steps.map((step, index) => (
        <div
          key={index}
          className={`step-progress-segment step-progress-segment--${step.status}`}
          data-tooltip={`${step.name} (${step.status})`}
          style={{ backgroundColor: getStatusColor(step.status) }}
        />
      ))}
    </div>
    <span className="step-progress-label">
      {completedSteps}/{totalSteps} steps
    </span>
  </div>
</div>
```

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Step progress bar displays in Definition tab of task detail modal
- [ ] Hovering segments shows step name and status
- [ ] Colors match status semantics (green=done, blue=in-progress, gray=pending, muted=skipped)
- [ ] Build and typecheck pass

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-013): complete Step N — description`
- **Bug fixes:** `fix(KB-013): description`
- **Tests:** `test(KB-013): description`

## Do NOT

- Expand scope to include editing steps or modifying step data
- Skip tests
- Modify files outside the File Scope without good reason
- Commit without the task ID prefix
- Create a new separate component file (keep changes within TaskDetailModal)
