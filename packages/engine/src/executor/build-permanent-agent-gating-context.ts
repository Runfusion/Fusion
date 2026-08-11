/**
 * FNXC:CodeOrganization 2026-08-03-10:05:
 * buildPermanentAgentGatingContext peeled from TaskExecutor (U4).
 *
 * FNXC:AgentGating 2026-07-05-00:00:
 * FN-7609: operators approving a gated action need the real command/args,
 * and a stateless heartbeat retrying the same command must reuse a single
 * pending approval instead of minting duplicates.
 *
 * FNXC:AgentGating 2026-07-26-14:50:
 * Audit finding (gate-path divergence): the permanent gate minted an
 * approval request but never paused, so the agent kept its turn while
 * "awaiting approval". Mirror the action gate's task-level hold (canonical
 * AWAITING_APPROVAL_PAUSE_REASON + approvalSuspended marker). Session
 * suspension is intentionally not wired here: the permanent gate only runs
 * in lanes WITHOUT an actionGateContext, where no executor in-flight
 * session surface exists to abort.
 */
import type { Agent, PermanentAgentGatingContext, TaskStore } from "@fusion/core";
import {
  AWAITING_APPROVAL_PAUSE_REASON,
  ApprovalRequestStore,
  resolveEffectiveAgentPermissionPolicy,
} from "@fusion/core";
import { buildAgentGatedActionSummary } from "../agents/permanent-agent-gating.js";
import type { EngineRunContext } from "../util/run-audit.js";

export type BuildPermanentAgentGatingContextDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  approvalSuspended: Set<string>;
  approvalRequestStore: ApprovalRequestStore;
};

export function buildPermanentAgentGatingContext(
  deps: BuildPermanentAgentGatingContextDeps,
  taskId: string | undefined,
  agent: Agent | null | undefined,
  projectDefaultPolicy?: {
    rules?: Partial<import("@fusion/core").AgentPermissionPolicy["rules"]>;
    toolRules?: import("@fusion/core").AgentPermissionPolicyToolRules;
  },
): PermanentAgentGatingContext | undefined {
  const actorId = agent?.id ?? `executor-${taskId ?? "unknown"}`;
  const actorName = agent?.name ?? `Task worker ${taskId ?? "unknown"}`;

  return {
    permissionPolicy: resolveEffectiveAgentPermissionPolicy(agent?.permissionPolicy, projectDefaultPolicy),
    requester: {
      actorId,
      actorType: "agent",
      actorName,
    },
    taskId,
    runId: taskId ? deps.getRunContextFor(taskId)?.runId : undefined,
    createApprovalRequest: async ({ category, toolName, args, approvalDedupeKey }) => await deps.approvalRequestStore.create({
      requester: {
        actorId,
        actorType: "agent",
        actorName,
      },
      taskId,
      runId: taskId ? deps.getRunContextFor(taskId)?.runId : undefined,
      targetAction: {
        category,
        action: toolName,
        summary: buildAgentGatedActionSummary(toolName, args),
        resourceType: "tool",
        resourceId: toolName,
        context: {
          toolName,
          toolArgs: args,
          source: "agent-gating",
          ...(approvalDedupeKey ? { approvalDedupeKey } : {}),
          ...(typeof (args as Record<string, unknown> | undefined)?.command === "string"
            ? { command: (args as Record<string, unknown>).command }
            : {}),
          ...(typeof (args as Record<string, unknown> | undefined)?.cwd === "string"
            ? { cwd: (args as Record<string, unknown>).cwd }
            : {}),
        },
      },
    }),
    findPendingApprovalRequest: async (dedupeKey) => {
      const pending = await deps.approvalRequestStore.list({ status: "pending", requesterActorId: actorId, taskId, limit: 100 });
      return pending.find((request) => request.targetAction.context?.approvalDedupeKey === dedupeKey) ?? null;
    },
    pauseForApproval: async ({ approvalRequestId, toolName }) => {
      if (!taskId) return;
      deps.approvalSuspended.add(taskId);
      try {
        await deps.store.pauseTask(taskId, true, deps.getRunContextFor(taskId), { pausedByAgentId: actorId, pausedReason: AWAITING_APPROVAL_PAUSE_REASON });
        await deps.store.logEntry(
          taskId,
          `Approval required for ${toolName}. Request ${approvalRequestId} created; task paused awaiting decision.`,
        );
      } catch (error) {
        deps.approvalSuspended.delete(taskId);
        throw error;
      }
    },
  };
}
