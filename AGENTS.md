# Project Guidelines

## STANDING DIRECTIVE: Buttons Are Frozen (2026-05-13)

Do not file, plan, or implement tasks that adjust button mobile-responsiveness, touch-target sizing, or mobile reflow of header/action button rows anywhere in the dashboard (TaskCard, SettingsModal, ChatView, MissionManager, AgentsView, FAB, etc.). **Keep buttons as they are.**

This supersedes earlier guidance about mobile touch targets, primary/secondary control sizing on mobile, and `.touch-target` minimums for buttons. The `Frontend UX Design` workflow step (WS-006) is disabled and must stay disabled.

If you find yourself opening `SettingsModal.css`, `TaskCard.css`, `ChatView.css`, etc. inside an `@media (max-width: 768px)` block to touch a `.btn`, `.modal-close`, `.settings-header-actions`, or `.card-*` button — stop. Confirm with the user in chat before proceeding.

Exception: explicit named user request in chat that overrides this directive.

## Finalizing Changes

When a change affects the published `@runfusion/fusion` package, add a changeset:

```bash
cat > .changeset/<short-description>.md << 'EOF'
---
"@runfusion/fusion": patch
---

Short description of the change.
EOF
```

Bump types: **patch** (bug fixes / internal), **minor** (new features / CLI / tools), **major** (breaking). Commit the changeset alongside the code change.

Do NOT create changesets for internal docs (AGENTS.md, README), CI config, or behavior-preserving refactors. The other workspace packages (`@fusion/core`, `@fusion/dashboard`, `@fusion/engine`) are private — no changesets for them.

## Releasing

Always use the repo release script:

```bash
pnpm release --yes
```

`scripts/release.mjs` is the source of truth: preflight, apply changesets, update lockfile + root changelog, build, commit, publish, push `main`, push tag. Do not run `changeset version`, `pnpm publish`, or manual git tags as a substitute. The script also keeps `@runfusion/fusion` and `runfusion.ai` in sync.

## Package Structure

- `@fusion/core` — domain model, task store (private)
- `@fusion/dashboard` — web UI + API server (private)
- `@fusion/engine` — triage, executor, reviewer, merger, scheduler (private)
- `@runfusion/fusion` — CLI + pi extension (published to npm)

Only `@runfusion/fusion` is published. The others get inlined into the CLI bundle via tsup `noExternal: [/^@fusion\//]`.

### Importing across `@fusion/*` packages

For the inlining to work, `@fusion/*` imports must be **statically analyzable**. The following anti-pattern silently breaks the published CLI (FN-2613, Runfusion/Fusion#9):

```ts
// ❌ BROKEN: variable specifier defeats static analysis
const engineModule = "@fusion/engine";
const engine = await import(/* @vite-ignore */ engineModule);
```

esbuild leaves the dynamic import in the output, the package isn't installed at runtime, the catch swallows the error, and downstream calls fail with `createFnAgent2 is not a function`.

**Rules:**
1. Default to static imports: `import { createFnAgent } from "@fusion/engine"`.
2. Exception: `@fusion/core` cannot statically import engine (circular). Core uses DI via `setCreateFnAgent` in `packages/core/src/ai-engine-loader.ts`, called from `packages/engine/src/index.ts`. Don't add new dynamic `import("@fusion/engine")` in core — extend the loader.
3. Never reintroduce the `engineModule = "@fusion/engine"` trick. Treat any sighting as a bug.
4. `vi.mock("@fusion/engine", …)` hoists above static imports — mocking still works.

## Storage Model

Hybrid: structured metadata in SQLite (`.fusion/fusion.db`, WAL mode), large blobs (PROMPT.md, attachments) on disk under `.fusion/tasks/{ID}/`. See [docs/storage.md](./docs/storage.md).

## Multi-Project Support

Central registry at `~/.fusion/fusion-central.db`; per-project DB at `.fusion/fusion.db`. See [docs/multi-project.md](./docs/multi-project.md) for CentralCore API, isolation modes, and global concurrency.

## Testing

Tests are required. Typechecks and manual verification are not substitutes for assertions.

Use the narrowest command that exercises the behavior you changed, then broaden before reporting completion.

```bash
pnpm test              # changed-only workspace tests; falls back to full gate in safety contexts
pnpm test:full         # full workspace quality gate
pnpm lint              # lint all packages
pnpm build             # build workspace packages (excludes desktop/mobile)
pnpm verify:workspace  # canonical pre-merge gate: lint -> test:full -> build
```

`pnpm test:full` runs each package's default test script with capped worker fanout (`FUSION_TEST_TOTAL_WORKERS=4 FUSION_TEST_CONCURRENCY=2 pnpm -r --workspace-concurrency=2 test`). Do not casually raise worker counts; dashboard/jsdom and integration-heavy packages destabilize when oversubscribed. Use `VITEST_MAX_WORKERS=<n>` only for targeted package-level investigation.

### Fresh-worktree dist bootstrap

`pnpm test` auto-runs `scripts/ensure-test-artifacts.mjs` to rebuild missing/stale dist artifacts. Dashboard and `dependency-graph` package lanes auto-bootstrap too. If you hit opaque `Failed to resolve import "./cli-spawn.js"` (or similar), treat it as bootstrap regression against FN-4605 — don't work around with a manual `pnpm build`.

### Dashboard Test Lanes

```bash
pnpm --filter @fusion/dashboard test                # curated app/API quality gate (default)
pnpm --filter @fusion/dashboard test:deep           # exhaustive app + API suite
pnpm --filter @fusion/dashboard test:app            # exhaustive React/jsdom
pnpm --filter @fusion/dashboard test:api            # exhaustive Node API/server
pnpm --filter @fusion/dashboard test:browser-smoke  # local browser CSS/layout smoke
pnpm --filter @fusion/dashboard test:build          # built client output contract
```

Run `test:deep` when changing broad dashboard architecture, shared modal/view infrastructure, or route registration. Run `test:browser-smoke` for layout/responsive/navigation/modal/CSS changes. Run `test:build` for Vite output, lazy-loading, chunking, or client-dist changes.

When adding a new test file under `app/components/__tests__`, also add its basename to `qualityAppTests` in `packages/dashboard/vitest.config.ts` — otherwise the curated gate silently skips it.

### Targeted commands

```bash
pnpm --filter @fusion/core test
pnpm --filter @fusion/engine test
pnpm --filter @runfusion/fusion test
pnpm test:scripts
node --test scripts/__tests__/*.test.mjs
```

For a single Vitest file, use package-local `exec vitest`:

```bash
pnpm --filter @fusion/core exec vitest run src/__tests__/central-db.test.ts --silent=passed-only --reporter=dot
```

### Engine test helper convention

`packages/engine/src/__tests__/executor-test-helpers.ts` defaults both `isUsableTaskWorktree` to `true` and `classifyTaskWorktree` to `{ ok: true }` via a helper-level `worktree-pool` mock. To test failure paths, override with `vi.spyOn(worktreePool, "classifyTaskWorktree").mockResolvedValueOnce({ ok: false, classification: "unregistered", reason: "..." })` (or `isUsableTaskWorktree` for legacy call sites). Production liveness assertions in `executor.ts` are unchanged.

### Before Reporting Done

- Code changes: affected package tests + any directly relevant browser/build lane.
- Cross-package, shared test infrastructure, or CI changes: `pnpm test:full`.
- Production/bundling-sensitive changes: `pnpm build`.
- Substantial work: `pnpm verify:workspace`.
- If you skip a relevant lane, say why.

### Test File Organization

Test for `src/foo.ts` → `src/__tests__/foo.test.ts`. Test for `app/components/Bar.tsx` → `app/components/__tests__/Bar.test.tsx`. `__tests__/` is the standard.

### What NOT to write

Tests should cover behavior a user could notice break, not implementation shape. Don't write:

- **CSS-class permutation tests** — use one `it.each` for the boolean matrix, not one `it` per combination.
- **Field-presence tests** when a payload-roundtrip test already exercises the same field.
- **React.memo tautologies** — testing `React.memo` tests React, not us. Test custom comparators directly, one case.
- **Mock-the-world wiring tests** — if a test mocks 8+ deps just to render a component, shim children with `() => null` or delete and rely on an integration test one level up.
- **Structural CSS assertions** — "tab uses .class-name not inline style". Consolidate into one aggregate layout-contract test per component.

Prefer `it.each` over copy-pasted `it()` blocks. When trimming, keep: first case + opposite case + any precedence/override case.

### What TO keep unconditionally

- Tests linked to an FN-ticket in describe/it names — these guard real regressions.
- Integration tests exercising real SQLite, real worker pool, or spawned processes.
- Lean core/engine unit tests with low mock burden.

## Port 4040 is Reserved

Port 4040 is the production dashboard port. A user's live session is typically running there. **Agents must NEVER:**
- Run `kill`, `kill -9`, `pkill`, or `killall` against processes on port 4040.
- Start a test server on port 4040 — always use `--port 0` for a random free port.

## Architecture invariants

Detailed mechanism logs live in `docs/architecture.md` and `docs/design/`. The contracts agents must respect:

- **Orphan `fusion/*` branches**: prune-or-rescue, never force-delete. Subsumed branches pruned; unique-commit branches rescued into triage tasks.
- **Stale active branches**: self-healing's `reclaim-stale-active-branches` stage prunes a `fusion/<task-id>` branch with zero unique commits when no usable worktree mapping exists, then clears `task.branch`/`task.worktree`/`task.baseCommitSha`. It must defer reclaim (emit `branch:stale-active-reclaim-deferred`) when the task worktree is in `activeSessionRegistry`, when `executionStartedAt` is within `STALE_ACTIVE_BRANCH_EXECUTION_GRACE_MS` (10 minutes), or when the mapped worktree has uncommitted changes.
- **Worktree metadata reconcile ordering (FN-4962)**: `reconcile-task-worktree-metadata` must run before `reclaim-stale-active-branches`; stale `task.worktree` metadata is rebound to live `fusion/<task-id>` worktrees when present (`task:auto-recover-worktree-metadata-rebound`) or cleared (`task:auto-recover-worktree-metadata-cleared`) when absent.
- **Completion fan-out is synchronous**: `SelfHealingManager.reconcileCompletedTask()` runs on `in-review → done`. Downstream stale `blockedBy` links and residual `fusion/<task-id>` branch/worktree artifacts are reconciled immediately, not on a periodic sweep.
- **In-review stall deadlock**: identical stalls (same code + reason) repeated past `inReviewStallDeadlockThreshold` (default 3) auto-pause with `pausedReason: "in-review-stall-deadlock"` and `status: "failed"`.
- **Restart recovery**: `RestartRecoveryCoordinator` classifies interrupted `in-progress` runs. Unusable-worktree session-start failures (`missing`, `incomplete`, `unregistered git worktree`) are recoverable; retries are capped at `MAX_WORKTREE_SESSION_RETRIES=3` before escalating.
- **Executor pre-session liveness gate (FN-4935)**: the gate now skips for fresh acquisitions (`acquisition.source === "fresh"`), emits structured `not_usable_task_worktree:<classification>` diagnostics (including canonicalized registered-path snapshots) and a `worktree:incomplete-detected` audit event with `source: "executor-liveness-gate"`, while preserving the existing `taskDoneRetryCount` / `MAX_TASK_DONE_REQUEUE_RETRIES` requeue contract. FN-4651 `worktreeSessionRetryCount` remains scoped to the in-review/session-start recovery path.
- **Stale self-owned active-session reconcile on conflict cleanup (FN-4973)**: when executor worktree-conflict cleanup finds only a same-task stale `activeSessionRegistry` entry and no live in-memory `activeWorktrees` binding for that task/path, it must unregister the stale entry before `removeWorktree` (plus one-shot backstop reconcile on same-task `ActiveSessionWorktreeRemovalError` races). Foreign-task entries remain protected by FN-4811 and must never be reconciled by the requesting task.
- **Task title/ID drift (FN-4898)**: active and archived title writes normalize foreign embedded `FN-NNN` tokens via `packages/core/src/task-title-id-drift.ts`. Empty placeholder groups (`()`, `[]`, `{}`) left behind by token stripping are also removed in both `normalizeTitleForTaskId` and `sanitizeTitle` (FN-4978). Lineage is preserved in `sourceParentTaskId` / description markers, not title embeds.
- **PR-conflict reclaim wiring (FN-4763)**: GitHub PR refresh now persists normalized `prInfo.mergeable` conflict state and, when conflicting, funnels tasks into self-healing’s existing reclaim machinery (`reclaimPrConflictForTask` / `reclaim-pr-conflicts` stage) so branch-conflict handling stays centralized with existing `inspectBranchConflict` outcomes and unrecoverable pause semantics.
- **Worktrunk-managed lifecycles**: when `worktrunk.enabled`, self-healing defers prune/idle/worktree-cap sweeps to the worktrunk backend; branch-level reclaim and orphan rescue stay native.
- **Post-finalize verification no-op (FN-4944)**: when auto-merge receives a delayed `VerificationError` after a task is already `done` with `mergeDetails.mergeConfirmed === true` (already-on-main fast-path), it must log one `[verification] ... no action` diagnostic and must not bounce the task back to `in-progress` / `merging-fix`. Defense-in-depth now re-checks the done+mergeConfirmed condition immediately before each verification-failure status write site, and emits `task:post-finalize-verification-no-op` database audit events with failure metadata for forensics.
- **Worktree pool exclusivity (FN-4954)**: `WorktreePool.acquire(taskId)` / `release(path, taskId?)` track a `leased` map so every pooled path is either idle or leased, never both. Cross-task double-lease detection throws `PoolDoubleLeaseError` and emits `worktree:pool-double-lease-detected`; merger Step 8 now detaches HEAD and clears `task.worktree` / `task.branch` before releasing paths back to the pool.
- **Scheduler fanout tiebreaker (FN-4969)**: within the same priority class, scheduler dispatch prefers runnable `todo` tasks with the highest active dependency-dependent fanout; `urgent` always outranks lower priorities regardless of fanout, and `overlapBlockedBy`/file-scope overlap blockers are excluded from unblock weight.

## Engine Process Rules

The engine runs the executor, merger, scheduler, IPC host, and dashboard activity loop on a single Node event loop. **Blocking that loop stalls every task in-flight.**

### Never use `execSync` for User-Configured Commands

Any command from project settings — `testCommand`, `buildCommand`, workflow step scripts — **must** run via `promisify(exec)` with a `timeout`:

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

`execSync` is only acceptable for short deterministic git plumbing (`git rev-parse`, `git branch -d`, `git worktree remove`). User-configured command wiring lives under `packages/engine/src/sandbox/` (FN-4636 seam); keep internal git plumbing on direct async exec.

### Move-Task contract

User-initiated `moveTask(in-progress → todo)` is a hard cancel: executor listeners must abort active sessions before dispose, stop step/workflow subprocesses, and leave the task parked in `todo` with `userPaused` semantics intact. Engine-initiated rebounds (pause, stuck recovery, workflow rerun, self-healing) use default `moveSource: "engine"` plus the appropriate `preserve*` flags and must not set `userPaused`.

### Executor run-context isolation

`TaskExecutor` run mutation context is now keyed per task (`currentRunContexts: Map<taskId, RunMutationContext>`), not a single shared mutable field. This prevents FN-4987-style cross-task audit attribution leaks where one task's `runId` appeared in another task's `scope-leak`/`fn_task_done` logs.

## Git Conventions

- Commit messages: `feat(FN-XXX):`, `fix(FN-XXX):`, `test(FN-XXX):`
- One commit per step (not per file change)
- Always include the task ID prefix

## Merging Branches Into Main

Hard-won rules (FN-2370 silently reverted three commits' worth of work):

1. **Drop duplicate commits before merging.** If a branch contains commits that duplicate work already on main, rebase to drop them. Auto-resolvers cannot tell which side is canonical and will silently discard refinements. `git log main..branch --format=%s` should not overlap with `git log <base>..main --format=%s`.
2. **Rebase over squash for multi-commit branches.** Fusion's direct merger defaults `directMergeCommitStrategy="auto"`: squash for 0–1 substantive commits, history-preserving rebase/cherry-pick otherwise. Force via project setting or `**Direct Merge Commit Strategy:** auto|always-squash|always-rebase` in PROMPT.
3. **Empty cherry-picks are no-ops.** Cherry-pick merges treat git's empty-pick signatures as "already on main" — empty commits skipped, fully-subsumed branches auto-complete, no empty commit created.
4. **Already-on-main classifier.** Verification-fix finalize and self-healing both recover when a task's lineage is already landed (emits `task:auto-recover-finalize-already-on-main`, `task:auto-recover-branch-misbound`).
5. **Contamination auto-recovery.** When every foreign-attributed commit is upstream by patch-id, the executor drops them and requeues. A second contamination event escalates to paused human adjudication. FN-4499 adds a bootstrap-misbinding safety branch (foreign-only attribution → `reanchorBranchToBase` + requeue) before the contamination classifier. FN-4887 adds a self-healing foreign-only sweep for in-review/paused tasks, with bounded auto-recovery only when `ownCommitCount === 0`, `nonAttributedCount === 0`, and every foreign commit is attributable by subject or `Fusion-Task-Id` trailer; this emits `task:auto-recover-foreign-only-contamination` / `task:auto-recover-foreign-only-contamination-skipped` and leaves ambiguous cases to manual recovery (FN-4860/FN-4875 boundary).
6. **Post-squash audit on auto-resolved conflicts.** `postMergeAuditMode`: `warn` (default), `block` (refuse on findings), `off`. Rebase-strategy overlap-only findings auto-clear when deterministic verification has proven the merged tree. When findings still block, the `mergeAuditAutoRecovery` pipeline runs (Stages 1–5: deterministic → programmatic → ai-assisted → bounded retries → park-with-follow-up).
7. **Pre-commit diff-volume gate.** Before writing an auto-resolved squash commit, the merger compares each file's staged squash delta against branch net delta vs merge-base. Non-allowlisted files losing too much branch volume block the merge in `in-review`. Guard against FN-3936-style silent drops.
8. **Smart-prefer-main overlap guard.** When `mergeConflictStrategy="smart-prefer-main"`, recent main commits (30-commit lookback) overlapping branch-modified files flip to prefer-branch by default (`mergeStrategyOverlapBehavior="flip-to-prefer-branch"`).
9. **Layer 3 scope partition for AI arbitration (FN-4956).** Before handing conflicted files to the Layer 3 AI arbiter, merger partitions conflicts against declared task File Scope. Out-of-scope conflicts are resolved to main (`--ours`) and unstaged so they cannot enter the squash; only in-scope conflicts reach AI. `task.scopeOverride=true` bypasses this partition. Run-audit emits `merge:layer3:foreign-file-skipped` (skip path) or `merge:layer3:scope-override-bypass` (override path).
10. **Auto-prerebase on hot-file/threshold divergence (FN-4958).** Before Stage 1 remote rebase, merger may prerebase the task branch onto local main when hot-file overlap or divergence threshold triggers (`packages/engine/src/merger-auto-prerebase.ts`). Failures are fail-soft (`merge:auto-prerebase:failed`) and fall through to the existing Stage 1/2/Layer 1–3 cascade; worktrunk-enabled paths defer this layer.

### Gitignored-path guard on squash merges

The merger strips gitignored paths from staged squash sets before commit (standard, Attempt 3 fallback, and verification-fix rebuild). Any staged ignored path is unstaged and logged.

**Agents must never** `git add -f .fusion/...` or force-add any ignored scratch artifact. Findings, diagnosis, and test-plan notes belong in task documents via `fn_task_document_write`, not committed files.

### File-Scope invariant on squash merges

Every squash commit path enforces a file-scope invariant immediately before commit: the staged set must overlap the task's declared `## File Scope` from `PROMPT.md`. Zero overlap with a non-empty scope throws `FileScopeViolationError`, resets pre-squash state, and parks the task in `in-review`.

Per-task opt-out: `task.scopeOverride = true` (log `task.scopeOverrideReason` when set). Empty scopes are not enforced.

File Scope entries are validated when PROMPT.md is written — non-path tokens (git refs, URLs, SHAs, bare identifiers) are rejected with `InvalidFileScopeError`.

### Manual audit script

For post-incident inspection: `node scripts/audit-squash-merge.mjs <squash-sha>`. Review every flagged item yourself — for each duplicate-cherry-pick subject, diff the matching main commit against HEAD and confirm survival. Restore any silent drops on the same branch before reporting merge complete.

## Pi Extension (`packages/cli/src/extension.ts`)

The pi extension ships as part of `@runfusion/fusion` and provides tools + a `/fn` command for chat agents.

**Update when:**
- CLI commands change (behavior, flags, output)
- Task store / Agent store API changes
- New user-facing features chat agents should be able to use

**Don't add tools for engine-internal operations** (move, step updates, logging, merge) — those are owned by the engine's own agents.

The extension has no skills — tool descriptions give the LLM everything it needs.

### `fn_web_fetch`

Lightweight URL read from agent/chat sessions. HTTP GET, follows redirects, extracts readable text (HTML→text and JSON pretty-print), bounded.

Universal baseline: available by default across executor, step-session, reviewer, merger, triage, and heartbeat (including engineer/custom direct-report paths). Gated under the `network_api` action-gate category (FN-4603).

- Defaults: `timeoutMs=30000`, `maxBytes=512000` (500 KB)
- Blocks private/loopback/link-local hosts (including DNS-resolved) unless explicitly overridden in internal/test contexts
- Read-only (no JS rendering, no auth flows, no POST/cookie workflows)
- Use the `agent-browser` skill when JS rendering or interactive navigation is required

## Agent Coordination Tools

Seven coordination tools support spawning, provisioning, discovery, delegation, and direct-report config. Detailed parameter contracts live in tool descriptions and `docs/agents.md`.

- `spawn_agent` — Parent-task-scoped ephemeral child in its own worktree. Limits via `maxSpawnedAgentsPerParent` (default 5) and `maxSpawnedAgentsGlobal` (default 20). Auto-terminated with parent. Gated under generic `task_agent_mutation` (FN-3973 explicitly excludes it from durable `agentProvisioning` policy).
- `agent_create` / `agent_delete` — Non-ephemeral provisioning of direct reports. Policy-gated via `projectSettings.agentProvisioning` (`approvalMode`, `trustedRoles`, `trustedAgentIds`, `alwaysApproveDelete`). Tool responses use `details.outcome`: `created` / `deleted` / `pending_approval` / `denied`. Pending requests resolve via `POST /api/approvals/:id/decision`. Audit events: `agent:{create,delete}:{requested,approved,denied}`.
- `list_agents` — Discovery with `role`/`state`/`includeEphemeral` filters.
- `delegate_task` — Create + assign task to a specific agent. Implementation tasks require executor-role target unless `override: true`. Cannot target ephemeral agents (use `spawn_agent`).
- `get_agent_config` / `update_agent_config` — Read/write soul, instructions, heartbeat interval/timeout, max concurrent runs, message response mode. **Authorization**: caller can only act on agents where `target.reportsTo === caller.id`. Cannot operate on ephemeral agents.

## Checkout Leasing

- 409 Conflict = ownership contention. Response: `{ error, currentHolder, taskId }`. **Never auto-retry 409.**
- `HeartbeatMonitor.executeHeartbeat()` validates checkout before work begins; mismatched `checkedOutBy` exits with `reason: "checkout_conflict"`. Heartbeat does not auto-checkout — callers obtain the lease.
- With `CentralClaimStore` wired, the authoritative owner is the central `taskClaims` row; per-project lease fields mirror it. `MeshLeaseManager.recoverAbandonedLease()` releases central first then local. `reconcileLeaseRow(taskId)` converges divergent state on the next tick (emits `task:auto-recover-lease-*`). Without a claim store, behavior remains single-node per-project.

## Agent Runtime Config

Per-agent overrides via `runtimeConfig`:
- **Heartbeat**: `heartbeatIntervalMs`, `heartbeatTimeoutMs`, `maxConcurrentRuns`. Triggered by timer, task assignment, or on-demand (`POST /api/agents/:id/runs`).
- **Budgets**: per-agent token budget tracking; `HeartbeatMonitor.executeHeartbeat()` skips when `isOverBudget` or `isOverThreshold` (timer triggers). Hard caps pause the agent.
- **Performance ratings**: 1–5 scale with trend analysis, injected into system prompts.

See [docs/agents.md](./docs/agents.md) for the full contract.

## Settings

Two tiers: global (`~/.fusion/settings.json`) overridden by project (`.fusion/config.json`). Configure via dashboard Settings modal or `fn settings`. Full reference: [docs/settings-reference.md](./docs/settings-reference.md).

### Model selection hierarchy

All three lanes (planning / executor / reviewer) follow the same 5-tier precedence:

1. Per-task override (`planningModelProvider`/`Id`, `modelProvider`/`Id`, `validatorModelProvider`/`Id`)
2. Project lane (`planningProvider`/`Id`, `executionProvider`/`Id`, `validatorProvider`/`Id`)
3. Global lane (`planningGlobalProvider`/`Id`, `executionGlobalProvider`/`Id`, `validatorGlobalProvider`/`Id`)
4. Project `defaultProviderOverride` / `defaultModelIdOverride`
5. Global `defaultProvider` / `defaultModelId` → automatic resolution

### Per-task token budget precedence

1. `task.tokenBudgetOverride`
2. Project `taskTokenBudget.perSize[task.size]`
3. Project `taskTokenBudget.soft/hard`
4. Global `taskTokenBudget.perSize[task.size]`
5. Global `taskTokenBudget.soft/hard`

Hard cap → pause with `pausedReason: "token_budget_exceeded"`. Soft cap → one-shot alert per task.

### Model presets

Standardize executor/validator pairs; auto-selectable by task size (Small → Budget, Medium → Normal, Large → Complex). See settings reference.

## Missions

- **Autopilot** — watches task completion and activates the next slice. States: `inactive → watching → activating → completing`. See [docs/missions.md](./docs/missions.md).
- **Planning context** — feature → task triage enriches descriptions with full mission → milestone → slice → feature hierarchy.
- **Planning tools** — `fn_mission_create`, `fn_milestone_add`/`update`, `fn_slice_add`/`activate`, `fn_feature_add`/`update`/`link_task`. `fn_milestone_update` and `fn_feature_update` accept partial patches.

## Workflow Steps

Reusable quality gates at configurable lifecycle phases. **Pre-merge** can block; **post-merge** is informational. `gateMode` is `gate` (failure blocks merge/remediation) or `advisory` (records `advisory_failure`, no block, no auto-revive). Defined as **prompt** (AI review) or **script** (deterministic command). See [docs/workflow-steps.md](./docs/workflow-steps.md).

## Run Audit

Every engine mutation is recorded across four domains:
- **Database** — task:create, task:update, task:move, `room:ambiguity:branch` (deictic message routing telemetry), etc.
- **Git** — worktree:create, commit:create, merge:resolve, etc.
- **Filesystem** — file:write, prompt:write, attachment:create, `secret:read|create|update|delete|approval-requested|approval-granted|approval-denied|sync-push|sync-pull`, `secret:env-*`, etc.
- **Sandbox** — `sandbox:prepare`, `sandbox:run`, `sandbox:failure`, `sandbox:fallback`.

Events are tied to run IDs end-to-end. See [docs/architecture.md](./docs/architecture.md) for the audit API.

## Archive Cleanup

Archived tasks can be cleaned up while preserving metadata. Restored tasks keep metadata but lose attachments and agent logs. See [docs/task-management.md](./docs/task-management.md).

## Secrets

AES-256-GCM-encrypted storage in project (`secrets`) and global (`secrets_global`) scopes. Per-secret access policy (`auto`/`prompt`/`deny`) resolved as `row → global default → "prompt"`. Master key via the core `MasterKeyProvider` abstraction. `fn_secret_get` is shipped in `packages/cli/src/extension.ts` (`key`, optional `scope`; `auto`/`prompt`/`deny` policy branches with `secret:read`/approval audit events and no plaintext in audit payloads). See [docs/secrets.md](./docs/secrets.md) for current capabilities; remaining open gap is master-key rotation UX.

## Node Dashboard

Mesh-network node management UI. Settings/auth/secrets sync endpoints documented in [docs/architecture.md](./docs/architecture.md). All remote endpoints require the target node's `apiKey`; inbound endpoints validate `Authorization: Bearer <apiKey>`.

## Headless Node Mode (`fn serve`)

Starts API server + AI engine without a frontend. Binds `0.0.0.0` by default. Health endpoint + startup banner in [docs/architecture.md](./docs/architecture.md).

## Terminal UI

The Ink-based TUI is part of `fn` (no separate `@fusion/tui` package). Implementation: `packages/cli/src/commands/dashboard-tui/`.

## Engine Diagnostic Logging

Structured logging via `createLogger()` from `packages/engine/src/logger.ts`. All lines prefixed with subsystem name. See [docs/diagnostics.md](./docs/diagnostics.md) for the full key-diagnostic-points catalog. Notable subsystems include `[executor]`, `[scheduler]`, `[stuck-detector]`, `[auto-claim-snapshot]`, `[prompt-size]`, `[wake-trigger-diagnostics]`, `[retry-burned]`, and `[room-ambiguity]`.

`AgentSemaphore` (`packages/engine/src/concurrency.ts`) has defensive guards: `limit` getter returns minimum 1; `availableCount` returns 0 for invalid limits.
- `[executor] FN-XXX: fn_task_done refused (<class>) — <reason>` (explicit tool path) and `[executor] FN-XXX: fn_task_done refused (<class>) — <reason> (implicit completion)` (implicit all-steps-done path) now share refusal-class diagnostics for `summary-claims-incomplete` (explicit only), `bulk-step-completion-without-review`, and `pending-code-review-revise`; both paths consume the same `MAX_TASK_DONE_REQUEUE_RETRIES` budget and escalate to `in-review` with `status: "failed"` on exhaustion.

## Dashboard UI Styling Guide

The dashboard's CSS is split into a global stylesheet (`packages/dashboard/app/styles.css`) and per-component files (`packages/dashboard/app/components/ComponentName.css`). Each `ComponentName.tsx` imports its stylesheet at the top.

**Rule:** New CSS for a component goes in `app/components/ComponentName.css`, NOT `styles.css`. Only design tokens, primitives (`.btn`, `.card`, `.modal`, `.form-input`), and cross-component `@media` overrides belong in the global file.

The `index.html` shell is templated server-side: the server injects a per-user `<link rel="modulepreload">` for the last-used `taskView` chunk, sourced from Vite's `dist/client/.vite/manifest.json` and `kb:<projectId>:kb-dashboard-task-view` in localStorage.

### Design tokens

`styles.css` is the source of truth for tokens (`--space-*`, `--radius-*`, `--shadow-*`, `--transition-*`, `--font-*`, `--header-height`, `--mobile-nav-height`, `--standalone-bottom-gap`, `--overlay-padding-top`) and color variables (`--bg`, `--surface`, `--card`, `--text`, `--text-muted`, status colors `--triage`/`--todo`/`--in-progress`/`--in-review`/`--done`, semantic `--color-success`/`--color-error`/`--color-warning`/`--color-info`, status backgrounds `--status-*-bg`).

**Always reference tokens. Never hardcode pixels, hex, or `rgba()` in component CSS** — the only exception is inside `:root`/theme blocks where tokens are *defined*. For translucent backgrounds use `color-mix(in srgb, var(--color) X%, transparent)`, not `rgba()`.

### Theme system

Dark/light modes via `data-theme`; 54 color themes via `data-color-theme` (lazy-loaded from `app/public/theme-data.css`).

- **Base tokens** (`--bg`, `--surface`, etc.) — redefine in `:root`, `[data-theme="light"]`, and every theme block.
- **Semantic tokens** (`--autopilot-pulse`, `--event-error-text`, `--badge-mission-*`, `--fab-*`) — `:root` + `[data-theme="light"]` only; no per-color-theme overrides.
- **Status tokens** (`--triage`, `--todo`, etc.) — redefine per theme block.

`status-colors-theme.test.ts` iterates all theme blocks to catch regressions.

### Component classes

Reuse existing primitives from `styles.css`:
- **Buttons**: `.btn`, `.btn-primary`, `.btn-danger`, `.btn-warning`, `.btn-sm`, `.btn-icon`, `.btn-icon--active`, `.btn-badge`. All inherit `:focus-visible` via `--focus-ring-strong` and `:active` via `transform: scale(0.97)`.
- **Modals**: `.modal-overlay[.open]`, `.modal`, `.modal-lg`, `.modal-header`, `.modal-close`, `.modal-actions`, `.modal-actions-left/right`. Overlay pads top with `--overlay-padding-top`.
- **Forms**: `.form-group`, `.input`, `.select`, `.checkbox-label`, `.form-error`. Inputs in `.form-group` get focus styles automatically.
- **Cards**: `.card`, `.card-header`, `.card-id`, `.card-title`, `.card-meta`, `.card-status-badge--{triage,todo,in-progress,in-review,done,archived}`.
- **Utility**: `.touch-target` (44px min), `.visually-hidden`.

Don't create parallel button/form variants — add states (`:hover`, `:focus-visible`, `:active`) to the existing primitives.

### Mobile responsive

Breakpoints: 768px (primary mobile), 1024px (tablet `min-width: 769px and max-width: 1024px`), 640px (compact), 480px (xs). Mobile overrides go in `@media (max-width: 768px)` blocks at the bottom of `styles.css` after base styles.

**Bottom spacing:** `--mobile-nav-height` (44px) + `env(safe-area-inset-bottom, 0px)` + `--standalone-bottom-gap` (0/8px PWA). All bottom-positioned mobile elements compose those.

**Touch targets:** Standing button-freeze directive supersedes per-button touch-target guidance. For non-button elements, primary controls (nav bar, FAB, tab action rows, modal CTAs, list-row tap targets, form controls) must be ≥36px on mobile. Secondary controls inside a card/list-row where the row itself is the tap target stay compact (24–28px or small chips).

**Safe area:** `max(var(--space-md), env(safe-area-inset-left, 0px))` for notch-aware horizontal padding.

### Lazy-Loaded Heavy Views

These 18 views are lazy-loaded via `React.lazy()` with `<Suspense fallback={null}>`. `prefetchLazyViews()` warms chunks once on mount via `requestIdleCallback`. **Do not make these eager.**

- `AgentsView`
- `NodesView`
- `ChatView`
- `MemoryView`
- `DevServerView`
- `InsightsView`
- `DocumentsView`
- `SkillsView`
- `ResearchView`
- `ReliabilityView`
- `EvalsView`
- `TodoView`
- `GoalsView`
- `StashRecoveryView`
- `SetupWizardModal`
- `PluginManager`
- `PiExtensionsManager`
- `AgentDetailView`

When adding or removing entries, update `packages/dashboard/app/__tests__/lazy-loaded-views-docs.test.ts` (expected set + count).

### CSS testing

Use `packages/dashboard/app/test/cssFixture.ts`:

```ts
import { loadAllAppCss, loadAllAppCssBaseOnly } from "../test/cssFixture";
const allCss = await loadAllAppCss();          // styles.css + all component .css
const baseOnly = await loadAllAppCssBaseOnly(); // strips @media/@supports
```

**Never** directly `readFileSync('../styles.css')` — an ESLint rule (`no-restricted-syntax` in `eslint.config.mjs`) bans this and points at `cssFixture.ts`. `vitest.config.ts` has `test.css: { include: [/.+/] }` so component CSS imports inject into jsdom for `getComputedStyle` assertions.

### File browser editor & autosize textarea

- `FileEditor.tsx` is CodeMirror 6-only (no `<textarea>` fallback). Language resolution: `packages/dashboard/app/utils/codemirror-language.ts`.
- For chat-style composer fields use `packages/dashboard/app/hooks/useAutosizeTextarea.ts`. Pattern: `height = "auto"` then clamp `scrollHeight` to min/max in `useLayoutEffect`. Pair with `resize: none` and `overflow-y: auto`.

### File-path links

Reuse `packages/dashboard/app/utils/filePathLinkify.tsx` and `FileBrowserContext`. Wrap plain text with `linkifyFilePaths(...)`, mixed JSX with `linkifyReactChildren(...)`. Mount under `FileBrowserProvider` and route clicks through its `openFile(path, { workspace?, line?, col? })`.

### Common pitfalls

- **`--surface-hover` undefined** — reference with a fallback (`var(--surface-hover, rgba(0,0,0,0.03))`) or define explicitly.
- **BEM specificity** — when a container state class and an element modifier target the same node, the container can win. Use `:not(.modifier)` to scope.
- **CSS `@media` detection** — track brace depth to confirm a rule is mobile-scoped; don't scan backwards for the nearest `@media`. Many components are global even if visually mobile-only.
- **Mobile board scroll-snap (FN-001)** — `scroll-snap-type: x mandatory` on mobile `.board` causes iOS Safari to compress the viewport when switching from ListView. Use `x proximity` + `overflow-anchor: none`.
- **`lucide-react` icon adds** — update `vi.mock("lucide-react")` test mocks immediately; missing exports cascade.
- **`.spin` is global** — don't redefine the generic spin keyframes in component CSS.

## Reliability Mechanism Coverage

Reliability-layer changes are in scope. Interaction regression backstops live in `packages/engine/src/__tests__/reliability-interactions/` — any task that adds or changes a reliability layer must add/update interaction tests there covering each plausible pair with existing layers (merge path, workflow/pre-merge, self-healing, scheduler/watchdog/restart recovery, governance gates).

- FN-4935 backstop: `packages/engine/src/__tests__/reliability-interactions/executor-liveness-gate.test.ts` guards fresh-acquisition skip behavior, structured liveness classifications, and executor-gate audit/requeue outcomes.
- FN-4887 backstop: `packages/engine/src/__tests__/reliability-interactions/foreign-only-contamination-recovery.real-git.test.ts` covers composition between bootstrap-misbinding, contamination dispatcher retry, misbound-in-review ordering, and FN-4811 active-session safeguards.
- FN-5039 backstop: `packages/engine/src/__tests__/reliability-interactions/worktree-contamination-attribution.real-git.test.ts` guards `captureModifiedFiles` trailer attribution filtering and `task:worktree-contamination-detected` audit fan-out across rebase contamination, clean, untrailered, and fallback paths.
- FN-4976 backstop: `packages/engine/src/__tests__/reliability-interactions/stale-self-owned-session-registry.test.ts` guards `cleanupConflictingWorktree` clearing stale same-task `activeSessionRegistry` entries before the FN-4811 foreign-owner check, while preserving refusal behavior for foreign owners and live same-task bindings.
- FN-4999 backstop: `packages/engine/src/__tests__/reliability-interactions/completion-handoff-limbo.test.ts` covers the `recoverCompletionHandoffLimbo` sweep stage (grace window, active-task skip, merge-blocker guard, capped retries, and audit fan-out).

The auto-recovery dispatcher at `packages/engine/src/auto-recovery.ts` (FN-4533) composes on top of existing layers (FN-4500 fast-path, FN-4508 deterministic branch-conflict, FN-4499 bootstrap-misbinding, FN-4428 contamination, `mergeAuditAutoRecovery` Stages 1–5, self-healing) to handle six residual classes: file-scope violation at squash, branch misbinding / ghost worktree, verification-fix scope leak, contamination, `branch-conflict-unrecoverable` residuals, and room-post/message-send failures. Invocation is additive — no existing layer's behavior changes.
