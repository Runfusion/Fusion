# Task: KB-061 - Add Type-to-Filter to Model Selection Dialogues

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a focused UI enhancement adding a search filter to existing model selection dropdowns. It uses established patterns already present in the codebase (dependency selector has similar filtering) and only touches two components.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 1, Security: 0, Reversibility: 1

## Mission

Add a type-to-filter search input to the model selection dropdowns in the dashboard. Currently, the model selectors use native `<select>` elements with provider optgroups, which becomes unwieldy as the list of available models grows. Users need a way to quickly find models by typing to filter the list by provider name, model ID, or display name.

This enhancement applies to all model selection UI:
1. **ModelSelectorTab** (per-task model overrides in task detail modal)
2. **SettingsModal** (default model selection in the Model settings section)
3. **InlineCreateCard** (KB-060 adds model selection during task creation — coordinate if needed)

The filter should work in real-time as the user types, matching against:
- Provider name (e.g., "anthropic", "openai")
- Model ID (e.g., "claude-sonnet-4-5", "gpt-4o")
- Model display name (e.g., "Claude Sonnet 4.5")

Case-insensitive matching with substring search is sufficient.

## Dependencies

- **None**
- **Note:** KB-060 (Add Model Selection to New Task Creation) is in progress. If it lands first, this task should also update InlineCreateCard. If this lands first, KB-060 should follow this pattern. Coordinate via `task_get` on KB-060 to see current status.

## Context to Read First

- `packages/dashboard/app/components/ModelSelectorTab.tsx` — Current model selection UI using `<select>` with optgroups
- `packages/dashboard/app/components/SettingsModal.tsx` — Model selection in Settings → Model section (see `case "model"` around line 195)
- `packages/dashboard/app/components/InlineCreateCard.tsx` — If KB-060 is complete, read this for the third location
- `packages/dashboard/app/styles.css` — Styling patterns, especially `.dep-dropdown-search` which implements similar search filtering
- `packages/dashboard/app/api.ts` — `ModelInfo` interface to understand model data structure
- `packages/dashboard/app/components/__tests__/ModelSelectorTab.test.tsx` — Existing test patterns
- `packages/dashboard/app/components/__tests__/SettingsModal.test.tsx` — Existing test patterns

## File Scope

- `packages/dashboard/app/components/ModelSelectorTab.tsx` — Add filter input and filtering logic
- `packages/dashboard/app/components/SettingsModal.tsx` — Add filter input and filtering logic in Model section
- `packages/dashboard/app/components/InlineCreateCard.tsx` — Add filter input if KB-060 is already merged
- `packages/dashboard/app/styles.css` — Add styles for model selector search input (reuse patterns from dep-dropdown-search)
- `packages/dashboard/app/components/__tests__/ModelSelectorTab.test.tsx` — Add tests for filtering
- `packages/dashboard/app/components/__tests__/SettingsModal.test.tsx` — Add tests for filtering

## Steps

### Step 1: Preflight

- [ ] Required files and paths exist
- [ ] Dependencies satisfied (check KB-060 status)
- [ ] Run existing tests to confirm baseline: `pnpm --filter @kb/dashboard test` — all should pass

### Step 2: Build Filtered Model Selector Component

Create a reusable pattern for filtered model selection that can be applied in both locations.

- [ ] Add filter state to ModelSelectorTab:
  - `executorFilter: string` — current filter text for executor model
  - `validatorFilter: string` — current filter text for validator model
- [ ] Build filtered model list function:
  ```typescript
  function filterModels(models: ModelInfo[], filter: string): ModelInfo[] {
    const terms = filter.toLowerCase().trim().split(/\s+/);
    return models.filter(m => {
      const haystack = `${m.provider} ${m.id} ${m.name}`.toLowerCase();
      return terms.every(term => haystack.includes(term));
    });
  }
  ```
- [ ] Add search input above each `<select>` in ModelSelectorTab:
  - Place input inside `.form-group`, above the select
  - Use styling pattern from `.dep-dropdown-search` (see styles.css)
  - Placeholder text: "Filter models…"
  - Clear button (×) appears when filter has text
  - Show result count badge: "3 models" next to clear button
- [ ] Connect filter state to select options — filtered list updates in real-time
- [ ] Handle empty filter results: show "No models match 'xyz'" message below select
- [ ] Preserve "Use default" option at top regardless of filter
- [ ] Apply same pattern to both Executor and Validator selectors

**Artifacts:**
- `packages/dashboard/app/components/ModelSelectorTab.tsx` (modified)

### Step 3: Apply Filter to SettingsModal

- [ ] Add filter state to SettingsModal's model section:
  - `modelFilter: string` — current filter text for default model selection
- [ ] Reuse the same `filterModels` function (consider extracting to a shared utility if not already done)
- [ ] Add search input above the default model `<select>`
- [ ] Apply same styling and behaviors as ModelSelectorTab
- [ ] Show empty state message when filter yields no results

**Artifacts:**
- `packages/dashboard/app/components/SettingsModal.tsx` (modified)

### Step 4: Add CSS Styles

- [ ] Add `.model-selector-filter` class for the filter input container:
  - Margin-bottom: 8px
  - Position relative (for clear button positioning)
- [ ] Add `.model-selector-filter-input` class:
  - Same styling as `.dep-dropdown-search` (sticky, full width, bottom border)
  - Use existing CSS variables for colors
- [ ] Add `.model-selector-filter-clear` class for clear button:
  - Position absolute right
  - Background none, border none, cursor pointer
  - Color var(--text-muted), hover var(--text)
- [ ] Add `.model-selector-results-count` class for result count badge:
  - Small text, muted color
  - Positioned next to clear button or below input
- [ ] Add `.model-selector-no-results` class for empty state:
  - Padding, muted color
  - Italic style
- [ ] Ensure responsive styles for mobile (input stays usable on narrow screens)

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Add tests to `ModelSelectorTab.test.tsx`:
  - Test filter input renders for both executor and validator selectors
  - Test typing in filter updates the filtered model list
  - Test filter matches provider, id, and name fields
  - Test multi-word filter (space-separated terms)
  - Test "Use default" option remains visible regardless of filter
  - Test clear button clears filter and restores full list
  - Test empty state message appears when filter matches nothing
  - Test selecting a model from filtered list works correctly
- [ ] Add tests to `SettingsModal.test.tsx`:
  - Test filter input renders in Model section
  - Test filtering updates the default model select options
  - Test clear button functionality
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`
- [ ] Manual verification: Open Model tab in task detail, type "claude" — only anthropic models should appear

**Artifacts:**
- `packages/dashboard/app/components/__tests__/ModelSelectorTab.test.tsx` (modified)
- `packages/dashboard/app/components/__tests__/SettingsModal.test.tsx` (modified)

### Step 6: Documentation & Delivery

- [ ] Create changeset file:
  ```bash
  cat > .changeset/add-model-filter-search.md << 'EOF'
  ---
  "@dustinbyrne/kb": patch
  ---
  
  Add type-to-filter search to model selection dropdowns. Users can now quickly find AI models by typing to filter by provider, model ID, or name.
  EOF
  ```
- [ ] Out-of-scope findings: If KB-060 hasn't landed, create a follow-up task via `task_create` to apply this filter pattern to InlineCreateCard

**Artifacts:**
- `.changeset/add-model-filter-search.md` (new)

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Filter works in ModelSelectorTab (both executor and validator selectors)
- [ ] Filter works in SettingsModal (default model selector)
- [ ] Filter is case-insensitive and matches provider, id, or name
- [ ] "Use default" option always visible regardless of filter
- [ ] Clear button resets filter
- [ ] Empty state shown when no matches
- [ ] UI matches existing design patterns (dependency search as reference)
- [ ] Changeset file included

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-061): complete Step N — description`
- **Bug fixes:** `fix(KB-061): description`
- **Tests:** `test(KB-061): description`

## Do NOT

- Replace the native `<select>` with a custom dropdown component (keep it simple)
- Implement complex search features like fuzzy matching or ranking (substring is sufficient)
- Modify the ModelInfo interface or API
- Skip tests for the filtering functionality
- Break existing optgroup organization (keep provider grouping)
- Remove or change keyboard navigation of the select element
- Expand scope to redesign the entire model selection UI
