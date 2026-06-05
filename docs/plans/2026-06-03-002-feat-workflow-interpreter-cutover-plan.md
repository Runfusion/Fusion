---
title: "feat: Workflow interpreter cutover — graph owns the full lifecycle"
type: feat
status: superseded
date: 2026-06-03
depth: deep
origin: docs/plans/2026-06-03-001-feat-executable-custom-workflows-node-editor-plan.md (Deferred Track)
---

# feat: Workflow interpreter cutover — graph owns the full lifecycle

## Summary

Promote `WorkflowGraphExecutor` from a flag-off no-op to the authoritative driver of a task's lifecycle, so a custom workflow graph can **replace** planning → execute → review → merge, not just inject steps around it. The user has explicitly waived the FN-4359 reliability freeze for this track; the parity invariants below remain the correctness bar regardless.

The existing scaffold already provides: graph walking with cycle detection, `success`/`failure`/`outcome:*` edge conditions, per-node retries, a `WorkflowLegacySeams` interface (`execute/review/merge/schedule`), the `workflowGraphExecutor` experimental flag, and the dual-observe parity machinery. The MVP (plan 001) provides: persisted workflow definitions, the node editor, and per-task selection. What's missing is **real seam implementations**, **custom-node handlers** (the default handlers throw for non-seam prompt/script nodes), and the **entry point** that routes a graph-selected task through the interpreter.

---

## Scope Boundaries

### In scope
- M-A: Interpreter foundation — custom-node handlers + a `WorkflowGraphTaskRunner` with injected seams, fully tested with fakes.
- M-B: Real seam wiring — delegate execute/review/merge to the legacy engine implementations via narrow injected callbacks from `TaskExecutor`/`ProjectEngine`.
- M-C: Flag-gated entry point — graph-selected tasks route through the interpreter when `experimentalFeatures.workflowGraphExecutor` is on; legacy fallback on any interpreter error.
- M-D: Parity + graduation — dual-observe on real runs, drive drift to zero, then default the flag on for graph-selected tasks.

### Deferred to Follow-Up Work
- Removing the legacy hardcoded pipeline (FN-5719 Phase 4) — only after M-D proves parity in the field.
- Planning/triage as a replaceable seam (the `schedule` seam exists but triage replacement needs the planning subsystem mapped first).
- Parallel branches (fan-out) executing concurrently — the walker is sequential; concurrency within a graph is a later extension.

---

## Key Technical Decisions

- **KTD-1 — Seams delegate, never reimplement.** The `execute`/`review`/`merge` seam implementations call the same engine functions the legacy path uses (agent session machinery, `reviewStep`, the auto-merge queue). The interpreter owns *sequencing*; the engine keeps owning *mechanics* (worktrees, leases, file-scope guard, squash contract, self-healing). This is the enqueue-only posture from DAG ADR-0001 applied to seams.
- **KTD-2 — Custom nodes run on the WorkflowStep machinery.** Non-seam prompt/script/gate nodes execute via the same prompt-session/script/verdict machinery as workflow steps (proven, readonly-tool-policy aware), invoked through an injected `runCustomNode` callback — the interpreter stays engine-agnostic and unit-testable with fakes.
- **KTD-3 — Legacy fallback on interpreter error (M-C).** Any thrown error from the interpreter path (not a graph-routed `failure` edge) falls back to the legacy pipeline for that task and emits an audit event. No task is ever stranded by interpreter bugs.
- **KTD-4 — Column transitions are seam side-effects.** `execute` seam entry → `in-progress`, review handoff → `in-review`, merge success → `done` — performed by the delegated engine code itself (KTD-1), so board invariants (FN-5147 terminal-until-merged, hard-cancel) are preserved by construction.
- **KTD-5 — Invariant bar (from FN-5719 / workflow-steps.md):** `FileScopeViolationError` guard, squash/merge contract, `autoMerge:false` terminal-until-merged, `moveTask(in-progress→todo)` hard-cancel, resume-limbo non-oscillation. Parity is machine-checked via the existing `compareWorkflowRunObservations` / `compareWorkflowRunAudits`.

---

## Implementation Units

### U1. Custom-node handlers (unblock non-seam nodes)
**Goal:** Default handlers route seam-configured prompt/script nodes to seams and **custom** prompt/script nodes to an injected runner instead of throwing.
**Files:** `packages/engine/src/workflow-node-handlers.ts`, `packages/engine/src/__tests__/workflow-node-handlers.test.ts`.
**Approach:** `createDefaultNodeHandlers(seams, runCustomNode)` — `resolveSeam` returns undefined (not throw) for non-seam nodes; gate nodes keep the context-gate behavior but also support prompt/script-backed gates via `runCustomNode` with `gateMode` semantics.
**Test scenarios:** seam node → seam called; custom prompt node → runner called with node config; custom script node → runner; gate node with context expectation → pass/fail; gate node with prompt config → runner verdict drives outcome; unknown seam string → error.

### U2. WorkflowGraphTaskRunner (engine-agnostic orchestration)
**Goal:** A runner that loads a task's selected workflow IR, runs `WorkflowGraphExecutor` with injected seams + custom-node runner, and maps the terminal outcome to a lifecycle disposition (`completed` / `failed` / `fell-back`).
**Files:** `packages/engine/src/workflow-graph-task-runner.ts` (new), `packages/engine/src/__tests__/workflow-graph-task-runner.test.ts` (new).
**Approach:** Pure DI: `{ store, seams, runCustomNode, settings }`. Reads selection via `store.getTaskWorkflowSelection` + `getWorkflowDefinition`. Falls back (disposition `fell-back`) when flag off, no selection, or IR load fails. Audit events for start/terminal/fallback.
**Test scenarios:** full graph run order with fake seams (execute→review→merge sequencing via the builtin IR); custom pre-merge node runs between start and execute when authored that way; failure edge routes to end with `failed`; thrown seam error → `fell-back`; flag off → `fell-back`; gate failure blocks merge seam.

### U3. Real seam implementations (M-B)
**Goal:** `createEngineSeams(executor, projectEngine)` delegating to real engine entry points.
**Files:** `packages/engine/src/workflow-engine-seams.ts` (new), executor/project-engine narrow accessor methods as needed, `packages/engine/src/__tests__/workflow-engine-seams.test.ts`.
**Approach:** execute → the executor's implementation-phase entry for an already-claimed task; review → `reviewStep` path with verdict mapped to `outcome:*`; merge → enqueue on the auto-merge queue and await terminal merge outcome. Each seam returns `WorkflowNodeResult` with `value` carrying verdict/outcome tokens for edge conditions.
**Execution note:** characterization-first — capture the legacy call sequence for one task end-to-end before extracting accessors.

**Characterization findings (2026-06-03):**
- **Review seam is plug-and-play today.** `reviewStep(cwd, taskId, stepNumber, stepName, reviewType, promptContent, baseline?, options)` (`packages/engine/src/reviewer.ts:306`) is a standalone exported function returning `{verdict: APPROVE|REVISE|RETHINK|UNAVAILABLE, review, summary}`. Map verdict → `outcome:*` edge tokens.
- **Merge seam is plug-and-play today.** `ProjectEngine.onMerge(taskId)` (`packages/engine/src/project-engine.ts:934`) returns `Promise<MergeResult>` (resolver-based, not polling); `MergeResult.merged` → success/failure. `aiMergeTask` (`merger.ts:7425`) is the lower-level direct call. `autoMerge:false` terminal-until-merged is honored by the queue itself.
- **Execute seam needs surgery.** The implementation phase (agent session → `fn_task_done`) is embedded inside `TaskExecutor.execute` at `executor.ts:4243–4611`, intertwined with worktree/claim setup (3152–4242) and the post-completion workflow-steps/review-handoff block (4549+). Required: extract a narrow `runImplementationPhase(task, worktreePath, settings, env) → {taskDone, modifiedFiles, completionMarkup}` (or an `implementationPhaseOnly` mode flag on `execute`), stopping before `runWorkflowSteps`/`handoffTaskToReview`. **Do not compose the full legacy `execute()` as the execute seam — it already performs review handoff and triggers auto-merge, so the graph's review/merge seams would double-run.**
- **Wiring point:** `in-process-runtime.ts:493` constructs `TaskExecutor`; ProjectEngine references the executor (not vice versa) — the runtime is where `createEngineSeams({executor, projectEngine, store, rootDir})` gets built.
- **Test harness to mimic:** `packages/engine/src/__tests__/executor-worktree.test.ts` (mocked session via `executor-test-helpers.ts`).

### U4. Flag-gated entry point + fallback (M-C)
**Goal:** Graph-selected tasks route through the runner from `TaskExecutor.execute`; interpreter errors fall back to legacy mid-flight where safe, else fail the task through existing recovery.
**Files:** `packages/engine/src/executor.ts` (top-of-execute branch only), `packages/engine/src/__tests__/workflow-graph-entry.test.ts`.

### U5. Dual-observe parity on real runs + graduation (M-D)
**Goal:** Enable `workflowInterpreterDualObserve` for graph-selected tasks, record drift, fix until `{agree:true}` is sustained, then flip `workflowGraphExecutor` default for selected-workflow tasks.
**Files:** `packages/engine/src/workflow-parity-observer.ts` call-site wiring, settings default change, docs update.

---

## Risks

- **TaskExecutor.execute is ~3k lines of intertwined state.** Mitigation: U3 extracts *accessors*, never moves logic; U4 touches only a top-of-function branch; characterization tests first.
- **Self-healing/recovery assume the legacy shape.** Mitigation: KTD-3 fallback + parity observation before authority; recovery paths treat interpreter tasks as legacy until M-D.
- **Merge queue awaiting from inside a graph walk** could deadlock with the executor's own lifecycle. Mitigation: merge seam enqueues and resolves on the queue's completion callback (same contract the legacy handoff uses), never polls.

## Sources
Plan 001 (Deferred Track), `workflow-graph-executor.ts`, `workflow-node-handlers.ts`, `workflow-parity-observer.ts`, `docs/rfcs/FN-5719-decouple-executor-merger.md`, `docs/dag/adr-0001-dag-orchestration.md`, `docs/workflow-steps.md`.
