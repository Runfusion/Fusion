import { ApiError, badRequest } from "../api-error.js";
import type { ApiRouteRegistrar } from "./types.js";

export const registerDiscoveryRoutes: ApiRouteRegistrar = (ctx) => {
  const { router, options, rethrowAsApiError } = ctx;

  // ── Node Discovery Routes (mDNS / DNS-SD) ────────────────────────────────

  /**
   * GET /api/discovery/status
   * Returns whether discovery is active and the current config.
   */
  router.get("/discovery/status", async (_req, res) => {
    try {
      const central = options?.centralCore ?? new (await import("@fusion/core")).CentralCore();
      const shouldClose = !options?.centralCore;
      if (shouldClose) await central.init();

      const active = central.isDiscoveryActive();
      const config = central.getDiscoveryConfig();
      if (shouldClose) await central.close();

      res.json({ active, config });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/discovery/start
   * Body: { broadcast?: boolean, listen?: boolean, port?: number, serviceType?: string }
   */
  router.post("/discovery/start", async (req, res) => {
    try {
      const broadcast = req.body?.broadcast ?? true;
      const listen = req.body?.listen ?? true;
      const requestPort = req.body?.port;
      const serviceType = typeof req.body?.serviceType === "string" && req.body.serviceType.trim().length > 0
        ? req.body.serviceType.trim()
        : "_fusion._tcp";

      if (typeof broadcast !== "boolean") {
        throw badRequest("broadcast must be a boolean");
      }
      if (typeof listen !== "boolean") {
        throw badRequest("listen must be a boolean");
      }
      if (
        requestPort !== undefined
        && (typeof requestPort !== "number" || !Number.isFinite(requestPort) || requestPort < 1)
      ) {
        throw badRequest("port must be a number >= 1");
      }

      const localPort = typeof req.socket.localPort === "number" && req.socket.localPort > 0
        ? req.socket.localPort
        : 4040;
      const port = requestPort ?? localPort;

      const config: import("@fusion/core").DiscoveryConfig = {
        broadcast,
        listen,
        serviceType,
        port,
        staleTimeoutMs: 300_000,
      };

      const central = options?.centralCore ?? new (await import("@fusion/core")).CentralCore();
      const shouldClose = !options?.centralCore;
      if (shouldClose) await central.init();

      await central.startDiscovery(config);
      if (shouldClose) await central.close();

      res.json({ success: true, config });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/discovery/stop
   * Stops active mDNS discovery.
   */
  router.post("/discovery/stop", async (_req, res) => {
    try {
      const central = options?.centralCore ?? new (await import("@fusion/core")).CentralCore();
      const shouldClose = !options?.centralCore;
      if (shouldClose) await central.init();

      central.stopDiscovery();
      if (shouldClose) await central.close();

      res.json({ success: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/discovery/nodes
   * List currently discovered nodes.
   */
  router.get("/discovery/nodes", async (_req, res) => {
    try {
      const central = options?.centralCore ?? new (await import("@fusion/core")).CentralCore();
      const shouldClose = !options?.centralCore;
      if (shouldClose) await central.init();

      const nodes = central.getDiscoveredNodes();
      if (shouldClose) await central.close();

      res.json(nodes);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/discovery/connect
   * Register a discovered node in the node registry.
   * Body: { name: string, host: string, port: number, apiKey?: string }
   */
  router.post("/discovery/connect", async (req, res) => {
    try {
      const { name, host, port, apiKey } = req.body as {
        name?: unknown;
        host?: unknown;
        port?: unknown;
        apiKey?: unknown;
      };

      if (typeof name !== "string" || !name.trim()) {
        throw badRequest("name is required and must be a non-empty string");
      }
      if (typeof host !== "string" || !host.trim()) {
        throw badRequest("host is required and must be a non-empty string");
      }
      if (typeof port !== "number" || !Number.isFinite(port) || port < 1) {
        throw badRequest("port is required and must be a number >= 1");
      }
      if (apiKey !== undefined && typeof apiKey !== "string") {
        throw badRequest("apiKey must be a string");
      }

      let normalizedHost = host.trim();
      try {
        const url = new URL(normalizedHost);
        normalizedHost = url.hostname;
      } catch {
        normalizedHost = normalizedHost.replace(/^https?:\/\//, "");
      }
      normalizedHost = normalizedHost.split("/")[0] ?? normalizedHost;

      const normalizedUrl = `http://${normalizedHost}:${port}`;

      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      const node = await central.registerNode({
        name: name.trim(),
        type: "remote",
        url: normalizedUrl,
        apiKey: typeof apiKey === "string" && apiKey.length > 0 ? apiKey : undefined,
      });

      try {
        await central.checkNodeHealth(node.id);
      } catch {
        // Best effort only; registration itself succeeded.
      }

      await central.close();
      res.json(node);
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
};
