# Task: KB-168 - Add Weekly Pace Markers and Percentage to Usage Indicator

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a focused UI enhancement adding pace visualization to the existing usage indicator. Minimal blast radius - only modifies UsageIndicator component and styles. Pattern is straightforward: calculate elapsed time percentage, display marker on progress bar, show delta text.

**Score:** 3/8 — Blast radius: 1, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Enhance the dashboard's usage indicator modal with visual pace tracking for weekly usage windows. Add a marker on the progress bar showing the user's expected weekly pace (based on elapsed time in the window) and text below showing the percentage they are ahead or behind that pace. The display must correctly adjust for the used/remaining toggle state.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/UsageIndicator.tsx` - Main usage indicator component with `UsageWindowRow`, progress bars, and view mode toggle
- `packages/dashboard/app/components/UsageIndicator.test.tsx` - Existing test patterns for the usage indicator
- `packages/dashboard/app/api.ts` - `UsageWindow` type definition (`percentUsed`, `percentLeft`, `resetMs`, `windowDurationMs`)
- `packages/dashboard/app/styles.css` - Existing usage styles (`.usage-progress-bar`, `.usage-progress-fill`, `.usage-window-footer`)

## File Scope

### Implementation
- `packages/dashboard/app/components/UsageIndicator.tsx` - Add pace calculation, marker component, and percentage display
- `packages/dashboard/app/styles.css` - Add CSS for pace marker line and pace text styling

### Tests
- `packages/dashboard/app/components/UsageIndicator.test.tsx` - Add tests for pace marker rendering and percentage calculations

## Steps

### Step 1: Add Pace Calculation and Types

- [ ] Add `pacePercent` calculation to `UsageWindowRow` component using existing `window.resetMs` and `window.windowDurationMs`
- [ ] Calculate `percentElapsed = 100 - (resetMs / windowDurationMs * 100)` when both values exist
- [ ] Calculate `paceDelta = window.percentUsed - percentElapsed` (positive = ahead of pace, negative = behind)
- [ ] Support both view modes: in "used" mode compare `percentUsed` to `percentElapsed`; in "remaining" mode the marker position and delta calculation must be inverted

**Artifacts:**
- `packages/dashboard/app/components/UsageIndicator.tsx` (modified - pace calculation logic)

### Step 2: Add Pace Marker to Progress Bar

- [ ] Add visual marker line on the progress bar showing expected pace position
- [ ] Position marker at `percentElapsed%` from the left in "used" mode
- [ ] Position marker at `(100 - percentElapsed)%` from the left in "remaining" mode (mirrored)
- [ ] Use distinct visual style for the marker: 2px wide vertical line, `--in-progress` color (purple), slightly taller than the progress bar (10px vs 8px), z-index above progress fill
- [ ] Only render marker when `windowDurationMs` and `resetMs` are defined and window label contains "Weekly" (case-insensitive)

**Artifacts:**
- `packages/dashboard/app/components/UsageIndicator.tsx` (modified - PaceMarker component or inline marker)
- `packages/dashboard/app/styles.css` (modified - `.usage-pace-marker` styles)

### Step 3: Add Pace Percentage Text Below Progress Bar

- [ ] Add pace text row below the existing `.usage-window-footer` in `UsageWindowRow`
- [ ] In "used" mode:
  - If `paceDelta > 5%`: show "⚡ X% ahead of pace" in green (using more than expected)
  - If `paceDelta < -5%`: show "🐢 X% behind pace" in blue (using less than expected)
  - Otherwise: show "✓ On pace" in muted color
- [ ] In "remaining" mode (invert the logic):
  - If user is ahead on usage (high percentUsed), they're "behind on remaining" (will run out early)
  - Show appropriate inverted messaging with correct percentages
- [ ] Round percentages to whole numbers for display
- [ ] Only show pace text for weekly windows with valid timing data

**Artifacts:**
- `packages/dashboard/app/components/UsageIndicator.tsx` (modified - pace text display)
- `packages/dashboard/app/styles.css` (modified - `.usage-pace-text`, `.pace-ahead`, `.pace-behind`, `.pace-ontrack` classes)

### Step 4: Add CSS Styles

- [ ] Add `.usage-pace-marker` class: `position: absolute`, `width: 2px`, `height: 10px`, `background: var(--in-progress)`, `z-index: 2`, centered on the calculated percentage
- [ ] Add `.usage-pace-row` class: `display: flex`, `align-items: center`, `gap: 6px`, `font-size: 11px`, `margin-top: 4px`
- [ ] Add color modifier classes: `.pace-ahead { color: var(--color-success) }`, `.pace-behind { color: var(--triage) }`, `.pace-ontrack { color: var(--text-muted) }`
- [ ] Ensure progress bar container has `position: relative` for absolute marker positioning

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified - new pace-related CSS classes)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Add test: "renders pace marker for weekly windows with timing data"
- [ ] Add test: "does not render pace marker for non-weekly windows (Session, Hourly)"
- [ ] Add test: "does not render pace marker when resetMs or windowDurationMs is undefined"
- [ ] Add test: "shows 'ahead of pace' text when usage exceeds elapsed time by >5%"
- [ ] Add test: "shows 'behind pace' text when usage is under elapsed time by >5%"
- [ ] Add test: "shows 'on pace' text when usage is within 5% of elapsed time"
- [ ] Add test: "pace marker position inverts correctly when switching to remaining mode"
- [ ] Add test: "pace percentage text inverts correctly when switching to remaining mode"
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

**Artifacts:**
- `packages/dashboard/app/components/UsageIndicator.test.tsx` (modified - new pace-related tests)

### Step 6: Documentation & Delivery

- [ ] Create changeset file for the feature:
  ```bash
  cat > .changeset/add-usage-pace-indicator.md << 'EOF'
  ---
  "@dustinbyrne/kb": patch
  ---

  Add weekly pace markers and ahead/behind percentage to usage indicator.
  EOF
  ```
- [ ] Out-of-scope findings: if pace calculation reveals need for backend changes, create follow-up task via `task_create`

**Artifacts:**
- `.changeset/add-usage-pace-indicator.md` (new)

## Documentation Requirements

**Must Update:**
- None (self-documenting UI feature)

**Check If Affected:**
- `AGENTS.md` — Update if usage patterns change significantly (unlikely for this UI-only change)

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test` returns 0 failures)
- [ ] Build passes (`pnpm build` succeeds)
- [ ] Weekly usage windows show a vertical pace marker on the progress bar
- [ ] Pace marker position adjusts correctly for used/remaining toggle
- [ ] Percentage ahead/behind/on-pace displays below the progress bar
- [ ] Pace text message inverts correctly for used/remaining toggle
- [ ] Non-weekly windows (Session, Hourly, Daily) do not show pace indicators
- [ ] Changeset file created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-168): complete Step N — description`
- **Bug fixes:** `fix(KB-168): description`
- **Tests:** `test(KB-168): description`
- **Styles:** `style(KB-168): description`

Example commits:
- `feat(KB-168): complete Step 1 — add pace calculation logic`
- `feat(KB-168): complete Step 3 — add pace percentage text display`
- `style(KB-168): add CSS for pace marker and text`
- `test(KB-168): add tests for pace indicator with view mode toggle`

## Reference Implementation Notes

### Pace Calculation Logic
```typescript
// In UsageWindowRow component
const shouldShowPace = window.label.toLowerCase().includes('weekly') && 
                       window.resetMs !== undefined && 
                       window.windowDurationMs !== undefined;

if (shouldShowPace) {
  const percentElapsed = 100 - (window.resetMs / window.windowDurationMs * 100);
  const paceDelta = window.percentUsed - percentElapsed; // positive = ahead
  
  // For "used" mode: marker at percentElapsed%, ahead = using more than time elapsed
  // For "remaining" mode: marker at (100 - percentElapsed)%, ahead = will run out early
}
```

### CSS Structure
```css
.usage-progress-wrapper {
  position: relative; /* for absolute marker positioning */
}

.usage-pace-marker {
  position: absolute;
  top: -1px;
  width: 2px;
  height: 10px;
  background: var(--in-progress);
  border-radius: 1px;
  z-index: 2;
  transform: translateX(-50%); /* center on percentage point */
}

.usage-pace-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  margin-top: 4px;
}

.pace-ahead { color: var(--color-success); }
.pace-behind { color: var(--triage); }
.pace-ontrack { color: var(--text-muted); }
```

## Do NOT

- Add new providers (out of scope - handled in KB-152)
- Modify backend usage fetchers
- Add pace indicators to non-weekly windows (Session, Hourly don't need pacing)
- Change the existing color scheme for progress bars
- Add settings/preferences for pace thresholds (use fixed 5% threshold)
- Skip tests for view mode toggle behavior
- Modify files outside the File Scope without good reason
