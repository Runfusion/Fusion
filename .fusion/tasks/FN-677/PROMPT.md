# Task: FN-677 - Fix Missing Types in packages/core/src/types.ts

**Created:** 2026-04-01
**Size:** S

## Review Level: 0 (None)

**Assessment:** This is a straightforward type definition fix. The types.ts file is missing several exported types that are imported by first-run.ts and migration-orchestrator.ts. No plan review needed for adding missing type definitions.
**Score:** 2/8 — Blast radius: 0 (local type additions), Pattern novelty: 0 (standard types), Security: 0 (no security impact), Reversibility: 2 (easy to modify)

## Mission

Add missing type definitions to `packages/core/src/types.ts` that are required by the first-run experience and migration orchestrator modules. The build is currently failing because these types are imported but not exported from types.ts:

1. `DetectedProject` — Detected project from filesystem scanning
2. `SetupState` — State for the first-run setup wizard UI
3. `ProjectSetupInput` — Input type for completing project setup
4. `SetupCompletionResult` — Result of setup completion
5. `MigrationOptions` — Options for migration orchestration
6. `MigrationResult` — Result of migration run

Additionally, add `setupComplete?: boolean` to `GlobalSettings` interface.

## Dependencies

- **None**

## Context to Read First

1. `packages/core/src/first-run.ts` (lines 18-28, 98-188, 249) — See how types are used
2. `packages/core/src/migration-orchestrator.ts` (lines 28-30, 112, 245, 366-420) — See migration type usage
3. `packages/core/src/types.ts` (lines 508-545) — See GlobalSettings interface to extend
4. `packages/core/src/types.ts` (lines 892-914) — See RegisteredProject for reference structure

## File Scope

- `packages/core/src/types.ts` (add missing type definitions)

## Steps

### Step 1: Add Missing Type Definitions

Add the following type definitions to `packages/core/src/types.ts` after the `ArchivedTaskEntry` interface (around line 880) and before `PlanningQuestionType`:

- [ ] Add `DetectedProject` interface:
  ```typescript
  export interface DetectedProject {
    path: string;
    name: string;
    hasDb: boolean;
  }
  ```

- [ ] Add `SetupState` interface:
  ```typescript
  export interface SetupState {
    isFirstRun: boolean;
    detectedProjects: DetectedProject[];
    registeredProjects: RegisteredProject[];
    recommendedAction: "auto-detect" | "create-new" | "manual-setup";
  }
  ```

- [ ] Add `ProjectSetupInput` interface:
  ```typescript
  export interface ProjectSetupInput {
    path: string;
    name: string;
    isolationMode?: IsolationMode;
  }
  ```

- [ ] Add `SetupCompletionResult` interface:
  ```typescript
  export interface SetupCompletionResult {
    success: boolean;
    registered: RegisteredProject[];
    errors: Array<{ path: string; error: string }>;
    nextSteps: string[];
  }
  ```

- [ ] Add `MigrationOptions` interface:
  ```typescript
  export interface MigrationOptions {
    startPath?: string;
    maxDepth?: number;
    autoRegister?: boolean;
    dryRun?: boolean;
    onProgress?: (completed: number, total: number, phase: string) => void;
  }
  ```

- [ ] Add `MigrationResult` interface:
  ```typescript
  export interface MigrationResult {
    projectsDetected: DetectedProject[];
    projectsRegistered: RegisteredProject[];
    projectsSkipped: Array<{ path: string; reason: string }>;
    errors: Array<{ path: string; error: string }>;
  }
  ```

- [ ] Add `setupComplete` to `GlobalSettings` interface (after `ntfyTopic` around line 542):
  ```typescript
  /** Default project ID for the current user. Used to automatically select
   *  the default project when opening the dashboard without a specific project. */
  defaultProjectId?: string;
  /** Whether the first-run setup wizard has been completed. */
  setupComplete?: boolean;
  ```

**Artifacts:**
- `packages/core/src/types.ts` (modified — add 6 new interfaces and 1 property)

### Step 2: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full build: `pnpm build`
- [ ] Verify no TypeScript errors in packages/core
- [ ] Run tests: `pnpm test`
- [ ] Fix any remaining failures

### Step 3: Documentation & Delivery

- [ ] No documentation updates required (internal type additions)
- [ ] Verify build passes completely

## Completion Criteria

- [ ] All 6 new type interfaces exported from types.ts
- [ ] `setupComplete` property added to `GlobalSettings`
- [ ] Build passes without TypeScript errors (`pnpm build` succeeds)
- [ ] All tests passing (`pnpm test` succeeds)

## Git Commit Convention

- **Step completion:** `feat(FN-677): complete Step 1 — add missing types for first-run experience`
- **Bug fixes:** `fix(FN-677): description`
- **Tests:** `test(FN-677): description`

## Do NOT

- Modify first-run.ts or migration-orchestrator.ts (they just need the types)
- Add implementation logic (only type definitions)
- Change existing type definitions (only add new ones)
- Skip the full build verification
