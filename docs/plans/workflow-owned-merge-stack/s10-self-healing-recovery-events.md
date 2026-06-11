---
title: "S10: self-healing recovery events"
type: refactor
status: draft-stack-handoff
date: 2026-06-09
slice: S10
milestone: "Gate C"
origin: docs/plans/2026-06-09-003-refactor-workflow-owned-merge-full-migration-slices-plan.md
stack_base: feature/workflow-owned-merge-s09-workflow-owned-retry-state
---

# S10: self-healing recovery events

## Stack Role

This draft PR reserves the S10 review slot in the workflow-owned merge,
retry, scheduling, and recovery migration stack. It is intentionally a handoff
artifact, not the completed implementation for this slice.

## Milestone

Gate C

## Depends On

S5 runtime driver, S8 merge processing, and S9 retry state.

## Goal

Convert self-healing merge/retry lifecycle mutations into typed workflow recovery events and node wakes.

## Expected File Scope

packages/engine/src/self-healing.ts; restart recovery coordinator; recovery policy; workflow runtime; recovery tests.

## Expected Tests

Mergeable in-review recovery event, stale merge status event, transient merge retry event, already-landed finalize event, autoMerge false terminal behavior, dedupe.

## Exit Gate

Self-healing no longer directly requeues, pauses, fails, unpauses, or moves merge/retry tasks except through guarded workflow primitives.

## Full Plan

See `docs/plans/2026-06-09-003-refactor-workflow-owned-merge-full-migration-slices-plan.md`.
