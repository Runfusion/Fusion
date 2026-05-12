import type { DirectMergeCommitStrategy, GithubAuthMode, UnavailableNodePolicy } from "./types.js";

const UNAVAILABLE_NODE_POLICIES: readonly UnavailableNodePolicy[] = ["block", "fallback-local"] as const;
const DIRECT_MERGE_COMMIT_STRATEGIES: readonly DirectMergeCommitStrategy[] = ["auto", "always-squash", "always-rebase"] as const;
const GITHUB_AUTH_MODES: readonly GithubAuthMode[] = ["gh-cli", "token"] as const;
const GITHUB_REPO_SLUG_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * Validates a project unavailable-node routing policy value.
 *
 * Returns the normalized policy value when valid, otherwise undefined.
 */
export function validateUnavailableNodePolicy(value: unknown): UnavailableNodePolicy | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  return (UNAVAILABLE_NODE_POLICIES as readonly string[]).includes(value)
    ? (value as UnavailableNodePolicy)
    : undefined;
}

/** Returns a validated direct-merge commit strategy for project settings, otherwise undefined. */
export function validateDirectMergeCommitStrategy(value: unknown): DirectMergeCommitStrategy | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  return (DIRECT_MERGE_COMMIT_STRATEGIES as readonly string[]).includes(value)
    ? (value as DirectMergeCommitStrategy)
    : undefined;
}

/** Returns a validated GitHub auth mode for project settings, otherwise undefined. */
export function validateGithubAuthMode(value: unknown): GithubAuthMode | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  return (GITHUB_AUTH_MODES as readonly string[]).includes(value) ? (value as GithubAuthMode) : undefined;
}

/** Returns a validated owner/repo GitHub slug, otherwise undefined. Empty string is treated as unset. */
export function validateGithubRepoSlug(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return GITHUB_REPO_SLUG_PATTERN.test(trimmed) ? trimmed : undefined;
}
