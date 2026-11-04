---
title: "A withheld file-scope delivery burned its own retry budget and made its checkout unrestackable"
date: 2026-11-04
problem_type: reliability
module: "@fusion/engine"
component: worktree-acquisition
tags:
  - overlap
  - file-scope
  - worktree
  - retry-budget
  - self-healing
  - lifecycle-columns
---

# Symptom

A card sat `failed` in the planning/Hold lane with:

```
Worktree acquisition failed after 3 heartbeat attempts for branch "fusion/<id>": Overlap
synchronization cannot resume execution because delivered file evidence is unavailable for
task(s) <blocker>.
```

Nothing recovered it. The predecessor it was waiting for landed hours earlier; the card stayed put
through engine restarts, and manual Retry did not help — the next heartbeat re-failed it with the
same three-strike message. `git worktree list` still showed the card's path, while
`git -C <path> status` reported the directory gone.

# Root cause (three defects compounding)

1. **A wait was charged to a broken-checkout budget.** The overlap freshness gate
   (`synchronizeOverlapWaitBeforeExecution`) throws `OverlapResumeSynchronizationError` when a
   predecessor's delivered-file evidence is unreadable or unproven in the checkout. That typed
   refusal reached the heartbeat acquisition catch, which counts every acquisition error against
   `MAX_HEARTBEAT_WORKTREE_ACQUISITION_RETRIES`. Three dispatches of a legitimate wait exhausted a
   budget meant for damaged checkouts.
2. **The exhaustion writer composed an unreadable message.** The third attempt wrapped the bare
   sentence in `Worktree acquisition failed after N heartbeat attempts for branch "<b>": …`.
   `isRecoverableOverlapWaitFailure` compares whole sentences, and `reconcileReleasedOverlapWaits`
   selects on it — so the composed form matched nothing, and the card silently left every recovery
   authority.
3. **The refused acquisition leaked its registration.** `persistWorktreeAssignment` runs before the
   gate, so the refusal left `worktree`/`branch`/`baseCommitSha` pointing at a checkout that the
   next pass had to re-acquire. Re-acquisition saw a registered path on a branch with zero unique
   commits, refused to restack it (`already contains the current HEAD`), and its defensive removal
   was rejected as a non-defensive reason. The abandoned card also kept a **dormant** file-scope
   lease whose checkout no longer existed, which re-blocked the very predecessor it waited on.

A fourth latent defect kept any future fix from being observed: the sweep's resume predicate was
`current.column === lanes?.wip`. The bounded park lands in the workflow's dwell lane, whose builtin
id is literally `todo` (its *name* is "Planning"), so the sweep examined such a card and refused it
forever.

# Fix

- Classify `OverlapResumeSynchronizationError` **ahead of** the strike budget: no strike consumed or
  cleared, no exhaustion writer, and the operator-visible reason is the bare recoverable sentence.
  Park once in the rebound lane through the ordinary `failure`-shaped `updateTask` + `moveTask` pair
  with `preserveProgress`/`preserveStatus` — the shape `fn_task_retry` clears.
- Give the gate structured refusal artifacts (`episodeIds`, `blockerTaskIds`, `repositories`,
  `missingEvidence`) so the reason never has to be parsed back out of prose.
- Release the leaked registration through the proof-gated defensive path
  (`RemovalReason.AcquisitionRefused` in `DEFENSIVE_REMOVAL_REASONS`, never a force reason) and clear
  the pointers only when the checkout is proven removed or absent.
- Strip the acquisition wrapper by shape inside `isRecoverableOverlapWaitFailure`, so an
  already-wrapped overlap message is recoverable and a non-overlap one is not.
- Derive the sweep's resume lanes from column traits — `countsTowardWip` ∪ every `hold` ∪ every
  `intake` column, tested with `columnsWithFlag` because Hold is non-unique — never a column id.
- Emit one `task:overlap-acquisition-parked` row per episode.

# How to diagnose it again

```bash
# Is a card parked on a withheld delivery rather than on a broken checkout?
# The audit row names the missing artifact and the blockers; the message never does.
psql … -c "select target, metadata from run_audit_events
           where mutation_type='task:overlap-acquisition-parked' order by created_at desc limit 5;"
```

Discriminators, in order:

- The card's `error` is the **bare** `Overlap synchronization cannot resume execution …` sentence and
  `registrationRelease` is `removed`/`absent` → healthy bounded wait; it resumes itself.
- A `Worktree acquisition failed after N heartbeat attempts …` wrapper whose inner sentence is *not* an
  overlap sentence → genuine broken checkout; that path still burns strikes and is supposed to.
- A `registrationRelease` of `preserved` means the refusal had real unmerged content; the pointers are
  deliberately kept, so investigate the content, not the lease.

# Prevention invariants

- A refusal that withholds work because of *another* card's evidence is a wait, not a checkout defect,
  and a wait consumes no repair budget.
- Never compose an operator message out of a sentence another module matches on; carry structure
  instead, and if a wrapper is unavoidable, make the matcher read through it.
- Any lane decision must be derived from column **traits**, never a column id: a custom board names
  its Hold lane anything, and `resolveLifecycleColumns` returns only the first Hold match, so
  membership tests use `columnsWithFlag`.
- If a step persists a checkout pointer before a guard that can refuse, that guard owns releasing the
  pointer. Proof-gated removal, and clear pointers only on a proven `removed`/`absent` verdict —
  otherwise the repair trades a wedge for an orphan registration.
