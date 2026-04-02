# Task: KB-169 - Make Provider Icons Show Real Providers in Usage Quota Dropdown

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Small UI fix - updating icon mapping logic and ensuring provider icons display correctly in the usage dropdown. Low blast radius, established patterns.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

The usage quota dropdown in the dashboard displays provider usage data for Claude, Codex, and Gemini. Currently, the `getProviderIconKey` mapping function in `UsageIndicator.tsx` attempts to map provider names to icon keys, but the provider names returned by the backend ("Claude", "Codex", "Gemini") need to be correctly mapped to their respective branded SVG icons (Anthropic "A", OpenAI spiral, Google Gemini sparkle).

This task ensures that the usage dropdown shows the actual branded provider icons instead of generic fallback icons. The mapping logic must handle the exact provider names returned by the backend (`packages/dashboard/src/usage.ts`):
- "Claude" → Anthropic icon (warm tan "A" monogram)
- "Codex" → OpenAI icon (green spiral flower)
- "Gemini" → Google Gemini icon (blue sparkle)

## Dependencies

- **None**

## Context to Read First

1. `packages/dashboard/app/components/UsageIndicator.tsx` - The usage dropdown component with `getProviderIconKey` mapping function
2. `packages/dashboard/app/components/ProviderIcon.tsx` - The provider icon component with SVG icons and providerConfig mapping
3. `packages/dashboard/src/usage.ts` - Backend that returns provider usage data with names: "Claude", "Codex", "Gemini"
4. `packages/dashboard/app/components/UsageIndicator.test.tsx` - Existing tests showing expected behavior

## File Scope

- `packages/dashboard/app/components/UsageIndicator.tsx` (modify)
- `packages/dashboard/app/components/ProviderIcon.tsx` (modify if adding new icons)
- `packages/dashboard/app/components/UsageIndicator.test.tsx` (add/update tests)

## Steps

### Step 1: Fix Provider Icon Mapping in UsageIndicator

- [ ] Verify `getProviderIconKey` function correctly maps all backend provider names to icon keys:
  - "Claude" → "anthropic" (case-insensitive match for "claude")
  - "Codex" → "openai" (case-insensitive match for "codex")
  - "Gemini" → "google" or "gemini" (case-insensitive match for "gemini")
- [ ] Ensure mapping uses `.toLowerCase()` and `.includes()` for robust matching
- [ ] Verify `ProviderCard` component passes the mapped key to `ProviderIcon` component
- [ ] Run targeted tests for `UsageIndicator` component

**Artifacts:**
- `packages/dashboard/app/components/UsageIndicator.tsx` (modified)

### Step 2: Verify ProviderIcon Component Handles All Keys

- [ ] Check that `ProviderIcon.tsx` has icon configurations for all mapped keys:
  - "anthropic" → `AnthropicIcon` (warm tan #d4a27f)
  - "openai" → `OpenAIIcon` (green #10a37f)
  - "google" → `GeminiIcon` (blue #4285f4)
  - "gemini" → `GeminiIcon` (blue #4285f4)
- [ ] Add any missing provider configurations if needed
- [ ] Ensure fallback to `Cpu` icon works for unknown providers
- [ ] Run `ProviderIcon` component tests

**Artifacts:**
- `packages/dashboard/app/components/ProviderIcon.tsx` (modified if needed)

### Step 3: Add/Update Tests for Provider Icon Mapping

- [ ] Add test cases for all three backend provider names:
  - Test "Claude" renders with `data-provider="anthropic"` and Anthropic SVG
  - Test "Codex" renders with `data-provider="openai"` and OpenAI SVG
  - Test "Gemini" renders with `data-provider="google"` or `data-provider="gemini"` and Gemini SVG
- [ ] Verify tests check for correct SVG `aria-label` attributes
- [ ] Ensure tests validate that the emoji `icon` field from API is NOT rendered (SVG takes precedence)
- [ ] Run all usage indicator tests to confirm pass

**Artifacts:**
- `packages/dashboard/app/components/UsageIndicator.test.tsx` (modified)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full dashboard test suite: `cd packages/dashboard && pnpm test`
- [ ] Fix all test failures
- [ ] Run full project build: `pnpm build`
- [ ] Manually verify in browser (if possible) that usage dropdown shows branded icons

### Step 5: Documentation & Delivery

- [ ] Update any relevant documentation if provider icon behavior changed
- [ ] Out-of-scope findings created as new tasks via `task_create` tool

## Documentation Requirements

**Must Update:**
- None required for this fix

**Check If Affected:**
- `AGENTS.md` — Check if provider icon documentation exists and update if relevant

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] `getProviderIconKey` correctly maps "Claude", "Codex", "Gemini" to their branded icons
- [ ] Usage dropdown displays Anthropic "A", OpenAI spiral, and Gemini sparkle icons
- [ ] No generic `Cpu` fallback icons shown for known providers

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-169): complete Step N — description`
- **Bug fixes:** `fix(KB-169): description`
- **Tests:** `test(KB-169): description`

## Do NOT

- Expand task scope beyond icon mapping fix
- Skip tests or manual verification
- Modify files outside the File Scope without good reason
- Change the backend provider names ("Claude", "Codex", "Gemini") - only fix frontend mapping
- Commit without the task ID prefix
