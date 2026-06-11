---
title: "S03: generic scheduler claim path"
type: refactor
status: draft-stack-handoff
date: 2026-06-09
slice: S03
milestone: "Foundation"
origin: docs/plans/2026-06-09-003-refactor-workflow-owned-merge-full-migration-slices-plan.md
stack_base: feature/workflow-owned-merge-s02-merge-request-projection
---

# S03: generic scheduler claim path

## Stack Role

This draft PR reserves the S03 review slot in the workflow-owned merge,
retry, scheduling, and recovery migration stack. It is intentionally a handoff
artifact, not the completed implementation for this slice.

## Milestone

Foundation

## Depends On

S1 workflow work-item schema and store API.

## Goal

Teach Scheduler to claim due workflow work items while preserving existing task dispatch behavior.

## Expected File Scope

packages/engine/src/scheduler.ts; packages/engine/src/workflow-task-runtime.ts; packages/engine/src/project-engine.ts; scheduler/workflow dispatch tests.

## Expected Tests

Due-work claiming, retryAfter delay, capacity holds, user pause exclusion, stale lease reclaim, and remote dispatch.

## Exit Gate

A workflow work item can be dispatched end to end in tests without constructing a merge queue branch.

## Full Plan

See `docs/plans/2026-06-09-003-refactor-workflow-owned-merge-full-migration-slices-plan.md`.
