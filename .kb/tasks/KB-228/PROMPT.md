# Task: KB-228 - Add More Time Option Presets for Scheduled Tasks

**Created:** 2026-03-31
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Simple type expansion and UI mapping additions with no breaking changes to existing functionality.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Expand the scheduled task preset options to provide users with more granular time intervals. Currently only hourly/daily/weekly/monthly presets exist. Add common intervals like 15/30 minutes, 2/6/12 hours, and weekday/weekend schedules to reduce the need for custom cron expressions.

## Dependencies

- **None**

## Context to Read First

- `packages/core/src/automation.ts` — Defines `ScheduleType` union type and `AUTOMATION_PRESETS` cron mappings
- `packages/dashboard/app/components/ScheduleForm.tsx` — Form component with `PRESET_CRON` and `SCHEDULE_TYPE_LABELS` (mirrors core definitions)
- `packages/dashboard/app/components/ScheduleCard.tsx` — Card display with `SCHEDULE_TYPE_COLORS` for visual badges
- `packages/dashboard/app/components/__tests__/ScheduleForm.test.tsx` — Existing test patterns for form behavior

## File Scope

- `packages/core/src/automation.ts`
- `packages/dashboard/app/components/ScheduleForm.tsx`
- `packages/dashboard/app/components/ScheduleCard.tsx`
- `packages/dashboard/app/components/__tests__/ScheduleForm.test.tsx`

## Steps

### Step 1: Add New Schedule Type Presets to Core

- [ ] Add 6 new values to `ScheduleType` union type in `packages/core/src/automation.ts`:
  - `"every15Minutes"` → `"*/15 * * * *"`
  - `"every30Minutes"` → `"*/30 * * * *"`
  - `"every2Hours"` → `"0 */2 * * *"`
  - `"every6Hours"` → `"0 */6 * * *"`
  - `"every12Hours"` → `"0 */12 * * *"`
  - `"weekdays"` → `"0 9 * * 1-5"` (9 AM Mon-Fri)
- [ ] Add corresponding entries to `AUTOMATION_PRESETS` record with correct cron expressions

**Artifacts:**
- `packages/core/src/automation.ts` (modified)

### Step 2: Update Dashboard Form with New Presets

- [ ] Add new entries to `PRESET_CRON` mapping in `ScheduleForm.tsx` matching core definitions
- [ ] Add human-readable labels to `SCHEDULE_TYPE_LABELS`:
  - `every15Minutes`: "Every 15 minutes"
  - `every30Minutes`: "Every 30 minutes"
  - `every2Hours`: "Every 2 hours"
  - `every6Hours`: "Every 6 hours"
  - `every12Hours`: "Every 12 hours"
  - `weekdays`: "Weekdays at 9 AM (Mon-Fri)"

**Artifacts:**
- `packages/dashboard/app/components/ScheduleForm.tsx` (modified)

### Step 3: Update Schedule Card Colors

- [ ] Add color entries to `SCHEDULE_TYPE_COLORS` in `ScheduleCard.tsx` for visual distinction:
  - `every15Minutes`: `"var(--color-cyan, #06b6d4)"`
  - `every30Minutes`: `"var(--color-teal, #14b8a6)"`
  - `every2Hours`: `"var(--color-indigo, #6366f1)"`
  - `every6Hours`: `"var(--color-rose, #f43f5e)"`
  - `every12Hours`: `"var(--color-amber, #f59e0b)"`
  - `weekdays`: `"var(--color-emerald, #10b981)"`

**Artifacts:**
- `packages/dashboard/app/components/ScheduleCard.tsx` (modified)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Add test cases in `ScheduleForm.test.tsx` to verify new preset types auto-fill correct cron expressions:
  - Test `every15Minutes` → `"*/15 * * * *"`
  - Test `every6Hours` → `"0 */6 * * *"`
  - Test `weekdays` → `"0 9 * * 1-5"`
- [ ] Run `pnpm test` to verify all tests pass
- [ ] Run `pnpm build` to verify no TypeScript compilation errors from type changes

**Artifacts:**
- `packages/dashboard/app/components/__tests__/ScheduleForm.test.tsx` (modified)

### Step 5: Documentation & Delivery

- [ ] Create changeset file for the enhancement (minor bump for new feature)
- [ ] Verify new options appear correctly in schedule dropdown
- [ ] Verify selecting each new preset auto-fills the correct cron expression
- [ ] Verify schedule cards display correct color badges for new types

## Documentation Requirements

**Must Update:**
- No documentation updates required — feature is self-documenting via UI labels

**Check If Affected:**
- Dashboard user guide — verify if scheduled tasks section needs preset list update

## Completion Criteria

- [ ] All 6 new schedule presets available in form dropdown
- [ ] Each preset auto-fills correct cron expression
- [ ] Each preset displays with unique color badge in cards
- [ ] All existing tests pass
- [ ] New preset tests added and passing
- [ ] Build completes without errors
- [ ] Changeset file created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-228): complete Step N — description`
- **Bug fixes:** `fix(KB-228): description`
- **Tests:** `test(KB-228): description`

## Do NOT

- Remove or modify existing preset types (hourly, daily, weekly, monthly, custom)
- Change existing cron expressions for current presets
- Add runtime validation logic — rely on existing server-side cron validation
- Modify the custom cron input behavior
- Update any CLI commands (extension.ts) — this is dashboard-only UI enhancement
