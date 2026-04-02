# Task: KB-630 - Inherit Parent Task Models in Subtasks

**Created:** 2026-03-31
**Size:** S

## Review Level: 0 (None)

**Assessment:** Straightforward inheritance pattern applied to two existing code paths. No security implications, fully reversible.
**Score:** 0/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 0

## Mission

When subtasks are created (via dashboard subtask breakdown or AI triage agent), they should automatically inherit the parent task's AI model settings unless explicitly overridden. Currently, subtasks are created without copying the parent's `modelProvider`, `modelId`, `validatorModelProvider`, and `validatorModelId` fields, causing them to fall back to global defaults instead of using the parent's configured models.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/src/routes.ts` — Lines around 4281-4350 where `/subtasks/create-tasks` endpoint creates subtasks
- `packages/engine/src/triage.ts` — Lines around 565-600 where `taskCreate` tool creates subtasks during triage
- `packages/core/src/types.ts` — Task and TaskCreateInput type definitions showing model fields

## File Scope

- `packages/dashboard/src/routes.ts` — Modify `/subtasks/create-tasks` endpoint
- `packages/engine/src/triage.ts` — Modify `taskCreate` tool in `createTriageTools`
- `packages/dashboard/src/routes.test.ts` — Add tests for model inheritance
- `packages/engine/src/triage.test.ts` — Add tests for model inheritance

## Steps

### Step 1: Dashboard Subtask Breakdown Model Inheritance

- [ ] Fetch parent task when `parentTaskId` is provided in `/subtasks/create-tasks` endpoint
- [ ] Pass parent's model fields (`modelProvider`, `modelId`, `validatorModelProvider`, `validatorModelId`) to each `store.createTask()` call
- [ ] If parent task doesn't exist or has no model overrides, subtasks get `undefined` (fallback to global defaults)

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)

### Step 2: Triage Agent Subtask Creation Model Inheritance

- [ ] Fetch parent task in `taskCreate` tool using `options.parentTaskId`
- [ ] Pass parent's model fields to `store.createTask()` call
- [ ] Handle case where parent fetch fails gracefully (fallback to no model overrides)

**Artifacts:**
- `packages/engine/src/triage.ts` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Add test in `packages/dashboard/src/routes.test.ts` verifying subtasks inherit parent models via `/subtasks/create-tasks`
- [ ] Add test in `packages/engine/src/triage.test.ts` verifying `taskCreate` tool inherits parent models
- [ ] Run `pnpm test` — all tests must pass
- [ ] Run `pnpm build` — must build without errors

**Artifacts:**
- `packages/dashboard/src/routes.test.ts` (modified)
- `packages/engine/src/triage.test.ts` (modified)

### Step 4: Documentation & Delivery

- [ ] Create changeset file `.changeset/subtask-model-inheritance.md` describing the change

**Artifacts:**
- `.changeset/subtask-model-inheritance.md` (new)

## Documentation Requirements

**Check If Affected:**
- `AGENTS.md` — Update if it documents subtask creation behavior

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Subtasks created via dashboard inherit parent task models
- [ ] Subtasks created via triage agent inherit parent task models
- [ ] Changeset file created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-630): complete Step N — description`
- **Bug fixes:** `fix(KB-630): description`
- **Tests:** `test(KB-630): description`

## Do NOT

- Modify model preset inheritance (out of scope)
- Change how global model defaults work
- Add UI for per-subtask model selection (not needed)
- Skip tests for the changed code paths
