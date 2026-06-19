---
title: "S07: completion handoff creates merge work"
type: refactor
status: draft-stack-handoff
date: 2026-06-09
slice: S07
milestone: "Runtime"
origin: docs/plans/2026-06-09-003-refactor-workflow-owned-merge-full-migration-slices-plan.md
stack_base: feature/workflow-owned-merge-s06-git-merge-capabilities
---

# S07: completion handoff creates merge work

## Stack Role

This draft PR reserves the S07 review slot in the workflow-owned merge,
retry, scheduling, and recovery migration stack. It is intentionally a handoff
artifact, not the completed implementation for this slice.

## Milestone

Runtime

## Depends On

S2 projection, S5 runtime driver, and S6 merge capabilities.

## Goal

Replace task-moved in-review auto-enqueue as policy authority with workflow completion handoff creating merge work.

## Expected File Scope

packages/engine/src/project-engine.ts; packages/engine/src/merger.ts; packages/core/src/store.ts; completion and cutover tests.

## Expected Tests

Coding completion creates merge work, autoMerge false creates manual hold, duplicate handoff idempotency, soft-delete cancellation, startup projection dedupe.

## Exit Gate

New task completions produce workflow merge work before old queue processing runs.

## Full Plan

See `docs/plans/2026-06-09-003-refactor-workflow-owned-merge-full-migration-slices-plan.md`.
