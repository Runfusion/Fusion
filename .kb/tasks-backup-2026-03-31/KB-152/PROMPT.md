# Task: KB-152 - Show Weekly Pace Indicators on Usage Dropdown and Add Minimax/Zai Providers

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This task involves both UI additions (pace indicators) and backend provider integrations. The usage system has clear patterns to follow. Medium blast radius across dashboard and backend usage modules.

**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 2

## Mission

Enhance the dashboard's usage indicator modal with two features:

1. **Weekly Pace Indicators**: Add visual indicators showing whether the user is on track to hit their weekly limits based on current consumption rate. For weekly usage windows, calculate and display a "pace" metric that compares actual usage percentage against elapsed time percentage in the current window.

2. **Minimax and Zai Providers**: Add two new AI provider integrations to the usage monitoring system:
   - **Minimax** ( minimaxi.com ) - Chinese AI provider with usage limits
   - **Zai** (Zhipu AI, zhipuai.cn ) - Chinese AI provider with quota tracking

These additions help users better manage their AI API consumption across all providers they use.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/src/usage.ts` - Backend provider fetchers (Claude, Codex, Gemini patterns)
- `packages/dashboard/src/usage.test.ts` - Test patterns for provider fetchers
- `packages/dashboard/app/components/UsageIndicator.tsx` - Frontend usage display component
- `packages/dashboard/app/components/UsageIndicator.test.tsx` - Frontend test patterns
- `packages/dashboard/app/api.ts` - API type definitions (ProviderUsage, UsageWindow)

## File Scope

### Backend (Provider Fetchers)
- `packages/dashboard/src/usage.ts` - Add `fetchMinimaxUsage()` and `fetchZaiUsage()` functions, update `fetchAllProviderUsage()`
- `packages/dashboard/src/usage.test.ts` - Add tests for new providers

### Frontend (Pace Indicators)
- `packages/dashboard/app/components/UsageIndicator.tsx` - Add pace indicator UI for weekly windows
- `packages/dashboard/app/components/UsageIndicator.test.tsx` - Add tests for pace indicator rendering
- `packages/dashboard/app/api.ts` - Add `pace` field to UsageWindow type (optional field)

### Styles
- `packages/dashboard/app/styles.css` - Add pace indicator CSS classes (existing file will be modified)

## Steps

### Step 1: Add Minimax Provider Backend

- [ ] Create `fetchMinimaxUsage()` function following the Claude/Codex/Gemini pattern
- [ ] Minimax credentials stored at `~/.minimax/credentials.json` (OAuth2 access_token field)
- [ ] API endpoint: `https://api.minimaxi.com/user/quota` (GET, Authorization: Bearer token)
- [ ] Response format: `{ "quota": { "total": number, "used": number, "remaining": number }, "reset_at": ISO8601_timestamp }`
- [ ] Calculate `percentUsed = (used / total) * 100`
- [ ] Support weekly window only (label: "Weekly")
- [ ] Handle auth errors (401/403) with "Auth expired" message
- [ ] Add icon: "🟣" (purple circle emoji)
- [ ] Run backend tests: `pnpm test --filter @kb/dashboard -- --testPathPattern=usage`

**Artifacts:**
- `packages/dashboard/src/usage.ts` (modified - add fetchMinimaxUsage function)

### Step 2: Add Zai (Zhipu AI) Provider Backend

- [ ] Create `fetchZaiUsage()` function following existing patterns
- [ ] Zai credentials stored at `~/.zai/auth.json` (access_token field)
- [ ] API endpoint: `https://api.zhipuai.com/v1/user/usage` (GET, Authorization: Bearer token)
- [ ] Response format: `{ "data": { "total_credits": number, "used_credits": number, "reset_date": ISO8601_timestamp } }`
- [ ] Calculate `percentUsed = (used_credits / total_credits) * 100`
- [ ] Support daily and monthly windows (labels: "Daily", "Monthly")
- [ ] Handle auth errors (401/403) with "Auth expired" message
- [ ] Add icon: "🟡" (yellow circle emoji)
- [ ] Update `fetchAllProviderUsage()` to include both new providers in Promise.allSettled
- [ ] Update cache size expectation in tests (now 5 providers instead of 3)
- [ ] Run backend tests: `pnpm test --filter @kb/dashboard -- --testPathPattern=usage`

**Artifacts:**
- `packages/dashboard/src/usage.ts` (modified - add fetchZaiUsage function, update main export)

### Step 3: Add Pace Calculation to UsageWindow

- [ ] Add optional `pace` field to `UsageWindow` interface in `packages/dashboard/app/api.ts`
  ```typescript
  pace?: {
    status: "ahead" | "on-track" | "behind";  // ahead = using faster than time elapsed
    percentElapsed: number;  // 0-100, how much of the window time has passed
    message: string;  // e.g., "Using 15% over your limit pace"
  }
  ```
- [ ] Add pace calculation helper in `packages/dashboard/src/usage.ts`:
  ```typescript
  function calculatePace(percentUsed: number, resetMs: number | undefined, windowDurationMs: number | undefined)
  ```
- [ ] Logic: If resetMs and windowDurationMs exist, `percentElapsed = 100 - (resetMs / windowDurationMs * 100)`
- [ ] Compare percentUsed vs percentElapsed:
  - `percentUsed > percentElapsed + 10%` → status: "ahead", message: "Using X% over pace"
  - `percentUsed < percentElapsed - 10%` → status: "behind", message: "Using X% under pace"
  - Otherwise → status: "on-track", message: "On pace with time elapsed"
- [ ] Apply pace calculation to weekly windows in Claude, Codex, and new providers
- [ ] Run backend tests to verify calculations

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified - add pace field to UsageWindow)
- `packages/dashboard/src/usage.ts` (modified - add calculatePace helper)

### Step 4: Frontend Pace Indicator UI

- [ ] Add `PaceIndicator` component in `UsageIndicator.tsx` (internal component, below UsageWindowRow)
- [ ] Display pace indicator only when `window.pace` is defined
- [ ] Visual design:
  - Status "ahead": Red warning icon (TrendingUp from lucide-react) + red text "⚠️ Using X% over pace"
  - Status "on-track": Green check icon (CheckCircle) + green text "✓ On pace"
  - Status "behind": Blue info icon (Info) + blue text "ℹ️ Using X% under pace"
- [ ] Position pace indicator below the progress bar in each `UsageWindowRow`
- [ ] Use existing CSS classes pattern: `pace-indicator`, `pace-indicator--ahead`, `pace-indicator--on-track`, `pace-indicator--behind`
- [ ] Update tests to verify pace indicator renders correctly for each status

**Artifacts:**
- `packages/dashboard/app/components/UsageIndicator.tsx` (modified - add PaceIndicator component)

### Step 5: Add CSS Styles for Pace Indicators

- [ ] Add to `packages/dashboard/app/styles.css` (or relevant CSS file):
  ```css
  .pace-indicator {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    margin-top: 4px;
  }
  .pace-indicator--ahead { color: var(--color-error, #ef4444); }
  .pace-indicator--on-track { color: var(--color-success, #22c55e); }
  .pace-indicator--behind { color: var(--color-info, #3b82f6); }
  ```
- [ ] Ensure CSS variables fallback to standard colors if not defined

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified - add pace indicator styles)

### Step 6: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Verify all usage tests pass: `pnpm test --filter @kb/dashboard -- --testPathPattern=usage`
- [ ] Verify all UsageIndicator tests pass: `pnpm test --filter @kb/dashboard -- --testPathPattern=UsageIndicator`
- [ ] Verify build passes: `pnpm build`
- [ ] Manual verification steps (documented for testing):
  - Mock Minimax credentials and verify provider appears in usage modal
  - Mock Zai credentials and verify provider appears in usage modal
  - Test pace indicator displays correctly for each status type

### Step 7: Documentation & Delivery

- [ ] Update `AGENTS.md` if there are new provider-specific instructions (optional)
- [ ] Create changeset file for the new feature:
  ```bash
  cat > .changeset/add-usage-pace-and-providers.md << 'EOF'
  ---
  "@dustinbyrne/kb": minor
  ---
  
  Add weekly pace indicators to usage dropdown and support Minimax and Zai AI providers.
  EOF
  ```
- [ ] Commit changes following convention: `feat(KB-152): add pace indicators and Minimax/Zai providers`

## Documentation Requirements

**Must Update:**
- None (internal dashboard feature)

**Check If Affected:**
- `AGENTS.md` — Add notes about testing provider integrations if relevant

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test` returns 0 failures)
- [ ] Build passes (`pnpm build` succeeds)
- [ ] Usage indicator shows pace for weekly windows when data available
- [ ] Minimax provider appears in usage modal when credentials configured
- [ ] Zai provider appears in usage modal when credentials configured
- [ ] Changeset file created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-152): complete Step N — description`
- **Bug fixes:** `fix(KB-152): description`
- **Tests:** `test(KB-152): description`

Example commits:
- `feat(KB-152): complete Step 1 — add Minimax provider backend`
- `feat(KB-152): complete Step 4 — add pace indicator UI component`
- `test(KB-152): add tests for Zai provider error handling`

## Do NOT

- Expand scope to include other providers beyond Minimax and Zai
- Modify the existing Claude/Codex/Gemini fetcher implementations (only add pace calculation)
- Add pace indicators to non-weekly windows (daily/session windows don't need pacing)
- Change the existing usage modal layout significantly - keep the same card structure
- Skip tests for the new providers
- Use real API credentials in tests (always mock)
