/*
FNXC:HumanMergeApproval 2026-09-17-18:09:
FN-514 — client for the per-card delivery lock.

Each button sends ONE explicit command. There is no destination selector, no "approve" pre-step, and
no client-side approval object: the server derives the destination from the action and is the sole
authority for the candidate identity and for what each action can actually do.
*/
import { proxyApi } from "../client/client.js";
import { withProjectId } from "../client/health.js";
import type { Task } from "@fusion/core";

export type HumanMergeDecisionActionId = "create-pr" | "merge" | "reject";

export interface HumanMergeActionCapabilityView {
  action: HumanMergeDecisionActionId;
  enabled: boolean;
  reason?: string;
}

export interface HumanMergeDecisionPointView {
  enabled: boolean;
  available: boolean;
  unavailableReason?: string;
  blocker?: string;
  candidateToken?: string;
  content?: unknown;
  targets?: Record<string, { kind: string; repositories: { repository: string; head: string; base: string; remote?: string }[] }>;
  capabilities: HumanMergeActionCapabilityView[];
  revision: string;
}

export async function fetchTaskMergeApproval(
  taskId: string,
  projectId?: string,
): Promise<HumanMergeDecisionPointView> {
  return proxyApi<HumanMergeDecisionPointView>(
    withProjectId(`/tasks/${encodeURIComponent(taskId)}/merge-approval`, projectId),
  );
}

export async function setTaskMergeApprovalLock(
  taskId: string,
  input: { enabled: boolean; requestId: string; expectedRevision?: string },
  projectId?: string,
): Promise<{ task: Task; replayed: boolean }> {
  return proxyApi<{ task: Task; replayed: boolean }>(
    withProjectId(`/tasks/${encodeURIComponent(taskId)}/merge-approval`, projectId),
    { method: "PUT", body: JSON.stringify(input) },
  );
}

/*
ONE action per request. `message` is an optional note for `create-pr` and `merge`, and the MANDATORY
instruction for `reject`; the server validates both families and refuses an empty rejection.
*/
export async function submitTaskMergeDecision(
  taskId: string,
  input: {
    action: HumanMergeDecisionActionId;
    message?: string;
    requestId: string;
    candidateToken: string;
    expectedRevision?: string;
  },
  projectId?: string,
): Promise<{ task: Task; action: HumanMergeDecisionActionId; replayed: boolean }> {
  return proxyApi<{ task: Task; action: HumanMergeDecisionActionId; replayed: boolean }>(
    withProjectId(`/tasks/${encodeURIComponent(taskId)}/merge-approval/decision`, projectId),
    { method: "POST", body: JSON.stringify(input) },
  );
}
