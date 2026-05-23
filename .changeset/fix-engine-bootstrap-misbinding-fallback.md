---
"@fusion/engine": patch
---

fix(engine): un-deadcode the bootstrap-misbinding auto-recovery fallback

The auto-recovery handler in `auto-recovery-handlers/branch-worktree.ts`
called `classifyBootstrapMisbinding` with `foreignCommits: []` because it
had no `BranchCrossContaminationError` in hand (it discovers the conflict
via `inspectBranchConflict`). The classifier's predicate gated on
`foreignCommits.length > 0`, so the input always resolved to
`isBootstrapMisbinding: false` and the re-anchor block was effectively
dead code.

The handler also used `ctx.task.baseCommitSha` as the contamination base,
which is deliberately preserved across sessions for diff math (FN-4417)
and can lag local `main` by many commits — causing legitimately-merged
landings to be classified as foreign at this layer.

Changes:
- `classifyBootstrapMisbinding` now derives the foreign-commit count from
  its own `git log baseSha..branchName` walk; `input.foreignCommits` is
  optional and advisory only. The result type gains `foreignCommitCount`.
- The `branch-worktree` recovery handler stops passing an empty array and
  computes a fresh merge-base against local `main` (falling back to
  `origin/main`), mirroring the executor's primary contamination path.
- Regression tests cover both the no-`foreignCommits` call shape and the
  `foreignCommitCount` field.
