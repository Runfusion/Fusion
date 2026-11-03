/*
FNXC:ZeroCommitLandingProof 2026-09-25-11:17 (RUFU-274):
A card whose branch has zero commits ahead of the integration branch can still be carrying the only
copy of its work: uncommitted files in the worktree. Git cannot see them. `rev-list --count` returns 0
and branch ancestry returns "contained in main" for a branch whose content was NEVER committed, so
every lane that reasons about "already landed / nothing to merge" from revision-walk evidence alone
will finalize such a card, let worktree cleanup delete the tree, and report it `done`.

RUFU-262 is the observed symptom: zero commits ahead, a worktree that still held modified and
untracked files, and the card standing in the complete lane. FN-8141 was the same laundering shape
with a clean tree (a reverted task finalized as a no-op), which is why this predicate covers the
zero-commit finalize generally instead of only the reported dirty case.

The invariant this module encodes: **landing proof is proof of delivered CONTENT, not proof of
git ancestry.** Ancestry is necessary and not sufficient — the missing half is a classification of
what is sitting in the worktree.

Why this lives in `@fusion/core` as a pure function: `packages/engine/src/merge/merger.ts` is ~11.6k
lines, `self-healing.ts` ~19.1k, `merger-ai.ts` ~4.1k and `project-engine.ts` ~7k. A predicate
re-implemented at that many sites drifts, which is why `assertCleanForDefensiveRemoval` today has
seven production call sites that pass inconsistent options — one passes none, one swallows the throw
with a bare catch, one passes an explicit ceiling. One predicate, one row sentence, one audit
vocabulary; the lanes differ only in how they deliver the verdict (Steps 2-5).

The lane's own `mergeConfirmed` flag and its own no-op claim are deliberately NOT inputs: they are the
claim under test. A lane that could approve itself by setting the flag it is being guarded on is how
the empty-merge lane produced RUFU-262 in the first place (`noOpResult()` writes
`mergeConfirmed: true`, and the merge-confirmed fast path in `project-engine.ts` then finalizes any
row carrying it).
*/

import type { MergeDetails, Task, UncommittedWorkHold, WorkflowStepResult } from "../types.js";
import type { WorktreeContentClassification, WorktreeContentState } from "../types/merge/worktree-content.js";
import { CLEAN_WORKTREE_CONTENT } from "../types/merge/worktree-content.js";

/*
FNXC:ZeroCommitDeliveryProof 2026-09-26-01:30 (RUFU-274):
The worktree-content vocabulary is DECLARED in `types/merge/worktree-content.ts` and re-exported here,
because the row shape (`MergeDetails.uncommittedWorkHold.contentState`) has to name the same states this
decision table reads, and `types/task/task-core.ts` importing from `merge/` would close an import cycle.
Re-exporting keeps `@fusion/core`'s public surface unchanged for engine lanes.
*/
export type { WorktreeContentState, WorktreeContentClassification };
export { CLEAN_WORKTREE_CONTENT };

/** Content classes that hold nothing this card could have been meant to deliver. */
/*
FNXC:ZeroCommitLandingProof 2026-09-27-02:40 (RUFU-274 Step 1/2 reconciliation):
These are the states in which NO uncommitted content of this card can survive to be lost. `absent` belongs
here even though it is an inference rather than a status read, because the classifier only reaches it after
the recorded path is gone AND `git worktree list` was read successfully and named no other checkout holding
the branch — so there is nowhere the files could be. A failed read of that registry is `unverifiable`, and
`deliverable`/`unverifiable` are the two states this predicate refuses; a tree that exists but holds only
committed-or-ignored content is `clean`/`regenerable-ignored`. RUFU-262's own row was `deliverable` (path
present, 9 modified + 4 untracked), so this arm never authorizes the incident shape.

`absent` stays SEPARATE from `clean` in the vocabulary because the two answer different questions: Step 5's
pointer rule may clear a genuinely-gone path from the row but the delivery CLAIM still needs its own proof
(`getMergeConfirmedFinalizationBlocker`, `hasDurableLandingProof`). Nothing may be at risk is not the same
statement as the work was delivered, and only the second one licenses `done`.
*/
const NOTHING_DELIVERABLE: ReadonlySet<WorktreeContentState> = new Set<WorktreeContentState>([
  "clean",
  "regenerable-ignored",
  "ignored-only",
  "absent",
]);

/** Non-ignored path counts carried by a classification (0 for every non-deliverable state). */
export function worktreeContentCounts(
  content: WorktreeContentClassification | undefined,
): { modifiedCount: number; untrackedCount: number; paths: readonly string[] } {
  if (content?.state === "deliverable") {
    return {
      modifiedCount: content.modifiedCount,
      untrackedCount: content.untrackedCount,
      paths: content.paths ?? [],
    };
  }
  return { modifiedCount: 0, untrackedCount: 0, paths: [] };
}

/**
 * Durable evidence that content already reached the integration branch. Each value names WHO can
 * assert it, so a caller cannot invent a kind it did not actually verify:
 *
 * - `durable-commit-sha` — `mergeDetails.commitSha` / `landedBranchTipSha` names a commit the lane
 *   recorded when a real landing happened.
 * - `verified-no-op` — the shipped `noOpVerifiedShortCircuit` flag: rebase-strategy capture proved
 *   every commit on the branch was ALREADY on main, from the merge that recorded it.
 * - `workspace-landed-at` — a workspace land recorded a per-repository `landedSha`.
 * - `landed-files` — the land recorded the file set it delivered (`landedFiles` / `filesChanged`).
 * - `caller-asserted` — proof a lane verified outside the row (an owned-commit/absent-branch
 *   reconciliation, `classifyOwnedLandedEvidenceForSelfHealing`); not derivable from `mergeDetails`.
 */
export type LandingProofKind =
  | "durable-commit-sha"
  | "verified-no-op"
  | "workspace-landed-at"
  | "landed-files"
  | "caller-asserted";

export interface LandingProof {
  kind: LandingProofKind;
  /** The landed sha when the kind names one. Never a content excerpt. */
  sha?: string | null;
}

export interface DurableLandingProofVerdict {
  proven: boolean;
  kind: LandingProofKind | null;
  proof: LandingProof | null;
}

/*
FNXC:ZeroCommitLandingProof 2026-09-26-01:30 (RUFU-274):
The canonical durable landing-proof predicate.

`mergeConfirmed` and `noOpMerge` are excluded on purpose: both are written by the finalizing lane
itself (`buildFinalizationMergeDetails` copies `result.mergeConfirmed` straight through), so treating
either as proof would let a lane that just declared "nothing to merge" then cite that declaration as
the reason nothing had to be merged. `noOpVerifiedShortCircuit` IS accepted, and is not the same
thing: its single writer is the rebase-strategy capture that verified each branch commit's presence on
main, i.e. a positive observation, not a claim of emptiness. It exists so the legitimate
already-on-main lane keeps finalizing (OD req 4) without becoming the loophole — a bare `noOpMerge`
flag set by the finalizing lane still proves nothing.
*/
export function hasDurableLandingProof(
  mergeDetails:
    | Pick<MergeDetails, "commitSha" | "landedBranchTipSha" | "landedFiles" | "filesChanged" | "noOpVerifiedShortCircuit" | "workspaceLandedFiles">
    | undefined,
): DurableLandingProofVerdict {
  if (!mergeDetails) return { proven: false, kind: null, proof: null };
  const commitSha = mergeDetails.commitSha?.trim() || mergeDetails.landedBranchTipSha?.trim();
  if (commitSha) {
    const proof: LandingProof = { kind: "durable-commit-sha", sha: commitSha };
    return { proven: true, kind: proof.kind, proof };
  }
  if (mergeDetails.noOpVerifiedShortCircuit === true) {
    const proof: LandingProof = { kind: "verified-no-op" };
    return { proven: true, kind: proof.kind, proof };
  }
  if (Object.values(mergeDetails.workspaceLandedFiles ?? {}).some((files) => (files?.length ?? 0) > 0)) {
    const proof: LandingProof = { kind: "workspace-landed-at" };
    return { proven: true, kind: proof.kind, proof };
  }
  const landedFileCount = mergeDetails.landedFiles?.length ?? 0;
  if (landedFileCount > 0 || (typeof mergeDetails.filesChanged === "number" && mergeDetails.filesChanged > 0)) {
    const proof: LandingProof = { kind: "landed-files" };
    return { proven: true, kind: proof.kind, proof };
  }
  return { proven: false, kind: null, proof: null };
}

export interface ZeroCommitLandingProofInput {
  /**
   * Commits on the card's branch ahead of the integration branch. `null` means the count could not be
   * read, which is NOT zero: an unreadable revision walk is the absence of proof, never proof of
   * emptiness.
   */
  aheadCommitCount: number | null;
  /** Durable landing proof from a caller that actually verified it. */
  landingProof?: LandingProof | null;
  /**
   * What the worktree holds. The `undefined` arm exists only for the defensive fallthrough below — the
   * zero-diff finalize contract (`NoCommitsNoOpFinalizeEvidence.worktreeContent`) is strictly required,
   * so a lane that has not probed cannot compile against it.
   */
  worktreeContent: WorktreeContentClassification | undefined;
  /** The card was explicitly authorized to deliver no commits. */
  noCommitsExpected?: boolean;
  /**
   * The lane is presenting itself as a no-op landing. Recorded for audit only — it never widens
   * permission, because a lane that does not label itself a no-op is still the sole candidate for the
   * row and is covered identically.
   */
  presentsNoOp?: boolean;
}

export type ZeroCommitLandingProofVerdict =
  | { kind: "proven"; basis: "commits-ahead" | "ahead-unproven" }
  | { kind: "proven-legitimate-noop"; basis: LegitimateNoOpBasis }
  | {
      kind: "refuse";
      code: UncommittedWorkRefusalCode;
      reason: string;
      contentState: WorktreeContentState;
      modifiedCount: number;
      untrackedCount: number;
      uncommittedPaths: readonly string[];
    }
  | { kind: "retry"; reason: "content-probe-failed"; contentState: WorktreeContentState };

/**
 * The two legitimate no-op classes, kept apart because they are checked differently: one asks whether
 * there was ever anything to deliver, the other asks whether the delivery already happened.
 */
export type LegitimateNoOpBasis =
  /** Zero commits ahead AND nothing deliverable in the worktree (marker optional — the probe is the evidence). */
  | "nothing-to-deliver"
  /** The content is provably already on the integration branch. */
  | "nothing-to-merge";

/**
 * Why a zero-commit finalization is refused.
 *
 * `uncommitted-work` and `content-unverifiable` are the two manual-merge-hold codes: both mean a human
 * must look at content that automatic delivery cannot safely touch. There is deliberately no third
 * "nothing is at risk" refusal code — a zero-commit card whose checkout provably holds nothing is a
 * legitimate no-op (Step 4 authorizes durable proof OR a clean probe), so it needs no refusal.
 */
export type UncommittedWorkRefusalCode =
  | "uncommitted-work"
  | "content-unverifiable";

/** Paths named on the row before the sentence switches to a count. */
const MAX_NAMED_PATHS = 5;

/**
 * The canonical row sentence for uncommitted content surviving a zero-commit branch. One sentence,
 * built here, so every lane's refusal reads identically and the card states the hold reason without
 * the operator opening History. It names the paths (bounded, so a 400-file tree cannot make the row
 * unreadable) and states the operator action.
 */
export function describeUncommittedWorkRefusal(
  uncommittedPaths: readonly string[],
  modifiedCount?: number,
  untrackedCount?: number,
  worktreeLabel = "its worktree",
): string {
  const counted = (modifiedCount ?? 0) + (untrackedCount ?? 0);
  const count = counted > 0 ? counted : uncommittedPaths.length;
  let named = "";
  if (uncommittedPaths.length > 0) {
    const listed = uncommittedPaths.slice(0, MAX_NAMED_PATHS).join(", ");
    const rest = uncommittedPaths.length - Math.min(uncommittedPaths.length, MAX_NAMED_PATHS);
    named = ` — ${listed}${rest > 0 ? ` (+${rest} more)` : ""}`;
  }
  /*
  FNXC:ZeroCommitDeliveryProof 2026-09-26-02:05 (RUFU-274):
  The path list a refusal can carry is capped, so on a 440-file tree the named paths would read as the
  whole story. When the probe counted more files than it could name, the sentence states the split too:
  `modified` and `untracked` need different operator actions (stage-and-commit vs. `git clean`), and an
  operator who sees only "440 uncommitted file(s)" cannot tell which they are facing. Only stated when
  the counts exceed the list, so a small tree keeps the short sentence this text already had.
  */
  const split = counted > uncommittedPaths.length && modifiedCount !== undefined && untrackedCount !== undefined
    ? ` (${modifiedCount} modified, ${untrackedCount} untracked)`
    : "";
  return `${count} uncommitted file(s) survived on the branch; automatic merge refused${named}${split}. Commit or discard them in ${worktreeLabel}, then merge manually.`;
}

/** Row sentence for content that could not be classified but whose card already claims delivery. */
export const CONTENT_UNVERIFIABLE_REFUSAL =
  "worktree content could not be classified, so uncommitted work cannot be ruled out; automatic merge refused. Resolve the worktree state, then merge manually.";

/**
 * The shared durable landing-proof predicate.
 *
 * Consulted by every finalization lane before it reports a card done. A lane that does not itself
 * label the finalize a no-op is still covered: for that lane this predicate is the row's sole
 * candidate for completion, which is exactly the case the rule has to answer.
 *
 * Decision table for a card with zero commits ahead of the integration branch (a card with commits ahead
 * is not a zero-commit finalize at all and returns `proven`):
 *
 * | worktree content                       | landing proof | verdict                                  |
 * | -------------------------------------- | ------------- | ---------------------------------------- |
 * | `deliverable`                          | any           | `refuse` `uncommitted-work`              |
 * | `unverifiable`                         | present       | `refuse` `content-unverifiable`          |
 * | `unverifiable`                         | absent        | `retry` `content-probe-failed`           |
 * | clean / regenerable / ignored-only / absent | present    | `proven-legitimate-noop` `nothing-to-merge`   |
 * | clean / regenerable / ignored-only / absent | absent     | `proven-legitimate-noop` `nothing-to-deliver` |
 *
 * A dirty checkout outranks landing proof: content that is provably on `main` does not make a second,
 * uncommitted copy of the work safe to delete.
 *
 * FNXC:ZeroCommitLandingProof 2026-09-27-02:11 (RUFU-274 Step 2/5): an OBSERVED-empty probe authorizes the
 * no-op on its own (Step 2: `clean` does not block), while a missing path is the absence of an observation
 * and needs durable proof or the card's own `noCommitsExpected` authorization. The two must not be merged:
 * conflating them is what let RUFU-262 finalize with its branch ref gone and its work alive only as files.
 *
 * FNXC:ZeroCommitLandingProof 2026-09-26-01:30 (RUFU-274):
 * An ABSENT classification never reads as clean. The parameter is required so a lane that never probed
 * fails to compile, but a JavaScript caller (or a lane that forwards `undefined` it received from an
 * optional field) still reaches here, and RUFU-262's whole failure mode was a lane whose implicit "the
 * tree is clean" assumption was never checked. Missing evidence therefore resolves to the same refusal
 * as the worst content state, never to the pass arm.
 *
 * FNXC:ZeroCommitLandingProof 2026-09-26-08:05 (RUFU-274):
 * An UNREADABLE ahead-count abstains only while nothing is at risk. `null` is the absence of proof, so it
 * cannot license the zero-commit refusal — but it equally cannot license a finalize, and the second
 * RUFU-262 shape is exactly this pair: the branch ref is gone (so nothing can be counted) while the
 * deliverable survives only as uncommitted files in a tree. A `deliverable` checkout therefore still
 * refuses with an unreadable count; every other content state keeps the abstention, so a repository that
 * merely cannot be counted is never wedged by this guard.
 */
export function evaluateZeroCommitLandingProof(
  input: ZeroCommitLandingProofInput,
): ZeroCommitLandingProofVerdict {
  const { aheadCommitCount, landingProof, worktreeContent } = input;
  const content = worktreeContent as WorktreeContentClassification | undefined;

  if (aheadCommitCount === null && content?.state !== "deliverable") {
    return { kind: "proven", basis: "ahead-unproven" };
  }
  if (aheadCommitCount !== null && aheadCommitCount > 0) return { kind: "proven", basis: "commits-ahead" };
  if (!content || typeof content.state !== "string") {
    return {
      kind: "refuse",
      code: "content-unverifiable",
      reason: CONTENT_UNVERIFIABLE_REFUSAL,
      contentState: "unverifiable",
      modifiedCount: 0,
      untrackedCount: 0,
      uncommittedPaths: [],
    };
  }

  const { modifiedCount, untrackedCount, paths } = worktreeContentCounts(content);

  if (content.state === "deliverable") {
    return {
      kind: "refuse",
      code: "uncommitted-work",
      reason: describeUncommittedWorkRefusal(paths, modifiedCount, untrackedCount),
      contentState: content.state,
      modifiedCount,
      untrackedCount,
      uncommittedPaths: paths,
    };
  }

  if (content.state === "unverifiable") {
    if (landingProof) {
      return {
        kind: "refuse",
        code: "content-unverifiable",
        reason: CONTENT_UNVERIFIABLE_REFUSAL,
        contentState: content.state,
        modifiedCount: 0,
        untrackedCount: 0,
        uncommittedPaths: [],
      };
    }
    return { kind: "retry", reason: "content-probe-failed", contentState: content.state };
  }

  if (NOTHING_DELIVERABLE.has(content.state)) {
    /*
    FNXC:ZeroCommitLandingProof 2026-09-27-01:01 (RUFU-274 Step 4):
    Nothing uncommitted survives to be lost, so the finalization is authorized by EITHER arm the spec
    allows: durable landing proof (the delivery already happened → `nothing-to-merge`) or a positive
    content probe on a branch with zero commits ahead (there was nothing to deliver → `nothing-to-deliver`).
    Requiring a marker or a sha on a provably-empty tree refused the legitimate clean-tree no-op lanes
    (ignored-only scratch, intentional zero-diff cards) without protecting anything: the content at risk is
    the `deliverable` arm above, an unobserved tree is the `absent`/`unverifiable` arms, and Step 2 states
    the same rule from the guard side — `clean` does not block.
    */
    if (landingProof) return { kind: "proven-legitimate-noop", basis: "nothing-to-merge" };
    return { kind: "proven-legitimate-noop", basis: "nothing-to-deliver" };
  }

  /*
  FNXC:ZeroCommitLandingProof 2026-09-25-11:17 (RUFU-274):
  Unreachable for the declared union; a future evidence class must be an explicit decision rather
  than an implicit pass-through, so the fallthrough refuses.
  */
  return {
    kind: "refuse",
    code: "content-unverifiable",
    reason: CONTENT_UNVERIFIABLE_REFUSAL,
    contentState: "unverifiable",
    modifiedCount: 0,
    untrackedCount: 0,
    uncommittedPaths: [],
  };
}

/*
FNXC:ZeroCommitLandingProof 2026-09-25-12:05 (RUFU-274):
The durable hold a refusing lane leaves on the row, and the door that reads it.

`getTaskMergeBlocker` is the row-only merge authority — every finalization door and the stall derivation
already consult it — so a refusal that is not visible there is invisible on the card. These two functions
are what make a refusal survive a restart: the lane proves the condition once with git, writes the marker,
and from then on the answer comes from the row without re-shelling out.

Clearing is the refusing lane's job (`clearZeroCommitUncommittedWorkHold` in the engine guard) on the next
pass that re-probes and gets a different verdict. That is what keeps a hold from outliving its cause, and
why the marker records the evidence class that produced it.
*/

/** True when the row carries a zero-commit uncommitted-work hold. */
export function isUncommittedWorkHold(
  mergeDetails: Pick<MergeDetails, "uncommittedWorkHold"> | undefined,
): mergeDetails is { uncommittedWorkHold: UncommittedWorkHold } {
  const reason = mergeDetails?.uncommittedWorkHold?.reason;
  return typeof reason === "string" && reason.trim().length > 0;
}

/**
 * The blocker form of the hold: the exact sentence the refusing lane recorded, so the board chip, the
 * task log, and the refusing lane can never state the refusal differently.
 *
 * A `manual: true` door does NOT bypass it. `manual` exists so a human can clear scheduler-transient
 * states, not to license discarding content — the merge would drop the uncommitted files whoever asks for
 * it. The operator action is on the worktree (commit or discard); the hold then clears on the next pass.
 */
export function getUncommittedWorkHoldBlocker(task: Pick<Task, "mergeDetails">): string | undefined {
  if (!isUncommittedWorkHold(task.mergeDetails)) return undefined;
  return task.mergeDetails.uncommittedWorkHold.reason;
}

/*
FNXC:ZeroCommitWorkspaceDelivery 2026-09-30-20:43 (RUFU-451):
The workspace partial-land sweep (`reconcileWorkspacePartialLands`) parks a card `failed` when a member
repository is PROVEN branch-gone with no `landedSha` (FORK-A), or when its branch state could not be read
after the bounded starvation budget. That judgement is sound for a card that owes commits and proves it
wrong for a card whose own plan declares `noCommitsExpected` — for that contract, git has nothing to show
by design, so "no branch, no landedSha" is the EXPECTED delivery shape rather than lost work.

Measured live on SANE-509: `no_commits_expected = 1`, both member branches present at zero unique
commits, review re-executed green, and the sweep parked the card `failed` with the FORK-A sentence every
pass. Because `getTaskMergeBlocker` treats any blocking status as a merge blocker, that single write also
refused the operator's `in-review → done` drag (`409 code=merge-blocked`), the stall classifier
(`stall:merge-blocker`), and every recovery door that consults the same authority — so a missing push
blocked the card from every direction at once, with no lane owning the repair.

The two sentence prefixes below are the SHARED FACT between the writer and the reader: the sweep builds
its park error from them and this module recognises them, so a wording change cannot silently orphan the
recognition the way a duplicated literal would. Recognition stays deliberately narrow — it names only
these two sentences, written only by that sweep, on a card that carries the explicit zero-commit
authorization. It is not a general "ignore failures on no-commits cards" rule, and it waives nothing
about pauses, review verdicts, or unrun gates.
*/

/** FORK-A park: a member repository is proven branch-gone with no landing proof. */
export const WORKSPACE_PARTIAL_LAND_UNRECOVERABLE_PREFIX = "Workspace partial-land unrecoverable:";

/** Starvation park: a member repository's branch state could not be read after the bounded budget. */
export const WORKSPACE_PARTIAL_LAND_EVIDENCE_UNAVAILABLE_PREFIX = "Workspace partial-land evidence unavailable:";

const WORKSPACE_PARTIAL_LAND_PARK_PREFIXES: readonly string[] = [
  WORKSPACE_PARTIAL_LAND_UNRECOVERABLE_PREFIX,
  WORKSPACE_PARTIAL_LAND_EVIDENCE_UNAVAILABLE_PREFIX,
];

/**
 * True when `error` is one of the two sentences the workspace partial-land sweep writes when it parks a
 * card. Any other failure text — including a later unrelated failure that overwrote the park — is not
 * this class, so the recognition cannot launder an ordinary merge failure.
 */
export function isWorkspacePartialLandParkError(error: string | undefined | null): boolean {
  if (typeof error !== "string") return false;
  return WORKSPACE_PARTIAL_LAND_PARK_PREFIXES.some((prefix) => error.startsWith(prefix));
}

/**
 * The card's own authorization to deliver zero commits. Read as an explicit `=== true`: `undefined` and
 * `false` are commit-expected (the legacy default), so a row that never answered is never treated as
 * exempt. 265 cards across the boards carry the flag; 1895 do not.
 */
export function hasZeroCommitDeliveryAuthorization(
  task: Partial<Pick<Task, "noCommitsExpected">>,
): boolean {
  return task.noCommitsExpected === true;
}

/*
FNXC:ZeroCommitEmptyInputContentProof 2026-11-03-17:27 (RUFU-384):
The CORE-side spelling of the engine's canonical empty-review-input fingerprint marker
(`EMPTY_REVIEW_DIFF_FINGERPRINT` in `packages/engine/src/worktree/review-diff-fingerprint.ts`).
Core cannot import engine, so this is a declared twin, not a second implementation: one exported
constant that every core consumer compares against, so the marker can never be re-typed per site and
a core lane can recognise the marker without a string literal of its own.

Only the CANONICAL version matches. An `empty-review-input:v2`-shaped string is a different marker and
must keep whatever answer an unknown fingerprint gets today — recognising by prefix would let a future
producer change the marker's meaning while old rows silently kept the zero-commit waiver.
*/
export const CORE_EMPTY_REVIEW_INPUT_FINGERPRINT = "empty-review-input:v1";

/*
FNXC:ZeroCommitEmptyInputContentProof 2026-11-03-18:50 (RUFU-384, code-review P0):
THE OTHER HALF OF THE PROOF: not every `unavailable` diff means "there is nothing to compute".
The engine's `probeReviewDiffFingerprint` (`packages/engine/src/worktree/review-diff-fingerprint.ts`)
answers `unavailable` for three reasons, and only ONE of them is evidence of an absent checkout:
 - `missing-worktree-or-base` — no worktree path or no diff base. This IS RUFU-365's shape: the card
   authored no commits, so its checkout is gone and no patch exists to hash.
 - `git-diff-too-large` — more than 10 MiB of streamed patch. This is POSITIVE PROOF that content
   EXISTS, the opposite of what the waiver is for.
 - `git-diff-failed` — the git spawn errored, timed out, or exited non-zero while the worktree was
   present. Content may exist and be unreadable; absence is unproven.
Waving through the last two would merge content that appeared (or only became visible) AFTER a Code
Review whose approval is bound to an empty diff — precisely the FN-9234 class RUFU-337 refused and
RUFU-384's own PROMPT.md forbids weakening. So the waiver names the one reason it means, by exact
spelling, rather than matching the state alone.
*/
export const CORE_MISSING_CHECKOUT_DIFF_REASON = "missing-worktree-or-base";

/**
 * Does the selected pre-merge gate row carry the canonical empty-review-input marker?
 * Exact equality only (see the marker note above).
 */
export function hasEmptyReviewInputApproval(
  result: Partial<Pick<WorkflowStepResult, "reviewInputFingerprint">> | undefined,
): boolean {
  return result?.reviewInputFingerprint === CORE_EMPTY_REVIEW_INPUT_FINGERPRINT;
}

/*
FNXC:ZeroCommitEmptyInputContentProof 2026-11-03-17:27 (RUFU-384):
THE CONSUMER RUFU-337 deliberately left unbuilt. RUFU-337 made the empty-input shape storable (an
empty review input fingerprints to the canonical marker, and a Code Review APPROVE may bind to it)
and left the sole site that could use it — the singular `unavailable` arm of `evaluateStep` — as a hard
`unprovable-content` refusal ON PURPOSE, because recognising it there would silently merge cards whose
content vanished AFTER review. RUFU-365 is the shape that refusal was wrong about: a reconciliation card
whose own plan declared `noCommitsExpected: true`, approved over the canonical empty input, whose diff
reports `unavailable` only because there is nothing to compute — no worktree, no branch. The refusal is
not fail-closed for that card, it is terminal: the merge door, auto-merge, and the FN-9304 fence each
answered "task has no provable approval for the content being merged" about a diff that does not and
should not exist, and the card sat wedged in review with every recovery lane saying the same thing back.

The arm therefore requires every one of these facts at once, and each one closes a different hole:
  (a) the selected row carries the canonical empty-input marker — the reviewer positively approved
      THIS shape, so nothing is being inferred from a missing diff;
  (c) the card holds its own explicit zero-commit authorization (`hasZeroCommitDeliveryAuthorization`,
      read from the task ROW, never from an option or an error-sentence substring) — a card that was
      expected to deliver content cannot claim its diff is legitimately uncomputable;
  (d) this gate is one the workflow actually REQUIRED — an arm must never speak for a gate the
      workflow never asked for, and `requiredPreMergeStepIds` is what the merge door itself uses to
      decide requirement.
  (e) the unavailability is the ONE reason that proves there is no checkout to compute from
      (`CORE_MISSING_CHECKOUT_DIFF_REASON`). The reason is a required argument, not an optional filter:
      a caller that cannot say why the diff is unavailable does not get the waiver. `git-diff-too-large`
      and `git-diff-failed` keep refusing because each is evidence that content EXISTS or may exist —
      see that constant's note for the per-reason reading.

Condition (b) — the row is otherwise approving — is NOT re-derived here on purpose. The caller reaches
this question only after `evaluateStep`'s existing approval evaluation passed, so re-implementing
approval semantics here would create a second approval authority that could disagree with the door.
A pending, failed, authored-REVISE, or `remediationArchivedAt` carrier never reaches the arm at all.

What stays refused, byte-for-byte as RUFU-337 pinned it: every card NOT authorized to deliver zero
commits, every row without the marker, a real-fingerprint mismatch, the marker against an AVAILABLE
non-empty diff (that is stale-content — content appeared after review), every `unavailable` reason other
than the missing-checkout one, and the descriptorless question (`options.mergeContent` omitted), which
answers exactly as it always did. The workspace branch below the singular arms is untouched, and an
empty-marker row never binds `repositoryScopeRevision` anyway.
*/
export function evaluateZeroCommitEmptyInputContentProof(
  task: Partial<Pick<Task, "noCommitsExpected" | "id">>,
  result: Partial<Pick<WorkflowStepResult, "reviewInputFingerprint">> | undefined,
  workflowStepId: string,
  requiredPreMergeStepIds: ReadonlySet<string> | undefined,
  diffUnavailableReason: string,
): boolean {
  if (diffUnavailableReason !== CORE_MISSING_CHECKOUT_DIFF_REASON) return false;
  if (!requiredPreMergeStepIds?.has(workflowStepId)) return false;
  return hasEmptyReviewInputApproval(result)
    && hasZeroCommitDeliveryAuthorization(task);
}

/**
 * The row shape RUFU-451 repairs: a `failed` card whose only failure evidence is the workspace
 * partial-land park written for a contract that expects no commits at all.
 *
 * `noCommitsExpected` is an OPTIONAL pick so existing partial-task callers keep compiling; a caller that
 * omits it therefore does NOT get the waiver. That is the fail-closed direction — the door keeps
 * refusing and the operator sees the same sentence they see today.
 */
export function isZeroCommitWorkspaceLandPark(
  task: Pick<Task, "status" | "error"> & Partial<Pick<Task, "noCommitsExpected">>,
): boolean {
  return hasZeroCommitDeliveryAuthorization(task)
    && task.status === "failed"
    && isWorkspacePartialLandParkError(task.error);
}
