/**
 * FNXC:CodeOrganization 2026-08-03-09:55:
 * buildActionGateContext peeled from TaskExecutor (U4).
 *
 * FNXC:AgentPermissions 2026-07-02-00:00:
 * FN-7413 requires task-scoped runtime gates for permanent identity agents, stored ephemeral agents, and fallback executor-FN task workers. Use a stable synthetic actor for fallback workers so category/exact-tool rules and approval dedupe keys apply even when no agent row exists.
 *
 * FNXC:ApprovalRedemption 2026-07-26-14:30:
 * decidedAt lets resolveGateOutcome apply the approval-grant TTL at redemption.
 *
 * FNXC:ApprovalHold 2026-07-09-00:10:
 * FN-7736: stamp the canonical AWAITING_APPROVAL_PAUSE_REASON on the
 * task (not just the agent) so recovery/oversight code can durably
 * recognize this hold via isTaskBlockedOnApproval -- previously only
 * `paused: true` was set with no reason, which self-healing's
 * autoReboundPausedScopeDecay could rebound before the operator ever
 * decided.
 *
 * FNXC:ApprovalResume 2026-07-12-17:02:
 * MAIN-008: record the approval-specific suspension before pauseTask emits its
 * task:updated event so every abort branch can preserve the in-progress row
 * for a deterministic fresh resume. Clear the mark if pauseTask fails so a
 * failed pause does not leave a sticky suspended marker.
 *
 * FNXC:AgentGating 2026-07-05-00:10:
 * FN-7608: pauseTask() alone does not stop the in-flight LLM turn -- make
 * wait-for-approval a REAL session-suspending state by aborting the in-flight
 * session fire-and-forget (await would deadlock inside the tool call).
 *
 * FNXC:ApprovalRedemption 2026-07-26-14:35:
 * ownership guard — an agent must not be able to burn another agent's approval by id.
 */
import type { Agent, AgentStore, TaskStore } from "@fusion/core";
import {
  AWAITING_APPROVAL_PAUSE_REASON,
  ApprovalRequestStore,
  isEphemeralAgent,
  resolveEffectiveAgentPermissionPolicy,
  resolveWorkflowIrForTask,
} from "@fusion/core";
import type { AgentActionGateContext } from "../agents/agent-action-gate.js";
import { isCurrentReviewerNodeOverride } from "../agents/workflow-agent-router.js";
import { executorLog } from "../logger.js";
import type { EngineRunContext } from "../util/run-audit.js";
import type { ActiveWorkflowAuthority } from "./workflow-principal-before-node.js";

export type BuildActionGateContextDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  approvalSuspended: Set<string>;
  awaitAbortInFlightTaskWork: (taskId: string, reason: string) => Promise<void>;
  agentStore?: AgentStore | null;
  approvalRequestStore: ApprovalRequestStore;
  activeWorkflowAuthorities: Map<string, ActiveWorkflowAuthority>;
  activeWorkflowGraphAbortControllers: Map<string, AbortController>;
};

export function buildActionGateContext(
  deps: BuildActionGateContextDeps,
  taskId: string | undefined,
  agent: Agent | null | undefined,
  projectDefaultPolicy?: {
    rules?: Partial<import("@fusion/core").AgentPermissionPolicy["rules"]>;
    toolRules?: import("@fusion/core").AgentPermissionPolicyToolRules;
  },
): AgentActionGateContext | undefined {
  const actorId = agent?.id ?? `executor-${taskId ?? "unknown"}`;
  const actorName = agent?.name ?? `Task worker ${taskId ?? "unknown"}`;
  const isEphemeral = !agent || isEphemeralAgent(agent);
  const policy = resolveEffectiveAgentPermissionPolicy(agent?.permissionPolicy, projectDefaultPolicy);
  const workflowAuthority = taskId ? deps.activeWorkflowAuthorities.get(taskId) : undefined;
  const authorityMatchesActor = workflowAuthority?.agentId === actorId;
  return {
    agentId: actorId,
    agentName: actorName,
    isEphemeral,
    taskId,
    runId: authorityMatchesActor ? workflowAuthority!.runId : taskId ? deps.getRunContextFor(taskId)?.runId : undefined,
    permissionPolicy: policy,
    ...(authorityMatchesActor ? {
      workflowAuthority: {
        projectId: deps.store.getRootDir(),
        taskId: workflowAuthority!.taskId,
        runId: workflowAuthority!.runId,
        workItemId: workflowAuthority!.workItemId,
        nodeInstanceId: workflowAuthority!.nodeInstanceId,
        principalAgentId: workflowAuthority!.agentId,
        kind: workflowAuthority!.kind,
        isLive: async () => {
          const current = deps.activeWorkflowAuthorities.get(workflowAuthority!.taskId);
          if (current !== workflowAuthority
            || !deps.activeWorkflowGraphAbortControllers.has(workflowAuthority!.taskId)
            || deps.activeWorkflowGraphAbortControllers.get(workflowAuthority!.taskId)!.signal.aborted) {
            return false;
          }
          if (!workflowAuthority!.requiresDurableFence) return true;
          /*
           * FNXC:WorkflowAgentRouting 2026-08-07-04:31:
           * Tool authority for a claimed continuation survives only while its exact leased
           * work item still names this principal and node.
           */
          const items = await deps.store.listWorkflowWorkItemsForTask(workflowAuthority!.taskId);
          const item = items.find((candidate) => candidate.id === workflowAuthority!.workItemId);
          if (item?.state !== "running"
            || item.principalAgentId !== workflowAuthority!.agentId
            || item.nodeInstanceId !== workflowAuthority!.nodeInstanceId
            || !item.leaseOwner
            || (item.leaseExpiresAt !== null && Date.parse(item.leaseExpiresAt) <= Date.now())) {
            return false;
          }
          const liveTask = await deps.store.getTask(workflowAuthority!.taskId);
          if (workflowAuthority!.kind === "task-assignee") {
            return liveTask.assignedAgentId === workflowAuthority!.agentId;
          }
          /*
           * FNXC:WorkflowAgentRouting 2026-08-07-04:56:
           * A reviewer override is authority for one exact IR node attempt, not a
           * task-wide reviewer grant. Re-read the selected workflow definition at
           * every gated call so an operator removing or changing the node override
           * immediately fences an already-running session.
           */
          if (workflowAuthority!.kind === "review-node-override") {
            const liveIr = await resolveWorkflowIrForTask(deps.store, workflowAuthority!.taskId);
            return isCurrentReviewerNodeOverride(
              liveIr,
              workflowAuthority!.nodeInstanceId,
              workflowAuthority!.agentId,
            );
          }
          return false;
        },
      },
    } : {}),
    createApprovalRequest: async (decision, args) => await deps.approvalRequestStore.create({
      requester: {
        actorId,
        actorType: "agent",
        actorName,
      },
      taskId,
      runId: taskId ? deps.getRunContextFor(taskId)?.runId : undefined,
      targetAction: {
        category: decision.category === "exempt" ? "command_execution" : decision.category,
        action: decision.operation,
        summary: decision.summary,
        resourceType: decision.resourceType,
        resourceId: decision.resourceId ?? "",
        context: {
          ...decision.metadata,
          approvalDedupeKey: decision.approvalDedupeKey,
          toolName: decision.toolName,
          toolArgs: args,
        },
      },
    }),
    findApprovalByDedupeKey: async (dedupeKey) => {
      const latest = await deps.approvalRequestStore.findLatestByDedupeKey({ requesterActorId: actorId, taskId, dedupeKey });
      return latest ? { id: latest.id, status: latest.status, decidedAt: latest.decidedAt } : null;
    },
    findPendingApprovalByDedupeKey: async (dedupeKey) => {
      const latest = await deps.approvalRequestStore.findLatestByDedupeKey({ requesterActorId: actorId, taskId, dedupeKey });
      return latest?.status === "pending" ? { id: latest.id } : null;
    },
    pauseForApproval: async ({ approvalRequestId, decision }) => {
      if (taskId) {
        deps.approvalSuspended.add(taskId);
        try {
          await deps.store.pauseTask(taskId, true, deps.getRunContextFor(taskId), { pausedByAgentId: actorId, pausedReason: AWAITING_APPROVAL_PAUSE_REASON });
        } catch (error) {
          deps.approvalSuspended.delete(taskId);
          throw error;
        }
        await deps.store.logEntry(
          taskId,
          `Approval required for ${decision.toolName}. Request ${approvalRequestId} created; task and agent paused awaiting decision.`,
          undefined,
          deps.getRunContextFor(taskId),
        );
        void deps.awaitAbortInFlightTaskWork(taskId, `awaiting-approval:${decision.toolName}`).catch((error) => {
          executorLog.warn(`${taskId}: failed to suspend in-flight session while awaiting approval: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
      if (agent && deps.agentStore) {
        await deps.agentStore.updateAgentState(agent.id, "paused");
        await deps.agentStore.updateAgent(agent.id, { pauseReason: "awaiting-approval" });
      }
    },
    markApprovalCompleted: async (approvalRequestId) => {
      await deps.approvalRequestStore.markCompleted(approvalRequestId, {
        actor: { actorId, actorType: "agent", actorName },
        note: "Tool executed after approval",
        expectedRequesterActorId: actorId,
      });
    },
  };
}
