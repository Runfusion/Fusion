---
title: "S08: workflow-owned merge queue processing"
type: refactor
status: draft-stack-handoff
date: 2026-06-09
slice: S08
milestone: "Gate B"
origin: docs/plans/2026-06-09-003-refactor-workflow-owned-merge-full-migration-slices-plan.md
stack_base: feature/workflow-owned-merge-s07-completion-handoff-merge-work
---

# S08: workflow-owned merge queue processing

## Stack Role

This draft PR reserves the S08 review slot in the workflow-owned merge,
retry, scheduling, and recovery migration stack. It is intentionally a handoff
artifact, not the completed implementation for this slice.

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
