---
title: "S11: branch group workflow subgraphs"
type: refactor
status: draft-stack-handoff
date: 2026-06-09
slice: S11
milestone: "Branch Groups"
origin: docs/plans/2026-06-09-003-refactor-workflow-owned-merge-full-migration-slices-plan.md
stack_base: feature/workflow-owned-merge-s10-self-healing-recovery-events
---

# S11: branch group workflow subgraphs

## Stack Role

This draft PR reserves the S11 review slot in the workflow-owned merge,
retry, scheduling, and recovery migration stack. It is intentionally a handoff
artifact, not the completed implementation for this slice.

## Milestone

Branch Groups

## Depends On

S6 merge capabilities, S8 merge processing, and S10 recovery events.

## Goal

Move branch-group member integration and group promotion into workflow-owned merge subgraphs.

## Expected File Scope

group merge coordinator, merge trait, integration worktree, built-in IR, shared branch-group workflow tests.

## Expected Tests

Member integration with autoMerge exception, blocked group promotion, conflict routing, final promotion guards.

## Exit Gate

Branch-group coordinator no longer owns task lifecycle independent of workflow runtime.

## Full Plan

See `docs/plans/2026-06-09-003-refactor-workflow-owned-merge-full-migration-slices-plan.md`.
