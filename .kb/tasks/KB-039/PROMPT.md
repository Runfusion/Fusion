# Task: KB-039 - Add Usage Indicator to Dashboard Header

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This feature introduces new UI components, API endpoints, and third-party API integrations. It requires careful planning for provider authentication handling, rate limiting, and mobile responsiveness. Pattern novelty is moderate (follows existing modal/popover patterns but with new data sources). Security considerations around token handling and API calls.
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 2, Reversibility: 1

## Mission

Add a usage indicator feature accessible from the dashboard header that displays subscription usage from multiple AI providers (Anthropic Claude, OpenAI Codex, Google Gemini, and others). The indicator shows hourly and weekly usage windows with percentage bars, reset timers, and pace indicators. The UI should be clean, use the existing dark theme, and be fully functional on mobile devices.

This feature helps users monitor their AI API consumption across providers to avoid hitting rate limits or quota caps during intensive kb task execution.

## Dependencies

- **None** — This is a standalone UI feature that adds new components and API endpoints.

## Context to Read First

1. `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/Header.tsx` — Current header implementation with icon buttons
2. `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/SettingsModal.tsx` — Modal pattern with sidebar navigation
3. `/Users/eclipxe/Projects/kb/packages/dashboard/app/api.ts` — API client patterns
4. `/Users/eclipxe/Projects/kb/packages/dashboard/src/routes.ts` — Backend route registration patterns (see `registerAuthRoutes`, `registerModelsRoute`)
5. `/Users/eclipxe/Projects/kb/packages/dashboard/app/styles.css` — CSS patterns, especially modal and mobile responsive styles
6. `/Users/eclipxe/.pi/agent/extensions/quota.ts` — Reference implementation for provider usage fetching (read for API patterns, not for code copying)

## File Scope

### New Files
- `packages/dashboard/app/components/UsageIndicator.tsx` — Main usage indicator modal component
- `packages/dashboard/app/components/UsageIndicator.test.tsx` — Component tests
- `packages/dashboard/app/hooks/useUsageData.ts` — Hook for fetching and polling usage data
- `packages/dashboard/app/hooks/useUsageData.test.ts` — Hook tests
- `packages/dashboard/src/usage.ts` — Backend provider usage fetching logic
- `packages/dashboard/src/usage.test.ts` — Backend tests

### Modified Files
- `packages/dashboard/app/components/Header.tsx` — Add usage indicator button
- `packages/dashboard/app/components/Header.test.tsx` — Add tests for usage button
- `packages/dashboard/app/api.ts` — Add `fetchUsageData()` API function
- `packages/dashboard/app/App.tsx` — Add usage indicator modal state and integration
- `packages/dashboard/src/routes.ts` — Add `/api/usage` endpoint
- `packages/dashboard/app/styles.css` — Add usage indicator styles (follow existing patterns)

## Steps

### Step 1: Backend API - Usage Endpoint

- [ ] Create `packages/dashboard/src/usage.ts` with provider usage fetching:
  - Define `ProviderUsage` interface with: `name`, `icon` (emoji), `status` ("ok" | "error" | "no-auth"), `windows` array
  - Define `UsageWindow` interface with: `label`, `percentUsed` (0-100), `percentLeft` (0-100), `resetText` (e.g., "resets in 2h"), `resetMs` (ms until reset)
  - Implement `fetchAllProviderUsage(authStorage)` that returns usage for configured providers
  - Support Anthropic (Claude) via OAuth API or CLI fallback
  - Support OpenAI (Codex) via auth.json if available
  - Support Google (Gemini) via OAuth if available
  - Return "no-auth" status gracefully for unconfigured providers
  - Implement caching with 30-second TTL to avoid API rate limits
- [ ] Create `packages/dashboard/src/usage.test.ts` with tests:
  - Test provider detection from auth storage
  - Test usage parsing for each provider
  - Test error handling for missing auth
  - Test caching behavior
- [ ] Add `/api/usage` GET route in `routes.ts`:
  - Returns `{ providers: ProviderUsage[] }`
  - 30-second server-side cache to prevent provider API abuse
  - Proper error handling for each provider (don't let one failure break all)

**Artifacts:**
- `packages/dashboard/src/usage.ts` (new)
- `packages/dashboard/src/usage.test.ts` (new)
- `packages/dashboard/src/routes.ts` (modified — add route)

### Step 2: Frontend API Client

- [ ] Add to `packages/dashboard/app/api.ts`:
  - `UsageWindow` and `ProviderUsage` type exports (mirror backend types)
  - `fetchUsageData(): Promise<{ providers: ProviderUsage[] }>` function
- [ ] Create `packages/dashboard/app/hooks/useUsageData.ts`:
  - Hook that fetches usage data on mount
  - Auto-refresh every 30 seconds when modal is open
  - Manual refresh capability
  - Loading and error states
- [ ] Create `packages/dashboard/app/hooks/useUsageData.test.ts`:
  - Test initial fetch
  - Test polling behavior
  - Test manual refresh
  - Test cleanup on unmount

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified)
- `packages/dashboard/app/hooks/useUsageData.ts` (new)
- `packages/dashboard/app/hooks/useUsageData.test.ts` (new)

### Step 3: Usage Indicator Component

- [ ] Create `packages/dashboard/app/components/UsageIndicator.tsx`:
  - Props: `isOpen`, `onClose`
  - Modal overlay following existing modal patterns (see `SettingsModal`)
  - Header with title "Usage" and close button
  - Provider cards arranged vertically:
    - Provider icon (emoji) + name on left
    - Auth status badge ("Connected", "Not configured", "Error")
    - For each usage window:
      - Window label (e.g., "Session (5h)", "Weekly")
      - Progress bar showing percentUsed (red if >90%, yellow if >70%, green otherwise)
      - Percentage text (e.g., "45% used")
      - Reset timer text (e.g., "resets in 2h 15m")
  - "Refresh" button at bottom to manually refresh
  - Loading skeleton while fetching
  - Error state per-provider (don't fail entire UI)
- [ ] Create `packages/dashboard/app/components/UsageIndicator.test.tsx`:
  - Test rendering with multiple providers
  - Test loading state
  - Test error handling
  - Test refresh button
  - Test close functionality
  - Test progress bar color coding

**Artifacts:**
- `packages/dashboard/app/components/UsageIndicator.tsx` (new)
- `packages/dashboard/app/components/UsageIndicator.test.tsx` (new)

### Step 4: Header Integration

- [ ] Update `packages/dashboard/app/components/Header.tsx`:
  - Add `onOpenUsage?: () => void` prop
  - Add usage icon button (use `Activity` icon from lucide-react) between view-toggle and import button
  - Title: "View usage"
  - Button styling consistent with other header buttons
- [ ] Update `packages/dashboard/app/components/Header.test.tsx`:
  - Test usage button renders when `onOpenUsage` provided
  - Test usage button does not render without handler
  - Test click calls `onOpenUsage`

**Artifacts:**
- `packages/dashboard/app/components/Header.tsx` (modified)
- `packages/dashboard/app/components/Header.test.tsx` (modified)

### Step 5: App Integration

- [ ] Update `packages/dashboard/app/App.tsx`:
  - Add `usageOpen` state
  - Add `handleOpenUsage` and `handleCloseUsage` callbacks
  - Pass `onOpenUsage` to Header component
  - Add `UsageIndicator` component with `isOpen={usageOpen}` and `onClose={handleCloseUsage}`
- [ ] Run component integration tests to verify modal opens/closes correctly

**Artifacts:**
- `packages/dashboard/app/App.tsx` (modified)

### Step 6: Styling

- [ ] Add usage indicator styles to `packages/dashboard/app/styles.css`:
  - `.usage-modal` — modal container (follow `.modal` pattern)
  - `.usage-provider` — provider card container
  - `.usage-provider-header` — name + status row
  - `.usage-window` — individual window row
  - `.usage-progress-bar` — progress bar styling
  - `.usage-progress-fill` — filled portion with color variants (--usage-high, --usage-medium, --usage-low)
  - `.usage-status-badge` — connected/not configured badges
  - Mobile responsive styles in `@media (max-width: 768px)` section
  - Use existing CSS variables: `--bg`, `--surface`, `--card`, `--border`, `--text`, `--text-muted`, `--color-success`, `--color-error`, `--triage` (for warning)

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 7: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run all tests: `pnpm test`
  - Dashboard tests must pass: `cd packages/dashboard && pnpm test`
  - New usage tests must pass
- [ ] Run build: `pnpm build`
  - Dashboard must build without errors
- [ ] Manual verification checklist:
  - [ ] Usage button appears in header
  - [ ] Clicking opens usage modal
  - [ ] Modal shows providers (configured and unconfigured)
  - [ ] Progress bars render with correct colors
  - [ ] Auto-refresh works every 30 seconds
  - [ ] Manual refresh button works
  - [ ] Modal closes with X button, Escape key, and overlay click
  - [ ] Mobile layout works correctly (full screen modal)

### Step 8: Documentation & Delivery

- [ ] Update `packages/dashboard/README.md` if it exists, or add inline documentation:
  - Document the usage indicator feature
  - Explain supported providers
- [ ] Create changeset: `.changeset/add-usage-indicator.md`
  ```
  ---
  "@dustinbyrne/kb": minor
  ---

  Add usage indicator to dashboard header showing AI provider subscription usage across multiple providers (Claude, Codex, Gemini). Displays hourly and weekly usage windows with pace indicators.
  ```

**Completion Criteria:**
- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Build passing (`pnpm build`)
- [ ] Changeset created
- [ ] Feature works on mobile and desktop

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-039): complete Step N — description`
- **Bug fixes:** `fix(KB-039): description`
- **Tests:** `test(KB-039): description`

## Do NOT

- Add backend dependencies without justification (use built-in `https` module)
- Store provider credentials in dashboard state (read from pi auth.json only)
- Make provider API calls more frequent than every 30 seconds
- Show raw API tokens in the UI
- Skip error handling for provider API failures
- Skip mobile responsive styling
- Add usage tracking for kb itself (this is for external AI providers only)
- Modify core package types unless absolutely necessary
