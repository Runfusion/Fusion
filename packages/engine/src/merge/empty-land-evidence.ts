/*
FNXC:EmptyLandEvidence 2026-09-25-10:55 (RUFU-293):
THE EMPTY-LAND VERDICT IS A CLAIM, NOT EVIDENCE — so it gets an evidence gate.

`mergeAndReview` returns `squashSha: null` when its candidate equals the integration tip with no
findings. That only proves the MERGE AGENT committed nothing inside the throwaway clean-room
checkout; it says nothing about whether the task branch still contributes unapplied work to the
integration target. RUFU-267 is the measured failure: 4 unmerged commits and a 38-file / 2614-insertion
contribution sat intact on `fusion/rufu-267` while the merge lane declared the land "empty", the
FN-8141 guard accused the executor of having "reverted or lost" the work, and after 3 identical
stalls the self-healing deadlock sweep paused the card on that false premise.

This module is the SINGLE read-only classifier every "empty land" seam routes through
(single-repo guard, workspace parity guard, self-healing stall-deadlock disposition) so the three
doors cannot drift into three different definitions of "nothing to land" — the same failure shape as
the sibling merge authorities that each grew their own copy of a merge predicate.

Three-valued outcome, deliberately NOT boolean:
  • `proven` + proof `ancestor`  — branch tip is contained in the integration tip (already integrated).
  • `proven` + proof `net-zero`  — the branch is AHEAD of the integration tip but contributes no net
    content (the FN-8141 commits+revert shape). Proof discriminant matters: net-zero is still
    laundering-prone without a landed proof, so the FN-8141 guard keeps blocking it with today's
    exact sentence. Only `ancestor` / a recorded landing may finalize.
  • `contradicted`               — the branch still contributes unapplied content. The empty verdict
    is FALSE; the merge lane malfunctioned. Never worded as lost/reverted work.
  • `unknown`                     — a probe failed, timed out, or the branch vanished mid-classification.
    Callers treat unknown as today's conservative behavior; absence of evidence is never evidence of
    absence (the same contract as `classifyBranchProbeError`).

Measurement uses the THREE-DOT range (`integration...branch`, i.e. merge-base → branch tip) on purpose:
a two-dot endpoint diff compares branch tip against an integration tip that may have advanced far
past the branch point, so it reports the whole world's changes as this branch's contribution and
reports a genuine net-zero revert as a giant diff. Three-dot measures only what the branch adds.
*/
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Default per-command bound. Same order as the other read-only merge/self-healing git probes. */
const EMPTY_LAND_GIT_TIMEOUT_MS = 30_000;

/** Which positive proof carried a `proven` verdict. Callers route on this, not just on `proven`. */
export type EmptyLandProof = "ancestor" | "net-zero";

/** Classification of an "empty land" claim against read-only branch evidence. */
export type EmptyLandEvidence = "proven" | "contradicted" | "unknown";

export interface EmptyLandEvidenceResult {
  /** Three-valued verdict; `unknown` must always take the caller's conservative path. */
  evidence: EmptyLandEvidence;
  /** Present ONLY when `evidence === "proven"`. */
  proof?: EmptyLandProof;
  /** Commits on the branch that the integration tip does not have (`rev-list --count`). */
  aheadCount?: number;
  /** Contribution size, parsed from `git diff --shortstat` (set whenever a diff was measurable). */
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
}

/**
 * One git invocation as the classifier needs to see it: a completed git run (whatever its exit
 * code) resolves, and only a spawn/timeout failure rejects. Exit code is exposed because
 * `merge-base --is-ancestor` answers "no" with exit 1 while git breaks with 128 — collapsing those
 * into a thrown error would silently downgrade a definitive negative answer to `unknown`.
 */
export interface EmptyLandGitResult {
  ok: boolean;
  stdout: string;
  exitCode: number;
}

/** Injectable git seam. Production callers pass `execEmptyLandGit(rootDir)`; tests pass a table. */
export type EmptyLandGitExec = (args: string[]) => Promise<EmptyLandGitResult>;

/**
 * FNXC:EmptyLandEvidence 2026-09-25-10:55 (RUFU-293):
 * The FN-8141 lost-work sentence, moved here so all three seams write BYTE-IDENTICAL text. It stays
 * byte-identical to the pre-RUFU-293 literal on purpose: `hasPriorAiNoOpFinalizationProof`, the
 * FN-8141 self-healing fixtures, and the CLI display path all key on shapes around this string, and
 * a behavior change owns its consumers only when it changes behavior, not the bytes of an
 * unchanged verdict.
 */
export const EMPTY_MERGE_NO_LANDED_PROOF_REASON =
  "branch had no net changes vs main — work may have been reverted or lost; operator review required";

/**
 * FNXC:EmptyLandEvidence 2026-09-25-10:55 (RUFU-293):
 * The honest diagnostic for a contradicted empty verdict. It deliberately contains NEITHER
 * "reverted or lost" NOR "had no net changes", so it can never be mistaken for the FN-8141 premise
 * by a text-keyed consumer, and it never repeats the false accusation it replaces.
 */
export const EMPTY_LAND_CONTRADICTION_REASON =
  "empty land verdict contradicted by branch content — merge-lane malfunction, work is still on the branch; operator review required";

/** Bounded run-audit event emitted once per detected contradiction. */
export const EMPTY_LAND_CONTRADICTION_EVENT = "task:empty-land-contradiction-detected";

/** Which door detected the contradiction; a fixed enum so audit can group by owner. */
export type EmptyLandEvidenceLane =
  | "ai-empty-merge"
  | "ai-empty-merge-workspace"
  | "self-healing-stall-deadlock";

/** Audit metadata for the contradiction event: ids, counts, and fixed enums ONLY (AGENTS RunAudit). */
export function emptyLandContradictionAuditMetadata(input: {
  taskId: string;
  lane: EmptyLandEvidenceLane;
  evidence: EmptyLandEvidenceResult;
  repoCount?: number;
  landedCount?: number;
}): Record<string, unknown> {
  return {
    taskId: input.taskId,
    lane: input.lane,
    evidence: "contradicted",
    aheadCount: input.evidence.aheadCount ?? null,
    filesChanged: input.evidence.filesChanged ?? null,
    insertions: input.evidence.insertions ?? null,
    deletions: input.evidence.deletions ?? null,
    ...(input.repoCount === undefined ? {} : { repoCount: input.repoCount }),
    ...(input.landedCount === undefined ? {} : { landedCount: input.landedCount }),
  };
}

/*
 * Shortstat parsing. Deliberately a local 3-regex parse rather than an import of
 * `parseShortstat` from `../self-healing-git-evidence.js`: that module is the self-healing git
 * substrate and already imports `./merge/already-merged-detector.js`, so importing it from
 * `merge/` would give the merge lane a new edge into the recovery substrate for six lines of
 * parsing. The shapes parsed here are identical.
 */
function parseShortstat(output: string): { filesChanged: number; insertions: number; deletions: number } {
  const normalized = output.trim().replace(/\s+/g, " ");
  const files = /(\d+) files? changed/.exec(normalized)?.[1];
  const insertions = /(\d+) insertions?\(\+\)/.exec(normalized)?.[1];
  const deletions = /(\d+) deletions?\(-\)/.exec(normalized)?.[1];
  return {
    filesChanged: files ? Number.parseInt(files, 10) : 0,
    insertions: insertions ? Number.parseInt(insertions, 10) : 0,
    deletions: deletions ? Number.parseInt(deletions, 10) : 0,
  };
}

/** Refs reach git as argv entries (never a shell string), but refuse obviously hostile names anyway. */
function isPlausibleRefName(value: string): boolean {
  return value.length > 0 && value.length <= 255 && /^[A-Za-z0-9][A-Za-z0-9._/\-[{}]*$/.test(value) && !value.includes("..");
}

/**
 * Classify an "empty land" claim for one branch against one integration target, read-only.
 *
 * Order is evidence-strength order: containment is the strongest and cheapest proof, so it runs
 * first and short-circuits the range probes a contradicted verdict needs.
 */
export async function classifyEmptyLandEvidence(input: {
  branch: string;
  integrationBranch: string;
  exec: EmptyLandGitExec;
}): Promise<EmptyLandEvidenceResult> {
  const { branch, integrationBranch, exec } = input;
  if (!isPlausibleRefName(branch) || !isPlausibleRefName(integrationBranch)) return { evidence: "unknown" };

  // (1) Branch tip containment in the integration tip → the work is genuinely integrated.
  let branchTip = "";
  try {
    const tip = await exec(["rev-parse", "--verify", `refs/heads/${branch}`]);
    if (!tip.ok || tip.stdout.trim().length === 0) return { evidence: "unknown" };
    branchTip = tip.stdout.trim();
  } catch {
    return { evidence: "unknown" };
  }
  try {
    const ancestor = await exec(["merge-base", "--is-ancestor", branchTip, integrationBranch]);
    if (ancestor.exitCode === 0) return { evidence: "proven", proof: "ancestor", aheadCount: 0 };
    // Exit 1 is git's definitive "no". Anything else (128, killed, spawn failure) is evidence loss.
    if (ancestor.exitCode !== 1) return { evidence: "unknown" };
  } catch {
    return { evidence: "unknown" };
  }

  // (2) Ahead of the target: measure what the branch ACTUALLY contributes (three-dot range).
  let aheadCount: number | undefined;
  try {
    const ahead = await exec(["rev-list", "--count", `${integrationBranch}..${branch}`]);
    const parsed = Number.parseInt(ahead.stdout.trim(), 10);
    if (!ahead.ok || !Number.isFinite(parsed) || parsed < 0) return { evidence: "unknown" };
    aheadCount = parsed;
  } catch {
    return { evidence: "unknown" };
  }

  try {
    const diff = await exec(["diff", "--shortstat", `${integrationBranch}...${branch}`]);
    if (!diff.ok) return { evidence: "unknown", aheadCount };
    if (diff.stdout.trim().length === 0) {
      // Ahead but contributing nothing: the commits+revert shape FN-8141 was written for.
      return { evidence: "proven", proof: "net-zero", aheadCount, filesChanged: 0, insertions: 0, deletions: 0 };
    }
    const stats = parseShortstat(diff.stdout);
    return { evidence: "contradicted", aheadCount, ...stats };
  } catch {
    return { evidence: "unknown", aheadCount };
  }
}

/**
 * Production git seam for the classifier: argv-only (no shell), bounded, and it maps any completed
 * git run — including a non-zero exit — to a result so the classifier can read exit codes. Only a
 * spawn failure or a timeout kills the promise, which the classifier records as `unknown`.
 */
export interface WorkspaceEmptyLandRepo {
  /** Sub-repo identity as the caller knows it; this module never interprets or returns it. */
  repo: string;
  branch: string;
  integrationBranch: string;
  repoRootDir: string;
}

export interface WorkspaceEmptyLandDecision {
  /** True when finalize must be blocked: no empty sub-repo could prove its work landed. */
  blocksFinalize: boolean;
  /** How many empty sub-repos still hold unapplied content (drives which sentence the caller says). */
  contradictedRepoCount: number;
  /** First contradicted measurement, for audit counts. */
  evidence?: EmptyLandEvidenceResult;
}

/*
FNXC:EmptyLandEvidence 2026-09-25-10:55 (RUFU-293):
The workspace parity guard's decision table, extracted so the routing is unit-testable without a
leased multi-repo workspace ( Standing Rule: prefer narrow seams over mock-the-world shells). Semantics
are the parity mirror of the single-repo guard, per sub-repo:
  • proven `ancestor`   → safe no-op, keep scanning (zero-ahead / already-integrated).
  • proven `net-zero`   → block as the FN-8141 lost-work shape (ahead of the target, contributing
    nothing = committed-then-reverted, which has no landed proof).
  • contradicted        → counted, scanning continues so a sibling lost-work repo is still found;
    the contradiction decides the sentence when the scan ends with both shapes present.
  • unknown             → block as the FN-8141 lost-work shape. This is also the branch-vanished
    case (`rev-parse` yields nothing) and the git-broken case, both previously blocked here.
`landedCount > 0` and `noCommitsExpected` skip the whole question, exactly as the inline loop did.
*/
/**
 * FNXC:EmptyLandEvidence 2026-10-23-11:40 (RUFU-293 integration):
 * `TRepo` is generic so the workspace call site passes its richer `WorkspaceRepoLandResult[]` straight
 * through and receives THAT type back in `classify`. Erasing the element type to this base shape cost
 * the callback the one field its default classifier reads (`integrationBranch`) — a compile error at the
 * call site, not a style question. Purely type-level: no runtime branch, no change to any verdict.
 */
export async function evaluateWorkspaceEmptyLand<TRepo extends WorkspaceEmptyLandRepo>(input: {
  noCommitsExpected?: boolean;
  repos: readonly TRepo[];
  landedCount: number;
  classify?: (repo: TRepo) => Promise<EmptyLandEvidenceResult>;
}): Promise<WorkspaceEmptyLandDecision> {
  const { noCommitsExpected, repos, landedCount } = input;
  if (noCommitsExpected === true || repos.length === 0 || landedCount > 0) {
    return { blocksFinalize: false, contradictedRepoCount: 0 };
  }
  const classify = input.classify
    ?? ((repo: TRepo) => classifyEmptyLandEvidence({
      branch: repo.branch,
      integrationBranch: repo.integrationBranch,
      exec: execEmptyLandGit(repo.repoRootDir),
    }));

  let contradictedRepoCount = 0;
  let evidence: EmptyLandEvidenceResult | undefined;
  for (const repo of repos) {
    const result = await classify(repo);
    if (result.evidence === "proven") {
      if (result.proof === "ancestor") continue;
      return { blocksFinalize: true, contradictedRepoCount, ...(evidence ? { evidence } : {}) };
    }
    if (result.evidence === "contradicted") {
      contradictedRepoCount += 1;
      evidence ??= result;
      continue;
    }
    return { blocksFinalize: true, contradictedRepoCount, ...(evidence ? { evidence } : {}) };
  }
  // Only contradicted sub-repos were found: the empty verdict is false, so nothing may finalize.
  return { blocksFinalize: contradictedRepoCount > 0, contradictedRepoCount, ...(evidence ? { evidence } : {}) };
}

export function execEmptyLandGit(
  rootDir: string,
  timeoutMs: number = EMPTY_LAND_GIT_TIMEOUT_MS,
): EmptyLandGitExec {
  return async (args: string[]) => {
    try {
      const { stdout } = await execFileAsync("git", args, { cwd: rootDir, timeout: timeoutMs, maxBuffer: 1024 * 1024 });
      return { ok: true, stdout, exitCode: 0 };
    } catch (error: unknown) {
      const err = error as { code?: unknown; killed?: unknown; signal?: unknown; stdout?: unknown };
      if (err.killed === true || (typeof err.signal === "string" && err.signal.length > 0)) throw error;
      const code = typeof err.code === "number" ? err.code : 1;
      return { ok: false, stdout: typeof err.stdout === "string" ? err.stdout : "", exitCode: code };
    }
  };
}
