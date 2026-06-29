import { exec, execSync } from "node:child_process";
import { promisify } from "node:util";

import { canonicalFusionBranchName, resolveTaskWorkingBranch } from "./worktree-names.js";

const execAsync = promisify(exec);

export type AlreadyMergedDetectionStrategy = "trailer" | "ancestry" | "patch-id" | "tree-equal";

export interface AlreadyMergedLookupInput {
  taskId: string;
  lineageId?: string;
  repoDir: string;
  baseBranch: string;
  taskBranch?: string;
  baseCommitSha?: string;
}

export type AlreadyMergedOwnershipProof =
  | "task-trailer"
  | "lineage-trailer"
  | "subject-anchor"
  | "canonical-branch-patch"
  | "canonical-branch-tree";

export interface AlreadyMergedLookupResult {
  sha: string;
  strategy: AlreadyMergedDetectionStrategy;
  ownershipProof?: AlreadyMergedOwnershipProof;
}

export interface CommitTaskOwnership {
  owned: boolean;
  proof?: Extract<AlreadyMergedOwnershipProof, "task-trailer" | "lineage-trailer" | "subject-anchor">;
  ownerTaskId?: string;
  ownerLineageId?: string;
  rejectionReason?: "foreign-task" | "foreign-lineage";
}

interface DetectAlreadyLandedInput {
  rootDir: string;
  taskId: string;
  lineageId?: string;
  baseBranch: string;
  taskBranch?: string;
  baseCommitSha?: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function firstTrailerValue(body: string, trailer: "Fusion-Task-Id" | "Fusion-Task-Lineage"): string | undefined {
  const match = body.match(new RegExp(`(?:^|\\n)${trailer}:\\s*([^\\n]+?)\\s*(?:\\n|$)`));
  return match?.[1]?.trim();
}

/**
 * Ownership anchor shared with self-healing's already-merged recovery guards.
 *
 * The 2026-05-23 lost-work incident (bug #2) was a `git log --grep=<taskId>`
 * first-hit attribution: a commit whose body merely *mentioned* a task ID in
 * prose was accepted as that task's landed commit, stranding/mis-attributing
 * the real work. The FN-7143/FN-7187 incident added the inverse guard: explicit
 * foreign Fusion trailers are rejection evidence even when a stale branch tip,
 * patch-id, or tree-equality fallback otherwise appears to match.
 */
export function getCommitTaskOwnership(
  taskId: string,
  lineageId: string | undefined,
  subject: string,
  body: string,
): CommitTaskOwnership {
  const ownerTaskId = firstTrailerValue(body, "Fusion-Task-Id");
  const ownerLineageId = firstTrailerValue(body, "Fusion-Task-Lineage");
  if (ownerTaskId && ownerTaskId !== taskId) {
    return { owned: false, ownerTaskId, ownerLineageId, rejectionReason: "foreign-task" };
  }
  if (lineageId && ownerLineageId && ownerLineageId !== lineageId) {
    return { owned: false, ownerTaskId, ownerLineageId, rejectionReason: "foreign-lineage" };
  }
  if (ownerTaskId === taskId) {
    return { owned: true, proof: "task-trailer", ownerTaskId, ownerLineageId };
  }
  if (lineageId && ownerLineageId === lineageId) {
    return { owned: true, proof: "lineage-trailer", ownerTaskId, ownerLineageId };
  }
  // Subject anchor MUST mention the task ID — either inside a conventional
  // scope (`<type>(<…taskId…>): …`) or as a leading `<taskId>: …`. The scope
  // group is intentionally NOT optional here: a bare `feat: …` with no task ID
  // is NOT ownership evidence (a prose commit such as `feat: unrelated change`
  // whose body merely mentions the task must be rejected — incident bug #2).
  const subjectAnchor = new RegExp(
    `^(?:[A-Za-z]+\\([^)]*\\b${escapeRegex(taskId)}\\b[^)]*\\):|${escapeRegex(taskId)}:)`,
  );
  if (subjectAnchor.test(subject)) {
    return { owned: true, proof: "subject-anchor", ownerTaskId, ownerLineageId };
  }
  return { owned: false, ownerTaskId, ownerLineageId };
}

async function commitHasForeignTaskOwnership(
  repoDir: string,
  sha: string,
  taskId: string,
  lineageId: string | undefined,
): Promise<boolean> {
  const { stdout } = await execAsync(`git show -s --format=%s%x1f%b ${shellQuote(sha)}`, {
    cwd: repoDir,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  const [subject = "", body = ""] = stdout.split("\x1f");
  const ownership = getCommitTaskOwnership(taskId, lineageId, subject, body);
  return ownership.rejectionReason === "foreign-task" || ownership.rejectionReason === "foreign-lineage";
}

export async function findAlreadyMergedTaskCommit(
  input: AlreadyMergedLookupInput,
): Promise<AlreadyMergedLookupResult | null> {
  const { taskId, lineageId, repoDir, baseBranch, taskBranch, baseCommitSha } = input;

  try {
    if (lineageId) {
      const lineagePattern = `^Fusion-Task-Lineage: ${escapeRegex(lineageId)}$`;
      const lineageCommand = [
        "git log",
        `--grep=${shellQuote(lineagePattern)}`,
        "-E",
        "--max-count=1",
        "--format=%H",
        shellQuote(baseBranch),
      ].join(" ");
      const lineage = await execAsync(lineageCommand, {
        cwd: repoDir,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      const lineageSha = lineage.stdout.trim();
      if (lineageSha) {
        return { sha: lineageSha, strategy: "trailer", ownershipProof: "lineage-trailer" };
      }
    }

    const trailerPattern = `^Fusion-Task-Id: ${escapeRegex(taskId)}$`;
    const trailerCommand = [
      "git log",
      `--grep=${shellQuote(trailerPattern)}`,
      "-E",
      "--max-count=1",
      "--format=%H",
      shellQuote(baseBranch),
    ].join(" ");
    const { stdout } = await execAsync(trailerCommand, {
      cwd: repoDir,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    const sha = stdout.trim();
    if (sha) {
      return { sha, strategy: "trailer", ownershipProof: "task-trailer" };
    }
  } catch {
    // Fall through to ancestry/patch-id checks.
  }

  let branchTip: string | null = null;
  const branchName = resolveTaskWorkingBranch({ id: taskId, branch: taskBranch });
  const canonicalBranchName = canonicalFusionBranchName(taskId);
  /*
  FNXC:WorkflowRecovery 2026-06-28-21:36:
  FN-7143/FN-7187 proved patch-id and tree-equal fallbacks need branch identity proof, not just content equivalence. Only the canonical task branch may imply ownership for fallback matches, and any explicit foreign Fusion trailer on the branch tip or candidate commit rejects the recovery.
  */
  const hasCanonicalBranchIdentity = branchName === canonicalBranchName;
  let branchTipOwnershipVerified = false;
  try {
    branchTip = execSync(`git rev-parse --verify ${shellQuote(branchName)}`, {
      cwd: repoDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (await commitHasForeignTaskOwnership(repoDir, branchTip, taskId, lineageId)) {
      return null;
    }
    branchTipOwnershipVerified = true;

    execSync(`git merge-base --is-ancestor ${shellQuote(branchTip)} ${shellQuote(baseBranch)}`, {
      cwd: repoDir,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // FN-5441/5446 (2026-05-23 lost-work bug #2): `--grep=<taskId>` is a loose
    // match that also hits commits merely mentioning the task ID in prose.
    // Gather candidates (bounded) and accept only the first whose subject/body
    // is OWNERSHIP-anchored on the task — never the first raw grep hit.
    const ancestryCommand = [
      "git log",
      "--first-parent",
      "-E",
      "--format=%H%x1f%s%x1f%b%x1e",
      `--grep=${shellQuote(escapeRegex(taskId))}`,
      "--max-count=20",
      shellQuote(baseBranch),
    ].join(" ");
    const { stdout } = await execAsync(ancestryCommand, {
      cwd: repoDir,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const records = stdout
      .split("\x1e")
      .map((record) => record.trim())
      .filter((record) => record.length > 0);
    for (const record of records) {
      const [candidateSha, candidateSubject = "", candidateBody = ""] = record.split("\x1f");
      const sha = candidateSha?.trim();
      const ownership = getCommitTaskOwnership(taskId, lineageId, candidateSubject, candidateBody);
      if (sha && ownership.owned) {
        return { sha, strategy: "ancestry", ownershipProof: ownership.proof };
      }
    }
  } catch {
    // Fall through to patch-id checks.
  }

  try {
    if (!hasCanonicalBranchIdentity) {
      return null;
    }
    if (!branchTip || !branchTipOwnershipVerified) {
      branchTip = execSync(`git rev-parse --verify ${shellQuote(branchName)}`, {
        cwd: repoDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      if (await commitHasForeignTaskOwnership(repoDir, branchTip, taskId, lineageId)) {
        return null;
      }
      branchTipOwnershipVerified = true;
    }

    let branchBase = baseCommitSha?.trim();
    if (!branchBase) {
      const { stdout: mergeBaseStdout } = await execAsync(
        `git merge-base ${shellQuote(branchTip)} ${shellQuote(baseBranch)}`,
        {
          cwd: repoDir,
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        },
      );
      branchBase = mergeBaseStdout.trim();
    }

    if (!branchBase) {
      return null;
    }

    const branchPatchIdCommand = `git diff ${shellQuote(branchBase)}..${shellQuote(branchTip)} | git patch-id`;
    const { stdout: branchPatchIdOut } = await execAsync(branchPatchIdCommand, {
      cwd: repoDir,
      shell: "/bin/sh",
      timeout: 60_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    const branchPatchIdLine = branchPatchIdOut
      .trim()
      .split("\n")
      .find((line) => line.trim().length > 0);
    const branchPatchId = branchPatchIdLine?.trim().split(/\s+/)[0];
    if (!branchPatchId) {
      return null;
    }

    const basePatchMapCommand = `git log -n 200 -p --format='%H' ${shellQuote(baseBranch)} | git patch-id`;
    const { stdout: basePatchIdsOut } = await execAsync(basePatchMapCommand, {
      cwd: repoDir,
      shell: "/bin/sh",
      timeout: 60_000,
      maxBuffer: 32 * 1024 * 1024,
    });

    const basePatchMap = new Map<string, string>();
    for (const line of basePatchIdsOut.split("\n")) {
      const [patchId, sha] = line.trim().split(/\s+/);
      if (!patchId || !sha) continue;
      basePatchMap.set(patchId, sha);
    }

    const matchedSha = basePatchMap.get(branchPatchId);
    if (matchedSha && !await commitHasForeignTaskOwnership(repoDir, matchedSha, taskId, lineageId)) {
      return { sha: matchedSha, strategy: "patch-id", ownershipProof: "canonical-branch-patch" };
    }
  } catch {
    // Fall through to null when patch-id detection fails.
  }

  try {
    const treeBranchName = resolveTaskWorkingBranch({ id: taskId, branch: taskBranch });
    if (treeBranchName !== canonicalBranchName) {
      return null;
    }
    execSync(`git rev-parse --verify ${shellQuote(treeBranchName)}`, {
      cwd: repoDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    const { stdout: baseTreeStdout } = await execAsync(`git rev-parse ${shellQuote(baseBranch)}^{tree}`, {
      cwd: repoDir,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    const { stdout: branchTreeStdout } = await execAsync(`git rev-parse ${shellQuote(treeBranchName)}^{tree}`, {
      cwd: repoDir,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });

    const baseTree = baseTreeStdout.trim();
    const branchTree = branchTreeStdout.trim();
    if (baseTree && branchTree && baseTree === branchTree) {
      const { stdout: baseHeadStdout } = await execAsync(`git rev-parse ${shellQuote(baseBranch)}`, {
        cwd: repoDir,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      const baseHead = baseHeadStdout.trim();
      if (baseHead && !await commitHasForeignTaskOwnership(repoDir, baseHead, taskId, lineageId)) {
        return { sha: baseHead, strategy: "tree-equal", ownershipProof: "canonical-branch-tree" };
      }
    }
  } catch {
    // Fall through to null when tree-equality detection fails.
  }

  return null;
}

export async function detectAlreadyLandedOnMain(
  input: DetectAlreadyLandedInput,
): Promise<AlreadyMergedLookupResult | null> {
  return findAlreadyMergedTaskCommit({
    taskId: input.taskId,
    lineageId: input.lineageId,
    repoDir: input.rootDir,
    baseBranch: input.baseBranch,
    taskBranch: input.taskBranch,
    baseCommitSha: input.baseCommitSha,
  });
}
