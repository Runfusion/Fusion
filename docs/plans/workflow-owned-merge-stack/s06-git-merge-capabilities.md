---
title: "S06: git and merge capability extraction"
type: refactor
status: draft-stack-handoff
date: 2026-06-09
slice: S06
milestone: "Runtime"
origin: docs/plans/2026-06-09-003-refactor-workflow-owned-merge-full-migration-slices-plan.md
stack_base: feature/workflow-owned-merge-s05-runtime-work-item-driver
---

# S06: git and merge capability extraction

## Stack Role

This draft PR reserves the S06 review slot in the workflow-owned merge,
retry, scheduling, and recovery migration stack. It is intentionally a handoff
artifact, not the completed implementation for this slice.

## Milestone

Runtime

## Depends On

S4 built-in IR regions and S5 runtime work-item driver.

## Goal

Put checkout preparation, branch integration, merge attempt, squash, finalize, and conflict classification behind workflow node capability modules.

## Expected File Scope

packages/engine/src/merger*.ts; packages/engine/src/workflow-merge-nodes.ts; merge capability tests.

## Expected Tests

Checkout preparation, file-scope failure, already-on-main finalize, transient retry, permanent conflict routing, and guard-service coverage.

## Exit Gate

A merge attempt can be driven by a workflow node capability with the same guard behavior as merger.ts.

## Full Plan

See `docs/plans/2026-06-09-003-refactor-workflow-owned-merge-full-migration-slices-plan.md`.
