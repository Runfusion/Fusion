import {
  AgentStore,
  ApprovalRequestStore,
  extractSandboxProvisioningRequest,
  type ApprovalRequest,
  type ApprovalRequestActorSnapshot,
  type ApprovalRequestStatus,
} from "@fusion/core";
import { assertNoSecretPlaintext, executeApprovedAgentProvisioning, executeApprovedWorktrunkInstall } from "@fusion/engine";
import { ApiError, badRequest, conflict, notFound } from "../api-error.js";
import type { ApiRoutesContext } from "./types.js";
import { emitApprovalSseEvent } from "../sse.js";

const DEFAULT_ACTOR: ApprovalRequestActorSnapshot = {
  actorId: "user",
  actorType: "user",
  actorName: "User",
};

interface ApprovalRequestSummaryDto {
  id: string;
  status: ApprovalRequestStatus;
  actionCategory: string;
  actionSummary: string;
  agentId: string;
  taskId?: string;
  createdAt: string;
  updatedAt: string;
  decidedAt?: string;
  decidedBy?: string;
}

interface ApprovalRequestDetailDto extends ApprovalRequestSummaryDto {
  requester: ApprovalRequestActorSnapshot;
  runId?: string;
  requestedAt: string;
  completedAt?: string;
  targetAction: {
    category: string;
    action: string;
    summary: string;
    resourceType: string;
    resourceId: string;
    context?: Record<string, unknown>;
  };
  history: Array<{
    id: string;
    eventType: string;
    actor: ApprovalRequestActorSnapshot;
    note?: string;
    createdAt: string;
  }>;
}

function parseOptionalInt(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n) || n < 0) throw badRequest(`${field} must be a non-negative integer`);
  return n;
}

function parseStatus(value: unknown): ApprovalRequestStatus | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "pending" || value === "approved" || value === "denied" || value === "completed") return value;
  throw badRequest("status must be one of: pending, approved, denied, completed");
}

function getDeciderActorId(
  history: Array<{ eventType: string; actor: ApprovalRequestActorSnapshot }>,
): string | undefined {
  const decisionEvent = [...history].reverse().find((entry) => entry.eventType === "approved" || entry.eventType === "denied");
  return decisionEvent?.actor.actorId;
}

function toSummaryDto(
  request: import("@fusion/core").ApprovalRequest,
  history: Array<{ eventType: string; actor: ApprovalRequestActorSnapshot }>,
): ApprovalRequestSummaryDto {
  return {
    id: request.id,
    status: request.status,
    actionCategory: request.targetAction.category,
    actionSummary: request.targetAction.summary,
    agentId: request.requester.actorId,
    taskId: request.taskId,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    decidedAt: request.decidedAt,
    decidedBy: getDeciderActorId(history),
  };
}

function toDetailDto(
  request: import("@fusion/core").ApprovalRequest,
  history: import("@fusion/core").ApprovalRequestAuditEvent[],
): ApprovalRequestDetailDto {
  return {
    ...toSummaryDto(request, history),
    requester: request.requester,
    runId: request.runId,
    requestedAt: request.requestedAt,
    completedAt: request.completedAt,
    targetAction: request.targetAction,
    history,
  };
}

let sandboxProvisioningExecutor: ((request: ApprovalRequest) => Promise<void>) | null = null;

export function registerSandboxProvisioningExecutor(fn: ((request: ApprovalRequest) => Promise<void>) | null): void {
  sandboxProvisioningExecutor = fn;
}

function emitProvisioningDecisionAudit(params: {
  scopedStore: import("@fusion/core").TaskStore;
  request: ApprovalRequest;
  decision: "approved" | "denied";
}): void {
  const { scopedStore, request, decision } = params;
  if (request.targetAction.category !== "agent_provisioning") return;

  const action = request.targetAction.action === "delete" ? "delete" : "create";
  const mutationType = `agent:${action}:${decision}` as const;
  const event: Parameters<typeof scopedStore.recordRunAuditEvent>[0] = {
    agentId: request.requester.actorId,
    domain: "database",
    mutationType,
    target: request.targetAction.resourceId || request.requester.actorId,
    metadata: {
      approvalRequestId: request.id,
      action,
      resourceId: request.targetAction.resourceId,
      requesterAgentId: request.requester.actorId,
    },
    runId: request.id,
  };
  if (request.taskId) event.taskId = request.taskId;
  if (request.runId) event.runId = request.runId;
  void scopedStore.recordRunAuditEvent(event);
}

function emitSecretsAccessDecisionAudit(params: {
  scopedStore: import("@fusion/core").TaskStore;
  request: ApprovalRequest;
  decision: "approve" | "deny";
}): void {
  const { scopedStore, request, decision } = params;
  if (request.targetAction.category !== "secrets_access") return;

  const context = request.targetAction.context ?? {};
  const scope = typeof context.scope === "string" ? context.scope : undefined;
  const key = typeof context.key === "string" ? context.key : undefined;
  const policySource = typeof context.policySource === "string" ? context.policySource : undefined;
  const target = scope && key ? `${scope}:${key}` : request.targetAction.resourceId;

  const metadata = {
    approvalRequestId: request.id,
    key,
    scope,
    policySource,
    requesterAgentId: request.requester.actorId,
  };
  assertNoSecretPlaintext(metadata);

  const event: Parameters<typeof scopedStore.recordRunAuditEvent>[0] = {
    agentId: request.requester.actorId,
    domain: "filesystem",
    mutationType: decision === "approve" ? "secret:approval-granted" : "secret:approval-denied",
    target,
    metadata,
    runId: request.id,
  };
  if (request.taskId) event.taskId = request.taskId;
  if (request.runId) event.runId = request.runId;
  void scopedStore.recordRunAuditEvent(event);
}

function emitSandboxProvisioningDecisionAudit(params: {
  scopedStore: import("@fusion/core").TaskStore;
  request: ApprovalRequest;
  decision: "approved" | "denied";
  runtimeLogger: ApiRoutesContext["runtimeLogger"];
}): void {
  const { scopedStore, request, decision, runtimeLogger } = params;
  if (request.targetAction.category !== "sandbox_provisioning") return;

  try {
    const details = extractSandboxProvisioningRequest(request);
    const mutationType = decision === "approved" ? "sandbox:provisioning:approve" : "sandbox:provisioning:deny";
    const event: Parameters<typeof scopedStore.recordRunAuditEvent>[0] = {
      agentId: request.requester.actorId,
      domain: "database",
      mutationType,
      target: request.targetAction.resourceId || details.operation,
      metadata: {
        approvalRequestId: request.id,
        backendId: details.backendId,
        operation: details.operation,
        requesterAgentId: request.requester.actorId,
      },
      runId: request.id,
    };
    if (request.taskId) event.taskId = request.taskId;
    if (request.runId) event.runId = request.runId;
    void scopedStore.recordRunAuditEvent(event);
  } catch (error) {
    runtimeLogger.warn("Failed to emit sandbox provisioning decision audit", {
      requestId: request.id,
      decision,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function resumeAfterDecision(params: {
  scopedStore: import("@fusion/core").TaskStore;
  request: import("@fusion/core").ApprovalRequest;
  runtimeLogger: ApiRoutesContext["runtimeLogger"];
}): Promise<void> {
  const { scopedStore, request, runtimeLogger } = params;

  try {
    if (request.taskId) {
      const task = await scopedStore.getTask(request.taskId);
      if (task?.paused && task.pausedByAgentId === request.requester.actorId && !task.userPaused) {
        await scopedStore.pauseTask(request.taskId, false, undefined);
      }
    }
  } catch (error) {
    runtimeLogger.warn("Failed to unpause task after approval decision", {
      requestId: request.id,
      taskId: request.taskId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir(), asyncLayer: scopedStore.getAsyncLayer() ?? undefined });
    await agentStore.init();
    const agent = await agentStore.getAgent(request.requester.actorId);
    if (agent?.state === "paused" && agent.pauseReason === "awaiting-approval") {
      await agentStore.updateAgentState(agent.id, "idle");
      await agentStore.updateAgent(agent.id, { pauseReason: undefined });
    }
  } catch (error) {
    runtimeLogger.warn("Failed to unpause agent after approval decision", {
      requestId: request.id,
      agentId: request.requester.actorId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function registerApprovalRoutes(ctx: ApiRoutesContext): void {
  const { router, getProjectContext, rethrowAsApiError, runtimeLogger } = ctx;

  router.get("/approvals", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const layer = scopedStore.getAsyncLayer();
      const approvalStore = new ApprovalRequestStore(layer ? null : scopedStore.getDatabase(), { asyncLayer: layer });
      const status = parseStatus(req.query.status);
      const limit = parseOptionalInt(req.query.limit, "limit") ?? 50;
      const offset = parseOptionalInt(req.query.offset, "offset") ?? 0;

      const requests = await approvalStore.list({ status, limit, offset });
      const summaries = await Promise.all(requests.map(async (request) => {
        const history = await approvalStore.getAuditHistory(request.id);
        return toSummaryDto(request, history);
      }));
      const total = (await approvalStore.list({ status, limit: Number.MAX_SAFE_INTEGER, offset: 0 })).length;
      const pendingCount = (await approvalStore.list({ status: "pending", limit: Number.MAX_SAFE_INTEGER, offset: 0 })).length;

      res.json({ requests: summaries, total, pendingCount });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  router.get("/approvals/:id", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const layer = scopedStore.getAsyncLayer();
      const approvalStore = new ApprovalRequestStore(layer ? null : scopedStore.getDatabase(), { asyncLayer: layer });
      const requestId = String(req.params.id);
      const request = await approvalStore.get(requestId);
      if (!request) throw notFound("Approval request not found");
      const history = await approvalStore.getAuditHistory(requestId);
      res.json(toDetailDto(request, history));
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  router.post("/approvals/:id/decision", async (req, res) => {
    try {
      const body = (req.body ?? {}) as { decision?: "approve" | "deny"; comment?: string; actor?: ApprovalRequestActorSnapshot };
      if (body.decision !== "approve" && body.decision !== "deny") {
        throw badRequest("decision must be one of: approve, deny");
      }
      if (body.comment !== undefined && typeof body.comment !== "string") {
        throw badRequest("comment must be a string");
      }

      const { store: scopedStore, projectId } = await getProjectContext(req);
      const layer = scopedStore.getAsyncLayer();
      const approvalStore = new ApprovalRequestStore(layer ? null : scopedStore.getDatabase(), { asyncLayer: layer });
      const requestId = String(req.params.id);
      const existing = await approvalStore.get(requestId);
      if (!existing) throw notFound("Approval request not found");

      const actor = body.actor ?? DEFAULT_ACTOR;
      if (!actor || typeof actor.actorId !== "string" || typeof actor.actorType !== "string" || typeof actor.actorName !== "string") {
        throw badRequest("actor must include actorId, actorType, and actorName");
      }

      const targetStatus = body.decision === "approve" ? "approved" : "denied";
      let updated;
      try {
        updated = await approvalStore.decide(requestId, targetStatus, { actor, note: body.comment });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("Invalid approval request transition")) {
          throw conflict(message);
        }
        throw error;
      }

      if (updated.targetAction.category === "agent_provisioning") {
        if (body.decision === "approve") {
          const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir(), asyncLayer: scopedStore.getAsyncLayer() ?? undefined });
          await agentStore.init();
          await executeApprovedAgentProvisioning(updated, { agentStore });
          emitProvisioningDecisionAudit({ scopedStore, request: updated, decision: "approved" });
        } else {
          emitProvisioningDecisionAudit({ scopedStore, request: updated, decision: "denied" });
        }
      }

      if (updated.targetAction.category === "network_api" && updated.targetAction.action === "worktrunk_install") {
        if (body.decision === "approve") {
          try {
            const settings = await scopedStore.getSettings();
            await executeApprovedWorktrunkInstall({
              approvalStore,
              settings: settings.worktrunk ?? {},
              request: updated,
            });
          } catch (error) {
            runtimeLogger.warn("Worktrunk install approval execution failed", {
              requestId: updated.id,
              error: error instanceof Error ? error.message : String(error),
            });
            void scopedStore.recordRunAuditEvent({
              domain: "filesystem",
              mutationType: "binary:install-failed",
              target: updated.targetAction.resourceId,
              agentId: updated.requester.actorId,
              runId: updated.runId ?? updated.id,
              ...(updated.taskId ? { taskId: updated.taskId } : {}),
              metadata: {
                approvalRequestId: updated.id,
                error: error instanceof Error ? error.message : String(error),
              },
            });
          }
        }
      }

      emitSecretsAccessDecisionAudit({ scopedStore, request: updated, decision: body.decision });

      if (updated.targetAction.category === "sandbox_provisioning") {
        if (body.decision === "approve") {
          if (sandboxProvisioningExecutor) {
            try {
              await sandboxProvisioningExecutor(updated);
            } catch (error) {
              runtimeLogger.warn("Sandbox provisioning executor failed", {
                requestId: updated.id,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
          emitSandboxProvisioningDecisionAudit({ scopedStore, request: updated, decision: "approved", runtimeLogger });
        } else {
          emitSandboxProvisioningDecisionAudit({ scopedStore, request: updated, decision: "denied", runtimeLogger });
        }
      }

      await resumeAfterDecision({ scopedStore, request: updated, runtimeLogger });
      const history = await approvalStore.getAuditHistory(requestId);
      const detail = toDetailDto(updated, history);
      emitApprovalSseEvent("approval:updated", detail, projectId);
      emitApprovalSseEvent("approval:decided", detail, projectId);
      res.json(detail);
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });
}
