---
title: "S13: scheduler policy deletion"
type: refactor
status: draft-stack-handoff
date: 2026-06-09
slice: S13
milestone: "Deletion"
origin: docs/plans/2026-06-09-003-refactor-workflow-owned-merge-full-migration-slices-plan.md
stack_base: feature/workflow-owned-merge-s12-workflow-projections
---

# S13: scheduler policy deletion

## Stack Role

This draft PR reserves the S13 review slot in the workflow-owned merge,
retry, scheduling, and recovery migration stack. It is intentionally a handoff
artifact, not the completed implementation for this slice.

## Milestone

Deletion

## Depends On

S3 scheduler claim path, S7 handoff, S8 merge processing, and S12 projections.

## Goal

Delete scheduler branches that infer lifecycle, merge eligibility, retry routing, or in-review dependency behavior from task columns.

## Expected File Scope

packages/engine/src/scheduler.ts; packages/core/src/task-merge.ts; scheduler deletion tests.

## Expected Tests

Dependency satisfaction cannot rely on in-review alone, retry due time from work item, overlap leases from workflow work, PR monitor remains substrate.

## Exit Gate

Search/structure tests fail if scheduler reintroduces task-column merge/retry policy.

## Full Plan

See `docs/plans/2026-06-09-003-refactor-workflow-owned-merge-full-migration-slices-plan.md`.
