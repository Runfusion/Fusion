# Task: KB-652 - OpenAI Codex model should use OpenAI logo in model selector

**Created:** 2026-04-01
**Size:** S

## Review Level: 0 (None)

**Assessment:** Simple provider alias addition following existing pattern; single file change with test update.
**Score:** 1/8 — Blast radius: 1, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

When the `openai-codex` provider is selected in the model selector, display the OpenAI logo instead of the generic fallback icon. The dashboard already aliases `gemini` to use the Google icon; we need to apply the same pattern for `openai-codex` → OpenAI icon.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/ProviderIcon.tsx` — Provider icon mapping configuration
- `packages/dashboard/app/components/__tests__/ProviderIcon.test.tsx` — Existing test patterns

## File Scope

- `packages/dashboard/app/components/ProviderIcon.tsx` (modified)
- `packages/dashboard/app/components/__tests__/ProviderIcon.test.tsx` (modified)

## Steps

### Step 1: Add Provider Alias

- [ ] Add `openai-codex` entry to `providerConfig` mapping to the OpenAI icon (same pattern as `gemini` → `google`)
- [ ] Use the same color (`#10a37f`) as the `openai` entry

### Step 2: Add Test Coverage

- [ ] Add test case verifying `openai-codex` renders the OpenAI brand icon
- [ ] Add test case verifying `openai-codex` uses correct color (`#10a37f`)
- [ ] Run ProviderIcon tests to verify: `pnpm test -- packages/dashboard/app/components/__tests__/ProviderIcon.test.tsx`

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full dashboard test suite: `pnpm test -- packages/dashboard`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

### Step 4: Documentation & Delivery

- [ ] No documentation updates needed (UI behavior fix)
- [ ] Out-of-scope findings created as new tasks via `task_create` tool

## Documentation Requirements

**Must Update:** None

**Check If Affected:** None

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] `openai-codex` provider displays OpenAI logo in model selector dropdown and badges

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-652): complete Step N — description`
- **Bug fixes:** `fix(KB-652): description`
- **Tests:** `test(KB-652): description`

## Do NOT

- Expand task scope (e.g., don't add other missing provider aliases)
- Skip tests
- Modify files outside the File Scope without good reason
- Commit without the task ID prefix
