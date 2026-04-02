# Task: KB-314 - Add OpenAI Logo to Model Dropdown

**Created:** 2026-03-31
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** The OpenAI icon already exists in ProviderIcon.tsx and is used by CustomModelDropdown. This task verifies the integration works correctly and all provider icons display properly in the dropdown.
**Score:** 2/8 — Blast radius: 0 (localized to icon display), Pattern novelty: 0 (existing pattern), Security: 1 (UI consistency), Reversibility: 1 (safe to adjust)

## Mission

Ensure the OpenAI provider logo displays correctly in the model selection dropdown component. The OpenAI icon already exists in the `ProviderIcon` component (used successfully in the UsageIndicator activity monitor), but needs verification that it renders properly in the `CustomModelDropdown` trigger button and dropdown group headers. This task verifies the icon integration, ensures consistent styling, and adds appropriate test coverage.

## Dependencies

- **None**

## Context to Read First

1. `packages/dashboard/app/components/ProviderIcon.tsx` — Icon component with OpenAI SVG logo (lines 35-53)
2. `packages/dashboard/app/components/CustomModelDropdown.tsx` — Dropdown that uses ProviderIcon in trigger (line 193) and group headers (line 237)
3. `packages/dashboard/app/components/UsageIndicator.tsx` — Reference implementation showing OpenAI icon working correctly (line 176)
4. `packages/dashboard/app/components/__tests__/ProviderIcon.test.tsx` — Existing icon tests
5. `packages/dashboard/app/components/__tests__/CustomModelDropdown.test.tsx` — Dropdown tests (currently mocks ProviderIcon)

## File Scope

- `packages/dashboard/app/components/ProviderIcon.tsx` (verify OpenAI icon implementation)
- `packages/dashboard/app/components/CustomModelDropdown.tsx` (verify integration)
- `packages/dashboard/app/components/__tests__/CustomModelDropdown.test.tsx` (add unmocked icon rendering test)
- `packages/dashboard/app/styles.css` (verify icon styling if needed)

## Steps

### Step 1: Verify ProviderIcon Implementation

- [ ] Open `ProviderIcon.tsx` and confirm OpenAI icon is correctly defined:
  - `OpenAIIcon` component exists with proper SVG path (lines 35-53)
  - `openai` entry exists in `providerConfig` with color `#10a37f` (line 99)
  - Component handles lowercase provider name normalization
- [ ] Verify icon renders correctly by running ProviderIcon tests
- [ ] Confirm `data-testid="openai-icon"` and `aria-label="OpenAI"` attributes are present

**Artifacts:**
- `packages/dashboard/app/components/ProviderIcon.tsx` (verified)

### Step 2: Verify Dropdown Integration

- [ ] Open `CustomModelDropdown.tsx` and confirm ProviderIcon is used:
  - Line 193: `<ProviderIcon provider={currentProvider} size="sm" />` in trigger button
  - Line 237: `<ProviderIcon provider={provider} size="sm" />` in group headers
- [ ] Confirm `currentProvider` is correctly extracted from value prop (lines 56-60)
- [ ] Verify the dropdown imports ProviderIcon (line 7)

**Artifacts:**
- `packages/dashboard/app/components/CustomModelDropdown.tsx` (verified)

### Step 3: Add Integration Test for OpenAI Icon Rendering

The existing dropdown tests mock ProviderIcon. Add a test that verifies actual icon rendering:

- [ ] Add new test in `CustomModelDropdown.test.tsx` that:
  - Renders `CustomModelDropdown` with `value="openai/gpt-4o"` **without** mocking ProviderIcon
  - Verifies the OpenAI SVG icon is rendered in the trigger button
  - Opens the dropdown and verifies OpenAI icon appears in the provider group header
  - Uses `screen.getByTestId("openai-icon")` or `screen.getByLabelText("OpenAI")` to find the icon
- [ ] Run the new test and ensure it passes

**Code example for the test:**
```tsx
it("renders OpenAI icon in trigger when OpenAI model is selected", () => {
  render(<CustomModelDropdown {...defaultProps} value="openai/gpt-4o" />);
  expect(screen.getByTestId("openai-icon")).toBeInTheDocument();
  expect(screen.getByLabelText("OpenAI")).toBeInTheDocument();
});

it("renders OpenAI icon in dropdown group header", async () => {
  const user = userEvent.setup();
  render(<CustomModelDropdown {...defaultProps} />);
  await user.click(screen.getByLabelText("Test Model"));
  expect(screen.getByTestId("openai-icon")).toBeInTheDocument();
});
```

**Artifacts:**
- `packages/dashboard/app/components/__tests__/CustomModelDropdown.test.tsx` (modified)

### Step 4: Verify Styling Consistency

- [ ] Check CSS styles for provider icon display in dropdown:
  - `.model-combobox-trigger-icon` styles (line 5163 in styles.css)
  - `.model-combobox-optgroup` styles for group headers (line 5310)
  - `.model-badge-custom .provider-icon` styles (line 5024)
- [ ] Ensure icon color `#10a37f` (OpenAI green) displays correctly against dropdown background
- [ ] Verify icon sizing is consistent (`size="sm"` = 16px)

**Artifacts:**
- `packages/dashboard/app/styles.css` (verified)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run all dashboard tests: `cd packages/dashboard && pnpm test`
- [ ] Verify all ProviderIcon tests pass
- [ ] Verify all CustomModelDropdown tests pass
- [ ] Fix any test failures
- [ ] Run build: `pnpm build`
- [ ] Verify build passes with no errors

### Step 6: Documentation & Delivery

- [ ] No documentation updates required (UI enhancement, no user-facing feature change)
- [ ] Create changeset for the UI fix:
    ```bash
    cat > .changeset/add-openai-logo-dropdown.md << 'EOF'
    ---
    "@dustinbyrne/kb": patch
    ---
    
    Add OpenAI logo display to model selection dropdown
    EOF
    ```
- [ ] Include changeset in the final commit

## Completion Criteria

- [ ] OpenAI icon renders correctly in CustomModelDropdown trigger when OpenAI model is selected
- [ ] OpenAI icon renders correctly in dropdown provider group header
- [ ] New integration test verifies actual OpenAI SVG icon rendering (not mocked)
- [ ] All existing tests pass
- [ ] Build passes
- [ ] Changeset file created

## Git Commit Convention

- **Step completion:** `feat(KB-314): complete Step N — description`
- **Bug fixes:** `fix(KB-314): description`
- **Tests:** `test(KB-314): description`

## Do NOT

- Modify the ProviderIcon SVG implementation unless it's broken
- Change the icon color scheme (use existing `#10a37f` OpenAI green)
- Add new dependencies
- Skip the unmocked icon rendering test
- Modify files outside the File Scope
