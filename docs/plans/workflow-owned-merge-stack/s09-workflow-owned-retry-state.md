---
title: "S09: workflow-owned retry state"
type: refactor
status: draft-stack-handoff
date: 2026-06-09
slice: S09
milestone: "Retry"
origin: docs/plans/2026-06-09-003-refactor-workflow-owned-merge-full-migration-slices-plan.md
stack_base: feature/workflow-owned-merge-s08-workflow-owned-merge-processing
---

# S09: workflow-owned retry state

## Stack Role

This draft PR reserves the S09 review slot in the workflow-owned merge,
retry, scheduling, and recovery migration stack. It is intentionally a handoff
artifact, not the completed implementation for this slice.

## Milestone

Retry

## Depends On

S5 runtime driver and S8 workflow-owned merge processing.

## Goal

Move retry attempts, budgets, backoff, retry-after, exhaustion, and manual retry reset into workflow node/work-item state.

## Expected File Scope

workflow graph executor, node handlers, retry/backoff helpers, retry summary/manual retry files, retry policy tests.

## Expected Tests

Implementation retry budget, merge retry isolation, due-time persistence, exhaustion routing, targeted manual retry clear, restart persistence.

## Exit Gate

No retry branch is controlled solely by task counters.

## Full Plan

See `docs/plans/2026-06-09-003-refactor-workflow-owned-merge-full-migration-slices-plan.md`.
