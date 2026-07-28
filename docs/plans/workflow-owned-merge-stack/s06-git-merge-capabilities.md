---
title: "S06: git and merge capability extraction"
type: refactor
status: not-started
measured_against: "main @ 46f35323c (2026-07-28)"
date: 2026-06-09
slice: S06
milestone: "Runtime"
origin: docs/plans/2026-06-09-003-refactor-workflow-owned-merge-full-migration-slices-plan.md
stack_base: feature/workflow-owned-merge-s05-runtime-work-item-driver
---

# S06: git and merge capability extraction

## Measured State (2026-07-28, U9 pre-flight)

Merge still runs through `packages/engine/src/merger.ts` (11,273 lines). `workflow-merge-nodes.ts` is a 76-line shim over the `requestMerge` primitive, not the capability extraction this slice describes.

Status corrected from `draft-stack-handoff`, which was accurate when drafted on
2026-06-09 and is not now. See `docs/workflow-policy-ownership-map.md` →
"Measured Wiring State" for the whole-stack table.

## Stack Role

Not started. Merge still runs through `merger.ts`; this slot remains the plan of
record for extracting those procedures into workflow node capabilities.

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
