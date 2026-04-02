# Task: KB-251 - AI-Powered Task Title Generation

**Created:** 2026-03-31
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This involves adding AI-powered title generation across multiple packages (engine, dashboard, core) with new API endpoints and async processing patterns. Requires careful integration with existing task creation flows.
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 2

## Mission

Replace the simple word-extraction title generation with AI-powered summarization that creates meaningful, concise task titles from descriptions. Currently, when a user creates a task without a title, the system extracts the first 8-10 words from the description (see `generateTitleFromDescription()` in `packages/core/src/store.ts`). This produces poor titles like "The title truncation should use ai to create a" instead of meaningful summaries like "Use AI to generate descriptive task titles from descriptions".

The solution should:
1. Use AI to generate concise, descriptive titles (max 60 chars) that actually summarize the task
2. Process titles asynchronously to avoid blocking task creation
3. Cache/store generated titles to avoid regenerating them
4. Fall back to simple truncation if AI is unavailable or times out
5. Apply retroactively to existing tasks that have auto-generated (truncated) titles

## Dependencies

- **None**

## Context to Read First

1. `packages/core/src/store.ts` — Look at `generateTitleFromDescription()` (lines ~2023-2067) to understand current simple title generation
2. `packages/dashboard/src/planning.ts` — See how AI generates titles in planning mode (search for "title" in PLANNING_SYSTEM_PROMPT and `generateSummary`)
3. `packages/engine/src/pi.ts` — Understand `createKbAgent` factory for creating AI sessions
4. `packages/dashboard/src/routes.ts` — Look at task creation endpoints to understand where title generation hooks in
5. `packages/dashboard/app/components/TaskCard.tsx` — Line 450 shows where title fallback rendering happens

## File Scope

- `packages/core/src/store.ts` — Add AI title generation trigger after task creation
- `packages/core/src/types.ts` — Add `aiTitleGenerated` flag to Task type
- `packages/engine/src/title-generator.ts` — New module: AI title generation processor
- `packages/dashboard/src/routes.ts` — Add API endpoint for manual title regeneration
- `packages/dashboard/app/api.ts` — Add client function for title regeneration API
- `packages/dashboard/app/components/TaskCard.tsx` — Update to show AI-generated titles differently
- `packages/core/src/store.test.ts` — Update tests for new title generation behavior
- `packages/engine/src/title-generator.test.ts` — New test file for title generator

## Steps

### Step 1: Core Types and Store Updates

- [ ] Add `aiTitleGenerated?: boolean` field to `Task` type in `packages/core/src/types.ts`
- [ ] Add `generateAITitle?: boolean` option to `TaskCreationInput` in `packages/core/src/types.ts`
- [ ] Modify `generateTitleFromDescription()` in `packages/core/src/store.ts` to mark titles with a flag indicating they were AI-generated (when that path is implemented)
- [ ] Add `requestAITitleGeneration(taskId: string)` method to TaskStore that emits an event
- [ ] Run targeted tests: `pnpm test --filter=@kb/core -- store.test.ts`

**Artifacts:**
- `packages/core/src/types.ts` (modified)
- `packages/core/src/store.ts` (modified)

### Step 2: Engine Title Generator Module

- [ ] Create `packages/engine/src/title-generator.ts` with `TitleGenerator` class
- [ ] Implement `generateTitle(description: string): Promise<string>` using `createKbAgent` with a focused system prompt:
  ```
  You are a title generation assistant. Given a task description, generate a concise, 
  descriptive title that summarizes the core intent. 
  
  Rules:
  - Maximum 60 characters
  - Use sentence case (capitalize first word, proper nouns)
  - Focus on the action/outcome, not implementation details
  - Remove filler words (the, a, an, should, needs to, etc.)
  
  Respond with ONLY the title text, no quotes, no markdown.
  ```
- [ ] Implement polling processor that listens for title generation requests
- [ ] Add timeout handling (max 10s) with fallback to simple truncation
- [ ] Add `packages/engine/src/title-generator.test.ts` with mocked AI responses
- [ ] Export from `packages/engine/src/index.ts`
- [ ] Run targeted tests: `pnpm test --filter=@kb/engine -- title-generator.test.ts`

**Artifacts:**
- `packages/engine/src/title-generator.ts` (new)
- `packages/engine/src/title-generator.test.ts` (new)
- `packages/engine/src/index.ts` (modified)

### Step 3: Dashboard API and Integration

- [ ] Add `POST /api/tasks/:id/regenerate-title` endpoint in `packages/dashboard/src/routes.ts`
  - Accepts optional `force: boolean` to regenerate even if already AI-generated
  - Returns `{ title: string, aiGenerated: boolean }`
  - Returns 404 if task not found, 400 if no description available
- [ ] Add `regenerateTaskTitle(taskId: string, force?: boolean)` function in `packages/dashboard/app/api.ts`
- [ ] Wire up title generation event in dashboard server startup (similar to how TriageProcessor is started)
- [ ] Add test for the new endpoint in `packages/dashboard/src/routes.test.ts`
- [ ] Run targeted tests: `pnpm test --filter=@kb/dashboard -- routes.test.ts`

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)
- `packages/dashboard/src/routes.test.ts` (modified)
- `packages/dashboard/app/api.ts` (modified)
- `packages/dashboard/src/server.ts` (modified - wire up generator)

### Step 4: Frontend Updates for AI-Generated Titles

- [ ] Update `TaskCard.tsx` to show a visual indicator (sparkle/star icon) when title is AI-generated
- [ ] Add hover tooltip explaining "AI-generated title" 
- [ ] Add context menu or button to manually regenerate title (calls the API endpoint)
- [ ] Ensure AI-generated titles are truncated visually with CSS if they exceed container width (use `text-overflow: ellipsis`)
- [ ] Add CSS for the AI title indicator in the card styles
- [ ] Run dashboard component tests: `pnpm test --filter=@kb/dashboard`

**Artifacts:**
- `packages/dashboard/app/components/TaskCard.tsx` (modified)
- `packages/dashboard/app/styles/card.css` (or appropriate style file - modified)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`
- [ ] Manual verification: Create a task with description "The title truncation should use ai to create a title that is a better summary" - verify AI generates something like "Use AI to generate better task title summaries"

### Step 6: Documentation & Delivery

- [ ] Update `AGENTS.md` to document the new AI title generation feature
- [ ] Add note about the `aiTitleGenerated` field in task type documentation
- [ ] Out-of-scope findings: If title generation significantly improves task discoverability, consider adding a one-time migration task to regenerate all existing auto-generated titles

## Documentation Requirements

**Must Update:**
- `AGENTS.md` — Add section under "Features" about AI-powered title generation

**Check If Affected:**
- `packages/core/README.md` — Update if there's task type documentation

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Documentation updated
- [ ] Creating a task without a title triggers async AI title generation
- [ ] AI-generated titles are visually distinguished in the dashboard
- [ ] Manual title regeneration works via API
- [ ] Fallback to simple truncation works when AI is unavailable

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-251): complete Step N — description`
- **Bug fixes:** `fix(KB-251): description`
- **Tests:** `test(KB-251): description`

## Do NOT

- Remove or break the existing simple title generation (keep as fallback)
- Block task creation waiting for AI title generation (must be async)
- Use AI for titles when the user explicitly provided a title (respect user's choice)
- Generate titles for tasks in "archived" column (skip to save API costs)
- Add complex title versioning or history tracking (out of scope)
