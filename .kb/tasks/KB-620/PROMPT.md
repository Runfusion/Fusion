# Task: KB-620 - Migration and First-Run Experience

**Created:** 2026-03-31
**Size:** M

## Review Level: 3 (Full)

**Assessment:** This task affects all existing users on first run post-upgrade, requiring careful handling of auto-migration and backward compatibility. High security considerations around auto-discovery of project directories. Pattern follows existing `db-migrate.ts` patterns but introduces new central database integration.
**Score:** 7/8 — Blast radius: 2, Pattern novelty: 1, Security: 2, Reversibility: 2

## Mission

Implement the migration and first-run experience that smoothly transitions kb from single-project mode to multi-project mode. When users upgrade to the multi-project version, the system must:

1. **Auto-detect** existing `.fusion/` directories and automatically register them in the central project registry
2. **Maintain backward compatibility** — existing single-project workflows continue working without `--project` flags
3. **Guide new users** through an interactive setup wizard when no projects exist
4. **Ensure safety** — migration is idempotent, reversible, and never deletes existing data

This task bridges the legacy single-project architecture with the new multi-project system, ensuring zero disruption to existing users while enabling the new functionality.

## Dependencies

- **Task:** KB-615 (Multi-Project Core Infrastructure) — Must provide: `CentralCore`, `ProjectRegistry`, project registration API at `~/.pi/kb/kb-central.db`
- **Task:** KB-616 (Per-Project Runtime Abstraction) — Must provide: `InProcessRuntime`, `ProjectManager`, runtime initialization patterns
- **Task:** KB-618 (Dashboard Multi-Project UX) — Must provide: Setup wizard UI components, overview page, `/api/projects` endpoints
- **Task:** KB-619 (CLI Multi-Project Commands) — Must provide: `fn project` subcommands, `--project` flag support, project resolution logic

### Dependency Fallback Strategy

Since dependencies may be incomplete, implement these placeholder interfaces in `packages/core/src/migration-stubs.ts`:

```typescript
// Stub interfaces until KB-615 completes
export interface CentralCoreStub {
  registerProject(name: string, workingDir: string, options?: { isolationMode?: string }): Promise<{ id: string; name: string; workingDirectory: string }>;
  listProjects(): Promise<Array<{ id: string; name: string; workingDirectory: string; status: string }>>;
  isProjectRegistered(workingDir: string): boolean;
}

export interface ProjectInfoStub {
  id: string;
  name: string;
  workingDirectory: string;
  status: "active" | "paused" | "errored";
  isolationMode: "in-process" | "child-process";
}
```

These stubs allow KB-620 to compile and test independently. When KB-615 completes, replace stubs with real implementations.

## Context to Read First

- `packages/core/src/db-migrate.ts` — Existing legacy→SQLite migration patterns (detect → migrate → backup)
- `packages/core/src/global-settings.ts` — Pattern for `~/.pi/kb/` directory management
- `packages/core/src/db.ts` — SQLite database initialization and WAL mode patterns
- `packages/cli/src/bin.ts` — CLI entry point, command routing (note: `fn init` does not exist yet)
- `packages/core/src/index.ts` — Current exports to understand public API surface
- `packages/core/src/db-migrate.test.ts` — Test patterns for migration testing (co-located with source)

## File Scope

### Modified Files
- `packages/core/src/db-migrate.ts` — Extend with `detectExistingProjects()`, `autoRegisterInCentralDb()`, `needsCentralMigration()`
- `packages/core/src/central-core.ts` — Add migration helpers: `autoRegisterProject()`, `getFirstRunState()` (or stubs if KB-615 incomplete)
- `packages/cli/src/bin.ts` — Add `fn init` command; add migration check on startup
- `packages/core/src/index.ts` — Export new migration functions and types

### New Files
- `packages/core/src/migration.ts` — `FirstRunDetector` class, `MigrationCoordinator` class, migration types
- `packages/core/src/migration-stubs.ts` — Stub interfaces for KB-615 dependencies (temporary, removed after KB-615)
- `packages/core/src/migration.test.ts` — Tests for auto-migration, first-run detection, idempotency
- `packages/core/src/backward-compat.test.ts` — Tests for backward compatibility layer

## Steps

### Step 0: Preflight

- [ ] Required paths exist (`packages/core/src/`, `packages/cli/src/`)
- [ ] Dependencies have stubs or implementations
- [ ] Can import from `@fusion/core` in tests

### Step 1: First-Run Detection Logic

Create the detection logic that determines the migration/startup path.

- [ ] Create `packages/core/src/migration.ts` with `FirstRunDetector` class:
  - `detectFirstRunState(): Promise<FirstRunState>` — returns one of:
    - `"fresh-install"` — No central DB, no `.fusion/` anywhere
    - `"needs-migration"` — No central DB, but `.fusion/fusion.db` exists in cwd
    - `"setup-wizard"` — Central DB exists but has zero projects
    - `"normal-operation"` — Central DB exists with projects
  - `detectExistingProjects(cwd: string): Promise<DetectedProject[]>` — Walk filesystem looking for `.fusion/fusion.db`
    - Start from `cwd` (default: `process.cwd()`)
    - Walk up directory tree to find `.fusion/fusion.db` (stop at home or root)
    - Return: `{ path: string, name: string, hasDb: boolean }`
  - `hasCentralDb(): boolean` — Check `~/.pi/kb/kb-central.db` exists
  - `getCentralDbPath(): string` — Returns `~/.pi/kb/kb-central.db`
- [ ] Define types in `packages/core/src/migration.ts`:
  - `type FirstRunState = "fresh-install" | "needs-migration" | "setup-wizard" | "normal-operation"`
  - `interface DetectedProject { path: string; name: string; hasDb: boolean }`
  - `interface MigrationResult { success: boolean; projectsRegistered: string[]; errors: string[] }`
- [ ] Create `MigrationCoordinator` class in `packages/core/src/migration.ts`:
  - Constructor takes `centralCore: CentralCoreStub`
  - `coordinateMigration(): Promise<MigrationResult>` — Orchestrates full migration flow
  - `registerSingleProject(projectPath: string): Promise<MigrationResult>` — For auto-migration
  - `completeSetup(projects: ProjectSetupInput[]): Promise<MigrationResult>` — For setup wizard
- [ ] Write tests in `packages/core/src/migration.test.ts`:
  - Test fresh install detection (no central DB, no local .fusion/)
  - Test migration-needed detection (local .fusion/ exists, no central DB)
  - Test setup-wizard detection (central DB exists, empty)
  - Test normal operation detection (central DB exists with projects)
  - Test project detection walking up directory tree
  - Test `MigrationCoordinator` orchestration flow
- [ ] Run targeted tests: `pnpm test packages/core/src/migration.test.ts`

**Artifacts:**
- `packages/core/src/migration.ts` (new)
- `packages/core/src/migration.test.ts` (new)

### Step 2: Auto-Migration to Central Database

Extend the existing migration system to handle single-project → multi-project migration.

- [ ] Extend `packages/core/src/db-migrate.ts`:
  - Add `needsCentralMigration(cwd: string): boolean` — Returns true if:
    - Central DB doesn't exist AND
    - `cwd` has `.fusion/fusion.db` (existing single-project)
  - Add `detectExistingProjects(cwd: string): Promise<DetectedProject[]>` — Walk up from cwd, find `.fusion/fusion.db`
  - Add `autoMigrateToCentral(existingProjectPath: string, centralCore: CentralCoreStub): Promise<MigrationResult>`:
    1. Generate project name from git remote (strip `.git`, take repo name) or directory basename
    2. Call `centralCore.registerProject(name, existingProjectPath, { isolationMode: "in-process" })`
    3. Return migration result with registered project ID
- [ ] Extend `packages/core/src/central-core.ts` (or create stub in `migration-stubs.ts` if KB-615 incomplete):
  - Add `autoRegisterProject(projectPath: string): Promise<ProjectInfoStub>`:
    - Generate name from git remote: `git remote get-url origin` → extract repo name
    - Fallback to directory basename
    - Ensure unique name (append `-N` if conflict)
    - Register with `isolationMode: "in-process"`, `status: "active"`
    - Return registered project
  - Add `getFirstRunState(): Promise<FirstRunState>` — Delegate to `FirstRunDetector`
- [ ] Ensure idempotency:
  - Re-running migration with existing central DB → no-op
  - Re-running migration for already-registered project → skip with info log
  - Add `isProjectRegistered(projectPath: string): boolean` check
- [ ] Write tests in `packages/core/src/migration.test.ts`:
  - Test auto-migration registers project correctly
  - Test idempotent migration (run twice, second is no-op)
  - Test project name generation from git remote
  - Test project name fallback to directory name
  - Test duplicate name handling (appends `-1`, `-2`, etc.)
- [ ] Run targeted tests: `pnpm test packages/core/src/migration.test.ts`

**Artifacts:**
- `packages/core/src/db-migrate.ts` (modified — add central migration functions)
- `packages/core/src/central-core.ts` (modified — add migration helpers, or stubs file)
- `packages/core/src/migration-stubs.ts` (new — if KB-615 incomplete)

### Step 3: Backward Compatibility Layer

Ensure single-project users experience zero behavior change.

- [ ] Update `packages/core/src/migration.ts` with `BackwardCompat` helper:
  - Add `resolveProjectContext(cwd: string, projectId?: string): Promise<ResolvedContext>`:
    - If `projectId` provided → look up in central registry, return that project
    - If no `projectId` and single project registered → auto-use that project
    - If no `projectId` and multiple projects → throw `ProjectRequiredError`
    - If no central DB available → return legacy mode (use cwd directly)
  - Add `isLegacyMode(): boolean` — Returns true if central DB unavailable
  - Define `ResolvedContext` interface: `{ projectId: string; workingDirectory: string; isLegacy: boolean }`
- [ ] Update `packages/core/src/store.ts` (if needed) to support backward-compatible initialization:
  - Ensure `TaskStore` constructor still works with just `rootDir`
  - No breaking changes to existing `TaskStore` API
- [ ] Write tests in `packages/core/src/backward-compat.test.ts`:
  - Test single project auto-resolution (no --project flag needed)
  - Test multiple projects requires explicit selection
  - Test legacy mode works without central database
  - Test error message when multiple projects and no selection
- [ ] Run targeted tests: `pnpm test packages/core/src/backward-compat.test.ts`

**Artifacts:**
- `packages/core/src/migration.ts` (modified — add backward compat helpers)
- `packages/core/src/backward-compat.test.ts` (new)

### Step 4: CLI Integration — fn init Command and Migration Hooks

Add `fn init` command and integrate migration into CLI startup.

- [ ] Update `packages/cli/src/bin.ts`:
  - Add `fn init` command handler:
    - Check if `.fusion/` exists in cwd → if yes, info message and exit
    - Create `.fusion/` directory with `fusion.db` (use existing Database initialization from `@fusion/core`)
    - Register project in central DB via `autoRegisterProject()`
    - Output: `Initialized kb project "X" at /path/to/project`
    - Options: `--name <name>` to override auto-detected name
  - Add migration check at startup (before executing commands, after `fn init` check):
    ```typescript
    // Skip migration check for init command itself
    if (command !== "init") {
      const detector = new FirstRunDetector();
      const state = await detector.detectFirstRunState();
      
      if (state === "needs-migration") {
        const cwd = process.cwd();
        const centralCore = await createCentralCore(); // or stub
        const result = await autoMigrateToCentral(cwd, centralCore);
        console.log(`✓ Auto-registered project: ${result.projectsRegistered[0]}`);
      }
    }
    ```
  - Add `--project` global flag handling (parse and store for command use)
- [ ] Ensure `fn init` remains idempotent:
  - If `.fusion/` already exists, skip creation
  - If project already registered, skip registration (info message: "Project already registered")
- [ ] Write integration tests in `packages/cli/src/__tests__/init.test.ts` (or co-located):
  - Test `fn init` creates `.fusion/` and registers project
  - Test migration hook runs on first command after upgrade
  - Test idempotent `fn init` (run twice, second reports already initialized)
- [ ] Run CLI tests: `pnpm test packages/cli`

**Artifacts:**
- `packages/cli/src/bin.ts` (modified — add `init` command, migration hooks)
- `packages/cli/src/init.test.ts` (new — co-located test file)

### Step 5: Dashboard First-Run Wizard Integration

Wire dashboard to use migration and setup wizard.

- [ ] Ensure dashboard API has endpoints (coordinate with KB-618 or create stubs):
  - `GET /api/setup-state` — Returns `FirstRunState` and detected projects
  - `POST /api/complete-setup` — Accepts `{ projects: ProjectSetupInput[] }`
- [ ] Create `/api/setup-state` handler in dashboard:
  - Use `FirstRunDetector` to get state
  - Return JSON: `{ state, detectedProjects, hasCentralDb }`
- [ ] Create `/api/complete-setup` handler in dashboard:
  - Accept project selections from wizard
  - Call `centralCore.registerProject()` for each
  - Return `{ success: true, registered: string[] }`
- [ ] Update dashboard root (`packages/dashboard/app/root.tsx`) to show migration prompt:
  - If state is `"needs-migration"` → Show "Migrate Project" prompt with single click
  - If state is `"setup-wizard"` → Show full setup wizard (from KB-618 or minimal stub)
  - If state is `"normal-operation"` → Show overview page
- [ ] Test dashboard flows:
  - Fresh install → setup wizard
  - Existing single project → migration prompt → overview
  - Multiple projects → overview directly

**Artifacts:**
- Dashboard API routes (new or extended from KB-618)
- Dashboard UI integration (coordinate with KB-618)

### Step 6: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run all new tests:
  - `pnpm test packages/core/src/migration.test.ts`
  - `pnpm test packages/core/src/backward-compat.test.ts`
  - `pnpm test packages/cli/src/init.test.ts`
- [ ] Run full core test suite: `pnpm test packages/core`
- [ ] Run full CLI test suite: `pnpm test packages/cli`
- [ ] Run full engine test suite: `pnpm test packages/engine`
- [ ] Build passes: `pnpm build`
- [ ] Manual integration test scenarios:
  1. **Fresh install (new user)**:
     - Delete `~/.pi/kb/kb-central.db` if exists
     - Create new empty directory, run `fn init`
     - Verify `.fusion/` created and project registered in central DB
  2. **Existing single-project user (upgrade scenario)**:
     - Delete `~/.pi/kb/kb-central.db`
     - Keep existing `.fusion/fusion.db` in test project
     - Run `fn task list` → should auto-migrate with console output
     - Verify project appears in central registry
  3. **Idempotent migration**:
     - Run `fn task list` again → no re-migration, no errors
  4. **Backward compatibility (single project)**:
     - With single project registered, run without `--project`
     - Should work seamlessly
  5. **Rollback safety**:
     - Delete `~/.pi/kb/kb-central.db`
     - Run `fn task list` in project directory → should still work (recreates or legacy mode)

**Test Coverage Requirements:**
- Migration detection: 100% of first-run states covered
- Auto-migration: register, idempotency, error handling
- Backward compat: single project auto-resolve, multi-project enforcement, legacy mode
- Name generation: git remote extraction, directory fallback, duplicate handling
- CLI init: create, register, idempotency

### Step 7: Documentation & Delivery

- [ ] Add JSDoc to all public methods in `migration.ts`
- [ ] Update `packages/core/src/index.ts` exports:
  - Export `FirstRunDetector`, `MigrationCoordinator`, `BackwardCompat`
  - Export types: `FirstRunState`, `DetectedProject`, `MigrationResult`, `ResolvedContext`
  - Export migration functions from `db-migrate.ts`
- [ ] Update `AGENTS.md` with Migration section:
  - **Auto-Migration**: How it works on first run after upgrade
  - **Backward Compatibility**: Single-project mode continues working
  - **Rollback Procedure**: Steps to recover if migration fails
    ```markdown
    ### Rollback from Multi-Project Migration

    If the central database causes issues:
    1. Delete `~/.pi/kb/kb-central.db` (this only removes the project registry)
    2. Your per-project `.fusion/fusion.db` files remain intact with all data
    3. kb will fall back to single-project legacy mode
    4. Re-run `fn init` in your project to re-register if needed
    ```
- [ ] Create changeset:
  ```bash
  cat > .changeset/multi-project-migration.md << 'EOF'
  ---
  "@fusion/core": minor
  "@gsxdsm/fusion": minor
  ---

  Add migration and first-run experience for multi-project support

  - Auto-detect and register existing projects on first run after upgrade
  - Maintain backward compatibility for single-project workflows
  - Interactive first-run setup wizard in dashboard
  - Idempotent migration — safe to re-run
  - Rollback procedure documented in AGENTS.md
  EOF
  ```
- [ ] Stage changeset with final commit
- [ ] Out-of-scope findings (create new tasks via `task_create` if found):
  - Advanced project discovery (deep filesystem scanning beyond cwd ancestors)
  - Import from other task management tools
  - Batch migration of multiple detected projects

**Artifacts:**
- `packages/core/src/index.ts` (modified — new exports)
- `AGENTS.md` (modified — add Migration section)
- `.changeset/multi-project-migration.md` (new)

## Documentation Requirements

**Must Update:**
- `AGENTS.md` — Add "Multi-Project Migration" section covering:
  - Auto-migration behavior on first run after update
  - Backward compatibility guarantees
  - Rollback procedure
- `packages/core/src/index.ts` — Export `FirstRunDetector`, `MigrationCoordinator`, `BackwardCompat`, migration types

**Check If Affected:**
- `README.md` — Update quickstart if migration flow changes user experience significantly
- `packages/cli/README.md` — Document new `fn init` command

## Completion Criteria

- [ ] All steps complete
- [ ] `FirstRunDetector` correctly identifies all four first-run states
- [ ] `MigrationCoordinator` orchestrates migration and setup flows
- [ ] Auto-migration registers existing projects automatically and idempotently
- [ ] `fn init` command creates `.fusion/` and registers projects in central database
- [ ] Backward compatibility: single-project workflows work without `--project`
- [ ] All integration test scenarios pass (fresh install, upgrade, idempotent, rollback)
- [ ] All tests passing with >80% coverage on new files
- [ ] Build passes with no TypeScript errors
- [ ] `AGENTS.md` updated with migration and rollback documentation
- [ ] Changeset created and staged

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-620): complete Step N — description`
  - Example: `feat(KB-620): complete Step 1 — FirstRunDetector with state detection`
- **Bug fixes:** `fix(KB-620): description`
- **Tests:** `test(KB-620): description`
- **Docs:** `docs(KB-620): add migration section to AGENTS.md`

## Do NOT

- Delete or modify existing `.fusion/` directories during migration (only register them)
- Break existing single-project workflows
- Require users to manually migrate their data
- Remove legacy `TaskStore` initialization patterns
- Skip the first-run wizard for fresh installs
- Auto-register projects without valid `.fusion/fusion.db` files
- Allow more than 100 projects in auto-detection (safety limit)
- Skip tests for backward compatibility scenarios
- Modify the central database schema (that's KB-615)
- Implement full dashboard UI (that's KB-618 — only wire up the integration)
- Implement full CLI project commands (that's KB-619 — only add `fn init` and migration hooks)

## Security Considerations

- **Path validation**: All auto-detected paths must contain `.fusion/fusion.db` before registration
- **Path traversal**: Sanitize and resolve all paths before storing in central DB
- **Circular registration**: Prevent projects being registered inside other projects
- **Privacy**: Don't expose absolute paths in UI (show project names, not full paths)
- **Rate limiting**: Auto-migration runs once; no repeated scanning

## Rollback Safety

If migration fails or causes issues:

1. **Delete central DB**: `rm ~/.pi/kb/kb-central.db`
   - This only removes the project registry
   - All per-project data in `.fusion/fusion.db` remains intact
   - Blob files (PROMPT.md, agent.log, attachments) remain intact

2. **Fallback behavior**: kb automatically falls back to single-project legacy mode

3. **Recovery**: Re-run `fn init` in your project directory to re-register

4. **Emergency bypass**: Set `KB_SKIP_MIGRATION=1` to disable auto-migration hooks
