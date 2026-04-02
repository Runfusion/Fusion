# Task: KB-081 - Add Provider Icons in Model Selector Dropdown

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This task modifies the UI component structure, replacing native `<select>` with a custom dropdown to support icons. It requires visual changes and testing updates but is contained to a single component with limited blast radius.
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 0, Reversibility: 1

## Mission

Enhance the model selector dropdown in the dashboard by creating a custom dropdown component that supports:
1. Visual provider icons next to each provider name (Anthropic, OpenAI, Google, Ollama, etc.)
2. Integrated text filtering within the dropdown
3. Keyboard navigation and accessibility

This improves visual scanning and helps users quickly identify providers when selecting executor and validator models.

## Dependencies

- **None**
- **Note:** KB-080 describes a combined dropdown and text entry feature. If completed first, this task should build upon it. If not, this task includes creating the combined dropdown component.

## Context to Read First

- `packages/dashboard/app/components/ModelSelectorTab.tsx` — The component that displays model selectors (currently uses native `<select>` elements)
- `packages/dashboard/app/components/__tests__/ModelSelectorTab.test.tsx` — Existing tests for the model selector
- `packages/dashboard/app/utils/modelFilter.ts` — Filter logic for models (provider, id, name matching)
- `packages/dashboard/app/api.ts` — Contains `ModelInfo` interface with `provider` field
- `packages/dashboard/app/styles.css` — Look for existing `.form-group select` styling patterns (lines 751-785)
- `packages/dashboard/app/components/__tests__/Column.test.tsx` — Reference for mocking lucide-react: `vi.mock("lucide-react", () => ({ ... }))`

## File Scope

- `packages/dashboard/app/components/ModelSelectorTab.tsx` (modified)
- `packages/dashboard/app/components/ProviderIcon.tsx` (new — icon component mapping providers to icons)
- `packages/dashboard/app/components/CustomModelDropdown.tsx` (new — custom dropdown with icon support and integrated filtering)
- `packages/dashboard/app/components/__tests__/ModelSelectorTab.test.tsx` (modified — update tests)
- `packages/dashboard/app/components/__tests__/CustomModelDropdown.test.tsx` (new — tests for custom dropdown)
- `packages/dashboard/app/components/__tests__/ProviderIcon.test.tsx` (new — tests for icon component)
- `packages/dashboard/app/styles.css` (modified — add styles for custom dropdown with icons)

## Steps

### Step 1: Create ProviderIcon Component

Create a reusable component that maps provider IDs to visual icons. Use Lucide icons as fallbacks for unknown providers.

- [ ] Create `packages/dashboard/app/components/ProviderIcon.tsx`
- [ ] Map known providers to specific icons from lucide-react:
  - `anthropic` → `Brain` icon
  - `openai` → `Sparkles` icon
  - `google` or `gemini` → `Search` icon  
  - `ollama` → `Terminal` icon
  - Default/fallback → `Cpu` icon for unknown providers
- [ ] Support size variants: `sm` (16px), `md` (20px), `lg` (24px)
- [ ] Export `ProviderIcon` component with props: `provider: string`, `size?: 'sm' | 'md' | 'lg'`
- [ ] Icons should be colored using provider-specific colors:
  - Anthropic: `#d4a27f` (warm tan)
  - OpenAI: `#10a37f` (green)
  - Google: `#4285f4` (blue)
  - Ollama: `#fff` (white)
  - Unknown: `var(--text-muted)`
- [ ] Write tests in `packages/dashboard/app/components/__tests__/ProviderIcon.test.tsx`
- [ ] Mock lucide-react in tests following existing pattern (see `Column.test.tsx`)

**Artifacts:**
- `packages/dashboard/app/components/ProviderIcon.tsx` (new)
- `packages/dashboard/app/components/__tests__/ProviderIcon.test.tsx` (new)

### Step 2: Create CustomModelDropdown Component

Build a custom dropdown component that combines text filtering with icon-enhanced model selection, replacing the native `<select>` element.

- [ ] Create `packages/dashboard/app/components/CustomModelDropdown.tsx`
- [ ] Props interface:
  - `models: ModelInfo[]` — full list of available models
  - `value: string` — current selection (format: `"provider/id"` or empty)
  - `onChange: (value: string) => void` — selection callback
  - `placeholder?: string` — default option text (default: "Use default")
  - `disabled?: boolean` — disable interaction
  - `id?: string` — for accessibility labels
- [ ] Component features:
  - Text input at top for filtering (integrated, not separate)
  - Dropdown menu showing grouped models by provider
  - Provider icon displayed next to provider group headers
  - Provider icon displayed next to currently selected value in trigger
  - "Use default" option at top with no icon
- [ ] Use `filterModels()` utility from `app/utils/modelFilter.ts` for filtering logic
- [ ] Group models by provider using `useMemo` (same logic pattern as current `ModelSelectorTab`)
- [ ] Keyboard navigation support:
  - `ArrowDown` / `ArrowUp` — navigate through options
  - `Enter` — select highlighted option
  - `Escape` — close dropdown
  - `Tab` — close dropdown and move focus
- [ ] Proper ARIA attributes:
  - `role="combobox"` on trigger
  - `role="listbox"` on dropdown menu
  - `aria-expanded` on trigger
  - `aria-selected` on options
  - `aria-label` referencing the label via `id`
- [ ] Click outside to close dropdown
- [ ] Write comprehensive tests in `packages/dashboard/app/components/__tests__/CustomModelDropdown.test.tsx`

**Artifacts:**
- `packages/dashboard/app/components/CustomModelDropdown.tsx` (new)
- `packages/dashboard/app/components/__tests__/CustomModelDropdown.test.tsx` (new)

### Step 3: Update ModelSelectorTab to Use Custom Dropdown

Replace the native `<select>` elements and separate filter inputs with the new `CustomModelDropdown` component.

- [ ] Import `CustomModelDropdown` and `ProviderIcon` in `ModelSelectorTab.tsx`
- [ ] Remove the separate filter input divs (`.model-selector-filter`) for both executor and validator
- [ ] Replace executor model `<select>` with `<CustomModelDropdown>`
  - Pass `filteredExecutorModels` as `models` prop
  - Pass `executorValue` as `value` prop
  - Pass `handleExecutorChange` as `onChange` prop
  - Pass `id="executorModel"` for accessibility
- [ ] Replace validator model `<select>` with `<CustomModelDropdown>`
  - Pass `filteredValidatorModels` as `models` prop  
  - Pass `validatorValue` as `value` prop
  - Pass `handleValidatorChange` as `onChange` prop
  - Pass `id="validatorModel"` for accessibility
- [ ] Remove `executorFilter`, `setExecutorFilter`, `validatorFilter`, `setValidatorFilter` state (now handled in CustomModelDropdown)
- [ ] Remove `filteredExecutorModels` and `filteredValidatorModels` memo (filtering now happens in CustomModelDropdown)
- [ ] Remove `executorModelsByProvider` and `validatorModelsByProvider` memo (grouping now happens in CustomModelDropdown)
- [ ] Update the current selection badges (`.model-selector-current`) to show `ProviderIcon` next to the provider name
- [ ] Remove `.model-selector-filter` and `.model-selector-no-results` CSS classes from component
- [ ] Verify the "Use default" option still works correctly (empty string value)
- [ ] Run targeted tests for ModelSelectorTab

**Artifacts:**
- `packages/dashboard/app/components/ModelSelectorTab.tsx` (modified)

### Step 4: Add CSS Styles for Custom Dropdown

Add styles to `styles.css` for the custom dropdown component with provider icons. Match existing form element styling patterns.

- [ ] Add `.custom-dropdown` container styles:
  - `position: relative`, `width: 100%`
  - Same font-size as existing select (14px)
- [ ] Add `.custom-dropdown-trigger` styles:
  - Match `.form-group select` styling (padding, background, border, border-radius)
  - Display as flex with icon and text
  - Cursor: pointer
  - Maintain `appearance: none` with custom arrow (match existing SVG arrow pattern)
- [ ] Add `.custom-dropdown-menu` styles:
  - `position: absolute`, `top: 100%`, `left: 0`, `right: 0`
  - `z-index: 100` (above modal overlay)
  - `max-height: 280px`, `overflow-y: auto`
  - Background: `var(--bg)`, border: `1px solid var(--border)`
  - Border-radius: `var(--radius)`
  - Box-shadow: `var(--shadow)`
- [ ] Add `.custom-dropdown-filter` styles for the filter input:
  - Sticky at top of dropdown menu
  - Padding, border-bottom separating from options
- [ ] Add `.custom-dropdown-optgroup` styles:
  - Padding, background: `var(--surface)`
  - Display flex with icon and provider name
  - Font-weight: 600, color: `var(--text-muted)`
  - Uppercase text transform, letter-spacing
- [ ] Add `.custom-dropdown-option` styles:
  - Padding-left (indented under provider group)
  - Hover background: `var(--card-hover)`
  - Selected state: background with `var(--todo)` tint
- [ ] Add `.custom-dropdown-icon` styles:
  - `display: inline-flex`, `margin-right: 8px`
  - Vertical alignment: middle
- [ ] Add `.custom-dropdown-results-count` styles (for showing "X models")
  - Small text, muted color, right-aligned in filter area
- [ ] Ensure all colors use CSS variables for theme compatibility

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified — add custom dropdown styles)

### Step 5: Update ModelSelectorTab Tests

Update existing tests to work with the new custom dropdown component.

- [ ] Mock `ProviderIcon` component in tests:
  ```typescript
  vi.mock("../ProviderIcon", () => ({
    ProviderIcon: ({ provider }: { provider: string }) => (
      <span data-testid={`provider-icon-${provider}`} />
    ),
  }));
  ```
- [ ] Mock `CustomModelDropdown` or render it fully with mocked sub-components
- [ ] Update test selectors:
  - Replace `screen.getByLabelText("Executor Model")` with appropriate queries for custom dropdown
  - Use `data-testid` attributes on CustomModelDropdown for reliable selection
- [ ] Update test "groups models by provider in select options" → verify provider headers render with icons in dropdown
- [ ] Update test "filters executor models by provider name" → verify filtering works within CustomModelDropdown
- [ ] Update test "clear button clears filter and restores full list" → verify clear button in CustomModelDropdown
- [ ] Update test "shows empty state message when filter matches nothing" → verify no results state in CustomModelDropdown
- [ ] Add new test: "displays provider icon next to current selection in badge"
- [ ] Add new test: "custom dropdown opens on trigger click and shows provider groups with icons"
- [ ] Add new test: "keyboard navigation works in custom dropdown (arrow keys, enter, escape)"
- [ ] Remove tests for removed functionality (separate filter inputs, native select behavior)
- [ ] Ensure all tests pass with `pnpm test`

**Artifacts:**
- `packages/dashboard/app/components/__tests__/ModelSelectorTab.test.tsx` (modified)

### Step 6: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` in `packages/dashboard` — all tests must pass
- [ ] Run `pnpm typecheck` — no TypeScript errors
- [ ] Run `pnpm build` — build must succeed without errors
- [ ] Manual verification checklist:
  - [ ] Provider icons appear next to provider names in dropdown groups
  - [ ] Provider icon appears in current selection badge
  - [ ] Filter input works within dropdown (type to filter models)
  - [ ] "Use default" option works correctly
  - [ ] Selecting a model saves correctly via API
  - [ ] Keyboard navigation works (ArrowUp/Down, Enter, Escape)
  - [ ] Click outside closes dropdown
  - [ ] Screen reader announces options correctly (test with VoiceOver or NVDA)
- [ ] Verify no visual regressions in existing UI (other select elements unchanged)

### Step 7: Documentation & Delivery

- [ ] Create changeset for UI enhancement (`.changeset/add-provider-icons.md`):
  ```markdown
  ---
  "@dustinbyrne/kb": minor
  ---
  
  Add provider icons to model selector dropdown for improved visual identification of AI providers. Replaces native select with custom dropdown component featuring integrated filtering and keyboard navigation.
  ```
- [ ] Check `AGENTS.md` — no update needed unless there's a UI documentation section
- [ ] If KB-080 is completed concurrently, verify no conflicts in `ModelSelectorTab.tsx`

**Artifacts:**
- `.changeset/add-provider-icons.md` (new)

## Documentation Requirements

**Must Update:**
- None required (self-documenting UI enhancement)

**Check If Affected:**
- `AGENTS.md` — update if there's a section documenting the model selector behavior

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test` in dashboard package)
- [ ] Build passes (`pnpm build`)
- [ ] Provider icons visible next to provider names in dropdown
- [ ] Current selection badge shows provider icon
- [ ] Integrated filter working within dropdown
- [ ] Keyboard navigation functional
- [ ] ARIA accessibility attributes present
- [ ] No visual regressions in existing UI

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-081): complete Step N — description`
- **Bug fixes:** `fix(KB-081): description`
- **Tests:** `test(KB-081): description`

Example commits:
- `feat(KB-081): complete Step 1 — create ProviderIcon component with provider mappings`
- `feat(KB-081): complete Step 2 — build CustomModelDropdown with icon and filter support`
- `feat(KB-081): complete Step 3 — integrate custom dropdown into ModelSelectorTab`
- `test(KB-081): update ModelSelectorTab tests for custom dropdown`
- `feat(KB-081): complete Step 7 — add changeset and documentation`

## Do NOT

- Expand scope to redesign the entire settings UI
- Skip tests or reduce test coverage
- Use external icon libraries beyond lucide-react (already a dependency)
- Hardcode provider-specific logic outside of ProviderIcon component
- Modify the model data structure or API endpoints
- Break keyboard accessibility of the dropdown
- Skip ARIA attributes for screen readers
- Commit without the KB-081 prefix
- Leave the separate filter inputs alongside the integrated filter (fully replace them)
