# Project Guidelines

## Finalizing Changes

When making changes that affect published packages, create a changeset file:

```bash
cat > .changeset/<short-description>.md << 'EOF'
---
"@runfusion/fusion": patch
---

Short description of the change.
EOF
```

Bump types:
- **patch**: bug fixes, internal changes
- **minor**: new features, new CLI commands, new tools
- **major**: breaking changes

Include the changeset file in the same commit as the code change. The filename should be a short kebab-case description (e.g., `fix-merge-conflict.md`, `add-retry-button.md`).

Only create changesets for changes that affect the published `@runfusion/fusion` package — user-facing features, bug fixes, CLI changes, tool changes. Do NOT create changesets for internal docs (AGENTS.md, README), CI config, or refactors that don't change behavior.

## Releasing

Always use the repo release script for npm releases:

```bash
pnpm release --yes
```

Do not run `changeset version`, `pnpm publish`, manual git tags, or manual release commits as a substitute for the script. `scripts/release.mjs` is the source of truth for release flow: it performs preflight checks, applies changesets, updates the lockfile and root changelog, builds, commits the version bump, publishes npm packages, pushes `main`, and pushes the version tag.

The release script is also the required path for keeping both public npm packages in sync:
- `@runfusion/fusion`
- `runfusion.ai`

## Package Structure

- `@fusion/core` — domain model, task store (private, not published)
- `@fusion/dashboard` — web UI + API server (private, not published)
- `@fusion/engine` — AI agents: triage, executor, reviewer, merger, scheduler (private, not published)
- `@runfusion/fusion` — CLI + pi extension (published to npm)

Only `@runfusion/fusion` is published. The others are internal workspace packages.

### Importing across `@fusion/*` packages

Because `@fusion/core`, `@fusion/dashboard`, and `@fusion/engine` are **not** on npm, the published CLI bundle (`packages/cli/dist/bin.js`) only works because tsup is configured with `noExternal: [/^@fusion\//]` — every `@fusion/*` import gets inlined into the bundle.

For that inlining to happen the import must be **statically analyzable**. The following anti-pattern silently breaks on the published `npm i -g @runfusion/fusion`:

```ts
// ❌ BROKEN: variable specifier defeats static analysis
const engineModule = "@fusion/engine";
const engine = await import(/* @vite-ignore */ engineModule);
createFnAgent = engine.createFnAgent;
```

esbuild leaves the dynamic `import("@fusion/engine")` in the output, the package isn't installed at runtime, the import throws, the catch silently sets the binding to `undefined`, and the next call fails with a confusing TypeError like `createFnAgent2 is not a function` (issue Runfusion/Fusion#9, FN-2613). Affects every AI flow in the dashboard.

**Rules:**

1. **Default to a static import** — `import { createFnAgent } from "@fusion/engine"` — so esbuild can bundle it and tests can `vi.mock("@fusion/engine", …)` it.
2. **The one exception is `@fusion/core` itself**, which can't statically import engine without a circular dependency (engine → core). Core uses dependency injection: `setCreateFnAgent` (in `packages/core/src/ai-engine-loader.ts`) is called by `packages/engine/src/index.ts` at module load. Don't add new dynamic `import("@fusion/engine")` calls in core — extend the loader instead.
3. **Never reintroduce the `engineModule = "@fusion/engine"` + `await import(/* @vite-ignore */ engineModule)` trick.** If you find one, treat it as a bug.
4. Test mocking still works with static imports — vitest's module-level `vi.mock("@fusion/engine", …)` hoists above the static import.

## Storage Model

Fusion uses a hybrid storage architecture: structured metadata lives in SQLite (`.fusion/fusion.db`) while large blob files (PROMPT.md, attachments) remain on the filesystem under `.fusion/tasks/{ID}/`. The database runs in WAL mode for concurrent access.

See [docs/storage.md](./docs/storage.md) for the full storage architecture documentation.

## Multi-Project Support

Fusion supports multiple projects with a central registry at `~/.fusion/fusion-central.db`. Each project has its own SQLite database at `.fusion/fusion.db`. See [docs/multi-project.md](./docs/multi-project.md) for details on:
- CentralCore API and project registration
- Isolation modes (in-process, child-process)
- Global concurrency management

## Testing

```bash
VITEST_MAX_WORKERS=4 pnpm test  # run all tests
pnpm build         # build all packages
```

Tests are required. Typechecks and manual verification are not substitutes for real tests with assertions.

### Test File Organization

All test files have been moved into `__tests__/` subdirectories alongside the code they test:

- Test for `src/foo.ts` → `src/__tests__/foo.test.ts`
- Test for `app/components/Bar.tsx` → `app/components/__tests__/Bar.test.tsx`

When writing new tests, follow this convention. A few legacy co-located test files may remain, but `__tests__/` is the standard.

### What NOT to write

New tests should cover behavior a user could notice break, not implementation shape. Don't write:

- **CSS-class permutation tests** — iterating `status × column × flag` to assert `cardClass()` output. Use a single `it.each` for the boolean matrix, not one `it` per combination.
- **Field-presence tests** when a payload-roundtrip test for the same field already exists — toggling and asserting the save payload implicitly requires the field to be present.
- **React.memo tautologies** — `React.memo(Probe)` + rerender + assert-called-once tests React's behavior, not ours. If you need to verify a custom comparator (e.g. `areTaskCardPropsEqual`), test *that* directly — one case.
- **Mock-the-world wiring tests** — if a test mocks 8+ dependencies just to render a component, either (a) it's a legitimate glue-component test (shim child components with `() => null`), or (b) delete it and rely on an integration test one level up.
- **Structural CSS assertions** — "tab container uses .class-name not inline style". Consolidate into one aggregate layout-contract test per component.

Prefer `it.each` over copy-pasted `it()` blocks. When trimming: keep the first case + the opposite case + any precedence/override case; drop linear iterations.

### What TO keep unconditionally

- Tests linked to an FN-ticket in `describe`/`it` names — these guard real regressions.
- Integration tests exercising real SQLite, real worker pool, or spawned processes.
- Lean core/engine unit tests with low mock burden.

## Port 4040 is Reserved

Port 4040 is the production dashboard port. A user's live dashboard session is typically running there. **Agents must NEVER:**
- Run `kill`, `kill -9`, `pkill`, or `killall` against processes on port 4040
- Start a test server on port 4040 — always use `--port 0` for random free port

## Engine Process Rules

The engine (`packages/engine`) runs the executor, merger, scheduler, IPC host, and dashboard-facing activity loop on a single Node event loop. **Blocking that loop stalls every task concurrently in-flight.**

### Never use `execSync` for User-Configured Commands

`execSync` blocks the entire event loop until the child process exits. Any command from project settings — `testCommand`, `buildCommand`, `workflow step scripts`, etc. — **must** run via `promisify(exec)` with `timeout`. Never use `execSync` for user-configured commands.

```ts
import { exec } from "node:child_process";
import { promisify } from "node:util";
const execAsync = promisify(exec);

const { stdout, stderr } = await execAsync(command, {
  cwd: worktreePath,
  timeout: 120_000,
  maxBuffer: 10 * 1024 * 1024,
});
```

`execSync` is only acceptable for short, deterministic git plumbing (`git rev-parse`, `git branch -d`, `git worktree remove`, etc.). When in doubt, use async.

## Git Conventions

- Commit messages: `feat(FN-XXX):`, `fix(FN-XXX):`, `test(FN-XXX):`
- One commit per step (not per file change)
- Always include the task ID prefix

## Merging Branches Into Main

Two rules, learned the hard way (FN-2370 silently reverted three commits' work):

1. **If a branch contains commits that duplicate work already on main, rebase the branch onto main and drop the duplicates *before* merging.** This usually happens when a branch was rebased from a stale base while the same work was also landed directly on main. Subjects that match recent main commits are the tell — `git log main..branch --format=%s` should not overlap with `git log <base>..main --format=%s`. Auto-resolvers cannot tell which side of a duplicated change is canonical and will silently drop refinements from the newer side.

2. **Prefer rebase-and-merge over squash for branches spanning multiple feature commits.** Squash collapses authorship and makes per-commit reverts impossible. Rebase-and-merge preserves the commit boundary so a regression can be reverted cleanly without losing the rest of the branch.

After any squash that auto-resolved conflicts, the merging agent MUST run:

```
node scripts/audit-squash-merge.mjs <squash-sha>
```

The agent then reviews each flagged item itself (no human handoff): for every duplicate-cherry-pick subject, diff the matching main commit against HEAD and confirm its net contribution survived; for every touched-file overlap, confirm the recent main commits' changes still appear in HEAD. If anything was silently dropped, restore it as a follow-up commit on the same branch before reporting the merge complete. Only if the audit is clean (or all losses have been restored) is the merge done.

## Node Dashboard

Fusion has a Node Dashboard view for managing mesh network nodes. See [docs/architecture.md](./docs/architecture.md) for dashboard components and API endpoints.

**Node Settings Sync API Endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/nodes/:id/settings` | Fetch settings from a remote node |
| POST | `/api/nodes/:id/settings/push` | Push local settings to a remote node |
| POST | `/api/nodes/:id/settings/pull` | Pull settings from a remote node |
| GET | `/api/nodes/:id/settings/sync-status` | Get sync status and diff summary |
| POST | `/api/nodes/:id/auth/sync` | Sync model auth credentials |
| POST | `/api/settings/sync-receive` | Receive pushed settings (inbound) |
| POST | `/api/settings/auth-receive` | Receive auth credentials (inbound) |
| GET | `/api/settings/auth-export` | Export local auth credentials |

All remote node endpoints require the target node to have an `apiKey` configured. Inbound endpoints validate the `Authorization: Bearer <apiKey>` header against the local node's apiKey.

## Pi Extension (`packages/cli/src/extension.ts`)

The pi extension provides tools and a `/fn` command for interacting with fn from within a pi session. It ships as part of `@runfusion/fusion`.

**Update the extension when:**
- CLI commands change (behavior, flags, or output)
- Task store / Agent store API changes (method signatures or behavior)
- New user-facing features are added that chat agents should be able to use

**Don't add tools for engine-internal operations** (move, step updates, logging, merge) — those are handled by the engine's own agents.

The extension has no skills — tool descriptions give the LLM everything it needs.

## Agent Spawning (`spawn_agent` tool)

The executor agent can spawn child agents that run in parallel. Each spawned agent:
1. Runs in its own git worktree (branched from the parent's worktree)
2. Receives a task prompt describing what to do
3. Executes autonomously until completion or termination
4. Reports status back to the parent via AgentStore

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | `string` | Name for the child agent |
| `role` | `string` | Role: `"triage"`, `"executor"`, `"reviewer"`, `"merger"`, `"engineer"`, or `"custom"` |
| `task` | `string` | Task description for the child agent to execute |

### Settings

- `maxSpawnedAgentsPerParent` (default: `5`) — Maximum children per parent agent
- `maxSpawnedAgentsGlobal` (default: `20`) — Maximum total spawned agents per executor instance

### Lifecycle

- Child agents are tracked in `AgentStore` with `reportsTo` set to the parent task ID
- When the parent session ends, all spawned children are terminated
- State transitions: `idle` → `active` → `running` → `active` (success) or `error` (failure)

### Error Handling

- Per-parent and global limits are enforced with descriptive error messages
- Failures during agent creation or worktree setup return error results
- State update failures are non-blocking (logged but don't prevent execution)

## Agent Delegation Tools

Two tools enable inter-agent delegation — discovering other agents and assigning work to them.

### `list_agents` Tool

List all available agents in the system. Shows each agent's name, role, state, personality (soul), and current assignment.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `role` | `string` (optional) | Filter by agent role/capability (e.g., `"executor"`, `"reviewer"`) |
| `state` | `string` (optional) | Filter by agent state (e.g., `"idle"`, `"active"`, `"running"`) |
| `includeEphemeral` | `boolean` (optional) | Include ephemeral/runtime agents (default: `false`) |

**Example usage:**
```
// Find all idle executor agents
list_agents({ role: "executor", state: "idle" })

// See all agents including runtime task-workers
list_agents({ includeEphemeral: true })
```

### `delegate_task` Tool

Create a new task and assign it to a specific agent for execution. The task goes to `todo` and will be picked up by the target agent on their next heartbeat cycle.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `agent_id` | `string` (required) | The agent ID to delegate work to |
| `description` | `string` (required) | What needs to be done |
| `dependencies` | `string[]` (optional) | Task IDs this new task depends on |

**Example workflow — CEO agent discovers QA agent and delegates testing:**

```
// 1. Discover available agents
list_agents({ role: "qa" })
// → Returns QA agent with id "qa-agent-001"

// 2. Delegate the testing task
delegate_task({
  agent_id: "qa-agent-001",
  description: "Run integration tests for the authentication module",
  dependencies: ["FN-100"]  // depends on implementation being done
})
// → Created FN-105: Delegated to QA Agent (qa-agent-001).
//   The task will be picked up on their next heartbeat cycle.
```

**Error cases:**
- `"ERROR: Agent {agent_id} not found"` — The agent ID does not exist
- `"ERROR: Cannot delegate to ephemeral/runtime agent {agent_id}"` — Cannot delegate to runtime task-worker agents (use `spawn_agent` for parallel worktree tasks instead)

**Note:** The delegation tools are available to both executor agents and heartbeat agents when the agent store is configured. Use `list_agents` first to discover agent IDs and capabilities before delegating.

## Checkout Leasing

Task ownership supports explicit checkout leases. Agents should be aware of:

### Conflict Semantics

- Checkout conflicts return **409 Conflict** when another agent already holds the lease
- Response shape: `{ error: "Task is already checked out", currentHolder, taskId }`
- Clients **must not retry 409 automatically** — this is ownership contention, not a transient failure

### Heartbeat Enforcement

`HeartbeatMonitor.executeHeartbeat()` validates checkout before work begins:
- If `task.checkedOutBy` is set to another agent, the run exits with `reason: "checkout_conflict"`
- Heartbeat execution does not auto-checkout — callers are responsible for obtaining checkout before starting work

## Per-Agent Heartbeat Configuration

Each agent can override heartbeat behavior via `runtimeConfig`. Key settings:
- `heartbeatIntervalMs` — How often heartbeats are triggered
- `heartbeatTimeoutMs` — Time without heartbeat before agent is considered unresponsive
- `maxConcurrentRuns` — Max concurrent heartbeat runs per agent

See [docs/agents.md](./docs/agents.md) for the full configuration reference.

## Budget Governance

Per-agent token budget tracking controls costs and prevents runaway AI spending. Budget enforcement happens at multiple points:

- **HeartbeatMonitor.executeHeartbeat()** — Checks budget before creating sessions; skips when `isOverBudget: true` or `isOverThreshold: true` (for timer triggers)
- **HeartbeatTriggerScheduler.onTimerTick()** — Skips timer ticks when budget is exceeded

Agents can be paused by budget exhaustion. See [docs/agents.md](./docs/agents.md) for the full budget configuration reference.

## Heartbeat Trigger Scheduling

`HeartbeatTriggerScheduler` manages three trigger mechanisms:
- **Timer** — Periodic wakeup based on `heartbeatIntervalMs`
- **Assignment** — Automatic wakeup when a task is assigned
- **On-demand** — Manual trigger via `POST /api/agents/:id/runs`

See [docs/agents.md](./docs/agents.md) for WakeContext and API details.

## Agent Performance Ratings

Agent performance ratings allow users and agents to provide feedback that influences future behavior through system prompt injection. Ratings use a 1–5 scale with trend analysis (improving/declining/stable).

See [docs/agents.md](./docs/agents.md) for the full API and dashboard configuration reference.

## Engine Diagnostic Logging

The task executor, scheduler, and related subsystems use structured logging via `createLogger()` from `packages/engine/src/logger.ts`. All log lines are prefixed with the subsystem name.

### Key Diagnostic Points

When debugging agent execution issues (agents stuck on "starting"), check these log points:

1. **`[executor] TaskExecutor constructed`** — Confirms the executor initialized with expected options
2. **`[executor] [event:task:moved] FN-XXX → in-progress`** — Confirms the scheduler moved the task
3. **`[executor] execute() called for FN-XXX`** — Confirms execute() was entered
4. **`[executor] FN-XXX: worktree ready at ...`** — Confirms worktree creation
5. **`[executor] FN-XXX: creating agent session`** — Confirms model resolution and session creation started
6. **`[pi] createFnAgent called`** — Confirms the agent factory was invoked
7. **`[pi] Session created successfully`** — Confirms the AI session was created
8. **`[executor] FN-XXX: calling promptWithFallback()...`** — Confirms the prompt was sent
9. **`[stuck-detector] Tracking task FN-XXX`** — Confirms heartbeat monitoring started

### Semaphore Resilience

`AgentSemaphore` (`packages/engine/src/concurrency.ts`) has defensive guards:
- `limit` getter returns minimum 1 (prevents indefinite blocking)
- `availableCount` returns 0 for invalid limits (NaN, Infinity, ≤0)

## Terminal UI (TUI) — Now Part of `fn` CLI

The `@fusion/tui` package has been merged into the `fn` CLI. The Ink-based TUI (status panel, logs, tail-follow, cursor visibility) is now invoked as part of the `fn` command.

**Invocation:**
- Running `fn` with no arguments defaults to the dashboard (web UI by default)
- The TUI surfaces inside the dashboard command when configured
- Implementation lives in `packages/cli/src/commands/dashboard-tui/`

There is no separate `@fusion/tui` package or `pnpm tui` command anymore. Refer to `packages/cli/src/commands/dashboard-tui/` for current TUI implementation details.

---

## Headless Node Mode (`fn serve`)

The `fn serve` command starts Fusion as a headless node (API server + AI engine, no frontend). It binds to `0.0.0.0` by default for remote accessibility.

See [docs/architecture.md](./docs/architecture.md) for the full reference including health endpoint and startup banner.

## Settings

fn uses a two-tier settings hierarchy:
- **Global settings** — User preferences in `~/.fusion/settings.json` (theme, models, notifications)
- **Project settings** — Project-specific settings in `.fusion/config.json` (concurrency, worktrees, commands)

Project settings override global settings. Configure via the dashboard **Settings** modal or `fn settings` CLI.

See [docs/settings-reference.md](./docs/settings-reference.md) for the complete settings reference.

### Settings Hierarchy for Model Selection

**For Task Specification (Triage):**
1. Per-task `planningModelProvider`/`planningModelId`
2. Project `planningProvider`/`planningModelId`
3. Global `planningGlobalProvider`/`planningGlobalModelId`
4. Project `defaultProviderOverride`/`defaultModelIdOverride`
5. Global `defaultProvider`/`defaultModelId`
6. Automatic provider/model resolution

**For Task Execution (Executor):**
1. Per-task `modelProvider`/`modelId`
2. Project `executionProvider`/`executionModelId`
3. Global `executionGlobalProvider`/`executionGlobalModelId`
4. Project `defaultProviderOverride`/`defaultModelIdOverride`
5. Global `defaultProvider`/`defaultModelId`
6. Automatic provider/model resolution

**For Code/Spec Review (Reviewer):**
1. Per-task `validatorModelProvider`/`validatorModelId`
2. Project `validatorProvider`/`validatorModelId`
3. Global `validatorGlobalProvider`/`validatorGlobalModelId`
4. Project `defaultProviderOverride`/`defaultModelIdOverride`
5. Global `defaultProvider`/`defaultModelId`
6. Automatic provider/model resolution

## Per-Task Model Overrides

Tasks can override project/global AI model settings on a per-task basis:
- **Executor Model** — The model used to implement the task
- **Validator Model** — The model used for code and plan review
- **Planning Model** — The model used for task specification

When both provider and modelId are set, the task override is used instead of global defaults. Set via the task detail modal's **Model** tab.

## Model Presets

Model presets let teams standardize AI model choices. Each preset contains executor/validator model pairs. Presets can be auto-selected by task size (Small → Budget, Medium → Normal, Large → Complex).

See [docs/settings-reference.md](./docs/settings-reference.md) for the full configuration reference.

## Mission Autopilot

Missions can run in autopilot mode for autonomous progression. When enabled:
- Autopilot watches task completion events
- Automatically activates the next slice when the current one finishes
- Progresses through: `inactive → watching → activating → completing`

See [docs/missions.md](./docs/missions.md) for the full autopilot reference.

## Mission Planning Context

When features are triaged to tasks, the system enriches descriptions with full mission hierarchy context (mission → milestone → slice → feature), giving implementation agents comprehensive context.

See [docs/missions.md](./docs/missions.md) for the planning context system and interview flow documentation.

## Workflow Steps

Workflow steps are reusable quality gates that run at configurable lifecycle phases:
- **Pre-merge** — After task implementation, before merge (can block)
- **Post-merge** — After successful merge (informational only)

Steps can be defined as **prompt** (AI agent review) or **script** (deterministic command).

See [docs/workflow-steps.md](./docs/workflow-steps.md) for the full reference including templates, API, and execution details.

## Run Audit

The run-audit system records every mutation performed by the engine across three domains:
- **Database** — task:create, task:update, task:move, etc.
- **Git** — worktree:create, commit:create, merge:resolve, etc.
- **Filesystem** — file:write, prompt:write, attachment:create, etc.

Events are tied to specific run IDs for end-to-end traceability. See [docs/architecture.md](./docs/architecture.md) for the audit API reference.

## Archive Cleanup

Archived tasks can be cleaned up from the filesystem while preserving metadata. Restored tasks keep all metadata but lose attachments and agent logs.

See [docs/task-management.md](./docs/task-management.md) for the archive and restore reference.

## Dashboard UI Styling Guide

This guide documents the dashboard's design system so that any AI agent or developer building new UI components follows established conventions automatically.

### CSS Architecture

The dashboard's CSS has been split into modular per-component files alongside a consolidated global stylesheet:

- **Global stylesheet**: `packages/dashboard/app/styles.css` (~4,500 lines)
  - Design tokens (spacing, colors, shadows, transitions, fonts)
  - Primitives (`.btn`, `.card`, `.modal`, `.form-input`)
  - Cross-component `@media` overrides and base breakpoints
- **Per-component stylesheets**: `packages/dashboard/app/components/ComponentName.css` (56 files)
  - Each component that needs CSS has a co-located `ComponentName.css`
  - Each `ComponentName.tsx` must import its stylesheet at the top: `import "./ComponentName.css";`

**Rule:** New CSS for a component goes in `app/components/ComponentName.css`, NOT in `styles.css`. Only genuinely global rules (design tokens, primitives, cross-component `@media` blocks) belong in `styles.css`.

### CSS Testing and Lazy-Loaded Views

For CSS regression tests, use the helper at `packages/dashboard/app/test/cssFixture.ts`:

```ts
import { loadAllAppCss, loadAllAppCssBaseOnly } from "../test/cssFixture";

// Concatenates styles.css + all component .css
const allCss = await loadAllAppCss();

// Strips @media/@supports blocks for base-rule assertions
const baseOnly = await loadAllAppCssBaseOnly();
```

**Never** directly `readFileSync('../styles.css')` — an ESLint rule (`no-restricted-syntax` in `eslint.config.mjs`) bans this in `packages/dashboard/**/*.test.{ts,tsx}` and points devs at `cssFixture.ts`.

The test config (`vitest.config.ts`) includes `test.css: { include: [/.+/] }` so component CSS imports actually inject into jsdom (needed for `getComputedStyle` assertions).

### Lazy-Loaded Heavy Views

These 13 views are lazy-loaded via `React.lazy()` to manage bundle size:

- `AgentsView`, `RoadmapsView`, `NodesView`, `ChatView`, `MemoryView`
- `DevServerView`, `InsightsView`, `DocumentsView`, `SkillsView`
- `SetupWizardModal`, `PluginManager`, `PiExtensionsManager`, `AgentDetailView`

They are loaded in `App.tsx` / `AppModals.tsx` / `SettingsModal.tsx` / `AgentsView.tsx` with `<Suspense fallback={null}>`. 

A `prefetchLazyViews()` function runs once on mount via `requestIdleCallback` to warm chunks. **Do not make these eager again** — bundle size matters.

### Design Tokens

All new CSS **must** use these token variables instead of hardcoded values. Tokens are defined at `:root` and adapted for light mode via `[data-theme="light"]`.

---

### Design Tokens

All new CSS **must** use these token variables instead of hardcoded values. Tokens are defined at `:root` and adapted for light mode via `[data-theme="light"]`.

| Token | Value | Purpose |
|-------|-------|---------|
| `--space-xs` | `4px` | Tight inline spacing |
| `--space-sm` | `8px` | Small gaps |
| `--space-md` | `12px` | Default gaps |
| `--space-lg` | `16px` | Section padding |
| `--space-xl` | `24px` | Large section padding |
| `--space-2xl` | `32px` | Extra-large spacing |
| `--radius-sm` | `4px` | Small corners |
| `--radius-md` | `8px` | Default corners |
| `--radius-lg` | `12px` | Card/modal corners |
| `--radius-xl` | `16px` | Large corners |
| `--radius-pill` | `10px` | Pill/badge corners |
| `--shadow-sm` | `0 1px 2px rgba(0,0,0,0.1)` | Subtle lift |
| `--shadow-md` | `0 4px 6px rgba(0,0,0,0.1)` | Standard lift |
| `--shadow-lg` | `0 4px 24px rgba(0,0,0,0.4)` | Modals, dropdowns |
| `--shadow-glow` | `0 0 8px rgba(88,166,255,0.3)` | Focus glow |
| `--glow-success` | `0 0 8px rgba(46,160,67,0.3)` | Success state |
| `--glow-danger` | `0 0 8px rgba(248,81,73,0.3)` | Danger state |
| `--glow-warning` | `0 0 8px rgba(227,179,65,0.3)` | Warning state |
| `--focus-ring` | `0 0 0 2px rgba(88,166,255,0.15)` | Subtle focus ring |
| `--focus-ring-strong` | `0 0 0 2px rgba(88,166,255,0.3)` | Prominent focus ring |
| `--transition-instant` | `0.1s ease` | Immediate |
| `--transition-fast` | `0.15s ease` | Quick |
| `--transition-normal` | `0.2s ease` | Default |
| `--transition-slow` | `0.3s ease` | Smooth |
| `--font-primary` | system font stack | Body font |
| `--font-mono` | monospace stack | Code, IDs |
| `--header-height` | `57px` | Fixed header height |
| `--mobile-nav-height` | `44px` | Mobile nav bar |
| `--standalone-bottom-gap` | `0px` / `8px` (PWA) | iOS home bar gap |
| `--overlay-padding-top` | `10vh` | Modal vertical position |

**Never** hardcode pixel values, colors, or durations in component CSS. Always reference a token. The sole exception is inside `:root` or theme blocks where tokens are *defined*.

---

### Color Variables

Core palette (dark defaults at `:root`, overridden in `[data-theme="light"]`):

| Variable | Purpose |
|----------|---------|
| `--bg` | Page background |
| `--surface` | Elevated surface |
| `--card` | Card background |
| `--card-hover` | Card hover state |
| `--border` | Borders and dividers |
| `--text` | Primary text |
| `--text-muted` | Secondary/muted text |
| `--text-dim` | Tertiary/disabled text |

Task status colors (semantic — consistent meaning across all 54 color themes):

| Variable | Status |
|----------|--------|
| `--triage` | Triage |
| `--todo` | Todo |
| `--in-progress` | In Progress |
| `--in-review` | In Review |
| `--done` | Done |

Semantic status colors:

| Variable | Purpose |
|----------|---------|
| `--color-success` | Success green |
| `--color-error` | Error red (light) |
| `--color-error-dark` | Error red (dark) |
| `--color-warning` | Warning amber |
| `--color-info` | Info blue |
| `--color-muted` | Muted gray |

**Rule:** Never use raw hex or `rgba(...)` for colors in component styles. Use `var(--token)` or `color-mix(in srgb, var(--color) X%, transparent)` for translucent backgrounds. The only place hardcoded colors are acceptable is inside `:root` theme blocks defining tokens.

Status background tokens already use `color-mix` for theme adaptability — reuse them rather than creating parallel variants:

```
--status-triage-bg, --status-todo-bg, --status-in-progress-bg,
--status-in-review-bg, --status-done-bg, --status-archived-bg,
--status-error-bg, --status-error-bg-deep
```

---

### Theme System

The dashboard supports **dark/light modes** (controlled by `data-theme` attribute) plus **54 color themes** (controlled by `data-color-theme` attribute). Theme blocks live in `packages/dashboard/app/public/theme-data.css` and are lazy-loaded when a non-default theme is active.

**Token categories:**

1. **Base tokens** (`--bg`, `--surface`, `--text`, etc.) — redefined in every theme block (dark + light for each of the 54 themes). Components using these tokens adapt automatically.
2. **Semantic tokens** (tokens with consistent *meaning* across all themes, like `--autopilot-pulse`, `--event-error-text`, `--badge-mission-*`, `--fab-*`) — only need dark/light adaptation via `[data-theme="light"]`. They do NOT need per-color-theme overrides because the semantic meaning is always consistent.
3. **Status tokens** (`--triage`, `--todo`, `--in-progress`, etc.) — redefined per theme block to match each theme's palette.

**Adding theme-aware CSS custom properties:**
- For **base** tokens: add to `:root`, `[data-theme="light"]`, and all 54 theme blocks (dark + light variants)
- For **semantic** tokens: add to `:root` and `[data-theme="light"]` only
- For **status** tokens: add to `:root` and all theme blocks

The automated test in `status-colors-theme.test.ts` iterates all theme blocks to catch regressions.

**New components must use `var(--token)` references** so themes apply without any per-component dark/light handling.

---

### Component Classes

Reuse these existing CSS classes rather than creating parallel styles. They live in `styles.css`.

#### Buttons

| Class | Purpose |
|-------|---------|
| `.btn` | Base button |
| `.btn-primary` | Primary CTA (uses `--cta-bg`) |
| `.btn-danger` | Destructive action (red) |
| `.btn-warning` | Warning action (amber) |
| `.btn-sm` | Compact button (4px 10px padding, 12px font) |
| `.btn-icon` | Icon-only button (square, icon fills) |
| `.btn-icon--active` | Active icon button state |
| `.btn-badge` | Notification badge on button |

All buttons use `--btn-padding`, `--btn-border-width`, `--transition-fast`, and `--radius-md` tokens. All have `:focus-visible` using `--focus-ring-strong` and `:active` using `transform: scale(0.97)`.

#### Modals

| Class | Purpose |
|-------|---------|
| `.modal-overlay` | Backdrop; use with `.open` class |
| `.modal-overlay.open` | Visible overlay (uses `backdrop-filter: blur(4px)`) |
| `.modal` | Default modal (480px wide, `--radius-lg`, `--shadow-lg`) |
| `.modal-lg` | Large modal (640px wide) |
| `.modal-header` | Modal title bar (flex, space-between) |
| `.modal-close` | Close button (× icon, hover color change) |
| `.modal-actions` | Action bar at modal bottom |
| `.modal-actions-left` | Left-aligned actions (use `margin-right: auto`) |
| `.modal-actions-right` | Right-aligned actions |

The overlay uses `position: fixed; inset: 0; z-index: 100;`. Pad the top with `--overlay-padding-top` (default 10vh) to center vertically.

#### Forms

| Class | Purpose |
|-------|---------|
| `.form-group` | Field container with `--space-xl` horizontal padding |
| `.form-group label` | Uppercase label (12px, 0.5px letter-spacing) |
| `.input` | Global input (surface bg, `--radius-sm`) |
| `.select` | Global select (same style as `.input`) |
| `.checkbox-label` | Checkbox label (flex, gap, no uppercase) |
| `.form-error` | Error box (uses `color-mix`, `--color-error`) |

Inputs and selects in `.form-group` get focus styles (`border-color: var(--todo)` + `--focus-ring`). Global `.input` and `.select` classes apply independently.

#### Cards

| Class | Purpose |
|-------|---------|
| `.card` | Task card base (grab cursor, `--card-padding`) |
| `.card-header` | Card top row (flex, gap: 6px) |
| `.card-id` | Monospace task ID (11px, `--text-muted`) |
| `.card-title` | Card title (13px, break-word) |
| `.card-meta` | Meta row (flex, gap, `--space-sm`) |
| `.card-status-badge` | Status badge (pill shape, status-bg/text colors) |
| `.card-status-badge--triage` | Triage badge variant |
| `.card-status-badge--todo` | Todo badge variant |
| `.card-status-badge--in-progress` | In-Progress badge variant |
| `.card-status-badge--in-review` | In-Review badge variant |
| `.card-status-badge--done` | Done badge variant |
| `.card-status-badge--archived` | Archived badge variant |

Cards have `--focus-ring-strong` focus style and `--card-hover` background on hover. Use `.card-status-badge--{status}` classes for column-color badges.

#### Utility

| Class | Purpose |
|-------|---------|
| `.touch-target` | 44px minimum touch target (Apple HIG / WCAG 2.5.8) |
| `.visually-hidden` | Screen-reader-only (clip rect) |

---

### Mobile Responsive

**Breakpoints** (use `@media (max-width: N)`):

| Breakpoint | Value | Use |
|------------|-------|-----|
| Mobile | `768px` | Primary mobile breakpoint |
| Tablet | `1024px` | `min-width: 769px and max-width: 1024px` |
| Small | `640px` | Compact mobile |
| XSmall | `480px` | Very narrow devices |

**Mobile CSS placement:** All mobile overrides go in `@media (max-width: 768px)` blocks at the **bottom** of `styles.css`, after their base styles.

**Bottom spacing:**
- `--mobile-nav-height` (`44px`) controls mobile nav bar height
- `--standalone-bottom-gap` (`0px` default, `8px` in PWA `display-mode: standalone`) adds iOS home indicator breathing room
- All bottom-positioned elements use `calc(..., var(--mobile-nav-height), env(safe-area-inset-bottom, 0px), var(--standalone-bottom-gap))`

**Touch targets:** All interactive elements must be at least **36px** on mobile. Use `.touch-target` for elements below this threshold (which sets `44px` minimum). Inside mobile media queries, individual component touch targets may be `36px`.

**Safe area:** Use `max(var(--space-md), env(safe-area-inset-left, 0px))` pattern for content respecting device notches on mobile.

---

### Adding New CSS

1. **Always use tokens** — `var(--space-md)`, `var(--text-muted)`, `var(--radius-md)`, `var(--transition-fast)`, etc. Never write `padding: 8px` or `color: #e6edf3` directly.
2. **Place new rules correctly** — Component CSS goes in `app/components/ComponentName.css`. Only genuinely global rules go in `styles.css`.
3. **Import stylesheet in component** — Add `import "./ComponentName.css";` at the top of `ComponentName.tsx`.
4. **Reuse existing classes** — Don't create parallel button or form styles. Add states (`:hover`, `:focus-visible`, `:active`) to the existing `.btn`, `.card`, `.input` chains.
5. **Theme-aware backgrounds** — Use `color-mix(in srgb, var(--color) X%, transparent)` instead of `rgba(...)`. For example, error backgrounds: `color-mix(in srgb, var(--color-error) 10%, transparent)`.
6. **Accessibility** — Add `:focus-visible` styles using `var(--focus-ring-strong)` on every interactive component. Never suppress focus entirely.
7. **Test both themes** — Verify new styles look correct in both dark and light modes before committing.
8. **Mobile overrides** — Add mobile variants below the base styles, inside a `@media (max-width: 768px)` block.

---

### Common Pitfalls

- **`--surface-hover` is undefined** — This token is referenced in several places but never defined in `:root` or theme blocks. Use a fallback: `var(--surface-hover, rgba(0,0,0,0.03))` or define the token explicitly.
- **Hardcoded `rgba(...)` for error states** — Use `color-mix(in srgb, var(--color-error) 10%, transparent)` instead of `rgba(248, 81, 73, 0.1)`.
- **`.form-error` style** — Should use `color-mix(in srgb, var(--color-error) 10%, transparent)` for the background, not hardcoded rgba.
- **`lucide-react` icon changes** — When adding new icons, update test mocks (`vi.mock("lucide-react")`) immediately. Missing mock exports cascade into runtime failures.
- **Light-theme overrides** — Components using `var(*)` tokens generally inherit correctly from `[data-theme="light"]` root redefinitions. Only add explicit `[data-theme="light"]` overrides where fine-tuning is needed (opacity, subtle shadows).
- **CSS regex tests in test files** — When changing mobile CSS values (e.g., `min-height`), update both the CSS and the corresponding test assertions. Use non-greedy `[^}]*` patterns for block-scoped regex, not `[\s\S]*` which can bleed across block boundaries.
- **BEM specificity conflicts** — When a container state class (`.quick-entry-box--expanded`) and an element modifier (`.quick-entry-input--expanded`) both target the same element, the container may win due to higher specificity. Use `:not(.modifier)` to scope container rules: `.quick-entry-box--expanded .quick-entry-input:not(.quick-entry-input--expanded)`.
- **CSS in `@media` blocks** — Don't search backwards for the nearest `@media` to check if a rule is mobile-scoped. Track brace depth to confirm the line is inside the block. Many components are defined globally even if they only visually appear on mobile.
