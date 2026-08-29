import { CentralCore, sanitizeDockerNodeConfigForResponse, validateDockerNodeConfig } from "@fusion/core";
import type { NodeConfig, NodeStatus } from "@fusion/core";
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

  /*
  FNXC:NodeRegistry 2026-07-15-00:00:
  Every node route needs a CentralCore authority to read/write the node registry.
  When the server injects a shared authority (`options.centralCore`), its lifecycle is owned by the
  server: the route must NEVER call `init()`/`close()` on it. When no shared authority is injected the
  route owns a fallback: construct once, `init()` once, and guarantee `close()` on EVERY exit path
  (success and error). A prior version closed the fallback only on success branches, so any handler that
  threw (validation, not-found, upstream failure) leaked the fallback connection. `withCentralCore`
  centralizes this so no handler can forget the finally-close, and closes best-effort if `init()` itself
  throws so a partially-opened fallback never leaks.
  */
  const withCentralCore = async <T>(fn: (central: CentralCore) => T | Promise<T>): Promise<T> => {
    const shared = options?.centralCore;
    if (shared) {
      // Shared authority: server-owned lifecycle — do not init/close here.
      return await fn(shared);
    }

    const central = new CentralCore();
    try {
      await central.init();
    } catch (initErr) {
      // init failed → close best-effort so a partially-opened fallback does not leak.
      await central.close().catch(() => {});
      throw initErr;
    }

    try {
      return await fn(central);
    } finally {
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
      const nodes = await withCentralCore((central) => central.listNodes());

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

      const node = await withCentralCore((central) => central.registerNode({
        name: name.trim(),
        type: nodeType,
        url: typeof url === "string" ? url.trim() : undefined,
        apiKey: typeof apiKey === "string" ? apiKey : undefined,
        maxConcurrent,
        capabilities,
        dockerConfig,
      }));

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
    try {
      const mappings = await withCentralCore((central) =>
        central.listProjectNodePathMappingsForNode(req.params.id),
      );
      res.json(mappings);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      const status = message.includes("Node not found") ? 404 : 500;
      throw new ApiError(status, message);
    }
  });

  /**
   * GET /api/nodes/:id
   * Get node details by ID.
   */
  router.get("/nodes/:id", async (req, res) => {
    try {
      const node = await withCentralCore((central) => central.getNode(req.params.id));

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

      const updates: Partial<Omit<NodeConfig, "id" | "createdAt">> = {};
      if (name !== undefined) updates.name = name;
      if (url !== undefined) updates.url = url;
      if (apiKey !== undefined) updates.apiKey = apiKey;
      if (maxConcurrent !== undefined) updates.maxConcurrent = maxConcurrent;
      if (status !== undefined) updates.status = status as NodeStatus;
      if (capabilities !== undefined) updates.capabilities = capabilities;
      if (dockerConfig !== undefined) updates.dockerConfig = dockerConfig;

      const node = await withCentralCore((central) => central.updateNode(req.params.id, updates));

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
      const node = await withCentralCore((central) => central.getNode(req.params.id));
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
      const updated = await withCentralCore(async (central) => {
        const node = await central.getNode(req.params.id);
        if (!node) {
          throw notFound("Node not found");
        }
        return central.updateNode(req.params.id, { dockerConfig: validation.config });
      });
      res.json(sanitizeDockerNodeConfigForResponse(updated.dockerConfig!));
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  router.patch("/nodes/:id/docker-config", async (req, res) => {
    try {
      const updated = await withCentralCore(async (central) => {
        const node = await central.getNode(req.params.id);
        if (!node) {
          throw notFound("Node not found");
        }
        const existing = node.dockerConfig;
        if (!existing) {
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
          throw new ApiError(400, "Invalid Docker config", { errors: validation.errors ?? [] });
        }

        return central.updateNode(req.params.id, { dockerConfig: validation.config });
      });
      res.json(sanitizeDockerNodeConfigForResponse(updated.dockerConfig!));
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  router.get("/nodes/:id/docker-config/diff", async (req, res) => {
    try {
      const node = await withCentralCore((central) => central.getNode(req.params.id));
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
      await withCentralCore(async (central) => {
        const existing = await central.getNode(req.params.id);
        if (!existing) {
          throw notFound("Node not found");
        }

        await central.unregisterNode(req.params.id);
      });

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
      const healthStatus = await withCentralCore((central) => central.checkNodeHealth(req.params.id));

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
      const node = await withCentralCore((central) => central.getNode(req.params.id));

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
      const node = await withCentralCore((central) => central.getNode(req.params.id));

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
      const result = await withCentralCore(async (central) => {
        // Validate target node exists
        const targetNode = await central.getNode(req.params.id);
        if (!targetNode) {
          throw notFound("Node not found");
        }

        // Reject local target nodes - sync-plugins is for remote nodes only
        if (targetNode.type === "local") {
          throw badRequest("Cannot sync plugins to a local node - sync-plugins is for remote nodes only");
        }

        // Find the local node
        const nodes = await central.listNodes();
        const localNode = nodes.find((n) => n.type === "local");
        if (!localNode) {
          throw badRequest("Local node not registered - cannot perform sync");
        }

        // Perform plugin sync comparison
        return central.syncPlugins(localNode.id, targetNode.id);
      });

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
      const result = await withCentralCore(async (central) => {
        // Validate target node exists
        const targetNode = await central.getNode(req.params.id);
        if (!targetNode) {
          throw notFound("Node not found");
        }

        // Find the local node
        const nodes = await central.listNodes();
        const localNode = nodes.find((n) => n.type === "local");
        if (!localNode) {
          throw badRequest("Local node not registered - cannot check compatibility");
        }

        // Get version info for both nodes
        const localVersionInfo = await central.getNodeVersionInfo(localNode.id);
        const targetVersionInfo = await central.getNodeVersionInfo(targetNode.id);

        // Validate both have version info
        if (!localVersionInfo) {
          throw badRequest("Local node has no version info yet");
        }
        if (!targetVersionInfo) {
          throw badRequest("Target node has no version info yet");
        }

        // Check compatibility using version strings
        return central.checkVersionCompatibility(
          localVersionInfo.appVersion,
          targetVersionInfo.appVersion,
        );
      });

      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });
};
