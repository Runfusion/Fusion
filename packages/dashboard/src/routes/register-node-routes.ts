import { sanitizeDockerNodeConfigForResponse, validateDockerNodeConfig } from "@fusion/core";
import { ApiError, badRequest, notFound } from "../api-error.js";
import type { ApiRouteRegistrar } from "./types.js";

const REMOTE_DISCOVERY_TIMEOUT_MS = 5000;

type DiscoveredRemoteProject = {
  id: string;
  name: string;
  path: string;
  status: "active" | "paused" | "errored" | "initializing";
  isolationMode: "in-process" | "child-process";
};

function normalizeNodeUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw badRequest("url is required and must be a non-empty string");
  }

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withProtocol);
  } catch {
    throw badRequest("url must be a valid HTTP(S) URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw badRequest("url must use http or https");
  }

  return parsed.toString().replace(/\/$/, "");
}

function isDiscoveredRemoteProject(value: unknown): value is DiscoveredRemoteProject {
  if (!value || typeof value !== "object") return false;
  const project = value as Record<string, unknown>;

  return typeof project.id === "string"
    && typeof project.name === "string"
    && typeof project.path === "string"
    && ["active", "paused", "errored", "initializing"].includes(String(project.status))
    && ["in-process", "child-process"].includes(String(project.isolationMode));
}

export const registerNodeRoutes: ApiRouteRegistrar = (ctx) => {
  const { router, options, rethrowAsApiError } = ctx;

  const openCentralCore = async (): Promise<import("@fusion/core").CentralCore> => {
    const sharedCentral = options?.centralCore;
    if (sharedCentral) {
      return sharedCentral;
    }

    const { CentralCore } = await import("@fusion/core");
    const central = new CentralCore();
    await central.init();
    return central;
  };

  const closeCentralCoreIfOwned = async (central: import("@fusion/core").CentralCore): Promise<void> => {
    if (central !== options?.centralCore) {
      await central.close();
    }
  };

  // ── Node Management Routes (Multi-Node Support) ───────────────────────────

  /**
   * GET /api/nodes
   * List all registered nodes.
   * Returns: NodeConfig[]
   */
  router.get("/nodes", async (_req, res) => {
    try {
      const central = await openCentralCore();

      const nodes = await central.listNodes();
      await closeCentralCoreIfOwned(central);

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
      const { name, type, url, apiKey, maxConcurrent, capabilities, dockerConfig } = req.body;

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

      const central = await openCentralCore();

      const node = await central.registerNode({
        name: name.trim(),
        type: nodeType,
        url: typeof url === "string" ? url.trim() : undefined,
        apiKey: typeof apiKey === "string" ? apiKey : undefined,
        maxConcurrent,
        capabilities,
        dockerConfig,
      });

      await closeCentralCoreIfOwned(central);
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
   * POST /api/nodes/discover-projects
   * Discover projects from a remote node before registration.
   * Body: { url: string; apiKey?: string }
   */
  router.post("/nodes/discover-projects", async (req, res) => {
    try {
      const { url, apiKey } = req.body as { url?: unknown; apiKey?: unknown };
      if (typeof url !== "string") {
        throw badRequest("url is required and must be a non-empty string");
      }
      if (apiKey !== undefined && typeof apiKey !== "string") {
        throw badRequest("apiKey must be a string when provided");
      }

      const normalizedUrl = normalizeNodeUrl(url);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REMOTE_DISCOVERY_TIMEOUT_MS);

      try {
        const response = await fetch(`${normalizedUrl}/api/projects`, {
          method: "GET",
          headers: apiKey && apiKey.trim().length > 0 ? { Authorization: `Bearer ${apiKey}` } : undefined,
          signal: controller.signal,
        });

        if (!response.ok) {
          let upstreamMessage = `Remote node returned ${response.status} ${response.statusText}`;
          try {
            const payload = await response.json() as { error?: unknown };
            if (typeof payload?.error === "string" && payload.error.trim()) {
              upstreamMessage = payload.error.trim();
            }
          } catch {
            // keep generic upstream message
          }
          throw new ApiError(response.status, upstreamMessage);
        }

        const rawBody = await response.json() as unknown;
        if (!Array.isArray(rawBody) || !rawBody.every(isDiscoveredRemoteProject)) {
          throw new ApiError(502, "Remote node returned malformed project discovery payload");
        }

        res.json({ projects: rawBody });
      } catch (error) {
        if (error instanceof ApiError) {
          throw error;
        }
        if (error instanceof Error && error.name === "AbortError") {
          throw new ApiError(504, "Remote node discovery request timed out");
        }
        throw new ApiError(502, `Unable to reach remote node: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/nodes/:id/path-mappings
   * List all project path mappings for a node.
   */
  router.get("/nodes/:id/path-mappings", async (req, res) => {
    const central = await openCentralCore();

    try {
      const mappings = await central.listProjectNodePathMappingsForNode(req.params.id);
      res.json(mappings);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      const status = message.includes("Node not found") ? 404 : 500;
      throw new ApiError(status, message);
    } finally {
      await closeCentralCoreIfOwned(central);
    }
  });

  /**
   * GET /api/nodes/:id
   * Get node details by ID.
   */
  router.get("/nodes/:id", async (req, res) => {
    try {
      const central = await openCentralCore();

      const node = await central.getNode(req.params.id);
      await closeCentralCoreIfOwned(central);

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
      const { name, url, apiKey, maxConcurrent, status, capabilities, dockerConfig } = req.body;

      const updates: Partial<Omit<import("@fusion/core").NodeConfig, "id" | "createdAt">> = {};
      if (name !== undefined) updates.name = name;
      if (url !== undefined) updates.url = url;
      if (apiKey !== undefined) updates.apiKey = apiKey;
      if (maxConcurrent !== undefined) updates.maxConcurrent = maxConcurrent;
      if (status !== undefined) updates.status = status as import("@fusion/core").NodeStatus;
      if (capabilities !== undefined) updates.capabilities = capabilities;
      if (dockerConfig !== undefined) updates.dockerConfig = dockerConfig;

      const central = await openCentralCore();

      const node = await central.updateNode(req.params.id, updates);
      await closeCentralCoreIfOwned(central);

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
   * GET /api/nodes/:id/docker-config
   * Return sanitized Docker config for a node.
   */
  router.get("/nodes/:id/docker-config", async (req, res) => {
    try {
      const central = await openCentralCore();
      const node = await central.getNode(req.params.id);
      await closeCentralCoreIfOwned(central);
      if (!node) throw notFound("Node not found");
      res.json(node.dockerConfig ? sanitizeDockerNodeConfigForResponse(node.dockerConfig) : null);
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  /**
   * PUT /api/nodes/:id/docker-config
   * Replace full Docker config for a node.
   */
  router.put("/nodes/:id/docker-config", async (req, res) => {
    try {
      const validation = validateDockerNodeConfig(req.body);
      if (!validation.valid || !validation.config) {
        throw new ApiError(400, "Invalid Docker config", { errors: validation.errors ?? [] });
      }
      const central = await openCentralCore();
      const node = await central.getNode(req.params.id);
      if (!node) {
        await closeCentralCoreIfOwned(central);
        throw notFound("Node not found");
      }
      const updated = await central.updateNode(req.params.id, { dockerConfig: validation.config });
      await closeCentralCoreIfOwned(central);
      res.json(sanitizeDockerNodeConfigForResponse(updated.dockerConfig!));
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  router.patch("/nodes/:id/docker-config", async (req, res) => {
    try {
      const central = await openCentralCore();
      const node = await central.getNode(req.params.id);
      if (!node) {
        await closeCentralCoreIfOwned(central);
        throw notFound("Node not found");
      }
      const existing = node.dockerConfig;
      if (!existing) {
        await closeCentralCoreIfOwned(central);
        throw badRequest("Node has no existing Docker config; use PUT first");
      }

      const patch = req.body as Record<string, unknown>;
      const mergedEnvironment: Record<string, string> = { ...existing.environment };
      if (patch.environment && typeof patch.environment === "object" && !Array.isArray(patch.environment)) {
        for (const [key, value] of Object.entries(patch.environment as Record<string, unknown>)) {
          if (value === null) {
            delete mergedEnvironment[key];
          } else if (typeof value === "string") {
            mergedEnvironment[key] = value;
          }
        }
      }

      const merged = {
        ...existing,
        ...patch,
        environment: mergedEnvironment,
        volumeMounts: patch.volumeMounts !== undefined ? patch.volumeMounts : existing.volumeMounts,
      };

      const validation = validateDockerNodeConfig(merged);
      if (!validation.valid || !validation.config) {
        await closeCentralCoreIfOwned(central);
        throw new ApiError(400, "Invalid Docker config", { errors: validation.errors ?? [] });
      }

      const updated = await central.updateNode(req.params.id, { dockerConfig: validation.config });
      await closeCentralCoreIfOwned(central);
      res.json(sanitizeDockerNodeConfigForResponse(updated.dockerConfig!));
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  router.get("/nodes/:id/docker-config/diff", async (req, res) => {
    try {
      const central = await openCentralCore();
      const node = await central.getNode(req.params.id);
      await closeCentralCoreIfOwned(central);
      if (!node) throw notFound("Node not found");
      if (!node.dockerConfig) {
        res.json({ config: null });
        return;
      }
      res.json({
        persistedVersion: node.dockerConfig.configVersion,
        deployedVersion: null,
        needsRecreate: false,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  /**
   * DELETE /api/nodes/:id
   * Unregister a node.
   */
  router.delete("/nodes/:id", async (req, res) => {
    try {
      const central = await openCentralCore();

      const existing = await central.getNode(req.params.id);
      if (!existing) {
        await closeCentralCoreIfOwned(central);
        throw notFound("Node not found");
      }

      await central.unregisterNode(req.params.id);
      await closeCentralCoreIfOwned(central);

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
      const central = await openCentralCore();

      const healthStatus = await central.checkNodeHealth(req.params.id);
      await closeCentralCoreIfOwned(central);

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
      const central = await openCentralCore();

      const node = await central.getNode(req.params.id);
      await closeCentralCoreIfOwned(central);

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
      const central = await openCentralCore();

      const node = await central.getNode(req.params.id);
      await closeCentralCoreIfOwned(central);

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
      const central = await openCentralCore();

      // Validate target node exists
      const targetNode = await central.getNode(req.params.id);
      if (!targetNode) {
        await closeCentralCoreIfOwned(central);
        throw notFound("Node not found");
      }

      // Reject local target nodes - sync-plugins is for remote nodes only
      if (targetNode.type === "local") {
        await closeCentralCoreIfOwned(central);
        throw badRequest("Cannot sync plugins to a local node - sync-plugins is for remote nodes only");
      }

      // Find the local node
      const nodes = await central.listNodes();
      const localNode = nodes.find((n) => n.type === "local");
      if (!localNode) {
        await closeCentralCoreIfOwned(central);
        throw badRequest("Local node not registered - cannot perform sync");
      }

      // Perform plugin sync comparison
      const result = await central.syncPlugins(localNode.id, targetNode.id);
      await closeCentralCoreIfOwned(central);

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
      const central = await openCentralCore();

      // Validate target node exists
      const targetNode = await central.getNode(req.params.id);
      if (!targetNode) {
        await closeCentralCoreIfOwned(central);
        throw notFound("Node not found");
      }

      // Find the local node
      const nodes = await central.listNodes();
      const localNode = nodes.find((n) => n.type === "local");
      if (!localNode) {
        await closeCentralCoreIfOwned(central);
        throw badRequest("Local node not registered - cannot check compatibility");
      }

      // Get version info for both nodes
      const localVersionInfo = await central.getNodeVersionInfo(localNode.id);
      const targetVersionInfo = await central.getNodeVersionInfo(targetNode.id);

      // Validate both have version info
      if (!localVersionInfo) {
        await closeCentralCoreIfOwned(central);
        throw badRequest("Local node has no version info yet");
      }
      if (!targetVersionInfo) {
        await closeCentralCoreIfOwned(central);
        throw badRequest("Target node has no version info yet");
      }

      // Check compatibility using version strings
      const result = central.checkVersionCompatibility(
        localVersionInfo.appVersion,
        targetVersionInfo.appVersion,
      );
      await closeCentralCoreIfOwned(central);

      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });
};
