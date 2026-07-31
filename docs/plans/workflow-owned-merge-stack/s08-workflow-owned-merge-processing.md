---
title: "S08: workflow-owned merge queue processing"
type: refactor
status: not-started
measured_against: "main @ 46f35323c (2026-07-28)"
date: 2026-06-09
slice: S08
milestone: "Gate B"
origin: docs/plans/2026-06-09-003-refactor-workflow-owned-merge-full-migration-slices-plan.md
stack_base: feature/workflow-owned-merge-s07-completion-handoff-merge-work
---

# S08: workflow-owned merge queue processing

## Measured State (2026-07-28, U9 pre-flight)

`ProjectEngine.mergeQueue` + `drainMergeQueue` remain the live merge pump.

Status corrected from `draft-stack-handoff`, which was accurate when drafted on
2026-06-09 and is not now. See `docs/workflow-policy-ownership-map.md` →
"Measured Wiring State" for the whole-stack table.

## Stack Role

Not started. `ProjectEngine.mergeQueue` + `drainMergeQueue` remain the live merge
pump; this slot remains the plan of record for replacing them.

## Milestone

Gate B

## Depends On

S3 scheduler claim path, S6 merge capabilities, and S7 completion handoff.

## Goal

Process merge work items through workflow runtime instead of ProjectEngine's in-memory merge queue loop.

## Expected File Scope

packages/engine/src/project-engine.ts; packages/engine/src/scheduler.ts; packages/engine/src/merger.ts; packages/core/src/store.ts; merge lifecycle tests.

## Expected Tests

Serialized merge claim, successful finalize, transient retry, permanent conflict routing, duplicate lease blocking, hard cancel cancellation.

## Exit Gate

Production merge processing no longer depends on a hidden mergeQueue dequeue loop.

## Full Plan

See `docs/plans/2026-06-09-003-refactor-workflow-owned-merge-full-migration-slices-plan.md`.
