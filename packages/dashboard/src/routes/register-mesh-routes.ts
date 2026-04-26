import { ApiError, badRequest } from "../api-error.js";
import type { ApiRouteRegistrar } from "./types.js";

export const registerMeshRoutes: ApiRouteRegistrar = (ctx) => {
  const { router, store, emitRemoteRouteDiagnostic, rethrowAsApiError } = ctx;

  // ── Mesh Topology Routes ────────────────────────────────────────────────

  /**
   * GET /api/mesh/state
   * Returns the full mesh topology state with peer connections between nodes.
   */
  router.get("/mesh/state", async (_req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      const nodes = await central.listNodes();
      const remoteNodes = nodes.filter((n) => n.type === "remote");
      const meshState: unknown[] = [];
      for (const node of nodes) {
        const state = typeof (central as InstanceType<typeof CentralCore>).getMeshState === "function"
          ? await (central as InstanceType<typeof CentralCore>).getMeshState(node.id)
          : null;
        if (state) {
          meshState.push(state);
        } else {
          const connections =
            node.type === "local"
              ? remoteNodes.map((peer) => ({
                  peerId: peer.id,
                  peerName: peer.name,
                  peerUrl: peer.url ?? null,
                  status: peer.status,
                }))
              : [];
          meshState.push({
            nodeId: node.id,
            nodeName: node.name,
            nodeUrl: node.url ?? null,
            type: node.type,
            status: node.status,
            metrics: null,
            lastSeen: node.updatedAt ?? null,
            connectedAt: node.createdAt ?? null,
            knownPeers: connections,
            connections,
          });
        }
      }
      await central.close();

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

      res.json(response);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });
};
