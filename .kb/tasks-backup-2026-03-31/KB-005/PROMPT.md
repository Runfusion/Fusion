# Task: KB-005 - Migration and First-Run Experience: Auto-migration and backward compatibility

**Created:** 2026-03-31
**Size:** L

## Review Level: 3 (Full)

**Assessment:** This is a complex integration task bridging legacy single-project architecture with a new multi-project central infrastructure. It involves data migration, CLI UX, dashboard API integration, extension modifications, and backward compatibility across the entire stack. The blast radius spans all packages (core, CLI, dashboard). Security concerns around path validation during project discovery require full review. This is a foundational transformation that affects all user workflows.

**Score:** 7/8 — Blast radius: 2, Pattern novelty: 2, Security: 2, Reversibility: 1

## Mission

Create a seamless migration and first-run experience that bridges kb's legacy single-project architecture with the new multi-project central infrastructure. This task implements:

1. **Automatic project discovery and registration** — Detect existing projects with `.fusion/` directories and register them in a central project registry
2. **First-run wizard** — New installations and upgrades present a guided setup experience  
3. **Backward compatibility** — Legacy single-project workflows continue working without changes during transition
4. **Idempotent migration** — Running migration multiple times is safe and won't duplicate data

**CRITICAL PREREQUISITE:** This task **CANNOT** be implemented until KB-001 through KB-004 are complete with working code. The current codebase does not have the multi-project infrastructure this task builds upon.

## Current vs. Target Architecture

**Current Architecture (as of today):**
- Single-project only — each project has its own `.fusion/fusion.db` SQLite database
- No central registry — projects are isolated with no cross-project awareness
- CLI works on current working directory only
- Dashboard shows one project at a time

**Target Architecture (after KB-001 through KB-004 complete):**
- **Central registry database** at `~/.fusion/fusion.db` with `projects` table (KB-001)
- **Per-project databases** remain at `<project>/.fusion/fusion.db` for actual data (KB-002)
- `ProjectStore` manages central registry (KB-001/KB-002)
- Dashboard shows multi-project overview (KB-003)
- CLI supports `--project` flag and `fn project` commands (KB-004)

**This Task (KB-005):** Builds the migration layer between these two architectural states and the first-run experience that guides users through the transition.

## Dependencies — BLOCKING

> **⚠️ CRITICAL: Do not begin KB-005 until ALL of the following are complete with verified, working implementations.**

| Task | Required Deliverable | Verification Command |
|------|---------------------|----------------------|
| **KB-001** | Central database at `~/.fusion/fusion.db` with `projects` table | `test -f ~/.fusion/fusion.db && sqlite3 ~/.fusion/fusion.db ".schema projects"` |
| **KB-001** | `Project` type with `id`, `name`, `path`, `enabled`, `createdAt`, `updatedAt` | `grep -q "export interface Project" packages/core/src/types.ts` |
| **KB-002** | `ProjectStore` class with CRUD methods | `test -f packages/core/src/project-store.ts` |
| **KB-002** | `ProjectRuntime` interface for per-project operations | `test -f packages/core/src/project-runtime.ts` |
| **KB-003** | Dashboard `ProjectOverview` component | `test -f packages/dashboard/app/components/ProjectOverview.tsx` |
| **KB-003** | Dashboard `ProjectSetupWizard` component | `test -f packages/dashboard/app/components/ProjectSetupWizard.tsx` |
| **KB-004** | CLI `fn project` subcommands | `./packages/cli/dist/bin.js project --help` works |
| **KB-004** | CLI `--project` flag support | `grep -q "\-\-project" packages/cli/src/bin.ts` |

**If any dependency is incomplete, STOP and do not proceed with KB-005.**

## Context to Read First

**Current Codebase (exists now):**
1. `/packages/core/src/db.ts` — Per-project SQLite database (`.fusion/fusion.db` within each project)
2. `/packages/core/src/db-migrate.ts` — Legacy file-based → SQLite migration logic
3. `/packages/core/src/store.ts` — TaskStore with `init()` that runs per-project migration
4. `/packages/core/src/global-settings.ts` — User-level settings at `~/.pi/kb/settings.json`
5. `/packages/cli/src/bin.ts` — CLI command structure (single-project only)
6. `/packages/cli/src/extension.ts` — Pi extension tools (uses `cwd` only, no project awareness)
7. `/packages/cli/src/commands/task.ts` — Task command implementations

**Expected After Dependencies (must exist before starting KB-005):**
1. `/packages/core/src/project-store.ts` — Central project registry operations (KB-001/KB-002)
2. `/packages/core/src/project-runtime.ts` — Per-project runtime abstraction (KB-002)
3. `/packages/dashboard/app/components/ProjectOverview.tsx` — Multi-project dashboard (KB-003)
4. `/packages/dashboard/app/components/ProjectSetupWizard.tsx` — Project registration UI (KB-003)

## File Scope

### New Files (Core)
- `packages/core/src/project-discovery.ts` — Project discovery and auto-registration logic
- `packages/core/src/first-run.ts` — First-run detection using central database `__meta` table
- `packages/core/src/migration-multi-project.ts` — Multi-project migration orchestrator

### New Files (CLI)
- `packages/cli/src/commands/project.ts` — Project management commands (`fn project list`, `fn project add`, `fn project remove`, `fn project discover`, `fn project status`)

### Modified Files (Core)
- `packages/core/src/store.ts` — Enhance `init()` with auto-discovery hook
- `packages/core/src/index.ts` — Export new migration and discovery utilities

### Modified Files (CLI)
- `packages/cli/src/bin.ts` — Add `init` command, first-run detection, `--skip-first-run` flag
- `packages/cli/src/extension.ts` — Add project-aware tools (`kb_project_list`, `kb_project_add`, `kb_project_discover`)

### Modified Files (Dashboard)
- `packages/dashboard/app/api.ts` — Add migration endpoints (`/api/migration/status`, `/api/migration/run`, `/api/migration/discover`)

### Tests
- `packages/core/src/project-discovery.test.ts`
- `packages/core/src/first-run.test.ts`
- `packages/core/src/migration-multi-project.test.ts`
- `packages/cli/src/commands/project.test.ts`

## Steps

### Step 0: Preflight — Verify All Dependencies

> **STOP HERE if any check fails. Do not proceed.**

- [ ] KB-001 verified: Central database `~/.fusion/fusion.db` exists with `projects` table
- [ ] KB-001 verified: `Project` type exists in `packages/core/src/types.ts`
- [ ] KB-002 verified: `packages/core/src/project-store.ts` exists with `ProjectStore` class
- [ ] KB-002 verified: `packages/core/src/project-runtime.ts` exists
- [ ] KB-003 verified: `packages/dashboard/app/components/ProjectOverview.tsx` exists
- [ ] KB-003 verified: `packages/dashboard/app/components/ProjectSetupWizard.tsx` exists
- [ ] KB-004 verified: CLI has `fn project` command (run `./packages/cli/dist/bin.js project --help`)
- [ ] KB-004 verified: CLI has `--project` flag support
- [ ] All existing tests pass: `pnpm test` returns zero failures

**If any check fails, do not proceed. The multi-project infrastructure is not ready.**

### Step 1: Project Discovery Engine

Create the project discovery system that scans for existing kb projects:

- [ ] Create `packages/core/src/project-discovery.ts`:
  ```typescript
  export interface DiscoveredProject {
    path: string;           // Absolute path to project root
    name: string;           // Directory name or git repo name
    hasKbDir: boolean;      // Has .fusion/ directory
    hasGitRepo: boolean;    // Has .git/ directory
    taskCount: number;      // Number of tasks found
    lastActivity: Date;     // Most recent task update
    alreadyRegistered: boolean; // Already in central registry
  }
  
  export interface DiscoveryOptions {
    scanPaths: string[];    // Paths to scan
    maxDepth: number;       // Max directory depth (default: 3)
    excludePatterns: RegExp[]; // Patterns to exclude
  }
  
  export async function discoverProjects(
    centralDb: Database,
    options: DiscoveryOptions
  ): Promise<DiscoveredProject[]>
  
  export async function discoverInCwd(centralDb: Database): Promise<DiscoveredProject | null>
  
  export async function validateProjectPath(
    path: string,
    centralDb: Database
  ): Promise<{ valid: boolean; error?: string }>
  ```
- [ ] Implement fast directory scanning (breadth-first, early termination on deep nesting)
- [ ] Detect `.fusion/fusion.db` (SQLite) or `.fusion/tasks/` (legacy) as kb project indicators
- [ ] Read task counts from per-project `fusion.db` using `TaskStore` or direct SQLite query
- [ ] Check `alreadyRegistered` by querying central `projects` table for matching `path`
- [ ] Path validation: absolute path, exists, readable, not inside another kb project
- [ ] Default scan paths: `~/projects`, `~/code`, `~/work`, `~/src`, current working directory
- [ ] Write comprehensive tests: `packages/core/src/project-discovery.test.ts`

**Artifacts:**
- `packages/core/src/project-discovery.ts` (new)
- `packages/core/src/project-discovery.test.ts` (new)

### Step 2: First-Run State Management

Create first-run detection using the central database's `__meta` table (consistent with existing patterns in `db.ts`):

- [ ] Create `packages/core/src/first-run.ts`:
  ```typescript
  export interface FirstRunState {
    isFirstRun: boolean;
    hasLegacyProjects: boolean;
    discoveredCount: number;
    registeredCount: number;
    migrationCompleted: boolean;
    skipped: boolean;
    timestamp: string;
  }
  
  // Uses central database __meta table for persistence
  export async function detectFirstRun(centralDb: Database): Promise<FirstRunState>
  export async function markMigrationCompleted(centralDb: Database): Promise<void>
  export async function markFirstRunSkipped(centralDb: Database): Promise<void>
  export async function readFirstRunState(centralDb: Database): Promise<FirstRunState | null>
  ```
- [ ] Store state in central database `__meta` table:
  - Key: `firstRunState`, Value: JSON-serialized `FirstRunState`
  - Key: `migrationStatus`, Value: `"completed" | "skipped" | "pending"`
- [ ] Detect first-run: `projects` table is empty AND no `firstRunState` entry exists
- [ ] Detect legacy projects: run `discoverProjects()` with default scan paths
- [ ] Write tests: `packages/core/src/first-run.test.ts`

**Artifacts:**
- `packages/core/src/first-run.ts` (new)
- `packages/core/src/first-run.test.ts` (new)

### Step 3: Multi-Project Migration Orchestrator

Create the orchestrator that registers discovered projects in the central registry:

- [ ] Create `packages/core/src/migration-multi-project.ts`:
  ```typescript
  export interface MultiProjectMigrationResult {
    projectsDiscovered: number;
    projectsRegistered: number;
    projectsSkipped: number;
    errors: Array<{ path: string; error: string }>;
    legacyMigrations: Array<{ path: string; success: boolean }>;
  }
  
  export async function runMultiProjectMigration(
    centralDb: Database,
    projectStore: ProjectStore,
    discoverOptions: DiscoveryOptions
  ): Promise<MultiProjectMigrationResult>
  
  export async function migrateSingleProject(
    projectPath: string,
    projectStore: ProjectStore,
    centralDb: Database
  ): Promise<{ success: boolean; projectId?: string; error?: string }>
  ```
- [ ] Migration flow for each discovered project:
  1. Check if per-project `.fusion/fusion.db` exists (SQLite format)
  2. If not, check if legacy file-based storage exists → run `migrateFromLegacy()` from `db-migrate.ts`
  3. Register project in central registry using `projectStore.createProject()`
  4. Handle naming conflicts (duplicate names → append number: "myproject-2")
- [ ] Log migration events to central database `activityLog` table
- [ ] Ensure idempotency: check `alreadyRegistered` before registering, skip if already exists
- [ ] Write comprehensive tests: `packages/core/src/migration-multi-project.test.ts`
  - Test three-state chain: legacy files → per-project SQLite → central registry
  - Test idempotency: same result on second run
  - Test partial failure: some projects fail, others succeed
  - Test naming conflicts: auto-resolution of duplicate names

**Artifacts:**
- `packages/core/src/migration-multi-project.ts` (new)
- `packages/core/src/migration-multi-project.test.ts` (new)

### Step 4: CLI Project Commands

Create comprehensive project management commands:

- [ ] Create `packages/cli/src/commands/project.ts`:
  ```typescript
  export async function runProjectList(centralDb: Database): Promise<void>
  export async function runProjectAdd(
    path: string,
    name: string | undefined,
    projectStore: ProjectStore
  ): Promise<void>
  export async function runProjectRemove(
    id: string,
    confirm: boolean,
    projectStore: ProjectStore
  ): Promise<void>
  export async function runProjectDiscover(centralDb: Database): Promise<void>
  export async function runProjectStatus(centralDb: Database): Promise<void>
  ```
- [ ] `fn project list` — Tabular output: ID, Name, Path, Tasks, Last Activity, Status
- [ ] `fn project add <path> [--name <name>]` — Register a project with validation
- [ ] `fn project remove <id> [--yes]` — Unregister (removes from central registry only, preserves project data)
- [ ] `fn project discover` — Scan and list unregistered projects
- [ ] `fn project status` — Show current context, registered projects count, discovered but unregistered
- [ ] Add tests: `packages/cli/src/commands/project.test.ts`

**Artifacts:**
- `packages/cli/src/commands/project.ts` (new)
- `packages/cli/src/commands/project.test.ts` (new)

### Step 5: CLI First-Run Integration

Integrate first-run detection into CLI startup:

- [ ] Modify `packages/cli/src/bin.ts`:
  - Add `init` subcommand with options:
    ```
    fn init              # Interactive first-run setup
    fn init --auto       # Non-interactive mode (for CI/CD)
    fn init --scan <paths>  # Custom scan paths (comma-separated)
    fn init --yes        # Auto-confirm all prompts
    ```
  - Add global `--skip-first-run` flag to bypass first-run checks
  - Before task commands when no projects registered, check first-run state
  - Show interactive prompt when first-run detected:
    ```
    ╔════════════════════════════════════════════════════════════════╗
    ║  Welcome to Fusion (kb) Multi-Project Mode!                     ║
    ║                                                                ║
    ║  Discovered 3 existing projects:                              ║
    ║    • kb (/Users/me/projects/kb) — 42 tasks                   ║
    ║    • webapp (/Users/me/projects/webapp) — 12 tasks           ║
    ║    • api (/Users/me/projects/api) — 8 tasks                  ║
    ║                                                                ║
    ║  Run 'fn init' to register these projects                     ║
    ║  Run 'fn init --auto' to register automatically               ║
    ║  Use --skip-first-run to bypass this message                  ║
    ╚════════════════════════════════════════════════════════════════╝
    ```
- [ ] Ensure backward compatibility: without `--project` flag, use CWD if it has `.fusion/`
- [ ] Write tests for first-run detection and bypass flags

**Artifacts:**
- `packages/cli/src/bin.ts` (modified)

### Step 6: CLI Backward Compatibility

Ensure existing single-project workflows continue working:

- [ ] Implement project resolution logic:
  ```typescript
  async function resolveProjectContext(
    projectFlag: string | undefined,
    cwd: string,
    centralDb: Database
  ): Promise<{ 
    projectId: string | null;  // null = implicit single-project mode
    projectPath: string;
    isImplicit: boolean;
  }>
  ```
- [ ] Resolution priority:
  1. If `--project <id>` provided → look up in central registry
  2. If CWD has `.fusion/` and registered → use registered project
  3. If CWD has `.fusion/` but not registered → create **implicit project** (warn user)
  4. If no `.fusion/` in CWD → error with helpful message suggesting `fn project add .`
- [ ] Implicit project mode:
  - Works without central registration
  - Logs warning: "Project not registered. Run 'fn project add .' to register."
  - Allows seamless transition for existing users
- [ ] Test all `fn task` commands work without `--project` in single-project setup
- [ ] Test mixed mode: some projects registered, some using implicit mode

**Artifacts:**
- Backward compatibility layer in CLI commands
- Implicit project mode for seamless transition

### Step 7: Extension Project Tools

Add project-aware tools to the Pi extension:

- [ ] Modify `packages/cli/src/extension.ts`:
  - Add `kb_project_list` tool:
    ```typescript
    {
      name: "kb_project_list",
      description: "List all registered projects in the central registry",
      parameters: Type.Object({})
    }
    ```
  - Add `kb_project_add` tool:
    ```typescript
    {
      name: "kb_project_add",
      description: "Register a new project in the central registry",
      parameters: Type.Object({
        path: Type.String({ description: "Absolute path to project directory" }),
        name: Type.Optional(Type.String({ description: "Display name (defaults to directory name)" }))
      })
    }
    ```
  - Add `kb_project_discover` tool:
    ```typescript
    {
      name: "kb_project_discover",
      description: "Discover unregistered kb projects in common directories",
      parameters: Type.Object({})
    }
    ```
- [ ] Update existing tools with optional `projectPath` parameter:
  - `kb_task_create` — Add `projectPath` parameter (default: `ctx.cwd`)
  - `kb_task_list` — Add `projectPath` parameter for filtering
  - `kb_task_show` — Add `projectPath` parameter
- [ ] Implement multi-project cache in extension:
  ```typescript
  // Replace: const storeCache = new Map<string, TaskStore>();
  // With: keyed by project path, not just cwd
  const storeCache = new Map<string, TaskStore>(); // key: projectPath
  
  async function getStore(cwd: string, projectPath?: string): Promise<TaskStore> {
    const key = projectPath || cwd;
    // ... existing logic
  }
  ```
- [ ] Update `promptGuidelines` to mention multi-project capabilities

**Artifacts:**
- `packages/cli/src/extension.ts` (modified)

### Step 8: Dashboard Migration API

Add migration endpoints for dashboard integration:

- [ ] Modify `packages/dashboard/app/api.ts`:
  - Add `GET /api/migration/status`:
    ```typescript
    interface MigrationStatusResponse {
      isFirstRun: boolean;
      hasLegacyProjects: boolean;
      discoveredProjects: DiscoveredProject[];
      registeredProjects: number;
      migrationCompleted: boolean;
      skipped: boolean;
    }
    ```
  - Add `POST /api/migration/run`:
    - Request: `{ scanPaths?: string[], autoRegister?: boolean }`
    - Response: `MultiProjectMigrationResult`
  - Add `GET /api/migration/discover`:
    - Query: `?scanPaths=...`
    - Response: `{ projects: DiscoveredProject[] }`
  - Add `POST /api/projects/register-bulk`:
    - Request: `{ projects: Array<{ path: string; name?: string }> }`
    - Response: `{ registered: number; errors: Array<{ path: string; error: string }> }`
- [ ] Add WebSocket events for migration progress:
  - `migration:started` — Migration began
  - `migration:progress` — `{ discovered: number; registered: number; currentPath: string }`
  - `migration:completed` — Migration finished with results
- [ ] Ensure graceful error handling (200 with error details, not 500s)

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified)

### Step 9: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run all core tests: `pnpm --filter @fusion/core test` — all pass
- [ ] Run all CLI tests: `pnpm --filter @dustinbyrne/kb test` — all pass
- [ ] Run all dashboard tests: `pnpm --filter @fusion/dashboard test` — all pass
- [ ] Test the **three-state migration chain**:
  1. **State 1:** Legacy file storage (`.fusion/tasks/*/task.json`, `.fusion/config.json`)
     - Run `TaskStore.init()` → Verify SQLite per-project DB created
  2. **State 2:** Per-project SQLite (`.fusion/fusion.db` exists, no central registry)
     - Run `runMultiProjectMigration()` → Verify projects registered in central DB
  3. **State 3:** Full multi-project (central registry + per-project DBs)
     - Verify all operations work through central registry
- [ ] Test scenarios:
  1. **Fresh install:** No `~/.fusion/`, no projects → `fn init` works
  2. **Single project upgrade:** Legacy `.fusion/` → migration prompt appears
  3. **Multi-project upgrade:** 3+ projects → all discovered and registered
  4. **Idempotency:** Run migration twice → no duplicates, no errors
  5. **Backward compatibility:** `fn task list` without `--project` → works in implicit mode
  6. **CI/CD mode:** `fn init --auto` → completes without prompts
  7. **Skip first-run:** `fn task list --skip-first-run` → bypasses prompts

**Artifacts:**
- All tests passing
- Test coverage for three-state migration chain

### Step 10: Documentation & Delivery

- [ ] Update `AGENTS.md` with "Migration and First-Run" section:
  ```markdown
  ## Migration and First-Run Architecture

  ### Two-Database Architecture
  ```
  ~/.fusion/fusion.db (central registry)
  ├── projects table: id, name, path, enabled, createdAt, updatedAt
  ├── __meta table: firstRunState, migrationStatus
  └── activityLog table: migration events

  <project>/.fusion/fusion.db (per-project data)
  ├── tasks table: all task data
  ├── config table: project settings
  ├── activityLog table: project events
  └── archivedTasks table: archived task entries
  ```

  ### Three-State Migration Chain
  1. Legacy file storage → `db-migrate.ts` → Per-project SQLite
  2. Per-project SQLite → `migration-multi-project.ts` → Central registry
  3. Full multi-project mode with central registry

  ### Recovery from Failed Migration
  - Check `~/.fusion/fusion.db` for `firstRunState` in `__meta` table
  - Check per-project `.fusion/fusion.db` for data integrity
  - Re-run `fn init --auto` to retry registration
  ```
- [ ] Update `README.md` with:
  - Multi-project setup instructions
  - Upgrade guide for existing users (`fn init`)
  - `fn project` command reference
- [ ] Update `packages/cli/README.md` with `fn init` and `fn project` documentation
- [ ] Create changeset:
  ```bash
  cat > .changeset/multi-project-migration.md << 'EOF'
  ---
  "@dustinbyrne/kb": minor
  ---
  
  Add automatic migration and first-run experience for multi-project support

  - Automatic discovery and registration of existing kb projects via `fn init`
  - First-run setup wizard with interactive and auto modes
  - Backward compatibility for single-project workflows
  - New `fn project` commands: list, add, remove, discover, status
  - Two-database architecture: central registry + per-project storage
  - Extension tools for multi-project management
  - Dashboard migration API with real-time progress
  EOF
  ```
- [ ] Create `.DONE` file in task directory

**Artifacts:**
- Updated documentation with architecture diagram
- Changeset file
- `.DONE` marker file

## Documentation Requirements

**Must Update:**
- `AGENTS.md` — Add "Migration and First-Run Architecture" section with:
  - Two-database architecture diagram (central registry + per-project storage)
  - Three-state migration chain documentation
  - Recovery procedures
- `README.md` — Add "Multi-Project Setup" section with upgrade instructions
- `packages/cli/README.md` — Document `fn init` and `fn project` commands

**Check If Affected:**
- `packages/core/README.md` — Update if exporting new APIs
- `packages/dashboard/README.md` — Update with migration API endpoints

## Completion Criteria

- [ ] All steps complete (0-10)
- [ ] All tests passing (core, CLI, dashboard)
- [ ] Build passes with no TypeScript errors
- [ ] First-run detection works: new installs see setup prompt
- [ ] Three-state migration chain tested: legacy → per-project SQLite → central registry
- [ ] Auto-migration works: existing projects discovered and registered without data loss
- [ ] Backward compatibility: single-project commands work unchanged in implicit mode
- [ ] Idempotency: multiple migrations don't create duplicates
- [ ] CLI `fn init`, `fn project` commands functional
- [ ] Extension project tools functional
- [ ] Dashboard migration API and WebSocket events functional
- [ ] Documentation updated with architecture diagram and migration guide
- [ ] Changeset created for the feature

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-005): complete Step N — description`
- **Bug fixes:** `fix(KB-005): description`
- **Tests:** `test(KB-005): description`
- **Docs:** `docs(KB-005): description`

Example commits:
```
feat(KB-005): complete Step 1 — add project discovery engine
feat(KB-005): complete Step 3 — add multi-project migration orchestrator
test(KB-005): add three-state migration chain tests
docs(KB-005): add architecture documentation
```

## Do NOT

- **Do NOT** begin implementation until KB-001 through KB-004 are verified complete
- **Do NOT** delete or modify original per-project `.fusion/` directories during migration
- **Do NOT** consolidate task data into central database — keep per-project SQLite databases
- **Do NOT** require users to manually migrate each project — auto-discovery should find them
- **Do NOT** break existing scripts that use `fn task` commands without `--project`
- **Do NOT** force interactive prompts in CI/CD — support `--auto` and `--skip-first-run` flags
- **Do NOT** duplicate task data during migration — central registry stores paths only
- **Do NOT** skip tests for the three-state migration chain
- **Do NOT** register projects without user confirmation unless using `--auto` flag
- **Do NOT** use separate JSON files for state — use central database `__meta` table
- **Do NOT** commit without running the full test suite
