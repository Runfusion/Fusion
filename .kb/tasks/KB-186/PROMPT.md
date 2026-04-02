# Task: KB-186 - Refinement: Fix Missing Pace Indicators in Usage Display

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Focused refinement to fix non-functional pace indicators. The component code exists but the data layer (usage.ts) doesn't provide required fields for Gemini. Minimal blast radius - only modifies usage.ts to add missing window duration data.

**Score:** 2/8 — Blast radius: 0 (single file), Pattern novelty: 0 (existing pattern), Security: 0 (no auth changes), Reversibility: 2 (easy to revert)

## Mission

Fix the pace indicators that were added in KB-168 but don't appear for certain providers. The issue is that the Gemini usage fetcher doesn't set `windowDurationMs` on its windows, and the UsageIndicator component requires this field (plus a "weekly" label) to show pace markers. This refinement adds the missing `windowDurationMs` data for Gemini and ensures pace indicators display correctly for all providers.

## Dependencies

- **Task:** KB-168 (pace indicator UI components - must be complete)

## Context to Read First

- `packages/dashboard/src/usage.ts` - Usage data fetchers for Claude, Codex, and Gemini
- `packages/dashboard/app/components/UsageIndicator.tsx` - Lines 47-52 for `shouldShowPace` logic
- `packages/dashboard/app/api.ts` - Lines 192-210 for `UsageWindow` type definition

## File Scope

### Implementation
- `packages/dashboard/src/usage.ts` - Add `windowDurationMs` to Gemini windows

### Tests
- `packages/dashboard/src/usage.test.ts` - Add tests for Gemini window duration (if file exists, otherwise no new tests needed)
- `packages/dashboard/app/components/UsageIndicator.test.tsx` - Verify existing tests still pass

## Steps

### Step 1: Analyze Gemini API Response Structure

- [ ] Review the Gemini API response format to understand what window timing data is available
- [ ] Determine the appropriate `windowDurationMs` value for Gemini's rate limit windows (daily = 86400000ms, or infer from reset time if available)
- [ ] Check if Gemini's API provides explicit window duration or if we need to infer from reset timing

**Note:** Looking at the Gemini fetcher (lines 317-357), the API returns `resetTime` in bucket objects but doesn't appear to provide explicit window duration. For rate limits that reset daily, use `86400000` (24 hours in ms) as the standard duration.

### Step 2: Add windowDurationMs to Gemini Usage Windows

- [ ] In `fetchGeminiUsage()` function (around line 317-357), modify the window creation to include `windowDurationMs`
- [ ] Add `windowDurationMs: 24 * 60 * 60 * 1000` (86400000ms = 1 day) for all Gemini windows since Gemini rate limits are daily
- [ ] Ensure `resetMs` is also being set correctly from the bucket's `resetTime`
- [ ] Update the `UsageWindow` object construction in the `for (const [family, info] of modelGroups)` loop

**Expected code change around line 345:**
```typescript
for (const [family, info] of modelGroups) {
  let resetMs: number | undefined;
  if (info.resetText) {
    // Parse the reset time from the resetText or use the already computed value
    resetMs = /* existing logic to compute ms from resetText */;
  }
  
  usage.windows.push({
    label: family,
    percentUsed: Math.min(100, Math.max(0, 100 - info.pctLeft)),
    percentLeft: Math.min(100, Math.max(0, info.pctLeft)),
    resetText: info.resetText,
    resetMs, // Will be set from bucket.resetTime parsing
    windowDurationMs: 24 * 60 * 60 * 1000, // Daily window for Gemini
  });
}
```

**Artifacts:**
- `packages/dashboard/src/usage.ts` (modified - Gemini `windowDurationMs` added)

### Step 3: Update Pace Indicator Visibility Logic (if needed)

- [ ] Review the `shouldShowPace` logic in `UsageIndicator.tsx` line 47-49
- [ ] Current logic: `window.label.toLowerCase().includes('weekly') && window.resetMs !== undefined && window.windowDurationMs !== undefined`
- [ ] For Gemini: Labels are "Pro models", "Flash Lite", "Flash models" - these don't include "weekly"
- [ ] Decision point: Either add "Daily" detection to shouldShowPace, or accept that pace indicators only work for weekly windows

**Decision:** Add support for daily windows in pace indicator since Gemini has daily rate limits. Modify `UsageIndicator.tsx` to show pace for both weekly and daily windows.

- [ ] Update `UsageIndicator.tsx` line 47-49 to show pace for both "weekly" and "daily" windows:
```typescript
const shouldShowPace = (window.label.toLowerCase().includes('weekly') || window.label.toLowerCase().includes('daily')) && 
                       window.resetMs !== undefined && 
                       window.windowDurationMs !== undefined;
```

**Artifacts:**
- `packages/dashboard/app/components/UsageIndicator.tsx` (modified - expand shouldShowPace logic)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run existing UsageIndicator tests: `pnpm vitest run app/components/UsageIndicator.test.tsx`
- [ ] All 32 existing tests must pass
- [ ] Run full dashboard test suite: `pnpm test`
- [ ] Fix any failures
- [ ] Build passes: `pnpm build`

**Manual verification steps (describe in code comments if automated tests not possible):**
- [ ] Verify Gemini usage windows now include `windowDurationMs` in API response
- [ ] Verify pace indicators appear for Gemini "Pro models", "Flash Lite", "Flash models" windows when data is available

**Artifacts:**
- Test results showing all passes

### Step 5: Documentation & Delivery

- [ ] Create changeset file for the fix:
```bash
cat > .changeset/fix-gemini-pace-indicators.md << 'EOF'
---
"@dustinbyrne/kb": patch
---

Fix missing pace indicators for Gemini provider by adding windowDurationMs to usage data.
EOF
```
- [ ] Update inline code comments in usage.ts explaining the 24-hour window duration choice for Gemini

**Artifacts:**
- `.changeset/fix-gemini-pace-indicators.md` (new)

## Documentation Requirements

**Must Update:**
- None (self-documenting code fix)

**Check If Affected:**
- `AGENTS.md` - No changes needed

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test` returns 0 failures)
- [ ] Build passes (`pnpm build` succeeds)
- [ ] Gemini usage windows now include `windowDurationMs` (86400000ms for daily windows)
- [ ] Pace indicators appear for Gemini windows that have both `resetMs` and `windowDurationMs`
- [ ] Changeset file created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-186): complete Step N — description`
- **Bug fixes:** `fix(KB-186): description`
- **Tests:** `test(KB-186): description`

Example commits:
- `fix(KB-186): add windowDurationMs to Gemini usage windows`
- `feat(KB-186): extend pace indicators to support daily windows`
- `test(KB-186): verify Gemini pace indicators render correctly`

## Reference Implementation Notes

### Gemini API Structure
The Gemini API returns quota data in a `buckets` array. Each bucket has:
- `modelId`: The model identifier (e.g., "gemini-2.5-pro", "gemini-2.0-flash")
- `remainingFraction`: Percentage of quota remaining (0-1)
- `resetTime`: ISO timestamp when the quota resets

The current code groups these by model family (Pro, Flash, Flash Lite) and takes the lowest remaining percentage per family.

### The Missing Data
Currently the code creates windows like:
```typescript
{
  label: "Pro models",
  percentUsed: 30,
  percentLeft: 70,
  resetText: "resets in 8h",
  // Missing: resetMs and windowDurationMs
}
```

After the fix:
```typescript
{
  label: "Pro models",
  percentUsed: 30,
  percentLeft: 70,
  resetText: "resets in 8h",
  resetMs: 28800000, // 8 hours in ms
  windowDurationMs: 86400000, // 24 hours in ms
}
```

### Pace Indicator Logic
The UsageIndicator component shows pace when:
1. Window label contains "weekly" OR "daily" (after this fix)
2. `resetMs` is defined (time until reset)
3. `windowDurationMs` is defined (total window length)

This allows the component to calculate:
- `percentElapsed = 100 - (resetMs / windowDurationMs * 100)` - how far through the window we are
- `paceDelta = percentUsed - percentElapsed` - whether usage is ahead/behind expected pace

## Do NOT

- Change the visual design of pace indicators (out of scope for this fix)
- Add pace indicators to non-windowed data (like Session limits)
- Modify providers other than Gemini (Claude and Codex already work)
- Add new configuration options for window durations (use standard daily/weekly values)
- Skip tests for the Gemini usage fetcher
- Modify files outside the File Scope without good reason
