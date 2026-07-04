import { ApiError, badRequest } from "../api-error.js";
import type { ApiRouteRegistrar } from "./types.js";
import { fetchFromRemoteNode } from "./register-settings-sync-helpers.js";

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

  const resolveAllocator = async (coordinatorNodeId?: string) => {
    return withCentralCore(async (central) => {
      if (!coordinatorNodeId) {
        return { mode: "local" as const };
      }
      const coordinator = await central.getNode(coordinatorNodeId);
      if (coordinator?.type === "local") {
        return { mode: "local" as const };
      }
      if (!coordinator) {
        throw new ApiError(503, "Allocator coordinator is unavailable");
      }
      return { mode: "remote" as const, coordinator };
    });
  };

  const mapCoordinatorWriteError = (err: unknown): never => {
    if (err instanceof ApiError && [502, 504].includes(err.statusCode)) {
      throw new ApiError(503, "Allocator coordinator is unavailable");
    }
    throw err;
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
      const prefix = String(req.body?.prefix ?? "").trim();
      const nodeId = String(req.body?.nodeId ?? "").trim();
      const ttlMs = req.body?.ttlMs;
      const coordinatorNodeId = typeof req.body?.coordinatorNodeId === "string" ? req.body.coordinatorNodeId : undefined;
      const senderNodeId = typeof req.body?.senderNodeId === "string" ? req.body.senderNodeId : undefined;
      if (!prefix) throw badRequest("prefix is required");
      if (!nodeId) throw badRequest("nodeId is required");
      if (!(await requireMeshAuth(req, res, senderNodeId))) return;

      const target = await resolveAllocator(coordinatorNodeId);
      if (target.mode === "remote") {
        try {
          const remote = await fetchFromRemoteNode(target.coordinator, "/api/mesh/task-ids/reserve", {
            method: "POST",
            body: { prefix, nodeId, ttlMs },
          });
          res.json(remote);
          return;
        } catch (err) {
          mapCoordinatorWriteError(err);
        }
      }

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
      const coordinatorNodeId = typeof req.body?.coordinatorNodeId === "string" ? req.body.coordinatorNodeId : undefined;
      const senderNodeId = typeof req.body?.senderNodeId === "string" ? req.body.senderNodeId : undefined;
      if (!reservationId) throw badRequest("reservationId is required");
      if (!nodeId) throw badRequest("nodeId is required");
      if (!(await requireMeshAuth(req, res, senderNodeId))) return;

      const target = await resolveAllocator(coordinatorNodeId);
      if (target.mode === "remote") {
        try {
          const remote = await fetchFromRemoteNode(target.coordinator, "/api/mesh/task-ids/commit", {
            method: "POST",
            body: { reservationId, nodeId },
          });
          res.json(remote);
          return;
        } catch (err) {
          mapCoordinatorWriteError(err);
        }
      }

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
      const coordinatorNodeId = typeof req.body?.coordinatorNodeId === "string" ? req.body.coordinatorNodeId : undefined;
      const senderNodeId = typeof req.body?.senderNodeId === "string" ? req.body.senderNodeId : undefined;
      if (!reservationId) throw badRequest("reservationId is required");
      if (!nodeId) throw badRequest("nodeId is required");
      if (reason !== "abort" && reason !== "expired" && reason !== "failed-create") {
        throw badRequest("reason must be one of: abort, expired, failed-create");
      }
      if (!(await requireMeshAuth(req, res, senderNodeId))) return;

      const target = await resolveAllocator(coordinatorNodeId);
      if (target.mode === "remote") {
        try {
          const remote = await fetchFromRemoteNode(target.coordinator, "/api/mesh/task-ids/abort", {
            method: "POST",
            body: { reservationId, nodeId, reason },
          });
          res.json(remote);
          return;
        } catch (err) {
          mapCoordinatorWriteError(err);
        }
      }

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

  router.post("/mesh/tasks/create", async (req, res) => {
    const payload = req.body;
    try {
      const senderNodeId = typeof payload?.sourceNodeId === "string" ? payload.sourceNodeId : undefined;
      if (!(await requireMeshAuth(req, res, senderNodeId))) return;
      if (payload?.replicationVersion !== 1) throw badRequest("replicationVersion must be 1");
      if (typeof payload?.reservationId !== "string" || payload.reservationId.trim().length === 0) throw badRequest("reservationId is required");
      if (typeof payload?.taskId !== "string" || payload.taskId.trim().length === 0) throw badRequest("taskId is required");
      if (typeof payload?.sourceNodeId !== "string" || payload.sourceNodeId.trim().length === 0) throw badRequest("sourceNodeId is required");
      if (typeof payload?.createdAt !== "string" || typeof payload?.updatedAt !== "string") throw badRequest("createdAt and updatedAt are required");
      if (typeof payload?.prompt !== "string") throw badRequest("prompt is required");
      if (!payload?.input || typeof payload.input !== "object") throw badRequest("input is required");

      const result = await store.applyReplicatedTaskCreate(payload);
      res.status(result.applied ? 201 : 200).json(result);
    } catch (err: unknown) {
      emitRemoteRouteDiagnostic({
        route: "mesh-task-create",
        message: "Failed to apply replicated task create",
        nodeId: typeof payload?.sourceNodeId === "string" ? payload.sourceNodeId : undefined,
        upstreamPath: "/api/mesh/tasks/create",
        operationStage: "apply-replicated-create",
        error: err,
      });
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

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

      // ── Settings sync: handle incoming settings and prepare response ──
      let responseSettings: import("@fusion/core").SettingsSyncPayload | undefined;
      const remoteSettings = req.body?.settings;

      if (remoteSettings) {
        try {
          // Get local settings from the dashboard's GlobalSettingsStore
          const localGlobal = await store.getGlobalSettingsStore().getSettings();
          const localPayload = await central.getSettingsForSync(localGlobal);
          const localChecksum = localPayload.checksum;

          // Apply remote settings if checksum differs (remote is newer/different)
          if (remoteSettings.checksum !== localChecksum) {
            const applyResult = await central.applyRemoteSettings(remoteSettings);

            if (applyResult.success) {
              emitRemoteRouteDiagnostic({
                route: "mesh-sync",
                message: "Applied remote settings payload",
                nodeId: senderNodeId,
                upstreamPath: "/api/mesh/sync",
                operationStage: "apply-remote-settings",
                level: "info",
                context: {
                  globalCount: applyResult.globalCount,
                  projectCount: applyResult.projectCount,
                  authCount: applyResult.authCount,
                },
              });
            } else {
              emitRemoteRouteDiagnostic({
                route: "mesh-sync",
                message: "Failed to apply remote settings payload",
                nodeId: senderNodeId,
                upstreamPath: "/api/mesh/sync",
                operationStage: "apply-remote-settings",
                level: "warn",
                error: new Error(applyResult.error ?? "Unknown applyRemoteSettings failure"),
              });
            }
          }

          // Always respond with our settings if sender included theirs
          responseSettings = localPayload;
        } catch (err) {
          // Log but don't fail the sync - peers are more important
          emitRemoteRouteDiagnostic({
            route: "mesh-sync",
            message: "Settings sync operation failed",
            nodeId: senderNodeId,
            upstreamPath: "/api/mesh/sync",
            operationStage: "settings-sync",
            error: err,
          });
        }
      }

      // ── Shared state sync: apply inbound domain snapshots independently ──
      const { AgentStore, SHARED_STATE_DEFAULT_LIMIT, validateSnapshotEnvelope, MissionStore } = await import("@fusion/core");
      const sharedState = req.body?.sharedState;
      if (sharedState && typeof sharedState === "object") {
        const missionStore = store.getMissionStore();
        const fusionDir = store.getFusionDir();
        let agentStore: InstanceType<typeof AgentStore> | null = null;

        const ensureAgentStore = async (): Promise<InstanceType<typeof AgentStore>> => {
          if (agentStore) return agentStore;
          const newStore = new AgentStore({ rootDir: fusionDir, taskStore: store, asyncLayer: store.getAsyncLayer() ?? undefined });
          await newStore.init();
          agentStore = newStore;
          return agentStore;
        };

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

        await applyDomain("task-metadata", async () => {
          if (!sharedState.taskMetadata) return;
          validateSnapshotEnvelope(sharedState.taskMetadata);
          await store.applyTaskMetadataSnapshot(sharedState.taskMetadata as Parameters<typeof store.applyTaskMetadataSnapshot>[0]);
        });

        await applyDomain("mission-hierarchy", async () => {
          if (!sharedState.missionHierarchy) return;
          validateSnapshotEnvelope(sharedState.missionHierarchy);
          // FNXC:MissionStore 2026-06-27-15:45:
          // applyMissionHierarchySnapshot is sync-only (mesh replication). In PG
          // backend mode getMissionStore() returns the AsyncMissionStore which does
          // not implement it; guard with instanceof and skip — mission mesh sync is
          // a sync-mode-only capability this unit.
          if (missionStore instanceof MissionStore) {
            missionStore.applyMissionHierarchySnapshot(sharedState.missionHierarchy as Parameters<typeof missionStore.applyMissionHierarchySnapshot>[0]);
          }
        });

        await applyDomain("agents", async () => {
          if (!sharedState.agents) return;
          validateSnapshotEnvelope(sharedState.agents);
          const activeAgentStore = await ensureAgentStore();
          await activeAgentStore.applyAgentSnapshot(sharedState.agents as Parameters<typeof activeAgentStore.applyAgentSnapshot>[0]);
        });

        await applyDomain("agent-runs", async () => {
          if (!sharedState.agentRuns) return;
          validateSnapshotEnvelope(sharedState.agentRuns);
          const activeAgentStore = await ensureAgentStore();
          await activeAgentStore.applyAgentRunSnapshot(sharedState.agentRuns as Parameters<typeof activeAgentStore.applyAgentRunSnapshot>[0]);
        });

        await applyDomain("activity-log", async () => {
          if (!sharedState.activityLog) return;
          validateSnapshotEnvelope(sharedState.activityLog);
          await store.applyActivityLogSnapshotAsync(sharedState.activityLog as Parameters<typeof store.applyActivityLogSnapshotAsync>[0]);
        });

        await applyDomain("run-audit", async () => {
          if (!sharedState.runAudit) return;
          validateSnapshotEnvelope(sharedState.runAudit);
          store.applyRunAuditSnapshot(sharedState.runAudit as Parameters<typeof store.applyRunAuditSnapshot>[0]);
        });

        await applyDomain("project-settings", async () => {
          if (!sharedState.projectSettings) return;
          validateSnapshotEnvelope(sharedState.projectSettings);
          const result = await central.applyProjectSettingsSnapshot(sharedState.projectSettings as Parameters<typeof central.applyProjectSettingsSnapshot>[0]);
          if (!result.success) {
            throw new Error(result.error ?? "applyProjectSettingsSnapshot failed");
          }
        });

        await applyDomain("auth-material", async () => {
          if (!sharedState.authMaterial) return;
          validateSnapshotEnvelope(sharedState.authMaterial);
          const applied = central.applyAuthMaterialSnapshot(sharedState.authMaterial as Parameters<typeof central.applyAuthMaterialSnapshot>[0]);
          const { AuthStorage } = await import("@earendil-works/pi-coding-agent");
          const { getFusionAuthPath } = await import("../auth-paths.js");
          const authStorage = AuthStorage.create(getFusionAuthPath());
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

        // Intentionally do not close this per-request AgentStore wrapper.
        // AgentStore uses a process-wide DB cache by rootDir; closing here would
        // invalidate shared connections used by long-lived runtime stores.
      }

      // Build shared-state response from fresh local snapshots per request.
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

      await collectSnapshot("taskMetadata", async () => store.getTaskMetadataSnapshot());
      await collectSnapshot("missionHierarchy", async () => {
        // FNXC:MissionStore 2026-06-27-15:45: getMissionHierarchySnapshot is sync-only;
        // skip (undefined snapshot) when the PG AsyncMissionStore is active.
        const { MissionStore: MissionStoreClass } = await import("@fusion/core");
        const ms = store.getMissionStore();
        return ms instanceof MissionStoreClass ? ms.getMissionHierarchySnapshot() : undefined;
      });
      await collectSnapshot("activityLog", async () => store.getActivityLogSnapshot(SHARED_STATE_DEFAULT_LIMIT));
      await collectSnapshot("runAudit", async () => store.getRunAuditSnapshot({ limit: SHARED_STATE_DEFAULT_LIMIT }));

      const responseAgentStore = new AgentStore({ rootDir: store.getFusionDir(), taskStore: store, asyncLayer: store.getAsyncLayer() ?? undefined });
      await responseAgentStore.init();
      await collectSnapshot("agents", async () => responseAgentStore.getAgentSnapshot());
      await collectSnapshot("agentRuns", async () => responseAgentStore.getAgentRunSnapshot(SHARED_STATE_DEFAULT_LIMIT));

      await collectSnapshot("projectSettings", async () => {
        const localGlobal = await store.getGlobalSettingsStore().getSettings();
        return central.getProjectSettingsSnapshot(localGlobal);
      });
      await collectSnapshot("authMaterial", async () => {
        const authPathsModule = await import("./register-settings-sync-helpers.js");
        const allProviders = await authPathsModule.readStoredAuthProvidersFromDisk();
        return central.getAuthMaterialSnapshot(authPathsModule.toProviderAuthEntries(allProviders));
      });

      await central.close();

      // Return sync response
      const response: Record<string, unknown> = {
        senderNodeId: localPeer.nodeId,
        senderNodeUrl: localPeer.nodeUrl,
        knownPeers: allKnownPeers,
        newPeers,
        timestamp: new Date().toISOString(),
      };

      // Include settings in response if sender sent settings
      if (responseSettings) {
        response.settings = responseSettings;
      }
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
