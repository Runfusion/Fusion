---
title: "Workflow-native execution through runtime primitives"
date: 2026-06-09
category: architecture-patterns
module: engine
problem_type: architecture_pattern
component: tooling
severity: high
applies_when:
  - "A workflow graph claims lifecycle authority but nodes still call back into legacy orchestration"
  - "Built-in workflows need to express default engine behavior without hidden executor branches"
  - "Recovery, review, merge, or planning policy is split between workflow IR and imperative runtime code"
  - "A graph runtime needs side effects without giving nodes direct access to scheduler or executor internals"
tags: [workflow-runtime, runtime-primitives, builtin-workflows, graph-executor, recovery-policy, engine-boundary]
related:
  - docs/plans/2026-06-09-001-refactor-big-bang-workflow-native-execution-plan.md
  - docs/solutions/architecture-patterns/per-entity-execution-principal-override-blast-radius.md
---

# Workflow-native execution through runtime primitives

## Context

The workflow graph executor already modeled task sequencing, but default task execution still depended on `WorkflowLegacySeams` that called back into `TaskExecutor.execute()`, review handoff, merge queue requests, and step-review helpers. That left two control planes: workflow IR described the lifecycle, while imperative code in the engine still decided large pieces of planning, execution, review, merge, and recovery.

The cutover in PR #1536 introduced a typed runtime primitive boundary and primitive-backed node handlers. The engine still owns substrate concerns, but built-in workflows and node handlers now own lifecycle policy.

Session history search: no relevant prior sessions were found for this specific workflow-runtime primitive cutover topic.

## Guidance

Use a **workflow policy / runtime primitive / engine substrate** split when moving lifecycle behavior into workflows.

**Workflow policy** lives in IR and node routing:

- the selected or built-in workflow defines node order and recovery branches;
- built-in lifecycle nodes express default behavior such as planning, execute, review, merge, parse-steps, step-review, and PR lifecycle;
- edge outcomes carry decisions like success, failure, revise, rethink, unavailable, manual-required, merge-timeout, or recovery routing.

**Runtime primitives** are the only side-effect boundary nodes call:

```ts
export interface WorkflowRuntimePrimitives {
  prepareWorktree(ctx, task): Promise<RuntimePrimitiveResult<PreparedWorktree>>;
  runPlanningSession(ctx, task): Promise<RuntimePrimitiveResult<PlanningSessionResult>>;
  runCodingSession(ctx, task, prepared): Promise<RuntimePrimitiveResult<CodingSessionResult>>;
  runTaskStep(ctx, task, stepIndex): Promise<RunTaskStepResult>;
  resetTaskStep(ctx, task, stepIndex, baselineSha?, checkpointId?): Promise<ResetStepResult>;
  runReview(ctx, task, input): Promise<RuntimePrimitiveResult<ReviewPrimitiveResult>>;
  requestMerge(ctx, task, input?): Promise<RuntimePrimitiveResult<MergePrimitiveResult>>;
  transitionTask(ctx, task, input): Promise<RuntimePrimitiveResult>;
  abortRun(ctx, task, input): Promise<RuntimePrimitiveResult>;
  audit(ctx, input): Promise<void> | void;
}
```

Every primitive receives a workflow run context and node context, so audit, side-effect boundaries, effective principal, retry attempt, and recovery event identity do not have to be inferred from the mutable task row.

**Engine substrate** remains centralized:

- scheduler dispatch and routing claims;
- local vs remote node routing;
- persistence adapters and workflow run state;
- concurrency/semaphore control;
- process supervision and abort mechanics;
- storage access and audit/log sinks;
- non-bypassable guards such as file scope, worktree ownership, branch-group merge targets, and transition validation.

In code, the graph executor should prefer primitive handlers when primitives are supplied:

```ts
const promptLike = deps?.primitives
  ? createPrimitivePromptLikeHandler(deps.primitives, runCustomNode)
  : createPromptLikeHandler(seams, runCustomNode);
```

Keep legacy seam adapters only as a compatibility wrapper for older tests or transitional callers. Do not let the production workflow path re-enter a monolithic executor lifecycle after a workflow run starts.

## Why This Matters

The primitive boundary prevents graph nodes from becoming thin aliases for old orchestration. A workflow can decide *what happens next* while the engine still provides safe, centralized mechanics for *how a side effect happens*.

This avoids several failure modes:

- a graph node starts side effects, throws, and then the old executor reruns the same lifecycle;
- built-in workflows drift from hidden imperative branches;
- recovery sweeps mutate task lifecycle directly instead of waking/routing workflow recovery;
- effective principal, audit, or side-effect identity is reconstructed differently in each subsystem;
- tests prove graph traversal but miss the actual task lifecycle path.

The cutover also exposed a useful testing boundary: old minimal executor-core fakes did not implement workflow-selection APIs. Those fakes should stay on the legacy characterization path unless the graph flag is explicitly enabled, while real workflow-aware stores can default unselected tasks to `builtin:coding`.

## When to Apply

- Converting an imperative task lifecycle into a graph/workflow runtime.
- Adding a built-in workflow that is supposed to be the compatibility contract for existing behavior.
- Moving recovery out of sweeps or background repair code and into routable workflow behavior.
- Introducing a side-effecting node kind that needs git, agents, review, merge, task transitions, or audit.
- Reviewing graph runtime changes where a node still calls a large executor method instead of a named primitive.

## Examples

### Built-in workflow owns the compatibility path

Before the cutover, `builtin:coding` started at execute:

```text
start -> execute -> review -> merge -> end
```

After the cutover, planning and pre-merge workflow steps are explicit:

```text
start -> planning -> execute -> workflow-step -> review -> merge -> end
```

The workflow compiler also treats `planning` and `workflow-step` as seam anchors in the canonical lifecycle order, so built-in graph shape and compile-time compatibility stay aligned.

### Graph routing owns workflow-aware tasks first

The production executor gives graph routing first claim for workflow-aware stores. It pins `workflowGraphExecutor` for the run, synthesizes `builtin:coding` for unselected tasks, and parks interpreter failures as workflow failures instead of falling through to legacy execution.

Minimal old test fakes without workflow-selection support still fall through unless they explicitly enable the graph flag. This keeps characterization tests useful without weakening the production boundary.

### Primitive-backed node handlers preserve routing semantics

Primitive handlers map old seam names to explicit operations:

- `planning` -> `runPlanningSession`
- `execute` -> `prepareWorktree` then `runCodingSession`
- `workflow-step` -> `runWorkflowStep`
- `review` -> `runReview`
- `merge` -> `requestMerge`
- `step-execute` -> `runTaskStep`
- `step-review` -> `runReview` with step index and bounded unavailable retry

The node still returns graph-native `{ outcome, value, contextPatch }`, so edge routing remains workflow-owned.

## Related

- `docs/workflow-steps.md` now documents the workflow runtime as authoritative and describes primitives as the side-effect boundary.
- `CONCEPTS.md` defines Workflow Runtime, Runtime Primitive, Built-in Lifecycle Node, and Recovery Event.
- `docs/solutions/architecture-patterns/per-entity-execution-principal-override-blast-radius.md` covers the adjacent identity/principal blast-radius checklist for workflow nodes.
