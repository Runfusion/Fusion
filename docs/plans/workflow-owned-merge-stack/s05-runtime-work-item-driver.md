---
title: "S05: runtime work-item driver"
type: refactor
status: landed-unwired
measured_against: "main @ 46f35323c (2026-07-28)"
date: 2026-06-09
slice: S05
milestone: "Runtime"
origin: docs/plans/2026-06-09-003-refactor-workflow-owned-merge-full-migration-slices-plan.md
stack_base: feature/workflow-owned-merge-s04-builtin-ir-regions
---

# S05: runtime work-item driver

## Measured State (2026-07-28, U9 pre-flight)

`WorkflowTaskRuntime.runWorkItem` and `processDueWorkflowWorkItem` are implemented; the processor is exported from `packages/engine/src/index.ts` and has **zero production callers**. The only live pump, `InProcessRuntime.drainWorkflowContinuations`, filters `kinds: ["task"]` and does not use this path.

Status corrected from `draft-stack-handoff`, which was accurate when drafted on
2026-06-09 and is not now. See `docs/workflow-policy-ownership-map.md` →
"Measured Wiring State" for the whole-stack table.

## Stack Role

This slot was drafted 2026-06-09 as a handoff artifact. It is **no longer**
only that — see the Measured State block above for what has actually landed.

## Milestone

Runtime

## Depends On

S1 workflow work items, S3 generic scheduler claim path, and S4 built-in IR regions.

## Goal

Let WorkflowTaskRuntime start from a workflow work item and persist node/work-item outcomes.

## Expected File Scope

packages/engine/src/workflow-task-runtime.ts; workflow graph executor and node handler files; runtime tests.

## Expected Tests

Runnable completion, retrying work creation, manual hold creation, restart resume, and duplicate lease refusal.

## Exit Gate

Runtime can progress workflow work without old merge queue callbacks.

## Full Plan

See `docs/plans/2026-06-09-003-refactor-workflow-owned-merge-full-migration-slices-plan.md`.
