---
title: "S03: generic scheduler claim path"
type: refactor
status: landed-unwired
measured_against: "main @ 46f35323c (2026-07-28)"
date: 2026-06-09
slice: S03
milestone: "Foundation"
origin: docs/plans/2026-06-09-003-refactor-workflow-owned-merge-full-migration-slices-plan.md
stack_base: feature/workflow-owned-merge-s02-merge-request-projection
---

# S03: generic scheduler claim path

## Measured State (2026-07-28, U9 pre-flight)

`claimDueWorkflowWorkItem` is implemented in `packages/engine/src/workflow-work-scheduler.ts` and wired into `workflow-work-processor.ts` — but that processor has **zero production callers**, so the claim path never runs.

Status corrected from `draft-stack-handoff`, which was accurate when drafted on
2026-06-09 and is not now. See `docs/workflow-policy-ownership-map.md` →
"Measured Wiring State" for the whole-stack table.

## Stack Role

This slot was drafted 2026-06-09 as a handoff artifact. It is **no longer**
only that — see the Measured State block above for what has actually landed.

## Milestone

Foundation

## Depends On

S1 workflow work-item schema and store API.

## Goal

Teach Scheduler to claim due workflow work items while preserving existing task dispatch behavior.

## Expected File Scope

packages/engine/src/scheduler.ts; packages/engine/src/workflow-task-runtime.ts; packages/engine/src/project-engine.ts; scheduler/workflow dispatch tests.

## Expected Tests

Due-work claiming, retryAfter delay, capacity holds, user pause exclusion, stale lease reclaim, and remote dispatch.

## Exit Gate

A workflow work item can be dispatched end to end in tests without constructing a merge queue branch.

## Full Plan

See `docs/plans/2026-06-09-003-refactor-workflow-owned-merge-full-migration-slices-plan.md`.
