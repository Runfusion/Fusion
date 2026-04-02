# Task: KB-184 - Model Presets Section in Settings

**Created:** 2026-03-30
**Size:** L

## Review Level: 3 (Full)

**Assessment:** This is a complex feature involving type changes across multiple packages (@kb/core, @kb/dashboard), UI components (SettingsModal, NewTaskModal, InlineCreateCard), backend API updates, and integration with the task creation flow. Changes affect shared types and require coordination between frontend and backend.
**Score:** 7/8 — Blast radius: 2, Pattern novelty: 1, Security: 2, Reversibility: 2

## Mission

Implement a **Model Presets** system that allows users to configure reusable model profiles (e.g., "Budget", "Normal", "Complex") with pre-defined executor and validator model assignments. Tasks can then reference a preset instead of manually selecting models. Include an auto-selection feature that automatically assigns the appropriate preset based on task size (S, M, L).

This reduces cognitive overhead when creating tasks and ensures consistent model selection patterns across the team.

## Dependencies

- **None**

## Context to Read First

1. `packages/core/src/types.ts` — Settings type definition and DEFAULT_SETTINGS
2. `packages/dashboard/app/components/SettingsModal.tsx` — Settings UI structure and SETTINGS_SECTIONS
3. `packages/dashboard/app/components/NewTaskModal.tsx` — Task creation with model selection
4. `packages/dashboard/app/components/InlineCreateCard.tsx` — Inline task creation with model dropdowns
5. `packages/dashboard/app/components/ModelSelectorTab.tsx` — Per-task model override UI
6. `packages/dashboard/src/routes.ts` — Backend API routes for settings
7. `packages/dashboard/app/api.ts` — Frontend API functions

## File Scope

### Core Types (Shared)
- `packages/core/src/types.ts` — Add ModelPreset type, update Settings interface, update DEFAULT_SETTINGS

### Dashboard Backend
- `packages/dashboard/src/routes.ts` — Add preset validation in settings PUT endpoint

### Dashboard Frontend Components
- `packages/dashboard/app/components/SettingsModal.tsx` — Add "Model Presets" section UI
- `packages/dashboard/app/components/NewTaskModal.tsx` — Add preset selector dropdown
- `packages/dashboard/app/components/InlineCreateCard.tsx` — Add preset selector dropdown

### Dashboard Frontend Utils
- `packages/dashboard/app/utils/modelPresets.ts` — New file: preset utility functions (getPresetByName, applyPresetToSelection, getRecommendedPresetForSize)

### Dashboard Tests
- `packages/dashboard/app/components/__tests__/SettingsModal.test.tsx` — Add tests for preset CRUD
- `packages/dashboard/app/utils/modelPresets.test.ts` — New test file for preset utilities

## Steps

### Step 1: Core Types and Data Model

- [ ] Add `ModelPreset` interface to `packages/core/src/types.ts`:
  ```typescript
  export interface ModelPreset {
    id: string; // unique identifier (slug-friendly, e.g., "budget", "normal", "complex")
    name: string; // display name (e.g., "Budget", "Normal", "Complex")
    executorProvider?: string;
    executorModelId?: string;
    validatorProvider?: string;
    validatorModelId?: string;
  }
  ```
- [ ] Update `Settings` interface to include:
  - `modelPresets?: ModelPreset[]` — array of configured presets
  - `autoSelectModelPreset?: boolean` — enable auto-selection based on task size
  - `defaultPresetBySize?: { S?: string; M?: string; L?: string }` — preset IDs mapped to task sizes
- [ ] Update `DEFAULT_SETTINGS` with empty defaults:
  ```typescript
  modelPresets: [],
  autoSelectModelPreset: false,
  defaultPresetBySize: {},
  ```
- [ ] Run `pnpm typecheck` to ensure type consistency

**Artifacts:**
- `packages/core/src/types.ts` (modified)

### Step 2: Backend Settings Validation

- [ ] Update `packages/dashboard/src/routes.ts` PUT `/settings` endpoint to validate modelPresets structure
- [ ] Validate that each preset has required fields (id, name)
- [ ] Validate that model provider/modelId pairs are consistent (both set or both undefined)
- [ ] Validate preset IDs are unique within the array
- [ ] Return 400 with descriptive error for invalid preset data
- [ ] Run dashboard package tests: `pnpm --filter @kb/dashboard test`

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)

### Step 3: Preset Utilities

- [ ] Create `packages/dashboard/app/utils/modelPresets.ts` with functions:
  - `getPresetByName(presets: ModelPreset[], name: string): ModelPreset | undefined`
  - `applyPresetToSelection(preset: ModelPreset | undefined): { executorValue: string; validatorValue: string }`
  - `getRecommendedPresetForSize(size: "S" | "M" | "L" | undefined, defaultPresetBySize: Record<string, string>, presets: ModelPreset[]): ModelPreset | undefined`
  - `validatePresetId(id: string): boolean` — checks alphanumeric, hyphens, underscores only, 1-32 chars
  - `generatePresetId(name: string): string` — slugify display name to valid ID
- [ ] Create unit tests in `packages/dashboard/app/utils/modelPresets.test.ts` covering all utility functions
- [ ] All tests pass

**Artifacts:**
- `packages/dashboard/app/utils/modelPresets.ts` (new)
- `packages/dashboard/app/utils/modelPresets.test.ts` (new)

### Step 4: Settings UI — Model Presets Section

- [ ] Add "Model Presets" section to `SETTINGS_SECTIONS` in SettingsModal.tsx (between "model" and "appearance")
- [ ] Implement preset management UI in `renderSectionFields()`:
  - List existing presets with name and model summary (e.g., "Budget: gpt-4o-mini / gpt-4o-mini")
  - "Add Preset" button that opens inline form
  - Each preset row has Edit and Delete buttons
- [ ] Implement preset edit form:
  - Name input (display name)
  - ID display (auto-generated from name, editable)
  - Executor model dropdown (reusing existing model dropdown pattern)
  - Validator model dropdown
  - Save/Cancel buttons
- [ ] Implement auto-selection configuration:
  - Checkbox: "Auto-select preset based on task size"
  - When enabled, show three dropdowns:
    - "Small tasks (S):" → preset dropdown
    - "Medium tasks (M):" → preset dropdown  
    - "Large tasks (L):" → preset dropdown
- [ ] Ensure preset deletion requires confirmation if presets are in use
- [ ] Persist changes via existing `updateSettings()` API
- [ ] Add CSS classes following existing patterns (`.settings-section-heading`, `.form-group`, etc.)

**Artifacts:**
- `packages/dashboard/app/components/SettingsModal.tsx` (modified)

### Step 5: Task Creation — NewTaskModal Preset Integration

- [ ] Add preset selector dropdown above the Executor/Validator model dropdowns in NewTaskModal.tsx
- [ ] Dropdown shows:
  - "Use default" (no preset)
  - Separator
  - Available presets by name (e.g., "Budget", "Normal", "Complex")
  - "Custom" (allows manual executor/validator selection)
- [ ] When a preset is selected:
  - Executor and validator dropdowns auto-populate with preset values
  - Dropdowns become disabled with "Using preset: {name}" indicator
  - "Override" button appears to enable manual editing
- [ ] When "Custom" is selected:
  - Executor and validator dropdowns are enabled for manual selection
- [ ] On task creation, include preset selection in the task (store as `modelPresetId` in task.json)
- [ ] Run tests: `pnpm --filter @kb/dashboard test NewTaskModal`

**Artifacts:**
- `packages/dashboard/app/components/NewTaskModal.tsx` (modified)

### Step 6: Task Creation — InlineCreateCard Preset Integration

- [ ] Add compact preset selector to InlineCreateCard.tsx (similar to model button pattern)
- [ ] Button shows: "⚡ {presetName}" or "⚡ Preset" when none selected
- [ ] Clicking opens dropdown with preset list + "Custom" option
- [ ] Selecting a preset updates the internal model state (executorProvider/ModelId, validatorProvider/ModelId)
- [ ] Show preset indicator next to model count badge (e.g., "⚡ Budget · 2 models")
- [ ] Ensure keyboard navigation (Tab, Enter, Escape) works with preset dropdown
- [ ] Run tests: `pnpm --filter @kb/dashboard test InlineCreateCard`

**Artifacts:**
- `packages/dashboard/app/components/InlineCreateCard.tsx` (modified)

### Step 7: Core Task Types — Store Selected Preset

- [ ] Update `Task` interface in `packages/core/src/types.ts` to include optional `modelPresetId?: string`
- [ ] Update `TaskCreateInput` interface to include optional `modelPresetId?: string`
- [ ] Update `ArchivedTaskEntry` to include `modelPresetId` for restoration compatibility
- [ ] Run `pnpm typecheck` across all packages

**Artifacts:**
- `packages/core/src/types.ts` (modified)

### Step 8: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Fix all test failures
- [ ] Build passes: `pnpm build`
- [ ] Manual verification checklist:
  - [ ] Create 3 presets in settings (Budget, Normal, Complex)
  - [ ] Enable auto-selection and map S→Budget, M→Normal, L→Complex
  - [ ] Create small task — verify Budget preset auto-applied
  - [ ] Create medium task — verify Normal preset auto-applied
  - [ ] Create large task — verify Complex preset auto-applied
  - [ ] Override preset in NewTaskModal — verify manual model selection works
  - [ ] Create task with preset in InlineCreateCard — verify correct models assigned
  - [ ] Edit preset in settings — verify changes reflected in task creation
  - [ ] Delete preset — verify graceful fallback to default

### Step 9: Documentation & Delivery

- [ ] Update `AGENTS.md` settings documentation section to describe:
  - Model presets feature
  - Auto-selection based on task size
  - How presets interact with per-task model overrides
- [ ] Create changeset for the feature:
  ```bash
  cat > .changeset/add-model-presets.md << 'EOF'
  ---
  "@dustinbyrne/kb": minor
  ---
  
  Add model presets for configurable AI model profiles. Users can define preset configurations like "Budget", "Normal", and "Complex" with pre-assigned executor and validator models. Tasks can reference presets instead of manual model selection. Includes auto-selection feature that assigns presets based on task size (S/M/L).
  EOF
  ```
- [ ] Out-of-scope findings: If discovering related improvements (preset import/export, preset sharing), create new tasks via `task_create` tool

## Documentation Requirements

**Must Update:**
- `AGENTS.md` — Add section under Settings explaining model presets and auto-selection

**Check If Affected:**
- `packages/dashboard/README.md` — Update if it mentions settings or model configuration
- `packages/cli/README.md` — Check if CLI commands reference model settings

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Build successful (`pnpm build`)
- [ ] Changeset created
- [ ] Documentation updated
- [ ] Manual verification completed

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-184): complete Step N — description`
- **Bug fixes:** `fix(KB-184): description`
- **Tests:** `test(KB-184): description`
- **Docs:** `docs(KB-184): description`

Example commits:
```
feat(KB-184): complete Step 1 — add ModelPreset type and Settings fields
test(KB-184): add modelPresets utility tests
feat(KB-184): complete Step 4 — implement Model Presets settings UI
```

## Do NOT

- Expand task scope beyond model presets and auto-selection
- Skip writing tests for new utility functions
- Modify engine/agent code to use presets (presets are resolved to models at task creation time)
- Remove existing per-task model override capability (presets are an alternative, not a replacement)
- Change default model behavior when no preset is configured
- Add server-side model resolution based on presets (resolution happens in UI/API layer)
- Skip type checking after type changes
- Break existing task creation flows
