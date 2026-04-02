# Task: KB-223 - Add dashboard settings UI field for taskStuckTimeoutMs setting

**Created:** 2026-03-31
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a straightforward UI addition following established patterns. The setting type already exists from KB-206, and we're just exposing it in the dashboard settings modal. Low blast radius, well-established patterns.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

Add a numeric input field in the dashboard Settings UI to allow users to enable and configure the `taskStuckTimeoutMs` setting from the web dashboard. The stuck task detection feature (implemented in KB-206) added this setting to the Settings type, but currently it can only be configured via the CLI or by editing the config file directly. This task exposes the setting in the dashboard's Settings modal.

## Dependencies

- **Task:** KB-206 (Stuck Task Detection and Recovery) — The `taskStuckTimeoutMs` setting type and DEFAULT_SETTINGS entry must exist

## Context to Read First

- `packages/dashboard/app/components/SettingsModal.tsx` — The main settings UI component, specifically the "scheduling" section case in `renderSectionFields()`
- `packages/dashboard/app/components/__tests__/SettingsModal.test.tsx` — Existing test patterns for settings fields
- `packages/core/src/types.ts` — The Settings type definition (verify `taskStuckTimeoutMs?: number` exists and DEFAULT_SETTINGS has it as `undefined`)

## File Scope

- `packages/dashboard/app/components/SettingsModal.tsx` — Add numeric input field for taskStuckTimeoutMs in the Scheduling section
- `packages/dashboard/app/components/__tests__/SettingsModal.test.tsx` — Add test coverage for the new field

## Steps

### Step 1: Add taskStuckTimeoutMs Field to SettingsModal

- [ ] Add a numeric input field for `taskStuckTimeoutMs` in the "scheduling" section of `renderSectionFields()`
- [ ] Field label: "Stuck Task Timeout (ms)"
- [ ] Input type: number with `min={0}` and `step={60000}` (60 seconds)
- [ ] Helper text: "Timeout in milliseconds for detecting stuck tasks. When a task's agent session shows no activity for longer than this duration, the task is terminated and retried. Set to 0 to disable. Suggested: 600000 (10 minutes)."
- [ ] Handle `undefined` value (when disabled) — display as empty or 0
- [ ] On change: convert empty/0 to `undefined` (disabled), positive values to number
- [ ] Verify the field appears correctly in the Scheduling section alongside existing fields (Max Concurrent Tasks, Poll Interval)

**Artifacts:**
- `packages/dashboard/app/components/SettingsModal.tsx` (modified)

### Step 2: Add Test Coverage

- [ ] Add test: "shows Stuck Task Timeout field in Scheduling section"
- [ ] Add test: "Stuck Task Timeout field saves correctly when set to a value"
- [ ] Add test: "Stuck Task Timeout field submits undefined when set to 0 or empty (disabled)"
- [ ] Update `defaultSettings` mock in test file to include `taskStuckTimeoutMs: undefined`
- [ ] Follow existing test patterns for numeric input fields (see maxConcurrent, pollIntervalMs tests)

**Artifacts:**
- `packages/dashboard/app/components/__tests__/SettingsModal.test.tsx` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` — all tests must pass including new SettingsModal tests
- [ ] Run `pnpm typecheck` — no type errors
- [ ] Run `pnpm build` — build succeeds
- [ ] Manual verification: Open dashboard Settings → Scheduling section, verify the field appears with correct label and helper text

### Step 4: Documentation & Delivery

- [ ] Verify the field follows existing UI patterns and styling
- [ ] No documentation updates needed (this is just exposing an existing setting)
- [ ] No changeset needed (dashboard is internal, not published)

## Documentation Requirements

**Must Update:**
- None — this is exposing an existing documented setting in the UI

**Check If Affected:**
- `AGENTS.md` — The `taskStuckTimeoutMs` setting is already documented from KB-206; no changes needed

## Completion Criteria

- [ ] Numeric input field for `taskStuckTimeoutMs` appears in Scheduling section
- [ ] Field correctly handles undefined/0 (disabled) vs positive values
- [ ] Helper text explains the setting clearly
- [ ] Tests cover the new field behavior
- [ ] All tests passing
- [ ] Typecheck passes
- [ ] Build passes

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-223): complete Step N — description`
- **Bug fixes:** `fix(KB-223): description`
- **Tests:** `test(KB-223): description`

## Do NOT

- Add the setting to a different section (keep it in Scheduling with other performance/timing settings)
- Change the setting type or default value (defined in core types)
- Skip test coverage for the new field
- Use a different input pattern than existing numeric fields (maxConcurrent, pollIntervalMs)
