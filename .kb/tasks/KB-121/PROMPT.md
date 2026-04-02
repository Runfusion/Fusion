# Task: KB-121 - Make provider icons on the dropdown accurate - use the actual provider icons

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a UI-only change with limited blast radius. The ProviderIcon component is used in only 2 places (CustomModelDropdown and ModelSelectorTab). Pattern is straightforward (swap generic icons for SVG brand logos). Fully reversible by reverting the file.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

Replace the generic Lucide icons (Brain, Sparkles, Search, Terminal, Cpu) in the ProviderIcon component with actual provider brand SVG logos. The dropdown currently shows generic icons that don't visually identify the AI providers. Users need to see the actual Anthropic, OpenAI, Google/Gemini, and Ollama brand icons for quick visual recognition.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/ProviderIcon.tsx` — Current implementation using generic Lucide icons
- `packages/dashboard/app/components/__tests__/ProviderIcon.test.tsx` — Existing tests (will need updating)
- `packages/dashboard/app/components/CustomModelDropdown.tsx` — Uses ProviderIcon in dropdown headers
- `packages/dashboard/app/components/ModelSelectorTab.tsx` — Uses ProviderIcon in model badges

## File Scope

- `packages/dashboard/app/components/ProviderIcon.tsx` (modified)
- `packages/dashboard/app/components/__tests__/ProviderIcon.test.tsx` (modified)

## Steps

### Step 1: Create Provider Brand SVG Icons

Replace the generic Lucide icons with actual brand SVG icons embedded as React components within ProviderIcon.tsx.

- [ ] Create inline SVG icon components for each provider:
  - **Anthropic**: Use their "A" monogram logo (the diamond-shaped stylized A in warm tan #d4a27f)
  - **OpenAI**: Use their spiral flower logo (green #10a37f)
  - **Google/Gemini**: Use the Gemini sparkle icon or Google "G" logo (blue #4285f4)
  - **Ollama**: Use the Ollama llama head logo (white #fff)
- [ ] Keep the same color scheme already defined in the component
- [ ] Maintain the same `sizeMap` and sizing behavior (sm: 16px, md: 20px, lg: 24px)
- [ ] Ensure all SVGs are properly sized using the `size` prop
- [ ] Keep the `Cpu` icon as the fallback for unknown providers

**Artifacts:**
- `packages/dashboard/app/components/ProviderIcon.tsx` (modified — new SVG icons)

### Step 2: Testing & Verification

Update tests to verify the new brand icons render correctly.

- [ ] Update `packages/dashboard/app/components/__tests__/ProviderIcon.test.tsx`:
  - Replace mock with actual SVG element assertions or data-testid checks
  - Test that each provider renders its specific SVG (check via data-testid or aria-label)
  - Keep tests for color application, size variants, and fallback behavior
  - Add data-testid attributes to SVG components for testability
- [ ] Run `pnpm test` and ensure all ProviderIcon tests pass
- [ ] Run `pnpm test` and ensure all CustomModelDropdown tests pass (they mock ProviderIcon, should still work)
- [ ] Run `pnpm test` and ensure full dashboard test suite passes

**Artifacts:**
- `packages/dashboard/app/components/__tests__/ProviderIcon.test.tsx` (modified)

### Step 3: Documentation & Delivery

- [ ] Verify the dropdown in ModelSelectorTab displays actual brand icons
- [ ] Create changeset for the UI improvement:
  ```bash
  cat > .changeset/accurate-provider-icons.md << 'EOF'
  ---
  "@dustinbyrne/kb": patch
  ---
  
  Use actual provider brand icons in model selection dropdown.
  EOF
  ```

## Completion Criteria

- [ ] ProviderIcon displays Anthropic, OpenAI, Google/Gemini, and Ollama brand logos (not generic icons)
- [ ] All sizes (sm, md, lg) render correctly
- [ ] Colors match the existing provider color scheme
- [ ] Unknown providers still show the Cpu fallback icon
- [ ] All tests pass
- [ ] Changeset created

## Git Commit Convention

- **Step completion:** `feat(KB-121): complete Step N — description`
- **Bug fixes:** `fix(KB-121): description`
- **Tests:** `test(KB-121): description`

## Do NOT

- Add external icon dependencies — use inline SVGs
- Change the ProviderIconProps interface signature
- Modify CustomModelDropdown or ModelSelectorTab (they consume ProviderIcon, no changes needed)
- Skip updating tests — tests must reflect the new implementation
- Use placeholder/generic icons — must be actual brand logos
