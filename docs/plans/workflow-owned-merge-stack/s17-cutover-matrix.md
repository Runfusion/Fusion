---
title: "S17: end-to-end cutover matrix"
type: refactor
status: draft-stack-handoff
date: 2026-06-09
slice: S17
milestone: "Gate E"
origin: docs/plans/2026-06-09-003-refactor-workflow-owned-merge-full-migration-slices-plan.md
stack_base: feature/workflow-owned-merge-s16-legacy-retry-field-demotion
---

# S17: end-to-end cutover matrix

## Stack Role

This draft PR reserves the S17 review slot in the workflow-owned merge,
retry, scheduling, and recovery migration stack. It is intentionally a handoff
artifact, not the completed implementation for this slice.

## Milestone

Gate E

## Depends On

S13 scheduler deletion, S14 merge queue deletion, S15 self-healing deletion, and S16 retry field demotion.

## Goal

Prove the full workflow-owned invariant across all known production surfaces before removing dual-read compatibility.

## Expected File Scope

engine reliability tests, core store tests, dashboard projection tests, docs/testing.md.

## Expected Tests

Default coding, stepwise coding, custom workflow, PR workflow, plugin workflow extension, autoMerge false, manual retry, hard cancel, restart during merge, transient/permanent merge failures, branch groups, stale recovery, already-landed finalization, dashboard and CLI projections.

## Exit Gate

Gate, lint, build, and targeted matrix suites pass with no old engine merge/retry/scheduling policy path racing workflow runtime.

## Full Plan

See `docs/plans/2026-06-09-003-refactor-workflow-owned-merge-full-migration-slices-plan.md`.
