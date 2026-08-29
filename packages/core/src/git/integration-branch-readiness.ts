import { isFusionSiblingBranch } from "../merge/task-merge.js";
import type { GitRepositoryCommandRunner } from "./git-repository.js";

export const WELL_KNOWN_INTEGRATION_BRANCHES = ["main", "master", "trunk", "develop"] as const;

export type IntegrationBranchSource =
  | "configured"
  | "origin-head"
  | "well-known-local"
  | "current-head"
  | "sole-local"
  | "remote-tracking";

export interface IntegrationBranchSelectionInput {
  configuredBranch?: string;
  originHeadBranch?: string;
  localBranches: string[];
  currentBranch?: string;
  remoteBranches?: string[];
}

export interface IntegrationBranchSelection {
  branch: string;
  source: IntegrationBranchSource;
}

function normalizedBranches(branches: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const branch of branches ?? []) {
    const candidate = typeof branch === "string" ? branch.trim() : "";
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    normalized.push(candidate);
  }
  return normalized;
}

function normalizedBranch(branch: string | undefined): string {
  return typeof branch === "string" ? branch.trim() : "";
}

function firstWellKnownBranch(branches: readonly string[]): string | null {
  return WELL_KNOWN_INTEGRATION_BRANCHES.find((branch) => branches.includes(branch)) ?? null;
}

/**
 * Selects an integration branch without reading Git or changing refs.
 *
 * FNXC:IntegrationBranchReadiness 2026-08-24-00:37:
 * FN-183 requires project registration to adopt an existing branch or create one,
 * never leave an operator with an unresolvable merge target. Local candidates rank
 * before remote-tracking candidates so a usable local branch is never retargeted to
 * a remote name; remote tiers only recover the old blind-main failure state where
 * local inference found nothing. Fusion sibling branches are task start points, not
 * project integration targets, and are excluded from inferred local and remote tiers.
 */
export function selectIntegrationBranch(
  inputs: IntegrationBranchSelectionInput,
): IntegrationBranchSelection | null {
  const configuredBranch = normalizedBranch(inputs.configuredBranch);
  if (configuredBranch) return { branch: configuredBranch, source: "configured" };

  const originHeadBranch = normalizedBranch(inputs.originHeadBranch);
  if (originHeadBranch) return { branch: originHeadBranch, source: "origin-head" };

  const localBranches = normalizedBranches(inputs.localBranches);
  const wellKnownLocal = firstWellKnownBranch(localBranches);
  if (wellKnownLocal) return { branch: wellKnownLocal, source: "well-known-local" };

  const currentBranch = normalizedBranch(inputs.currentBranch);
  if (currentBranch && localBranches.includes(currentBranch) && !isFusionSiblingBranch(currentBranch)) {
    return { branch: currentBranch, source: "current-head" };
  }

  const inferredLocalBranches = localBranches.filter((branch) => !isFusionSiblingBranch(branch));
  if (inferredLocalBranches.length === 1) {
    return { branch: inferredLocalBranches[0], source: "sole-local" };
  }

  const remoteBranches = normalizedBranches(inputs.remoteBranches)
    .filter((branch) => !isFusionSiblingBranch(branch));
  const wellKnownRemote = firstWellKnownBranch(remoteBranches);
  if (wellKnownRemote) return { branch: wellKnownRemote, source: "remote-tracking" };

  if (remoteBranches.length === 1) {
    return { branch: remoteBranches[0], source: "remote-tracking" };
  }

  return null;
}

export interface IntegrationBranchReconciliation {
  repoRelPath: string;
  branch: string;
  source: IntegrationBranchSource | "fallback";
  action: "existing" | "created-from-remote" | "created-from-head" | "unavailable";
  reason?: string;
}

export interface EnsureIntegrationBranchLocalRefOptions {
  runner: GitRepositoryCommandRunner;
  timeoutMs: number;
  configuredBranch?: string;
  repoRelPath?: string;
}

function normalizeGitBranch(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\/origin\//, "")
    .replace(/^origin\//, "");
}

function parseGitBranchList(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map(normalizeGitBranch)
    .filter(Boolean);
}

async function probeGit(
  repoPath: string,
  args: string[],
  options: EnsureIntegrationBranchLocalRefOptions,
): Promise<string> {
  try {
    return (await options.runner("git", ["-C", repoPath, ...args], { timeout: options.timeoutMs })).stdout;
  } catch {
    return "";
  }
}

function materializationFailureReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const normalized = raw.replace(/\s+/g, " ").trim();
  return normalized.slice(0, 240) || "git branch could not create the selected ref";
}

/**
 * Ensures the selected branch has a local ref without changing HEAD or contacting a remote.
 *
 * FNXC:IntegrationBranchReadiness 2026-08-24-00:37:
 * FN-183 requires registration to adopt or create an integration ref without producing a
 * new registration failure. A remote-tracking ref is materialized with plain `git branch`,
 * never `--track`: a real ref can lack a configured fetch refspec, for which `--track`
 * fails even though a local branch can be created safely. Probe and materialization failures
 * stay non-fatal so a temporary Git write problem cannot replace the old error state with a
 * registration failure; callers retain the unavailable result for operator visibility.
 */
export async function ensureIntegrationBranchLocalRef(
  repoPath: string,
  options: EnsureIntegrationBranchLocalRefOptions,
): Promise<IntegrationBranchReconciliation> {
  const [localRefOutput, currentHeadOutput, originHeadOutput, remoteRefOutput] = await Promise.all([
    probeGit(repoPath, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"], options),
    probeGit(repoPath, ["symbolic-ref", "--quiet", "--short", "HEAD"], options),
    probeGit(repoPath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], options),
    probeGit(repoPath, ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin/"], options),
  ]);

  const localBranches = parseGitBranchList(localRefOutput);
  const remoteBranches = parseGitBranchList(remoteRefOutput)
    .filter((branch) => branch !== "HEAD");
  const selection = selectIntegrationBranch({
    configuredBranch: normalizeGitBranch(options.configuredBranch),
    originHeadBranch: normalizeGitBranch(originHeadOutput),
    localBranches,
    currentBranch: normalizeGitBranch(currentHeadOutput),
    remoteBranches,
  });
  const branch = selection?.branch ?? "main";
  const source: IntegrationBranchSource | "fallback" = selection?.source ?? "fallback";
  const resultBase: Pick<IntegrationBranchReconciliation, "repoRelPath" | "branch" | "source"> = {
    repoRelPath: options.repoRelPath ?? ".",
    branch,
    source,
  };

  if (localBranches.includes(branch)) {
    return { ...resultBase, action: "existing" };
  }

  const remoteBranchExists = remoteBranches.includes(branch);
  try {
    await options.runner(
      "git",
      ["-C", repoPath, "branch", branch, remoteBranchExists ? `refs/remotes/origin/${branch}` : "HEAD"],
      { timeout: options.timeoutMs },
    );
    return { ...resultBase, action: remoteBranchExists ? "created-from-remote" : "created-from-head" };
  } catch (error) {
    return {
      ...resultBase,
      action: "unavailable",
      reason: materializationFailureReason(error),
    };
  }
}
