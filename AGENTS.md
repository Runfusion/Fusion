# Project Guidelines

## Essential rules

- **Lifecycle containment (FN-207/FN-217):** Automatic work advances through intake, hold, WIP, review, and completion. Only a revision may move a card backward: Plan Review `REVISE` may move WIP to hold, while Code Review, verification, or merge-fix `REVISE` may move review to WIP only with named pending remediation. Timeouts, retries, graph routing, cleanup, dependency recovery, contamination recovery, worktree recovery, and merge failure repair stay in the current lifecycle role. Automatic moves may never target intake or move backward out of terminal lanes.

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
- Every generated or hand-authored `PROMPT.md` must place `## What This Delivers` after `## Original Description` and before `## Before → After Transformation`. Use plain product language with no file paths or symbol names so an operator can confirm intent at a glance; Plan Review treats a missing or jargon-only summary as a blocking REVISE.

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
pnpm release
```

Confirm interactively when prompted. `scripts/release.mjs` is the source of truth. Do not substitute with manual `changeset version`, `pnpm publish`, or git tags. There is no `--yes` skip.


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

The Claude and Grok runtime skill loaders are intentionally duplicated clones and must remain a clean Claude↔Grok rename-diff. `scripts/check-runtime-skill-loader-drift.mjs` enforces that ratchet in `pretest`, `pretest:full`, and the merge gate: a one-sided edit fails the gate. Do not relocate either loader because its skill-source discovery is layout-sensitive.

<!--
FNXC:FleetClaims 2026-08-02-23:59: The "Check whether a file is claimed before converting it" rule
(scripts/check-file-claimed.mjs, added 2026-07-31 for the lifecycle-migration fleet) is REMOVED.
It caused board tasks to park blocked on unrelated open PRs (FN-8728 vs PR #2398). Operator decision:
file-scope conflict detection must only consider Fusion's own board (file-scope leases, dependencies),
never open GitHub PRs. The fleet phase that motivated the rule is complete.
-->

### Standing Rule: Flaky Tests Are Quarantined on Sight (Deletion Ratchet)

- A test observed failing without a corresponding real bug in the change is QUARANTINED ON SIGHT: add an entry to `scripts/lib/test-quarantine.json` (`file`, `reason` with a link to the failing run, `quarantinedAt`) AND a matching one-line `exclude` in that package's vitest config, in the same commit.
<!--
FNXC:TestFlakeRegister 2026-08-01-07:00: Issue #2862 recorded three suite-only PostgreSQL-adjacent flakes in files retaining 6, 75, and 80 passing tests. A first-sighting record preserves that coverage while creating evidence for an immediate second-sighting quarantine.
-->
- On a **first** sighting only, a flake in a file whose remaining coverage is substantial MAY be recorded in [`docs/solutions/test-failures/suite-only-flakes-observed-register.md`](docs/solutions/test-failures/suite-only-flakes-observed-register.md) instead of quarantined, because quarantine is file-level and would evict that coverage over a single observation. Recording is mandatory, not optional evasion: the register entry must include the file path, exact `suite > case`, reproduction data, and observed tree/SHA. A **second** sighting of the same test is an ordinary on-sight quarantine with no further discretion. This exception does not relax the anti-appeasement rule (no widened timeouts, retries, loosened/deleted assertions, or `.skip`) and does not apply to a merge-gate flake, which is still evicted under the gate rule below.
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

### Standing Rule: Never Declare a Component Inside Another Component

- A React component declared inside another component's render is a **new element type on every render**, so React unmounts and remounts its whole subtree on each parent update — focused inputs are destroyed mid-typing, expanded/scrolled rows reset, and local state is silently discarded.
- Hoist it to module scope and pass what it needs as props. If it is only markup, make it a **lowercase render function** (`renderModalShell(children)`): that returns elements without introducing an element type, so the subtree reconciles in place.
- Enforced by `fusion-react/no-nested-component-definitions` (defined in `eslint.config.mjs`, covered by `packages/dashboard/app/__tests__/eslint-no-nested-components.test.ts`). Escape hatch: a preceding `// nested-component-allowlist: <reason>` comment.
- Motivating incidents: FN-8606's `ModalShell` made Planning Mode and Settings untypable (each keystroke remounted the composer, so only the first character survived), and `MailboxModal`'s `ReplyContextExpandable` collapsed already-expanded reply rows whenever another row was expanded.
- Testing note: `fireEvent.change` sets a value without needing the node to stay mounted, so it **cannot** catch this. Assert with real per-character `userEvent.type`, or assert DOM node identity across an unrelated re-render.

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

### Standing Rule: Tests Assert Behavior, Never Source Text Or Comments

**A test may never assert that a comment exists.** Not an `FNXC:` block, not a date stamp, not prose lifted from a source or CSS file. Comments are documentation; asserting them tests nothing a user, caller, or operator can observe.

This is not a style preference — it is a rule this repo's own conventions make self-defeating. The FNXC convention above tells authors to *keep these comments updated as requirements change*. A test pinning one guarantees a future false failure, and the cheapest way to make that failure go away is the worst possible action: **re-adding a comment to shipped source purely to satisfy a test.**

**Measured 2026-08-23.** `grok-runtime-bootstrap.test.ts` asserted `runTaskMerge`'s body contained the literal `FNXC:GrokCliRouting 2026-07-15-10:17`. FN-9167 legitimately rewrote that function and dropped the block while leaving the behavior intact. The test went red, and the fix applied was to restore the comment in `packages/cli/src/commands/task.ts` — a comment returned to the product not because it documented anything true, but to appease a test. Four more such assertions sat in the dashboard's CSS tests (`NewTaskModal`, `FloatingWindow`, `TaskDetailModal.responsive-and-dependencies`, `CommandCenter.tablet-layout`), each beside a real assertion and each adding nothing.

What to do instead, in order of preference:
1. **Assert the behavior** the comment describes: the rendered style, the computed value, the observable outcome, the state after the action.
2. **Assert the code construct** if the invariant is genuinely structural — `expect(body).not.toContain("mergePluginRunner")` is a real guard; `expect(body).toContain("FNXC:…")` is not.
3. **Delete the assertion.** If nothing behavioral or structural is behind it, it was never guarding anything.

**Boundary — this rule does not touch code-construct guards.** Source scans that enforce call-site allowlists and architectural ratchets (`engine-no-blocking-shellout`, `user-configured-command-no-execsync`, `vi-mock-specifiers-resolve`, the durable-write and emit-surface inventories, `legacy-tombstones`, `lazy-loaded-views-docs`) assert code structure, are mandated elsewhere in this document, and stay. The line is: **prose, comments, and date stamps are never a test subject; code constructs may be.**

Enforced by `scripts/check-no-comment-assertions-in-tests.mjs`, which runs in `pretest`, `pretest:full`, and `test:gate:static`. It flags the unambiguous case (an `FNXC:` stamp inside an assertion matcher); an earlier draft that also matched `/*` produced 24 false positives and zero true ones, because a regex cannot tell comment prose from a path glob. The rest of this rule is enforced by review.

### Standing Rule: A Behavior Change Owns Every Test That Asserts The Old Behavior

**Changing behavior is not done until the tests that encoded the old behavior are updated or deleted — in the same change.** This is not the same rule as "keep the tests green": targeted verification runs the tests for the files you touched, and the stale assertions are almost always in files you did not touch, so a green targeted run is not evidence that no test still encodes the behavior you just changed.

Before finishing a change that alters, gates, or removes behavior, actively search for what encodes the old contract:

- **You added a guard, validation, or refusal** (a new required field, a new blocker, a stricter door). Search for the FIXTURES that will now be refused. They will not be in your file scope. Grep for the construct the guard rejects — a `createTask({ branch` without provenance, a task fixture with no `enabledWorkflowSteps` — and fix each fixture to state its intent explicitly.
- **You removed a feature.** Delete its tests. A test asserting a deliberately removed contract guards nothing, and "fixing" it later means re-adding the removed behavior. Grep for the removed symbol, prompt string, flag, or route.
- **You changed an order, a default, a constant, or a prompt.** Grep for the literal. Topology lists, prompt-content assertions, and snapshot fixtures live far from the code they describe. Prompt text also has SIZE budgets (`agent-prompts.test.ts` caps the fast triage prompt) — an addition can break a guard nowhere near the words you wrote.
- **You added a public store/service method.** Check the inventory and drift guards that require every public surface to be classified.

Prefer fixing at the SHARED FACTORY, not per test: one fixture helper usually explains dozens of failures, and per-test patches leave the next author the same trap.

Never make a stale test pass by weakening it. The honest resolutions are: update the fixture to state the intent it always had, record the new truth in the assertion, or delete the test with a comment naming the change that removed its subject. Restoring removed behavior to satisfy a test is a defect, not a fix.

**Motivating incidents (measured 2026-08-24, one full engine suite run):** 297 failing tests, of which ~135 traced to exactly five behavior changes whose tests were never updated — the FN-158 required-pre-merge-gate guard (~70 fixtures across 13 files), the branch-write provenance guard (18 failures from ONE shared reliability fixture), a workflow-IR reorder that moved `completion-summary` before `code-review` (10 stale topology assertions), an `updateTaskAtomic` store seam missing from fake stores (~9), and FN-074's task-splitting removal leaving 4 reviewer-prompt tests asserting a deleted contract. Every one of those changes passed its own targeted verification. `merger-ai.test.ts` alone carried 37 failures that one fixture line fixed.

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
7. **Smart-prefer-main overlap guard.** Recent overlapping main commits can flip to prefer-branch.
8. **Layer-3 scope partition.** Out-of-scope conflicts resolve to main before AI arbitration unless `task.scopeOverride=true`.
9. **Legacy auto-prerebase is inert.** It belonged to the soft-deprecated `aiMergeTask` pipeline; unified `runAiMerge` does not use it.

### Gitignored-path guard on squash merges

Never force-add ignored artifacts (for example `git add -f .fusion/...`). Use task documents for findings/notes.

### File-Scope invariant on squash merges

Every squash commit must overlap task `## File Scope` (unless scope is empty). Violations must fail with `FileScopeViolationError` and reset pre-squash state.

Per-task opt-out exists: `task.scopeOverride = true` (log the reason).

### `autoMerge: false` callout (FN-5147)

When `settings.autoMerge: false`, `in-review` is terminal-until-merged by a human. Lifecycle-mutating self-healing must not move these tasks backward, pause/fail them, or re-enqueue them for execution.

Scoped exception (FN-5819/FN-8823): while project auto-merge is On, shared-branch-group members (`branchContext.assignmentMode === "shared"`) still run the member→shared-branch local integration step subject to the user-Off hold. Under project auto-merge Off, every member is held unless its task explicitly sets `autoMerge: true`; shared-branch → default-branch promotion remains separately gated by group/global auto-merge.

### Mock provider (test mode)

`testMode?: boolean` is now available in both project and global settings. If project `testMode === true` (or the resolved default provider is `"mock"` at any tier), every AI lane is forced to `mock/scripted`, overriding per-task and per-lane model selections. The dashboard exposes this via the Settings Modal "Enable test mode" toggle and a persistent "Test mode — no real AI calls" banner.

### Run Audit
<!--
FNXC:RunAudit 2026-08-20-03:12:
FN-9172 makes executor telemetry optional even when PostgreSQL or an extension sink stalls. Direct
`store.recordRunAuditEvent` calls under `packages/engine/src/executor/` are an anti-pattern: use
`emitBoundedRunAudit` so audit visibility never becomes a lifecycle dependency.

FNXC:RunAudit 2026-08-20-04:15:
FN-9175 promotes this to every engine lane. Direct engine `store.recordRunAuditEvent` calls are an
anti-pattern: use `packages/engine/src/util/emit-bounded-run-audit.ts` and prove hostile sink
isolation through a behavioral regression.

FNXC:RunAudit 2026-08-20-05:39:
FN-9176 applies that seam to hold-release, goals, overseer, mesh leases, runtime credential
rotation, and workflow-column boundaries. The bespoke merge-write fence and packages/core
canonical emitters remain explicit exclusions until their separately scoped hardening work lands.
-->
- FN-9175: New engine run-audit emitters must use `emitBoundedRunAudit` from `packages/engine/src/util/emit-bounded-run-audit.ts`; it absorbs absent, throwing, rejecting, hanging, and late-settling sinks without changing the owning branch, and requires behavioral sink-health coverage.
- FNXC:RunAudit 2026-08-20-05:49: FN-9177 requires new core best-effort emitters to use `packages/core/src/run-audit/emit-bounded-run-audit.ts`. It deliberately mirrors the engine seam because core cannot import engine; transactional and deliberately awaited durability writers remain unbounded.
- FNXC:RunAudit 2026-08-20-07:14: FN-9182 requires core emitters whose behavior branches on audit success to use `emitBoundedRunAuditWithOutcome`; `emitBoundedRunAudit` remains the default best-effort seam, while transactional and deliberately awaited durability writers remain unbounded.
- FN-9180: The `task-deleted-outbox:*` catch-up, reconciliation-fallback, lease-fenced, and retention-pruned emitters use `packages/core/src/run-audit/emit-bounded-run-audit.ts`, remain awaited at their post-cursor/post-DELETE positions, and require hostile-sink production-path coverage.
- FN-9181: Detached recall-capture `memory:capture-recorded` and `memory:capture-failed` emissions use the core bounded seam, preserving the injectable test adapter and preventing stalled telemetry from retaining detached capture work; see `docs/run-audit.md`.
- FN-9233: `worktree:removal-discarded-regenerable-content` records a defensive deletion of allowlisted ignored build or dependency output. Metadata contains only `taskId`, removal reason, and porcelain entry count; non-allowlisted ignored content remains proof-gated and `worktree:removal-preserved` records its refusal.
- FN-9109: `session:cross-runtime-fallback-engaged` records a single retryable-failure handoff from a primary runtime to a deferred CLI runtime. Metadata is ids/outcomes-only (`sessionPurpose`, primary/fallback provider and model IDs, trigger point, failure category, `contextTransferred`); never record error prose or transferred transcript text.

- FN-8958: `merge:orphan-write-fenced` is emitted once per orphan merge body at its fence's first interaction. Metadata is ids/counts/outcomes-only: `{ taskId, category, interaction, suppressedCount }`; `suppressedCount` is the emit-time count (`1` for `interaction:"suppressed"`, `0` for `interaction:"rejected"`), never a cumulative body total.

- Store-open provenance: every `TaskStore.init()` emits `store:open` with ids/paths-only metadata (`pid`, `ppid`, `execPath`, `entry`, `cwd`, `nodeVersion`). Purpose: attribute shared-DB mutations to the process that opened the store (the FN-7910 Ideas-evacuation writer was unidentifiable without it). Tests reading unfiltered `runAuditEvents` must filter out `store:open` rather than assert exact counts.
- FN-8948: `mission:reconcile-pass` records a bounded automatic reconciliation result. Metadata contains optional mission ID, source enum, and scan/write/skip/conflict/failure counters only; never roadmap prose, titles, reasons, or secrets.
- FN-7158: agent performance reflections emit `reflection:generated`, `reflection:skipped`, and `reflection:failed` with ids/counts/outcomes-only metadata; never persist reflection prose or prompt text in run-audit.
- FN-7528: a deterministic, non-LLM post-task performance capture (`AgentReflectionService.captureTaskPerformance`) runs once per completed task and emits `reflection:captured` with ids/counts/outcomes-only metadata (`retryReworkCount?`, `filesTouchedCount?`, `packagesTouchedCount?`, `verificationFileScoped?`, `durationMs?`); never persists `verificationScopeReason` free-text or summary prose in run-audit.
- FN-8932: Memory Keeper emits `memory:consolidation-completed`, `memory:consolidation-skipped`, and `memory:consolidation-failed`. Metadata is ids/counts/outcomes-only: `reason`/`unavailableReason`, `stage`, and `graphRecoveryReason` are fixed enums; it never includes error class/message, memory content, paths, or graph identifiers. No-op ticks emit no audit row; only disabled, unavailable, or genuinely overlapping ticks emit `-skipped`.
- FN-8933: Memory semantics emits `memory:semantics-inferred`/`memory:semantics-skipped`, while automatic recall capture reserves `memory:capture-recorded`/`memory:capture-failed`; metadata is ids/counts/fixed outcomes only and never includes labels, recalled prose, prompts, model output, or reasoning. Inferred graph writes stamp provenance at the sole core seam; detached task, research, and insight capture writers never block their source lifecycle.
- FN-7787: `createResolvedAgentSession` enriches `session:runtime-resolved` with `noModelResolved: true` and `runtimeBuiltInFallbackModel` when a non-mock/non-test session reaches runtime creation without a complete provider/model pair; this is a visibility signal for runtime built-in fallback usage, not a fabricated model-resolution verdict.
- FN-8661: `session:runtime-resolved` records `credentialInstanceId` for a resolved explicit credential, plus `credentialInstanceMissing`, requested, and resolved instance ids when a dangling selection falls back to the provider default. Metadata is ids/outcomes-only and never includes credential material.
- FN-7835/FN-7844/FN-7859/FN-7878: durable-agent error-state recovery emits `agent:auto-recover-error-state` when either the heartbeat timer or the self-healing sweep clears a recoverable, non-operator-actionable `error` and retries; metadata stays ids/counts/outcomes-only (`agentId`, attempt, limit, source), where `source` is `timer`/`automation`/`self-healing`. Generic/unknown heartbeat failures are recoverable by default because manual Retry often proves they were transient; both entry paths share the `heartbeatErrorRecovery` budget (self-healing keeps `durableErrorRecovery` only for cooldown/stale-path bookkeeping) and emit `agent:error-retry-exhausted` when the shared budget is exhausted and the agent is parked `paused` with `pauseReason:"error-retry-exhausted"`. Only operator-actionable durable heartbeat errors (credentials/OAuth scope, model access, billing/quota, excluding transient auth rotation), plus stale worktree/module-resolution errors handled by their dedicated suppression path, skip the retry budget and emit `agent:error-parked-unrecoverable` with ids/counts/outcomes-only metadata (`agentId`, `source`, optional `attempts`, `limit`) before parking `paused` with `pauseReason:"error-unrecoverable"` for human repair.
- FN-7884: self-healing startup recovery emits `agent:reset-error-state-on-startup` when an engine restart clears an eligible durable-agent `error` or `pauseReason:"error-retry-exhausted"` park, resets shared `heartbeatErrorRecovery` plus legacy `durableErrorRecovery` budget/cooldown metadata, clears `lastError`/exhaustion pause state, and re-arms the heartbeat. Metadata stays ids/counts/outcomes-only (`agentId`, `priorState`, optional `priorPauseReason`, `source`). This startup-only path bypasses steady-state staleness/cooldown/exhaustion gates while preserving operator-actionable, stale-module, user-paused, `error-unrecoverable`, ephemeral, disabled-runtime, and active-execution suppression.
- FN-7802: self-healing emits `task:reconcile-missing-worktree-merge-active` when it proves an `in-review` merge-active task (`merging`/`merging-pr`/`merging-fix`) is stranded by an unusable-worktree session-start failure, clears stale `worktree`/`branch`/`sessionFile`, resets the worktree-session retry budget, increments `recoveryRetryCount` as the bounded stale-metadata clear counter, and requeues to `todo`; it emits `task:reconcile-missing-worktree-merge-active-no-action` when `autoMerge:false`, workspace-task ownership, or triple-proof blocks the backward move.
- FN-7863: executor emits `task:execution-dispatch-loop-terminalized` when an execute-node self-requeue loop reaches `MAX_EXECUTE_REQUEUE_LOOP_CYCLES` with an unchanged progress signature; metadata stays ids/counts/outcomes-only (`taskId`, `cycleCount`, `maxCycles`, `progressSignature`, `failureValue`) and the task is visibly failed with `EXECUTION_DISPATCH_LOOP_EXHAUSTED:` while preserving worktree/branch/step progress.
- FN-7926: executor emits `task:completed-blocked-parked` when completed implementation work is held by a live `getTaskCompletionBlocker()` reason instead of re-entering the execute self-requeue loop; self-healing emits `task:completed-blocked-advanced` when the blocker clears and the parked work advances to review. Metadata stays ids/outcomes-only (`taskId`, blocker/source/prior column/status).
- FN-7011/FN-7975: self-healing emits `task:reconcile-engine-downtime-active-timing` when startup recovery or a full Global/Engine unpause shifts active task segment anchors to exclude proven stopped-engine wall-clock, and `task:reconcile-engine-downtime-active-timing-no-action` when no active task qualifies.
- FN-5419: git run-audit now includes `pull:fast-forward` and `stash:pop-conflict`; dashboard git surfaces now include the extended `POST /api/git/pull` integration-worktree path plus companion `POST /api/git/stash-resolve`, `POST /api/git/stash-drop`, and `POST /api/git/stash-apply` routes.
- KB-002: divergent post-merge pushes emit `push:recovery-branch` for the remote `fusion/<task-id>-stranded` safety-ref lifecycle; metadata stays ids/outcomes-only (`taskId`, `remote`, `recoveryBranch`, `sha`, `outcome`). Aborted target pushes emit `push:origin` with `outcome:"aborted"` and remain non-fatal after task finalization.
- FN-245 removes the `task:promote-forced-unplanned` audit event, the `force` option from every promote surface, and the `issueRelease` `allowUnplanned` waiver. Unplanned and approval-held cards are refused on every release surface, including explicit promote; only genuine planning and approval completion can release them into execution.
- FN-6292: self-healing emits `task:reconcile-dependency-blocking-lease` when it rebounds an in-progress holder whose stale file-scope lease blocks an unmet dependency, and `task:reconcile-dependency-blocking-lease-no-action` when triple-proof blocks that backward move.
- FN-6736: self-healing emits `task:reclaim-phantom-executor-binding` when it proves an in-memory executor-active binding is stale, clears the binding, and requeues the in-progress task with worktree/progress preserved.
- FN-6783: task-store open and self-healing housekeeping emit `task:reconcile-orphaned-task-dir` when they non-destructively re-import a valid live `.fusion/tasks/{ID}/task.json` directory that has no task row anywhere, preserving soft-deleted/archived/tombstoned IDs.
- FN-7069: task-store open and self-healing housekeeping emit `task:reconcile-phantom-committed-reservation` when they prune orphaned child rows for a committed task-ID reservation that has no live/soft-deleted/archived task row and no task directory, while preserving the committed reservation so the ID is never reused.
- FN-7074: task creation emits `task:reservation-commit-rolled-back` when a distributed reservation was committed atomically with a `tasks` row but a later create materialization step failed; metadata includes `reservationId`, `nodeId`, `reason: "failed-create"`, and `error`, and the reservation is moved to aborted so the sequence remains burned.
- FN-6782/FN-6796: self-healing emits `task:auto-recover-paused-abort-park` when it clears a benign pause-abort operator park, requeueing safe `todo`/`in-progress` rows or preserving a clean auto-merge-eligible `in-review` row for review progression.
- FN-9187 historical compatibility: persisted `task:auto-archive-failure-budget-exhausted` rows remain readable after task archiving was retired. No live engine path emits this event.
- FN-6793/FN-6797: self-healing emits `task:reconcile-in-review-unmet-dependencies` when it records unmet dependency state on an `in-review` task without moving it backward, and `task:reconcile-in-review-unmet-dependencies-no-action` when pause/user-pause, `autoMerge:false`, or live execution/checkout proof suppresses that in-place repair.
- Workspace (Phase D U1): self-healing emits `task:reconcile-workspace-partial-land` when it re-enqueues a partial/zero-landed workspace task's per-repo land (or parks it `failed` for proven branch absence or exhausted `evidence-unavailable` branch reads), and `task:reconcile-workspace-partial-land-no-action` when `autoMerge:false`, user-pause, a live sub-repo worktree (workspace-aware liveness), or `evidence-unavailable` blocks that backward move. The bounded evidence-exhaustion reason is `evidence-unavailable-exhausted`; audit metadata remains ids/counts/outcomes-only.
- Workspace (Phase D U1): self-healing emits `task:reclaim-phantom-workspace-land-lease` when it clears a leaked `workspace-repo-land` lease whose owning task is terminal/dead and older than the FN-6736 staleness floor. Archived-role and soft-deleted owners are terminal; live merging, executing, or merge-pending owners are untouched.
- FN-9164: `worktree:workspace-repo-base-branch` records per-repo base resolution with exactly `taskId`, `repoRelPath`, `stage`, `source`, `outcome`, and optional `fallbackReason`; branch/ref names are deliberately excluded from metadata and `target`, living only in the durable entry and task log.
- FN-9168: `task:merge-boundary-unproven-parked` is emitted once per terminal merge-boundary-unproven park at the bounded-retry router and reachable graph terminal-merge park. Metadata is ids/counts/fixed outcomes only (`taskId`, `nodeId`, `failureValue`, `source`, optional `reasonCode`/`missingInstanceCount`, `priorColumn`, `priorStatus`, `outcome`) and never boundary reason prose, foreach instance IDs, or error text. `emitMergeBoundaryUnprovenParked` swallows absent/throwing/rejecting sinks and time-bounds a hung one with `MERGE_BOUNDARY_UNPROVEN_AUDIT_EMIT_TIMEOUT_MS`; late settlement is swallowed and the unref'd timer is cleared, so best-effort telemetry never alters, delays, aborts, or wedges the terminal park.
- FN-9058: `worktree:workspace-main-checkout-edit` records workspace completion guard evidence with ids/counts/fixed outcomes only: task/repo IDs, file/commit counts, evidence or warning reason enum, `taskDoneRetryCount`, and `blocked`/`warned`/`skipped`; never paths, file content, or commit prose.
- Main-checkout guard narrowing (2026-08-27): the workspace main-checkout guard blocks completion **only** on a task-attributed commit. Uncommitted status entries emit `outcome:"warned"` with `reason:"uncommitted-only"` plus their `evidence` enum and never refuse `fn_task_done`: workspace lands run the same `landOneRepo`/`landSquash` path as single-repo against the sub-repo main checkout, so a dirty tree there is already stashed → fast-forwarded → restored under `merger.allowDirtyLocalCheckoutSync`. Delivery is proven by the acquired-worktree `no_commits` invariant, not by main-checkout cleanliness. Do not re-add a status-only refusal: it named an operator-only remedy in a message addressed to the agent, so the card could only loop.
- FN-9059: workspace coordination emits `workspace-lease:*` events for lease acquisition, renewal, release, `fence-published`, `fence-superseded`, `reclaimed`, and `reclaim-refused`, plus `workspace-land-intent:*` events for write-ahead intent lifecycle and `resolve-refused`. Metadata is ids, SHAs, counts, and fixed outcomes only; it never includes a credential-bearing remote URL.
- FN-9056: self-healing emits `task:reconcile-orphaned-workspace-worktree` when it reclaims a complete-lane or conservatively-idle failed/soft-deleted workspace entry. It vetoes raw/canonical active paths, task-session/executor/merge liveness, pauses and scheduled recovery; archived rows remain archive-lifecycle-owned. It runs `git worktree prune` even for already-gone paths and deletes only safely-discardable canonical `fusion/<id>` branches. Duplicate, foreign, unowned, or outside-root claims are skipped without git work; one entry-scoped `MAX_STARVATION_DROPS` budget plus settlement bounds retries. Metadata is ids/counts/fixed outcomes: task/repo/path, success/reason/lane, worktree/prune/branch outcomes, and attempt.
- FN-8144: archive emits `archive-workspace-worktree-disposer-missing` when a workspace archive has no store-scoped backend disposer; per-repository archive removal is awaited under canonical-path reservations, with failed paths quarantined for successor reconciliation.
- FN-7514: the planner overseer's per-task oversight loop (`PlannerRecoveryController.tick`) emits `overseer:oversight-withheld-human-control` when the pure `evaluateOverseerHumanControl` guard withholds ALL oversight action (no steering, retry, targeted-fix, or pending confirmation) for a task that is user-paused (`task.userPaused===true`, or `task.paused===true` with no `pausedReason`) or ineligible for auto-merge processing per `allowsAutoMergeProcessing` (`autoMerge:false`/PR-based human-review terminal contract). The guard runs BEFORE FN-7513's confirmation classification, so a withheld task never records a pending confirmation. Metadata: `{ taskId, reason: "user-paused" | "auto-merge-off-human-review", stage, oversightLevel }`; deduped per (taskId, withheld reason) so it is not re-emitted every poll while the reason is unchanged.
- FN-7720: `TaskStore.bypassFailedPreMergeReviewStep` emits `task:bypass-review` when a privileged operator bypasses a blocking pre-merge review gate of an `in-review` task. Target selection prefers the latest `failed` row, then a required gate with no result at all, then (FN-295) a required gate whose existing result is simply not an approval — including a `skipped` row archived by another gate's remediation, whose `remediationArchivedAt`/`remediationArchivedFromStatus` stamps the waiver erases, because an audited human decision supersedes an automatic archive and the stamp is otherwise an unconditional merge veto. Metadata includes metadata includes `workflowStepId`, `workflowStepName`, `bypassedFromStatus`, `bypassedFromVerdict`, and the mandatory `reason`. The bypass rewrites the step's `status` to `"skipped"` with `bypassedBy`/`bypassedAt`/`bypassReason`/`bypassedFromStatus` fields; it never fabricates a reviewer `verdict` and clears only the failed-pre-merge-step `getTaskMergeBlocker` reason. Reachable via `fn_task_bypass_review` (CLI/pi-extension operator tool surface only — not executor/reviewer/triage) and `POST /tasks/:id/bypass-review`.
- FN-8654: credential rotation emits append-only `credential:instance-rotation-attempt`, `credential:instance-rotation-outcome`, and `credential:instance-rotation-exhausted` rows. Attempt and terminal outcome are separate immutable rows; metadata contains provider/instance IDs, lane, optional task/agent IDs, counts, and fixed outcomes only. Exhaustion records `startingInstanceId` separately and excludes it from `attemptedCount`; providers with zero or one configured instance emit none of these rows.
- FN-7996: executor emits `task:execution-tool-failure-retry` for a claimed same-model consecutive-tool-failure retry and `task:execution-tool-failure-retry-exhausted` when the matching run budget is spent. Metadata is ids/counts/outcomes-only; the exhausted event is emitted once through a project-scoped compare-and-set while terminal parking remains idempotent.
- FN-7998: executor emits `task:execution-escalation-retry` when its opt-in, single alternate model/node attempt is persisted after FN-7996 exhaustion, and `task:execution-escalation-exhausted` when that attempt also reaches the terminal park. Metadata remains ids/counts/outcomes-only (`taskId`, graph node id, target booleans, and prior retry count); no model identifiers or prose are persisted in run-audit.
- FN-8004: `agent:heartbeat-move-skipped-soft-delete` records a heartbeat move that races a soft-deleted task without parking the durable agent. Metadata remains ids/timestamps/source only (`agentId`, optional `taskId`/`deletedAt`, `moveAttemptedAt`, optional `source`); it never stores error prose.
- FN-8141: the executor's `fn_task_done(outcome="blocked", reason=..., blockedBy?=[...])` honest-blocked exit emits `task:execution-blocked-parked` when an executor parks a genuinely-impossible task `failed` (`error = "BLOCKED: <reason>"`) instead of laundering it to `done` by skipping steps. It bypasses the completion/verdict/bulk-completion gates (blocked is not a completion claim), leaves steps in their true statuses, preserves worktree/branch, records `blockedBy` as real `task.dependencies` edges so the task requeues behind the blocker, and does NOT hand off to review — the parked row is honored by the executor's `status === "failed"` post-loop branch and is not auto-recovered into in-review by `recoverStrandedCompletedTodoTasks` (steps are not all done/skipped and `task.error` is set). Metadata stays ids/outcomes-only (`taskId`, `blockedBy` ids, `hasReason` boolean, `parkedAs: "failed" | "auto-replan"` — never the reason prose). A blocked exit with EMPTY `blockedBy` parks as `needs-replan` in the replan column instead of `failed` (nothing external to wait for → the recovery is a replan; the failed badge alarmed operators while the overseer replanned anyway); dependency-carrying blocks keep the failed park.
- FN-8305: durable symbol-lock operations emit `symbol-lock:acquired`, `symbol-lock:acquire-conflict`, `symbol-lock:renewed`, `symbol-lock:released`, `symbol-lock:reconcile-stale`, and deduplicated `symbol-lock:reconcile-stale-no-action`. Metadata is ids/counts/outcomes-only; normalized opaque symbol keys are permitted IDs, while raw symbol prose is not.
- FN-8600: triage emits `task:plan-admission-throttled` when planning admission is withheld while eligible cards are waiting, recording the binding gate (`blockedBy`, now always `"running-agent cap"` — the cross-project semaphore that was the other value is deleted, and the four `semaphore*` fields went with it) plus `maxConcurrent`, `claimed`, `projectRoom`, `eligibleCount`, up to five `eligibleTaskIds`, `processingCount`, and up to five `processingTaskIds`. Metadata is ids/counts-only. Deduped on the gate signature INCLUDING the eligible task IDs, so a sustained stall collapses to one row while a new card's stall is never swallowed; the marker is set only after the write lands, so a failed write retries on the next poll. Purpose: before this event the binding gate existed only in a `planLog` line that is persisted nowhere, so "why did this card sit queued to plan?" was unanswerable after the fact. Reachable today by direct DB query only — the sole run-audit read route resolves through a durable agent's heartbeat run and this event uses a synthetic run id under `agentId:"triage"`.
- FN-8592: startup and periodic self-healing emit `task:reconcile-stranded-hold-continuation` when an idle hold-column card with a real spec is re-seeded at its pre-release Plan Review, and deduped `task:reconcile-stranded-hold-continuation-no-action` for a candidate guard or race loss. Metadata stays ids/counts/outcomes-only (`taskId`, `column`, node/workflow identifiers, staleness or reason); healthy non-candidates are silent. The repair is insert-only and uses the shared per-task advisory transaction lock; global/engine pause and `autoMerge:false` defer to the operator.
- Workflow role routing: the executor emits `task:workflow-run-suspended` whenever a graph run ends in the `suspended` disposition, recording where and why the card is waiting (`nodeId`, fixed `reason` code, `fromColumn`/`toColumn`, and the resumed continuation's id/node/state). A suspend writes no task error by design, so without this row a card that re-suspends at the same node every dispatch leaves NO new state anywhere and is indistinguishable from a dead engine — that is how an unwired `agentStore` deadlocked every task unnoticed. Metadata is ids/outcomes-only; reason codes are a fixed enum, never prose.
- Workflow role routing: `replaceActiveTaskWorkflowContinuation` is the ONLY sanctioned way to write a `kind:"task"` continuation. `idx_workflow_work_items_one_active_task_continuation` permits one active row per task and is NOT the constraint a plain upsert's ON CONFLICT targets, so a bare upsert RAISES against a predecessor the run has already left (the resumed continuation, or a sibling foreach instance sharing the template `nodeId`). The primitive retires non-matching active rows and installs the successor in one transaction under the task advisory lock. Never re-add a recovery path that reacts to a failed write by terminalizing other rows: it cannot distinguish an index conflict from a transient database error, and it destroys legitimate holds. Ratcheted by `packages/engine/src/__tests__/legacy-tombstones.test.ts`; the invariant is pinned against a real index by `packages/core/src/__tests__/postgres/workflow-continuation-slot.pg.test.ts`.
- FN-8492: the self-healing sweep `reconcile-orphaned-pending-step-results` (startup, right after legacy adoption, plus periodic maintenance) emits `task:reconcile-orphaned-pending-step-results` when it REWRITES `pending` workflow-step results with no live session behind them to `failed` (canonical liveness triple: `activeSessionRegistry` path, `executingTaskLock`, `isTaskActive`). It must never DELETE an orphaned entry — the merge gate blocks on pending/failed results, not on an enabled step with no result, so deletion silently satisfies the gate and the task merges with its review skipped; the `failed` rewrite keeps the gate closed and hands re-run/bypass to the failed-pre-merge-steps recovery and FN-7720 operator-bypass paths. `in-progress` rows are always skipped (executor-owned; resume is deferred at startup), the row is re-read immediately before the write, and user pauses are never disturbed. Metadata is ids/counts-only (`taskId`, `column`, `orphanedCount`, `resultCount`).
- FN-295: self-healing emits `task:reconcile-collateral-archived-review-gate` when it restores a required pre-merge gate that another gate's remediation archived as collateral (`remediationArchivedAt` with no `bypassedBy`), returning it to its pre-archive terminal status so the FN-7720 audited bypass can select it again. Metadata stays ids/counts-only (`taskId`, `column`, `workflowStepId`, `restoredCount`, `resultCount`); the sweep never fabricates a verdict, never approves, and never touches an operator waiver, the remediation-owning gate, a workspace card, a user-paused card, or a live session.
- FN-279: self-healing emits `task:reconcile-unproven-review-approval` when it rewrites a singular content-review approval without `reviewInputFingerprint` to a recoverable failed result in place. Metadata stays ids/counts/outcomes-only (`taskId`, `column`, `workflowStepId`, `repairedCount`, `resultCount`, `needsOperatorBypass`); reviewer prose, findings, and fingerprints never enter run-audit.
- FN-8923: self-healing emits `task:reconcile-principal-held-planning` when it re-queues planning for a card whose only active continuation is a `held` triage-role row blocked on principal routing (`workflow-principal-*`), and deduped `task:reconcile-principal-held-planning-no-action` for a live session or a lost race. A planning hold has no other retry owner: triage re-admits a hold-column card only on `status: "needs-replan"`, so the hold survives exactly as long as that status does. Candidacy requires the planning lane (hold/intake traits), effective auto-merge on, an owned (null) status, and a grace window; the re-read and write run under the shared planning lifecycle lock. Metadata stays ids/counts/outcomes-only (`taskId`, `column`, `nodeId`, `blockedReason`, `stalenessMs`, optional `reason`). This makes `self-healing.ts` a second writer of `needs-replan` alongside `executor.ts`; the U10b note below describes the graph's replan loop, which this sweep feeds rather than replaces.
- FN-8356: self-healing emits `task:reconcile-stale-duplicate-decision` when it clears a triage-marker duplicate-decision pause against a missing, deleted, done, or archived canonical. Metadata is ids/outcomes-only (`taskId`, `canonicalId`, `canonicalColumn`, `canonicalDeleted`, `priorPausedReason`); active canonical decisions and user pauses remain untouched.
- FN-8953: self-healing emits `task:reconcile-pending-wedge-notification` for a durable deferred wedge hold. Metadata is ids/counts/outcomes-only (`taskId`, `reasonKey`, `pendingAgeMs`, `outcome`), where outcome is `delivered`, `suppressed`, `cleared`, `rearmed`, `held`, `absent`, `unreadable`, `deferred`, or `failed`; descriptor prose is never recorded.
- U9b (R10/KTD-8): the self-healing STARTUP recovery step `adopt-legacy-task-rows` emits `task:reconcile-legacy-adoption` when it adopts a pre-cutover row through the KTD-8 adoption table (clearing a legacy `task.status` whose writer the cutover deleted so the graph re-enters at its owning node, and/or landing the one-time `reviewLevel` -> `enabledWorkflowSteps` preset backfill), and `task:reconcile-legacy-adoption-unmappable` when an UNKNOWN status parks the row `paused` for a human with its status deliberately left in place. Metadata is ids/counts/outcomes-only (`taskId`, `action`, `priorStatus`, `column`, `backfilledStepCount`, `reason`), where `reason` is a fixed adoption-table note and never row prose. Adoption runs FIRST in startup recovery (every later step reasons about `task.status`), stamps `task.legacyAdoptedAt` only on rows it actually mutates (so upgrade does not mass-write every `done` row), and never touches a user pause or a `preserve` gate. `planLegacyAdoption` in `packages/core/src/legacy-adoption.ts` is the single shared decision used by both this sweep and the store-open reconcile so the two cannot drift.
- U10 (R9): the pre-graph cutover machinery is DELETED and stays deleted, ratcheted by `packages/engine/src/__tests__/legacy-tombstones.test.ts`. Gone: `workflow-cutover.ts`, `workflow-authoritative-driver.ts`, `workflow-parity-observer.ts`, the `graphCompletionInterceptors` re-entry map, triage's out-of-graph `runPlanReviewBeforeExecution` gate, and the in-session `fn_review_step` tool with its RETHINK git-reset/session-rewind, per-step conversation checkpoints, deferred reviewer provider-error channel, and review-level prompt scaffolding. Plan/code/browser review are owned EXCLUSIVELY by workflow-graph nodes — do not re-introduce a second review authority inside the implementation session; that duplicate-Plan-Review race is what the cutover removed. The tombstone test strips comments before searching, so the FNXC notes that explain each deletion are expected to remain in source while the code must not.
- U10b (R9): `maybeExecuteWorkflowGraph`'s legacy fallback is DELETED. A TaskStore without `getTaskWorkflowSelection`/`getTaskWorkflowSelectionAsync` no longer falls back to a legacy execute path — graph ownership is unconditional, `graphCompletion` is mandatory rather than optional, and the three completion boundaries that used to branch on its absence are plain returns. `transferPreHeldToLegacy` and the pre-held-slot hand-off to the legacy path are gone with it. Consequence for tests: nothing can reach the pre-graph shape by deleting the selection readers from a mock store; a test that needs "this store cannot resolve a workflow" must assert the fail-closed park, not a fallback.
- U10b: **`task.status === "needs-replan"` is NOT un-migrated legacy.** Post-U3 it is written solely by the graph's own `plan-replan` seam (the `plan-review --failure--> plan-replan` edge -> `requestPreMergeOptionalStepFix` -> `executor.ts` replan write) plus the stale-spec guards that feed the same loop; it is consumed by triage (todo rediscovery + the surgical-revision seed), `hold-release` (blocks re-dispatch of a just-rejected plan), and `task-merge` (auto-merge block). That is the graph's durable replan signal wearing a legacy name. `packages/core/src/__tests__/legacy-adoption.test.ts`'s census guard intentionally requires the literal to still be written in `executor.ts` — it is guarding the GRAPH's writer, so do not "clean it up". Migrating those readers to a purpose-built run-state signal is a deferred post-cutover follow-up (naming/purity), not cutover work.



## Reference docs (deeper detail)

- `./docs/architecture.md` — lifecycle invariants, self-healing rules, reliability interaction backstops, run-audit internals.
- `./docs/knowledge-graph.md` — deterministic committable codebase structure graph.
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
- `./docs/agent-activity-contract.md` — inspectable `/api/agent-activity` wire, cursor, and retention contract.
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
- `GoalsView`
- `PullRequestView`
- `PatchnodeView`
- `SetupWizardModal`
- `SettingsModal`
- `WorkflowNodeEditor`
- `PluginManager`
- `PiExtensionsManager`
- `AgentDetailView`

Note: the embedded main-content views Workflows (`_WorkflowEditorView`), Import Tasks (`_ImportTasksView`), Automations (`_AutomationsView`), and Settings (`_SettingsView`) in App.tsx are `_`-prefixed lazy splits that reuse already-documented chunks. Task session terminals, the Task Detail embedded terminal, onboarding-internal modals, duplicate `AgentDetailView` imports, and right-dock overflow re-imports of already-counted views are also intentionally excluded. These exclusions stay out of the curated list and count; `lazy-loaded-views-docs.test.ts` asserts them explicitly, so do not add them as bullets.

## FNXC_LOG comments:
   - Please whenever you're working on a codebase. I want you to add comments describing the date of the change (must be in this format yyyy-MM-dd-hh:mm) and describing the requirements or the change in requirements that made you implement certain functionality.
   - **Take the timestamp from `date -u`, and use a real clock time.** `check-fnxc-future-dates` accepts a stamp that is not ahead of BOTH the runner's local calendar and UTC (`today = max(localToday, utcToday)`), which is what makes it safe for a fleet whose machines sit in different zones. A `date -u` stamp can never be ahead of that bound — UTC only moves forward between writing and checking — so it passes from every timezone, and it is the only rule with that property. Writing your OWN LOCAL date is safe only if you are not east of UTC: during your evening, an author at UTC+2 has a local date that is already tomorrow in UTC, and that stamp is rejected until UTC catches up hours later. Measured on 2026-08-01: a `2026-08-02` stamp (a UTC+2 author's local date at 22:00 UTC) fails the gate, while the `date -u` stamp of `2026-08-01` passes.
   - This has now broken `main` from BOTH directions, so neither naive rule is safe on its own. Authors WEST of the runner, whose correct 5pm stamp read as "tomorrow" under a UTC-only comparison, cost four breakages in one day; authors EAST of the runner, writing their own local date, cost five more in two hours on 2026-07-31 — all invisible to their authors because `pnpm lint` passed locally. The gate now accepts both honest cases; a genuinely invented date — days out rather than hours — still fails, and so does an impossible clock time (an hour above 23 or a minute above 59).
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
<!-- FNXC:RunAudit 2026-08-20-05:49: FN-9177 requires new core best-effort emitters to use the core-owned bounded seam. -->
- FN-9177: New core best-effort emitters must use `packages/core/src/run-audit/emit-bounded-run-audit.ts`. It deliberately mirrors the engine seam because `@fusion/core` cannot import `@fusion/engine`; transactional and deliberately awaited durability writers remain unbounded.
- FN-9178: Awaited core audit exclusions are classified with evidence in `docs/run-audit.md`: class A candidates, class B outcome-signalled candidates, and class C forensic/durability records. Transactional writers remain permanently unbounded because they share the mutation transaction.
<!-- FNXC:ReviewConvergence 2026-08-22-17:20: FN-149 requires all five review-convergence emit sites to use the FN-9175 bounded seam, so telemetry never becomes a review lifecycle dependency. -->
- FN-149: review convergence emits `task:review-finding-disputed`, `task:review-convergence-escalation`, `task:review-arbitration`, and `task:review-convergence-human-escalation` through `emitBoundedRunAudit`; metadata is ids/counts/fixed outcomes only and never rationale, finding prose, reviewer feedback, or arbiter output.
- FN-9234/FN-9264: `task:review-input-recaptured` and `task:merge-stale-content-review-rerouted` use `emitBoundedRunAudit`; metadata is ids/counts/fixed outcomes only (`taskId`, workflow step id, approval verdict or reroute reason/source, `parkShape`, `parkCleared`, `mergeRetriesReset`, and resolved-in-review finding count). Self-healing recovers only the bounded-retry rejection, raw merge-door blocker, and retry-exhausted stale-content parks after re-seeding review. Fingerprints, diffs, paths, findings, and reviewer prose are never recorded.
- FN-288: `task:review-verdict-repaired` records one bounded same-session request for a missing verdict. Metadata is ids/fixed outcomes only (`taskId`, `workflowStepId`, `outcome`, and the exact repaired verdict when produced); reviewer prose never enters run-audit, and hostile sinks cannot alter the review outcome.
- FN-179: acquire-cache recovery emits `worktree:workspace-repo-acquire-reclaimed` and `task:reclaim-phantom-workspace-acquire-lease`; contention emits `task:session-contention-hold` and `task:session-contention-hold-exhausted`. Metadata is ids/counts/fixed outcomes only; the holder/repository wait reason is persisted on the task row and never put in run-audit.
- FN-209: `task:external-block-parked` and `task:external-block-cleared` record entry to and operator recovery from an outside-worktree freeze. Metadata is ids/fixed outcomes only (`taskId`, origin, code, source, column, resume node id); raw obstacle prose never enters run-audit, and bounded best-effort emission cannot become a lifecycle dependency.
- FN-9253: `task:step-session-abort-contained` records an interrupted step-session repair in place. Metadata is ids/counts/fixed outcomes only (`taskId`, `column`, trigger, outcome, completedStepCount); recovery never performs a backward lifecycle move or clears completed step progress, and bounded best-effort telemetry cannot become a lifecycle dependency.
- FN-9243: `task:merge-unrun-pre-merge-gate-rerouted` records a bounded graph reseed for an enabled pre-merge gate with no result. Metadata is exactly `taskId`, `nodeId`, `workflowStepId`, fixed `reason`, `source`, and `missingGateCount`; it excludes review prose, findings, fingerprints, blocker text, and errors. Lifecycle containment enters a behind-card review gate in place rather than granting `workflow-graph-node-column` backward authority.
