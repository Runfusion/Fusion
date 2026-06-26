import { ApprovalRequestStore, type ApprovalRequestActorSnapshot } from "@fusion/core";
import {
  WORKTRUNK_INSTALL_PATH,
  WORKTRUNK_PINNED_RELEASE,
  probeWorktrunk,
  requestWorktrunkInstallApproval,
  resolveWorktrunkBinary,
} from "@fusion/engine";
import { ApiError, badRequest } from "../api-error.js";
import { emitApprovalSseEvent } from "../sse.js";
import type { ApiRoutesContext } from "./types.js";

const DEFAULT_ACTOR: ApprovalRequestActorSnapshot = {
  actorId: "user",
  actorType: "user",
  actorName: "User",
};

function worktrunkInstallDedupeKey(): string {
  return WORKTRUNK_PINNED_RELEASE.version
    ? `worktrunk_install:${WORKTRUNK_PINNED_RELEASE.version}`
    : "worktrunk_install:pending";
}

export function registerWorktrunkRoutes(ctx: ApiRoutesContext): void {
  const { router, getProjectContext, rethrowAsApiError } = ctx;

  router.get("/worktrunk/status", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const settings = await scopedStore.getSettings();
      const worktrunkSettings = settings.worktrunk ?? {};
      const layer = scopedStore.getAsyncLayer();
      const approvalStore = new ApprovalRequestStore(layer ? null : scopedStore.getDatabase(), { asyncLayer: layer });

      try {
        const resolved = await resolveWorktrunkBinary({ settings: worktrunkSettings });
        const probe = await probeWorktrunk(resolved.binaryPath);
        res.json({
          status: "installed",
          version: probe.version ?? WORKTRUNK_PINNED_RELEASE.version ?? "pending",
          installPath: resolved.binaryPath,
        });
        return;
      } catch {
        // continue to pending/missing lookup
      }

      const pending = await approvalStore.findLatestByDedupeKey({
        requesterActorId: DEFAULT_ACTOR.actorId,
        dedupeKey: worktrunkInstallDedupeKey(),
      });

      if (pending?.status === "pending") {
        res.json({
          status: "pending-approval",
          pendingApprovalId: pending.id,
          installPath: WORKTRUNK_INSTALL_PATH,
        });
        return;
      }

      if (pending?.status === "denied") {
        res.json({ status: "denied", error: "Install approval was denied", installPath: WORKTRUNK_INSTALL_PATH });
        return;
      }

      res.json({ status: "missing", installPath: WORKTRUNK_INSTALL_PATH });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  router.post("/worktrunk/install-request", async (req, res) => {
    try {
      const body = (req.body ?? {}) as { actor?: ApprovalRequestActorSnapshot };
      if (body.actor && (!body.actor.actorId || !body.actor.actorType || !body.actor.actorName)) {
        throw badRequest("actor must include actorId, actorType, and actorName");
      }
      const actor = body.actor ?? DEFAULT_ACTOR;
      const { store: scopedStore, projectId } = await getProjectContext(req);
      const settings = await scopedStore.getSettings();
      const worktrunkSettings = settings.worktrunk ?? {};
      const layer2 = scopedStore.getAsyncLayer();
      const approvalStore = new ApprovalRequestStore(layer2 ? null : scopedStore.getDatabase(), { asyncLayer: layer2 });

      try {
        const resolved = await resolveWorktrunkBinary({ settings: worktrunkSettings });
        res.json({
          status: "installed",
          installPath: resolved.binaryPath,
          version: WORKTRUNK_PINNED_RELEASE.version ?? "pending",
        });
        return;
      } catch {
        // proceed with approval request
      }

      const request = await requestWorktrunkInstallApproval({
        approvalStore,
        actor,
        projectId,
      });
      const detail = await approvalStore.get(request.approvalRequestId);
      if (detail) {
        emitApprovalSseEvent("approval:requested", {
          id: detail.id,
          status: detail.status,
          actionCategory: detail.targetAction.category,
          actionSummary: detail.targetAction.summary,
          agentId: detail.requester.actorId,
          taskId: detail.taskId,
          createdAt: detail.createdAt,
          updatedAt: detail.updatedAt,
          decidedAt: detail.decidedAt,
        }, projectId);
      }
      res.json({ status: "pending-approval", approvalRequestId: request.approvalRequestId });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });
}
