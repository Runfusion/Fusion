# Task: KB-153 - Usage Dropdown Toggle and Real Provider Icons

**Created:** 2026-03-30
**Size:** S

## Review Level: 2 (Plan and Code)

**Assessment:** This task involves UI enhancements to the existing usage indicator - adding a view toggle and integrating SVG provider icons. Low blast radius as it only modifies the existing UsageIndicator component without backend changes.

**Score:** 4/8 — Blast radius: 1, Pattern novelty: 1, Security: 0, Reversibility: 2

## Mission

Enhance the dashboard's usage indicator modal with two UX improvements:

1. **Usage View Toggle**: Add a toggle switch that allows users to switch between viewing "remaining" (percentLeft) vs "used" (percentUsed) percentages in the usage windows. The toggle should persist the user's preference in localStorage.

2. **Real Provider Icons**: Replace the emoji-based provider icons (🟠, 🟢, 🔵) with actual SVG icons from the existing `ProviderIcon` component. This provides a more polished, professional appearance.

These changes improve the usability and visual polish of the usage monitoring feature.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/UsageIndicator.tsx` - Main usage indicator component (read current implementation)
- `packages/dashboard/app/components/ProviderIcon.tsx` - Provider icon component with SVG icons for Anthropic, OpenAI, Gemini, Ollama
- `packages/dashboard/app/api.ts` - Type definitions for `ProviderUsage` and `UsageWindow`
- `packages/dashboard/app/styles.css` - CSS classes for usage indicator styling
- `packages/dashboard/app/components/UsageIndicator.test.tsx` - Existing test patterns

## File Scope

### Frontend Components
- `packages/dashboard/app/components/UsageIndicator.tsx` - Add toggle UI and integrate ProviderIcon
- `packages/dashboard/app/components/UsageIndicator.test.tsx` - Add tests for toggle functionality and icon rendering

### Styles
- `packages/dashboard/app/styles.css` - Add CSS classes for the toggle switch and updated icon styling

## Steps

### Step 1: Add Usage View Toggle to UsageWindowRow

- [ ] Add a new `viewMode` prop to `UsageWindowRow` component: type `'used' | 'remaining'`
- [ ] Modify `UsageWindowRow` to display different percentages based on view mode:
  - When `viewMode='used'`: Show "X% used" text and use `percentUsed` for the progress bar width
  - When `viewMode='remaining'`: Show "X% remaining" text and use `percentLeft` for the progress bar width
- [ ] The progress bar color should remain based on `percentUsed` (the actual usage level) regardless of view mode
- [ ] Update the footer text to match the view mode: "X% left" vs "X% used" (inverse of the header)
- [ ] Run existing tests to ensure no regressions: `pnpm test --filter @kb/dashboard -- --testPathPattern=UsageIndicator`

**Artifacts:**
- `packages/dashboard/app/components/UsageIndicator.tsx` (modified - UsageWindowRow component)

### Step 2: Add Global Toggle Control to UsageIndicator Modal

- [ ] Add local state for `viewMode` in `UsageIndicator` component using `useState<'used' | 'remaining'>`
- [ ] On component mount, read initial preference from `localStorage.getItem('kb-usage-view-mode')` (defaults to 'used')
- [ ] Add a toggle switch in the modal header area (next to the "Usage" title or in the actions bar)
- [ ] Toggle design:
  - Use a segmented control or switch pattern with labels "Used" and "Remaining"
  - Active state should be visually distinct
  - Position in header area for easy access
- [ ] When toggle changes, update state and persist to `localStorage.setItem('kb-usage-view-mode', mode)`
- [ ] Pass the current `viewMode` to all `UsageWindowRow` instances
- [ ] Run tests: `pnpm test --filter @kb/dashboard -- --testPathPattern=UsageIndicator`

**Artifacts:**
- `packages/dashboard/app/components/UsageIndicator.tsx` (modified - UsageIndicator component)

### Step 3: Integrate Real Provider Icons

- [ ] Import `ProviderIcon` component in `UsageIndicator.tsx`
- [ ] Create a mapping function to map provider names to ProviderIcon provider keys:
  - "Claude" → "anthropic"
  - "Codex" → "openai" (Codex is OpenAI's product)
  - "Gemini" → "google" (Gemini is Google's product)
- [ ] Replace the emoji icon span in `ProviderCard` with the `ProviderIcon` component:
  ```tsx
  <ProviderIcon provider={mappedProviderName} size="md" />
  ```
- [ ] Remove the emoji `icon` field usage from the provider display (keep it in the type for backward compatibility)
- [ ] Ensure proper alignment and sizing of SVG icons within the provider card header
- [ ] Run tests: `pnpm test --filter @kb/dashboard -- --testPathPattern=UsageIndicator`

**Artifacts:**
- `packages/dashboard/app/components/UsageIndicator.tsx` (modified - ProviderCard component)

### Step 4: Add CSS Styles for Toggle and Icons

- [ ] Add CSS classes for the view mode toggle:
  ```css
  .usage-view-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--bg-secondary, var(--border));
    padding: 4px;
    border-radius: 6px;
  }
  .usage-view-toggle-btn {
    padding: 4px 10px;
    border-radius: 4px;
    font-size: 12px;
    font-weight: 500;
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    transition: all 0.2s ease;
  }
  .usage-view-toggle-btn:hover {
    color: var(--text);
  }
  .usage-view-toggle-btn.active {
    background: var(--bg-primary, var(--todo));
    color: var(--text);
  }
  ```
- [ ] Update `.usage-provider-icon` styles if needed to accommodate SVG icons:
  - Ensure proper vertical alignment with text
  - Maintain existing spacing
- [ ] Ensure toggle is responsive and fits within the modal header on mobile

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified - add toggle and icon styles)

### Step 5: Update Tests

- [ ] Add tests for the view mode toggle:
  - Test that toggle buttons render with correct initial state
  - Test that clicking toggle switches view mode
  - Test that localStorage is read on mount and written on change
  - Test that UsageWindowRow displays correct percentages in each mode
- [ ] Add tests for ProviderIcon integration:
  - Test that Claude provider uses anthropic icon
  - Test that Codex provider uses openai icon
  - Test that Gemini provider uses google icon
- [ ] Update any existing tests that assert on emoji icons
- [ ] Run full test suite: `pnpm test --filter @kb/dashboard -- --testPathPattern=UsageIndicator`

**Artifacts:**
- `packages/dashboard/app/components/UsageIndicator.test.tsx` (modified - new test cases)

### Step 6: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Verify all UsageIndicator tests pass: `pnpm test --filter @kb/dashboard -- --testPathPattern=UsageIndicator`
- [ ] Verify build passes: `pnpm build`
- [ ] Manual verification checklist:
  - [ ] Toggle switch appears in usage modal header
  - [ ] Clicking "Used" shows percentage used in progress bars
  - [ ] Clicking "Remaining" shows percentage remaining in progress bars
  - [ ] Progress bar colors remain correct (based on actual usage level)
  - [ ] Preference persists across modal close/reopen
  - [ ] Claude shows Anthropic icon (diamond A)
  - [ ] Codex shows OpenAI icon (spiral)
  - [ ] Gemini shows Google/Gemini icon (sparkle)
  - [ ] Provider cards align correctly with SVG icons

### Step 7: Documentation & Delivery

- [ ] Create changeset file for the enhancement:
  ```bash
  cat > .changeset/usage-toggle-and-icons.md << 'EOF'
  ---
  "@dustinbyrne/kb": patch
  ---
  
  Add usage view toggle (used/remaining) and real provider icons to usage dropdown.
  EOF
  ```
- [ ] Commit changes following convention: `feat(KB-153): add usage view toggle and real provider icons`

## Documentation Requirements

**Must Update:**
- None (internal dashboard feature)

**Check If Affected:**
- None

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test` returns 0 failures)
- [ ] Build passes (`pnpm build` succeeds)
- [ ] Usage indicator shows toggle for switching between "Used" and "Remaining" views
- [ ] View preference persists in localStorage
- [ ] Provider icons display as SVG instead of emoji
- [ ] Changeset file created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-153): complete Step N — description`
- **Bug fixes:** `fix(KB-153): description`
- **Tests:** `test(KB-153): description`

Example commits:
- `feat(KB-153): complete Step 1 — add view mode prop to UsageWindowRow`
- `feat(KB-153): complete Step 2 — add global toggle control with localStorage persistence`
- `feat(KB-153): complete Step 3 — integrate ProviderIcon component`
- `test(KB-153): add tests for view mode toggle and icon rendering`

## Do NOT

- Modify backend usage.ts or API types (ProviderUsage interface with icon field must remain for compatibility)
- Change the data structure sent from backend to frontend
- Remove the emoji icon field from the API types (just stop rendering it)
- Expand scope to include other UI changes to the usage modal
- Use external icon libraries (use the existing ProviderIcon component only)
- Skip tests for the toggle functionality
- Break existing test assertions without updating them
