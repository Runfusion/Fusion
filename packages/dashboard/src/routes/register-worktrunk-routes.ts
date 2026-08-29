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
import { requireAsyncLayer } from "../require-async-layer.js";

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
      const layer = requireAsyncLayer(scopedStore, "Worktrunk approval store");
      const approvalStore = new ApprovalRequestStore(null, { asyncLayer: layer });

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
      /*
      FNXC:ApprovalDecisionAuthority 2026-07-26-16:40:
      The worktrunk-install approval requester is derived SERVER-SIDE. Previously
      `req.body.actor` became the requester snapshot verbatim, letting any HTTP caller
      forge the identity that later shows as "who asked for this install". The bearer
      token is a single shared operator secret, so the honest requester is the synthetic
      dashboard operator; a body actor is at most advisory display metadata — its
      actorName is carried only when its actorType is "user", and a non-user actorType is
      rejected 403 (agents must use their own engine-side approval path, not this route).
      This also keeps the requester actorId aligned with the /worktrunk/status
      pending-lookup, which queries by DEFAULT_ACTOR.actorId.
      */
      const body = (req.body ?? {}) as { actor?: { actorId?: unknown; actorType?: unknown; actorName?: unknown } | null };
      let advisoryActorName: string | undefined;
      if (body.actor !== undefined && body.actor !== null) {
        if (
          typeof body.actor !== "object"
          || typeof body.actor.actorId !== "string" || body.actor.actorId.length === 0
          || typeof body.actor.actorType !== "string" || body.actor.actorType.length === 0
          || typeof body.actor.actorName !== "string" || body.actor.actorName.length === 0
        ) {
          throw badRequest("actor must include actorId, actorType, and actorName");
        }
        if (body.actor.actorType !== "user") {
          throw new ApiError(403, "Worktrunk install requests over HTTP are operator-only; a non-user actor cannot request an install");
        }
        if (body.actor.actorName.trim().length > 0) {
          advisoryActorName = body.actor.actorName;
        }
      }
      const actor: ApprovalRequestActorSnapshot = {
        actorId: DEFAULT_ACTOR.actorId,
        actorType: DEFAULT_ACTOR.actorType,
        actorName: advisoryActorName ?? DEFAULT_ACTOR.actorName,
      };
      const { store: scopedStore, projectId } = await getProjectContext(req);
      const settings = await scopedStore.getSettings();
      const worktrunkSettings = settings.worktrunk ?? {};
      const layer2 = requireAsyncLayer(scopedStore, "Worktrunk approval store");
      const approvalStore = new ApprovalRequestStore(null, { asyncLayer: layer2 });

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
