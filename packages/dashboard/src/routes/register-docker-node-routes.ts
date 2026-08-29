import type {
  DockerExtraCli,
  DockerHostConfig,
  DockerVolumeMount,
  FullProvisioningInput,
  ManagedDockerNode,
  ManagedDockerNodeInput,
  NodeConfig,
} from "@fusion/core";
import { randomUUID } from "node:crypto";
import { ApiError, badRequest, notFound } from "../api-error.js";
import type { ApiRouteRegistrar } from "./types.js";

const VALID_EXTRA_CLIS: DockerExtraCli[] = ["claude-cli", "droid-cli"];

function sanitizeHostConfig(input: unknown): DockerHostConfig {
  const host = (input ?? {}) as Partial<DockerHostConfig>;

  return {
    host: typeof host.host === "string" ? host.host.trim() : undefined,
    context: typeof host.context === "string" ? host.context.trim() : undefined,
    tlsVerify: host.tlsVerify === undefined ? undefined : Boolean(host.tlsVerify),
    tlsCaPath: typeof host.tlsCaPath === "string" ? host.tlsCaPath.trim() : undefined,
    tlsCertPath: typeof host.tlsCertPath === "string" ? host.tlsCertPath.trim() : undefined,
    tlsKeyPath: typeof host.tlsKeyPath === "string" ? host.tlsKeyPath.trim() : undefined,
  };
}

function sanitizeVolumeMounts(input: unknown): DockerVolumeMount[] {
  if (!Array.isArray(input)) {
    throw badRequest("volumeMounts must be an array");
  }

  return input.map((mount, index) => {
    if (!mount || typeof mount !== "object") {
      throw badRequest(`volumeMounts[${index}] must be an object`);
    }

    const normalized = mount as Partial<DockerVolumeMount>;
    const hostPath = typeof normalized.hostPath === "string" ? normalized.hostPath.trim() : "";
    const containerPath = typeof normalized.containerPath === "string" ? normalized.containerPath.trim() : "";
    const mode = normalized.mode === "ro" ? "ro" : "rw";

    if (!hostPath || !containerPath) {
      throw badRequest(`volumeMounts[${index}] requires hostPath and containerPath`);
    }

    return { hostPath, containerPath, mode };
  });
}

function sanitizeExtraClis(input: unknown): DockerExtraCli[] {
  if (!Array.isArray(input)) {
    throw badRequest("extraClis must be an array");
  }

  for (const cli of input) {
    if (typeof cli !== "string" || !VALID_EXTRA_CLIS.includes(cli as DockerExtraCli)) {
      throw badRequest("extraClis contains unsupported value");
    }
  }

  return input as DockerExtraCli[];
}

function toManagedDockerNodeInfo(managedNode: ManagedDockerNode, linkedNode?: NodeConfig) {
  return {
    ...managedNode,
    hostConfig: {
      type: managedNode.hostConfig.host || managedNode.hostConfig.context ? "remote" : "local",
      host: managedNode.hostConfig.host,
      context: managedNode.hostConfig.context,
      tlsOptions: {
        tlsVerify: managedNode.hostConfig.tlsVerify,
        tlsCaPath: managedNode.hostConfig.tlsCaPath,
        tlsCertPath: managedNode.hostConfig.tlsCertPath,
        tlsKeyPath: managedNode.hostConfig.tlsKeyPath,
      },
    },
    volumeMounts: managedNode.volumeMounts.map((mount) => ({
      hostPath: mount.hostPath,
      containerPath: mount.containerPath,
      readOnly: mount.mode === "ro" ? true : undefined,
    })),
    resourceSizing: {
      cpuLimit: managedNode.resourceSizing?.cpus !== undefined ? String(managedNode.resourceSizing.cpus) : undefined,
      memoryLimit: managedNode.resourceSizing?.memoryMB !== undefined ? `${managedNode.resourceSizing.memoryMB}MB` : undefined,
    },
    linkedNode: linkedNode ?? undefined,
  };
}

export const registerDockerNodeRoutes: ApiRouteRegistrar = (ctx) => {
  const { router, rethrowAsApiError } = ctx;

  router.get("/docker/contexts", async (_req, res) => {
    try {
      const { DockerClientService } = await import("@fusion/core");
      const service = new DockerClientService();
      const contexts = await service.listContexts();
      res.json(contexts);
    } catch (error: unknown) {
      if (error instanceof ApiError) throw error;
      rethrowAsApiError(error);
    }
  });

  router.post("/docker/test-connection", async (req, res) => {
    try {
      const hostConfig = ((req.body ?? {}) as { hostConfig?: DockerHostConfig }).hostConfig;
      if (hostConfig?.host && !/^(tcp|unix|npipe):\/\//.test(hostConfig.host)) {
        throw badRequest("hostConfig.host must start with tcp://, unix://, or npipe://");
      }
      if (hostConfig?.context !== undefined && typeof hostConfig.context === "string" && hostConfig.context.trim() === "") {
        throw badRequest("hostConfig.context must be a non-empty string");
      }

      const { DockerClientService } = await import("@fusion/core");
      const service = new DockerClientService();
      const result = await service.testConnection(hostConfig);
      res.json(result);
    } catch (error: unknown) {
      if (error instanceof ApiError) throw error;
      rethrowAsApiError(error);
    }
  });

  router.get("/docker/local-available", async (_req, res) => {
    try {
      const { DockerClientService } = await import("@fusion/core");
      const service = new DockerClientService();
      const result = await service.testConnection();
      res.json({ available: result.success, version: result.dockerVersion, error: result.error });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.json({ available: false, error: message });
    }
  });

  router.get("/docker/nodes", async (_req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();
      try {
        const nodes = await central.listManagedDockerNodes();
        const enriched = await Promise.all(nodes.map(async (managedNode) => {
          const linkedNode = managedNode.nodeId ? await central.getNode(managedNode.nodeId) : undefined;
          return toManagedDockerNodeInfo(managedNode, linkedNode);
        }));
        enriched.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
        res.json(enriched);
      } finally {
        await central.close();
      }
    } catch (error: unknown) {
      if (error instanceof ApiError) {
        throw error;
      }
      rethrowAsApiError(error);
    }
  });

  router.get("/docker/nodes/:managedId/container-status", async (req, res) => {
    try {
      const { CentralCore, DockerClientService } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();
      try {
        const managedNode = await central.getManagedDockerNode(req.params.managedId);
        if (!managedNode) {
          throw notFound("Managed Docker node not found");
        }
        if (!managedNode.containerId) {
          throw badRequest(`Node has no container yet (status: ${managedNode.status})`);
        }
        try {
          const dockerService = new DockerClientService(managedNode.hostConfig);
          const info = await dockerService.getContainerInfo(managedNode.containerId, managedNode.hostConfig);
          if (!info) {
            throw notFound("Container not found");
          }
          res.json({
            running: info.state.running,
            status: info.status,
            startedAt: info.state.startedAt,
            finishedAt: info.state.finishedAt,
            exitCode: info.state.exitCode,
            error: info.state.error,
            ports: info.ports,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          res.status(503).json({ error: `Docker unreachable: ${message}` });
        }
      } finally {
        await central.close();
      }
    } catch (error: unknown) {
      if (error instanceof ApiError) {
        throw error;
      }
      rethrowAsApiError(error);
    }
  });

  router.get("/docker/nodes/:managedId/logs", async (req, res) => {
    try {
      const { CentralCore, DockerClientService } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();
      try {
        const managedNode = await central.getManagedDockerNode(req.params.managedId);
        if (!managedNode) {
          throw notFound("Managed Docker node not found");
        }
        if (!managedNode.containerId) {
          throw badRequest(`Node has no container yet (status: ${managedNode.status})`);
        }

        const tailValue = Number(req.query.tail ?? 100);
        const tail = Number.isFinite(tailValue) ? Math.max(1, Math.min(1000, Math.floor(tailValue))) : 100;

        try {
          const dockerService = new DockerClientService(managedNode.hostConfig);
          const logs = await dockerService.getContainerLogs(managedNode.containerId, managedNode.hostConfig, { tail });
          res.json({ logs });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          res.status(503).json({ error: `Docker unreachable: ${message}` });
        }
      } finally {
        await central.close();
      }
    } catch (error: unknown) {
      if (error instanceof ApiError) {
        throw error;
      }
      rethrowAsApiError(error);
    }
  });

  router.get("/docker/nodes/:managedId", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();
      try {
        const node = await central.getManagedDockerNode(req.params.managedId);
        if (!node) {
          throw notFound("Managed Docker node not found");
        }
        const linkedNode = node.nodeId ? await central.getNode(node.nodeId) : undefined;
        res.json(toManagedDockerNodeInfo(node, linkedNode));
      } finally {
        await central.close();
      }
    } catch (error: unknown) {
      if (error instanceof ApiError) {
        throw error;
      }
      rethrowAsApiError(error);
    }
  });

  router.get("/docker-nodes", async (_req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();
      const nodes = await central.listManagedDockerNodes();
      await central.close();
      nodes.sort((a, b) => a.name.localeCompare(b.name));
      res.json(nodes);
    } catch (error: unknown) {
      if (error instanceof ApiError) {
        throw error;
      }
      rethrowAsApiError(error);
    }
  });

  router.post("/docker-nodes", async (req, res) => {
    try {
      const payload = (req.body ?? {}) as Partial<ManagedDockerNodeInput>;
      const name = typeof payload.name === "string" ? payload.name.trim() : "";
      const imageName = typeof payload.imageName === "string" ? payload.imageName.trim() : "";

      if (!name || name.length > 64) {
        throw badRequest("name is required and must be 1-64 characters");
      }
      if (!imageName) {
        throw badRequest("imageName is required");
      }

      const input: ManagedDockerNodeInput = {
        nodeId: typeof payload.nodeId === "string" ? payload.nodeId.trim() : null,
        name,
        imageName,
        imageTag: typeof payload.imageTag === "string" && payload.imageTag.trim() ? payload.imageTag.trim() : "latest",
        hostConfig: sanitizeHostConfig(payload.hostConfig),
        envVars:
          payload.envVars && typeof payload.envVars === "object" && !Array.isArray(payload.envVars)
            ? Object.fromEntries(
                Object.entries(payload.envVars).map(([key, value]) => [key.trim(), String(value)]),
              )
            : {},
        volumeMounts: sanitizeVolumeMounts(payload.volumeMounts ?? []),
        resourceSizing: {
          memoryMB:
            typeof payload.resourceSizing?.memoryMB === "number" && Number.isFinite(payload.resourceSizing.memoryMB)
              ? payload.resourceSizing.memoryMB
              : 4096,
          cpus:
            typeof payload.resourceSizing?.cpus === "number" && Number.isFinite(payload.resourceSizing.cpus)
              ? payload.resourceSizing.cpus
              : 2,
        },
        extraClis: sanitizeExtraClis(payload.extraClis ?? []),
        persistentStorage: payload.persistentStorage !== undefined ? Boolean(payload.persistentStorage) : true,
        reachableUrl:
          typeof payload.reachableUrl === "string" && payload.reachableUrl.trim() ? payload.reachableUrl.trim() : null,
        apiKey: typeof payload.apiKey === "string" && payload.apiKey.trim() ? payload.apiKey.trim() : null,
      };

      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();
      const created = await central.createManagedDockerNode(input);
      await central.close();

      res.status(201).json(created);
    } catch (error: unknown) {
      if (error instanceof ApiError) {
        throw error;
      }
      rethrowAsApiError(error);
    }
  });

  router.get("/docker-nodes/:id", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();
      const node = await central.getManagedDockerNode(req.params.id);
      await central.close();

      if (!node) {
        throw notFound("Managed Docker node not found");
      }

      res.json(node);
    } catch (error: unknown) {
      if (error instanceof ApiError) {
        throw error;
      }
      rethrowAsApiError(error);
    }
  });

  // ── Mesh Configuration Routes ────────────────────────────────────────

  /**
   * POST /api/docker/nodes/:managedId/apply-mesh-config
   * Generate and apply mesh config to a provisioned Docker node.
   */
  router.post("/docker/nodes/:managedId/apply-mesh-config", async (req, res) => {
    try {
      const { managedId } = req.params;
      const body = (req.body ?? {}) as {
        orchestratorUrl?: string;
        orchestratorApiKey?: string;
        containerPort?: number;
      };

      const { CentralCore, DockerClientService, MeshConfigGenerator } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      try {
        const managedNode = await central.getManagedDockerNode(managedId);
        if (!managedNode) {
          throw notFound("Managed Docker node not found");
        }

        // Validate status — only "creating" or "stopped" can receive mesh config
        if (managedNode.status === "running") {
          throw badRequest("Node is already running with mesh config applied. Use regenerate-api-key to update credentials.");
        }
        if (managedNode.status === "error") {
          throw badRequest("Node is in error state. Resolve the error before applying mesh config.");
        }

        // Resolve orchestrator URL and API key
        let orchestratorUrl = body.orchestratorUrl?.trim();
        let orchestratorApiKey = body.orchestratorApiKey?.trim();

        // Fall back to local node lookup if not explicitly provided
        if (!orchestratorUrl || !orchestratorApiKey) {
          const nodes = await central.listNodes();
          const localNode = nodes.find((n) => n.type === "local");

          if (localNode?.apiKey) {
            orchestratorApiKey = orchestratorApiKey || localNode.apiKey;
          }

          // Construct URL from request hostname if not available
          if (!orchestratorUrl) {
            const host = req.hostname || req.get("host") || "localhost";
            // Strip port from host header if present (we'll add the actual port)
            const hostname = host.split(":")[0];
            // Use the request's port or default to the server's port
            const reqPort = req.socket?.localPort;
            orchestratorUrl = `http://${hostname}${reqPort && reqPort !== 80 ? `:${reqPort}` : ""}`;
          }
        }

        if (!orchestratorUrl || !orchestratorApiKey) {
          throw badRequest(
            "Cannot determine orchestrator URL/API key. " +
            "Either provide orchestratorUrl and orchestratorApiKey in the request body, " +
            "or configure the local node with an API key.",
          );
        }

        const dockerClient = new DockerClientService(managedNode.hostConfig);
        const generator = new MeshConfigGenerator({ central, dockerClient });

        const input: FullProvisioningInput = {
          managedNode,
          orchestratorUrl,
          orchestratorApiKey,
          containerPort: body.containerPort,
        };

        const result = await generator.provisionAndRegister(input);
        res.status(201).json(result);
      } finally {
        await central.close();
      }
    } catch (error: unknown) {
      if (error instanceof ApiError) throw error;
      rethrowAsApiError(error);
    }
  });

  /**
   * POST /api/docker/nodes/:managedId/regenerate-api-key
   * Generate a new API key for an existing managed Docker node.
   */
  router.post("/docker/nodes/:managedId/regenerate-api-key", async (req, res) => {
    try {
      const { managedId } = req.params;

      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      try {
        const managedNode = await central.getManagedDockerNode(managedId);
        if (!managedNode) {
          throw notFound("Managed Docker node not found");
        }

        const newKey = randomUUID().replace(/-/g, "");

        // Update the managed Docker node record
        await central.updateManagedDockerNode(managedId, { apiKey: newKey });

        // If linked to a NodeConfig, update that too
        if (managedNode.nodeId) {
          await central.updateNode(managedNode.nodeId, { apiKey: newKey });
        }

        res.json({ apiKey: newKey });
      } finally {
        await central.close();
      }
    } catch (error: unknown) {
      if (error instanceof ApiError) throw error;
      rethrowAsApiError(error);
    }
  });

  /**
   * GET /api/docker/nodes/:managedId/mesh-status
   * Check mesh connectivity status for a managed Docker node.
   */
  router.get("/docker/nodes/:managedId/mesh-status", async (req, res) => {
    try {
      const { managedId } = req.params;

      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      try {
        const managedNode = await central.getManagedDockerNode(managedId);
        if (!managedNode) {
          throw notFound("Managed Docker node not found");
        }

        // If not linked to a mesh node yet
        if (!managedNode.nodeId) {
          res.json({
            registered: false,
            status: "offline",
            lastCheckedAt: new Date().toISOString(),
          });
          return;
        }

        // Check health of the linked node
        const node = await central.getNode(managedNode.nodeId);
        await central.checkNodeHealth(managedNode.nodeId);
        // Re-fetch to get updated status after health check
        const updatedNode = await central.getNode(managedNode.nodeId);

        res.json({
          registered: true,
          status: updatedNode?.status ?? node?.status ?? "offline",
          reachableUrl: managedNode.reachableUrl,
          lastCheckedAt: new Date().toISOString(),
        });
      } finally {
        await central.close();
      }
    } catch (error: unknown) {
      if (error instanceof ApiError) throw error;
      rethrowAsApiError(error);
    }
  });
};
