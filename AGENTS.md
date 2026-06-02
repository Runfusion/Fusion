# Project Guidelines

## Essential rules

### STANDING DIRECTIVE: Buttons Are Frozen (2026-05-13)

Do not file, plan, or implement tasks that adjust button mobile-responsiveness, touch-target sizing, or mobile reflow of header/action button rows anywhere in the dashboard (TaskCard, SettingsModal, ChatView, MissionManager, AgentsView, FAB, etc.). **Keep buttons as they are.**

This supersedes earlier guidance about mobile touch targets, primary/secondary control sizing on mobile, and `.touch-target` minimums for buttons. The `Frontend UX Design` workflow step (WS-006) is disabled and must stay disabled.

If you find yourself opening `SettingsModal.css`, `TaskCard.css`, `ChatView.css`, etc. inside an `@media (max-width: 768px)` block to touch a `.btn`, `.modal-close`, `.settings-header-actions`, or `.card-*` button — stop. Confirm with the user in chat before proceeding.

Exception: explicit named user request in chat that overrides this directive.

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

### Finalizing Changes

When a change affects published `@runfusion/fusion`, add a changeset (example: `.changeset/<name>.md` with `"@runfusion/fusion": patch`).

Bump types:
- **patch** — bug fixes/internal
- **minor** — new features/CLI/tools
- **major** — breaking changes

Do **NOT** create changesets for AGENTS.md/README/internal docs, CI config, or behavior-preserving refactors. `@fusion/core`, `@fusion/dashboard`, and `@fusion/engine` are private.

### Releasing

Use only:

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

Tests are required. Typechecks/manual checks are not substitutes.

```bash
pnpm test
pnpm test:full
pnpm lint
pnpm build
pnpm verify:workspace
```

### Standing Rule: Do Not Add Slow Tests (FN-5048)

- Prefer narrow seams, in-memory fakes, shared harnesses, and targeted assertions.
- Prefer fake timers over real polling/time waits.
- Do not mask slowness by raising worker/concurrency knobs.
- Do not add new real-network calls, real polling loops, or mock-the-world shells when a narrower seam exists.
- Use the testing taxonomy in `docs/testing.md` when deciding trim vs keep.

### Port 4040 is Reserved

Never kill processes on port 4040 and never start test servers on 4040. Use `--port 0` or another free port.

### Engine Process Rules

#### Never use `execSync` for user-configured commands

Run user-configured commands (test/build/workflow scripts) via async `exec` with timeout. `execSync` is only acceptable for short deterministic git plumbing.

#### Move-Task contract

User `moveTask(in-progress → todo)` is a hard cancel: abort active sessions/subprocesses and park task in `todo` with user-paused semantics. Engine rebounds must not set `userPaused`.

#### Process supervision

Use `superviseSpawn(...)` from `@fusion/core` for managed child processes; do not use raw detached `spawn`/`nohup` patterns unless explicitly allowlisted. `eslint.config.mjs` + `scripts/check-no-nohup.mjs` enforce this.

### Git Conventions

- Commit prefixes: `feat(FN-XXX):`, `fix(FN-XXX):`, `test(FN-XXX):`
- One commit per step boundary
- Include task ID prefix
- Fusion task-worktree commits should carry `Fusion-Task-Id: FN-NNNN` trailers

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

- FN-5419: git run-audit now includes `pull:fast-forward` and `stash:pop-conflict`; dashboard git surfaces now include the extended `POST /api/git/pull` integration-worktree path plus companion `POST /api/git/stash-resolve`, `POST /api/git/stash-drop`, and `POST /api/git/stash-apply` routes.

### Reliability Mechanism Coverage

- FN-5432 backstop: `packages/engine/src/__tests__/reliability-interactions/dependency-cycle-reconcile.test.ts` extends FN-5256 coverage with long-cycle ambiguous sweep, write-boundary/sweep race, self-defeating+cycle non-contradiction across one maintenance flow, and audit-event shape regression; core regression cases (long cycle, self-loop via update, incremental-update closes a loop, moveTask seam invariant, DependencyCycleError shape) live in `packages/core/src/__tests__/store-dependency-cycle.test.ts`. User-facing pull/stash audit event behavior (`pull:fast-forward`, `stash:pop-conflict`) is documented in `docs/dashboard-guide.md` under Merge Advance Notice / Smart Pull.
- FN-5403 backstop: `packages/engine/src/__tests__/reliability-interactions/engine-stop-aborts-execution.test.ts` locks stop-ordering behavior so engine shutdown aborts executor AI sessions before drain wait and preserves task-row lifecycle semantics.
- FN-5704 backstop: `packages/engine/src/__tests__/reliability-interactions/reclaim-self-owned-resume-limbo-escalation.test.ts` guards reclaim/unpause no-progress oscillation recovery by capping repeated no-progress resumes, escalating to preserve-work `todo` rebound, and emitting `task:resume-limbo-escalated` audit metadata while exempting progress/user-paused/autoMerge-off cases.
- FN-5715 backstop: `packages/engine/src/__tests__/reliability-interactions/mission-validation-trigger-gap.test.ts` guards mission validation trigger continuity so done task completion and startup recovery both route assertion-linked features through validator runs before completion.
- FN-5738 backstop: `packages/engine/src/__tests__/reliability-interactions/mission-validation-trigger-gap.test.ts` extends mission-loop coverage so zero-assertion auto-pass deterministically advances to `loopState="passed"` and emits `validation_auto_passed_no_assertions` without duplicate recovery re-fire.
- FN-5741 backstop: `packages/engine/src/__tests__/reliability-interactions/merge-request-shadow-handoff.test.ts` guards Phase-1 write-only-shadow merge-request record + handoff-accepted marker seam (flag OFF = no-op, ON = shadow-only non-authoritative).
- FN-5742 backstop: `packages/engine/src/__tests__/reliability-interactions/dual-observe-merge-seam.test.ts` guards Phase-2 dual-observe parity (dependency + lease diffs, shadow dequeue parity, manual-required shadow skip) while legacy behavior remains authoritative.
- FN-5743 backstop: `packages/engine/src/__tests__/reliability-interactions/merge-request-cancel-on-hard-cancel.test.ts` plus `packages/core/src/__tests__/merge-request-record.test.ts` guard Phase-3 cutover semantics (merge-request retry state transitions, authoritative user hard-cancel tombstone, and non-user rebound no-op cancel semantics).
- FN-5754 backstop: `packages/engine/src/__tests__/reliability-interactions/mission-stranded-feature-retriage.test.ts` guards startup/maintenance stranded-feature re-triage for active autopilot slices, including link-first dedupe, non-defined skip safety, non-autopilot no-op, idempotency, and `mission:stranded-feature-triaged` audit shape.
- FN-5755 backstop: `packages/engine/src/__tests__/reliability-interactions/mission-validation-trigger-gap.test.ts` extends mission validation coverage so bounded periodic maintenance replays `recoverActiveMissions` for stranded `implementing` features and remains idempotent on repeated passes.
- FN-5783 backstop: `packages/engine/src/__tests__/reliability-interactions/branch-group-automerge-precedence.test.ts` guards grouped merge precedence so per-task `autoMerge` remains member→integration only, group `autoMerge` gates promotion eligibility, and promotion-gate audit events capture pause/automerge override reasons.
- FN-5788 backstop: `packages/engine/src/__tests__/reliability-interactions/branch-group-promotion-gate.test.ts` guards merger-side promotion-gate telemetry on shared member landings, including pause/settings/group autoMerge reason mapping and no default-branch auto-promotion side effects.
- FN-5830 backstop: `packages/engine/src/__tests__/reliability-interactions/branch-group-promotion.test.ts` guards branch-group completion-gate + promotion lifecycle so completion detection drives exactly one shared→default promotion, re-calls stay idempotent, and gated paths emit promotion-gated telemetry without promoting.
- FN-5820 backstop: `packages/engine/src/__tests__/reliability-interactions/shared-branch-group-lifecycle.test.ts` guards the full shared-branch-group lifecycle—concurrent distinct-worktree execution, member→shared-branch accumulation, single shared→main completion-gate promotion with idempotent re-evaluation, gate-disabled integration-without-promotion, and per-task-derived/ungrouped no-regression.
- FN-5866 backstop: `packages/engine/src/__tests__/reliability-interactions/post-done-continuation-no-wedge.test.ts` guards the post-done non-continuable-session seam so completed executor work stays cleanly in `in-review` while incomplete tasks still fail normally.
- FN-5888 backstop: `packages/engine/src/__tests__/reliability-interactions/post-done-continuation-no-wedge.test.ts` also covers the incomplete-task non-continuable-session fresh-session retry path, ensuring within-budget failures clear `sessionFile` and requeue to `todo` with preserved resume state while exhausted budgets still fall through to terminal failure.
- FN-5889 backstop: `packages/engine/src/__tests__/reliability-interactions/post-done-continuation-no-wedge.test.ts` extends the seam to the step-session post-done continuation path and the `recoverPostDoneNonContinuableWedge` self-heal, so completed work never wedges to `in-review` + `status="failed"` and already-wedged rows are cleared before stall surfacing.
- FN-5874 backstop: `packages/engine/src/__tests__/reliability-interactions/ai-merge-ff-landed-files.test.ts` guards AI-merge fast-forward finalizer persistence of `mergeDetails.commitSha`, `landedFiles`, and `modifiedFiles`, verifies no-op landings do not fabricate metadata, and confirms normal squash landings do not set FN-5103 attribution-restriction flags; companion coverage in `packages/engine/src/__tests__/self-healing.test.ts` extends `recoverDoneTaskMergeMetadata` so done tasks with empty `mergeDetails` but a recorded `baseCommitSha` are backfilled via owned-commit discovery while FN-5103 skip guards still prevent overwrite.

---

## Reference docs (deeper detail)

- `./docs/architecture.md` — lifecycle invariants, self-healing rules, reliability interaction backstops, run-audit internals.
- `./docs/testing.md` — full testing lanes, worker fanout guidance, test taxonomy, and file organization.
- `./docs/dashboard-guide.md` — dashboard behavior and **Styling Guide** details. User-facing docs for Merge Advance Notice and Smart Pull live here.
- `./docs/agents.md` — pi extension scope, coordination tools, checkout leasing, runtime config.
- `./docs/settings-reference.md` — model-selection hierarchy, mock provider mode, token budget precedence, presets.
- `./docs/storage.md` — hybrid storage model details.
- `./docs/multi-project.md` — central/per-project DB and isolation modes.
- `./docs/missions.md` — mission/milestone/slice/feature model.
- `./docs/workflow-steps.md` — prompt/script gates and merge-blocking behavior.
- `./docs/secrets.md` — secrets policy and tooling behavior.
- `./docs/diagnostics.md` — engine diagnostic logging conventions.
- `./docs/task-management.md` — archive cleanup and restore semantics.
- `./docs/soft-delete-verification-matrix.md` — mandatory soft-delete verification matrix.
- `./docs/cli-reference.md` — CLI and terminal UI reference.
- `./docs/contributing.md` — contributing conventions and release-adjacent context.

### Lazy-Loaded Heavy Views

These 19 views are lazy-loaded via `React.lazy()` with `<Suspense fallback={null}>`.
Keep this AGENTS inventory in sync with App lazy imports and `packages/dashboard/app/__tests__/lazy-loaded-views-docs.test.ts`.

- `AgentsView`
- `NodesView`
- `ChatView`
- `MemoryView`
- `DevServerView`
- `SecretsView`
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
