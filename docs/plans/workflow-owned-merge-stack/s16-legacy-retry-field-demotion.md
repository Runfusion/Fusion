---
title: "S16: legacy retry field demotion"
type: refactor
status: draft-stack-handoff
date: 2026-06-09
slice: S16
milestone: "Deletion"
origin: docs/plans/2026-06-09-003-refactor-workflow-owned-merge-full-migration-slices-plan.md
stack_base: feature/workflow-owned-merge-s15-self-healing-policy-deletion
---

# S16: legacy retry field demotion

## Stack Role

This draft PR reserves the S16 review slot in the workflow-owned merge,
retry, scheduling, and recovery migration stack. It is intentionally a handoff
artifact, not the completed implementation for this slice.

## Milestone

Deletion

## Depends On

S9 retry state, S12 projections, and S15 self-healing policy deletion.

## Goal

Demote task-level retry/merge counters to projections and remove policy reads that still treat them as authority.

## Expected File Scope

core types, retry summary, manual retry reset, core store, project engine, self-healing, retry tests.

## Expected Tests

Retry summaries derive from workflow state, manual retry emits workflow wake, task field changes alone cannot cause scheduler/recovery/merge action.

## Exit Gate

Task retry fields are display-only compatibility data.

## Full Plan

See `docs/plans/2026-06-09-003-refactor-workflow-owned-merge-full-migration-slices-plan.md`.
