# Task: KB-147 - Add Separate Planning and Verification Model Settings

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This touches multiple packages (core types, dashboard UI, dashboard API, engine triage) and requires coordinated changes across type definitions, settings UI, and agent initialization logic. Changes are additive and reversible — existing behavior preserved when new settings are undefined.

**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 2, Reversibility: 1

## Mission

Add global settings in the dashboard to configure separate AI models for:
1. **Planning** (triage/specification) — the model used when writing PROMPT.md specifications
2. **Verification** (review/validation) — the model used when reviewing specs and code

Currently, both planning and verification use the default model (`defaultProvider`/`defaultModelId`). Per-task overrides already exist for executor and validator models via the Model tab in task detail. This task adds global defaults so users can set system-wide preferences without configuring each task individually.

## Dependencies

- **None**

## Context to Read First

- `packages/core/src/types.ts` — Settings type definition, DEFAULT_SETTINGS
- `packages/dashboard/app/components/SettingsModal.tsx` — Settings UI, model selection section
- `packages/dashboard/app/api.ts` — fetchSettings, updateSettings API calls
- `packages/engine/src/triage.ts` — TriageProcessor, specifyTask, createKbAgent call with defaultProvider/defaultModelId
- `packages/engine/src/reviewer.ts` — reviewStep function used for spec review

## File Scope

- `packages/core/src/types.ts` — Add `planningProvider`, `planningModelId`, `validatorProvider`, `validatorModelId` to Settings interface and DEFAULT_SETTINGS
- `packages/dashboard/app/components/SettingsModal.tsx` — Add planning model and validator model dropdowns in the Model section
- `packages/engine/src/triage.ts` — Update specifyTask to use planning model settings for the triage agent
- `packages/engine/src/reviewer.ts` — Update reviewStep to accept and use validator model settings
- `packages/dashboard/src/routes.ts` — Pass model registry to engine functions if needed (check existing pattern)

## Steps

### Step 1: Extend Core Settings Types

- [ ] Add `planningProvider?: string` and `planningModelId?: string` to Settings interface in `packages/core/src/types.ts`
- [ ] Add `validatorProvider?: string` and `validatorModelId?: string` to Settings interface
- [ ] Update DEFAULT_SETTINGS to include new fields (undefined by default)
- [ ] Add JSDoc comments explaining: when both provider and modelId are set, they override the default model for that specific purpose

**Artifacts:**
- `packages/core/src/types.ts` (modified)

### Step 2: Add Model Selection UI in Settings

- [ ] Extend the "model" section in SettingsModal to include 3 model selectors:
  - **Default Model** (existing) — used for task execution when no per-task override
  - **Planning Model** (new) — used for triage/specification
  - **Validator Model** (new) — used for spec review and code review
- [ ] Each selector uses the same pattern as the existing default model dropdown:
  - Filter input for searching models
  - Grouped by provider in optgroup
  - "Use default" option when both fields undefined
  - Shows current selection as badge
- [ ] Reuse the model filter utility and existing styles
- [ ] Handle loading states and empty states consistently

**Artifacts:**
- `packages/dashboard/app/components/SettingsModal.tsx` (modified)

### Step 3: Update Triage to Use Planning Model

- [ ] In `packages/engine/src/triage.ts`, locate the `createKbAgent` call in `specifyTask`
- [ ] Update the call to use planning model settings when available:
  - If `settings.planningProvider` and `settings.planningModelId` are set, use them
  - Otherwise fall back to `settings.defaultProvider`/`settings.defaultModelId`
- [ ] Pass the planning model to `defaultProvider`/`defaultModelId` parameters of `createKbAgent`
- [ ] Ensure the `reviewStep` call for spec review uses the validator model settings (see Step 4)

**Artifacts:**
- `packages/engine/src/triage.ts` (modified)

### Step 4: Update Reviewer to Use Validator Model

- [ ] In `packages/engine/src/reviewer.ts`, locate `reviewStep` function
- [ ] The function already accepts `ReviewOptions` with `defaultProvider`/`defaultModelId`
- [ ] Update call sites to pass validator model settings when available:
  - In `triage.ts` `createReviewSpecTool`, pass `settings.validatorProvider`/`settings.validatorModelId` if set
  - Fall back to `settings.defaultProvider`/`settings.defaultModelId` if validator fields not set
- [ ] Verify the reviewer properly uses these options when creating its agent session

**Artifacts:**
- `packages/engine/src/reviewer.ts` (modified if needed)
- `packages/engine/src/triage.ts` (modified for reviewSpecTool)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` — all tests must pass
- [ ] Run `pnpm typecheck` — no type errors
- [ ] Run `pnpm build` — successful build
- [ ] Verify settings UI loads and shows three model selectors
- [ ] Test saving settings with each model type selected
- [ ] Verify fallback behavior: when planning/validator models not set, uses default model
- [ ] Test that existing behavior unchanged when new settings are undefined

### Step 6: Documentation & Delivery

- [ ] Update AGENTS.md if there's a settings documentation section (check for existing pattern)
- [ ] Out-of-scope findings created as new tasks via `task_create` tool:
  - Per-task planning model override (currently only global + per-task executor/validator)

**Artifacts:**
- `.changeset/add-planning-validator-models.md` (changeset for the feature)

## Documentation Requirements

**Must Update:**
- `.changeset/add-planning-validator-models.md` — describe the new feature for the changelog

**Check If Affected:**
- `AGENTS.md` — add to settings documentation if such a section exists

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Typecheck passes (`pnpm typecheck`)
- [ ] Build passes (`pnpm build`)
- [ ] Three model selectors visible in Settings > Model section
- [ ] Settings save correctly with new model fields
- [ ] Fallback to default model works when planning/validator not set
- [ ] Changeset file included

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-147): complete Step N — description`
- **Bug fixes:** `fix(KB-147): description`
- **Tests:** `test(KB-147): description`

## Do NOT

- Modify per-task model override behavior in ModelSelectorTab
- Change the existing default model field names (backward compatibility)
- Remove thinking level settings
- Modify the model registry or authentication flows
- Skip writing a changeset file
- Break existing settings loading/saving behavior
