# Task: KB-621 - AI Title Summarization from Long Descriptions

**Created:** 2026-03-31
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This involves adding settings, creating a new AI service in core, modifying task creation flow, and dashboard UI changes. The blast radius spans core types, store behavior, core AI service, dashboard API, and UI.
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 2, Reversibility: 1

## Mission

Implement an optional AI-powered title summarization feature that automatically generates concise titles from task descriptions longer than 140 characters. When enabled and a task is created without a title, the system uses AI to create a summary (≤60 characters) from the description. Users can choose which AI model to use for summarization via project settings.

## Dependencies

- **None**

## Context to Read First

1. `packages/core/src/types.ts` — Settings interfaces, PROJECT_SETTINGS_KEYS, TaskCreateInput
2. `packages/core/src/store.ts` — createTask method (line ~575)
3. `packages/dashboard/src/routes.ts` — API routes structure, existing `/ai/refine-text` endpoint at line 4645
4. `packages/dashboard/src/ai-refine.ts` — Pattern for AI text generation services (used for reference, but service goes in core)
5. `packages/dashboard/app/components/SettingsModal.tsx` — Settings UI structure, SETTINGS_SECTIONS at line 78
6. `packages/engine/src/pi.ts` — createKbAgent pattern for AI sessions

## File Scope

- `packages/core/src/types.ts` — Add `autoSummarizeTitles`, `titleSummarizerProvider`, `titleSummarizerModelId` to ProjectSettings; add `summarize?: boolean` to TaskCreateInput
- `packages/core/src/ai-summarize.ts` — New AI summarization service (in core package, not dashboard)
- `packages/core/src/store.ts` — Modify createTask to trigger summarization
- `packages/core/src/store.test.ts` — Add tests for title summarization behavior
- `packages/dashboard/src/routes.ts` — Add POST `/ai/summarize-title` endpoint
- `packages/dashboard/app/api.ts` — Add API client for summarize-title endpoint
- `packages/dashboard/app/api.test.ts` — Add tests for summarizeTitle API client
- `packages/dashboard/app/components/SettingsModal.tsx` — Add "AI Summarization" settings section
- `.changeset/ai-title-summarization.md` — Changeset for the feature

## Steps

### Step 1: Add Settings Types

- [ ] Add `autoSummarizeTitles?: boolean` to `ProjectSettings` interface in `packages/core/src/types.ts`
- [ ] Add `titleSummarizerProvider?: string` to `ProjectSettings` interface
- [ ] Add `titleSummarizerModelId?: string` to `ProjectSettings` interface
- [ ] Add `summarize?: boolean` to `TaskCreateInput` interface in types.ts
- [ ] Add new keys to `PROJECT_SETTINGS_KEYS` array: `autoSummarizeTitles`, `titleSummarizerProvider`, `titleSummarizerModelId`
- [ ] Add default values to `DEFAULT_PROJECT_SETTINGS`: `autoSummarizeTitles: false`
- [ ] Run TypeScript typecheck in packages/core to verify no errors

**Artifacts:**
- `packages/core/src/types.ts` (modified)

### Step 2: Create Core AI Summarization Service

- [ ] Create `packages/core/src/ai-summarize.ts` following the AI pattern from dashboard's `ai-refine.ts`
- [ ] Implement `SUMMARIZE_SYSTEM_PROMPT` constant with instructions:
  - "Create a concise title (max 60 characters) that summarizes the given task description"
  - "Return only the title text, no quotes, no markdown, no explanations"
  - "Capture the essence of what the task is about"
- [ ] Implement `summarizeTitle()` function that:
  - Accepts description text, rootDir, and optional provider/modelId
  - Uses dynamic import of `@fusion/engine` (like ai-refine.ts pattern) to get `createKbAgent`
  - Returns a single-line summary (≤60 characters)
  - Truncates result to 60 chars if AI returns longer text
  - Returns null for descriptions ≤140 chars (validation, not generation)
- [ ] Add rate limiting state and `checkRateLimit(ip: string)` function (10 requests per hour per IP)
- [ ] Add validation: description must be 141-2000 characters
- [ ] Export custom error classes: `ValidationError`, `AiServiceError`, `RateLimitError`
- [ ] Ensure graceful handling when engine import fails (throw AiServiceError)
- [ ] Create `packages/core/src/ai-summarize.test.ts` with unit tests for validation, rate limiting, and error handling
- [ ] Run targeted tests for new file

**Artifacts:**
- `packages/core/src/ai-summarize.ts` (new)
- `packages/core/src/ai-summarize.test.ts` (new)

### Step 3: Modify Task Store for Summarization

- [ ] Add optional `onSummarize?: (description: string) => Promise<string | null>` callback parameter to `createTask()` method signature
- [ ] In `createTask()` method body, add logic after validation:
  - If `input.summarize === true` OR (settings has `autoSummarizeTitles: true` AND no title provided):
    - Check if description.length > 140
    - If so, call `onSummarize?.(input.description)` if callback provided
    - If callback returns a title, use it; if null/undefined, proceed without title
    - If callback throws, log warning via `taskLog` but don't block task creation
- [ ] Do NOT import ai-summarize.ts directly in store.ts — use the callback pattern to avoid core→engine dependency issues
- [ ] The store should remain agnostic to how summarization is implemented
- [ ] Update `packages/core/src/store.test.ts`:
  - Add test for createTask with summarize callback returning a title
  - Add test for createTask with summarize callback returning null
  - Add test for createTask with autoSummarizeTitles setting enabled
  - Add test for graceful handling when summarize callback throws
- [ ] Run store tests to verify behavior

**Artifacts:**
- `packages/core/src/store.ts` (modified)
- `packages/core/src/store.test.ts` (modified)

### Step 4: Add Dashboard API Endpoint

- [ ] Add POST `/ai/summarize-title` route in `packages/dashboard/src/routes.ts` (note: no `/api` prefix — router is already mounted at `/api`)
- [ ] Request body validation:
  - `description: string` (required, 141-2000 chars)
  - `provider?: string` (optional)
  - `modelId?: string` (optional)
- [ ] Model selection hierarchy when called:
  1. Use request body provider+modelId if provided
  2. Else use settings `titleSummarizerProvider` + `titleSummarizerModelId` if configured
  3. Else use settings `planningProvider` + `planningModelId` if configured
  4. Else use settings `defaultProvider` + `defaultModelId` if configured
  5. Else use automatic model resolution (no explicit model)
- [ ] Import `summarizeTitle` and `checkRateLimit` from `@fusion/core` (since it's now in core package)
- [ ] Get client IP for rate limiting: `req.ip` or `req.socket.remoteAddress`
- [ ] Response: `{ title: string }` (the generated summary, guaranteed ≤60 chars)
- [ ] Error handling:
  - 400 for validation errors (description too short/long, missing)
  - 429 for rate limit exceeded (include reset time in error message if available)
  - 503 for AI service unavailable
  - 500 for unexpected errors
- [ ] Add debug logging behind `KB_DEBUG_AI` env flag
- [ ] Run dashboard tests to verify route integration

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)

### Step 5: Wire Up Summarization in Dashboard Routes

- [ ] In `packages/dashboard/src/routes.ts`, locate where `store.createTask` is called (around line 1365)
- [ ] Pass `onSummarize` callback to `store.createTask()`:
  ```typescript
  onSummarize: async (description) => {
    const settings = await store.getSettings();
    // Resolve model selection hierarchy
    const provider = settings.titleSummarizerProvider || settings.planningProvider || settings.defaultProvider;
    const modelId = settings.titleSummarizerModelId || settings.planningModelId || settings.defaultModelId;
    // Call core's summarizeTitle function
    return await summarizeTitle(description, store.getRootDir(), provider, modelId);
  }
  ```
- [ ] Import `summarizeTitle` from `@fusion/core` at top of routes.ts
- [ ] Ensure the callback handles errors gracefully (returns null on error so task creation proceeds)
- [ ] Verify other createTask calls (planning mode, subtask breakdown, etc.) can optionally pass onSummarize

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)

### Step 6: Add Dashboard API Client

- [ ] Add `summarizeTitle()` function to `packages/dashboard/app/api.ts`
- [ ] Function signature: `summarizeTitle(description: string, provider?: string, modelId?: string): Promise<string>`
- [ ] Makes POST request to `/api/ai/summarize-title`
- [ ] Handle 429 responses specifically with retry-after message
- [ ] Handle 503 with "AI service temporarily unavailable"
- [ ] Throw meaningful error messages for other failures
- [ ] Add test coverage in `packages/dashboard/app/api.test.ts`:
  - Success case returns title
  - 400 validation error handling
  - 429 rate limit handling
  - 503 service unavailable handling
- [ ] Run api tests

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified)
- `packages/dashboard/app/api.test.ts` (modified)

### Step 7: Add Settings UI

- [ ] Add new "AI Summarization" section to `SETTINGS_SECTIONS` in SettingsModal.tsx
- [ ] Insert between "model-presets" (index 2) and "appearance" (index 3) sections
- [ ] Set scope: "project" (stored in `.fusion/config.json`)
- [ ] Add UI controls in renderSectionFields() for the new section:
  - Checkbox: "Auto-summarize long descriptions as titles"
    - Binds to `form.autoSummarizeTitles`
    - Help text: "When enabled, tasks created without a title but with descriptions over 140 characters will automatically get an AI-generated title (max 60 characters)."
  - Model selector for "Title summarization model" (only visible when checkbox enabled)
    - Use `CustomModelDropdown` component for provider selection
    - Use a second dropdown for model selection (re-use pattern from ModelSelectorTab)
    - Show "(using planning model)" or "(using default model)" when not explicitly set
  - Quick action buttons:
    - "Use planning model" — sets to planningProvider/planningModelId
    - "Use default model" — sets to defaultProvider/defaultModelId
- [ ] Ensure form state properly initializes from settings
- [ ] Add scope banner in renderScopeBanner() for the new section
- [ ] Verify UI doesn't break when availableModels is loading
- [ ] Test UI rendering: open settings, navigate to AI Summarization section, verify controls appear

**Artifacts:**
- `packages/dashboard/app/components/SettingsModal.tsx` (modified)

### Step 8: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` in packages/core — all tests pass including new ai-summarize tests
- [ ] Run `pnpm test` in packages/dashboard — all tests pass including new API tests
- [ ] Run `pnpm build` — builds without errors in all packages
- [ ] Verify TypeScript typecheck passes: `pnpm typecheck` (or equivalent)
- [ ] Test rate limiting: make 11 rapid requests to summarize-title endpoint, verify 429 on 11th
- [ ] Test model fallback hierarchy by:
  1. Setting only default model → should use default
  2. Setting planning model → should prefer planning over default
  3. Setting titleSummarizer model → should prefer over planning/default
- [ ] Manual UI test:
  1. Open dashboard settings, enable auto-summarize
  2. Select a specific model for summarization
  3. Create task with no title but long description (>140 chars) via quick entry
  4. Verify task appears with auto-generated title
  5. Disable setting, create another long-description task
  6. Verify no title is generated (task shows ID only)

### Step 9: Documentation & Delivery

- [ ] Create changeset file: `.changeset/ai-title-summarization.md`
  ```markdown
  ---
  "@gsxdsm/fusion": patch
  ---

  Add AI-powered title summarization feature. When enabled via settings, tasks created without titles but with descriptions longer than 140 characters will automatically receive an AI-generated title (max 60 characters). Includes configurable model selection for the summarization with fallback to planning and default models.
  ```
- [ ] Update AGENTS.md settings documentation section if it exists:
  - Add documentation for `autoSummarizeTitles`, `titleSummarizerProvider`, `titleSummarizerModelId`
  - Document the model selection hierarchy: titleSummarizer → planning → default
- [ ] Verify all commits include `KB-621` prefix
- [ ] Verify no files modified outside File Scope

## Documentation Requirements

**Must Update:**
- `.changeset/ai-title-summarization.md` — New changeset describing the feature

**Check If Affected:**
- `AGENTS.md` — Check if settings documentation section exists and update if relevant

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Documentation updated with changeset
- [ ] Feature works end-to-end (settings → task creation with AI summary)
- [ ] Rate limiting verified working
- [ ] Model fallback hierarchy verified working

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-621): complete Step N — description`
- **Bug fixes:** `fix(KB-621): description`
- **Tests:** `test(KB-621): description`
- **Changeset:** `feat(KB-621): add changeset for AI title summarization`

## Do NOT

- Expand task scope to include automatic summarization of existing tasks (only new tasks)
- Skip rate limiting on the summarize endpoint
- Modify files outside the File Scope without good reason
- Commit without the KB-621 prefix
- Use AI summarization when user explicitly provided a title (respect user input)
- Create circular dependencies between packages (core must not depend on dashboard or engine)
