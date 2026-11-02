---
title: "A workspace card that owes no commit had no delivery shape at any door"
date: 2026-11-02
problem_type: reliability
module: "@fusion/engine"
component: workspace-merge
tags:
  - workspace
  - zero-commits-expected
  - finalization
  - review
  - self-healing
symptoms:
  - "a workspace card sits in-review for days with both review gates APPROVE and nothing left to do"
  - "the land step refuses a card whose own spec says no commit and no changeset"
  - "`fn task reconcile` answers `ineligible` with reason `workspace`"
  - "the operator review bypass refuses because no gate failed"
  - "the card reports `stall:merge-blocker` with no unlanded work"
root_cause: "Every delivery door asked a card that owes no commit to produce per-repository landing evidence, and none of them had a terminal shape for \"the evidence is that there is nothing to land\"."
resolution_type: code_fix
---

## Problem

SANE-509 (a `saneca` workspace card) stood **51.4 h** in `in-review` while being complete by its own written
contract. Its spec declared the deliverable source-free — git-ignored board paths, explicitly "no commit and no
changeset". Both review gates carried `APPROVE`. Nothing could move it:

- the land step demanded a commit that its own spec forbids;
- `fn task reconcile <id>` answered `409 { outcome: "ineligible", reason: "workspace" }`;
- the operator bypass (`fn_task_bypass_review`, FN-7720) refused because **no gate had failed** — bypass clears a
  failed pre-merge review lane, and this card's lanes had all approved;
- the stall classifier reported `stall:merge-blocker`, which is the sentence for "the merge door refuses", not for
  "there was never anything to merge".

## Root cause

`noCommitsExpected` (the row's zero-commit contract, `hasZeroCommitDeliveryAuthorization`) declared what a card
promised to change. It never acquired a **terminal delivery shape**: each door still answered the same question —
"show me per-repository landing evidence" — and for a source-free card the honest answer is *the evidence is that
there is nothing to land*. Four separate doors then produced four different refusals for one row, and a card could
not satisfy all of them at once.

The driving fact is the existing declaration, not a new field: a "source free" per-card waiver would have created
a second authority that proves nothing.

## What each increment closed

| Layer | Shape it refused before | What it does now |
| --- | --- | --- |
| RUFU-504 | declared **and** acquired members sitting on their merge-base were "unexplained emptiness" | readiness returns `ready` per member; `landOneRepo` writes `merge:ai-empty` per-repository proof. A deleted branch is still never folded into a delivery, and no sha is ever invented. |
| RUFU-441 / `9ac84f3561` | an ahead-and-net-zero member was accused of being lost work; a zero-commit partial-land was parked `failed` | the empty-land classifier names the `reverted` shape on proof; the partial-land sweep suppresses the false park. |
| RUFU-451 (land step) | the workspace lane's own arm **threw** for an obligation-free card after three other lanes had agreed | `landWorkspaceTask`'s `no-op` arm finalizes as commit-free delivery, with the shared zero-commit door as its witness. It runs no landing side effect: no `merging` status, no fence or lease, no `WorkspaceLandIntent`, no worktree, no git write. |
| RUFU-451 (reconcile door) | the card-level door was reached by a card that actually held checkouts | the per-member obligation set is measured instead, and `affirmObligationFreeWorkspaceDelivery` runs only when there is genuinely nothing to probe. |
| RUFU-451 (board surface) | a closed card kept reporting a land failure | the land-failure chips for discharged and provably-absent members are cleared at the close. |
| RUFU-451 (planning) | a File Scope naming only board-owned ignored paths did not derive the contract | the zero-commit declaration is derived from it, so the spec's own words reach the row. |
| RUFU-451 (this fix) | **the merge door closed a card that held acquired checkouts while measuring none of them** | both doors read one obligation-set rule. |

## The invariant: one obligation set, both doors

`workspaceObligationRepositories` (`packages/engine/src/merge/workspace-merge-readiness.ts`) is the single answer
to "what does this card owe proof about?":

- a **confirmed** declaration names the set, in declared order;
- an authorized card whose confirmed scope names **no** repository owes proof about the checkouts it **holds**;
- without the declaration, an empty scope is an unreconciled declaration — the set stays empty and the
  operator-repair refusal stands, byte-identically.

Both `resolveWorkspaceMergeReadiness` / `landWorkspaceTask` and `reconcileLandedReviewTask` read it. Before that,
the merge door answered `no-op` from the declared list alone while the reconcile door used the acquired set for the
same row — SANE-509 measured three member entries against a confirmed scope of zero repositories. Two doors, one
card, opposite verdicts, and the card could only ever lose.

What may never be inferred, restated for the next reader who is tempted to help:

- an acquired checkout whose branch the ancestry probe cannot resolve is **never** absence — `unproven` is a
  refusal, and a deleted member branch is not proof of delivery either;
- a member whose recorded landing this lane did not perform refuses at the merge door; proving lands is
  `findProvenLandedCommit` in the reconcile door's hands, and the land step gains no authority over it;
- an obligation set narrower than the card's own declaration is a caller that lost repositories, and
  `decideWorkspaceDelivery` refuses it;
- a close that measured no tip at all says "holds no artifact of this card", never RUFU-504's ancestry sentence —
  the persisted sentence must describe the reads that actually ran, which is why
  `commitFreeDischargeReason` derives its provenance clause from the counts the caller had to produce.

## How to tell which door refused

| Evidence | Door |
| --- | --- |
| `Workspace merge has no acquired repositories matching confirmed scope … operator repair is required` | readiness classification (`resolveWorkspaceMergeReadiness`) |
| `… declared a zero-commit contract while its own checkout is not proven at zero commits ahead: <repo> (basis …)` | the merge door's per-member measurement |
| `{ outcome: "ineligible", reason: "workspace" }` with per-repo bases | the reconcile fence |
| `workspace-obligation-free-unproven` | the card-level door over a card that holds nothing |
| `stall:merge-blocker` while every gate approved and nothing is unlanded | suspect a missing terminal shape, not a missing commit |

A refusal at the merge door writes no `status`, no `error`, and no `mergeDetails`; it returns
`finalizeBlockedReason` and the card waits in review. That is a WAIT, not a failure, and it spends no retry budget.

## Related

- `docs/solutions/reliability/workspace-empty-merge-boundary-finalization-livelock.md` — the second-pass empty set.
- `docs/solutions/reliability/evidence-gated-empty-land-verdicts.md` — the empty-land evidence gate.
- `docs/workspaces.md`, `docs/architecture.md`, `docs/cli-reference.md` — the operator-facing contract.
