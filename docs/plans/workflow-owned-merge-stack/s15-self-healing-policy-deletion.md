---
title: "S15: self-healing policy deletion"
type: refactor
status: draft-stack-handoff
date: 2026-06-09
slice: S15
milestone: "Deletion"
origin: docs/plans/2026-06-09-003-refactor-workflow-owned-merge-full-migration-slices-plan.md
stack_base: feature/workflow-owned-merge-s14-project-engine-merge-queue-deletion
---

# S15: self-healing policy deletion

## Stack Role

This draft PR reserves the S15 review slot in the workflow-owned merge,
retry, scheduling, and recovery migration stack. It is intentionally a handoff
artifact, not the completed implementation for this slice.

## Milestone

Deletion

## Depends On

S10 recovery events, S11 branch-group subgraphs, and S14 merge queue deletion.

## Goal

Delete self-healing direct lifecycle mutations for merge/retry tasks after recovery events cover all cases.

## Expected File Scope

packages/engine/src/self-healing.ts; self-healing audit docs; recovery event and deletion tests.

## Expected Tests

Direct move/pause/requeue/retry-reset patterns absent for merge/retry surfaces, valid held states no-op, recovery facts include audit context.

## Exit Gate

Search tests fail on direct self-healing merge/retry lifecycle mutation patterns.

## Full Plan

See `docs/plans/2026-06-09-003-refactor-workflow-owned-merge-full-migration-slices-plan.md`.
