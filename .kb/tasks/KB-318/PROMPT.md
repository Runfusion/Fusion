# Task: KB-318 - Add Missing Settings Fields to @kb/core

**Created:** 2026-03-31
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Simple type additions to ProjectSettings interface. No runtime logic changes, only type definitions and defaults. Low blast radius, reversible.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Add missing `autoUpdatePrStatus` and `autoCreatePr` boolean fields to the `ProjectSettings` interface in `@kb/core`. These fields are referenced in `@kb/engine` tests (cron-runner.test.ts) but don't exist in the type definitions, causing TypeScript build failures in the engine package.

The fields control GitHub PR automation behavior:
- `autoUpdatePrStatus`: When true, automatically poll and update PR status badges
- `autoCreatePr`: When true, automatically create GitHub PRs for completed tasks

## Dependencies

- **None**

## Context to Read First

- `packages/core/src/types.ts` — Settings type definitions (line ~500-700)
- `packages/engine/src/cron-runner.test.ts` — Usage of missing fields (line ~24)
- `packages/core/src/index.ts` — Verify exports

## File Scope

- `packages/core/src/types.ts` — Add fields to ProjectSettings interface and DEFAULT_PROJECT_SETTINGS

## Steps

### Step 1: Add Missing Fields to ProjectSettings

- [ ] Add `autoUpdatePrStatus?: boolean;` to `ProjectSettings` interface in `types.ts`
- [ ] Add `autoCreatePr?: boolean;` to `ProjectSettings` interface in `types.ts`
- [ ] Add JSDoc comments explaining each field's purpose
- [ ] Add both fields to `DEFAULT_PROJECT_SETTINGS` with default value `false`

**Artifacts:**
- `packages/core/src/types.ts` (modified)

### Step 2: Verify Build

- [ ] Run `pnpm build` in `@kb/core` package
- [ ] Verify no TypeScript errors in `packages/core`
- [ ] Run `pnpm build` in `@kb/engine` package
- [ ] Verify engine build errors related to these fields are resolved

**Artifacts:**
- Build output (no files modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` in `@kb/core` package
- [ ] Run `pnpm test` in `@kb/engine` package
- [ ] Fix any test failures
- [ ] Full build passes: `pnpm build`

### Step 4: Documentation & Delivery

- [ ] Create changeset file (patch bump for `@dustinbyrne/kb`)
- [ ] Out-of-scope findings created as new tasks via `task_create` tool

## Documentation Requirements

**Must Update:**
- None — type additions are self-documenting via JSDoc

**Check If Affected:**
- `.fusion/config.json` schema documentation (if exists)
- Dashboard settings UI (may need to expose these new fields)

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] `@kb/engine` builds without type errors
- [ ] Changeset file created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-318): complete Step N — description`
- **Bug fixes:** `fix(KB-318): description`
- **Tests:** `test(KB-318): description`

## Do NOT

- Add runtime logic — this is a type-only change
- Modify engine package files — the types will fix engine build errors
- Skip the engine build verification
- Create a major or minor changeset — this is a patch fix
