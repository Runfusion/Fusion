import { createLogger } from "@fusion/core";

const severityAuditLog = createLogger("dashboard-register-docker-provisioning-routes");
import type { DockerHostConfig, DockerProvisionInput } from "@fusion/core";
import { ApiError, badRequest } from "../api-error.js";
import type { ApiRouteRegistrar } from "./types.js";

const IMAGE_PATTERN = /^[a-zA-Z0-9._/-]+$/;
const TAG_PATTERN = /^[a-zA-Z0-9._-]+$/;

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

function parseHostConfigQuery(raw: string | string[] | undefined): DockerHostConfig {
  if (!raw || Array.isArray(raw)) return {};
  try {
    const parsed = JSON.parse(decodeURIComponent(raw));
    return sanitizeHostConfig(parsed);
  } catch {
    return {};
  }
}

export const registerDockerProvisioningRoutes: ApiRouteRegistrar = (ctx) => {
  const { router, rethrowAsApiError } = ctx;

  // POST /api/docker/provision — Provision a new Docker node
  router.post("/docker/provision", async (req, res) => {
    try {
      const body = req.body ?? {};
      const nodeName = typeof body.nodeName === "string" ? body.nodeName.trim() : "";
      const hostConfig = body.hostConfig;
      const imageConfig = body.imageConfig;
      const autoGenerateApiKey = body.autoGenerateApiKey;

      // Validation
      if (!nodeName || nodeName.length > 64) {
        throw badRequest("nodeName is required and must be 1-64 characters");
      }
      if (!hostConfig || typeof hostConfig !== "object") {
        throw badRequest("hostConfig is required");
      }
      if (!imageConfig || typeof imageConfig !== "object") {
        throw badRequest("imageConfig is required");
      }
      if (typeof imageConfig.image !== "string" || !imageConfig.image.trim()) {
        throw badRequest("imageConfig.image is required");
      }
      if (!IMAGE_PATTERN.test(imageConfig.image)) {
        throw badRequest("imageConfig.image contains invalid characters");
      }
      if (typeof imageConfig.tag !== "string" || !imageConfig.tag.trim()) {
        throw badRequest("imageConfig.tag is required");
      }
      if (!TAG_PATTERN.test(imageConfig.tag)) {
        throw badRequest("imageConfig.tag contains invalid characters");
      }
      if (typeof autoGenerateApiKey !== "boolean") {
        throw badRequest("autoGenerateApiKey is required and must be a boolean");
      }
      if (!autoGenerateApiKey && (!body.apiKey || typeof body.apiKey !== "string" || !body.apiKey.trim())) {
        throw badRequest("apiKey is required when autoGenerateApiKey is false");
      }

      const input: DockerProvisionInput = {
        nodeName,
        hostConfig: sanitizeHostConfig(hostConfig),
        imageConfig: {
          image: imageConfig.image.trim(),
          tag: imageConfig.tag.trim(),
          pullImage: Boolean(imageConfig.pullImage),
          registryUsername: typeof imageConfig.registryUsername === "string" ? imageConfig.registryUsername : undefined,
          registryPassword: typeof imageConfig.registryPassword === "string" ? imageConfig.registryPassword : undefined,
        },
        resourceConfig: body.resourceConfig ?? undefined,
        environment: Array.isArray(body.environment) ? body.environment : undefined,
        volumeMounts: Array.isArray(body.volumeMounts) ? body.volumeMounts : undefined,
        persistentVolume: typeof body.persistentVolume === "string" ? body.persistentVolume : undefined,
        extraClis: Array.isArray(body.extraClis) ? body.extraClis : undefined,
        reachableUrl: typeof body.reachableUrl === "string" ? body.reachableUrl.trim() : undefined,
        autoGenerateApiKey,
        apiKey: typeof body.apiKey === "string" ? body.apiKey.trim() : undefined,
        maxConcurrent: typeof body.maxConcurrent === "number" ? body.maxConcurrent : undefined,
        network: typeof body.network === "string" ? body.network.trim() : undefined,
        labels: body.labels && typeof body.labels === "object" && !Array.isArray(body.labels) ? body.labels : undefined,
      };

      const { DockerProvisioningService, DockerClientService, CentralCore } = await import("@fusion/core");

      // Create Docker client with the provided host config as default
      const dockerClientService = new DockerClientService(input.hostConfig);
      const provisionService = new DockerProvisioningService(dockerClientService);

      // Run provisioning
      const result = await provisionService.provision(input);

      if (!result.success) {
        res.json(result);
        return;
      }

      // Calculate reachable URL for node registration
      let reachableUrl = input.reachableUrl;
      if (!reachableUrl && result.portMapping) {
        const hostPort = result.portMapping.split(":")[1];
        const dockerHost = input.hostConfig.host;
        if (!dockerHost || dockerHost === "unix:///var/run/docker.sock") {
          reachableUrl = `http://localhost:${hostPort}`;
        } else {
          // Extract hostname from Docker host URI
          try {
            const url = new URL(dockerHost);
            reachableUrl = `http://${url.hostname}:${hostPort}`;
          } catch {
            reachableUrl = `http://localhost:${hostPort}`;
          }
        }
      }

      // Register node in CentralCore
      let nodeId: string | undefined;
      try {
        const central = new CentralCore();
        await central.init();
        try {
          const registeredNode = await central.registerNode({
            name: input.nodeName,
            type: "remote",
            url: reachableUrl,
            apiKey: result.apiKey,
            maxConcurrent: input.maxConcurrent ?? 2,
          });
          nodeId = registeredNode.id;

          // Persist Docker metadata using runtime feature check
          if (typeof central.createManagedDockerNode === "function") {
            try {
              const dockerNode = await central.createManagedDockerNode({
                nodeId: registeredNode.id,
                name: input.nodeName,
                imageName: input.imageConfig.image,
                imageTag: input.imageConfig.tag,
                hostConfig: input.hostConfig,
                envVars: input.environment
                  ? Object.fromEntries(
                      input.environment
                        .filter((e) => e.includes("="))
                        .map((e) => {
                          const idx = e.indexOf("=");
                          return [e.slice(0, idx), e.slice(idx + 1)];
                        }),
                    )
                  : {},
                volumeMounts: [],
                resourceSizing: {
                  memoryMB: input.resourceConfig?.memoryLimitMb,
                  cpus: input.resourceConfig?.cpuLimit,
                  memorySwapMB: input.resourceConfig?.memorySwapMb,
                },
                extraClis: (input.extraClis ?? []) as Array<"claude-cli" | "droid-cli">,
                persistentStorage: !!input.persistentVolume,
                reachableUrl: reachableUrl ?? null,
                apiKey: result.apiKey ?? null,
              });

              // Update with container details after creation
              await central.updateManagedDockerNode(dockerNode.id, {
                containerId: result.containerId!,
                status: "running",
              });
            } catch (metaError) {
              // Non-fatal: node is registered but Docker metadata couldn't be persisted
              severityAuditLog.warn(
                "[docker-provisioning] Failed to persist managed Docker node metadata:",
                metaError instanceof Error ? metaError.message : String(metaError),
              );
            }
          }
        } finally {
          await central.close();
        }
      } catch (registerError) {
        // Container is running but unregistered — log warning, return result with error
        severityAuditLog.warn(
          "[docker-provisioning] Container created but node registration failed:",
          registerError instanceof Error ? registerError.message : String(registerError),
        );
        res.json({
          ...result,
          success: false,
          nodeId: undefined,
          error: `Container created but node registration failed: ${registerError instanceof Error ? registerError.message : String(registerError)}`,
          failedStage: "node-register" as const,
        });
        return;
      }

      res.json({ ...result, nodeId });
    } catch (error: unknown) {
      if (error instanceof ApiError) throw error;
      rethrowAsApiError(error);
    }
  });

  // POST /api/docker/deprovision — Stop and remove a Docker node container
  router.post("/docker/deprovision", async (req, res) => {
    try {
      const body = req.body ?? {};
      const containerId = typeof body.containerId === "string" ? body.containerId.trim() : "";

      if (!containerId) {
        throw badRequest("containerId is required");
      }

      const hostConfig = sanitizeHostConfig(body.hostConfig);
      const removeVolumes = Boolean(body.removeVolumes);

      const { DockerProvisioningService, DockerClientService, CentralCore } = await import("@fusion/core");
      const dockerClientService = new DockerClientService(hostConfig);
      const provisionService = new DockerProvisioningService(dockerClientService);

      const result = await provisionService.deprovision(containerId, hostConfig, removeVolumes);

      if (result.success) {
        // Attempt to unregister the node from CentralCore
        try {
          const central = new CentralCore();
          await central.init();
          try {
            // Use runtime feature check for managed Docker node support
            if (typeof central.listManagedDockerNodes === "function") {
              const allNodes = await central.listManagedDockerNodes();
              const match = allNodes.find((n) => n.containerId === containerId);
              if (match?.nodeId) {
                try {
                  await central.unregisterNode(match.nodeId);
                } catch {
                  // Node unregistration failed — container is removed but node registration persists
                }
              }
              // Clean up managed Docker node record
              if (match) {
                try {
                  await central.deleteManagedDockerNode(match.id);
                } catch {
                  // Best effort
                }
              }
            }
          } finally {
            await central.close();
          }
        } catch {
          // CentralCore access failed — container is removed, that's the important part
        }
      }

      res.json(result);
    } catch (error: unknown) {
      if (error instanceof ApiError) throw error;
      rethrowAsApiError(error);
    }
  });

  // POST /api/docker/containers/:containerId/start — Start a stopped container
  router.post("/docker/containers/:containerId/start", async (req, res) => {
    try {
      const containerId = req.params.containerId;
      const hostConfig = sanitizeHostConfig((req.body ?? {}).hostConfig);

      const { DockerProvisioningService, DockerClientService } = await import("@fusion/core");
      const dockerClientService = new DockerClientService(hostConfig);
      const provisionService = new DockerProvisioningService(dockerClientService);

      const result = await provisionService.startContainer(containerId, hostConfig);
      res.json(result);
    } catch (error: unknown) {
      if (error instanceof ApiError) throw error;
      rethrowAsApiError(error);
    }
  });

  // POST /api/docker/containers/:containerId/stop — Stop a running container
  router.post("/docker/containers/:containerId/stop", async (req, res) => {
    try {
      const containerId = req.params.containerId;
      const hostConfig = sanitizeHostConfig((req.body ?? {}).hostConfig);

      const { DockerProvisioningService, DockerClientService } = await import("@fusion/core");
      const dockerClientService = new DockerClientService(hostConfig);
      const provisionService = new DockerProvisioningService(dockerClientService);

      const result = await provisionService.stopContainer(containerId, hostConfig);
      res.json(result);
    } catch (error: unknown) {
      if (error instanceof ApiError) throw error;
      rethrowAsApiError(error);
    }
  });

  // POST /api/docker/containers/:containerId/restart — Restart a container
  router.post("/docker/containers/:containerId/restart", async (req, res) => {
    try {
      const containerId = req.params.containerId;
      const hostConfig = sanitizeHostConfig((req.body ?? {}).hostConfig);

      const { DockerProvisioningService, DockerClientService } = await import("@fusion/core");
      const dockerClientService = new DockerClientService(hostConfig);
      const provisionService = new DockerProvisioningService(dockerClientService);

      const result = await provisionService.restartContainer(containerId, hostConfig);
      res.json(result);
    } catch (error: unknown) {
      if (error instanceof ApiError) throw error;
      rethrowAsApiError(error);
    }
  });

  // GET /api/docker/containers/:containerId/status — Get container runtime status
  router.get("/docker/containers/:containerId/status", async (req, res) => {
    try {
      const containerId = req.params.containerId;
      const rawHostConfig = req.query.hostConfig as string | string[] | undefined;
      const hostConfig = parseHostConfigQuery(rawHostConfig);

      const { DockerProvisioningService, DockerClientService } = await import("@fusion/core");
      const dockerClientService = new DockerClientService(hostConfig);
      const provisionService = new DockerProvisioningService(dockerClientService);

      const result = await provisionService.getContainerStatus(containerId, hostConfig);
      res.json(result);
    } catch (error: unknown) {
      if (error instanceof ApiError) throw error;
      rethrowAsApiError(error);
    }
  });

  // GET /api/docker/default-image — Get the default Fusion image configuration
  router.get("/docker/default-image", (_req, res) => {
    res.json({ image: "runfusion/fusion", tag: "latest" });
  });
};
