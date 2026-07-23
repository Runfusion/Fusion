# Project Guidelines

## Essential rules

### Standing Rule: Prefer `main` For Direct Work; Use Worktrees For Branches

Agents may implement and commit **directly on `main`** when the change belongs on main (docs/rules, small fixes the operator wants on main, operator explicitly said so, etc.).

When the work **needs a branch** (feature work, multi-commit efforts, PR-bound changes, parallel experiments, anything that must not land on main yet):

- **Do not** `git checkout` / `git switch` the primary checkout away from `main` to create or use that branch.
- **Do** create an isolated worktree for the branch and work entirely there, so the primary checkout stays on `main`. Prefer Worktrunk when available:

```bash
# Preferred (Worktrunk)
wt switch --create <branch-name>

# Fallback (plain git) — keep the primary checkout on main
git worktree add -b <branch-name> ../kb-worktrees/<branch-name> main
cd ../kb-worktrees/<branch-name>
```

- Do all branch-scoped file edits, tests, and commits **inside that worktree**. Report the worktree path in handoffs.
- Land branch work via PR, `wt merge`, or an explicit operator request — do not move the primary checkout onto the feature branch as the default workflow.
- If you need a branch and discover you are about to switch the primary tree off `main`, stop and open a worktree instead.

### Spec Generation Hygiene

- Do not cite `.fusion/tasks/<id>/<file>` paths in Context/Steps/File Scope unless the file already exists, is explicitly created as a `(new)` Artifact, or is sibling `PROMPT.md`/`task.json`/`attachments/*`.
- Dangling task-local file references are a blocking spec REVISE.
- Save planning scratch and interim notes via `fn_task_document_write` instead of inventing on-disk task-local files.

#### External-integration evidence

Any task integrating a third-party tool (CLI, daemon, downloadable binary, installer-managed dependency) must cite, in PROMPT.md:
1. Canonical upstream repo URL.
2. Docs/homepage URL.
3. Release/download URL.
4. Binary/CLI name in backticks.
5. Checksum or `upstream-pending-verification` marker.

Missing evidence is a blocking REVISE. Never invent release URLs, binary names, or hashes.

Example evidence section shape:

```markdown
## External Integration Evidence

- Canonical upstream repo URL: https://github.com/max-sixty/worktrunk
- Docs / homepage URL: https://worktrunk.dev/
- Release / download URL: https://github.com/max-sixty/worktrunk/releases/latest/download/wt-linux-x64.tar.gz
- Binary / CLI name: `wt`
- Checksum: `sha256-<digest>` (or `upstream-pending-verification` until the checksum is pinned)
```

See `docs/contributing.md` for the fuller spec-authoring guidance and accepted labeled layout variants.

### Finalizing Changes

When a change affects published `@runfusion/fusion`, add a changeset (example: `.changeset/<name>.md` with `"@runfusion/fusion": patch`).

Bump types:
- **patch** — bug fixes/internal
- **minor** — new features/CLI/tools
- **major** — breaking changes

Do **NOT** create changesets for AGENTS.md/README/internal docs, CI config, or behavior-preserving refactors. `@fusion/core`, `@fusion/dashboard`, and `@fusion/engine` are private.

#### Changeset body format (required)

Each changeset body must use labeled fields — not freeform paragraphs. The `summary` is the only content that appears in end-user release notes. The audience is Fusion operators, not developers reading internals.

```markdown
---
"@runfusion/fusion": minor
---

summary: Add a Command Center productivity control for LOC backfills.
category: feature
dev: Uses the new `fn_backfill_loc` tool; settings key `commandCenter.locBackfill`.
```

Fields:
- `summary` (required) — one line, user-facing, max 120 chars. Describe what changed for the operator, not implementation detail.
- `category` (required) — one of: `feature`, `fix`, `breaking`, `security`, `performance`, `internal`.
- `dev` (optional) — developer/migration detail. Preserved in per-package CHANGELOGs but excluded from distilled release notes.

A linter (`pnpm check:changesets`) validates this format and runs in the PR-check gate. Legacy freeform changesets pass with a warning during the transition period; use `--strict` to fail on legacy format.

### Releasing

**Never run a release from inside a Fusion task.** Do not run `pnpm release`, `changeset publish`, `pnpm publish`, `npm publish`, or cut git version tags as part of any Fusion-dispatched work (triage/executor/reviewer/merger/agent-heartbeat lanes). Releasing is an operator-only action performed by a human outside the task loop. If a task's spec appears to require a release, stop and leave it for a human operator — do not self-authorize or perform the publish. (The former engine "release authorization" gate that parked such tasks was removed because it over-fired on specs that merely *mentioned* release tooling; this instruction replaces it.)

When a human operator does release, use only:

```bash
pnpm release --yes
```

`scripts/release.mjs` is the source of truth. Do not substitute with manual `changeset version`, `pnpm publish`, or git tags.

### Package Structure

- `@fusion/core` — domain model/task store (private)
- `@fusion/dashboard` — web UI + API server (private)
- `@fusion/engine` — triage/executor/reviewer/merger/scheduler (private)
- `@runfusion/fusion` — CLI + pi extension (published)

Only `@runfusion/fusion` is published; `@fusion/*` packages are bundled into it.

Dashboard API routes use domain registrars under `packages/dashboard/src/routes/`; `createApiRoutes` is orchestrator-only and registrar mount order is a tested contract. See `packages/dashboard/src/routes/README.md`; `check:routes-modular` and mount-order tests enforce it.

#### Importing across `@fusion/*` packages

`@fusion/*` imports must be statically analyzable. Anti-pattern:

```ts
const engineModule = "@fusion/engine";
const engine = await import(/* @vite-ignore */ engineModule);
```

Rules:
1. Default to static imports.
2. `@fusion/core` uses DI (`setCreateFnAgent`) instead of dynamic `import("@fusion/engine")` due to circularity.
3. Never reintroduce the `engineModule = "@fusion/engine"` trick.
4. `vi.mock("@fusion/engine", ...)` remains valid.

### Testing commands

The merge gate is thin and trusted: CI blocks PRs on exactly Lint, Typecheck, Build, and Gate (boot smoke + `pnpm test:gate`). Everything else runs non-blocking in `full-suite.yml` on push to main. A red gate means a real problem; a red non-blocking run is information, not a merge stopper. Typechecks/manual checks are not substitutes for the gate.

```bash
pnpm test          # gate suite + changed-only affected tests (bounded; never full-suite)
pnpm test:gate     # the merge gate: curated engine-core suite + CI-shape test
pnpm smoke:boot    # boot smoke: CLI --help + real serve /api/health
pnpm verify:fast   # TEST-FREE verification: artifact bootstrap + scoped typecheck/build + CLI build + boot smoke; recommended non-test verification/testCommand. Additive — changes no default
pnpm test:velocity # weekly report-only test velocity baseline; use -- --measure --write-report to refresh
pnpm test:full     # full workspace suite — explicit opt-in only
pnpm lint
pnpm build
pnpm verify:workspace  # deep opt-in verification (lint -> test:full -> build); NOT the merge gate
```

`pnpm verify:fast` is the recommended **test-free verification** path: bootstrap missing/stale workspace dist artifacts, typecheck + build scoped to the changed packages (it reuses `pnpm test`'s changed-package resolution), an always-on `@runfusion/fusion` CLI build required by the source-checkout boot smoke, plus the boot smoke once, with **no test run**. It is deterministic and flake-free, suitable as a project `testCommand`/verification command when you want non-test verification; the full suite stays available and runs non-blocking. It is additive and does not change `pnpm test`, the gate, or CI. See `docs/testing.md`.

### Standing Rule: Flaky Tests Are Quarantined on Sight (Deletion Ratchet)

- A test observed failing without a corresponding real bug in the change is QUARANTINED ON SIGHT: add an entry to `scripts/lib/test-quarantine.json` (`file`, `reason` with a link to the failing run, `quarantinedAt`) AND a matching one-line `exclude` in that package's vitest config, in the same commit.
- **Agents must never appease a flaky test.** No widened timeouts, no added retries, no loosened or deleted assertions to make a flake pass. Quarantine it instead. Appeasement drains the test's signal and is how the suite rotted last time.
- A quarantined test is DELETED after 14 days (`quarantinedAt` + 2 weeks) unless rescued. Rescue requires evidence the test catches real regressions plus a root-cause fix — not stabilization passes.
- A flake INSIDE the merge gate is evicted, not skipped: remove its line from the `engine-core` allow-list in `packages/engine/vitest.config.ts` (the eviction PR does not need the flaky test to pass).
- A second quarantine in the same subsystem is a product-race smell — look at the product code before the deletion clock runs out (see `docs/solutions/ui-bugs/skill-autocomplete-highlight-reset-on-swr-revalidation.md`: a flake "stabilized" three times was a real race).
- Gate admission requires evidence of value; tests never graduate into the gate by default. Mechanics: `docs/testing.md` → "Quarantine ledger and the deletion ratchet".

### Standing Rule: Do Not Add Slow Tests (FN-5048)

- Prefer narrow seams, in-memory fakes, shared harnesses, and targeted assertions.
- Prefer fake timers over real polling/time waits.
- Do not mask slowness by raising worker/concurrency knobs.
- Do not add new real-network calls, real polling loops, or mock-the-world shells when a narrower seam exists.
- Use the testing taxonomy in `docs/testing.md` when deciding trim vs keep.

### Standing Rule: Scope Verification to Changed Files — Do Not Use `allowFullSuite`

- When verifying via `fn_run_verification`, **do not pass `allowFullSuite: true` unless absolutely necessary.** It is a last-resort escape hatch that runs a marathon command (root `pnpm test`, `pnpm test:full`, `verify:workspace`, whole-package tests, repeat loops) far in excess of what the change requires, and it is the main way verification balloons past its budget.
- Default to a **file-scoped** command targeting only the tests affected by the diff, e.g. `pnpm --filter @fusion/<pkg> exec vitest run src/path/to/changed.test.ts --silent=passed-only --reporter=dot`. The marathon soft-cap exists to push you toward this.
- `allowFullSuite: true` is justified only for a genuinely full run with no targetable test set (e.g. a cross-cutting infra change) — and then state the reason. The thin merge gate (`pnpm test:gate`) is the cross-cutting safety net, not per-task verification.

### Standing Rule: Reuse Components, Design Tokens, and Systems (No Drift)

- Before adding UI/CSS, reuse existing components and primitives; extend their `:hover`, `:focus-visible`, or `:active` states instead of forking parallel button, form, or card variants.
- Always use design tokens (`--space-*`, `--radius-*`, `--shadow-*`, `--duration-*`, `--transition-*`, `--font-*`, and color/status/semantic tokens); never hardcode pixels, hex, or `rgba()` in component CSS. Use `color-mix(...)` for translucency.
- Put new component CSS in `packages/dashboard/app/components/ComponentName.css`, not `styles.css`; the global file is only for tokens, primitives, and cross-component `@media` overrides.
- Reuse existing systems, helpers, and hooks after searching for an equivalent before adding a new one. If a new primitive is genuinely necessary, justify it in the change and first check documented patterns in `docs/solutions/`.
- Authoritative references: [Styling Guide — Design tokens and Component classes](docs/dashboard-guide.md#styling-guide), `packages/dashboard/app/styles.css` (token/primitive source of truth), and `docs/solutions/`.

### Standing Rule: Fix the Invariant, Not the Repro (FN-5893)

- When fixing a bug, the regression test must assert the general invariant across ALL known surfaces — not only the single reported reproduction.
- Symptom-based acceptance is mandatory for bug-class tasks: the final verification must reproduce the original failure condition and assert it no longer occurs via a real automated test. Encode this as a `## Symptom Verification` section in PROMPT.md with **Original symptom**, **Exact reproduction**, and **Assertion it is gone**; green build/tests alone are insufficient. This marker is the contract consumed by the GitHub auto-close gate (FN-6230).
- Surface enumeration is now an enforced bug-fix artifact: the spec must include a `## Surface Enumeration` section, planning must REVISE when that section is missing, and review must REVISE any repro-only regression test.
- The Surface Enumeration gate also applies to tasks that add or remove UI affordances (icons, buttons, chevrons, toggles, badges, menu entries, click targets), including Review Level 0 cosmetic tasks.
- Enumerate the surfaces before filing or closing the fix: every provider/bridge for streaming and agent paths, both desktop and mobile breakpoints for UI behavior, empty/undefined/duplicate/populated data states, and every shared hook/component/module/helper that reuses the affected logic.
- After removing a UI affordance, explicitly check for and clean up empty button shells, orphaned click targets, now-unused wrappers, and dangling aria-labels across both desktop and mobile breakpoints.
- Use the canonical checklist in `docs/testing.md` → **Surface Enumeration checklist** so planning and review enumerate the same surfaces.
- Motivating incidents: streamed-response spacing was fixed three times before the invariant was fully covered (FN-5787, FN-5789, FN-5803), the usage "Show hidden" button regressed three times before broader coverage stuck (FN-5797, FN-5875, FN-5919), and the auto-merge blank-dashboard fix re-opened after desktop-only coverage missed mobile Android (FN-5751).
- Motivating incident for UI affordances: the workflow-row drop-down arrow removal took three tasks (FN-6115 → FN-6118 → FN-6123) because the affordance rendered in two components and mobile kept an empty 36×36 `btn-icon` button shell.
- If a regression test only proves the exact reported case, it is incomplete; extend it until the invariant holds across all known surfaces.

### Port 4040 is Reserved

Never kill processes on port 4040 and never start test servers on 4040. Use `--port 0` or another free port.

### Never run an unbounded `find` against the system temp directory

Do not issue a recursive `find` (or any unbounded recursive directory walk) rooted at the OS temp directory — `$TMPDIR`, `/tmp`, or macOS `/var/folders/...` (canonical `/private/var/...`). The temp root can hold an enormous number of entries on CI and long-lived dev hosts, so a broad scan can hang for minutes and pin I/O.

When you need a Fusion temp artifact, target the known prefix directly and list a single level with a prefix filter — never walk the whole temp tree. The canonical bounded pattern is the engine's own sweep: non-recursive `readdirSync(...)` passes over the configured `<worktreesDir>/.ai-merge/` root plus legacy `.fusion/ai-merge/` and `tmpdir()` leftovers, filtered by a known prefix such as `fusion-ai-merge-` (`SelfHealingManager.cleanupStaleTempMergeWorktrees()` in `packages/engine/src/self-healing.ts`). Scoped `find` calls under a project worktree or `.fusion/` are fine; only the broad temp-root scan is forbidden.

### Engine Process Rules

#### Never use `execSync` for user-configured commands

Run user-configured commands (test/build/workflow scripts) via async `exec` with timeout. `execSync` is only acceptable for short deterministic git plumbing. `packages/engine/src/__tests__/engine-no-blocking-shellout.test.ts` enforces the engine-wide call-site allowlist for all synchronous shellout primitives.

#### Move-Task contract

User `moveTask(in-progress → todo)` is a hard cancel: abort active sessions/subprocesses and park task in `todo` with user-paused semantics. Engine rebounds must not set `userPaused`.

#### Process supervision

Use `superviseSpawn(...)` from `@fusion/core` for managed child processes; do not use raw detached `spawn`/`nohup` patterns unless explicitly allowlisted. `eslint.config.mjs` + `scripts/check-no-nohup.mjs` enforce this.

### Git Conventions

- Commit prefixes: `feat(FN-XXX):`, `fix(FN-XXX):`, `test(FN-XXX):`
- One commit per step boundary
- Include task ID prefix
- Fusion task-worktree commits should carry `Fusion-Task-Id: FN-NNNN` trailers
- **Branch work uses worktrees:** when a change needs a feature branch, create a worktree (`wt switch --create <branch>` or `git worktree add -b …`) and work there — do not switch the primary checkout off `main`. Direct commits on `main` are fine when the change belongs on main. See **Standing Rule: Prefer `main` For Direct Work; Use Worktrees For Branches**.

### Merging Branches Into Main

1. **Drop duplicate commits before merging.** Rebase away duplicates already on main.
2. **Squash is now the project default; history-preserving merge paths require opt-in.** New projects default `directMergeCommitStrategy="always-squash"`. To preserve multi-commit history, explicitly set project `directMergeCommitStrategy` to `"auto"` or `"always-rebase"`, or set a per-task `**Direct Merge Commit Strategy:** ...` override in `PROMPT.md`.
3. **Empty cherry-picks are no-ops.** Do not create empty commits.
4. **Already-on-main classifier applies.** Allow finalize/self-healing recovery when lineage is landed.
5. **Contamination auto-recovery is bounded.** First pass can auto-drop upstream foreign commits; repeated/ambiguous cases escalate.
6. **Run post-squash audit policy.** Respect `postMergeAuditMode` (`warn`/`block`/`off`) and auto-recovery stages.
7. **Enforce pre-commit diff-volume gate.** Block suspicious shrinkage before squash commit.
8. **Smart-prefer-main overlap guard.** Recent overlapping main commits can flip to prefer-branch.
9. **Layer-3 scope partition.** Out-of-scope conflicts resolve to main before AI arbitration unless `task.scopeOverride=true`.
10. **Auto-prerebase on divergence/hot files.** Fail-soft and continue normal conflict stack.

### Gitignored-path guard on squash merges

Never force-add ignored artifacts (for example `git add -f .fusion/...`). Use task documents for findings/notes.

### File-Scope invariant on squash merges

Every squash commit must overlap task `## File Scope` (unless scope is empty). Violations must fail with `FileScopeViolationError` and reset pre-squash state.

Per-task opt-out exists: `task.scopeOverride = true` (log the reason).

### `autoMerge: false` callout (FN-5147)

When `settings.autoMerge: false`, `in-review` is terminal-until-merged by a human. Lifecycle-mutating self-healing must not move these tasks backward, pause/fail them, or re-enqueue them for execution.

Scoped exception (FN-5819): shared-branch-group members (`branchContext.assignmentMode === "shared"`) still run the member→shared-branch local integration step while auto-merge is off. This exception is only for assembling `branch_groups.branchName`; shared-branch → default-branch promotion remains gated by group/global auto-merge.

### Mock provider (test mode)

`testMode?: boolean` is now available in both project and global settings. If project `testMode === true` (or the resolved default provider is `"mock"` at any tier), every AI lane is forced to `mock/scripted`, overriding per-task and per-lane model selections. The dashboard exposes this via the Settings Modal "Enable test mode" toggle and a persistent "Test mode — no real AI calls" banner.

### Run Audit

- Store-open provenance: every `TaskStore.init()` emits `store:open` with ids/paths-only metadata (`pid`, `ppid`, `execPath`, `entry`, `cwd`, `nodeVersion`). Purpose: attribute shared-DB mutations to the process that opened the store (the FN-7910 Ideas-evacuation writer was unidentifiable without it). Tests reading unfiltered `runAuditEvents` must filter out `store:open` rather than assert exact counts.
- FN-7158: agent performance reflections emit `reflection:generated`, `reflection:skipped`, and `reflection:failed` with ids/counts/outcomes-only metadata; never persist reflection prose or prompt text in run-audit.
- FN-7528: a deterministic, non-LLM post-task performance capture (`AgentReflectionService.captureTaskPerformance`) runs once per completed task and emits `reflection:captured` with ids/counts/outcomes-only metadata (`retryReworkCount?`, `filesTouchedCount?`, `packagesTouchedCount?`, `verificationFileScoped?`, `durationMs?`); never persists `verificationScopeReason` free-text or summary prose in run-audit.
- FN-7787: `createResolvedAgentSession` enriches `session:runtime-resolved` with `noModelResolved: true` and `runtimeBuiltInFallbackModel` when a non-mock/non-test session reaches runtime creation without a complete provider/model pair; this is a visibility signal for runtime built-in fallback usage, not a fabricated model-resolution verdict.
- FN-7835/FN-7844/FN-7859/FN-7878: durable-agent error-state recovery emits `agent:auto-recover-error-state` when either the heartbeat timer or the self-healing sweep clears a recoverable, non-operator-actionable `error` and retries; metadata stays ids/counts/outcomes-only (`agentId`, attempt, limit, source), where `source` is `timer`/`automation`/`self-healing`. Generic/unknown heartbeat failures are recoverable by default because manual Retry often proves they were transient; both entry paths share the `heartbeatErrorRecovery` budget (self-healing keeps `durableErrorRecovery` only for cooldown/stale-path bookkeeping) and emit `agent:error-retry-exhausted` when the shared budget is exhausted and the agent is parked `paused` with `pauseReason:"error-retry-exhausted"`. Only operator-actionable durable heartbeat errors (credentials/OAuth scope, model access, billing/quota, excluding transient auth rotation), plus stale worktree/module-resolution errors handled by their dedicated suppression path, skip the retry budget and emit `agent:error-parked-unrecoverable` with ids/counts/outcomes-only metadata (`agentId`, `source`, optional `attempts`, `limit`) before parking `paused` with `pauseReason:"error-unrecoverable"` for human repair.
- FN-7884: self-healing startup recovery emits `agent:reset-error-state-on-startup` when an engine restart clears an eligible durable-agent `error` or `pauseReason:"error-retry-exhausted"` park, resets shared `heartbeatErrorRecovery` plus legacy `durableErrorRecovery` budget/cooldown metadata, clears `lastError`/exhaustion pause state, and re-arms the heartbeat. Metadata stays ids/counts/outcomes-only (`agentId`, `priorState`, optional `priorPauseReason`, `source`). This startup-only path bypasses steady-state staleness/cooldown/exhaustion gates while preserving operator-actionable, stale-module, user-paused, `error-unrecoverable`, ephemeral, disabled-runtime, and active-execution suppression.
- FN-7802: self-healing emits `task:reconcile-missing-worktree-merge-active` when it proves an `in-review` merge-active task (`merging`/`merging-pr`/`merging-fix`) is stranded by an unusable-worktree session-start failure, clears stale `worktree`/`branch`/`sessionFile`, resets the worktree-session retry budget, increments `recoveryRetryCount` as the bounded stale-metadata clear counter, and requeues to `todo`; it emits `task:reconcile-missing-worktree-merge-active-no-action` when `autoMerge:false`, workspace-task ownership, or triple-proof blocks the backward move.
- FN-7863: executor emits `task:execution-dispatch-loop-terminalized` when an execute-node self-requeue loop reaches `MAX_EXECUTE_REQUEUE_LOOP_CYCLES` with an unchanged progress signature; metadata stays ids/counts/outcomes-only (`taskId`, `cycleCount`, `maxCycles`, `progressSignature`, `failureValue`) and the task is visibly failed with `EXECUTION_DISPATCH_LOOP_EXHAUSTED:` while preserving worktree/branch/step progress.
- FN-7926: executor emits `task:completed-blocked-parked` when completed implementation work is held by a live `getTaskCompletionBlocker()` reason instead of re-entering the execute self-requeue loop; self-healing emits `task:completed-blocked-advanced` when the blocker clears and the parked work advances to review. Metadata stays ids/outcomes-only (`taskId`, blocker/source/prior column/status).
- FN-7011/FN-7975: self-healing emits `task:reconcile-engine-downtime-active-timing` when startup recovery or a full Global/Engine unpause shifts active task segment anchors to exclude proven stopped-engine wall-clock, and `task:reconcile-engine-downtime-active-timing-no-action` when no active task qualifies.
- FN-5419: git run-audit now includes `pull:fast-forward` and `stash:pop-conflict`; dashboard git surfaces now include the extended `POST /api/git/pull` integration-worktree path plus companion `POST /api/git/stash-resolve`, `POST /api/git/stash-drop`, and `POST /api/git/stash-apply` routes.
- FN-6292: self-healing emits `task:reconcile-dependency-blocking-lease` when it rebounds an in-progress holder whose stale file-scope lease blocks an unmet dependency, and `task:reconcile-dependency-blocking-lease-no-action` when triple-proof blocks that backward move.
- FN-6736: self-healing emits `task:reclaim-phantom-executor-binding` when it proves an in-memory executor-active binding is stale, clears the binding, and requeues the in-progress task with worktree/progress preserved.
- FN-6783: task-store open and self-healing housekeeping emit `task:reconcile-orphaned-task-dir` when they non-destructively re-import a valid live `.fusion/tasks/{ID}/task.json` directory that has no task row anywhere, preserving soft-deleted/archived/tombstoned IDs.
- FN-7069: task-store open and self-healing housekeeping emit `task:reconcile-phantom-committed-reservation` when they prune orphaned child rows for a committed task-ID reservation that has no live/soft-deleted/archived task row and no task directory, while preserving the committed reservation so the ID is never reused.
- FN-7074: task creation emits `task:reservation-commit-rolled-back` when a distributed reservation was committed atomically with a `tasks` row but a later create materialization step failed; metadata includes `reservationId`, `nodeId`, `reason: "failed-create"`, and `error`, and the reservation is moved to aborted so the sequence remains burned.
- FN-6782/FN-6796: self-healing emits `task:auto-recover-paused-abort-park` when it clears a benign pause-abort operator park, requeueing safe `todo`/`in-progress` rows or preserving a clean auto-merge-eligible `in-review` row for review progression.
- FN-6793/FN-6797: self-healing emits `task:reconcile-in-review-unmet-dependencies` when it rebounds an `in-review` task whose declared dependencies are still unmet, and `task:reconcile-in-review-unmet-dependencies-no-action` when pause/user-pause, `autoMerge:false`, live execution/checkout proof, or a failed rebound mutation blocks that backward move.
- Workspace (Phase D U1): self-healing emits `task:reconcile-workspace-partial-land` when it re-enqueues a partial/zero-landed workspace task's per-repo land (or parks it `failed` when a sub-repo's `fusion/<id>` branch is gone with no `landedSha`), and `task:reconcile-workspace-partial-land-no-action` when `autoMerge:false`, user-pause, or a live sub-repo worktree (workspace-aware liveness) blocks that backward move.
- Workspace (Phase D U1): self-healing emits `task:reclaim-phantom-workspace-land-lease` when it clears a leaked `workspace-repo-land` lease whose owning task is terminal/dead and older than the FN-6736 staleness floor (a live merging owner is left untouched).
- Workspace (Phase D U1): self-healing emits `task:reconcile-orphaned-workspace-worktree` when it removes a done/dead workspace task's recorded per-repo worktree from its stored `worktreePath` (guarded by `isPathActive`; no temp-root walk).
- FN-8144: archive emits `archive-workspace-worktree-disposer-missing` when a workspace archive has no store-scoped backend disposer; per-repository archive removal is awaited under canonical-path reservations, with failed paths quarantined for successor reconciliation.
- FN-7514: the planner overseer's per-task oversight loop (`PlannerRecoveryController.tick`) emits `overseer:oversight-withheld-human-control` when the pure `evaluateOverseerHumanControl` guard withholds ALL oversight action (no steering, retry, targeted-fix, or pending confirmation) for a task that is user-paused (`task.userPaused===true`, or `task.paused===true` with no `pausedReason`) or ineligible for auto-merge processing per `allowsAutoMergeProcessing` (`autoMerge:false`/PR-based human-review terminal contract). The guard runs BEFORE FN-7513's confirmation classification, so a withheld task never records a pending confirmation. Metadata: `{ taskId, reason: "user-paused" | "auto-merge-off-human-review", stage, oversightLevel }`; deduped per (taskId, withheld reason) so it is not re-emitted every poll while the reason is unchanged.
- FN-7720: `TaskStore.bypassFailedPreMergeReviewStep` emits `task:bypass-review` when a privileged operator bypasses the latest failed pre-merge review step of an `in-review` task; metadata includes `workflowStepId`, `workflowStepName`, `bypassedFromStatus`, `bypassedFromVerdict`, and the mandatory `reason`. The bypass rewrites the step's `status` to `"skipped"` with `bypassedBy`/`bypassedAt`/`bypassReason`/`bypassedFromStatus` fields; it never fabricates a reviewer `verdict` and clears only the failed-pre-merge-step `getTaskMergeBlocker` reason. Reachable via `fn_task_bypass_review` (CLI/pi-extension operator tool surface only — not executor/reviewer/triage) and `POST /tasks/:id/bypass-review`.
- FN-7996: executor emits `task:execution-tool-failure-retry` for a claimed same-model consecutive-tool-failure retry and `task:execution-tool-failure-retry-exhausted` when the matching run budget is spent. Metadata is ids/counts/outcomes-only; the exhausted event is emitted once through a project-scoped compare-and-set while terminal parking remains idempotent.
- FN-7998: executor emits `task:execution-escalation-retry` when its opt-in, single alternate model/node attempt is persisted after FN-7996 exhaustion, and `task:execution-escalation-exhausted` when that attempt also reaches the terminal park. Metadata remains ids/counts/outcomes-only (`taskId`, graph node id, target booleans, and prior retry count); no model identifiers or prose are persisted in run-audit.
- FN-8004: `agent:heartbeat-move-skipped-soft-delete` records a heartbeat move that races a soft-deleted task without parking the durable agent. Metadata remains ids/timestamps/source only (`agentId`, optional `taskId`/`deletedAt`, `moveAttemptedAt`, optional `source`); it never stores error prose.
- FN-8141: the executor's `fn_task_done(outcome="blocked", reason=..., blockedBy?=[...])` honest-blocked exit emits `task:execution-blocked-parked` when an executor parks a genuinely-impossible task `failed` (`error = "BLOCKED: <reason>"`) instead of laundering it to `done` by skipping steps. It bypasses the completion/verdict/bulk-completion gates (blocked is not a completion claim), leaves steps in their true statuses, preserves worktree/branch, records `blockedBy` as real `task.dependencies` edges so the task requeues behind the blocker, and does NOT hand off to review — the parked row is honored by the executor's `status === "failed"` post-loop branch and is not auto-recovered into in-review by `recoverStrandedCompletedTodoTasks` (steps are not all done/skipped and `task.error` is set). Metadata stays ids/outcomes-only (`taskId`, `blockedBy` ids, `hasReason` boolean — never the reason prose).
- FN-8305: durable symbol-lock operations emit `symbol-lock:acquired`, `symbol-lock:acquire-conflict`, `symbol-lock:renewed`, `symbol-lock:released`, `symbol-lock:reconcile-stale`, and deduplicated `symbol-lock:reconcile-stale-no-action`. Metadata is ids/counts/outcomes-only; normalized opaque symbol keys are permitted IDs, while raw symbol prose is not.
- FN-8492: the self-healing sweep `reconcile-orphaned-pending-step-results` (startup, right after legacy adoption, plus periodic maintenance) emits `task:reconcile-orphaned-pending-step-results` when it REWRITES `pending` workflow-step results with no live session behind them to `failed` (canonical liveness triple: `activeSessionRegistry` path, `executingTaskLock`, `isTaskActive`). It must never DELETE an orphaned entry — the merge gate blocks on pending/failed results, not on an enabled step with no result, so deletion silently satisfies the gate and the task merges with its review skipped; the `failed` rewrite keeps the gate closed and hands re-run/bypass to the failed-pre-merge-steps recovery and FN-7720 operator-bypass paths. `in-progress` rows are always skipped (executor-owned; resume is deferred at startup), the row is re-read immediately before the write, and user pauses are never disturbed. Metadata is ids/counts-only (`taskId`, `column`, `orphanedCount`, `resultCount`).
- FN-8356: self-healing emits `task:reconcile-stale-duplicate-decision` when it clears a triage-marker duplicate-decision pause against a missing, deleted, done, or archived canonical. Metadata is ids/outcomes-only (`taskId`, `canonicalId`, `canonicalColumn`, `canonicalDeleted`, `priorPausedReason`); active canonical decisions and user pauses remain untouched.
- U9b (R10/KTD-8): the self-healing STARTUP recovery step `adopt-legacy-task-rows` emits `task:reconcile-legacy-adoption` when it adopts a pre-cutover row through the KTD-8 adoption table (clearing a legacy `task.status` whose writer the cutover deleted so the graph re-enters at its owning node, and/or landing the one-time `reviewLevel` -> `enabledWorkflowSteps` preset backfill), and `task:reconcile-legacy-adoption-unmappable` when an UNKNOWN status parks the row `paused` for a human with its status deliberately left in place. Metadata is ids/counts/outcomes-only (`taskId`, `action`, `priorStatus`, `column`, `backfilledStepCount`, `reason`), where `reason` is a fixed adoption-table note and never row prose. Adoption runs FIRST in startup recovery (every later step reasons about `task.status`), stamps `task.legacyAdoptedAt` only on rows it actually mutates (so upgrade does not mass-write every `done` row), and never touches a user pause or a `preserve` gate. `planLegacyAdoption` in `packages/core/src/legacy-adoption.ts` is the single shared decision used by both this sweep and the store-open reconcile so the two cannot drift.
- U10 (R9): the pre-graph cutover machinery is DELETED and stays deleted, ratcheted by `packages/engine/src/__tests__/legacy-tombstones.test.ts`. Gone: `workflow-cutover.ts`, `workflow-authoritative-driver.ts`, `workflow-parity-observer.ts`, the `graphCompletionInterceptors` re-entry map, triage's out-of-graph `runPlanReviewBeforeExecution` gate, and the in-session `fn_review_step` tool with its RETHINK git-reset/session-rewind, per-step conversation checkpoints, deferred reviewer provider-error channel, and review-level prompt scaffolding. Plan/code/browser review are owned EXCLUSIVELY by workflow-graph nodes — do not re-introduce a second review authority inside the implementation session; that duplicate-Plan-Review race is what the cutover removed. The tombstone test strips comments before searching, so the FNXC notes that explain each deletion are expected to remain in source while the code must not.
- U10b (R9): `maybeExecuteWorkflowGraph`'s legacy fallback is DELETED. A TaskStore without `getTaskWorkflowSelection`/`getTaskWorkflowSelectionAsync` no longer falls back to a legacy execute path — graph ownership is unconditional, `graphCompletion` is mandatory rather than optional, and the three completion boundaries that used to branch on its absence are plain returns. `transferPreHeldToLegacy` and the pre-held-slot hand-off to the legacy path are gone with it. Consequence for tests: nothing can reach the pre-graph shape by deleting the selection readers from a mock store; a test that needs "this store cannot resolve a workflow" must assert the fail-closed park, not a fallback.
- U10b: **`task.status === "needs-replan"` is NOT un-migrated legacy.** Post-U3 it is written solely by the graph's own `plan-replan` seam (the `plan-review --failure--> plan-replan` edge -> `requestPreMergeOptionalStepFix` -> `executor.ts` replan write) plus the stale-spec guards that feed the same loop; it is consumed by triage (todo rediscovery + the surgical-revision seed), `hold-release` (blocks re-dispatch of a just-rejected plan), and `task-merge` (auto-merge block). That is the graph's durable replan signal wearing a legacy name. `packages/core/src/__tests__/legacy-adoption.test.ts`'s census guard intentionally requires the literal to still be written in `executor.ts` — it is guarding the GRAPH's writer, so do not "clean it up". Migrating those readers to a purpose-built run-state signal is a deferred post-cutover follow-up (naming/purity), not cutover work.



## Reference docs (deeper detail)

- `./docs/architecture.md` — lifecycle invariants, self-healing rules, reliability interaction backstops, run-audit internals.
- `./docs/testing.md` — full testing lanes, worker fanout guidance, test taxonomy, weekly velocity baseline, and file organization.
- `./docs/test-velocity-baseline.md` — weekly #leads-ready test feedback-loop velocity report generated by `scripts/test-velocity-baseline.mjs`.
- `./docs/dashboard-guide.md` — dashboard behavior and **Styling Guide** details. User-facing docs for Merge Advance Notice and Smart Pull live here.
- `./docs/PLUGIN_AUTHORING.md` — plugin authoring guide, lifecycle hooks, routes, tools, and dashboard-extension surfaces.
- `./docs/agents.md` — pi extension scope, coordination tools, checkout leasing, runtime config.
- `./docs/settings-reference.md` — model-selection hierarchy, mock provider mode, token budget precedence, presets.
- `./docs/signals-connectors.md` — setup, HMAC auth, payload mapping, and security notes for Command Center external signal connectors.
- `./docs/storage.md` — hybrid storage model details, including per-task `agent-log.jsonl` storage and retention semantics.
- `./docs/multi-project.md` — central/per-project DB and isolation modes.
- `./docs/missions.md` — mission/milestone/slice/feature model.
- `./docs/workflow-steps.md` — prompt/script gates and merge-blocking behavior.
- `./docs/secrets.md` — secrets policy and tooling behavior.
- `./docs/diagnostics.md` — engine diagnostic logging conventions.
- `./docs/task-management.md` — archive cleanup and restore semantics.
- `./docs/soft-delete-verification-matrix.md` — mandatory soft-delete verification matrix.
- `./docs/cli-reference.md` — CLI and terminal UI reference.
- `./docs/contributing.md` — contributing conventions and release-adjacent context.
- `./docs/solutions/` — documented solutions to past problems (bugs, architecture patterns, best practices, conventions), organized by category with YAML frontmatter (`category`, `module`, `tags`, `problem_type`, `applies_when`). Relevant when implementing or debugging in documented areas.
- `./CONCEPTS.md` — shared domain vocabulary (entities, named processes, status concepts). Relevant when orienting to the codebase or discussing domain concepts.

### Lazy-Loaded Heavy Views

These 20 views are lazy-loaded via `React.lazy()` with `<Suspense fallback={null}>`.
Keep this AGENTS inventory in sync with App lazy imports, AppModals lazy modal imports (`SettingsModal`, `WorkflowNodeEditor`, `SetupWizardModal`), plugin settings lazy imports (`PluginManager`, `PiExtensionsManager`), AgentsView lazy imports (`AgentDetailView`), and `packages/dashboard/app/__tests__/lazy-loaded-views-docs.test.ts`.

- `AgentsView`
- `ChatView`
- `MemoryView`
- `DevServerView`
- `SecretsView`
- `InsightsView`
- `DocumentsView`
- `SkillsView`
- `ResearchView`
- `CommandCenter`
- `EvalsView`
- `TodoView`
- `GoalsView`
- `PullRequestView`
- `SetupWizardModal`
- `SettingsModal`
- `WorkflowNodeEditor`
- `PluginManager`
- `PiExtensionsManager`
- `AgentDetailView`

Note: the embedded main-content views Workflows (`_WorkflowEditorView`), Import Tasks (`_ImportTasksView`), Automations (`_AutomationsView`), and Settings (`_SettingsView`) in App.tsx are `_`-prefixed lazy splits that reuse already-documented chunks. Task session terminals, the Task Detail embedded terminal, onboarding-internal modals, duplicate `AgentDetailView` imports, and right-dock overflow re-imports of already-counted views are also intentionally excluded. These exclusions stay out of the curated list and count; `lazy-loaded-views-docs.test.ts` asserts them explicitly, so do not add them as bullets.

## FNXC_LOG comments:
   - Please whenever you're working on a codebase. I want you to add comments describing the date of the change (must be in this format yyyy-MM-dd-hh:mm) and describing the requirements or the change in requirements that made you implement certain functionality.
   - I want you to write FNXC:Area-of-product in front of all your comments so they can be grepped.
   - Most of this should be written as jsdocs but you can add short comments around for the important variables and more complex parts of the codebase.
   - The idea is to encode the requiements of the system (especially software behavior, UX, and important technical decisions) into the code so it's clearer later why a certain piece of code was written.
   - Always make sure to keep these comments updated as you work in the codebase and requirements change.
   - Use technical writing principles to write non-verbose comments that convey the important info without fluff.
   - Keep in mind that ALL of the important user facing requirements sent by the user must be written as comments somewhere in the codebase.
   - There's no need to add line breaks in FNXC comments to stay under a certain character width. Just add line breaks normally at the ened of sentences.

   Good Example for a FNXC Comment:
   ```
   /*
   FNXC:SettingsNavigation 2026-05-13-08:05:
   The Settings dialog needs enough horizontal room for a main-tab section sidebar while Ghostty settings live in their own second tab.
   Use scoped CSS so the native modal host and Storybook share the same width without relying on newly generated utilities.

   FNXC:SettingsNavigation 2026-05-13-08:11:
   The modal should be 20% wider than the first section-sidebar layout and use a taller viewport so more settings remain visible without scrolling.
   */
   ```