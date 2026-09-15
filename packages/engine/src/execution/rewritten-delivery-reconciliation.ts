import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import { getCommitTaskOwnership } from "../merge/already-merged-detector.js";

const execFileAsync = promisify(execFile);

/*
FNXC:OverlapWaitSynchronization 2026-09-15-19:20:
FN-429. FN-428 waited on FN-419/FN-424/FN-426, then main was rebased onto origin/main at 17:11:40 UTC.
The delivered commits kept their patch and their `Fusion-Task-*` trailers but changed SHA
(`9ff2f99…` -> `b98b32f…`, `5408c81…` -> `bf9cd4e…`), while the predecessors' `mergeDetails.commitSha`
still named the pre-rebase SHAs. The overlap resume gate proves freshness with
`git merge-base --is-ancestor <landedSha> HEAD`, so a fresh checkout of the rewritten integration
branch failed `freshness-unproven` before Preflight and no refresh could ever repair it.

Invariant this module preserves: an ABSENT delivered SHA is never a no-op. A rewritten delivery is
recognized only on cumulative proof — readable original object, identical `git patch-id --stable`,
a `Fusion-Task-Id`/`Fusion-Task-Lineage` trailer owned by that predecessor (a `subject-anchor`
alone is REFUSED), ancestry in the execution checkout and in the declared target, and exactly one
qualified candidate. Anything ambiguous, foreign, patch-modified, or unreadable stays a bounded
refusal in the same phase; this module never approves, never cancels a wait, and never widens
backward-move authority.
*/

/** Bounded candidate window walked back from `HEAD`; a rewrite never moves a delivery further than this. */
export const REWRITTEN_DELIVERY_SEARCH_LIMIT = 200;

export interface RewrittenDeliveryReconciliationInput {
  worktreePath: string;
  repository: string;
  blockerTaskId: string;
  blockerLineageId?: string;
  target?: string;
  landedSha: string;
  searchLimit?: number;
}

export type RewrittenDeliveryReconciliationProof = "patch-id+task-trailer" | "patch-id+lineage-trailer";

export type RewrittenDeliveryReconciliationRefusal =
  | "evidence-unavailable"
  | "no-equivalent-delivery"
  | "identity-foreign"
  | "identity-ambiguous"
  | "target-mismatch";

export type RewrittenDeliveryReconciliation =
  | { outcome: "reconciled"; reconciledSha: string; proof: RewrittenDeliveryReconciliationProof }
  | { outcome: "refused"; reason: RewrittenDeliveryReconciliationRefusal };

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

interface WindowCommit {
  sha: string;
  subject: string;
  body: string;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER });
  return stdout;
}

/** `git patch-id` only reads a diff from stdin, so it cannot go through execFile's argv-only seam. */
async function patchIdOfDiff(cwd: string, diff: string): Promise<string | undefined> {
  if (diff.length === 0) return undefined;
  return await new Promise<string | undefined>((resolve, reject) => {
    const child = spawn("git", ["patch-id", "--stable"], { cwd });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) { reject(new Error(`git patch-id exited with ${String(code)}`)); return; }
      resolve(stdout.trim().split(/\s+/)[0] || undefined);
    });
    child.stdin.on("error", reject);
    child.stdin.end(diff);
  });
}

async function stablePatchId(cwd: string, sha: string): Promise<string | undefined> {
  const diff = await runGit(cwd, ["diff-tree", "-p", "--root", "--no-commit-id", sha]);
  return await patchIdOfDiff(cwd, diff);
}

async function isAncestor(cwd: string, sha: string, ref: string): Promise<boolean> {
  try {
    await runGit(cwd, ["merge-base", "--is-ancestor", sha, ref]);
    return true;
  } catch (error) {
    if ((error as { code?: number | string }).code === 1) return false;
    throw error;
  }
}

async function readWindow(cwd: string, limit: number): Promise<WindowCommit[]> {
  const stdout = await runGit(cwd, ["log", "--no-merges", `--max-count=${String(limit)}`, "--format=%H%x1f%s%x1f%b%x1e", "HEAD"]);
  return stdout.split("\x1e")
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record.trim().length > 0)
    .map((record) => {
      const [sha = "", subject = "", body = ""] = record.split("\x1f");
      return { sha: sha.trim(), subject, body };
    })
    .filter((entry) => entry.sha.length > 0);
}

function hasFusionTrailer(body: string): boolean {
  return /(?:^|\n)Fusion-Task-(?:Id|Lineage):/.test(body);
}

/**
 * Prove — or refuse — that a delivered predecessor commit was rewritten (rebase, finalize, push/pull)
 * into an equivalent commit that the execution checkout does contain. The caller must have already
 * proven the checkout clean and attempted its ordinary refresh: this helper never mutates the repository.
 */
export async function reconcileRewrittenDelivery(
  input: RewrittenDeliveryReconciliationInput,
): Promise<RewrittenDeliveryReconciliation> {
  const cwd = input.worktreePath;
  const limit = Math.max(1, input.searchLimit ?? REWRITTEN_DELIVERY_SEARCH_LIMIT);
  try {
    const objectType = (await runGit(cwd, ["cat-file", "-t", input.landedSha]).catch(() => "")).trim();
    if (objectType !== "commit") return { outcome: "refused", reason: "evidence-unavailable" };

    const expectedPatchId = await stablePatchId(cwd, input.landedSha).catch(() => undefined);
    if (!expectedPatchId) return { outcome: "refused", reason: "evidence-unavailable" };

    let resolvedTarget: string | undefined;
    if (input.target) {
      resolvedTarget = (await runGit(cwd, ["rev-parse", "--verify", "--quiet", input.target]).catch(() => "")).trim();
      if (!resolvedTarget) return { outcome: "refused", reason: "target-mismatch" };
    }

    const window = await readWindow(cwd, limit);
    const qualified: Array<{ sha: string; proof: RewrittenDeliveryReconciliationProof }> = [];
    const patchEqualForeign: string[] = [];
    const patchEqualOutsideTarget: string[] = [];

    for (const candidate of window) {
      if (candidate.sha === input.landedSha) continue;
      const ownership = getCommitTaskOwnership(input.blockerTaskId, input.blockerLineageId, candidate.subject, candidate.body);
      // `subject-anchor` alone is prose-level evidence; a rewritten delivery must carry a real trailer.
      const owned = ownership.owned && (ownership.proof === "task-trailer" || ownership.proof === "lineage-trailer");
      const foreign = ownership.rejectionReason === "foreign-task" || ownership.rejectionReason === "foreign-lineage";
      if (!owned && !(foreign && hasFusionTrailer(candidate.body))) continue;

      const candidatePatchId = await stablePatchId(cwd, candidate.sha).catch(() => undefined);
      if (!candidatePatchId || candidatePatchId !== expectedPatchId) continue;
      if (!owned) { patchEqualForeign.push(candidate.sha); continue; }
      if (!await isAncestor(cwd, candidate.sha, "HEAD")) continue;
      if (resolvedTarget && !await isAncestor(cwd, candidate.sha, resolvedTarget)) {
        patchEqualOutsideTarget.push(candidate.sha);
        continue;
      }
      qualified.push({ sha: candidate.sha, proof: ownership.proof === "task-trailer" ? "patch-id+task-trailer" : "patch-id+lineage-trailer" });
    }

    if (qualified.length === 1) {
      const [only] = qualified as [{ sha: string; proof: RewrittenDeliveryReconciliationProof }];
      return { outcome: "reconciled", reconciledSha: only.sha, proof: only.proof };
    }
    if (qualified.length > 1) return { outcome: "refused", reason: "identity-ambiguous" };
    if (patchEqualOutsideTarget.length > 0) return { outcome: "refused", reason: "target-mismatch" };
    if (patchEqualForeign.length > 0) return { outcome: "refused", reason: "identity-foreign" };
    return { outcome: "refused", reason: "no-equivalent-delivery" };
  } catch {
    // Every git failure is unreadable evidence, never an approval: the caller keeps its bounded refusal.
    return { outcome: "refused", reason: "evidence-unavailable" };
  }
}
