---
title: "S07: completion handoff creates merge work"
type: refactor
status: not-started
measured_against: "main @ 46f35323c (2026-07-28)"
date: 2026-06-09
slice: S07
milestone: "Runtime"
origin: docs/plans/2026-06-09-003-refactor-workflow-owned-merge-full-migration-slices-plan.md
stack_base: feature/workflow-owned-merge-s06-git-merge-capabilities
---

# S07: completion handoff creates merge work

## Measured State (2026-07-28, U9 pre-flight)

**Ordering constraint (corrected 2026-07-28 after PR #2504 review).** The writer already exists: `createCompletionHandoffWorkflowWork` writes `merge`/`manual-hold` items from the live handoff-to-review path, and nothing claims or reconciles them, so they accumulate non-terminal today. That is benign — the legacy `ProjectEngine.mergeQueue` still drives the actual merge. What this slice changes is making those items **authoritative**. Landing it before S03/S05 are driven converts a benign row leak into cards that reach the merge boundary and stop. S07 must not land before S03/S05 are driven, and the pre-existing unclaimed rows need a reconcile/backfill decision as part of this slice.

Status corrected from `draft-stack-handoff`, which was accurate when drafted on
2026-06-09 and is not now. See `docs/workflow-policy-ownership-map.md` →
"Measured Wiring State" for the whole-stack table.

## Stack Role

Not started, and gated on S03/S05 actually being driven — see the corrected
ordering constraint above. This slot remains the plan of record.

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
