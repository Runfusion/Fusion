---
title: "S05: runtime work-item driver"
type: refactor
status: draft-stack-handoff
date: 2026-06-09
slice: S05
milestone: "Runtime"
origin: docs/plans/2026-06-09-003-refactor-workflow-owned-merge-full-migration-slices-plan.md
stack_base: feature/workflow-owned-merge-s04-builtin-ir-regions
---

# S05: runtime work-item driver

## Stack Role

This draft PR reserves the S05 review slot in the workflow-owned merge,
retry, scheduling, and recovery migration stack. It is intentionally a handoff
artifact, not the completed implementation for this slice.

## Milestone

Runtime

## Depends On

S1 workflow work items, S3 generic scheduler claim path, and S4 built-in IR regions.

## Goal

Let WorkflowTaskRuntime start from a workflow work item and persist node/work-item outcomes.

## Expected File Scope

packages/engine/src/workflow-task-runtime.ts; workflow graph executor and node handler files; runtime tests.

## Expected Tests

Runnable completion, retrying work creation, manual hold creation, restart resume, and duplicate lease refusal.

## Exit Gate

Runtime can progress workflow work without old merge queue callbacks.

## Full Plan

See `docs/plans/2026-06-09-003-refactor-workflow-owned-merge-full-migration-slices-plan.md`.
