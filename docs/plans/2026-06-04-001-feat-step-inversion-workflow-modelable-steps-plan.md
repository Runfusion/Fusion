---
title: "feat: Step inversion — steps as workflow-modelable nodes"
type: feat
status: active
date: 2026-06-04
depth: deep
origin: none (solo planning bootstrap; extends docs/plans/2026-06-03-003-feat-workflow-custom-columns-traits-plan.md)
---

# feat: Step inversion — steps as workflow-modelable nodes

## Summary

Extend the engine→workflow inversion to **task steps**. Today the engine owns step policy end-to-end: PROMPT.md `### Step N:` headings parse into `Task.steps[]`, the agent session executes them, per-step review happens through the in-session `fn_review_step` tool (verdicts `APPROVE | REVISE | RETHINK | UNAVAILABLE`), RETHINK does `git reset --hard` + session rewind + step reset, and merge is blocked while any step is non-terminal. After this plan, the substrate knows exactly one new thing — **how to run one step of a task inside its session and how to reset one step to its baseline** — and everything else (step granularity, per-step check/verdict, approval gates, rework/escalation routing) becomes user-authored workflow-graph structure: a runtime-expanding **`foreach` template region** instantiated once per planned step, a **`step-review` node** that surfaces review verdicts as outcome edges, and bounded **rework edges** that the executor permits as the only legal cycles.

Steps additionally gain **parallel execution and worktree isolation as explicit foreach axes** (`mode: sequential|parallel`, `isolation: shared|worktree`): PROMPT.md steps may carry `depends:` metadata, and a parallel foreach runs dependency-satisfied instances concurrently — each in its **own worktree/branch off a common base** — with an **ordered integration stage** that lands step branches in step order and routes rebase conflicts to an `integration-conflict` rework outcome (KTD-11).

Third, the **task shape itself becomes workflow-defined** (KTD-12/13/14): the existence of PROMPT.md and the `### Step N:` parsing convention stop being engine law — workflows declare their **artifacts** (named task documents), and **step parsing is itself a graph node**: `parse-steps(artifact, parser)` reads an artifact, runs a registry parser, and writes the step list, with routable `no-steps`/`parse-error` outcomes — and parsers are **plugin-pluggable**. A **`code` node** (KTD-15) runs arbitrary sandboxed TypeScript for logic no built-in covers. Workflows also declare **custom task fields** (typed, with enum options and rendering instructions); the task model reduces to core fields (title, description) plus standard metadata, with everything else as workflow-defined fields, and the task UI renders the field schema dynamically (detail form + card badges).

The default workflow is untouched (monolithic `execute` seam, declares PROMPT.md + the step-headings parser + zero custom fields — byte-identical; it is the parity oracle, same posture as the columns track). Inversion is opt-in via custom workflows; a new built-in **stepwise coding workflow** demonstrates the full modeling and is the parity-comparison subject.

---

## Problem Frame

The columns/traits track (plan 2026-06-03-003, PR #1418) moved board policy — transitions, capacity, hold, merge orchestration — into workflow IR + traits. But **step policy is still engine law**:

- The plan→steps breakdown is a hardcoded regex over PROMPT.md (`store.parseStepsFromPrompt`, `packages/core/src/store.ts:8534`).
- Per-step review is an in-session tool (`fn_review_step`, `packages/engine/src/executor.ts:7300+`) whose verdict handling — APPROVE auto-completes the step, REVISE re-prompts, RETHINK resets git + session + step — is fixed control flow inside a ~3k-line `execute()`.
- Rework routing (what happens after REVISE/RETHINK, how many times, who escalates) is not expressible by a user at all.
- The graph executor (`packages/engine/src/workflow-graph-executor.ts`) sees implementation as one opaque `execute` seam; a workflow cannot say "review each step with a read-only checker before the next step starts" or "send a rejected step to a senior-model rework node."

A user who wants per-step plan review, a different verdict policy, a human approval between steps, or fan-out read-only checks per step has no modeling surface. That policy belongs in workflows; the engine should only supply the mechanisms (run step *i* in the session; reset step *i* to baseline; run the reviewer).

The FN-4359 reliability-freeze waiver carried by plans 002/003 continues to apply to this track. The five lifecycle invariants (FN-5147 terminal-until-merged, hard-cancel, in-review stall, file-scope, squash) plus the lost-work guard trio remain the non-configurable correctness bar.

---

## Scope Boundaries

### In scope

- New IR constructs (additive to WorkflowIr v2): `foreach` node kind with an inline per-step template subgraph; `step-execute` seam node (legal only inside a foreach template); `step-review` node kind; `rework` edge kind (the only legal cycle form); verdict outcome edges.
- Substrate capability extraction: `runTaskStep(task, stepIndex)` (run exactly one step inside the task's single session/worktree, commit with the existing `complete step N` convention) and `resetStepToBaseline(task, stepIndex, baselineSha)` (git reset + session rewind + `updateStep(...,"pending")`), both delegating to existing code, never reimplementing.
- Runtime template expansion with deterministic instance identity, persisted instance run-state (schema v108), crash/resume reconstruction, and a stale-instance recovery sweep.
- `Task.steps[]` kept as the **physical projection sink**: instance transitions call the existing `store.updateStep`, so the merge-blocker, dashboard step display, CLI/TUI, reconcile-from-git, and lost-work reset all keep working unchanged.
- **Parallel step execution** (KTD-11): `TaskStep.dependsOn` metadata parsed from PROMPT.md `### Step N (depends: 1,2):` annotations; foreach `concurrency` config; per-instance worktrees/branches off a common base via the existing worktree pool; ordered integration (rebase/cherry-pick in step order) with `outcome:integration-conflict` routed as rework on the updated base; branch-scoped RETHINK reset in parallel mode.
- **Workflow-defined task artifacts & a `parse-steps` node** (KTD-12): workflows declare named task documents (riding the existing task-documents machinery), and step parsing is a first-class graph node — `parse-steps(artifact, parser)` reads the artifact and writes the step list, with `no-steps`/`parse-error` outcome edges; `parseStepsFromPrompt` becomes the built-in `step-headings` parser in a parser registry; the default workflow keeps its legacy in-execute step init for byte-identical parity.
- **Workflow-defined custom task fields** (KTD-13): typed field definitions (string/text/number/boolean/enum/multi-enum/date/url) with enum options and rendering instructions in the IR; values stored per task and validated against the schema through a single store authority; agent-tool parity.
- **Pluggable step parsers**: plugins register parsers (namespaced ids) through the plugin runtime, mirroring the plugin-trait adapter; fail-closed to `parse-error`.
- **`code` node** (KTD-15): inline TypeScript compiled with esbuild, executed in a timeout-bounded child process against a narrow harness contract (`ctx` in, `{outcome, contextPatch, customFields}` out); save-time syntax validation.
- **Dynamic task UI** (KTD-14): TaskDetailModal renders the field schema as a form section; TaskCard renders card-front-placed fields as badges/chips; workflow editor gains a field-definitions panel.
- Built-in **stepwise coding workflow** (new, opt-in) modeling today's per-step review policy explicitly; parity assertions against legacy in-session behavior.
- Workflow node editor support for authoring foreach/step-review/rework constructs; agent-tool and plugin-SDK type parity; docs.

### Out of scope (deferred for later)

- Removing or rewriting the legacy in-session step path (`fn_review_step`, step-sessions). It remains the flag-OFF behavior and the default workflow's behavior, byte-identical.
- Re-expansion when the agent edits PROMPT.md after the foreach has expanded (instance count is pinned at expansion; documented limitation, surfaced via tool message — see KTD-3).
- Step-template authoring from the dashboard *board* (lanes/cards unchanged); authoring lives in the existing workflow node editor.
- Plugin-defined node kinds (plugins already reach gates via traits; new node kinds stay built-in this round).
- **Recasting existing built-in task fields** (priority, labels, etc.) as workflow custom fields — this plan ships the field *system*; migrating built-ins onto it is a follow-up with its own compatibility track (every built-in field has hardcoded consumers across ~150 files). The field system is designed so that migration is additive when it comes.
- Plugin-contributed field *types* (the field-type whitelist is built-in-only this round; step parsers ARE pluggable, KTD-12).
- Cross-workflow field identity (two workflows defining a field with the same id are distinct schemas; no shared/global field namespace yet).
- Graduating any flag default.

---

## Key Technical Decisions

### KTD-1 — Default workflow stays monolithic; inversion is opt-in (resolves the parity-vs-inversion contradiction)

The built-in default coding workflow keeps its single `execute` seam node and is byte-identical flag-ON and flag-OFF (the existing characterization suites continue to prove this). Per-step modeling cannot be both "verbatim today" and "structurally inverted" — so the default is the **parity oracle**, and inversion ships as authoring capability plus a separate built-in **stepwise coding workflow** users can select. This mirrors exactly how the columns track kept `VALID_TRANSITIONS` as the deprecated-but-retained oracle.

### KTD-2 — One new substrate seam pair: `runTaskStep` / `resetStepToBaseline`

- `runTaskStep(task, stepIndex)` — drives execution of exactly step *i* and returns `{outcome, baselineSha, checkpointId}`. **Honest framing: this is part extraction, part new code.** The discrete per-step boundary (`onStepStart`/`onStepComplete`) exists today only in `StepSessionExecutor` (the `runStepsInNewSessions` path); the monolithic single-session path has no "run one step and return control" seam — the agent self-paces. Therefore: **graph-owned stepwise runs always use step-session physics** (`StepSessionExecutor`), regardless of the `runStepsInNewSessions` setting (pinned per run, like the flag in KTD-8). `runTaskStep` is a thin driver over `StepSessionExecutor` extracted characterization-first; no monolithic single-step driver is invented. The legacy monolithic path is untouched and remains the flag-OFF/default-workflow behavior.
- **Commit authorship is unchanged**: the step agent still authors its own `complete Step N — <summary>` commits (the summary feeds `git log`, merger subject derivation, and `reconcileStepsFromGitHistory`, `executor.ts:11067`). `runTaskStep` **observes** the commit (captures the resulting SHA at step completion) — it never authors commits.
- **Baseline capture is a deliberate, documented behavior change**: today the RETHINK baseline is an agent-supplied tool parameter; in the inverted path the substrate runs `git rev-parse HEAD` at instance start. Because instances run sequentially (KTD-3), HEAD-at-instance-start is exactly the boundary after steps `0..i-1`'s commits — equivalent to what a well-behaved agent supplies today. U7's RETHINK parity test asserts the captured SHA matches the agent-equivalent baseline on scripted runs.
- `resetStepToBaseline(task, stepIndex, baselineSha, checkpointId?)` — the RETHINK mechanics, verbatim from `executor.ts:7455-7505`: `git reset --hard <baseline>`, session rewind via `navigateTree`/`branchWithSummary` fallback, `updateStep(...,"pending")`. Partial-recovery behavior preserved: missing baseline → skip git reset; missing checkpoint → skip rewind (today's semantics, `executor.ts:7466,7492`). **Blast-radius guard** (shared isolation): because rework edges are intra-instance and shared-isolation instances are sequential, a reset for instance *i* can only fire while *i* is active — later instances have not run, and the per-instance baseline postdates steps `0..i-1`, so the reset can never destroy other steps' approved work. `resetStepToBaseline` asserts this invariant defensively (baseline is an ancestor of HEAD; no later instance row is `completed`) and refuses with an audited failure outcome if violated. Under worktree isolation (KTD-11) the reset targets the instance's own branch, making the guard structural.

Crucially this **fixes the in-memory fragility**: today `stepCheckpoints`/`codeReviewVerdicts` are unsynchronized in-memory Maps lost on restart. `baselineSha`/`checkpointId` move into persisted instance run-state (KTD-6). The graph decides *when* a reset happens; the substrate owns *how*.

### KTD-3 — `foreach` node with an inline template subgraph; expansion when the walk reaches it

New node kind `foreach`, config:

```
{
  source: "task-steps",
  maxReworkCycles?: number,
  mode?: "sequential" | "parallel",      // default "sequential"
  concurrency?: number,                   // parallel mode only; default 2, cap 8
  isolation?: "shared" | "worktree",      // default: "shared" for sequential, "worktree" for parallel
  template: { nodes: [...], edges: [...] }
}
```

- `template` is an inline subgraph with exactly one entry and one exit (validated like the main graph; same `validateV2` rules applied recursively).
- Expansion happens **when the walk reaches the foreach node**: `source: "task-steps"` reads `Task.steps[]` at that moment — by then the planning seam / plan node has populated steps (today's `execute()` initializes steps from PROMPT.md before step work begins, `executor.ts:4263-4269`).
- **`mode` and `isolation` are explicit, independent authoring axes** (KTD-11 for the physics):
  - `sequential` + `shared` (default): instances run in step order in the task's main worktree — the baseline physics every other KTD describes.
  - `sequential` + `worktree`: instances still run one at a time, but each in its own worktree/branch with ordered integration — buys branch-scoped RETHINK and a clean per-step audit trail at sequential pace.
  - `parallel` + `worktree`: dependency-aware concurrent execution (below).
  - `parallel` + `shared`: **rejected by the validator** — concurrent write sessions in one worktree are unguardable races.
- **Parallel scheduling**: an instance becomes runnable when all of its step's `dependsOn` steps are integrated (KTD-11); up to `concurrency` runnable instances execute concurrently. `TaskStep.dependsOn?: number[]` is parsed from the PROMPT.md annotation `### Step N (depends: 1,2): Title`; a step with no annotation implicitly depends on the previous step, so an unannotated plan is fully sequential regardless of mode — parallelism is opt-in per step by the planner, not asserted globally by the workflow author. Dependency cycles are rejected at expansion with an audited failure.
- Instance identity is deterministic: `<foreachNodeId>#<stepIndex>:<templateNodeId>` — resume can reconstruct the full instance set from `(foreachNodeId, pinned step count)` without persisting the expansion itself.
- **Expansion-placement validation**: the validator (U1) requires that a `parse-steps` node (KTD-12) dominates — precedes on all paths — any `foreach` with `source: "task-steps"`. This prevents a silent wrong outcome where a mis-authored graph reaches the foreach before parsing, sees zero steps, and merges a task with no step work done.
- **Zero steps parsed** (after a dominating planning node) → the foreach immediately traverses its `success` edge (matches today: zero steps = no merge blocker, `task-merge.ts:202`).
- Step count is **pinned at expansion and persisted** (`pinnedStepCount` on the instance rows' run scope, KTD-6). PROMPT.md edits after expansion do not re-expand; `store.updateStep`'s auto-reinit path is bypassed for graph-owned tasks (the projection writes explicit indices). The agent gets a tool-message notice when it edits steps after expansion (implementation detail, U6).
- **Pin vs. git-reconcile on resume**: if resume-time `Task.steps[]` length differs from the persisted pin (re-parse or reconcile changed it), the run does **not** guess — it fails the foreach with an audited `pin-mismatch` outcome, instance rows are cleared, and the task follows the normal graph-failure recovery path (legacy requeue with git-reconciled `steps[]` as truth). U4 tests cover both grow and shrink.

### KTD-4 — `step-review` node: verdicts become outcome edges

New node kind `step-review`, config `{ type: "plan" | "code", model?: ... }`, legal only inside a foreach template. Its handler calls `reviewStep(...)` (`packages/engine/src/reviewer.ts:306`) under `semaphore.runNested` (same as today, `executor.ts:7397`) against the **current instance's** step, and maps the verdict to outcome edges:

- `outcome:approve` → typically routes forward; the projection marks the step `done` (preserving today's APPROVE-auto-completes semantics for code reviews).
- `outcome:revise` → typically a **rework edge** back to the instance's `step-execute` node (no reset; the session revises in place — today's REVISE).
- `outcome:rethink` → a rework edge whose traversal triggers `resetStepToBaseline` first (today's RETHINK).
- `outcome:unavailable` → bounded retry (mirroring the in-session `planSpecUnavailableCounts` limiter, `executor.ts:7297`), then routes `outcome:unavailable` if still failing; the validator requires it routed or defaults it to the node's `success` path in advisory fashion (plan reviews are advisory today).

The validator requires `approve` and `revise` to be routed; `rethink` defaults to the `revise` target with reset semantics if unrouted. Review nodes are read-only with respect to the worktree. **Verdict authority is single-writer**: only a step-review node on the instance's main path may author the verdict that routes the instance and writes the projection; step-review nodes inside `split` branches are advisory-only (validator-enforced), so fan-out checks can never clobber the authoritative verdict or race the rework budget. `step-execute` may not appear in split branches at all (validator-enforced, extending `SEAM_FORBIDDEN_IN_BRANCH`).

### KTD-5 — Rework edges: the only legal cycles, bounded per instance

New edge attribute `kind: "rework"`. **Mechanism**: foreach instances execute in an **iterative region sub-walk** modeled on `walkBranch` (`workflow-graph-branches.ts:240+`, a `for(;;)` loop over `currentId`), NOT through the recursive `walk`. The recursive walk's `inStack` cycle detector (`workflow-graph-executor.ts:145`) is untouched and still throws on any back-edge outside an active instance region — rework is a loop-back of `currentId` *within* the instance's iterative sub-walk, where cycles are naturally expressible. The two approaches are mutually exclusive; loosening the recursive detector is explicitly NOT the design. Rework traversal count per instance is bounded by `maxReworkCycles` (default 3, hard cap 10 — same clamp posture as `maxRetries`). Exhaustion emits `outcome:rework-exhausted` from the foreach instance; the validator requires it routed (escalation node, hold for human, or failure) or defaults to `failure`. This is deliberately distinct from per-node `maxRetries`, which stays exception-only.

### KTD-6 — Persisted instance run-state; resume reconstructs deterministically (schema v108)

New table `workflow_run_step_instances` (migration 108, additive):

```
taskId, runId, foreachNodeId, stepIndex, pinnedStepCount, currentNodeId, status, baselineSha, checkpointId, reworkCount, branchName, integratedAt, updatedAt
```

(`branchName`/`integratedAt` and the `awaiting-integration` status serve parallel mode, KTD-11; null/unused at `concurrency: 1`.) The same v108 migration adds `tasks.customFields TEXT DEFAULT '{}'` (KTD-13) — one schema bump for the whole plan.

- **No new interface layer**: the CRUD pair (`saveWorkflowRunStepInstance` / `loadWorkflowRunStepInstances` / `clearWorkflowRunStepInstances`) are direct store methods wired into the executor via the same additive-guard pattern as `buildBranchPersistence()` (`executor.ts:3302`). A named persistence interface gets added only if a second adapter materializes in the same PR (e.g., in-memory for tests).
- On resume: rebuild the instance set from the persisted `pinnedStepCount` + rows (mismatch with live `steps[]` → `pin-mismatch` failure, KTD-3); completed instances skip; the in-flight instance seeds its iterative sub-walk position directly from persisted `currentNodeId` + `reworkCount` — **not** from a node-id-keyed `completedNodeIds` skip set, which is unsound under rework cycles (the same node id legitimately runs multiple times). `reconcileStepsFromGitHistory` remains the git-truth fallback and its verdict wins over stale instance rows (rows are corrected to match, never the reverse).
- A stale-instance recovery sweep mirrors `recoverStaleTransitionPending()` — instances `in-progress` with no live session lease are reset to the projection's truth.
- Rows are pruned per run like `clearWorkflowRunBranches` (#1412 pattern). Archived tasks freeze the projection (steps[] persists on `ArchivedTask`); instance rows are pruned.

### KTD-7 — `Task.steps[]` stays the physical sink (emulation, not rewrite)

Instance lifecycle writes go **through `store.updateStep`** (`store.ts:7546`) with explicit indices: instance start → `in-progress`, approve/complete → `done`, rethink reset → `pending` (via `resetStepToBaseline`). Consequences, all intentional:

- Merge-blocker (`task-merge.ts:202`), dashboard step bars, TUI step lists, `mesh-lease-manager` work-started detection, and lost-work reset keep reading the same array with the same semantics — **no consumer changes**.
- `updateStep`'s regression/out-of-order guards stay active. The graph writes are ordered (sequential instances), so guards should never fire; if they do, that's a projection bug surfaced loudly in the audit log (U6 adds an audit warning on guard-suppressed graph writes rather than today's silent ignore).
- `currentStep` auto-advance behavior is preserved by construction. Rework loops legitimately move a step `done→pending` only via `resetStepToBaseline` (RETHINK), which today already does exactly that — board display of a step regressing is existing behavior.
- The merge-blocker race (instance completes vs. projection flush) is closed by ordering: `updateStep` is called **before** the instance row flips to `completed` (projection-first ordering, same reservation-first discipline as capacity in plan 003 KTD-10).

### KTD-8 — Flag posture: `workflowGraphExecutor` gates it; flag pinned per run

The foreach/step-review machinery is interpreter functionality, gated by the existing `experimentalFeatures.workflowGraphExecutor` flag (the columns flag is orthogonal and untouched). The flag is **read once at dispatch and pinned for the run** — a mid-flight toggle takes effect on the next dispatch, never mid-walk (closes the dual-writer hazard: legacy and graph paths both mutate `steps[]`/worktree). The same pin applies to execution physics: graph-owned stepwise runs force step-session mode for the run's duration regardless of the `runStepsInNewSessions` setting (KTD-2), so the flag-interaction matrix (graph ON × step-sessions OFF) cannot select an unsupported physics combination. Flag-OFF rollback mid-task follows the existing `fell-back`/recovery posture: instance rows are swept, `steps[]` (the projection — always git-reconcilable) is the surviving truth, and legacy resume reconciles from git exactly as it does today. IR with foreach nodes is v2-only; `downgradeIrToV1IfPure` already refuses non-v1 node kinds, so #1405's rollback contract is preserved automatically.

### KTD-9 — Built-in stepwise coding workflow is the demonstration + parity subject

A second built-in (`builtin-stepwise-coding-workflow-ir.ts`): plan seam → parse-steps(PROMPT.md, step-headings) → foreach(task-steps){ step-execute → step-review(code) with approve→exit, revise→rework, rethink→rework+reset, rework-exhausted→hold(manual) } → review seam → merge seam. Its observable step-state trajectory for equivalent inputs must match the **legacy step-session path's** trajectory (same `updateStep` sequence, same merge-blocker windows; the step-session path is the deterministic oracle — the agent-paced monolithic path is not deterministically comparable, see U7) — asserted by a characterization-style trajectory comparison, reusing the `workflow-parity.ts` observation machinery rather than inventing new drift tracking.

### KTD-10 — Authoring surface: node editor additions, board untouched

`WorkflowNodeEditor` gains foreach (container/group node rendering the template subgraph), step-review, and rework-edge authoring; `workflow-flow-mapping.ts` round-trips them. The board/lanes render nothing new — step progress continues to come from `Task.steps[]` (KTD-7). Per-instance metadata (rework counts, verdicts) surfaces only in the task detail workflow results area, additively.

### KTD-11 — Parallel step execution: per-instance worktrees, ordered integration, optimistic conflicts

`mode` and `isolation` are explicit foreach config (KTD-3). Worktree isolation applies whenever `isolation: "worktree"` — in `sequential` mode it yields one-at-a-time instances with branch isolation + ordered integration (clean branch-scoped RETHINK without concurrency); in `parallel` mode, when the dependency graph admits it, multiple step instances run concurrently. The physics:

- **Isolation**: each worktree-isolated instance gets its **own worktree and branch** off the current **integration base** (the task's main branch tip at instance start), allocated through the existing worktree pool (`worktree-pool.ts`) with canonical per-instance branch names. Each instance is its own step-session (`StepSessionExecutor` already creates per-step sessions — natural fit) and acquires a normal `AgentSemaphore` lease, so machine resource ceilings apply unchanged; `concurrency` is additionally clamped by available semaphore slots (parallelism degrades gracefully to sequential under contention, never deadlocks waiting for slots it holds).
- **Ordered integration**: under worktree isolation, instance completion does NOT mark the step done. A foreach-internal **integration stage** lands completed step branches onto the integration base **in step order** (rebase/cherry-pick); only successful integration flips the projection (`updateStep(...,"done")`) and unblocks dependents. Shared isolation integrates trivially — work lands directly in the main worktree, and done-at-step-completion semantics match the rest of this plan unchanged.
- **Conflicts are optimistic**: no upfront file-scope declarations. A rebase/cherry-pick conflict during integration emits `outcome:integration-conflict` from that instance — default routing is a rework edge: the instance's branch is discarded, and the step re-executes **on the updated base** (counting against its `maxReworkCycles` budget; exhaustion routes `rework-exhausted` as usual). The validator requires `integration-conflict` routed or defaults it to the rework path.
- **RETHINK under worktree isolation is branch-scoped**: `resetStepToBaseline` resets the instance's branch only — sibling instances and the integration base are untouched, which makes the KTD-2 blast-radius guard structural rather than defensive in this mode. (Shared isolation keeps the KTD-2 guard as written.)
- **Reconcile alignment**: `complete step N` commits exist on instance branches before integration and on the main history after it; `reconcileStepsFromGitHistory` reads main-worktree history, so its verdict ("done iff integrated") agrees with the projection rule by construction.
- **Projection ordering guard**: `store.updateStep`'s out-of-order-done guard (`store.ts:7592-7610`) assumes index order; graph-source writes (U6's `source: "graph"`) relax it to **dependency order** — a done write is legal when all `dependsOn` steps are done. `currentStep` auto-advance (first non-done scan) is order-agnostic already.
- **Persistence**: instance rows gain `branchName` and `integratedAt`; status adds `awaiting-integration`. Crash under worktree isolation resumes by reconciling rows against branch existence: integrated → done; branch exists, not integrated → re-enter integration queue; branch missing → instance re-runs.

### KTD-12 — Workflow-defined task artifacts & a `parse-steps` node

Today `PROMPT.md` is hardcoded engine law: created by the planning phase, parsed by the fixed regex in `parseStepsFromPrompt` (`store.ts:8534`), and assumed by reconcile, step init, and resume prompts. Inversion — **step parsing is itself a graph node**, visible and reorderable workflow structure:

- **IR gains an `artifacts` declaration**: `artifacts: [{ key, title?, producedBy?: "planning" | "manual", role?: "step-source" | "context" }]`. Artifacts ride the **existing task-documents machinery** (`TaskDocument`, `fn_task_document_write/read`) — no new storage; `PROMPT.md` becomes the default workflow's declared `step-source` artifact backed by its current file location (the document layer already fronts it).
- **New node kind `parse-steps`**, config `{ artifact: <key>, parser: "step-headings" | "json-steps" }`. Its handler reads the artifact at walk time, runs the named parser, and writes the canonical step list through the projection sink (`Task.steps[]` via the store, graph source — same single authority as everything else). Outcomes: `success`, `outcome:no-steps` (parsed cleanly, zero steps — routable, defaults to success), `outcome:parse-error` (malformed artifact — routable, defaults to failure). The node is the *only* graph-side writer of the step list; running a `parse-steps` after a foreach has already expanded trips the KTD-3 pin protection (audited failure), so re-plan loops cannot silently desynchronize an expanded foreach.
- **Parser registry is pluggable**: the registry (same posture as the trait registry) holds built-ins `step-headings` (the extracted `parseStepsFromPrompt` logic, including the `(depends: …)` annotation from U1 — extraction, not rewrite) and `json-steps` (a structured `[{name, depends?}]` document for workflows that plan in JSON), and **plugins register parsers** under namespaced ids (`plugin:<pluginId>:<parserId>`) through the plugin runtime — mirroring `plugin-trait-adapter.ts`. Contract: `(artifactContent, ctx) → {steps: [{name, dependsOn?}]}`, executed through the plugin runner with a timeout; an unavailable or throwing plugin parser maps to `outcome:parse-error` (fail-closed, audited) — never a crash. IR referencing a parser absent from the live registry is rejected at save with the id named.
- **foreach consumes, never parses**: foreach `source: "task-steps"` just reads `Task.steps[]`; the KTD-3 dominance validation is now concrete — a `parse-steps` node must dominate any `foreach(source:"task-steps")` on all paths (the monolithic default workflow has no foreach and keeps its legacy in-`execute()` step init untouched).
- **The planning seam contract**: the workflow's `producedBy: "planning"` artifacts are what the planning seam is told to produce (surfaced in the planning prompt); the engine no longer assumes PROMPT.md by name outside the default workflow's declaration. Reconcile (`reconcileStepsFromGitHistory`) and resume read through the workflow's parse-steps declaration to know which artifact/parser governs the task.
- **Parity**: the legacy path (`parseStepsFromPrompt` callers in store/executor) delegates to the same extracted `step-headings` parser function — byte-identical, proven by the existing parse tests running against both the direct call and the registry resolution. The stepwise builtin's chain becomes: plan seam → `parse-steps(PROMPT.md, step-headings)` → foreach.

### KTD-13 — Workflow-defined custom task fields

The task model is recast as: **core fields** (title, description) + **standard metadata** (column/status, timestamps, branch/git state, workflow selection) + **workflow-defined custom fields** for everything else. This round ships the field system; built-ins stay where they are (see Out of scope).

- **IR gains `fields`**: `fields: [{ id, name, type, required?, default?, options?, render? }]` where `type ∈ string | text | number | boolean | enum | multi-enum | date | url`; `options: [{value, label, color?}]` for enum kinds; `render: { placement?: "card" | "detail" | "detail-section", widget?: "select" | "radio" | "chips" | "input" | "textarea" | "toggle", badge?: boolean }` as rendering instructions. Validator enforces id uniqueness, type whitelist, options present iff enum-kind, render-hint whitelist.
- **Storage**: `tasks.customFields` JSON column (added in the same v108 migration as the instance table — one schema bump for the plan). Values keyed by field id.
- **Single write authority**: a store-level `updateTaskCustomFields(taskId, patch)` (and the same path inside `updateTask`) validates every write against the task's workflow field schema — type check, enum membership, required-on-transition is NOT enforced this round (fields are data, not gates; a `gate` trait can read them later). Invalid writes are typed rejections, mirroring `TransitionRejection` style.
- **Schema evolution**: editing a workflow's fields follows the reconciliation posture of columns (#1409/`rehome_to` precedent): removing a field orphans existing values (retained, rendered under an "orphaned fields" disclosure in detail UI, excluded from cards); an incompatible type change is rejected unless the update names `coerce: "drop" | "keep-orphaned"`. Tasks switching workflows keep values for ids the new workflow also defines (same id = same field by convention within a project), orphan the rest.
- **Agent-native parity**: `fn_task_update` accepts a `custom_fields` patch (validated through the same authority); `fn_workflow_create/update` accept `fields`; field values are surfaced in session/task context so agents can read and set them.

### KTD-14 — Dynamic task UI from the field schema

- **Task detail**: `TaskDetailModal` renders a schema-driven fields section — widget per `type`+`render.widget` (select/radio/chips for enums, toggle for boolean, date input, validated url/number inputs, textarea for text), grouped by `placement` (`detail` inline near description; `detail-section` as a collapsible group). Saves go through the dashboard route → store authority; validation errors surface inline per field (400 with field path).
- **Card front**: fields with `placement: "card"` render as badges/chips on `TaskCard` (enum colors from `options[].color`; boolean as a labeled chip when true). Card real estate is bounded: max 3 card-placed fields rendered, overflow indicated — the validator warns (not rejects) past 3.
- **Data flow**: field definitions ship with the board-workflows payload (`/api/tasks/board-workflows` already carries per-workflow data and invalidates on `workflow:updated` SSE); task field values are already on the task payload via `customFields`.
- **Workflow editor**: a **Fields panel** in the workflow editor (sibling to the column panel from the columns track) — add/edit/remove field definitions, enum option editor with color picker, render-placement controls, live badge preview. Reuses the editor's existing validation-at-save surfacing.
- **TUI**: read-only rendering of card-placed fields in the task detail view (chips → bracketed labels); no TUI editing this round.

### KTD-15 — `code` node: arbitrary TypeScript in the graph

A general computation escape hatch so workflows can express logic no built-in node covers (derive a field from artifacts, call an internal API, compute routing data):

- **New node kind `code`**, config `{ source: string, timeoutMs?: number }` — inline TypeScript. Compiled in-memory with esbuild at execution (and syntax-checked at save: the validator runs the same transform and rejects IR whose source fails to compile), then run in a **child process** with cwd = the task's worktree.
- **Harness contract**: the script default-exports `async (ctx) => result`, where `ctx = { task, steps, customFields, context, artifacts: {read(key)}, instance? }` (instance present inside a foreach template — the `foreach:active` data). The returned `{ outcome?, value?, contextPatch?, customFields? }` maps to graph behavior: `outcome` routes `outcome:<value>` edges (absent → success), `contextPatch` merges into walk context, `customFields` writes through the U11 validation authority. Throw/timeout/non-zero exit → `failure` outcome with the error audited.
- **Boundaries**: the code node does NOT get a store handle, engine internals, or the step-list write path — steps are written only by `parse-steps` (KTD-12), task fields only through the validated patch it returns. It can read artifacts and the worktree; it runs with the same trust as existing workflow script steps (workflows are project-local, user-authored config — `WorkflowStepMode "script"` already executes arbitrary project scripts today, so this adds expressiveness, not a new trust tier). Timeout clamped (default 30s, cap 300s); stdout/stderr captured and size-capped into the node result; source size capped (64KB).
- **Placement rules**: legal anywhere a script node is legal, including inside foreach templates and split branches (it is review-side/read-only with respect to git unless the author's code itself writes files in the worktree — same as script nodes today; the file-scope guard still applies to anything it commits via the session, and the code node itself never commits).
- **Editor**: palette entry + inspector with a code textarea (monospace, esbuild syntax errors surfaced at save), timeout input.


---

## Requirements

- R1: A workflow can define a per-step template subgraph instantiated once per planned step at runtime (`foreach`, source `task-steps`).
- R2: Step execution is exposed by the substrate as the `step-execute` seam only. At `concurrency: 1` (default) instances run sequentially in step order in the task's main worktree; at `concurrency > 1` dependency-satisfied instances run concurrently in per-instance worktrees (R15).
- R3: Per-step review is a graph node whose APPROVE/REVISE/RETHINK/UNAVAILABLE verdicts route as outcome edges; validator enforces approve/revise routing and read-only placement rules.
- R4: RETHINK semantics (git reset to per-step baseline + session rewind + step→pending) are a substrate capability triggered by rework-edge traversal; baseline/checkpoint persist across restart.
- R5: Rework cycles are the only legal graph cycles, scoped to one template instance, bounded by `maxReworkCycles` (default 3, cap 10), with a routed exhaustion outcome.
- R6: `Task.steps[]` remains the projection sink via `store.updateStep`; merge-blocker, dashboard/TUI step display, reconcile, and lost-work behavior are unchanged for all tasks.
- R7: Instance run-state persists (schema v108), survives crash/restart with deterministic identity, is swept when stale, and is pruned per run; git reconcile remains authoritative over instance rows.
- R8: Zero planned steps → foreach no-ops through its success edge.
- R9: Default workflow byte-identical flag-ON/OFF (existing characterization suites stay green, unmodified in intent).
- R10: Flag pinned at dispatch; mid-flight toggles affect only subsequent dispatches; flag-OFF rollback mid-task converges via existing fell-back + git-reconcile recovery.
- R11: Built-in stepwise workflow reproduces the legacy per-step trajectory for equivalent runs (parity assertion via `workflow-parity.ts` observations).
- R12: Node editor can author/round-trip foreach, step-review, rework edges; IR validation errors surface at save time; i18n-wrapped strings; component tests registered in `qualityAppComponentTests`.
- R13: Agent tools and plugin SDK expose the new IR types (type-only in SDK); `fn_workflow_create/update` accept the new constructs with the same validation.
- R14: Five lifecycle invariants + lost-work guard trio remain non-configurable and covered by tests on the stepwise path.
- R15: Parallel step execution per KTD-11 — foreach exposes explicit `mode` (sequential|parallel) and `isolation` (shared|worktree) axes (parallel+shared validator-rejected); `dependsOn` parsed from PROMPT.md (unannotated steps depend on the previous step, preserving sequential behavior by default); per-instance worktrees off the integration base; ordered integration flips the projection (done iff integrated); rebase conflicts route `outcome:integration-conflict` to rework on the updated base within the rework budget; concurrency clamped by semaphore availability without deadlock; dependency cycles rejected at expansion.
- R16: Step parsing is a graph node per KTD-12 — `parse-steps(artifact, parser)` is the only graph-side writer of the step list, with routable `no-steps`/`parse-error` outcomes; workflows declare task artifacts; the parser registry's `step-headings` is the extracted `parseStepsFromPrompt`, byte-identical for legacy callers; a parse-steps node must dominate any foreach; parse-steps after foreach expansion trips the pin protection; plugin-registered parsers resolve through the plugin runtime and fail closed to `parse-error`.
- R17: Workflows define custom task fields (typed, enum options, render instructions) per KTD-13; values validated through a single store authority with typed rejections; field removal orphans (never destroys) values; agent tools have full read/write parity.
- R18: Task UI renders the field schema dynamically per KTD-14 — detail form widgets by type, card badges by placement, workflow-editor Fields panel; zero custom fields renders exactly today's UI.
- R19: `code` node per KTD-15 — save-time compile validation, child-process execution with clamped timeout and capped output, harness contract honored (no store handle, fields only via the validated patch, steps never), throw/timeout → audited failure.

---

## Implementation Units

### U1 — IR: foreach, step-review, rework edges, dependsOn parsing, validation

- **Goal**: Additive WorkflowIr v2 extensions with full validation (R1, R3 validator half, R5 shape, R8 shape, R15 shape).
- **Files**: Modify `packages/core/src/workflow-ir-types.ts`, `packages/core/src/workflow-ir.ts`, `packages/core/src/types.ts` (`TaskStep.dependsOn?: number[]`), `packages/core/src/store.ts` (`parseStepsFromPrompt` regex extension for `### Step N (depends: 1,2): Title` — the current regex `^###\s+Step\s+\d+[^:]*:` breaks on the colon inside the annotation, so the updated regex must parse the annotation explicitly AND remain byte-identical for unannotated headings); tests `packages/core/src/__tests__/workflow-ir.test.ts` (extend), new `packages/core/src/__tests__/workflow-ir-foreach.test.ts`, store parse tests extended.
- **Approach**: Add `foreach`, `step-review`, and `parse-steps` to `WorkflowIrNodeKind` (parse-steps config validation: artifact key references a declared artifact, parser in the registry whitelist); `WorkflowIrEdge.kind?: "rework"`; foreach `config.template` as inline `{nodes, edges}` validated recursively (single entry/exit, no nested foreach this round, `step-execute` seam legal only here, `split` branches inside templates may contain only read-only nodes — extend `SEAM_FORBIDDEN_IN_BRANCH`). Verdict-routing validation per KTD-4 including the single-writer rule (step-review inside a split is advisory-only); **dominance validation**: a steps-populating node must precede any `foreach(source:"task-steps")` on all paths (KTD-3); rework edges legal only intra-template; `mode`/`isolation`/`concurrency` validation (parallel+shared rejected; concurrency ≥1, cap 8, parallel-mode-only); `V1_NODE_KINDS` untouched so `downgradeIrToV1IfPure` refuses these (KTD-8).
- **Patterns to follow**: `validateParallelism` / `walkBranchToJoin` (`workflow-ir.ts:92-180`) for region validation; hold-node config validation (`workflow-ir.ts:214-221`).
- **Test scenarios**: parse/validate happy path; template with 0/2 entries rejected; step-execute outside foreach rejected; step-execute inside a split branch rejected; rework edge crossing template boundary rejected; unrouted approve/revise rejected; unrouted rethink defaults to revise target; unrouted rework-exhausted defaults to failure; foreach not dominated by a parse-steps node rejected; parse-steps referencing an undeclared artifact or unknown parser rejected; verdict-authoring step-review inside a split rejected (advisory-only allowed); maxReworkCycles clamp (0→1? reject; 99→10); parallel+shared isolation rejected; concurrency clamp + concurrency-on-sequential rejected; `(depends: 1,2)` parsed into dependsOn; unannotated headings parse byte-identically to today; malformed depends annotation falls back to plain-name parse; v1 round-trip refusal (`downgradeIrToV1IfPure` returns v2 unchanged); JSON round-trip stability.
- **Verification**: new + extended IR tests green; `pnpm --filter @fusion/core build`.

### U2 — Substrate seams: `runTaskStep` / `resetStepToBaseline`

- **Goal**: Build the two substrate capabilities per KTD-2 (R2, R4 mechanics). **Execution note: characterization-first** — capture the `StepSessionExecutor` call sequence (updateStep ordering, commit observation, reset behavior incl. missing-baseline/checkpoint partial paths) before building on it.
- **Files**: Modify `packages/engine/src/executor.ts` (`:4291-4350` step-session paths and `:7455-7505` RETHINK block); new `packages/engine/src/step-runner.ts` if extraction warrants a module; tests `packages/engine/src/__tests__/step-runner.test.ts`, extend `packages/engine/src/__tests__/executor-step-session.test.ts`.
- **Approach**: `runTaskStep` is a thin driver over `StepSessionExecutor` (graph-owned runs force step-session physics, KTD-2/KTD-8); the RETHINK block is accessor-extracted verbatim into `resetStepToBaseline` with the blast-radius guard added. Baseline captured at instance start (substrate `git rev-parse HEAD` — documented behavior change, KTD-2). The agent still authors step commits; `runTaskStep` observes them. Legacy in-session path keeps calling the same underlying code — `fn_review_step` behavior is untouched.
- **Patterns to follow**: `runImplementationPhase` extraction (`executor.ts:3444-3455`); `executor-test-helpers.ts` harness.
- **Test scenarios**: runTaskStep marks in-progress→done with correct commit message; failure outcome leaves step non-done; reset with baseline+checkpoint does git reset + rewind + pending; reset missing baseline skips git reset but still flips pending; reset missing checkpoint skips rewind; legacy fn_review_step path byte-identical (characterization).
- **Verification**: characterization tests green pre- and post-extraction; engine vitest targeted suites; `pnpm --filter @fusion/engine exec tsc --noEmit`.

### U3 — Graph executor: expansion, instance walk, bounded rework cycles

- **Goal**: Executor support for foreach expansion, deterministic instance identity, sequential instance execution, rework back-edges with per-instance bounds, verdict outcome edges (R1, R2 ordering, R5, R8).
- **Files**: Modify `packages/engine/src/workflow-graph-executor.ts`, `packages/engine/src/workflow-node-handlers.ts`; tests new `packages/engine/src/__tests__/workflow-graph-foreach.test.ts`.
- **Approach**: On reaching a foreach node, read `Task.steps[]`, pin the count, materialize instance node ids `<foreachId>#<i>:<inner>` and run each instance through an **iterative region sub-walk** modeled on `walkBranch` (KTD-5 — the recursive walk's cycle detector at `:145` is untouched); rework edges loop `currentId` back within the instance, decrementing the per-instance budget; exhaustion emits `outcome:rework-exhausted`. **Active-instance context is threaded via the existing `contextPatch` mechanism under the reserved key `foreach:active`** carrying `{foreachNodeId, stepIndex, baselineSha, checkpointId}` — handlers already read `context`, and U5/U8 depend on this key explicitly (decision promoted from Deferred; reserved-key prefix prevents collision with split/join context patches). Zero steps → success edge. Abort signal honored between nodes (existing posture).
- **Patterns to follow**: `runSplitJoin` / `walkBranch` (`workflow-graph-branches.ts:148-364`) for region sub-walks, abort, and completed-node skip; `executeNodeWithRetries` (`workflow-graph-executor.ts:244-280`) for bound clamping.
- **Test scenarios**: 3-step expansion runs 9 instance nodes in order; zero steps skips; revise rework loops twice then approves; rework exhaustion routes exhausted edge; rework budget is per-instance not shared; non-rework cycle still throws; abort mid-instance stops cleanly; outcome:unavailable retry-then-route; split fan-out of read-only checks inside a template joins correctly; `foreach:active` context key visible to template handlers and absent outside instances.
- **Verification**: foreach executor suite green; existing `workflow-graph-executor-parity.test.ts` and `workflow-graph-fanout.test.ts` untouched and green.

### U4 — Persistence + resume + recovery (schema v108)

- **Goal**: Instance run-state survives crash/restart; stale sweep; pruning (R7, R10 recovery half).
- **Files**: Modify `packages/core/src/db.ts` (migration 108), `packages/core/src/store.ts` (CRUD: `saveWorkflowRunStepInstance` / `loadWorkflowRunStepInstances` / `clearWorkflowRunStepInstances`), `packages/engine/src/executor.ts` (`buildStepInstancePersistence()`), `packages/engine/src/self-healing.ts` (stale sweep); tests `packages/core/src/__tests__/db-migrate.test.ts` (extend, incl. v107→108 forward path per #1417 pattern), new `packages/core/src/__tests__/workflow-step-instances.test.ts`, extend `packages/engine/src/__tests__/restart.integration.test.ts`.
- **Approach**: Mirror `workflow_run_branches` table + `WorkflowBranchPersistence` adapter + additive guard (`executor.ts:3302-3314`); resume reconstruction per KTD-6 with git-reconcile authoritative; sweep mirrors `recoverStaleTransitionPending`; prune per run.
- **Test scenarios**: migration 107→108 forward; CRUD round-trip; crash mid-instance-2 resumes at instance 2 with instances 0-1 skipped; crash during rework pass 2 resumes at pass 2 (seeded from `currentNodeId`+`reworkCount`, not re-running pass 1); steps[] grows on resume after pin → `pin-mismatch` failure; steps[] shrinks on resume → `pin-mismatch` failure; stale in-progress row with no lease swept to projection truth; git says step N done but row says in-progress → row corrected; rows pruned on run completion; pre-108 store → in-memory fallback (additive guard).
- **Verification**: core + engine suites green; schema version literal sweep done **up front, atomically with the migration commit**, using the broad pattern `grep -rn 'toBe(107)' packages/` (~40+ sites across at least 8 test files: db.test.ts alone has ~25; insight-store, goals-schema, run-audit, task-documents, store-merge-queue, merge-request-record, mission-store add more — the narrow `getSchemaVersion()).toBe(107)` pattern missed satellites last round).

### U5 — step-review node handler + verdict wiring

- **Goal**: Graph-native per-step review delegating to `reviewStep`, verdicts as outcomes, UNAVAILABLE limiter, rethink-triggers-reset (R3, R4 routing half).
- **Files**: Modify `packages/engine/src/workflow-node-handlers.ts`, `packages/engine/src/executor.ts` (handler wiring + reset trigger on rework traversal), `packages/engine/src/reviewer.ts` (only if a narrow option needs exposing); tests new `packages/engine/src/__tests__/workflow-step-review.test.ts`.
- **Approach**: Handler resolves the active instance from the `foreach:active` context key (U3), calls `reviewStep` under `semaphore.runNested`; verdict→outcome mapping per KTD-4 with single-writer verdict authority (split-branch reviews advisory-only); persists verdict + reworkCount into the instance row (replacing the in-memory maps **for graph-owned tasks only** — legacy maps untouched); rethink rework-edge traversal invokes `resetStepToBaseline` with persisted baseline/checkpoint before re-entering the instance.
- **Patterns to follow**: `createGateHandler` / `createPromptLikeHandler` (`workflow-node-handlers.ts:43-66`); fail-closed posture of gates.
- **Test scenarios**: approve marks step done (projection) and routes approve edge; revise routes rework without reset; rethink resets (git+session+pending) then re-executes; unavailable retries then routes; verdict persisted across simulated restart; review node in a split branch runs read-only against the same instance without verdict clobbering (serialized per instance).
- **Verification**: step-review suite green; reviewer suites untouched green.

### U6 — Projection discipline: updateStep wiring + guard audit

- **Goal**: All instance lifecycle writes flow through `store.updateStep` with projection-first ordering; guard-suppressed graph writes audit loudly; PROMPT.md-edit-after-expansion notice (R6, KTD-7).
- **Files**: Modify `packages/engine/src/executor.ts` / `workflow-graph-executor.ts` (write ordering), `packages/core/src/store.ts` (audit warning on suppressed graph-source updateStep; explicit-index bypass of auto-reinit for graph-owned tasks); tests extend `packages/core/src/__tests__/store.test.ts` step sections, new assertions in `workflow-graph-foreach.test.ts`.
- **Approach**: `updateStep` gains an optional `source: "graph"` arg (additive, default legacy semantics); graph-source writes relax the out-of-order-done guard (`store.ts:7592-7610`) from index order to **dependency order** (done is legal when all `dependsOn` steps are done — KTD-11); projection-first ordering (updateStep before instance row flip) closes the merge-blocker race; merge-blocker, dashboard, TUI, mesh-lease, lost-work paths verified unchanged by existing tests.
- **Test scenarios**: projection-first ordering observable (merge-blocker never sees completed-instance/pending-step inversion); guard-suppressed graph write emits audit warning; legacy updateStep silent-ignore behavior unchanged; auto-reinit bypass only for graph-owned tasks; zero-step task mergeable.
- **Verification**: store + task-merge suites green; characterization suites green.

### U7 — Built-in stepwise workflow + parity & invariant coverage

- **Goal**: Ship the demonstration workflow; prove trajectory parity and invariant preservation (R9, R11, R14, R10 toggle tests).
- **Files**: New `packages/core/src/builtin-stepwise-coding-workflow-ir.ts` (+ registration alongside the existing builtin); tests new `packages/engine/src/__tests__/stepwise-workflow-parity.test.ts`, extend flag-toggle/crash coverage in `restart.integration.test.ts`.
- **Approach**: IR per KTD-9; parity via `workflow-parity.ts` observation comparison of the `updateStep` trajectory + merge-blocker windows against the **legacy step-session path** (`runStepsInNewSessions` ON — the deterministic per-step oracle; the agent-paced monolithic path is not deterministically comparable and stays covered by the existing default-workflow characterization suites). **Test-file ownership is explicit**: `stepwise-workflow-parity.test.ts` owns updateStep-trajectory + merge-blocker-window comparisons (scripted runs, legacy vs stepwise); the existing `workflow-graph-executor-parity.test.ts` stays focused on default-workflow byte-identity — a header comment in each file declares its parity subject. Explicit tests for flag pinned-at-dispatch, toggle-mid-flight deferred to next dispatch, flag-OFF rollback converging via git reconcile; five invariants + lost-work trio exercised on the stepwise path.
- **Test scenarios**: identical updateStep sequence legacy-step-session vs stepwise for a 3-step approve-all run; revise-then-approve trajectory parity; RETHINK trajectory parity (incl. git state, and captured-baseline == agent-equivalent baseline assertion per KTD-2); RETHINK blast-radius guard refuses when a later instance row is completed; FN-5147 terminal-until-merged on stepwise; hard-cancel mid-instance; file-scope guard fires inside step-execute; toggle mid-run does not switch paths; OFF-rollback then legacy resume completes the task.
- **Verification**: parity suite green; full default-workflow characterization suites green unmodified.

### U8 — Node editor authoring + flow mapping

- **Goal**: Author/round-trip foreach (group node), step-review, rework edges; save-time validation surfacing (R12).
- **Files**: Modify `packages/dashboard/app/components/WorkflowNodeEditor.tsx`, `packages/dashboard/app/components/workflow-flow-mapping.ts`, `packages/dashboard/app/components/WorkflowNodeEditor.css` (or sibling component CSS per the extraction convention); tests extend `packages/dashboard/app/components/__tests__/WorkflowNodeEditor.test.tsx`, `workflow-flow-mapping.test.ts`; register any new component test in `packages/dashboard/vitest.config.ts` `qualityAppComponentTests`.
- **Approach** (design decisions committed here, not deferred):
  - **Template authoring is inline**: template nodes are always-visible React Flow children of the foreach group node (`parentId` set to the group), no drill-in canvas mode. `flowToIr` partitions nodes by `parentId` — children of a foreach group reassemble into that node's `config.template`; everything else stays top-level. Empty foreach groups render an empty-state hint ("drag a step-execute node here").
  - **Palette**: add `foreach` (preset `source:"task-steps"`, auto-populating one `step-execute` child so the group is never confusingly empty), `step-review`, `parse-steps` (preset artifact `PROMPT.md`, parser `step-headings`; inspector renders an artifact select over the workflow's declared artifacts and a parser select sourced from the live registry incl. plugin parsers), and `code` (inspector: monospace source textarea with save-time esbuild error surfacing + timeout input) entries to the PALETTE array (`WorkflowNodeEditor.tsx:87`).
  - **Inspector fields**: `foreach` branch renders a `mode` select (sequential|parallel), an `isolation` select (shared|worktree — shared disabled when mode is parallel, matching the validator), a numeric `concurrency` input shown only in parallel mode (min 1, max 8, placeholder 2), and a numeric `maxReworkCycles` input (min 1, max 10, placeholder 3 — mirroring the `maxRetries` input pattern at `WorkflowNodeEditor.tsx:711`); `step-review` branch renders a `type` select (plan|code) and the existing `CustomModelDropdown` (optional, like the gate node's model field).
  - **Edge authoring**: selecting an edge whose source is a `step-review` node shows an edge inspector with a condition dropdown (approve/revise/rethink/unavailable — stored as `outcome:<verdict>` conditions, displayed as short labels) and a "rework" toggle (sets `kind:"rework"`). Rework edges render dashed in the accent color with a loop indicator.
  - Validation errors from `parseWorkflowIr` surface inline at save (existing pattern); all strings `t("key","Default")`; i18n keys added across the 6 locales via the deep-merge convention (do not let the sync prune dynamic keys — prior incident).
  - **Per-instance metadata display** (KTD-10): a per-step row group in the existing `WorkflowResultsTab` — step name, verdict chip per review pass, rework count badge when > 0, `rework-exhausted` rendered as a warning state.
- **Test scenarios**: round-trip IR→flow→IR stability with foreach template (children partitioned by parentId); save with unrouted approve edge shows validation error; rework edge create/delete via edge inspector; foreach/step-review inspector field editing; palette auto-populates step-execute child; i18n keys present.
- **Verification**: dashboard component shards green locally (`qualityAppComponentTests` batch); editor save produces v2 IR accepted by core parser.

### U10 — Parallel step execution: per-instance worktrees, dependency scheduler, ordered integration

- **Goal**: KTD-11 end to end on top of sequential foreach (R15). **Execution note: test-first** for the integration/conflict state machine.
- **Files**: Modify `packages/engine/src/workflow-graph-executor.ts` (dependency-aware instance scheduler inside foreach), `packages/engine/src/executor.ts` / `packages/engine/src/worktree-pool.ts` (per-instance worktree/branch allocation + release), new `packages/engine/src/step-integration.ts` (ordered rebase/cherry-pick integration stage + conflict detection); tests new `packages/engine/src/__tests__/workflow-step-parallel.test.ts`, extend `restart.integration.test.ts`.
- **Approach**: Two orthogonal switches from KTD-3 config: worktree isolation (per-instance branch + ordered integration — also usable in sequential mode) and parallel scheduling (runnable set = instances whose `dependsOn` are all integrated; schedule up to `min(concurrency, free semaphore slots)` concurrently). Each isolated instance runs as its own step-session in its own worktree branched from the integration base; completion enqueues `awaiting-integration`; the integration stage lands branches strictly in step order, flipping the projection (`updateStep done`, graph source) only on success; conflict discards the branch and routes `outcome:integration-conflict` (rework on updated base, budget-counted). Branch-scoped RETHINK. Worktrees released on integration/discard (pool hygiene).
- **Patterns to follow**: `worktree-pool.ts` allocation/canonical naming; `runSplitJoin` concurrency + abort wiring (`workflow-graph-branches.ts`); merger rebase/conflict handling for the integration mechanics (`merger.ts` — reuse its conflict-classification helpers, do not reimplement).
- **Test scenarios**: diamond dep graph (1 ← 2,3 ← 4) runs 2∥3 then 4; sequential+worktree runs one at a time with per-step branches and ordered integration; unannotated plan stays fully sequential at concurrency 4; conflict between parallel steps → loser reworks on updated base and succeeds; conflict rework exhaustion routes rework-exhausted; integration order is step order even when completion order inverts; crash with one branch un-integrated resumes into the integration queue; branch missing on resume re-runs the instance; semaphore starvation degrades to sequential without deadlock; dependency cycle at expansion fails audited; RETHINK resets only the instance branch; merge-blocker stays blocked until last integration (projection rule).
- **Verification**: parallel suite green; sequential foreach suites (U3) untouched green; file-scope guard + lost-work trio exercised on parallel paths.

### U11 — Custom task fields: IR schema, storage, write authority

- **Goal**: KTD-13 core half (R17). **Execution note: test-first** for the validation authority.
- **Files**: Modify `packages/core/src/workflow-ir-types.ts` / `workflow-ir.ts` (`fields` declaration + validation), `packages/core/src/types.ts` (`Task.customFields?: Record<string, unknown>`, `WorkflowFieldDefinition`), `packages/core/src/db.ts` (customFields column rides the U4 v108 migration), `packages/core/src/store.ts` (`updateTaskCustomFields` authority + `updateTask` integration + orphan handling on workflow edit/switch); new `packages/core/src/task-fields.ts` (validation: type check, enum membership, render whitelist); tests new `packages/core/src/__tests__/task-fields.test.ts`, workflow-ir tests extended.
- **Approach**: per KTD-13 — single write authority with typed rejections (TransitionRejection style); field removal orphans values; incompatible type change rejected unless `coerce` named (reuses the `rehome_to` conflict-resolution pattern from workflow updates); workflow-switch keeps same-id values.
- **Patterns to follow**: `workflow-ir.ts` column validation; `plugin-gate-verdict.ts` typed-shape style; #1409 reconciliation posture.
- **Test scenarios**: each type validates/rejects correctly; enum membership enforced; multi-enum subsets; unknown field id rejected; required default applied at task create under the workflow; field removed → value orphaned not deleted; type change without coerce rejected, with coerce honored; workflow switch keeps same-id values and orphans the rest; zero-fields workflow → writes to custom_fields rejected cleanly; JSON round-trip.
- **Verification**: core suite green; v108 migration test covers the column.

### U12 — `parse-steps` node, workflow artifacts & parser registry

- **Goal**: KTD-12 (R16) — the `parse-steps` node handler, artifact declarations, and the parser registry. **Execution note: characterization-first** — pin `parseStepsFromPrompt` behavior before extraction.
- **Files**: Modify `packages/core/src/workflow-ir-types.ts` / `workflow-ir.ts` (`artifacts` declaration — parse-steps node-kind validation itself lands in U1), new `packages/core/src/step-parsers.ts` (registry + `step-headings` extraction + `json-steps`), `packages/core/src/store.ts` (`parseStepsFromPrompt` delegates to the registry), `packages/engine/src/workflow-node-handlers.ts` (parse-steps handler: read artifact → run parser → write step list via the graph-source projection path → outcome mapping), `packages/engine/src/plugin-parser-adapter.ts` (new — plugin parser registration through the plugin runtime, mirroring `plugin-trait-adapter.ts`; timeout + fail-closed mapping to parse-error), `packages/engine/src/executor.ts` (reconcile + planning-prompt artifact contract reads the workflow declaration; pin-protection check for parse-steps after expansion); tests new `packages/core/src/__tests__/step-parsers.test.ts`, new `packages/engine/src/__tests__/workflow-parse-steps.test.ts`, executor reconcile tests extended.
- **Approach**: per KTD-12 — the node is the only graph-side step-list writer; registry is built-in-only; foreach `source: "task-steps"` reads the projection; the default workflow keeps its legacy in-execute step init (untouched code path) while legacy `parseStepsFromPrompt` callers delegate to the same extracted parser (parity by construction); planning seam surfaces `producedBy: "planning"` artifact keys in its prompt.
- **Patterns to follow**: trait registry (`trait-registry.ts`) for the registry shape; `createGateHandler` for handler wiring; task-documents machinery for artifact backing.
- **Test scenarios**: step-headings extraction byte-identical on existing fixtures (incl. depends annotations); json-steps parses `[{name, depends}]`; parse-steps writes steps through the graph-source projection path; `outcome:no-steps` on clean-empty parse routes (defaults success); `outcome:parse-error` on malformed artifact routes (defaults failure), not crash; missing artifact → parse-error; parse-steps after foreach expansion → pin-protection audited failure; default workflow parity (direct call vs registry resolution identical); reconcile reads through the workflow's parse-steps declaration; plugin parser happy path through the runner; plugin parser timeout/throw → parse-error (fail-closed, audited); IR referencing an unregistered plugin parser rejected at save.
- **Verification**: characterization tests green pre/post extraction; core + engine suites green.

### U13 — Dynamic task UI: field rendering + Fields panel

- **Goal**: KTD-14 (R18).
- **Files**: Modify `packages/dashboard/app/components/TaskDetailModal.tsx` (schema-driven fields section), `packages/dashboard/app/components/TaskCard.tsx` (card-placed badges/chips), new `packages/dashboard/app/components/TaskFieldsSection.tsx` + `TaskFieldsSection.css` + `WorkflowFieldsPanel.tsx` (editor Fields panel, sibling to the column panel), `packages/dashboard/src/routes/` (field-values PATCH endpoint → store authority, 400 with field path), `packages/dashboard/src/routes/board-workflows.ts` (field defs in payload), CLI TUI task detail (read-only chips); tests new `packages/dashboard/app/components/__tests__/TaskFieldsSection.test.tsx` + `WorkflowFieldsPanel.test.tsx` (BOTH registered in `qualityAppComponentTests`), TaskCard/TaskDetailModal tests extended.
- **Approach**: per KTD-14 — widget per type/render hint; max-3 card fields with overflow indicator; enum colors from options; orphaned-fields disclosure in detail; live badge preview in the Fields panel; zero custom fields renders exactly today's UI (snapshot-guarded); all strings `t()`-wrapped, 6-locale deep-merge.
- **Test scenarios**: each widget type renders + edits + validation error inline; card badge placement honors max-3 overflow; enum color applied; orphaned values shown in disclosure, absent from card; Fields panel CRUD + option color editor + save-time IR validation surfaced; zero-fields snapshot identical; SSE workflow:updated refreshes field defs.
- **Verification**: dashboard component shards green; `qualityAppComponentTests` registration verified; TUI render test.

### U14 — `code` node: compile, sandbox runner, harness contract

- **Goal**: KTD-15 (R19). **Execution note: test-first** for the harness contract and failure modes.
- **Files**: Modify `packages/core/src/workflow-ir-types.ts` / `workflow-ir.ts` (`code` node kind + save-time esbuild syntax validation + source/timeout clamps), new `packages/engine/src/code-node-runner.ts` (esbuild in-memory compile + child-process execution + harness I/O + output caps), `packages/engine/src/workflow-node-handlers.ts` (handler wiring: ctx assembly incl. `foreach:active`, result mapping to outcome/contextPatch/customFields-via-U11-authority); tests new `packages/engine/src/__tests__/code-node.test.ts`, IR validation tests extended.
- **Approach**: per KTD-15 — esbuild is already in the toolchain (vitest); child process gets cwd = worktree, a minimal env, and the serialized ctx; no store handle crosses the boundary; returned customFields patch goes through `updateTaskCustomFields`; stdout/stderr captured (capped) into the node result for the audit log.
- **Patterns to follow**: script-step execution for process spawning + capture posture; `createPromptLikeHandler` for handler shape; U11 authority for field writes.
- **Test scenarios**: happy path returns value + routes success; `outcome: "foo"` routes `outcome:foo` edge; contextPatch merges; customFields patch validated (invalid → node failure with typed rejection surfaced); syntax error rejected at IR save; runtime throw → failure audited; timeout kills the child and fails; output cap enforced; source size cap; inside a foreach template receives `instance`; no steps-write path exists (attempting one is not expressible via the contract).
- **Verification**: code-node suite green; validator round-trip green.

### U9 — Agent tools, plugin SDK, docs, changeset

- **Goal**: Agent-native parity and documentation (R13, R16/R17 agent halves).
- **Files**: Modify `packages/engine/src/agent-tools.ts` (`fn_workflow_create/update` accept `fields`/`artifacts`; `fn_task_update` accepts `custom_fields` patch through the U11 authority; planning-prompt guidance for `depends:` annotations; `fn_trait_list` untouched), `packages/cli/skill/fusion/references/engine-tools.md` (tool table — the skill-sync test enforces this), `packages/plugin-sdk/src/index.ts` (TYPE-ONLY re-exports of new IR types — runtime exports break the standalone-artifact test), `docs/workflow-steps.md`, `docs/architecture.md` §9 extension, `CONCEPTS.md`; new `.changeset/step-inversion-workflow-modelable-steps.md` (with rollback note, mirroring the columns changeset).
- **Test scenarios**: fn_workflow_create with a foreach IR + fields validates and persists; invalid template/field rejected with the IR error surfaced; fn_task_update custom_fields validated through the authority; SDK type-only export keeps standalone-artifact test green; skill-sync test green.
- **Verification**: agent-tools tests green; plugin-sdk test green; docs render.

### Dependencies & sequencing

U1 → (U2 ∥ U4-core-half) → U3 → U5 → U6 → U10 → U7; U9 last. U2, U3, U5, U6, U10 are **strictly serial** (all touch `executor.ts`/graph executor). U4's core-only half (db.ts migration + store CRUD) parallelizes with U2; U4's executor wiring (`buildStepInstancePersistence`) waits for U3. U10 (parallel/isolated execution) builds on sequential foreach (U3) + projection discipline (U6) and lands before U7 so the parity/invariant suite covers all modes. U8 may start IR-type authoring, palette, inspector, and CSS work in parallel with U3–U6 (the `foreach:active` context decision is now committed in U3's approach, so no mid-stream rewrite risk); its round-trip tests land after U1 is merged.

The task-shape track is largely independent of the step-execution track: **U11 (fields core) parallelizes with U2–U6** (core-only, no executor surface beyond the U4 migration it shares); **U12 (artifacts/parsers) follows U1** (shares IR validation) and its executor touches (reconcile/planning contract) slot between U6 and U10 in the serial executor chain; **U13 (dynamic UI) follows U11** and parallelizes with U8 (different dashboard surfaces; both register component tests). U7's parity scope includes U12's default-workflow declaration. **U14 (code node) follows U1** (node kind) and **U11** (field-write authority); its engine half is independent of the U2–U10 executor chain except the handler-registration touch, which slots anywhere after U3.

---

## Risks & Mitigations

- **RETHINK convergence (highest risk)**: git reset + session rewind + projection + instance rows must converge. Mitigation: substrate owns the whole reset atomically (KTD-2); baseline/checkpoint persisted (KTD-6); rework traversal is the single trigger point (U5); trajectory parity test for RETHINK specifically (U7).
- **Cycle-support regression in the executor**: loosening the cycle detector could mask authored-graph bugs. Mitigation: exemption is narrowly scoped (rework kind + same active instance), non-rework cycles still throw (U3 test).
- **Dual-writer on flag transition**: closed by pin-at-dispatch (KTD-8) + OFF-rollback convergence tests (U7).
- **`executor.ts` merge conflicts with main**: extraction in a ~3k-line function while main moves (see `docs/solutions/best-practices/merge-conflict-extraction-vs-semantics-and-parallel-bootstrap.md`). Mitigation: extraction commits kept mechanical and early; rebase before U5+.
- **Projection guard masking**: `updateStep` silently ignores invalid transitions, which would hide projection bugs. Mitigation: audit-loud for graph-source writes (U6).
- **Schema-version literal sweep**: v107 bump missed satellite test files last round (4 CI rounds). Mitigation: explicit grep sweep in U4's verification.
- **Integration-conflict churn (parallel mode)**: heavily-overlapping steps marked independent would loop integrate→conflict→rework until budget exhaustion. Mitigation: optimistic conflicts are budget-counted with a routed exhaustion outcome; unannotated steps default to sequential dependence, so parallelism only exists where the planner asserted it; the planning prompt guidance (U9 docs) tells planners to annotate `depends:` conservatively.
- **Worktree pool pressure**: per-instance worktrees multiply pool usage. Mitigation: concurrency cap 8, semaphore clamp, and release-on-integration hygiene in U10; pool reuse machinery already exists for fan-out branches.
- **Parser extraction parity (KTD-12)**: `parseStepsFromPrompt` has subtle behaviors (auto-reinit interplay, regex edge cases) that a registry indirection could perturb. Mitigation: characterization-first in U12; default workflow resolves to the same extracted function, asserted identical on existing fixtures.
- **Dynamic UI regression surface (KTD-14)**: schema-driven rendering touches TaskCard/TaskDetailModal, the two highest-traffic components. Mitigation: zero-fields snapshot guard (today's UI byte-identical when no fields are defined); new rendering isolated in `TaskFieldsSection`; card overflow bounded at 3.
- **Code-node misuse surface (KTD-15)**: arbitrary TS in workflows can do anything the user can. Mitigation: explicit trust framing (same tier as existing script steps), no store handle across the boundary, field writes only through the validated patch, steps never writable, clamped timeout + output caps, save-time compile rejection, full stdout/stderr audit capture.
- **Plugin parser availability drift (KTD-12)**: a workflow saved against a plugin parser can outlive the plugin. Mitigation: save-time registry check; at runtime fail-closed to `parse-error` (routable), never a crash; audit names the missing parser id.
- **Field-schema drift vs stored values**: workflow edits can strand values. Mitigation: orphan-not-delete posture (KTD-13), `coerce` confirmation on incompatible type changes, orphaned-fields disclosure in detail UI.

## System-Wide Impact

- `Task.steps[]` consumers: none change (KTD-7) — verified, not assumed, by existing suites in U6/U7.
- `workflow_run_branches` pattern reused, not modified; `workflow_run_step_instances` is net-new.
- Legacy in-session step path: untouched code paths; only extraction-level refactor (U2) with characterization proof.
- The columns-track flag (`workflowColumns`) and its graduation report are untouched; this track rides `workflowGraphExecutor`.

## Deferred to Implementation

- Whether `runTaskStep` needs a distinct module (`step-runner.ts`) or stays an executor method — decide by extraction size in U2.
- Whether the foreach instance sub-walk reuses `runSplitJoin`'s AbortController/semaphore wiring for read-only split fan-out inside templates, or a separate path — decide in U3 (split-inside-sequential-loop is untested territory in `workflow-graph-branches.ts`).
- Tool-message wording for PROMPT.md-edited-after-expansion notice (U6).
- Display-label strings for `outcome:<verdict>` edge conditions in the editor (U8 renders short labels; exact i18n copy at implementation).

## References

- Predecessors: `docs/plans/2026-06-03-003-feat-workflow-custom-columns-traits-plan.md` (completed), `docs/plans/2026-06-03-002-feat-workflow-interpreter-cutover-plan.md` (superseded; its executor characterization findings remain accurate), `docs/plans/2026-06-03-001-feat-executable-custom-workflows-node-editor-plan.md` (completed).
- Contracts: `docs/architecture.md` §9 (substrate/policy framing); `docs/rfcs/FN-5719-decouple-executor-merger.md` (lifecycle seam + invariant bar).
- Key code anchors: `packages/core/src/store.ts:7546` (updateStep), `packages/core/src/task-merge.ts:202` (merge-blocker), `packages/engine/src/executor.ts:3444` (runImplementationPhase), `:7300-7505` (fn_review_step/RETHINK), `:11067` (reconcile), `packages/engine/src/workflow-graph-executor.ts:145` (cycle detector), `:244-280` (retries), `packages/engine/src/workflow-graph-branches.ts` (region walk + persistence pattern), `packages/engine/src/reviewer.ts:306` (reviewStep), `packages/core/src/workflow-ir.ts` (validators).
