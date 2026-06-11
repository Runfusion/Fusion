---
title: "S18: documentation settings and release notes"
type: refactor
status: draft-stack-handoff
date: 2026-06-09
slice: S18
milestone: "Release"
origin: docs/plans/2026-06-09-003-refactor-workflow-owned-merge-full-migration-slices-plan.md
stack_base: feature/workflow-owned-merge-s17-cutover-matrix
---

# S18: documentation settings and release notes

## Stack Role

This draft PR reserves the S18 review slot in the workflow-owned merge,
retry, scheduling, and recovery migration stack. It is intentionally a handoff
artifact, not the completed implementation for this slice.

## Milestone

Release

## Depends On

S17 end-to-end cutover matrix.

## Goal

Update architecture, settings, dashboard, CLI, and testing docs for workflow-owned policy and compatibility projections.

## Expected File Scope

docs/architecture.md; docs/workflow-steps.md; docs/dashboard-guide.md; docs/settings-reference.md; docs/testing.md; CONCEPTS.md; changeset.

## Expected Tests

Docs inventory/search tests where applicable; lazy view inventory unchanged unless dashboard imports change.

## Exit Gate

User-facing docs use the same state names as API/UI tests, and a patch changeset exists if published behavior changed.

## Full Plan

See `docs/plans/2026-06-09-003-refactor-workflow-owned-merge-full-migration-slices-plan.md`.
