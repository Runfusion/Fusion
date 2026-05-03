import { randomUUID } from "node:crypto";
import type {
  DockerHostConfig,
  FullProvisioningInput,
  ManagedDockerNode,
  MeshConfigGeneratorInput,
  MeshConfigResult,
  MeshConnectionConfig,
  NodeStatus,
} from "./types.js";
import type { CentralCore } from "./central-core.js";
import type { DockerClientService } from "./docker-client.js";

/** Default container port — NOT 4040 (reserved for the production dashboard per AGENTS.md). */
const DEFAULT_CONTAINER_PORT = 4041;

/** Maximum time to wait for a new node to report healthy (ms). */
const HEALTH_CHECK_TIMEOUT_MS = 30_000;

/** Polling interval between health check attempts (ms). */
const HEALTH_CHECK_INTERVAL_MS = 3_000;

/** Brief pause after container recreation to allow startup (ms). */
const POST_RECREATE_DELAY_MS = 2_500;

/**
 * Service for generating mesh connection configuration for newly provisioned Docker nodes.
 *
 * Generates an API key, assembles connection environment variables, injects them into
 * the running container (via recreation), registers the node in the mesh, and verifies
 * connectivity. This is the glue that turns a provisioned container into a reachable mesh peer.
 */
export class MeshConfigGenerator {
  constructor(
    private readonly deps: {
      central: CentralCore;
      dockerClient: DockerClientService;
    },
  ) {}

  /**
   * Assemble the mesh connection configuration from the provided inputs.
   * Pure function — no side effects.
   */
  generateConfig(input: MeshConfigGeneratorInput): MeshConnectionConfig {
    const { managedNode, orchestratorUrl, orchestratorApiKey, nodeApiKey, containerPort } = input;

    const resolvedApiKey = nodeApiKey ?? this.generateApiKey();
    const resolvedPort = containerPort ?? DEFAULT_CONTAINER_PORT;
    const resolvedUrl = this.determineReachableUrl(managedNode, resolvedPort);

    // Build mesh env vars (these override any user-provided values with the same keys)
    const meshEnvVars: Record<string, string> = {
      FUSION_DAEMON_TOKEN: resolvedApiKey,
      PORT: String(resolvedPort),
      FUSION_NODE_NAME: managedNode.name,
    };

    // Merge with existing user env vars — mesh config keys take precedence
    const envVars: Record<string, string> = {
      ...(managedNode.envVars ?? {}),
      ...meshEnvVars,
    };

    return {
      nodeApiKey: resolvedApiKey,
      reachableUrl: resolvedUrl,
      orchestratorUrl,
      orchestratorApiKey,
      containerPort: resolvedPort,
      envVars,
    };
  }

  /**
   * Apply the mesh configuration to a provisioned Docker node by recreating
   * its container with updated environment variables.
   */
  async applyConfig(
    managedNodeId: string,
    config: MeshConnectionConfig,
    hostConfig: DockerHostConfig,
  ): Promise<void> {
    const managedNode = await this.deps.central.getManagedDockerNode(managedNodeId);
    if (!managedNode) {
      throw new Error(`Managed Docker node not found: ${managedNodeId}`);
    }

    if (!managedNode.containerId) {
      throw new Error(
        `Cannot apply config: node "${managedNode.name}" (${managedNodeId}) has no container ID. ` +
        "The node must be provisioned first.",
      );
    }

    // Set status to "recreating" before touching the container
    await this.deps.central.updateManagedDockerNode(managedNodeId, {
      status: "recreating",
    });

    try {
      const newContainerId = await this.deps.dockerClient.recreateContainer(
        managedNode.containerId,
        {
          envVars: config.envVars,
          imageName: `${managedNode.imageName}:${managedNode.imageTag}`,
          volumeMounts: managedNode.volumeMounts ?? [],
          hostConfig,
        },
      );

      // Brief pause to allow container to start
      await new Promise((resolve) => setTimeout(resolve, POST_RECREATE_DELAY_MS));

      // Update the managed node record with new state
      await this.deps.central.updateManagedDockerNode(managedNodeId, {
        apiKey: config.nodeApiKey,
        reachableUrl: config.reachableUrl,
        envVars: config.envVars,
        status: "running",
        containerId: newContainerId,
      });
    } catch (error) {
      // Update status to error and re-throw
      const message = error instanceof Error ? error.message : String(error);
      await this.deps.central.updateManagedDockerNode(managedNodeId, {
        status: "error",
        errorMessage: message,
      });
      throw error;
    }
  }

  /**
   * Register the provisioned node in the mesh and verify connectivity.
   */
  async registerInMesh(
    managedNodeId: string,
    config: MeshConnectionConfig,
  ): Promise<MeshConfigResult> {
    const managedNode = await this.deps.central.getManagedDockerNode(managedNodeId);
    if (!managedNode) {
      throw new Error(`Managed Docker node not found: ${managedNodeId}`);
    }

    // Register a new NodeConfig in the mesh
    const node = await this.deps.central.registerNode({
      name: managedNode.name,
      type: "remote",
      url: config.reachableUrl,
      apiKey: config.nodeApiKey,
      maxConcurrent: 2,
    });

    // Link the managed Docker node to the new NodeConfig
    await this.deps.central.linkManagedDockerNodeToNode(managedNodeId, node.id);

    // Wait for the node to come online (polling health check)
    const { healthy, latencyMs } = await this.waitForNodeHealth(
      node.id,
      HEALTH_CHECK_TIMEOUT_MS,
      HEALTH_CHECK_INTERVAL_MS,
    );

    const result: MeshConfigResult = {
      config,
      node,
      isHealthy: healthy,
      healthCheckLatencyMs: latencyMs,
    };

    if (!healthy) {
      result.error = `Node did not reach online status within ${HEALTH_CHECK_TIMEOUT_MS / 1000}s`;
    }

    return result;
  }

  /**
   * End-to-end convenience method: generate config → apply → register.
   * On failure at any step, sets managed node status to "error" and re-throws.
   */
  async provisionAndRegister(input: FullProvisioningInput): Promise<MeshConfigResult> {
    const managedNodeId = input.managedNode.id;

    try {
      const config = this.generateConfig(input);
      await this.applyConfig(managedNodeId, config, input.managedNode.hostConfig);
      return await this.registerInMesh(managedNodeId, config);
    } catch (error) {
      // Ensure the managed node is in error state
      const message = error instanceof Error ? error.message : String(error);
      try {
        await this.deps.central.updateManagedDockerNode(managedNodeId, {
          status: "error",
          errorMessage: message,
        });
      } catch {
        // Best-effort status update — the original error is more important
      }
      throw error;
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────────

  /** Generate a 32-character hex API key from randomUUID(). */
  private generateApiKey(): string {
    return randomUUID().replace(/-/g, "");
  }

  /** Resolve the reachable URL from the managed node configuration. */
  private determineReachableUrl(
    managedNode: ManagedDockerNode,
    containerPort: number,
  ): string {
    // Use explicit user-provided URL if set
    if (managedNode.reachableUrl) {
      return managedNode.reachableUrl;
    }

    // Determine from host config
    const host = managedNode.hostConfig?.host;
    if (!host || isLocalDaemonHost(host)) {
      return `http://localhost:${containerPort}`;
    }

    // Extract hostname from the Docker host URL (e.g., "tcp://192.168.1.50:2376" → "192.168.1.50")
    try {
      const url = new URL(host);
      return `http://${url.hostname}:${containerPort}`;
    } catch {
      // Fallback: use the raw host value
      return `http://${host}:${containerPort}`;
    }
  }

  /**
   * Poll the node health check until it reports online or times out.
   * Returns whether the node is healthy and the latency of the successful check.
   */
  private async waitForNodeHealth(
    nodeId: string,
    timeoutMs: number,
    intervalMs: number,
  ): Promise<{ healthy: boolean; latencyMs?: number }> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const checkStart = Date.now();
      try {
        const status: NodeStatus = await this.deps.central.checkNodeHealth(nodeId);
        const latencyMs = Date.now() - checkStart;

        if (status === "online") {
          return { healthy: true, latencyMs };
        }
      } catch {
        // Health check failed — node not ready yet
      }

      // Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    return { healthy: false };
  }
}

/** Check if the Docker host is a local daemon. */
function isLocalDaemonHost(host?: string): boolean {
  return !host || host.trim() === "" || host === "unix:///var/run/docker.sock";
}
