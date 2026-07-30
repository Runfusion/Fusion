---
category: workflow-learnings
module: scripts/lifecycle-column-census
tags: [fleet, batch, census, git, rebase]
problem_type: process-hazard
applies_when: keeping a long-lived shared batch branch current with main
---

# Mega-batch branches: MERGE main in, do not rebase onto it

Recorded 2026-07-30 from `batch-dashboard-app` (~25 commits, two workers pushing). Written for the
other three batch owners, who will hit the identical thing.

## The trap

`scripts/lib/lifecycle-column-census-baseline.json` is **rewritten by every `--strict` run**, not
only by `--update-baseline` — that is the deliberate self-lowering ratchet. So on a batch branch,
nearly every commit touches it.

Rebasing a 25-commit branch onto a moved main therefore replays 25 commits and re-conflicts on that
one file at **each** step. Worse, once a few steps have resolved differently, commits inside the
branch start conflicting *with each other* on real source files — I hit a `DockTaskList.tsx` conflict
between two batch commits that had never conflicted when they were written.

Two full rebase attempts produced repeated conflicts and no progress.

## What works

```bash
# The repo's standing rule: branch work happens in a worktree; the primary checkout stays on main.
wt switch --create batch-sync            # or: git worktree add -b batch-sync ../kb-worktrees/batch-sync main
cd ../kb-worktrees/batch-sync            # (skip both if you are ALREADY in a worktree for this branch)

git fetch origin && git reset --hard origin/<batch-branch>
git merge origin/main --no-edit
# one conflict, in the baseline:
git checkout origin/main -- scripts/lib/lifecycle-column-census-baseline.json
node scripts/lifecycle-column-census.mjs --strict --update-baseline
git add scripts/lib/lifecycle-column-census-baseline.json && git commit --no-edit
```

**One** conflict instead of twenty-five, and the resolution is mechanical: take main's baseline, then
re-record from the merged tree. The tip is the only state that has to be correct — intermediate
baselines never mattered.

## Why the instinct is wrong here

Rebase is right for a short-lived single-author branch, which is what the per-file fleet PRs were,
and that is where the habit comes from. A batch branch is neither: it is long-lived, shared, and
touches a file that mutates on every verification run. Those three properties are exactly the ones
that make rebase expensive and merge cheap.

## Two smaller notes from the same session

- `--strict` **writes**. Redirecting its stdout to `/dev/null` in a scripted loop hides the
  "baseline rewritten downward, COMMIT IT" message and leaves a dirty tree that will abort your next
  `git checkout`. It is not silent; do not silence it.
- Branch-switching in a shared worktree can leave tracked binaries (`e2e/__screenshots__/*.png`)
  looking modified. Restore them (`git checkout -- <path>`); do not commit them into a batch.
