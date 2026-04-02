# Task: KB-504 - Migration and First-Run Experience: Auto-migration and backward compatibility

**Created:** 2026-03-31
**Size:** M

## Review Level: 3 (Full)

**Assessment:** This task bridges the gap between single-project and multi-project kb, requiring careful handling of existing user data and backward compatibility. High blast radius as it affects all existing kb users on first run. Security implications around auto-discovery and registration of projects. Pattern novelty in the migration orchestration.
**Score:** 6/8 — Blast radius: 2, Pattern novelty: 1, Security: 2, Reversibility: 1

## Mission

Build the migration and first-run experience that smoothly transitions kb from single-project mode to multi-project mode. This task ensures:

1. **Auto-migration**: When a user runs kb after the multi-project update, the system detects existing `.fusion` directories and automatically registers them in the central project registry
2. **Backward compatibility**: Existing single-project workflows continue to work seamlessly without user intervention
3. **First-run wizard**: New users (or existing users with fresh central database) are guided through an interactive setup to register their first project
4. **Graceful degradation**: If the central database is unavailable, kb falls back to single-project mode

This task depends on KB-500 (central infrastructure) and KB-501 (per-project runtime) and must integrate with KB-502 (dashboard UX) and KB-503 (CLI commands) as they become available.

## Dependencies

- **Task:** KB-500 (Core Infrastructure: Central database, project registry, unified activity feed)
  - Must provide: `CentralCore`, `ProjectRegistry`, `RegisteredProject`, `createCentralCore()`
  - Must expose: project registration API, global activity feed
- **Task:** KB-501 (Per-Project Runtime Abstraction and Hybrid Executor Lifecycle)
  - Must provide: `HybridExecutor`, `InProcessProjectRuntime`, runtime initialization patterns
  - Must expose: runtime lifecycle management, backward-compatible single-project mode
- **Task:** KB-502 (Dashboard Multi-Project UX: Overview page, drill-down, and setup wizard)
  - Must provide: Dashboard UI components for first-run experience, setup wizard
  - Note: If not yet complete, implement with stub UI that logs to console
- **Task:** KB-503 (CLI Multi-Project Commands: project subcommands and --project flag)
  - Must provide: `kb project` subcommands for registration
  - Note: If not yet complete, migration creates projects automatically without CLI

## Context to Read First

- `packages/core/src/db-migrate.ts` — Legacy migration patterns (file-based → SQLite)
- `packages/core/src/global-settings.ts` — Global settings store with `init()` pattern
- `packages/core/src/central-core.ts` (from KB-500) — Central orchestration API
- `packages/core/src/project-registry.ts` (from KB-500) — Project registration methods
- `packages/engine/src/hybrid-executor.ts` (from KB-501) — Runtime initialization
- `packages/cli/src/bin.ts` — CLI entry point and command routing
- `packages/cli/src/commands/dashboard.ts` — Dashboard startup logic
- `packages/dashboard/app/root.tsx` — Dashboard root component

## File Scope

### New Files
- `packages/core/src/migration-orchestrator.ts` — `MigrationOrchestrator` class for coordinating migration
- `packages/core/src/first-run.ts` — `FirstRunExperience` class for setup wizard logic
- `packages/core/src/__tests__/migration-orchestrator.test.ts` — Migration orchestrator tests
- `packages/core/src/__tests__/first-run.test.ts` — First-run experience tests
- `packages/cli/src/commands/project.ts` — Project management CLI commands (if KB-503 incomplete)

### Modified Files
- `packages/core/src/index.ts` — Export new migration and first-run classes
- `packages/cli/src/bin.ts` — Add `--project` flag support and migration hooks
- `packages/cli/src/commands/dashboard.ts` — Integrate first-run wizard into dashboard startup
- `packages/dashboard/app/root.tsx` — Add first-run modal/wizard component
- `packages/dashboard/app/hooks/useProjects.ts` — New hook for project management

## Steps

### Step 1: Migration Orchestrator

- [ ] Create `packages/core/src/migration-orchestrator.ts`:
  - `MigrationOrchestrator` class taking `CentralCore` and options
  - `detectExistingProjects(startPath: string): Promise<DetectedProject[]>` — walk filesystem looking for `.fusion/fusion.db`
    - Starting from `startPath` (default: homedir or current working directory)
    - Recursively search subdirectories (max depth 5)
    - Skip node_modules, .git, and hidden directories
    - Return array of { path, name: basename(path), hasDb: boolean }
  - `autoRegisterProjects(detected: DetectedProject[]): Promise<RegisteredProject[]>`
    - Filter to projects with `.fusion/fusion.db` (valid kb projects)
    - Skip if already registered in `ProjectRegistry`
    - Generate unique project names from directory basename (append number if conflict)
    - Register with `isolationMode: 'in-process'` (default for migrated projects)
    - Set `status: 'active'`
    - Return array of newly registered projects
  - `needsMigration(): Promise<boolean>` — check if central DB exists and has any projects
  - `runMigration(options?: MigrationOptions): Promise<MigrationResult>`
    - Full orchestration: detect → register → validate
    - Options: `autoDetectPath`, `autoRegister`, `dryRun`
    - Returns: { projectsDetected, projectsRegistered, projectsSkipped, errors }
- [ ] Implement safety checks:
  - Verify `.fusion/fusion.db` exists before registering (not just `.fusion` directory)
  - Validate project paths are absolute and resolved
  - Check for circular registrations (project inside another registered project)
  - Maximum 100 projects auto-registered (safety limit)
- [ ] Write comprehensive tests:
  - Detection with various directory structures
  - Auto-registration with name conflicts
  - Duplicate detection (already registered)
  - Safety limit enforcement
  - Error handling for invalid paths
- [ ] Run targeted tests: `pnpm test packages/core/src/__tests__/migration-orchestrator.test.ts`

**Artifacts:**
- `packages/core/src/migration-orchestrator.ts` (new)
- `packages/core/src/__tests__/migration-orchestrator.test.ts` (new)

### Step 2: First-Run Experience

- [ ] Create `packages/core/src/first-run.ts`:
  - `FirstRunExperience` class taking `CentralCore`, `GlobalSettingsStore`
  - `isFirstRun(): Promise<boolean>` — check if central DB is fresh (no projects registered)
  - `detectOrCreateInitialProject(): Promise<{ type: 'detected' | 'created' | 'manual'; project?: RegisteredProject }>`
    - First, try to detect existing kb project from `process.cwd()`
    - If found, auto-register it (this is the common case: user in their project dir)
    - If not found, check if we should create a new project here
    - Return appropriate guidance for the UI
  - `getSetupState(): Promise<SetupState>` — returns full first-run state:
    - `isFirstRun: boolean`
    - `hasDetectedProjects: boolean`
    - `detectedProjects: DetectedProject[]`
    - `registeredProjects: RegisteredProject[]`
    - `recommendedAction: 'auto-detect' | 'manual-setup' | 'create-new'`
  - `completeSetup(projects: ProjectSetupInput[]): Promise<RegisteredProject[]>`
    - Finalize first-run by registering selected projects
    - Mark setup as complete in global settings
- [ ] Create `SetupWizardData` types for UI communication:
  - `ProjectSetupInput` — { path, name, isolationMode }
  - `SetupState` — full state type for wizard
  - `SetupCompletionResult` — { success, projects, nextSteps }
- [ ] Write tests for:
  - First-run detection (empty central DB)
  - Project detection from CWD
  - Setup completion flow
  - Idempotency (running twice doesn't duplicate)
- [ ] Run targeted tests: `pnpm test packages/core/src/__tests__/first-run.test.ts`

**Artifacts:**
- `packages/core/src/first-run.ts` (new)
- `packages/core/src/__tests__/first-run.test.ts` (new)

### Step 3: Backward Compatibility Layer

- [ ] Update `packages/core/src/index.ts`:
  - Export `MigrationOrchestrator`, `FirstRunExperience`, and related types
  - Export factory functions `createMigrationOrchestrator()`, `createFirstRunExperience()`
- [ ] Create backward-compatible store initialization in `packages/core/src/store.ts`:
  - Add `TaskStore.getOrCreateForProject(projectId?: string): Promise<TaskStore>`
    - If `projectId` provided: look up in central registry, create store for that path
    - If no `projectId` and single project registered: use that project
    - If no `projectId` and multiple projects: throw requiring explicit selection
    - If no central DB available: fall back to legacy behavior (current directory)
  - Maintain existing `new TaskStore(rootDir)` constructor for direct use
- [ ] Ensure `TaskStore` events still work without central core:
  - Single-project mode should not require `CentralCore` to be initialized
  - Events emit locally even without global activity feed
- [ ] Write tests for backward compatibility:
  - Store works without central database (legacy mode)
  - Store auto-detects project when only one registered
  - Store requires explicit project when multiple registered
- [ ] Run targeted tests: `pnpm test packages/core/src/store.test.ts` (backward compat section)

**Artifacts:**
- `packages/core/src/index.ts` (modified — exports)
- `packages/core/src/store.ts` (modified — backward compat methods)

### Step 4: CLI Integration

- [ ] Update `packages/cli/src/bin.ts`:
  - Add `--project <id>` global flag to all commands
  - Add migration check before executing commands:
    ```typescript
    // Before running any command
    const centralCore = createCentralCore();
    const migration = createMigrationOrchestrator(centralCore);
    
    if (await migration.needsMigration()) {
      const firstRun = createFirstRunExperience(centralCore);
      const state = await firstRun.getSetupState();
      
      if (state.isFirstRun && state.hasDetectedProjects) {
        // Auto-migrate detected projects
        const result = await migration.runMigration({ autoRegister: true });
        console.log(`Auto-registered ${result.projectsRegistered.length} projects`);
      }
    }
    ```
  - Handle `--project` flag resolution:
    - Look up project by ID in central registry
    - If not found, try to match by path
    - If no project specified and only one exists: use it
    - If no project specified and multiple exist: show error with available projects
- [ ] If KB-503 not complete, create basic `packages/cli/src/commands/project.ts`:
  - `runProjectList()` — list registered projects
  - `runProjectRegister(path, name?, options?)` — register a new project
  - `runProjectUnregister(id)` — remove from registry
  - Wire these to `fn project list`, `fn project register`, etc.
- [ ] Write tests for CLI integration:
  - `--project` flag resolution
  - Auto-migration on first command
  - Error messages for missing project selection
- [ ] Run targeted tests: `pnpm test packages/cli/src/bin.test.ts` (if exists) or manual verification

**Artifacts:**
- `packages/cli/src/bin.ts` (modified — migration hooks, --project flag)
- `packages/cli/src/commands/project.ts` (new or modified)

### Step 5: Dashboard First-Run Wizard

- [ ] Create `packages/dashboard/app/hooks/useProjects.ts`:
  - `useProjects()` hook returning:
    - `projects: RegisteredProject[]`
    - `currentProject: RegisteredProject | undefined`
    - `setCurrentProject(id: string)`
    - `isLoading`, `error`
  - Integrate with existing `useTaskStore` (project-scoped)
  - Poll `/api/projects` endpoint (from KB-502 or create stub)
- [ ] Update `packages/dashboard/app/root.tsx`:
  - Add first-run detection on app mount:
    ```typescript
    useEffect(() => {
      fetch('/api/setup-state')
        .then(r => r.json())
        .then(state => {
          if (state.isFirstRun) {
            setShowSetupWizard(true);
          }
        });
    }, []);
    ```
  - Add `SetupWizard` modal component (import from KB-502 or create stub)
  - If KB-502 not complete, create minimal stub wizard:
    - Shows detected projects
    - Allows selecting which to register
    - One "Complete Setup" button
- [ ] Create `/api/setup-state` endpoint in dashboard API:
  - Returns `SetupState` from `FirstRunExperience.getSetupState()`
  - POST `/api/complete-setup` to finalize
- [ ] Write tests for:
  - First-run wizard appearance
  - Project selection flow
  - Setup completion API
- [ ] Run targeted tests: `pnpm test packages/dashboard` (wizard flow)

**Artifacts:**
- `packages/dashboard/app/hooks/useProjects.ts` (new)
- `packages/dashboard/app/root.tsx` (modified — first-run detection)
- Dashboard API routes for setup (new or modified from KB-502)

### Step 6: Integration Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full core test suite: `pnpm test packages/core`
- [ ] Run full engine test suite: `pnpm test packages/engine`
- [ ] Run full CLI test suite: `pnpm test packages/cli`
- [ ] Run full dashboard test suite: `pnpm test packages/dashboard`
- [ ] Build passes: `pnpm build`
- [ ] Manual integration test scenarios:
  1. **Fresh install (new user)**: No `~/.pi/kb/kb-central.db`, no projects
     - Run `fn dashboard` → should show setup wizard
     - Create first project → should register and continue
  2. **Existing single-project user**: Has `.fusion/fusion.db` in current directory
     - Run `fn task list` → should auto-register project
     - No setup wizard should appear (auto-migrated)
  3. **Existing multi-project user**: After KB-500/501, has central DB
     - Run `fn task list --project <id>` → should use specified project
     - Run `fn task list` with multiple projects → should require explicit selection
  4. **Legacy mode (no central DB access)**: Corrupt or missing central DB
     - kb should fall back to single-project mode
     - Warning logged but commands still work

### Step 7: Documentation & Delivery

- [ ] Add JSDoc comments to all public methods in migration and first-run classes
- [ ] Update `AGENTS.md` — Document the migration architecture:
  - **Migration Overview**: How auto-migration works on first run
  - **Backward Compatibility**: How single-project mode is preserved
  - **First-Run Wizard**: Setup flow for new users
  - **Troubleshooting**: How to manually trigger migration, recovery options
- [ ] Create changeset for the feature:
    ```bash
    cat > .changeset/multi-project-migration.md << 'EOF'
    ---
    "@kb/core": minor
    "@kb/engine": minor
    "@dustinbyrne/kb": minor
    ---
    
    Add migration and first-run experience for multi-project support
    
    - Auto-detect and register existing kb projects on first run
    - Backward-compatible single-project mode
    - Interactive first-run setup wizard in dashboard
    - `--project` flag for CLI multi-project support
    - Graceful fallback when central database unavailable
    EOF
    ```
- [ ] Include changeset in commit
- [ ] Out-of-scope findings created as new tasks via `task_create` tool:
  - Any UI improvements beyond basic wizard (belongs in KB-502)
  - Advanced project management CLI (belongs in KB-503)

## Documentation Requirements

**Must Update:**
- `packages/core/src/index.ts` — Add exports for new public API
- `AGENTS.md` — Add section on "Multi-Project Migration" describing:
  - Auto-migration behavior on first run after update
  - How existing projects are auto-registered
  - Backward compatibility guarantees
  - First-run wizard flow
  - `--project` flag usage

**Check If Affected:**
- `README.md` — Update quickstart if it changes significantly
- `packages/cli/README.md` — Document `--project` flag
- `packages/dashboard/README.md` — Document first-run wizard

## Completion Criteria

- [ ] `MigrationOrchestrator` can detect existing projects from filesystem
- [ ] Auto-migration registers detected projects automatically on first run
- [ ] `FirstRunExperience` provides setup wizard state and completion
- [ ] Dashboard shows first-run wizard when no projects registered
- [ ] CLI supports `--project` flag for all commands
- [ ] Backward compatibility: single-project mode works without central DB
- [ ] All test scenarios pass (fresh install, existing user, legacy mode)
- [ ] All tests passing (>80% coverage for new files)
- [ ] Build passes with no TypeScript errors
- [ ] Documentation updated
- [ ] Changeset created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-504): complete Step N — description`
  - Example: `feat(KB-504): complete Step 1 — MigrationOrchestrator with project detection`
- **Bug fixes:** `fix(KB-504): description`
- **Tests:** `test(KB-504): description`
- **Docs:** `docs(KB-504): description`

## Do NOT

- Delete or modify existing `.fusion` directories during migration (only register them)
- Break existing single-project workflows
- Require users to manually migrate their data
- Skip the first-run wizard for new users (they must complete setup)
- Auto-register projects without `.fusion/fusion.db` (must be valid kb projects)
- Allow more than 100 projects in auto-detection (safety limit)
- Remove legacy `TaskStore` constructor or behavior
- Skip tests for backward compatibility scenarios
- Modify the core SQLite schema (that's KB-500)
- Implement full dashboard UI (that's KB-502 — only wire up the wizard)
- Implement full CLI project commands (that's KB-503 — only add basics if needed)

## Security Considerations

- Validate all auto-detected paths (must contain `.fusion/fusion.db`)
- Prevent path traversal in project detection (sanitize paths before resolving)
- Reject projects inside other registered projects (circular detection)
- Don't expose absolute paths in UI (show relative or project names only)
- Limit auto-detection depth (max 5 levels) to prevent performance issues
- Cap auto-registered projects at 100 (prevent accidental mass-registration)
- Require explicit user confirmation in first-run wizard before registering

## Recovery & Rollback

If migration fails or causes issues:

1. **Disable auto-migration**: Set `KB_SKIP_MIGRATION=1` environment variable
2. **Manual registration**: Use `kb project register <path>` after KB-503 completes
3. **Reset central DB**: Delete `~/.pi/kb/kb-central.db` (loses project registry only, not project data)
4. **Legacy mode**: If central DB is missing, kb falls back to single-project mode automatically
