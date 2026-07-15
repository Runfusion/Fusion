import { validateSnapshotEnvelope } from "@fusion/core";
import { createFusionAuthStorage } from "@fusion/engine";
import { ApiError, badRequest } from "../api-error.js";
import type { ApiRouteRegistrar } from "./types.js";

export const registerMeshRoutes: ApiRouteRegistrar = (ctx) => {
  const { router, store, options, emitRemoteRouteDiagnostic, rethrowAsApiError } = ctx;

  const withCentralCore = async <T>(work: (central: import("@fusion/core").CentralCore) => Promise<T>): Promise<T> => {
    const { CentralCore } = await import("@fusion/core");
    const sharedCentral = options?.centralCore;
    const central = sharedCentral ?? new CentralCore();
    const shouldClose = !sharedCentral;
    if (!sharedCentral || (typeof central.isInitialized === "function" && !central.isInitialized())) {
      await central.init();
    }
    try {
      return await work(central);
    } finally {
      if (shouldClose) {
        await central.close();
      }
    }
  };

  const requireMeshAuth = async (
    req: { headers: { authorization?: string } },
    res: { status: (code: number) => { json: (payload: unknown) => void } },
    senderNodeId?: string,
  ): Promise<boolean> => {
    if (!senderNodeId) return true;
    const senderNode = await withCentralCore((central) => central.getNode(senderNodeId));
    if (!senderNode?.apiKey) return true;
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
    if (!token || token !== senderNode.apiKey) {
      res.status(401).json({ error: "Unauthorized" });
      return false;
    }
    return true;
  };

  // ── Mesh Topology Routes ────────────────────────────────────────────────

  /**
   * GET /api/mesh/state
   * Returns the full mesh topology state with peer connections between nodes.
   */
  router.get("/mesh/state", async (req, res) => {
    try {
      const includeRemote = req.query.includeRemote !== "false";
      const meshState = await withCentralCore(async (central) => {
        const { z } = await import("zod");
        const metricsSchema = z.object({
          cpuUsage: z.number(),
          memoryUsed: z.number(),
          memoryTotal: z.number(),
          storageUsed: z.number(),
          storageTotal: z.number(),
          uptime: z.number(),
          reportedAt: z.string(),
        });
        const nodeMeshStateSchema = z.object({
          nodeId: z.string(),
          nodeName: z.string(),
          nodeUrl: z.string().optional(),
          nodeType: z.enum(["local", "remote"]),
          status: z.enum(["online", "offline", "connecting", "error"]),
          metrics: metricsSchema.nullable(),
          lastSeen: z.string(),
          connectedAt: z.string(),
          knownPeers: z.array(z.object({
            id: z.string(),
            nodeId: z.string(),
            peerNodeId: z.string(),
            name: z.string(),
            url: z.string(),
            status: z.enum(["online", "offline", "connecting", "error"]),
            lastSeen: z.string(),
            connectedAt: z.string(),
          })),
        });
        const meshArraySchema = z.array(nodeMeshStateSchema);

        const localSnapshots = await central.getLocalMeshSnapshot();
        const sourceNodeId = localSnapshots.find((entry) => entry.nodeType === "local")?.nodeId ?? "unknown";

        const nodesById = new Map(localSnapshots.map((entry) => [entry.nodeId, entry]));
        if (!includeRemote) {
          return {
            collectedAt: new Date().toISOString(),
            sourceNodeId,
            nodes: Array.from(nodesById.values()),
          };
        }

        const registeredNodes = await central.listNodes();
        const remoteNodes = registeredNodes.filter((node) => node.type === "remote" && node.url);

        const remoteResults = await Promise.allSettled(
          remoteNodes.map(async (remoteNode) => {
            const headers: Record<string, string> = { "Content-Type": "application/json" };
            if (remoteNode.apiKey) {
              headers.Authorization = `Bearer ${remoteNode.apiKey}`;
            }
            const response = await fetch(`${remoteNode.url!.replace(/\/$/, "")}/api/mesh/state?includeRemote=false`, {
              method: "GET",
              headers,
              signal: AbortSignal.timeout(10_000),
            });
            if (!response.ok) {
              throw new Error(`Remote mesh state request failed (${response.status})`);
            }
            const payload = await response.json() as unknown;
            if (!payload || typeof payload !== "object") {
              throw new Error("Remote mesh state payload was not an object");
            }
            const remoteNodesPayload = meshArraySchema.parse((payload as { nodes?: unknown }).nodes);
            return remoteNodesPayload.map((entry) => ({ ...entry, nodeUrl: entry.nodeUrl ?? undefined }));
          }),
        );

        remoteResults.forEach((result, index) => {
          const remoteNode = remoteNodes[index];
          if (result.status === "fulfilled") {
            for (const snapshot of result.value) {
              nodesById.set(snapshot.nodeId, snapshot);
            }
            return;
          }

          emitRemoteRouteDiagnostic({
            route: "mesh-state",
            message: "Failed to fetch remote mesh state",
            nodeId: remoteNode?.id,
            upstreamPath: "/api/mesh/state",
            operationStage: "fetch-remote-mesh-state",
            level: "warn",
            error: result.reason,
          });
        });

        return {
          collectedAt: new Date().toISOString(),
          sourceNodeId,
          nodes: Array.from(nodesById.values()),
        };
      });

      res.json(meshState);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/mesh/sync
   * Exchange peer information with another node for gossip protocol.
   *
   * Request body: PeerSyncRequest (may include optional settings field)
   * Response body: PeerSyncResponse (may include optional settings field)
   */
  router.post("/mesh/task-ids/reserve", async (req, res) => {
    try {
      /*
      FNXC:SharedPostgresMultiNode 2026-07-14-23:45:
      Always allocate against shared distributed_task_id_* rows. coordinatorNodeId is ignored.
      */
      const prefix = String(req.body?.prefix ?? "").trim();
      const nodeId = String(req.body?.nodeId ?? "").trim();
      const ttlMs = req.body?.ttlMs;
      const senderNodeId = typeof req.body?.senderNodeId === "string" ? req.body.senderNodeId : undefined;
      if (!prefix) throw badRequest("prefix is required");
      if (!nodeId) throw badRequest("nodeId is required");
      if (!(await requireMeshAuth(req, res, senderNodeId))) return;

      const result = await store.getDistributedTaskIdAllocator().reserveDistributedTaskId({ prefix, nodeId, ttlMs });
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  router.post("/mesh/task-ids/commit", async (req, res) => {
    try {
      const reservationId = String(req.body?.reservationId ?? "").trim();
      const nodeId = String(req.body?.nodeId ?? "").trim();
      const senderNodeId = typeof req.body?.senderNodeId === "string" ? req.body.senderNodeId : undefined;
      if (!reservationId) throw badRequest("reservationId is required");
      if (!nodeId) throw badRequest("nodeId is required");
      if (!(await requireMeshAuth(req, res, senderNodeId))) return;

      const result = await store.getDistributedTaskIdAllocator().commitDistributedTaskIdReservation({ reservationId, nodeId });
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      if (err instanceof Error && err.message.toLowerCase().includes("expired")) {
        throw new ApiError(409, err.message);
      }
      rethrowAsApiError(err);
    }
  });

  router.post("/mesh/task-ids/abort", async (req, res) => {
    try {
      const reservationId = String(req.body?.reservationId ?? "").trim();
      const nodeId = String(req.body?.nodeId ?? "").trim();
      const reason = req.body?.reason;
      const senderNodeId = typeof req.body?.senderNodeId === "string" ? req.body.senderNodeId : undefined;
      if (!reservationId) throw badRequest("reservationId is required");
      if (!nodeId) throw badRequest("nodeId is required");
      if (reason !== "abort" && reason !== "expired" && reason !== "failed-create") {
        throw badRequest("reason must be one of: abort, expired, failed-create");
      }
      if (!(await requireMeshAuth(req, res, senderNodeId))) return;

      const result = await store.getDistributedTaskIdAllocator().abortDistributedTaskIdReservation({ reservationId, nodeId, reason });
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  router.get("/mesh/task-ids/state", async (req, res) => {
    try {
      const prefix = String(req.query?.prefix ?? "").trim();
      const senderNodeId = typeof req.query?.senderNodeId === "string" ? req.query.senderNodeId : undefined;
      if (!prefix) throw badRequest("prefix is required");
      if (!(await requireMeshAuth(req, res, senderNodeId))) return;
      const result = await store.getDistributedTaskIdAllocator().getDistributedTaskIdState({ prefix });
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  /*
  FNXC:PostgresCutover 2026-07-12:
  POST /mesh/tasks/create (replicated task creates) is REMOVED entirely: all
  replication is handled at the PostgreSQL level — nodes share the database,
  so the originating node's create is already visible to every peer. The
  legacy sqlite Database on this branch is a throwing stub, so there is no
  topology left that needs mesh task replication.
  */

  router.post("/mesh/sync", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      // Validate required fields
      const senderNodeId = req.body?.senderNodeId;
      if (!senderNodeId) {
        throw badRequest("senderNodeId is required");
      }

      const knownPeers = req.body?.knownPeers;
      if (!Array.isArray(knownPeers)) {
        throw badRequest("knownPeers must be an array");
      }

      // Optional: validate knownPeers entries have required fields
      for (const peer of knownPeers) {
        if (!peer?.nodeId || !peer?.nodeName || typeof peer?.status !== "string") {
          throw badRequest("Each knownPeers entry must have nodeId, nodeName, and status");
        }
      }

      // Get sender node from registry to validate auth
      const senderNode = await central.getNode(senderNodeId);

      // Auth validation: if sender is registered with an apiKey, validate it
      if (senderNode?.apiKey) {
        const authHeader = req.headers.authorization;
        const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;

        if (!token || token !== senderNode.apiKey) {
          await central.close();
          res.status(401).json({ error: "Unauthorized" });
          return;
        }
      }

      // Merge incoming peer data
      await central.mergePeers(knownPeers);

      // Update sender node status to online (it sent us a request, so it's alive)
      try {
        await central.updateNode(senderNodeId, { status: "online" });
      } catch {
        // Silently skip if sender node not found in local registry
      }

      // Get all known peers
      const allKnownPeers = await central.getAllKnownPeerInfo();

      // Calculate newPeers - peers the sender doesn't know about
      const senderKnownIds = new Set(knownPeers.map((p: { nodeId: string }) => p.nodeId));
      const newPeers = allKnownPeers.filter((peer) => !senderKnownIds.has(peer.nodeId));

      // Get local node info
      const localPeer = await central.getLocalPeerInfo();

      /*
      FNXC:PostgresCutover 2026-07-10:
      FNXC:SharedPostgresMultiNode 2026-07-14-23:45:
      Settings and projectSettings mesh sync are retired: shared Postgres is the
      settings SoT. Inbound settings/projectSettings are ignored. Only
      authMaterial (per-machine auth.json) is applied/offered over mesh HTTP.
      */
      if (req.body?.settings) {
        emitRemoteRouteDiagnostic({
          route: "mesh-sync",
          message: "Ignored inbound settings payload — settings live in shared PostgreSQL",
          nodeId: senderNodeId,
          upstreamPath: "/api/mesh/sync",
          operationStage: "settings-sync",
          level: "info",
        });
      }

      // ── Shared state: auth material only ──
      const rawSharedState = req.body?.sharedState;
      let sharedState = rawSharedState;
      if (rawSharedState && typeof rawSharedState === "object") {
        const allowedDomains = ["authMaterial"];
        const ignoredDomains = Object.keys(rawSharedState).filter((domain) => !allowedDomains.includes(domain));
        if (ignoredDomains.length > 0) {
          emitRemoteRouteDiagnostic({
            route: "mesh-sync",
            message: `Ignored inbound shared-state domains [${ignoredDomains.join(", ")}] — only authMaterial is exchanged over mesh (durable state is shared PostgreSQL)`,
            nodeId: senderNodeId,
            upstreamPath: "/api/mesh/sync",
            operationStage: "shared-state-sync",
            level: "info",
          });
        }
        const filtered: Record<string, unknown> = {};
        for (const domain of allowedDomains) {
          if (rawSharedState[domain]) filtered[domain] = rawSharedState[domain];
        }
        sharedState = Object.keys(filtered).length > 0 ? filtered : undefined;
      }
      if (sharedState && typeof sharedState === "object") {
        const applyDomain = async (domain: string, fn: () => Promise<void> | void): Promise<void> => {
          try {
            await fn();
          } catch (err) {
            emitRemoteRouteDiagnostic({
              route: "mesh-sync",
              message: `Failed to apply shared state domain: ${domain}`,
              nodeId: senderNodeId,
              upstreamPath: "/api/mesh/sync",
              operationStage: `apply-shared-state-${domain}`,
              level: "warn",
              error: err,
            });
          }
        };

        await applyDomain("auth-material", async () => {
          if (!sharedState.authMaterial) return;
          validateSnapshotEnvelope(sharedState.authMaterial);
          const applied = central.applyAuthMaterialSnapshot(sharedState.authMaterial as Parameters<typeof central.applyAuthMaterialSnapshot>[0]);
          /*
           * FNXC:ProviderAuth 2026-07-07-00:00:
           * Dashboard sync/mesh credential writes must go through the coordinated createFusionAuthStorage()
           * proxy (reload-before-persist, supplemental-credential sync, logout suppression, Anthropic aliasing)
           * instead of a raw AuthStorage.create(getFusionAuthPath()) instance, so concurrent Fusion processes
           * sharing ~/.fusion/agent/auth.json do not clobber each other's saved provider keys. FN-7647,
           * follow-up to FN-7646's engine-side hardening. Uses a static top-level import (not dynamic
           * import) per FN-3049's bundler-safety rule against dynamic engine imports (`await` + `import(...)` of the engine package).
           */
          const authStorage = createFusionAuthStorage();
          for (const [providerId, credential] of Object.entries(applied.providerAuth)) {
            if (credential.type === "api_key" && credential.key) {
              authStorage.set(providerId, { type: "api_key", key: credential.key });
              continue;
            }
            if (credential.type === "oauth" && credential.accessToken && credential.refreshToken && typeof credential.expires === "number") {
              authStorage.set(providerId, {
                type: "oauth",
                access: credential.accessToken,
                refresh: credential.refreshToken,
                expires: credential.expires,
                ...(credential.accountId ? { accountId: credential.accountId } : {}),
              });
            }
          }
        });

      }

      // Build shared-state response: authMaterial only (file-local credentials).
      const responseSharedState: Record<string, unknown> = {};
      const collectSnapshot = async (domain: string, fn: () => Promise<unknown>): Promise<void> => {
        try {
          const snapshot = await fn();
          if (!snapshot) {
            emitRemoteRouteDiagnostic({
              route: "mesh-sync",
              message: `No shared state snapshot available for domain: ${domain}`,
              nodeId: senderNodeId,
              upstreamPath: "/api/mesh/sync",
              operationStage: `build-shared-state-${domain}`,
              level: "info",
            });
            return;
          }
          responseSharedState[domain] = snapshot;
        } catch (err) {
          emitRemoteRouteDiagnostic({
            route: "mesh-sync",
            message: `Failed to build shared state snapshot for domain: ${domain}`,
            nodeId: senderNodeId,
            upstreamPath: "/api/mesh/sync",
            operationStage: `build-shared-state-${domain}`,
            level: "warn",
            error: err,
          });
        }
      };

      await collectSnapshot("authMaterial", async () => {
        const authPathsModule = await import("./register-settings-sync-helpers.js");
        const allProviders = await authPathsModule.readStoredAuthProvidersFromDisk();
        return central.getAuthMaterialSnapshot(authPathsModule.toProviderAuthEntries(allProviders));
      });

      await central.close();

      // Return sync response (membership + optional auth material only)
      const response: Record<string, unknown> = {
        senderNodeId: localPeer.nodeId,
        senderNodeUrl: localPeer.nodeUrl,
        knownPeers: allKnownPeers,
        newPeers,
        timestamp: new Date().toISOString(),
      };

      if (Object.keys(responseSharedState).length > 0) {
        response.sharedState = responseSharedState;
      }

      res.json(response);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });
};
