# Task: KB-215 - Restore Weekly Pace Indicators in Usage Dropdown

**Created:** 2026-03-31
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** The issue is localized to the usage indicator display logic. The backend calculates pace data and the frontend has rendering code, but the indicators are not appearing. This requires investigation of data flow between backend usage fetchers and frontend display.
**Score:** 3/8 — Blast radius: 1, Pattern novelty: 1, Security: 0, Reversibility: 1

## Mission

Restore the weekly pace indicators in the dashboard's Usage dropdown that show whether the user's API consumption is ahead of, behind, or on pace with the elapsed time in the current billing window. The indicator should display a vertical marker line on the progress bar at the position representing elapsed time, with explanatory text below (e.g., "Using 15% over pace", "Using 10% under pace", or "On pace with time elapsed").

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/src/usage.ts` — Backend usage fetchers and `calculatePace()` / `applyPaceToWindow()` functions
- `packages/dashboard/app/components/UsageIndicator.tsx` — Frontend component that renders usage windows and pace indicators
- `packages/dashboard/app/api.ts` — API types including `UsageWindow` and `UsagePace` interfaces
- `packages/dashboard/app/components/UsageIndicator.test.tsx` — Test expectations for pace indicator rendering
- `packages/dashboard/app/styles.css` — CSS classes for `.usage-pace-marker`, `.usage-pace-row`, `.pace-ahead`, `.pace-behind`, `.pace-ontrack`

## File Scope

- `packages/dashboard/src/usage.ts` — Debug and fix pace calculation logic
- `packages/dashboard/app/components/UsageIndicator.tsx` — Verify frontend rendering conditions
- `packages/dashboard/app/components/UsageIndicator.test.tsx` — Add/update tests for pace visibility

## Steps

### Step 1: Investigate Backend Pace Calculation

- [ ] Review `applyPaceToWindow()` function logic for edge cases that might return undefined
- [ ] Check if `resetMs` or `windowDurationMs` are being set correctly for weekly windows in all provider fetchers (Claude, Codex, Gemini, Minimax, Zai)
- [ ] Verify `calculatePace()` handles all timing scenarios correctly
- [ ] Add debug logging temporarily to trace pace calculation output
- [ ] Confirm pace data is being attached to windows before returning from `fetchAllProviderUsage()`

### Step 2: Verify Frontend Rendering Conditions

- [ ] Check that `UsageIndicator.tsx` correctly reads `window.pace` from API response
- [ ] Verify `shouldShowPace` boolean is correctly calculated as `pace !== undefined`
- [ ] Ensure pace marker positioning math handles both 'used' and 'remaining' view modes
- [ ] Confirm pace row renders with correct status text and icon (TrendingUp, Info, CheckCircle)

### Step 3: Fix the Root Cause

- [ ] Apply fix based on investigation findings (likely either: backend not setting timing data, calculation returning undefined unexpectedly, or frontend condition blocking render)
- [ ] Ensure weekly windows (label includes "Weekly", "Monthly", or has windowDurationMs > 24h) receive pace calculation
- [ ] Maintain backward compatibility — pace should only show when timing data is valid

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `UsageIndicator.test.tsx` suite — all pace-related tests must pass
- [ ] Add new test case that verifies pace appears for weekly windows with valid backend data
- [ ] Run full test suite: `pnpm test` in dashboard package
- [ ] Build passes: `pnpm build`

### Step 5: Documentation & Delivery

- [ ] Remove any debug logging added during investigation
- [ ] Update relevant code comments if behavior changed
- [ ] Out-of-scope findings created as new tasks via `task_create` tool if broader issues discovered

## Documentation Requirements

**Must Update:**
- None — this is a bug fix restoring existing functionality

**Check If Affected:**
- `AGENTS.md` — Update if usage API behavior changes significantly

## Completion Criteria

- [ ] Weekly pace indicators appear in Usage dropdown for windows with valid timing data
- [ ] Pace marker line displays at correct position on progress bar (percentElapsed)
- [ ] Pace status text shows correct message: "Using X% over pace", "Using X% under pace", or "On pace with time elapsed"
- [ ] All tests passing including new pace visibility test
- [ ] Build passes

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-215): complete Step N — description`
- **Bug fixes:** `fix(KB-215): description`
- **Tests:** `test(KB-215): description`

## Do NOT

- Expand task scope to redesign the usage indicator UI
- Skip tests — pace indicator must have test coverage
- Modify files outside the File Scope without good reason
- Commit without the task ID prefix
- Change the pace calculation algorithm's core logic without understanding why it was chosen
