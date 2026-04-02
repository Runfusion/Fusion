# Task: KB-075 - Add Per-Task Thinking Level Override

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This touches multiple packages (core, engine, dashboard) with UI changes, API changes, and engine integration. The pattern is well-established (follows existing per-task model overrides), but requires coordinated changes across the stack.
**Score:** 5/8 — Blast radius: 2, Pattern novelty: 1, Security: 1, Reversibility: 1

## Mission

Add the ability to set a thinking level override on a per-task basis, similar to how per-task model overrides work. This allows users to control the reasoning effort (cost/quality tradeoff) for individual tasks without changing global defaults. The thinking level should be configurable from the Model tab in the task detail modal and should flow through to the executor, reviewer, triage, and merger agents.

## Dependencies

- **None**

## Context to Read First

- `packages/core/src/types.ts` — Task interface and ThinkingLevel type
- `packages/core/src/store.ts` — How per-task model overrides are handled in updateTask
- `packages/dashboard/app/components/ModelSelectorTab.tsx` — Existing model override UI pattern
- `packages/dashboard/app/components/SettingsModal.tsx` — How thinking level selector works for global settings (around line 188)
- `packages/dashboard/src/routes.ts` — PATCH /tasks/:id route for model updates
- `packages/dashboard/app/api.ts` — updateTask function signature
- `packages/engine/src/executor.ts` — How thinking level is passed to createKbAgent (around line 433)
- `packages/engine/src/reviewer.ts` — How reviewStep receives defaultThinkingLevel
- `packages/engine/src/triage.ts` — How triage agent is created with thinking level
- `packages/engine/src/merger.ts` — How merger agent is created with thinking level

## File Scope

### Core Package
- `packages/core/src/types.ts` — Add thinkingLevel to Task interface
- `packages/core/src/store.ts` — Add thinkingLevel to updateTask parameters

### Dashboard Server
- `packages/dashboard/src/routes.ts` — Add thinkingLevel to PATCH route

### Dashboard UI
- `packages/dashboard/app/api.ts` — Add thinkingLevel to updateTask function
- `packages/dashboard/app/components/ModelSelectorTab.tsx` — Add thinking level selector

### Engine Package
- `packages/engine/src/executor.ts` — Use task thinkingLevel override in agent creation
- `packages/engine/src/reviewer.ts` — Add validatorThinkingLevel to ReviewOptions (optional enhancement)
- `packages/engine/src/triage.ts` — Use task thinkingLevel when creating triage agent
- `packages/engine/src/merger.ts` — Use task thinkingLevel when creating merger agent

### Tests
- `packages/dashboard/app/components/__tests__/ModelSelectorTab.test.tsx` — Add tests for thinking level UI
- `packages/dashboard/src/routes.test.ts` — Add tests for thinkingLevel in PATCH route
- `packages/core/src/store.test.ts` — Add tests for thinkingLevel persistence

## Steps

### Step 1: Core Types and Store

- [ ] Add `thinkingLevel?: ThinkingLevel` field to the `Task` interface in `packages/core/src/types.ts`
- [ ] Add `thinkingLevel?: string | null` parameter to `updateTask` in `packages/core/src/store.ts`
- [ ] Handle `thinkingLevel` in `updateTask`: set to `undefined` when null, otherwise set the value
- [ ] Add unit tests in `packages/core/src/store.test.ts` for thinkingLevel persistence

**Artifacts:**
- `packages/core/src/types.ts` (modified)
- `packages/core/src/store.ts` (modified)
- `packages/core/src/store.test.ts` (modified)

### Step 2: Dashboard API Routes

- [ ] Add `thinkingLevel` validation to PATCH `/tasks/:id` route in `packages/dashboard/src/routes.ts`
- [ ] Pass `thinkingLevel` through to `store.updateTask`
- [ ] Add tests in `packages/dashboard/src/routes.test.ts` for thinkingLevel updates

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)
- `packages/dashboard/src/routes.test.ts` (modified)

### Step 3: Dashboard Frontend API and UI

- [ ] Add `thinkingLevel?: string` to `updateTask` function parameters in `packages/dashboard/app/api.ts`
- [ ] Add thinking level selector to `ModelSelectorTab` component in `packages/dashboard/app/components/ModelSelectorTab.tsx`
- [ ] Selector should show only when selected executor model supports reasoning (use `reasoning` boolean from ModelInfo)
- [ ] Show "Using default" badge when no override is set
- [ ] Include thinkingLevel in the save/reset flow alongside model settings
- [ ] Add tests in `packages/dashboard/app/components/__tests__/ModelSelectorTab.test.tsx`

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified)
- `packages/dashboard/app/components/ModelSelectorTab.tsx` (modified)
- `packages/dashboard/app/components/__tests__/ModelSelectorTab.test.tsx` (modified)

### Step 4: Engine Integration

- [ ] In `packages/engine/src/executor.ts`, modify executor agent creation to use `detail.thinkingLevel ?? settings.defaultThinkingLevel`
- [ ] Pass task thinkingLevel to reviewStep in the createReviewStepTool (add to ReviewOptions)
- [ ] In `packages/engine/src/triage.ts`, use task's `thinkingLevel` when creating triage agent (fallback to global default)
- [ ] In `packages/engine/src/merger.ts`, use task's `thinkingLevel` when creating merger agent (fallback to global default)

**Artifacts:**
- `packages/engine/src/executor.ts` (modified)
- `packages/engine/src/triage.ts` (modified)
- `packages/engine/src/merger.ts` (modified)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` in all modified packages
- [ ] Fix all test failures
- [ ] Run `pnpm build` to ensure TypeScript compiles
- [ ] Manually verify thinking level selector appears only for reasoning models
- [ ] Verify thinking level is saved and persisted correctly

### Step 6: Documentation & Delivery

- [ ] Update AGENTS.md if needed to document the per-task thinking level feature
- [ ] Create changeset file for the feature (minor bump for `@dustinbyrne/kb`)
- [ ] Ensure all commits follow the convention with KB-075 prefix

## Documentation Requirements

**Must Update:**
- None required — feature follows existing patterns and is self-documenting through the UI

**Check If Affected:**
- `AGENTS.md` — Add mention of per-task thinking level if there's a section on model overrides

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Build passes (`pnpm build`)
- [ ] Thinking level can be set per-task from the Model tab
- [ ] Thinking level only shows for models that support reasoning
- [ ] Thinking level flows through to executor, reviewer, triage, and merger agents
- [ ] Using "default" clears the override and falls back to global settings

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-075): complete Step N — description`
- **Bug fixes:** `fix(KB-075): description`
- **Tests:** `test(KB-075): description`

## Do NOT

- Expand task scope beyond thinking level (don't add other new per-task settings)
- Skip tests for any modified component
- Modify the global settings UI (SettingsModal thinking level selector is separate)
- Change the thinking level behavior for models that don't support reasoning
- Break existing per-task model override functionality
