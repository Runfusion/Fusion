import { ApiError, badRequest, notFound } from "../api-error.js";
import type { ApiRouteRegistrar } from "./types.js";

export const registerNodeRoutes: ApiRouteRegistrar = (ctx) => {
  const { router, rethrowAsApiError } = ctx;

  // ── Node Management Routes (Multi-Node Support) ───────────────────────────

  /**
   * GET /api/nodes
   * List all registered nodes.
   * Returns: NodeConfig[]
   */
  router.get("/nodes", async (_req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      const nodes = await central.listNodes();
      await central.close();

      nodes.sort((a, b) => a.name.localeCompare(b.name));
      res.json(nodes);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/nodes
   * Register a new node.
   * Body: { name, type, url?, apiKey?, maxConcurrent?, capabilities? }
   */
  router.post("/nodes", async (req, res) => {
    try {
      const { name, type, url, apiKey, maxConcurrent, capabilities } = req.body;

      if (!name || typeof name !== "string" || !name.trim()) {
        throw badRequest("name is required and must be a non-empty string");
      }

      // Default to "remote" for backward compatibility with frontend API calls
      const nodeType = type === "local" || type === "remote" ? type : "remote";

      if (nodeType === "remote" && (!url || typeof url !== "string" || !url.trim())) {
        throw badRequest("url is required for remote nodes");
      }

      if (
        maxConcurrent !== undefined
        && (typeof maxConcurrent !== "number" || !Number.isFinite(maxConcurrent) || maxConcurrent < 1)
      ) {
        throw badRequest("maxConcurrent must be a number >= 1");
      }

      if (
        capabilities !== undefined
        && (!Array.isArray(capabilities) || capabilities.some((capability) => typeof capability !== "string"))
      ) {
        throw badRequest("capabilities must be an array of strings");
      }

      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      const node = await central.registerNode({
        name: name.trim(),
        type: nodeType,
        url: typeof url === "string" ? url.trim() : undefined,
        apiKey: typeof apiKey === "string" ? apiKey : undefined,
        maxConcurrent,
        capabilities,
      });

      await central.close();
      res.status(201).json(node);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = (err instanceof Error ? err.message : String(err)).includes("already exists")
        ? 409
        : (err instanceof Error ? err.message : String(err)).includes("must")
          ? 400
          : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  /**
   * GET /api/nodes/:id
   * Get node details by ID.
   */
  router.get("/nodes/:id", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      const node = await central.getNode(req.params.id);
      await central.close();

      if (!node) {
        throw notFound("Node not found");
      }

      res.json(node);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * PATCH /api/nodes/:id
   * Update node config.
   */
  router.patch("/nodes/:id", async (req, res) => {
    try {
      const { name, url, apiKey, maxConcurrent, status, capabilities } = req.body;

      const updates: Partial<Omit<import("@fusion/core").NodeConfig, "id" | "createdAt">> = {};
      if (name !== undefined) updates.name = name;
      if (url !== undefined) updates.url = url;
      if (apiKey !== undefined) updates.apiKey = apiKey;
      if (maxConcurrent !== undefined) updates.maxConcurrent = maxConcurrent;
      if (status !== undefined) updates.status = status as import("@fusion/core").NodeStatus;
      if (capabilities !== undefined) updates.capabilities = capabilities;

      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      const node = await central.updateNode(req.params.id, updates);
      await central.close();

      res.json(node);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = (err instanceof Error ? err.message : String(err)).includes("not found")
        ? 404
        : (err instanceof Error ? err.message : String(err)).includes("must")
          ? 400
          : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  /**
   * DELETE /api/nodes/:id
   * Unregister a node.
   */
  router.delete("/nodes/:id", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      const existing = await central.getNode(req.params.id);
      if (!existing) {
        await central.close();
        throw notFound("Node not found");
      }

      await central.unregisterNode(req.params.id);
      await central.close();

      res.status(204).end();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/nodes/:id/health-check
   * Trigger health check for a node.
   */
  router.post("/nodes/:id/health-check", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      const healthStatus = await central.checkNodeHealth(req.params.id);
      await central.close();

      res.json({ status: healthStatus });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = (err instanceof Error ? err.message : String(err)).includes("not found") ? 404 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  /**
   * GET /api/nodes/:id/metrics
   * Get node runtime metrics (SystemMetrics from node's systemMetrics field).
   */
  router.get("/nodes/:id/metrics", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      const node = await central.getNode(req.params.id);
      await central.close();

      if (!node) {
        throw notFound("Node not found");
      }

      // Return the systemMetrics field which contains SystemMetrics or null
      res.json(node.systemMetrics ?? null);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/nodes/:id/version
   * Get version information for a node.
   * Returns NodeVersionInfo when present, null when no version info has been stored yet.
   */
  router.get("/nodes/:id/version", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      const node = await central.getNode(req.params.id);
      await central.close();

      if (!node) {
        throw notFound("Node not found");
      }

      // Return versionInfo if present, null if not yet stored
      res.json(node.versionInfo ?? null);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/nodes/:id/sync-plugins
   * Compare plugin versions between the local node and a remote node.
   * Returns PluginSyncResult with recommendations for each plugin.
   */
  router.post("/nodes/:id/sync-plugins", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      // Validate target node exists
      const targetNode = await central.getNode(req.params.id);
      if (!targetNode) {
        await central.close();
        throw notFound("Node not found");
      }

      // Reject local target nodes - sync-plugins is for remote nodes only
      if (targetNode.type === "local") {
        await central.close();
        throw badRequest("Cannot sync plugins to a local node - sync-plugins is for remote nodes only");
      }

      // Find the local node
      const nodes = await central.listNodes();
      const localNode = nodes.find((n) => n.type === "local");
      if (!localNode) {
        await central.close();
        throw badRequest("Local node not registered - cannot perform sync");
      }

      // Perform plugin sync comparison
      const result = await central.syncPlugins(localNode.id, targetNode.id);
      await central.close();

      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/nodes/:id/compatibility
   * Check version compatibility between the local node and a target node.
   * Returns VersionCompatibilityResult based on app version comparison.
   */
  router.get("/nodes/:id/compatibility", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      // Validate target node exists
      const targetNode = await central.getNode(req.params.id);
      if (!targetNode) {
        await central.close();
        throw notFound("Node not found");
      }

      // Find the local node
      const nodes = await central.listNodes();
      const localNode = nodes.find((n) => n.type === "local");
      if (!localNode) {
        await central.close();
        throw badRequest("Local node not registered - cannot check compatibility");
      }

      // Get version info for both nodes
      const localVersionInfo = await central.getNodeVersionInfo(localNode.id);
      const targetVersionInfo = await central.getNodeVersionInfo(targetNode.id);

      // Validate both have version info
      if (!localVersionInfo) {
        await central.close();
        throw badRequest("Local node has no version info yet");
      }
      if (!targetVersionInfo) {
        await central.close();
        throw badRequest("Target node has no version info yet");
      }

      // Check compatibility using version strings
      const result = central.checkVersionCompatibility(
        localVersionInfo.appVersion,
        targetVersionInfo.appVersion,
      );
      await central.close();

      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });
};
