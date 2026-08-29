import type { Task } from "@fusion/core";
import { getNoCommitEligibilityReason } from "./no-commit-eligibility.js";
import { evaluatePromptDerivedNoCommitEligibility } from "./prompt-derived-eligibility.js";

export type WorkspaceZeroAcquireClassification =
  | { kind: "not-applicable" }
  | { kind: "commit-free-eligible"; reason: string }
  | { kind: "unproven" };

export type WorkspaceZeroAcquireOptions = {
  workspaceMode: boolean;
  noOpCompletion?: boolean;
  noOpCompletionReason?: string;
};

/**
 * FNXC:Workspace 2026-08-15-04:21:
 * Completion verification and per-repo review must classify the same empty
 * workspace map identically. Previously one accepted it vacuously while the
 * other returned UNAVAILABLE forever; centralizing the predicate prevents those
 * lifecycle ends from drifting apart again.
 */
export function classifyWorkspaceZeroAcquire(
  task: Task,
  options: WorkspaceZeroAcquireOptions,
): WorkspaceZeroAcquireClassification {
  if (!options.workspaceMode || Object.keys(task.workspaceWorktrees ?? {}).length > 0) {
    return { kind: "not-applicable" };
  }

  const explicitReason = getNoCommitEligibilityReason(task);
  if (explicitReason) return { kind: "commit-free-eligible", reason: explicitReason };

  if (options.noOpCompletion) {
    return {
      kind: "commit-free-eligible",
      reason: options.noOpCompletionReason ?? "verified no-op/duplicate completion sentinel",
    };
  }

  const prompt = typeof (task as Task & { prompt?: unknown }).prompt === "string"
    ? (task as Task & { prompt: string }).prompt
    : "";
  const promptEligibility = evaluatePromptDerivedNoCommitEligibility(task, prompt);
  if (promptEligibility.eligible) {
    return {
      kind: "commit-free-eligible",
      reason: promptEligibility.reason ?? "prompt-derived no-commit eligibility",
    };
  }

  return { kind: "unproven" };
}
