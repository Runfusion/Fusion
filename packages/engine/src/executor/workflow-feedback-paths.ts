/**
 * FNXC:CodeOrganization 2026-08-03-07:20:
 * Pure workflow-feedback path helpers peeled from executor.ts (wave18 / U4 Slice A).
 */
import { normalizeRepoRelPath } from "../worktree/workspace-paths.js";

export interface WorkflowRevisionFeedbackPartition {
  inScopeFeedback: string;
  outOfScopeFeedback: string;
  inScopeSegments: string[];
  outOfScopeSegments: string[];
  detectedPaths: string[];
}

const WORKFLOW_FEEDBACK_PATH_REGEX = /`([^`\n]+)`|(?<![A-Za-z0-9_.-])((?:\.\.?\/)?(?:@?[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+(?:\.[A-Za-z0-9._-]+)?)/g;

// FNXC:Workspace 2026-06-21-15:00: F8 — delegate to the single shared normalizer (workspace-paths.ts).
// Was a near-duplicate that did NOT strip a leading slash and only collapsed a single trailing slash;
// the shared `normalizeRepoRelPath` additionally strips leading slashes and collapses repeated trailing
// slashes. For repo-relative inputs (the only inputs in practice) the result is unchanged; the extra
// canonicalization only hardens absolute/trailing-slash edge cases so workspace and non-workspace scope
// matching agree. Kept as a thin alias so existing call sites stay put.
function normalizeWorkflowScopePath(pathValue: string): string {
  return normalizeRepoRelPath(pathValue);
}

function stripTrailingPathPunctuation(pathValue: string): string {
  return pathValue.replace(/[),.:;!?]+$/g, "");
}

export function extractReferencedPathsFromWorkflowFeedback(feedback: string): string[] {
  const extracted: string[] = [];
  const seen = new Set<string>();
  for (const match of feedback.matchAll(WORKFLOW_FEEDBACK_PATH_REGEX)) {
    const candidate = stripTrailingPathPunctuation(match[1] ?? match[2] ?? "");
    const normalized = normalizeWorkflowScopePath(candidate);
    if (!normalized.includes("/")) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    extracted.push(normalized);
  }
  return extracted;
}

/**
 * FN-4811 follow-up: paths the scope-leak guard never flags, regardless of declared
 * scope. These are file types every task may legitimately touch as part of standard
 * delivery (e.g., `.changeset/` per AGENTS.md's "Finalizing Changes" section).
 * Cross-task contamination of these paths is caught by stronger guards downstream
 * (file-scope invariant at squash commit, branch-tip checks, post-merge audit).
 */
export function isAlwaysAllowedScopeLeakPath(filePath: string): boolean {
  const normalizedPath = normalizeWorkflowScopePath(filePath);
  return normalizedPath.startsWith(".changeset/");
}

export function workflowPathMatchesDeclaredScope(filePath: string, scopePatterns: readonly string[]): boolean {
  const normalizedPath = normalizeWorkflowScopePath(filePath);
  for (const rawPattern of scopePatterns) {
    const pattern = normalizeWorkflowScopePath(rawPattern);
    if (!pattern) continue;
    if (/\/\*+$/.test(pattern)) {
      const directory = pattern.replace(/\/\*+$/, "");
      if (normalizedPath === directory || normalizedPath.startsWith(`${directory}/`)) return true;
      continue;
    }
    if (pattern.endsWith("/")) {
      if (normalizedPath.startsWith(pattern)) return true;
      continue;
    }
    if (normalizedPath === pattern) return true;
  }
  return false;
}
