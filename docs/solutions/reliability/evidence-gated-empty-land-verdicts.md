---
title: "A merge lane that committed nothing declares the card's work \"reverted or lost\" — while the branch still holds every commit"
date: 2026-10-15
category: reliability
problem_type: reliability
module: "@fusion/engine"
component: merge/merger-ai / self-healing / run-audit
tags:
  - empty-land
  - merge-lane
  - false-diagnosis
  - evidence-gate
  - stall-deadlock
  - rufu-267
  - rufu-293
symptoms:
  - "an in-review card fails with \"branch had no net changes vs main — work may have been reverted or lost; operator review required\""
  - "`git cherry <integration-branch> fusion/<task-id>` still prints only `+` rows"
  - "the deliverable named on the card is absent from the integration branch (`git log <integration-branch> -- <file>` is empty)"
  - "after three identical stalls the card is paused with the in-review stall-deadlock prefix and its owner detached"
  - "`merge:ai-empty` rows exist for the card while no landing row (`merge:orphan-write-fenced` / push / landed proof) ever appeared"
---

## What happened

RUFU-267 (byte-stable system prompts) reached `in-review`/failed with the board sentence
`branch had no net changes vs main — work may have been reverted or lost; operator review required`,
and its owner was detached by the in-review stall-deadlock park after the same blocker repeated. The
accusation was false. Re-measured on 2026-10-15, four days after the verdict:

| Evidence | Measured value |
| --- | --- |
| Unmerged commits | `git rev-list --count fusion/rufu-267 ^HEAD` → `4`; `git cherry main fusion/rufu-267` → four `+` rows |
| Contribution still unapplied | `git diff --shortstat main...fusion/rufu-267` → `38 files changed, 2614 insertions(+), 331 deletions(-)` |
| Deliverable | `scripts/check-prompt-volatility.mjs`: `git log main -- <file>` empty — it was never on main |
| Recovery artifacts | stash `7a172cf192` ("RECOVERED RUFU-267 prompt-volatility WIP") plus `refs/fusion-salvage/rufu-267-stash` |

So the work was neither reverted nor lost: it sat intact on its own branch, and the merge lane had
merely failed to produce a squash commit in its clean room. The board stated the opposite of the truth
and then spent its own recovery budget freezing the card on that statement.

## Root cause: tip equality was treated as a proof of emptiness

`mergeAndReview` returns `squashSha: null` whenever the merge agent's candidate SHA still equals the
branch tip and it recorded no findings. That condition proves one thing only — *the merge agent
committed nothing in the clean room*. Three consumers then upgraded it to a claim about the branch:

1. the single-repo finalize guard (the FN-8141 laundering guard),
2. the workspace parity guard (`hasRevertedEmptyRepo` over per-repo `merge-base --is-ancestor` probes),
3. the self-healing in-review stall-deadlock disposition, which terminalizes and detaches the owner
   after N identical stalls whose premise is whichever sentence the guard above wrote.

None of them re-derived the git premise, so a merge-lane malfunction was laundered into a statement
about the card's work. Worse, the honest-looking sentence is *sticky*: `recoverStrandedCompletedTodoTasks`
excludes any task whose `error` is set, and `handleGraphFailure` preserves a merger park verbatim, so
the false sentence routed every automatic recovery away from a card whose content was fine.

## The invariant, and the one seam that owns it

**An "empty land" verdict may only be declared when read-only git evidence positively proves the
contribution is already on the integration target or is net-zero against it. Evidence that contradicts
it produces an honest malfunction diagnostic — never the lost-work accusation.**

That lives in exactly one classifier, `packages/engine/src/merge/empty-land-evidence.ts`:

* `classifyEmptyLandEvidence({ branch, integrationBranch, exec })` → `EmptyLandEvidence` =
  `proven` (`EmptyLandProof` = `ancestor` | `net-zero`), `contradicted`, or `unknown`.
* `evaluateWorkspaceEmptyLand(...)` gives the same verdict per repository plus the lane decision.
* `execEmptyLandGit(...)` is the read-only exec adapter; the git timeout is `EMPTY_LAND_GIT_TIMEOUT_MS`.
* `emptyLandContradictionAuditMetadata(...)` builds the ids/counts-only audit payload.
* Two sentences are exported, because equality across surfaces is what makes the diagnosis greppable:
  `EMPTY_MERGE_NO_LANDED_PROOF_REASON` (kept **verbatim** from FN-8141 — a proven-net-zero branch with
  no landed proof must still block exactly as before) and
  `EMPTY_LAND_CONTRADICTION_REASON` = "empty land verdict contradicted by branch content — merge-lane
  malfunction, work is still on the branch; operator review required".

All three seams consume the classifier instead of re-deriving anything: the single-repo guard at
`merger-ai.ts` `outcome === "empty"`, the workspace parity guard, and `self-healing.ts`, which reaches
it through the protected `SelfHealingGitEvidence.classifyEmptyLandEvidence` seam (the same
`execBranchProbe`-style injection pattern used for `hasUnlandedTaskOwnedContent`), so reliability
fixtures supply evidence without shelling real git.

## What deliberately did not change

Keeping the FN-8141 anti-laundering protection intact was half the task, so these stay as they were:

* A **proven** net-zero / ancestor branch with no landed proof still blocks with the original
  sentence, byte-identical — the existing `revertBranchToNetZero` suites in `merger-ai.test.ts` and
  `workspace-merger.test.ts` are the ratchet for that.
* `unknown` evidence (git failure, timeout, branch vanished mid-classification) keeps today's
  conservative behavior; the classifier never guesses empty.
* The zero-ahead fast path (`branchTip === mainTip`) stays evidence-free — tip equality *is* the proof
  there, so a contradiction is unreachable by construction.
* The workspace nested-registration refusal (RUFU-290's product seam) stayed byte-intact.
* `hasPriorAiNoOpFinalizationProof`'s log matcher and the matched line shape are untouched; new
  contradiction log lines were written so they cannot match it.
* Contradiction still does **not** auto-merge: the disposition stays blocked/paused, only the reason
  becomes honest. Fixing the diagnosis is not the same as granting the merge.

## Audit trail

* `merge:ai-empty` now carries a closed `reason` discriminator — `branch-truly-empty` (zero ahead of
  the tip with no durable review blockers, decided before any clean room is built) versus
  `merge-agent-no-squash` (the branch *was* ahead, yet no squash appeared). Only the second arm can
  hide unapplied work, which is what makes the two arms distinguishable after the fact.
* New event `task:empty-land-contradiction-detected` (`EMPTY_LAND_CONTRADICTION_EVENT`) is emitted
  through the bounded `emitBoundedRunAudit` seam from the merger lane and from self-healing, with
  ids/counts/fixed enums only; diffs, branch content, findings, and file paths never enter the row.
  Catalogue and `docs/run-audit.md` were updated in the same commits as the emit sites, which
  `run-audit-catalogue.test.ts` locks table-for-table.

## Symptom verification

`packages/engine/src/__tests__/reliability-interactions/in-review-stall-empty-land-contradiction.test.ts`
drives the reported shape end to end: a card whose error carries the empty-merge premise, a branch the
injected evidence says still contributes, and the assertion that the deadlock disposition records the
malfunction sentence instead of the lost-work one — with the proven-net-zero control in the same file
proving the old sentence survives. The workspace arm is covered by the contradicted-repo production
path in `workspace-merger.test.ts`, and both `merge:ai-empty` arms by `merger-ai.test.ts`.

Non-vacuity was checked, not assumed: against `ff1eb1e938` (the commit that carries the classifier and
the single-repo gate but not yet the workspace parity gate or the `reason` discriminator) the three
new assertions fail 3 ×, and they pass at HEAD.

## Salvaging a card this class diagnosed

The salvage half of RUFU-293 is the procedure to copy, because the interesting failure mode is
*destroying* the evidence while rescuing the work:

1. Re-measure the premise before touching anything — `rev-list --count <branch> ^HEAD`, `git cherry`,
   `git log <target> -- <deliverable>`, `git diff --shortstat`. Branch state outranks board rows, which
   rotate under you.
2. Preserve every recovery artifact as-is. Do **not** re-apply a stash just because it exists: prove
   containment first (per added line for tracked files, blob equality for the untracked `^3` parent)
   and record the verdict. RUFU-267's stash came out **SUPERSEDED** — of 26 tracked files and 1148
   added non-empty lines exactly 3 were absent (all earlier-draft spellings the branch renamed), and
   its three untracked deliverables exist on the branch as strictly larger revisions, so re-applying
   would have *regressed* them. The correct disposition was "superseded, preserved".
3. Separate product bugs from staleness before writing a fix commit. The salvage branch's own lanes
   were green (59 vitest + 19 script tests); the only red, `executor-prompt.test.ts`, is a file **main
   itself quarantined on 2026-10-05** for shard-only flakiness. Confirm a quarantine claim in
   `scripts/lib/test-quarantine.json` and the package's vitest `exclude` list before spending a cycle.
4. Reconcile the board row through sanctioned surfaces only. Here the engine had already done it
   (auto-unblock, continuation re-queues, a workflow-drift park); the executor's honest contribution
   was to *not* move the column, rewrite dependencies, retry a card whose plan is complete, drop the
   stash, or force-move a branch checked out in another worktree — and to record the residual blocker,
   which was 3–4 merge conflicts against current `main` plus a missing Code Review row, neither of
   which an executor lane may self-authorize.
5. Never push to a remote from a salvage lane. Branch and stash are the evidence; a push makes the
   repair unverifiable.

## Reachability boundary

The classifier is only as good as the branch it is pointed at. If the branch has already been deleted
or reset, evidence is `unknown` and the guard keeps the historical conservative sentence — a salvage
after the fact cannot be reached by this path, only by the RUFU-283 vanished-directory detector. That
gap is why the contradiction event names `tipSha` and the ahead/file counts: the row is the surviving
proof that the branch was alive at verdict time.
