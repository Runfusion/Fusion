---
title: "S12: dashboard API CLI workflow projection"
type: refactor
status: draft-stack-handoff
date: 2026-06-09
slice: S12
milestone: "Gate D"
origin: docs/plans/2026-06-09-003-refactor-workflow-owned-merge-full-migration-slices-plan.md
stack_base: feature/workflow-owned-merge-s11-branch-group-subgraphs
---

# S12: dashboard API CLI workflow projection

## Stack Role

This draft PR reserves the S12 review slot in the workflow-owned merge,
retry, scheduling, and recovery migration stack. It is intentionally a handoff
artifact, not the completed implementation for this slice.

## Milestone

Gate D

## Depends On

S1/S2 state foundations, S7 merge work handoff, S9 retry state, and S10 recovery events.

## Goal

Surface workflow-native queued, retrying, merging, manual-hold, failed, stalled, and recovered reasons across inspection surfaces.

## Expected File Scope

dashboard TaskCard/detail/API/CLI output files, retry summary, task merge projection files, dashboard/API tests.

## Expected Tests

Workflow-first merge queued, retry due time, manual hold, recovery reason, stale badge hiding, branch-group target identity.

## Exit Gate

UI/API/CLI tests prove workflow state is the first projection source.

## Full Plan

See `docs/plans/2026-06-09-003-refactor-workflow-owned-merge-full-migration-slices-plan.md`.
