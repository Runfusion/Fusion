# Task: KB-612 - Convert Stuck Task Timeout Setting to Minutes

**Created:** 2026-03-31
**Size:** S

## Review Level: 0 (None)

**Assessment:** This is a straightforward UI-only change that converts a numeric input from milliseconds to minutes. The internal storage format (milliseconds) remains unchanged — only the user-facing presentation and conversion logic changes. Zero blast radius, no security implications, fully reversible.
**Score:** 1/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 1

## Mission

Change the "Stuck Task Timeout" setting in the dashboard from milliseconds to minutes. Users will enter values in minutes (e.g., "10" for 10 minutes), and the UI will convert to milliseconds internally (600000) for storage. This improves UX by letting users think in human-friendly time units rather than counting milliseconds.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/SettingsModal.tsx` — Contains the current stuck task timeout input field in the "scheduling" section (around line 860)
- `packages/dashboard/app/components/__tests__/SettingsModal.test.tsx` — Contains existing tests for the stuck task timeout field (around line 1350)
- `packages/core/src/types.ts` — Defines `ProjectSettings.taskStuckTimeoutMs` type (remains unchanged — still milliseconds internally)

## File Scope

- `packages/dashboard/app/components/SettingsModal.tsx` (modified)
- `packages/dashboard/app/components/__tests__/SettingsModal.test.tsx` (modified)

## Steps

### Step 1: Update SettingsModal.tsx

- [ ] Change the input label from "Stuck Task Timeout (ms)" to "Stuck Task Timeout (minutes)"
- [ ] Change the input `step` from `60000` to `1` (whole minutes)
- [ ] Change the input `min` from `0` to `1` (minimum 1 minute when enabled)
- [ ] Update the `onChange` handler to convert minutes to milliseconds when storing: `num * 60000`
- [ ] Update the `value` display to convert milliseconds to minutes: `Math.round((form.taskStuckTimeoutMs || 0) / 60000)` or empty string when undefined
- [ ] Update the help text from referencing milliseconds to minutes: "Timeout in minutes for detecting stuck tasks. When a task's agent session shows no activity for longer than this duration, the task is terminated and retried. Leave empty to disable. Suggested: 10."
- [ ] Keep the empty → undefined behavior (empty input means disabled)

**Artifacts:**
- `packages/dashboard/app/components/SettingsModal.tsx` (modified)

### Step 2: Update SettingsModal Tests

- [ ] Update test: "shows Stuck Task Timeout field in Scheduling section" — change label text assertion from "(ms)" to "(minutes)", step from "60000" to "1", min from "0" to "1"
- [ ] Update test: "Stuck Task Timeout field saves correctly when set to a value" — input "10" minutes, expect save payload of `600000` (10 * 60000)
- [ ] Update test: "Stuck Task Timeout field submits undefined when set to 0 or empty (disabled)" — now just empty string triggers undefined, not 0
- [ ] Update test: "Stuck Task Timeout field shows helper text" — update text matcher to reference minutes
- [ ] Add test: "Stuck Task Timeout field displays correct minute value from milliseconds setting" — mock settings with `taskStuckTimeoutMs: 600000`, expect input value of "10"

**Artifacts:**
- `packages/dashboard/app/components/__tests__/SettingsModal.test.tsx` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` in the dashboard package to verify all SettingsModal tests pass
- [ ] Run `pnpm test` at workspace root to verify no regressions
- [ ] Run `pnpm typecheck` to verify TypeScript compiles cleanly
- [ ] Manually verify the conversion math:
  - Input: 10 minutes → Stored: 600000ms ✓
  - Input: 30 minutes → Stored: 1800000ms ✓
  - Stored: 600000ms → Displayed: 10 ✓
  - Empty input → Stored: undefined (disabled) ✓

### Step 4: Documentation & Delivery

- [ ] Create changeset file for this user-facing UX improvement (minor bump since it changes UI behavior):
  ```bash
  cat > .changeset/stuck-timeout-minutes.md << 'EOF'
  ---
  "@dustinbyrne/kb": minor
  ---

  Change stuck task timeout setting from milliseconds to minutes for better usability
  EOF
  ```
- [ ] Commit with task ID prefix: `feat(KB-612): convert stuck task timeout to minutes input`

## Documentation Requirements

**Must Update:**
- None — the AGENTS.md already describes this setting conceptually without specifying the UI unit

**Check If Affected:**
- `AGENTS.md` — verify the `taskStuckTimeoutMs` description doesn't need updating (it describes the setting in general terms, not UI units)

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] User can enter "10" in the Stuck Task Timeout field and see it saved as 600000ms internally
- [ ] When loading settings with 600000ms stored, the field displays "10"
- [ ] Empty field correctly disables the stuck task detection
- [ ] Changeset file included in commit

## Do NOT

- Change the internal storage format — `taskStuckTimeoutMs` in types and database must remain milliseconds
- Modify the stuck-task-detector engine logic — it already works with milliseconds
- Add conversion logic anywhere except the UI layer (SettingsModal)
- Change any other time-related settings (pollIntervalMs stays in milliseconds intentionally)
