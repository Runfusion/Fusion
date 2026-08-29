---
title: "S02: merge request projection onto work items"
type: refactor
status: landed-unwired
measured_against: "main @ 46f35323c (2026-07-28)"
date: 2026-06-09
slice: S02
milestone: "Foundation"
origin: docs/plans/2026-06-09-003-refactor-workflow-owned-merge-full-migration-slices-plan.md
stack_base: feature/workflow-owned-merge-retry-scheduling-plan
---

# S02: merge request projection onto work items

## Measured State (2026-07-28, U9 pre-flight)

`projectMergeRequestToWorkflowWorkItem` is implemented in `packages/core/src/task-store/workflow-workitems-ops.ts` and has **zero production callers**. The projection exists; nothing invokes it.

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

Project existing merge request records into workflow work-item state so dashboards and schedulers can dual-read before cutover.

## Expected File Scope

packages/core/src/store.ts; packages/core/src/task-merge.ts; packages/core/src/types.ts; merge-request and dual-observe tests.

## Expected Tests

Projection tests for queued/running/retrying/manual-required/succeeded/exhausted states, hard cancel cancellation, and restart idempotency.

## Exit Gate

Every merge request state has a lossless workflow work-item equivalent.

## Full Plan

See `docs/plans/2026-06-09-003-refactor-workflow-owned-merge-full-migration-slices-plan.md`.
