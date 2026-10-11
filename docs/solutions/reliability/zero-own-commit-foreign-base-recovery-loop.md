---
title: "A zero-own-commit branch on a foreign-tainted base must terminate, not re-loop"
date: 2026-09-13
category: reliability
problem_type: reliability
module: "@fusion/engine"
component: self-healing / branch-conflict-recovery
tags:
  - self-healing
  - branch-conflict
  - worktree
  - retry-budget
  - lifecycle-containment
  - trusted-identity
symptoms:
  - "a review-lane card stays failed+paused `branch-conflict-unrecoverable` forever"
  - "every maintenance pass repeats the same refusal pair (`already-merged rejected`, `is already checked out at`)"
  - "a peer card's `overlapBlockedBy` points at the wedge indefinitely"
root_cause: "two closed exits that were both unreachable: the zero-loss proof refused the identity the branch actually landed on, and no refusal path persisted `recoveryRetryCount`, so the dispatcher retry budget could never advance"
resolution_type: product-fix
applies_when: "diagnosing a branch-conflict wedge, changing the branch-conflict refusal sites, or touching checkout-emptiness / landedness proofs"
---

## The shape (RUFU-217)

A card in the review lane whose task branch owns ZERO commits of its own, cut from a base that
local `main` never advanced to, then rebased onto the fetched `origin/main` (acquisition-time
rebase onto the remote). Its tip is a foreign landing — commits owned by another lineage — and
the worktree is clean. The operator-visible loop: the reclaim sweep re-admits the
`branch-conflict-unrecoverable` pause every maintenance pass, the already-merged arm logs
`already-merged rejected (foreign-task-tip)`, the outer catch pauses again, nothing is ever
written that a future pass could read differently.

## The two-closed-exits trap

1. **The trusted-identity gap.** Every landedness proof (the sweep's foreign-tip rejection, the
   classifier, the checkout-emptiness prover) asked "is the tip an ancestor of / zero ahead of
   the LOCAL integration branch?" A branch rebased onto `origin/main` while local `main` sits
   behind fails exactly that test: the inherited foreign tip is unique against the behind local
   identity, so every proof said "foreign content" or "occupied" forever. The disposition the
   operator would perform by hand (see it landed, release it) had no automated equivalent.
2. **The counter that was never written.** The dispatcher decision engine requires
   `retryCount >= maxRetries` to refuse with exhaustion, and it reads `task.recoveryRetryCount`.
   Every refusal in this loop parked or paused the card WITHOUT persisting any counter, so
   `retryCount` was always 0 — a fresh budget on every pass. The loop was not "retrying too
   much"; it was unbounded by construction.

## Why the contamination handler was never the route

The executor dispatcher routes `branch-conflict-unrecoverable` to
`BranchWorktreeAutoRecoveryHandler`; the `SelfHealingManager` dispatchers are constructed
handler-less, and the contamination auto-recovery handler is not registered for this class at
all. Wiring recovery INTO the dispatcher would put it behind the very decision that produced
the wedge. The reachability fix is a DIRECT CALL to the existing exported
`recoverForeignOnlyContamination()` at the three sites that fall through to the unrecoverable
pause: the sweep's outer catch (mirroring its sibling PR-conflict catch), and
`handleBranchConflict` before dispatch / before force-cleanup. The routing table is unchanged,
byte-identical.

## The fix

- **One shared trusted-identity chain** (`resolveTrustedIntegrationRefs`): local integration
  branch first, then each existing `<remote>/<integration>`. Shared by the conflict
  inspections, the sweep's foreign-tip rejection, the foreign-only classifier, and the
  checkout-emptiness prover (chain anchored on the branch NAME so a recorded SHA base still
  gains the remote-tracking identity). A card's own commit unique against EVERY identity still
  refuses (FN-1406); unknown stays occupied-equivalent.
- **A persisted budget** (`recovery/branch-conflict-recovery-accounting.ts`): every counted
  pass at every refusal site (sweep, dispatcher-pause, handler irreducible pause, in-session
  exhaustion) writes `recoveryRetryCount` in the same update. `autoRecovery.mode: "off"` opts
  out. Operator retry resets it (`MANUAL_RETRY_RESET_COUNTER_KEYS`).
- **A terminal park separated from lease release.** At `maxRetries + 1` the card parks
  `failed`+`paused` with the existing `branch-conflict-recovery-exhausted` reason and an error
  naming the remedy — and that write performs ZERO git mutation: no worktree removal, no branch
  delete, no field clearing. The retained checkout stays inspectable; the sweep never
  re-admits the exhausted reason. Lease release is the separate, proof-gated decision: the
  zero-loss exit (re-anchor when the worktree is usable, discard when it is not) or the RUFU-200
  emptiness downgrade (clean tree AND zero-ahead of a TRUSTED identity — no git mutation at
  all, which also repairs cards predating acquire-time base recording).

**The tradeoff, stated:** for a shape the proof cannot clear, the card is deliberately held —
lease kept, peer still blocked. Termination + named remedy + wedge notification is the
guarantee; unblocking is NOT. Releasing an unproven checkout is the destruction FN-1406 forbids;
a blocked peer is operator-recoverable, destroyed work is not.

## Forensics notes

- The deployed-bundle refusal string `foreign-tainted` does not exist at HEAD — reason codes are
  `foreign-task-tip` / `foreign-lineage-tip` / `foreign-landed-commit` / `ownership-unverifiable`
  / `ambiguous`. Key diagnoses on the SHAPE, not the operator-visible literal.
- `landedVia: "remote-tracking"` on a `tip-already-merged` verdict is the marker of exactly this
  shape: landed where the LOCAL identity could not prove it.
- Real-git fixtures that reproduce it live in
  `packages/engine/src/__tests__/self-healing-zero-own-commit-foreign-base.real-git.test.ts`
  (origin-clone-diverge-rebase recipe); the loop-bound assertions live in
  `branch-conflict-retry-bound.test.ts`.

## Second failure mode: the base mentions the card, but not because the card landed (RUFU-396)

The refusal above is terminal and budgeted, so a **false** foreign-tip refusal is its own wedge. Measured
on RUFU-391: `git rev-list --count main..fusion/rufu-391` was `0`, the tip was RUFU-388's landed commit, and
`main` carried two commits whose messages contain `Fusion-Task-Id: RUFU-391` — written by RUFU-388's
delivery, not by this card. `baseHasExplicitTaskOwnership` ran `git log --grep="Fusion-Task-Id: <id>"` on the
base, called that "delivery", and `foreignTipRejection` therefore refused with `reason=foreign-task-tip` on
every sweep until the bounded budget parked the card `branch-conflict-recovery-exhausted`.

Positive control that keeps the fix honest: RUFU-378's `80a67a940c` is a real landed commit whose trailer,
body, and touched files (`packages/cli/src/commands/models.ts`) all belong to RUFU-378, and it sits in the
history of `fusion/rufu-378`, which also has zero unique commits. Both cards present the *same* raw grep
signal; only the verified evidence separates them.

**The discriminator is declared File Scope, not commit prose.** A stamped base commit counts as delivery
only when (a) re-reading the commit proves this card's ownership (the merge-side `getCommitTaskOwnership`
rules, not a substring), (b) it is content-bearing (`git show --name-only` non-empty), and (c) its touched
paths intersect the card's declared scope — the union of every `## File Scope` prompt list entry, the
store's effective write scope, and `sourceMetadata.fileScope`. RUFU-391's two stamped commits touch review
-queue gating and the shared governance docs: none of its three declared paths. Zero intersection proves the
card's own work is not in the base, so the card is routed to the existing stale-metadata reclaim
(`stale-cached-metadata-ghost-conflict`), announced by `task:already-merged-never-delivered`, and its
recovery budget is untouched.

**Traps recorded while implementing it:**

- `extractEffectiveWriteScopeFromPrompt` alone is NOT the declared scope. It reads only the FIRST exact
  `## File Scope` heading and keeps only backticked entries, so a card that writes bare paths (RUFU-391's
  second section) yields `[]` — which reads as "nothing was ever promised" and would make every claim match
  vacuously. Treat an empty effective set as unknown and union the raw prompt entries plus `sourceMetadata`.
- Do not reuse the merge-arbitration path matcher for delivery proof: its same-directory leniency (any
  pattern in directory X covers any file in directory X) would make `docs/run-audit.md` cover
  `docs/cli-reference.md`, which silently denies the rescue forever. `scopeCoversPath` is exact-equality,
  directory-prefix, and a real `**` translation, with no leniency.
- Missing or unreadable scope/paths must fail toward the OLD behavior (keep the refusal). The rescue is
  only ever an addition where absence is proven.
- An approved content-review row (`reviewKind: "code"` / `code-review`, `status: passed`, an APPROVE verdict,
  not operator-bypassed) is an independent delivery signal and vetoes the rescue: a scope mismatch after a
  human sign-off is the scope drift the board's own rules permit, not an undelivered card.
