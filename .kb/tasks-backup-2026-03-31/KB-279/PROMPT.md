# Task: KB-279 - Fix Title Auto-Creation to Use AI Summarization

**Created:** 2026-03-31
**Size:** S

## Review Level: 2 (Plan and Code)

**Assessment:** The fix requires modifying the `generateTitleFromDescription` function to use AI for proper summarization instead of simple word truncation. It's a localized change but involves async AI calls and error handling.
**Score:** 4/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 1

## Mission

Fix the title auto-creation feature so it uses an AI agent to generate a proper summary of the task description instead of simply truncating the first few words. If the AI call fails or returns an empty result, the task should be created without a title (empty string) rather than falling back to truncated text.

## Dependencies

- **None**

## Context to Read First

- `packages/core/src/store.ts` — Lines 2239-2328 contain the current `generateTitleFromDescription` function that needs to be fixed
- `packages/core/src/store.ts` — Line 382 where `generateTitleFromDescription` is called in `createTask`
- `packages/dashboard/src/ai-refine.ts` — Reference pattern for making simple AI agent calls using `createKbAgent` with `tools: "readonly"`
- `packages/engine/src/pi.ts` — How `createKbAgent` works and its options
- `packages/core/src/store.test.ts` — Lines 2445-2500 contain tests for title generation that will need updating

## File Scope

- `packages/core/src/store.ts` (modify)
- `packages/core/src/store.test.ts` (modify)

## Steps

### Step 1: Make Title Generation Async with AI

- [ ] Modify `generateTitleFromDescription` to be an async function
- [ ] Add dynamic import of `@kb/engine` to get `createKbAgent` (follow pattern in `ai-refine.ts`)
- [ ] Create a concise system prompt for title generation (max 60 chars, 3-8 words, summarize key intent)
- [ ] Use `createKbAgent` with `tools: "readonly"` to generate the title
- [ ] Extract the AI response and clean it (remove quotes, trim whitespace)
- [ ] Return empty string if AI fails or returns empty content (no fallback to truncation)

**Artifacts:**
- `packages/core/src/store.ts` (modified)

### Step 2: Update createTask to Await Title Generation

- [ ] Make `createTask` async call to `generateTitleFromDescription` use `await`
- [ ] Ensure the rest of the function handles the async title generation correctly
- [ ] Verify that when title generation returns empty, the task is created without a title

**Artifacts:**
- `packages/core/src/store.ts` (modified)

### Step 3: Update Tests

- [ ] Update all tests that expect truncated titles to expect AI-generated titles (or empty if AI fails)
- [ ] Mock the AI agent in tests to return predictable titles
- [ ] Add tests for AI failure case (returns empty string when AI fails)
- [ ] Update the "very long description" test — it should no longer truncate but generate a summary
- [ ] Ensure tests for short/single word descriptions still work (AI should return those as-is)

**Artifacts:**
- `packages/core/src/store.test.ts` (modified)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

### Step 5: Documentation & Delivery

- [ ] Update AGENTS.md if there's a section about title generation
- [ ] Create changeset file (patch level — internal improvement)

## Documentation Requirements

**Must Update:**
- None — internal implementation change

**Check If Affected:**
- `AGENTS.md` — Check if there's any mention of how titles are auto-generated

## Completion Criteria

- [ ] Title generation uses AI to summarize instead of truncating
- [ ] AI failures result in no title (empty) rather than truncated fallback
- [ ] All tests passing
- [ ] Build passes
- [ ] Changeset created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-279): complete Step N — description`
- **Bug fixes:** `fix(KB-279): description`
- **Tests:** `test(KB-279): description`

## Do NOT

- Keep the old truncation logic as a fallback — if AI fails, return empty string
- Add title generation to other parts of the codebase (scope is only `createTask`)
- Change the title field structure or storage format
- Use the full executor agent with coding tools — use `readonly` tools only
