/*
FNXC:WorkspaceMergeFinalization 2026-10-02-21:52 (RUFU-504):
A workspace card whose declared repositories were all already integrated delivers real work and still
produces zero commits: every `fusion/<id>` branch tip equals (or is contained in) the repository's own
integration branch. Before this file the workspace lane could only express two outcomes — "some repo landed
with a sha" or "nothing happened" — so `finalizeWorkspaceTask` wrote `mergeConfirmed: anyLanded`, the shared
finalizer's `hasDurableMergeProof` saw no proof, and the card was refused with the generic
`missing-merge-confirmation`. That refusal is unrecoverable from inside the lane: the stale `failed` row it
leaves behind is itself a merge blocker, so fixing the cause does not release cards already terminalised by
it (measured on the saneca review lane: 15 parked siblings on one sentence).

Rules this file owns:
  • Zero commits is only a DELIVERY when git corroborates it per repository. A land-result status of
    `empty` is a claim under test, never the proof — the same posture the singular lane's
    `enforceZeroCommitLandingProof` takes (RUFU-274) and the reason `noCommitsExpected` is not consulted
    here (the marker is optional; the probe is the evidence).
  • One probe implementation for the whole lane. The empty-merge finalize guard and the delivery decision
    both read this module, so the two cannot disagree about what "zero ahead" meant on a given pass.
  • An unprovable repository is never folded into a delivery. It yields `undelivered`, which keeps today's
    refusal, because claiming a commit-free delivery the probe could not corroborate is exactly the
    RUFU-262 shape this repo already lost work to.
  • No sha is ever invented. `landed` keeps the only sha-bearing status; a commit-free delivery carries
    branch-tip SHAs as *evidence about the branch*, in a field that is not read as a landing.
*/

/**
 * The structural minimum this module reads off a landing result. Declared here rather than imported from
 * `merger-ai.js` on purpose: the engine already dissolved one cycle between the workspace merge modules
 * (`isRepoLanded` → `workspace-land-predicate.ts`), and a type-only import would still make the lane's
 * dependency graph circular to a static reader. `WorkspaceRepoLandResult` satisfies this shape.
 */
export interface WorkspaceRepoLandingLike {
  repo: string;
  repoRootDir: string;
  integrationBranch: string;
  branch: string;
  status: "landed" | "empty" | "failed";
}

/** What the probe established about one repository's branch, at probe time. */
export type WorkspaceCommitFreeBasis =
  /** Branch tip resolves and is an ancestor of the repo's integration branch: zero commits ahead. */
  | "zero-ahead"
  /** Branch gone, or tip NOT an ancestor (ahead-but-net-zero, i.e. reverted/lost shape). */
  | "unproven";

export interface WorkspaceCommitFreeProbeInput {
  /** The `workspaceWorktrees` key (repo-relative path). */
  repo: string;
  /** Absolute path to that sub-repo's checkout, which is where the refs are resolved. */
  repoRootDir: string;
  /** The `fusion/<id>` branch this card carried in that repository. */
  branch: string;
  /** The per-repo integration branch the landing would have reached. */
  integrationBranch: string;
}

export interface WorkspaceCommitFreeRepoEvidence extends WorkspaceCommitFreeProbeInput {
  basis: WorkspaceCommitFreeBasis;
  /** Present whenever the branch resolved, including the `unproven` ahead-but-empty shape. */
  branchTipSha?: string;
}

/**
 * Injected so this module owns the DECISION while the caller owns the shellout. `merger-ai.ts` passes its
 * own `git`/`gitOk`; a test passes an in-process table. A skipped probe is an absent probe: this must never
 * gain a default that reports `zero-ahead` without having looked.
 */
export type WorkspaceTipAncestryProbe = (
  input: WorkspaceCommitFreeProbeInput,
) => Promise<{ basis: WorkspaceCommitFreeBasis; branchTipSha?: string }>;

/** Runs one git command and resolves with trimmed stdout, rejecting on a non-zero exit. */
export type GitTextRunner = (args: string[], cwd: string) => Promise<string>;

/**
 * Builds the probe over a git runner, so the literal ancestry expression lives in THIS module and is
 * reachable from a test with a real repository. The convention matches `merger-ai.ts`'s `git()`: a rejected
 * run means git said no (`merge-base --is-ancestor` exits 1 when the sha is not an ancestor), never an
 * exception worth surfacing — an unresolvable branch and a refused ancestry are both simply "not proven".
 */
export function createTipAncestryProbe(runGit: GitTextRunner): WorkspaceTipAncestryProbe {
  return async ({ repoRootDir, branch, integrationBranch }) => {
    const tip = await runGit(["rev-parse", "--verify", `refs/heads/${branch}`], repoRootDir).catch(() => "");
    if (!tip) return { basis: "unproven" };
    try {
      await runGit(["merge-base", "--is-ancestor", tip, integrationBranch], repoRootDir);
      return { basis: "zero-ahead", branchTipSha: tip };
    } catch {
      // Tip exists but is NOT contained in the integration branch: ahead-but-net-zero, the FN-8141
      // reverted/lost shape. Never a delivery.
      return { basis: "unproven", branchTipSha: tip };
    }
  };
}

/** Repositories whose landing produced a sha carry their own proof and need no ancestry probe. */
export function reposNeedingCommitFreeProbe(repos: WorkspaceRepoLandingLike[]): WorkspaceRepoLandingLike[] {
  return repos.filter((repo) => repo.status !== "landed");
}

export async function probeWorkspaceCommitFree(
  repos: WorkspaceCommitFreeProbeInput[],
  probe: WorkspaceTipAncestryProbe,
): Promise<WorkspaceCommitFreeRepoEvidence[]> {
  const evidence: WorkspaceCommitFreeRepoEvidence[] = [];
  for (const repo of repos) {
    const result = await probe(repo);
    evidence.push({ ...repo, basis: result.basis, ...(result.branchTipSha ? { branchTipSha: result.branchTipSha } : {}) });
  }
  return evidence;
}

export type WorkspaceDeliveryKind =
  /** At least one repository received a recorded commit. Today's only accepted delivery. */
  | "landed-delivery"
  /** No repository produced a commit, and every repository was proven zero-ahead. */
  | "commit-free-delivery"
  /** Neither: keep the existing refusal. */
  | "undelivered";

export interface WorkspaceDeliveryDecision {
  kind: WorkspaceDeliveryKind;
  /**
   * What `mergeDetails.mergeConfirmed` and `MergeResult.mergeConfirmed` become. `hasDurableMergeProof`
   * reads exactly this, so it is the whole of what this decision changes downstream.
   */
  mergeConfirmed: boolean;
  /** Written as `mergeDetails.noOpReason` for a commit-free delivery; never an error sentence. */
  noOpReason?: string;
  /** Per-repo basis, kept so a later reader can tell commit-free from landed without re-probing. */
  commitFreeBasis?: Record<string, WorkspaceCommitFreeBasis>;
  /** Branch tips observed, as corroboration of the basis — NOT landing shas. */
  commitFreeBranchTipShas?: Record<string, string>;
}

/**
 * The lane's whole terminal judgement, as a pure function of the landing results plus per-repo ancestry
 * evidence. Kept pure so the two directions that matter — "zero commits is a delivery only when proven" and
 * "one unproven repo is not a delivery" — are testable without a repository or a store.
 */
export function decideWorkspaceDelivery(input: {
  repoCount: number;
  landedCount: number;
  evidence: WorkspaceCommitFreeRepoEvidence[];
}): WorkspaceDeliveryDecision {
  const basis: Record<string, WorkspaceCommitFreeBasis> = {};
  const tipShas: Record<string, string> = {};
  for (const repo of input.evidence) {
    basis[repo.repo] = repo.basis;
    if (repo.branchTipSha) tipShas[repo.repo] = repo.branchTipSha;
  }
  const hasBasis = Object.keys(basis).length > 0;
  if (input.landedCount > 0) {
    return { kind: "landed-delivery", mergeConfirmed: true, ...(hasBasis ? { commitFreeBasis: basis } : {}) };
  }
  if (input.repoCount > 0 && input.repoCount === input.evidence.length && input.evidence.every((r) => r.basis === "zero-ahead")) {
    return {
      kind: "commit-free-delivery",
      mergeConfirmed: true,
      noOpReason: COMMIT_FREE_DELIVERY_REASON,
      commitFreeBasis: basis,
      ...(Object.keys(tipShas).length > 0 ? { commitFreeBranchTipShas: tipShas } : {}),
    };
  }
  return { kind: "undelivered", mergeConfirmed: false, ...(hasBasis ? { commitFreeBasis: basis } : {}) };
}

/**
 * The sentence stored as `mergeDetails.noOpReason`. It states the claim git was made to corroborate, so a
 * reader can re-derive it — and it is deliberately not phrased as a failure, because a commit-free delivery
 * is a completed card, not a parked one.
 */
export const COMMIT_FREE_DELIVERY_REASON =
  "commit-free delivery: every declared repository's task branch tip is an ancestor of that repository's integration branch, so the landing created no new commit anywhere";

/** Aggregate counts for the delivery summary line on the card. */
export function summarizeCommitFreeEvidence(evidence: WorkspaceCommitFreeRepoEvidence[]): string {
  return evidence.map((repo) => `${repo.repo} {basis=${repo.basis}${repo.branchTipSha ? `; tip=${repo.branchTipSha.slice(0, 12)}` : "; tip=none"}}`).join("; ");
}

/*
FNXC:WorkspaceLandedReconcile 2026-11-01-08:10 (RUFU-357):
The reconcile side (operator-run `fn task reconcile`, the HTTP reconcile route, and the shared
`reconcileLandedReviewTask` fence) needed the SAME per-repository authority as this module's merge-side
door, because the two lanes ask one question — "is this card's work already fully integrated in every
repository?" — and two answers is the drift this repo has repeatedly lost cards to (see the empty-land
and land-predicate headers). The saneca board is the measured population: 16 workspace review cards with
a summed unique-commit count of 0 across root + both sub-repos sat `in-review` + `failed` behind the
engine's own `in-review-stall-deadlock` park while the fence refused them with the blanket word
`workspace` before a single git check ran. A card with no content left to review does not need a review
bypass; it needs this proof.

Facts this predicate owns, and why the vocabulary matters:
  • `zero-ahead` and `net-zero` are different facts with OPPOSITE consequences. `zero-ahead` = the branch
    tip is an ancestor of that repository's own resolved base (git corroborated by
    `measureAheadCommitCount === 0`) — the saneca `uniq=0` shape, and a discharge here. `net-zero` (the
    `EmptyLandProof` discriminant) = the branch is AHEAD of its target while contributing nothing — the
    FN-8141 committed-then-reverted shape with no landed proof — and it is NEVER a discharge; it maps to
    `basis: "reverted"` and stays a refusal. Confusing the two would finalize lost work.
  • An unprovable repository is never folded into a discharge. `measureAhead === null` means the count
    could not be read (gone branch, unresolvable base ref, mid-operation repo) — that is a refusal naming
    the repository, not an absence of evidence to wave through. Same posture as the probe above: skipped
    probes are absent probes, and this function has no default that reports zero-ahead without looking.
  • The aggregate mirrors `decideWorkspaceDelivery` rather than re-deriving it: when every repository
    needed the ancestry probe and none reported landed, the verdict is THAT function's verdict, so the
    merge lane and the reconcile fence cannot disagree about what `zero-ahead` meant on a given pass.
    The mixed "some landed, some probed" shape deliberately does NOT route through it — its
    `repoCount === evidence.length` condition cannot answer that shape — and discharges (or refuses)
    from the per-repo verdicts directly.
  • No landing SHA is invented. `landed` discharges delegate to the canonical landed predicate
    (`isRepoLanded`/`findProvenLandedCommit`) unchanged via injection; `zero-ahead` carries only the
    observed branch tip, which is evidence about a branch, never a claim that this card authored a commit.

Like the rest of this module, the decision lives here while the caller owns every shellout: identity
classification (`resolveWorkspaceRootMembership`), base resolution, the landed predicate, the branch
probe, and the ahead-count measurement all arrive as injected seams, keeping the module free of
`self-healing.ts` dependencies and unit-testable with an in-process table.
*/

/** The slice of a `workspaceWorktrees` entry this predicate reads. */
export interface WorkspaceReconcileDischargeEntry {
  /** The `fusion/<id>` branch this card carries in that repository. */
  branch: string;
  /** The recorded base this repository must eventually target (`entry.baseBranch`). */
  baseBranch?: string;
  /** Recorded landing sha, if a land persisted one. */
  landedSha?: string;
  /** Revert boundary for the landed predicate's trailer scan. */
  revertBoundarySha?: string;
}

/** Why a repository was NOT discharged. Every member is a refusal; none is wordable as a delivery. */
export type WorkspaceReconcileHeldBasis =
  /** Branch resolves, is ahead of the repository's own base, and contributes content. */
  | "ahead"
  /** The `net-zero` shape: ahead of base, three-dot contribution empty — committed-then-reverted, no landed proof. */
  | "reverted"
  /** The branch ref is absent and the repository has no landed proof. */
  | "branch-absent"
  /** Git could not answer (unreadable repo, unresolvable tip, contradictory reads, unknown branch state). */
  | "unproven"
  /** The repository's own integration branch could not be resolved. */
  | "base-unresolvable";

/** Per-repository discharge verdict. */
export type WorkspaceReconcileRepoVerdict =
  | { repo: string; kind: "discharged"; basis: "zero-ahead" | "landed"; branchTipSha?: string }
  | { repo: string; kind: "held"; basis: WorkspaceReconcileHeldBasis; uniqueCommitCount: number | null };

export interface WorkspaceReconcileDischargeResult {
  /** True only when the obligation set is non-empty AND every repository discharged. */
  discharge: boolean;
  /** The obligation set was empty — a refusal, never an empty-set discharge. */
  scopeEmpty: boolean;
  /** Every per-repo verdict, in `repoKeys` order. */
  repos: WorkspaceReconcileRepoVerdict[];
  /** The held subset (refusal wording names these). */
  heldRepos: Array<Extract<WorkspaceReconcileRepoVerdict, { kind: "held" }>>;
  /**
   * Probe evidence per repository that reached the ancestry probe, in the persisted
   * `mergeDetails.workspaceCommitFreeBasis` vocabulary. Repositories that discharged via `landed` or
   * never reached the probe are deliberately absent — `unproven` here would misdescribe a landed repo.
   */
  commitFreeBasis?: Record<string, WorkspaceCommitFreeBasis>;
  /** Observed tips for probed repositories — corroboration of the basis, NOT landing shas. */
  commitFreeBranchTipShas?: Record<string, string>;
}

export interface WorkspaceReconcileDischargeInput {
  /** The obligation set: confirmed-scope repository keys the card owes delivery in. */
  repoKeys: readonly string[];
  /** `task.workspaceWorktrees` (or the slice above) keyed the same way. */
  entries: Readonly<Record<string, WorkspaceReconcileDischargeEntry | undefined>>;
  /**
   * Identity-classified absolute checkout dir for the key, or `undefined` when the entry cannot be
   * measured at all (unknown membership, missing directory). Classification happens BEFORE this is
   * consulted (RUFU-390/RUFU-519: measuring a member in a directory whose top-level is an enclosing
   * repository certifies a delivery never made); a `workspace-root-repository` member must be passed
   * the ROOT repository's directory — the entry then names the repository actually measured.
   */
  resolveRepoRootDir: (repo: string) => string | undefined;
  /** Resolves the repository's OWN integration/base branch; `undefined` = unresolvable. */
  probeIntegrationBranch: (
    repo: string,
    entry: WorkspaceReconcileDischargeEntry,
    repoRootDir: string,
  ) => Promise<string | undefined>;
  /** The canonical landed predicate, wired by the caller (production: `isRepoLanded` closure). */
  isLanded: (input: {
    repo: string;
    repoRootDir: string;
    integrationBranch: string;
    entry: WorkspaceReconcileDischargeEntry;
  }) => Promise<boolean>;
  /** RUFU-504's ancestry probe (production: `createTipAncestryProbe`). */
  probe: WorkspaceTipAncestryProbe;
  /** The canonical ahead-count measurement (production: `measureAheadCommitCount`); `null` = unreadable. */
  measureAhead: (input: { repoDir: string; integrationBranch: string; branch: string }) => Promise<number | null>;
  /**
   * Optional three-valued branch presence (production: `SelfHealingManager.probeRepoBranch`). Used only
   * when the ancestry probe resolved no tip, to say `branch-absent` on PROVEN absence instead of
   * guessing between "gone" and "unreadable".
   */
  probeBranch?: (repoRootDir: string, branch: string) => Promise<"present" | "absent" | "unknown">;
  /**
   * Optional ahead diagnosis (production: `classifyEmptyLandEvidence` + `execEmptyLandGit`). Used ONLY
   * to explain a refusal: it maps the ahead-but-contributionless shape to `reverted`, fills an
   * `aheadCount` when `measureAhead` could not, and NEVER licenses a discharge.
   */
  diagnoseAhead?: (input: {
    repo: string;
    repoRootDir: string;
    branch: string;
    integrationBranch: string;
  }) => Promise<{ evidence: "proven" | "contradicted" | "unknown"; proof?: "ancestor" | "net-zero"; aheadCount?: number }>;
}

/**
 * Per-repository discharge proof for the landed-review reconcile fence. Every repository in the
 * obligation set must discharge (`zero-ahead` git-corroborated, or `landed` via the canonical
 * predicate) before the aggregate says `discharge: true`; any held repository names itself with its
 * unique-commit count (or `null` = unproven) for the refusal wording.
 */
export async function evaluateWorkspaceReconcileDischarge(
  input: WorkspaceReconcileDischargeInput,
): Promise<WorkspaceReconcileDischargeResult> {
  const { repoKeys, entries, resolveRepoRootDir, probeIntegrationBranch, isLanded, probe, measureAhead, probeBranch, diagnoseAhead } = input;
  const repos: WorkspaceReconcileRepoVerdict[] = [];
  /** Probe-stage evidence, kept for the decideWorkspaceDelivery mirror and the persisted basis map. */
  const probeEvidence: WorkspaceCommitFreeRepoEvidence[] = [];

  for (const repo of repoKeys) {
    const entry = entries[repo];
    if (!entry) {
      // Belt: callers gate scope/entry mismatches earlier (workspace-scope-unresolved); inside the
      // predicate an unmeasurable key is simply held, never an assumed discharge.
      repos.push({ repo, kind: "held", basis: "unproven", uniqueCommitCount: null });
      continue;
    }
    const repoRootDir = resolveRepoRootDir(repo);
    if (!repoRootDir) {
      repos.push({ repo, kind: "held", basis: "unproven", uniqueCommitCount: null });
      continue;
    }
    const integrationBranch = await probeIntegrationBranch(repo, entry, repoRootDir);
    if (!integrationBranch) {
      repos.push({ repo, kind: "held", basis: "base-unresolvable", uniqueCommitCount: null });
      continue;
    }
    // Landed proof is the strongest discharge and skips the ancestry probe entirely — a squash land
    // advances the integration ref PAST the branch, so ancestry would answer "unproven" about a
    // repository whose delivery is durable (`reposNeedingCommitFreeProbe` is the merge-side mirror).
    if (await isLanded({ repo, repoRootDir, integrationBranch, entry })) {
      // No evidence row and no tip for a landed repository: `unproven` beside a durable landing would
      // misdescribe the delivery in the persisted basis map, and re-resolving the tip would buy an
      // observation of a branch whose delivery no longer depends on it.
      repos.push({ repo, kind: "discharged", basis: "landed" });
      continue;
    }
    if (!entry.branch) {
      repos.push({ repo, kind: "held", basis: "branch-absent", uniqueCommitCount: null });
      continue;
    }
    const probed = await probe({ repo, repoRootDir, branch: entry.branch, integrationBranch });
    probeEvidence.push({
      repo,
      repoRootDir,
      branch: entry.branch,
      integrationBranch,
      basis: probed.basis,
      ...(probed.branchTipSha ? { branchTipSha: probed.branchTipSha } : {}),
    });
    if (probed.basis === "zero-ahead") {
      // Containment is the claim; the canonical count corroborates it. A non-zero or unreadable count
      // contradicts (or fails to corroborate) the probe, and the refusal names the repository.
      const count = await measureAhead({ repoDir: repoRootDir, integrationBranch, branch: entry.branch });
      if (count === 0) {
        repos.push({ repo, kind: "discharged", basis: "zero-ahead", ...(probed.branchTipSha ? { branchTipSha: probed.branchTipSha } : {}) });
      } else if (count === null) {
        repos.push({ repo, kind: "held", basis: "unproven", uniqueCommitCount: null });
      } else {
        repos.push({ repo, kind: "held", basis: "ahead", uniqueCommitCount: count });
      }
      continue;
    }
    // Probe said "not contained". With a resolved tip the repository is ahead — measure, then explain;
    // without a tip it is branch-gone-or-unreadable — only a proven absence says `branch-absent`.
    if (probed.branchTipSha) {
      const count = await measureAhead({ repoDir: repoRootDir, integrationBranch, branch: entry.branch });
      // Explanation runs exactly where a refusal is already the outcome: an unreadable count, or any
      // positive count, may still be the `net-zero` reverted shape, and `reverted` names that fact.
      // Diagnosis NEVER discharges — it only chooses which refusal word the repository gets.
      const refined = count !== 0 && diagnoseAhead
        ? await diagnoseAhead({ repo, repoRootDir, branch: entry.branch, integrationBranch })
        : undefined;
      if (refined?.evidence === "proven" && refined.proof === "net-zero") {
        repos.push({ repo, kind: "held", basis: "reverted", uniqueCommitCount: refined.aheadCount ?? count });
        continue;
      }
      if (count === null) {
        // The count could not be read; a contradicted classification still proves the branch holds
        // content and may carry the count the canonical measure could not.
        if (refined?.evidence === "contradicted" && typeof refined.aheadCount === "number") {
          repos.push({ repo, kind: "held", basis: "ahead", uniqueCommitCount: refined.aheadCount });
        } else {
          repos.push({ repo, kind: "held", basis: "unproven", uniqueCommitCount: null });
        }
        continue;
      }
      if (count > 0) {
        repos.push({ repo, kind: "held", basis: "ahead", uniqueCommitCount: count });
        continue;
      }
      // Count 0 while the tip is NOT an ancestor means the refs moved between reads — evidence loss,
      // not zero-ness. Never a discharge.
      repos.push({ repo, kind: "held", basis: "unproven", uniqueCommitCount: count });
      continue;
    }
    if (probeBranch) {
      const state = await probeBranch(repoRootDir, entry.branch);
      if (state === "absent") {
        repos.push({ repo, kind: "held", basis: "branch-absent", uniqueCommitCount: null });
        continue;
      }
      if (state === "unknown") {
        repos.push({ repo, kind: "held", basis: "unproven", uniqueCommitCount: null });
        continue;
      }
      // Proven present yet unprobed by ancestry: report the raw count (may itself be null) as unproven.
      const count = await measureAhead({ repoDir: repoRootDir, integrationBranch, branch: entry.branch });
      repos.push({ repo, kind: "held", basis: "unproven", uniqueCommitCount: count });
      continue;
    }
    repos.push({ repo, kind: "held", basis: "unproven", uniqueCommitCount: null });
  }

  const heldRepos = repos.filter((r): r is Extract<WorkspaceReconcileRepoVerdict, { kind: "held" }> => r.kind === "held");
  const scopeEmpty = repoKeys.length === 0;
  const landedCount = repos.filter((r) => r.kind === "discharged" && r.basis === "landed").length;
  // Mirror `decideWorkspaceDelivery` EXACTLY when the shape is pure-probe (no repository landed and
  // every declared repository reached the probe). Any other shape — mixed landed/probed — must not ask
  // that function, whose repoCount === evidence.length guard cannot answer it.
  const pureProbeShape = !scopeEmpty && landedCount === 0 && probeEvidence.length === repoKeys.length;
  const mirrorDischarge = pureProbeShape
    ? decideWorkspaceDelivery({ repoCount: repoKeys.length, landedCount: 0, evidence: probeEvidence }).kind === "commit-free-delivery"
    : true;
  const discharge = !scopeEmpty && heldRepos.length === 0 && mirrorDischarge;

  const basis: Record<string, WorkspaceCommitFreeBasis> = {};
  const tipShas: Record<string, string> = {};
  for (const evidence of probeEvidence) {
    basis[evidence.repo] = evidence.basis;
    if (evidence.branchTipSha) tipShas[evidence.repo] = evidence.branchTipSha;
  }

  return {
    discharge,
    scopeEmpty,
    repos,
    heldRepos,
    ...(Object.keys(basis).length > 0 ? { commitFreeBasis: basis } : {}),
    ...(Object.keys(tipShas).length > 0 ? { commitFreeBranchTipShas: tipShas } : {}),
  };
}
