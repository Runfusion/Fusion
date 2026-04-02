# Task: KB-342 - Add multi-project support with central core and per-project executors

**Created:** 2026-03-31
**Size:** L

## Review Level: 3 (Full)

**Assessment:** This is a major architectural transformation touching the core database layer, engine runtime, dashboard UI, CLI, and migration paths. High blast radius, novel patterns for multi-tenancy, security implications around project isolation, and requires careful reversibility planning.
**Score:** 7/8 — Blast radius: 2, Pattern novelty: 2, Security: 2, Reversibility: 1

## Mission

Transform kb from a single-project tool into a multi-project system where each project has its own board, tasks, agents, and executor instance, all reporting back to a central core. This is a meta-tracking task that has been broken down into 5 subtasks.

## Dependencies

- **None** (parent tracking task)

## Child Tasks

This task has been broken down into the following subtasks that must be completed in order:

1. **KB-001: Core Infrastructure** — Central database (`~/.pi/kb/kb-central.db`), project registry, unified activity feed, global concurrency limits, project health tracking
   - No dependencies
   - Status: todo

2. **KB-002: Per-Project Runtime Abstraction** — ProjectRuntime interface, InProcessRuntime, ChildProcessRuntime with IPC protocol, lifecycle management
   - Depends on: KB-001
   - Status: triage

3. **KB-003: Dashboard Multi-Project UX** — Overview page, project health cards, drill-down navigation, setup wizard, first-run experience
   - Depends on: KB-002
   - Status: triage

4. **KB-346: CLI Multi-Project Commands** — `fn project` subcommands (list, add, remove, info), `--project` flag, auto-detection
   - Depends on: KB-002  
   - Status: triage

5. **KB-347: Migration and First-Run Experience** — Auto-migration from single-project, backward compatibility, setup wizard
   - Depends on: KB-001, KB-002, KB-003, KB-346
   - Status: triage

## Architecture Overview

### Central Core (`~/.pi/kb/kb-central.db`)
A new SQLite database acting as the system-wide hub:
- **Project registry** — name, working directory, status (active/paused/errored), isolation mode
- **Unified activity feed** — aggregated task events across all projects with project attribution
- **Global concurrency limits** — system-wide max concurrent agents cap
- **Project health tracking** — status indicators, in-flight task counts, last activity
- **Resource monitoring** — CPU, memory, and API usage per project

### Per-Project Runtime
Each registered project gets its own scoped engine components:
- `TaskStore` (pointing to the project's `.fusion/fusion.db`)
- `TaskExecutor`, `TriageProcessor`, `Scheduler`, `WorktreePool`, etc.
- Components report events back to the central core

### Executor Lifecycle (Hybrid Model)
- **Default: in-process** — project components run inside main dashboard Node process
- **Opt-in: child process isolation** — projects run in separate Node process via IPC
- Central core abstracts over both modes with uniform `ProjectRuntime` interface

## Dashboard UX

### Overview Page (Home)
- Shows all registered projects with health cards
- Unified activity feed timeline across all projects
- Global concurrency usage indicator
- "Add Project" button triggers setup wizard

### Project Drill-Down
- Clicking a project enters the existing full board view, scoped to that project
- All existing views work as-is within a project context

### First Run Experience
- Interactive setup wizard when no projects are registered
- Auto-migration path for existing `.fusion/` directories

## CLI Changes

### New `fn project` subcommands:
- `fn project list` — list all registered projects
- `fn project add [dir]` — register new project (interactive wizard)
- `fn project remove <name>` — unregister project
- `fn project info [name]` — show project details

### Existing commands:
- Auto-detect project from cwd (walk up to find `.fusion/`)
- `--project <name>` flag on all task/settings commands

## Migration
- Auto-create central DB on first run post-upgrade
- Auto-register existing `.fusion/` directory as a project
- Fully backward-compatible for single-project users

## Context to Read First

- `packages/core/src/store.ts` — Current TaskStore architecture
- `packages/core/src/db.ts` — SQLite database patterns
- `packages/engine/src/scheduler.ts` — Current scheduler implementation
- `packages/engine/src/executor.ts` — TaskExecutor lifecycle
- `packages/dashboard/app/api.ts` — Dashboard API client
- `packages/cli/src/bin.ts` — CLI command structure

## File Scope

This parent task spans multiple packages. See individual subtasks for specific file scopes:

- KB-001: `packages/core/src/central-core.ts` (new), schema definitions
- KB-002: `packages/engine/src/project-runtime.ts` (new), `packages/engine/src/ipc/` (new)
- KB-003: `packages/dashboard/app/routes/overview.tsx` (new), routing changes
- KB-346: `packages/cli/src/commands/project.ts` (new)
- KB-347: Migration logic in `packages/core/src/db-migrate.ts`

## Steps

### Step 1: Execute Subtask KB-001

- [ ] KB-001: Core Infrastructure complete
- [ ] Central database schema implemented
- [ ] Project registry API functional
- [ ] Tests passing

### Step 2: Execute Subtask KB-002

- [ ] KB-002: Per-Project Runtime Abstraction complete
- [ ] ProjectRuntime interface defined
- [ ] Both in-process and child-process modes working
- [ ] IPC protocol functional
- [ ] Tests passing

### Step 3: Execute Subtasks KB-003 and KB-346 (parallel)

- [ ] KB-003: Dashboard Multi-Project UX complete
- [ ] KB-346: CLI Multi-Project Commands complete
- [ ] Both dashboard and CLI can manage multiple projects
- [ ] Tests passing

### Step 4: Execute Subtask KB-347

- [ ] KB-347: Migration and First-Run Experience complete
- [ ] Auto-migration from single-project tested
- [ ] Backward compatibility verified
- [ ] Tests passing

### Step 5: Integration Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] All 5 subtasks complete
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`
- [ ] Manual end-to-end testing of multi-project flow

### Step 6: Documentation & Delivery

- [ ] Update AGENTS.md with multi-project architecture
- [ ] Update README.md with new CLI commands
- [ ] Create changeset for the feature
- [ ] Out-of-scope findings created as new tasks via `task_create` tool

## Documentation Requirements

**Must Update:**
- `AGENTS.md` — Document new central core architecture, ProjectRuntime interface, IPC protocol
- `README.md` — Add `fn project` commands to CLI reference

**Check If Affected:**
- `packages/core/src/index.ts` — Export new types (CentralCore, ProjectRuntime, etc.)
- `packages/engine/src/index.ts` — Export new runtime classes

## Completion Criteria

- [ ] All 5 subtasks (KB-001, KB-002, KB-003, KB-346, KB-347) complete
- [ ] All tests passing
- [ ] Documentation updated
- [ ] Multi-project system functional end-to-end
- [ ] Backward compatibility verified

## Git Commit Convention

Since this is a parent tracking task, commits should be made in the individual subtasks:
- **KB-001 commits:** `feat(KB-001): ...`
- **KB-002 commits:** `feat(KB-002): ...`
- etc.

Parent task KB-342 will be marked complete when all subtasks are done.

## Do NOT

- Implement changes directly in KB-342 (use subtasks)
- Skip the dependency order (KB-001 → KB-002 → KB-003/KB-346 → KB-347)
- Modify files outside the scopes defined in subtasks
- Break backward compatibility without migration path
- Skip child-process isolation testing (critical for reliability)
