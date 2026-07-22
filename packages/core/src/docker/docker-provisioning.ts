import { randomUUID } from "node:crypto";
import type Docker from "dockerode";
import type {
  DockerContainerInspectResult,
  DockerHostConfig,
  DockerProvisionInput,
  DockerProvisionResult,
} from "../types.js";
import { DockerClientService } from "./docker-client.js";

const log = {
  info: (...args: unknown[]) => console.log("[docker-provisioning]", ...args),
  error: (...args: unknown[]) => console.error("[docker-provisioning]", ...args),
  warn: (...args: unknown[]) => console.warn("[docker-provisioning]", ...args),
};

/**
 * Service for provisioning Docker-based Fusion nodes.
 * Creates containers from a prebuilt image, manages their lifecycle,
 * and provides start/stop/restart operations.
 */
export class DockerProvisioningService {
  constructor(private readonly dockerClientService: DockerClientService) {}

  /**
   * Provision a new Docker container for a Fusion node.
   * Pulls or validates the image, creates and starts the container,
   * and returns the result with container details.
   */
  async provision(input: DockerProvisionInput): Promise<DockerProvisionResult> {
    const startTime = Date.now();

    try {
      const docker = await this.dockerClientService.getDockerInstance(input.hostConfig);
      const { image, tag } = input.imageConfig;
      const imageRef = `${image}:${tag}`;

      // Step 1: Pull or validate image
      if (input.imageConfig.pullImage) {
        log.info(`Pulling image ${imageRef}...`);
        try {
          const authOptions =
            input.imageConfig.registryUsername || input.imageConfig.registryPassword
              ? {
                  authconfig: {
                    username: input.imageConfig.registryUsername ?? "",
                    password: input.imageConfig.registryPassword ?? "",
                  },
                }
              : undefined;
          const stream = await docker.pull(imageRef, authOptions);
          await new Promise<void>((resolve, reject) => {
            docker.modem.followProgress(stream, (err: Error | null) =>
              err ? reject(err) : resolve(),
            );
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log.error(`Image pull failed: ${message}`);
          return {
            success: false,
            error: `Failed to pull image ${imageRef}: ${message}`,
            failedStage: "image-pull",
            durationMs: Date.now() - startTime,
          };
        }
      } else {
        // Validate image exists locally
        try {
          await docker.getImage(imageRef).inspect();
        } catch {
          log.error(`Image ${imageRef} not found locally`);
          return {
            success: false,
            error: `Image ${imageRef} not found locally. Set pullImage: true to pull it.`,
            failedStage: "image-pull",
            durationMs: Date.now() - startTime,
          };
        }
      }

      // Step 2: Generate container name
      const containerName = `fusion-${input.nodeName.toLowerCase().replace(/[^a-z0-9-]/g, "-")}-${randomUUID().slice(0, 8)}`;

      // Step 3: Generate API key if needed
      const apiKey = input.autoGenerateApiKey
        ? `fn_${randomUUID().replace(/-/g, "")}`
        : input.apiKey ?? "";

      // Step 4: Build environment
      const envArray: string[] = [
        `FUSION_NODE_NAME=${input.nodeName}`,
        `FUSION_API_KEY=${apiKey}`,
        "FUSION_MODE=serve",
        "FUSION_PORT=4040",
        "FUSION_DATA_DIR=/data",
      ];

      if (input.reachableUrl) {
        envArray.push(`FUSION_REACHABLE_URL=${input.reachableUrl}`);
      }

      if (input.extraClis && input.extraClis.length > 0) {
        envArray.push(`FUSION_EXTRA_CLIS=${input.extraClis.join(",")}`);
      }

      // User-provided environment appended last (allows overrides)
      if (input.environment) {
        envArray.push(...input.environment);
      }

      // Step 5: Build volume mounts
      const mounts: string[] = [];
      if (input.persistentVolume) {
        mounts.push(`${input.persistentVolume}:/data`);
      }
      if (input.volumeMounts) {
        mounts.push(...input.volumeMounts);
      }

      // Step 6: Build container create options
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const createOptions: any = {
        name: containerName,
        Image: imageRef,
        Env: envArray,
        HostConfig: {
          PortBindings: { "4040/tcp": [{ HostPort: "0" }] },
          ...(mounts.length > 0 ? { Binds: mounts } : {}),
          ...(input.resourceConfig?.memoryLimitMb
            ? { Memory: input.resourceConfig.memoryLimitMb * 1024 * 1024 }
            : {}),
          ...(input.resourceConfig?.cpuLimit
            ? { NanoCpus: Math.round(input.resourceConfig.cpuLimit * 1e9) }
            : {}),
          ...(input.resourceConfig?.memorySwapMb !== undefined
            ? { MemorySwap: input.resourceConfig.memorySwapMb * 1024 * 1024 }
            : {}),
          RestartPolicy: { Name: "unless-stopped" },
        },
        ...(input.network
          ? { NetworkingConfig: { EndpointsConfig: { [input.network]: {} } } }
          : {}),
        Labels: {
          "fusion.managed": "true",
          "fusion.node-name": input.nodeName,
          ...(input.labels || {}),
        },
        ExposedPorts: { "4040/tcp": {} },
      };

      // Step 7: Create container
      let container: Docker.Container;
      try {
        container = await docker.createContainer(createOptions);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error(`Container creation failed: ${message}`);
        return {
          success: false,
          error: `Failed to create container: ${message}`,
          failedStage: "container-create",
          durationMs: Date.now() - startTime,
        };
      }

      // Step 8: Start container
      try {
        await container.start();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error(`Container start failed: ${message}, cleaning up...`);
        // Attempt cleanup
        try {
          await container.remove({ force: true });
        } catch {
          // Best effort cleanup
        }
        return {
          success: false,
          error: `Failed to start container: ${message}`,
          failedStage: "container-start",
          durationMs: Date.now() - startTime,
        };
      }

      // Step 9: Inspect to get port mapping
      let portMapping: string | undefined;
      try {
        const inspectResult = await container.inspect();
        const portInfo = inspectResult.NetworkSettings?.Ports?.["4040/tcp"]?.[0];
        if (portInfo?.HostPort) {
          portMapping = `4040:${portInfo.HostPort}`;
        }
      } catch {
        // Container is running, port info is nice-to-have
      }

      const durationMs = Date.now() - startTime;
      log.info(`Container ${containerName} provisioned successfully in ${durationMs}ms`);

      return {
        success: true,
        containerId: container.id,
        containerName,
        apiKey,
        portMapping,
        durationMs,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`Unexpected provisioning error: ${message}`);
      return {
        success: false,
        error: message,
        failedStage: "container-create",
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Deprovision a Docker container — stop and remove it.
   */
  async deprovision(
    containerId: string,
    hostConfig: DockerHostConfig,
    removeVolumes: boolean,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const docker = await this.dockerClientService.getDockerInstance(hostConfig);
      const container = docker.getContainer(containerId);

      // Stop with timeout — ignore "already stopped" errors
      try {
        await container.stop({ t: 10 });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("already stopped") && !message.includes("is not running")) {
          log.warn(`Container stop returned: ${message}`);
        }
      }

      await container.remove({ force: true, v: removeVolumes });
      log.info(`Container ${containerId} deprovisioned`);
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`Deprovision failed for ${containerId}: ${message}`);
      return { success: false, error: message };
    }
  }

  /**
   * Get the runtime status of a container.
   * Creates a Docker client for the given hostConfig to query container info.
   */
  async getContainerStatus(
    containerId: string,
    hostConfig: DockerHostConfig,
  ): Promise<DockerContainerInspectResult | null> {
    try {
      const docker = await this.dockerClientService.getDockerInstance(hostConfig);
      const inspect = await docker.getContainer(containerId).inspect();
      return {
        id: inspect.Id,
        name: (inspect.Name ?? "").replace(/^\//, ""),
        status: inspect.State?.Status ?? "unknown",
        image: inspect.Config?.Image ?? "",
        created: inspect.Created ? Date.parse(inspect.Created) : 0,
        state: {
          running: Boolean(inspect.State?.Running),
          paused: Boolean(inspect.State?.Paused),
          restarting: Boolean(inspect.State?.Restarting),
          dead: Boolean(inspect.State?.Dead),
          error: inspect.State?.Error || undefined,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("404") || message.toLowerCase().includes("no such container")) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Start an existing container.
   */
  async startContainer(
    containerId: string,
    hostConfig: DockerHostConfig,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const docker = await this.dockerClientService.getDockerInstance(hostConfig);
      const container = docker.getContainer(containerId);
      await container.start();
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  }

  /**
   * Stop a running container with a 10-second timeout.
   */
  async stopContainer(
    containerId: string,
    hostConfig: DockerHostConfig,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const docker = await this.dockerClientService.getDockerInstance(hostConfig);
      const container = docker.getContainer(containerId);
      await container.stop({ t: 10 });
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  }

  /**
   * Restart a container (stop then start).
   */
  async restartContainer(
    containerId: string,
    hostConfig: DockerHostConfig,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const docker = await this.dockerClientService.getDockerInstance(hostConfig);
      const container = docker.getContainer(containerId);
      await container.restart();
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  }
}
