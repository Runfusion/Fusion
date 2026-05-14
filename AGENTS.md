# Project Guidelines

## STANDING DIRECTIVE: Buttons Are Frozen (2026-05-13)

Do not file, plan, or implement tasks that adjust button mobile-responsiveness, touch-target sizing, or mobile reflow of header/action button rows anywhere in the dashboard (TaskCard, SettingsModal, ChatView, MissionManager, AgentsView, FAB, etc.). **Keep buttons as they are.**

This supersedes earlier guidance in this document about mobile touch targets, primary/secondary control sizing on mobile, and `.touch-target` minimums for buttons. The CSS guidance for non-button elements still applies. The `Frontend UX Design` workflow step (WS-006) is disabled and must stay disabled.

If you find yourself opening `SettingsModal.css`, `TaskCard.css`, `ChatView.css`, or similar files inside an `@media (max-width: 768px)` block to touch a `.btn`, `.modal-close`, `.settings-header-actions`, `.card-*` button, or similar control — stop. Confirm with the user in chat before proceeding.

Exceptions only for: explicit named user request in chat that overrides this directive.

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

Tests are required. Typechecks and manual verification are not substitutes for real tests with assertions.

Use the narrowest command that exercises the behavior you changed, then broaden before reporting completion. Prefer local verification over waiting for GitHub Actions.

```bash
pnpm test              # changed-only workspace tests; falls back to the workspace quality gate in safety contexts
pnpm test:full         # full workspace quality gate, clean-worktree compatible
pnpm lint              # lint all packages
pnpm build             # build workspace packages, excluding desktop/mobile
pnpm verify:workspace  # canonical pre-merge gate: lint -> test:full -> build
```

`pnpm test:full` is the default broad local gate. It runs each package's default test script with capped worker fanout:

```bash
FUSION_TEST_TOTAL_WORKERS=4 FUSION_TEST_CONCURRENCY=2 pnpm -r --workspace-concurrency=2 test
```

Do not casually raise worker counts to make a run faster; dashboard/jsdom and integration-heavy packages can become slower or unstable when oversubscribed. Use `VITEST_MAX_WORKERS=<n>` only for targeted package-level investigation.

### Dashboard Test Lanes

Dashboard has a curated default gate plus explicit exhaustive lanes:

```bash
pnpm --filter @fusion/dashboard test                # curated app/API quality gate
pnpm --filter @fusion/dashboard test:deep           # exhaustive app + API suite
pnpm --filter @fusion/dashboard test:app            # exhaustive React/jsdom app tests
pnpm --filter @fusion/dashboard test:api            # exhaustive Node API/server tests
pnpm --filter @fusion/dashboard test:browser-smoke  # local browser CSS/layout smoke
pnpm --filter @fusion/dashboard test:build          # built client output contract
```

Run the default dashboard gate for ordinary dashboard work. Run `test:deep` when changing broad dashboard architecture, shared modal/view infrastructure, route registration, or anything that could invalidate the curated selection. Run `test:browser-smoke` for layout, responsive, navigation, modal, or CSS changes. Run `test:build` for Vite/build output, lazy-loading, chunking, static asset, or client-dist changes.

### Engine test helper convention

`packages/engine/src/__tests__/executor-test-helpers.ts` now defaults `isUsableTaskWorktree` to `true` via a helper-level `worktree-pool` mock so fabricated worktree paths continue to pass FN-4114 liveness gating without real `git worktree add` setup.
To test failure paths, override per test with `vi.spyOn(worktreePool, "isUsableTaskWorktree").mockResolvedValueOnce(false)` (or `.mockResolvedValue(false)` in a scoped `beforeEach`).
This is test-only scaffolding; production liveness assertions in `packages/engine/src/executor.ts` remain unchanged.

### Package-Specific Test Commands

Common targeted lanes:

```bash
pnpm --filter @fusion/core test
pnpm --filter @fusion/engine test
pnpm --filter @runfusion/fusion test
pnpm test:scripts
node --test scripts/__tests__/*.test.mjs
```

For a single Vitest file, prefer package-local `exec vitest` so argument forwarding does not accidentally run the whole package:

```bash
pnpm --filter @fusion/core exec vitest run src/__tests__/central-db.test.ts --silent=passed-only --reporter=dot
pnpm --filter @fusion/dashboard exec vitest run --project dashboard-app-quality app/components/__tests__/TaskCard.test.tsx --silent=passed-only --reporter=dot
```

### Before Reporting Done

- For code changes: run the affected package tests and any directly relevant browser/build lane.
- For cross-package, shared test infrastructure, or CI changes: run `pnpm test:full`.
- For production/bundling-sensitive changes: run `pnpm build`.
- For final verification on substantial work: run `pnpm verify:workspace` unless there is a clear reason to split the commands and report them separately.
- If you intentionally do not run a relevant lane, say why.

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

## Architecture

- Merge deadlock self-healing now layers `recoverAlreadyMergedReviewTasks()`, `clearStaleBlockedBy()`, and `reclaimSelfOwnedBranchConflicts()` in `packages/engine/src/self-healing.ts`, plus the paused-aware in-review scope filter in `packages/engine/src/scheduler.ts` (`inReviewWithWorktree` excludes `paused` tasks). `reclaimSelfOwnedBranchConflicts()` now also recovers paused `branch-conflict-unrecoverable` review rows when ownership is self-proven, auto-reclaims `fusion/<task-id>` branches that are still live-mapped but have zero unique commits vs main by force-removing the stale worktree and deleting the branch, and clears `task.worktree`/`task.branch` so retries recreate a fresh checkout. `inspectBranchConflict()` backs this with a patch-id fallback for degraded/empty `git cherry` output before declaring zero-unique-commit subsumption; orphan `fusion/*` branches are still resolved by prune-or-rescue logic (subsumed branches pruned; unique-commit branches rescued into triage tasks instead of force delete). Completion fan-out now runs synchronously on `in-review → done` via `SelfHealingManager.reconcileCompletedTask()`, so downstream stale `blockedBy` links and residual `fusion/<task-id>` branch/worktree artifacts are reconciled immediately instead of waiting for periodic sweeps.
- Restart recovery is coordinated through `RestartRecoveryCoordinator` (`packages/engine/src/restart-recovery-coordinator.ts`), which classifies interrupted `in-progress` runs at runtime startup: no-progress `fn_task_done` failures are safely requeued to `todo`, then remaining orphaned work is resumed via the executor.

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

User-initiated `moveTask(in-progress → todo)` is a hard cancel contract: executor listeners must abort active sessions before dispose, stop step/workflow subprocesses, and leave the task parked in `todo` with `userPaused` semantics intact. Engine-initiated rebounds (pause, stuck recovery, workflow rerun, self-healing) must continue to use default `moveSource: "engine"` plus the appropriate `preserve*` flags (`preserveResumeState`, `preserveProgress`, `preserveWorktree`) and must not set `userPaused`.

## Git Conventions

- Commit messages: `feat(FN-XXX):`, `fix(FN-XXX):`, `test(FN-XXX):`
- One commit per step (not per file change)
- Always include the task ID prefix

## Merging Branches Into Main

Two rules, learned the hard way (FN-2370 silently reverted three commits' work):

1. **If a branch contains commits that duplicate work already on main, rebase the branch onto main and drop the duplicates *before* merging.** This usually happens when a branch was rebased from a stale base while the same work was also landed directly on main. Subjects that match recent main commits are the tell — `git log main..branch --format=%s` should not overlap with `git log <base>..main --format=%s`. Auto-resolvers cannot tell which side of a duplicated change is canonical and will silently drop refinements from the newer side.

2. **Prefer rebase-and-merge over squash for branches spanning multiple substantive commits.** Fusion's direct merger now defaults `directMergeCommitStrategy="auto"`, which keeps squash for branches with 0–1 substantive commits but automatically switches multi-substantive branches to a history-preserving rebase/cherry-pick path. Use the project setting `directMergeCommitStrategy` or the task-level `**Direct Merge Commit Strategy:** auto|always-squash|always-rebase` PROMPT line when you need to force a route.

History-preserving cherry-pick merges now treat git's explicit empty-pick signatures (`The previous cherry-pick is now empty`, `nothing to commit, working tree clean`, and the `--skip`/`--allow-empty` hints) as "already on main" no-ops: empty commits are skipped, fully-subsumed branches auto-complete to `done`, and no empty commit is created.

Executor contamination handling now does a single-shot auto-recovery when every foreign-attributed commit is already upstream by patch-id equivalence: it drops only the already-upstream commits, requeues the task, and records a guard so a second contamination event escalates directly to paused human adjudication. FN-4499 adds a bootstrap-misbinding safety branch: `classifyBootstrapMisbinding` detects contamination ranges with foreign-only attribution (0 own commits, 0 non-attributed commits), the executor re-anchors with `reanchorBranchToBase`, emits `branch:reanchor` audit metadata, and requeues to `todo` before the standard FN-4428 classifier path; any failed re-anchor or non-bootstrap signal still falls back to the existing contamination pause flow.

After any squash that auto-resolved conflicts, the merger runs the post-squash audit before auto-completing the task. Outcome depends on `postMergeAuditMode`: `warn` is the default (logs findings and continues), `block` is the stricter opt-in mode (refuses completion on findings), and `off` skips the audit. For rebase-strategy merges, overlap-only findings are also auto-cleared when deterministic verification has already proven the merged tree.

When audit findings still block completion, Fusion now runs an auto-recovery pipeline (Stages 1–5) governed by `mergeAuditAutoRecovery` (`deterministic-only` → `programmatic` → `ai-assisted` → `off`). Stages include deterministic short-circuiting, per-file survival checks, optional single-commit AI restoration, bounded audit-bounce retries, and finally park-with-follow-up if unresolved.

Before those auto-resolved squash commits are written, the merger also runs a per-file diff-volume gate: it compares each file's staged squash delta against the branch's net delta vs its merge-base, and blocks the merge in `in-review` when a non-allowlisted file loses too much branch volume. This is the pre-commit guard against FN-3936-style silent drops where fallback resolution kept a branch's commit message but discarded the branch's main file edits.

### Gitignored-path guard on squash merges

The merger now strips gitignored paths from the staged squash set before writing the merge commit (including verification-fix rebuild paths). Any staged path that matches `.gitignore` (for example `.fusion/`, `.worktrees/`, `.pi/`, `.factory/`, `node_modules/`, `dist/`) is explicitly unstaged and logged.

Agents must **never** bypass `.gitignore` with `git add -f .fusion/...` (or force-add any ignored scratch artifact). Findings, diagnosis, and test-plan notes belong in task documents via `fn_task_document_write`, not committed files.

### File-Scope invariant on squash merges

Every squash commit path now enforces a file-scope invariant immediately before writing the commit: the staged file set must overlap the task's declared `## File Scope` from `PROMPT.md`. The invariant runs on the standard squash path, the Attempt 3 `-X ours/theirs` fallback, and the verification-fix rebuild/finalize path. When the staged files have zero overlap with a non-empty declared scope, the merger throws a structured `FileScopeViolationError`, logs the declared scope + staged files to the merger agent log, resets the pre-squash state, and leaves the task in `in-review` for inspection instead of landing the commit.

Tasks can opt out per task via `task.scopeOverride = true`; when present, the merger bypasses the invariant and logs `task.scopeOverrideReason` when provided. Empty declared file scopes are not enforced.

File Scope entries are validated when PROMPT.md is written: non-path tokens (git refs, URLs, SHAs, bare identifiers) are rejected with `InvalidFileScopeError`, and entries must be repo-relative paths/globs.

When `mergeConflictStrategy="smart-prefer-main"`, the merger also runs an overlap guard before the Attempt 3 `-X ours` fallback. If recent `main` commits (30-commit lookback) touched files the task branch also changed, the default `mergeStrategyOverlapBehavior="flip-to-prefer-branch"` makes those overlapping files prefer the task branch instead of silently discarding branch hardening; `warn-only` preserves the legacy fallback while logging the risk, and `ignore` disables the guard.

For manual follow-up, standalone auditing, or post-incident inspection, the script remains available:

```
node scripts/audit-squash-merge.mjs <squash-sha>
```

Review every flagged item yourself (no human handoff): for every duplicate-cherry-pick subject, diff the matching main commit against HEAD and confirm its net contribution survived; for every touched-file overlap, confirm the recent main commits' changes still appear in HEAD. If anything was silently dropped, restore it as a follow-up commit on the same branch before reporting the merge complete. Only if the audit is clean (or all losses have been restored) is the merge done.

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

### WebFetch tool (`fn_web_fetch`)

Use `fn_web_fetch` for lightweight URL reads from agent/chat sessions. It performs an HTTP GET, follows redirects, extracts readable text (including HTML→text and JSON pretty-print), and returns bounded content.

`fn_web_fetch` is a universal baseline capability and is available by default across all agent roles/surfaces (executor, step-session, reviewer, merger, triage, and heartbeat, including engineer/custom direct-report paths routed through heartbeat).

- Default limits: `timeoutMs=30000` and `maxBytes=512000` (500 KB)
- Security: blocks private/loopback/link-local hosts (including DNS-resolved private addresses) unless explicitly overridden in internal/test contexts
- Scope: read-only fetch (no JS rendering, no auth flows, no POST/cookie workflows)
- Use `agent-browser` skill when pages require JavaScript execution, interactive navigation, or richer browser behavior

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

Six tools enable inter-agent coordination — discovering agents, provisioning/decommissioning direct reports, delegating tasks, and managing direct-report configuration.

### `agent_create` Tool

Create a non-ephemeral agent that reports to the caller (or, for CEO-level callers, any `reportsTo` target).

Provisioning is policy-gated via `projectSettings.agentProvisioning` (`approvalMode`, `trustedRoles`, `trustedAgentIds`, `alwaysApproveDelete`). Tool responses use `details.outcome` values `created`, `deleted`, `pending_approval`, or `denied`. Pending requests are resolved via dashboard/API approval decision route (`POST /api/approvals/:id/decision`), which executes deferred provisioning on approve.

### `agent_delete` Tool

Delete a non-ephemeral direct report. If the target holds a task checkout lease, deletion is blocked unless `force: true`. Assigned tasks can be reassigned via `reassign_to` or released/unassigned.

Provisioning policy also applies to deletes (`details.outcome`: `deleted`, `pending_approval`, or `denied`). Provisioning emits audit events `agent:create:{requested,approved,denied}` and `agent:delete:{requested,approved,denied}` tied to the originating run/task metadata.

FN-3973 decision: `spawn_agent` remains under generic action-gate `task_agent_mutation` governance and is intentionally excluded from durable `agentProvisioning` policy. Rationale: spawned children are ephemeral (`metadata.type = "spawned"`), parent-task scoped (`reportsTo=<taskId>`), and auto-terminated with parent teardown.

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
| `override` | `boolean` (optional) | Set true to bypass executor-role assignment policy |

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
- `"ERROR: Agent {agent_id} has role \"...\"; implementation task <new> requires an \"executor\"-role agent. Pass override=true to bypass."` — Non-executor target blocked unless `override: true`

### `get_agent_config` Tool

Read full configuration for a direct-report agent (soul, instructions, runtime heartbeat settings, and memory).

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `agent_id` | `string` (required) | The direct-report agent ID to inspect |

**Authorization rule:** caller can only read agents where `target.reportsTo === caller.id`.

### `update_agent_config` Tool

Update configuration for a direct-report, non-ephemeral agent.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `agent_id` | `string` (required) | The direct-report agent ID to update |
| `soul` | `string` (optional) | Agent personality/identity text |
| `instructions_text` | `string` (optional) | Inline custom instructions |
| `instructions_path` | `string` (optional) | Path to instructions markdown |
| `heartbeat_procedure_path` | `string` (optional) | Path to heartbeat procedure markdown |
| `heartbeat_interval_ms` | `number` (optional) | Heartbeat polling interval (min 1000) |
| `heartbeat_timeout_ms` | `number` (optional) | Heartbeat timeout (min 5000) |
| `max_concurrent_runs` | `number` (optional) | Max concurrent heartbeat runs (min 1) |
| `message_response_mode` | `"immediate" \| "on-heartbeat"` (optional) | Message response behavior |

**Authorization rule:** caller can only update agents where `target.reportsTo === caller.id`.

**Error cases:**
- `"ERROR: Agent {agent_id} not found"`
- `"ERROR: You can only update configuration of agents that report to you"`
- `"ERROR: Cannot update ephemeral/runtime agent {agent_id}"`

**Note:** These coordination tools are available to executor and heartbeat agents when the relevant stores are configured.

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
10. **`[auto-claim-snapshot] rebuild generated=N reason=<ttl|invalidate>`** — Confirms project-wide auto-claim snapshot rebuild cadence
11. **`[auto-claim-prompt] agent=<id> chars=<n> count=<n>`** — Tracks rendered no-task candidate section size
12. **`[prompt-size] prompt-size { agentId, role, runId, template, systemChars, execChars, totalChars, isNoTaskRun }`** — Per-heartbeat prompt-size audit record

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

### Per-Task Token Budget Precedence

Task token budgets resolve in this order:
1. Per-task `task.tokenBudgetOverride`
2. Project `taskTokenBudget.perSize[task.size]`
3. Project `taskTokenBudget.soft/hard`
4. Global `taskTokenBudget.perSize[task.size]`
5. Global `taskTokenBudget.soft/hard`

Hard-cap hits pause the task with `pausedReason: "token_budget_exceeded"`; soft-cap hits emit a one-shot alert per task.

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
- Workflow steps support `gateMode`: `gate` failures block merge/remediation, while `advisory` failures are recorded as `advisory_failure` and do not block merge or trigger auto-revive.
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

These 17 views are lazy-loaded via `React.lazy()` to manage bundle size:

- `AgentsView`, `NodesView`, `ChatView`, `MemoryView`
- `DevServerView`, `InsightsView`, `DocumentsView`, `SkillsView`, `ResearchView`, `ReliabilityView`, `EvalsView`, `TodoView`, `StashRecoveryView`
- `SetupWizardModal`, `PluginManager`, `PiExtensionsManager`, `AgentDetailView`

They are loaded in `App.tsx` / `AppModals.tsx` / `SettingsModal.tsx` / `AgentsView.tsx` with `<Suspense fallback={null}>`. 

A `prefetchLazyViews()` function runs once on mount via `requestIdleCallback` to warm chunks. **Do not make these eager again** — bundle size matters.

### File browser editor

`packages/dashboard/app/components/FileEditor.tsx` is CodeMirror 6-backed as the single edit surface (no fallback `<textarea>` pane). Language resolution lives in `packages/dashboard/app/utils/codemirror-language.ts` via `resolveCodeMirrorLanguage(filePath)`, currently mapping JS/TS, CSS, JSON, and Markdown extensions; unknown extensions intentionally fall back to plain text.

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
| `--accent-text` | Foreground text/icon color on `--accent` surfaces |

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

**Touch-target convention — primary vs secondary controls (added 2026-05-13 after FN-3965/FN-4351):**

WCAG 2.5.8 / Apple HIG apply to the **primary interaction target** of a surface, not to every visible interactive element. Blanket-inflating secondary controls to 36px+ breaks density and is an anti-pattern.

- **Primary controls** (mobile nav bar, FAB, tab action rows, modal CTAs, list-row entire-row tap targets, settings/onboarding form controls): MUST be ≥36px on mobile. Use `calc(var(--space-xl) + var(--space-md))` or `.touch-target`.
- **Secondary controls** on a density-sensitive surface where the surface itself is the primary tap target (e.g., TaskCard's archive/unarchive/send-back/edit/delete buttons — the card body opens detail on tap; list-row hover-revealed action buttons; chip-style provenance/tracking affordances): MUST remain compact (typically 24–28px square or `font-size: 0.625rem`-class chips). Do NOT apply mobile touch-target inflation here.

If you're tempted to add `min-height: calc(var(--space-xl) + var(--space-md))` (or any 36px+ override) to a hover-revealed or chip-style control inside a card or list row, stop and ask: is the parent surface itself the tap target? If yes, the secondary control stays compact. Reference FN-3965 (the wrong application) and FN-4351 (the restoration) for the canonical case.

**Safe area:** Use `max(var(--space-md), env(safe-area-inset-left, 0px))` pattern for content respecting device notches on mobile.

---

### File-path links in dashboard text

- Reuse `packages/dashboard/app/utils/filePathLinkify.tsx` plus `packages/dashboard/app/context/FileBrowserContext.tsx` whenever a dashboard surface should open workspace paths in `FileBrowserModal`.
- Wrap plain text with `linkifyFilePaths(...)`, and wrap mixed JSX/markdown/highlight output with `linkifyReactChildren(...)` so existing formatting survives.
- Mount surfaces under `FileBrowserProvider` and route clicks through its `openFile(path, { workspace?, line?, col? })` handler instead of adding one-off modal state plumbing.

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
- **Mobile board view-switch scroll-snap pitfall (FN-001)** — `scroll-snap-type: x mandatory` on mobile `.board` can cause iOS Safari to compress the viewport into a corner when switching from ListView because stale layout measurements are snapped before flex children resolve. Use `scroll-snap-type: x proximity` combined with `overflow-anchor: none` instead.

## Reliability Mechanism Governance

Reliability mechanism changes are currently under freeze pending FN-4359 governance hardening; treat new reliability-layer behavior changes as blocked unless explicitly approved in task scope.

Reliability interaction regression backstops live in `packages/engine/src/__tests__/reliability-interactions/` and are the canonical location for cross-layer reliability coverage. Any task that adds or changes a reliability layer must add/update interaction tests in that directory for each plausible pair with existing layers (merge path, workflow/pre-merge, self-healing, scheduler/watchdog/restart recovery, and governance gates).
