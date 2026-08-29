---
title: "chore: Workflow-owned merge stacked PR creation"
type: chore
status: active
date: 2026-06-09
depth: shallow
origin: docs/plans/2026-06-09-003-refactor-workflow-owned-merge-full-migration-slices-plan.md
---

# chore: Workflow-owned merge stacked PR creation

## Summary

Create a linear GitHub PR stack for the remaining workflow-owned merge,
retry, scheduling, recovery, projection, deletion, and release slices. The stack
does not claim future implementation is complete. Each PR carries a durable
slice handoff document and is opened as a draft against the previous slice
branch so reviewers can see ordering, dependency, and milestone intent.

## Requirements Trace

- R1. Every migration slice S0-S18 from the origin plan is represented in the
  PR stack.
- R2. Existing PR #1571 remains the stack base for S0/S1.
- R3. Remaining slices S2-S18 each receive a dedicated branch and draft PR.
- R4. Each branch has a non-empty, reviewable diff that records the slice goal,
  milestone, dependencies, file scope, tests, and exit gate.
- R5. PR bodies link back to the full migration plan and identify their base
  branch so the stack is reconstructible.

## Scope

In scope:

- Add `docs/plans/workflow-owned-merge-stack/sXX-*.md` handoff files.
- Create and push one branch per remaining slice.
- Open draft PRs stacked linearly from S2 through S18.
- Update PR #1571 with the complete slice/milestone list when needed.

Out of scope:

- Implementing S2-S18 code changes in this turn.
- Merging the stack.
- Rewriting existing PR #1571 commits.

## Stack Shape

- S0/S1: existing PR #1571, branch
  `feature/workflow-owned-merge-retry-scheduling-plan`, base `main`.
- S2: base S0/S1 branch.
- S3-S18: each branch is based on the immediately preceding slice branch.

This is intentionally linear even though the origin dependency graph has some
parallelizable edges. A linear stack gives GitHub a straightforward review and
landing path; implementation branches can still be split or rebased later if a
slice needs to move independently.

## Verification

- `git status --short --branch` is clean after all branches are pushed.
- `gh pr view` succeeds for each created PR.
- Every created PR body includes the slice number, milestone, dependency, full
  plan link, and base branch.
- `gh pr checks` is inspected for the current stack base and any newly opened
  PR checks that are immediately available.
