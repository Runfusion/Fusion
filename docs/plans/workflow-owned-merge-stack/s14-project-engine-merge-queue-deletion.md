---
title: "S14: ProjectEngine merge queue deletion"
type: refactor
status: draft-stack-handoff
date: 2026-06-09
slice: S14
milestone: "Deletion"
origin: docs/plans/2026-06-09-003-refactor-workflow-owned-merge-full-migration-slices-plan.md
stack_base: feature/workflow-owned-merge-s13-scheduler-policy-deletion
---

# S14: ProjectEngine merge queue deletion

## Stack Role

This draft PR reserves the S14 review slot in the workflow-owned merge,
retry, scheduling, and recovery migration stack. It is intentionally a handoff
artifact, not the completed implementation for this slice.

## Milestone

Deletion

## Depends On

S8 merge processing, S11 branch-group subgraphs, and S13 scheduler deletion.

## Goal

Remove production ProjectEngine merge queue policy and retain only explicit human/manual event entry points plus substrate helpers.

## Expected File Scope

packages/engine/src/project-engine.ts; runtimes/in-process runtime; core store; merge lifecycle and deletion tests.

## Expected Tests

No startup hidden enqueue, unpause wakes workflow work, manual merge event wakes merge node, stale mergeActive does not block workflow work, old queue APIs compatibility-only.

## Exit Gate

No production caller starts merge processing outside workflow runtime.

## Full Plan

See `docs/plans/2026-06-09-003-refactor-workflow-owned-merge-full-migration-slices-plan.md`.
