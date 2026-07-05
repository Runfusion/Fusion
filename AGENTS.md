# Project Guidelines

## Essential rules

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

- FN-7158: agent performance reflections emit `reflection:generated`, `reflection:skipped`, and `reflection:failed` with ids/counts/outcomes-only metadata; never persist reflection prose or prompt text in run-audit.
- FN-7528: a deterministic, non-LLM post-task performance capture (`AgentReflectionService.captureTaskPerformance`) runs once per completed task and emits `reflection:captured` with ids/counts/outcomes-only metadata (`retryReworkCount?`, `filesTouchedCount?`, `packagesTouchedCount?`, `verificationFileScoped?`, `durationMs?`); never persists `verificationScopeReason` free-text or summary prose in run-audit.
- FN-7011: self-healing emits `task:reconcile-engine-downtime-active-timing` when startup recovery shifts active task segment anchors to exclude proven engine-process downtime, and `task:reconcile-engine-downtime-active-timing-no-action` when no active task qualifies.
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
- FN-7514: the planner overseer's per-task oversight loop (`PlannerRecoveryController.tick`) emits `overseer:oversight-withheld-human-control` when the pure `evaluateOverseerHumanControl` guard withholds ALL oversight action (no steering, retry, targeted-fix, or pending confirmation) for a task that is user-paused (`task.userPaused===true`, or `task.paused===true` with no `pausedReason`) or ineligible for auto-merge processing per `allowsAutoMergeProcessing` (`autoMerge:false`/PR-based human-review terminal contract). The guard runs BEFORE FN-7513's confirmation classification, so a withheld task never records a pending confirmation. Metadata: `{ taskId, reason: "user-paused" | "auto-merge-off-human-review", stage, oversightLevel }`; deduped per (taskId, withheld reason) so it is not re-emitted every poll while the reason is unchanged.


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

Note: the embedded main-content views Workflows (`_WorkflowEditorView`), Import Tasks (`_ImportTasksView`), Automations (`_AutomationsView`), and Settings (`_SettingsView`) in App.tsx are `_`-prefixed lazy splits that reuse already-documented chunks. Task session terminals, onboarding-internal modals, duplicate `AgentDetailView` imports, and right-dock overflow re-imports of already-counted views are also intentionally excluded. These exclusions stay out of the curated list and count; `lazy-loaded-views-docs.test.ts` asserts them explicitly, so do not add them as bullets.

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