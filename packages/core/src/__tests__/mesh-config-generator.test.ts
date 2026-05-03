import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedDockerNode, MeshConnectionConfig } from "../types.js";

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockCentral = {
  getManagedDockerNode: vi.fn(),
  updateManagedDockerNode: vi.fn(),
  registerNode: vi.fn(),
  linkManagedDockerNodeToNode: vi.fn(),
  checkNodeHealth: vi.fn(),
};

const mockDockerClient = {
  recreateContainer: vi.fn(),
};

vi.mock("../central-core.js", () => ({
  CentralCore: vi.fn(),
}));

vi.mock("../docker-client.js", () => ({
  DockerClientService: vi.fn(),
}));

// ── Helpers ────────────────────────────────────────────────────────────────

function createManagedNode(overrides: Partial<ManagedDockerNode> = {}): ManagedDockerNode {
  return {
    id: "dn_test123",
    nodeId: null,
    name: "test-node",
    imageName: "runfusion/fusion",
    imageTag: "latest",
    containerId: "container_abc",
    status: "creating",
    hostConfig: { host: undefined },
    envVars: {},
    volumeMounts: [],
    resourceSizing: { memoryMB: 4096, cpus: 2 },
    extraClis: [],
    persistentStorage: true,
    reachableUrl: null,
    apiKey: null,
    errorMessage: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// Import after mocks are set up
const { MeshConfigGenerator } = await import("../mesh-config-generator.js");

function createGenerator() {
  return new MeshConfigGenerator({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    central: mockCentral as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dockerClient: mockDockerClient as any,
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("MeshConfigGenerator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── generateConfig ─────────────────────────────────────────────────────

  describe("generateConfig", () => {
    it("uses managed node's reachableUrl when set", () => {
      const generator = createGenerator();
      const node = createManagedNode({ reachableUrl: "http://custom:5000" });

      const config = generator.generateConfig({
        managedNode: node,
        orchestratorUrl: "http://orchestrator:4040",
        orchestratorApiKey: "orch-key",
      });

      expect(config.reachableUrl).toBe("http://custom:5000");
    });

    it("auto-generates 32-char hex API key when none provided", () => {
      const generator = createGenerator();
      const node = createManagedNode();

      const config = generator.generateConfig({
        managedNode: node,
        orchestratorUrl: "http://orchestrator:4040",
        orchestratorApiKey: "orch-key",
      });

      expect(config.nodeApiKey).toMatch(/^[0-9a-f]{32}$/);
    });

    it("preserves user-provided API key", () => {
      const generator = createGenerator();
      const node = createManagedNode();

      const config = generator.generateConfig({
        managedNode: node,
        orchestratorUrl: "http://orchestrator:4040",
        orchestratorApiKey: "orch-key",
        nodeApiKey: "user-provided-key",
      });

      expect(config.nodeApiKey).toBe("user-provided-key");
    });

    it("assembles all mesh env vars with correct values", () => {
      const generator = createGenerator();
      const node = createManagedNode({ name: "my-node" });

      const config = generator.generateConfig({
        managedNode: node,
        orchestratorUrl: "http://orchestrator:4040",
        orchestratorApiKey: "orch-key",
        nodeApiKey: "test-api-key",
        containerPort: 5000,
      });

      expect(config.envVars).toMatchObject({
        FUSION_DAEMON_TOKEN: "test-api-key",
        PORT: "5000",
        FUSION_NODE_NAME: "my-node",
      });
    });

    it("merges with existing user env vars, mesh config overrides on conflict", () => {
      const generator = createGenerator();
      const node = createManagedNode({
        envVars: { PORT: "3000", CUSTOM_VAR: "custom-value" },
      });

      const config = generator.generateConfig({
        managedNode: node,
        orchestratorUrl: "http://orchestrator:4040",
        orchestratorApiKey: "orch-key",
        nodeApiKey: "test-key",
      });

      // User env var preserved
      expect(config.envVars.CUSTOM_VAR).toBe("custom-value");
      // Mesh config overrides user PORT
      expect(config.envVars.PORT).toBe("4041");
    });

    it("defaults container port to 4041", () => {
      const generator = createGenerator();
      const node = createManagedNode();

      const config = generator.generateConfig({
        managedNode: node,
        orchestratorUrl: "http://orchestrator:4040",
        orchestratorApiKey: "orch-key",
      });

      expect(config.containerPort).toBe(4041);
      expect(config.envVars.PORT).toBe("4041");
    });

    it("uses explicit containerPort override", () => {
      const generator = createGenerator();
      const node = createManagedNode();

      const config = generator.generateConfig({
        managedNode: node,
        orchestratorUrl: "http://orchestrator:4040",
        orchestratorApiKey: "orch-key",
        containerPort: 5050,
      });

      expect(config.containerPort).toBe(5050);
    });

    it("passes orchestrator URL and API key through to config", () => {
      const generator = createGenerator();
      const node = createManagedNode();

      const config = generator.generateConfig({
        managedNode: node,
        orchestratorUrl: "http://orchestrator:4040",
        orchestratorApiKey: "orch-key-123",
      });

      expect(config.orchestratorUrl).toBe("http://orchestrator:4040");
      expect(config.orchestratorApiKey).toBe("orch-key-123");
    });

    it("resolves localhost URL for local Docker daemon", () => {
      const generator = createGenerator();
      const node = createManagedNode({ hostConfig: { host: undefined } });

      const config = generator.generateConfig({
        managedNode: node,
        orchestratorUrl: "http://orchestrator:4040",
        orchestratorApiKey: "orch-key",
      });

      expect(config.reachableUrl).toBe("http://localhost:4041");
    });

    it("resolves remote host URL from hostConfig", () => {
      const generator = createGenerator();
      const node = createManagedNode({
        hostConfig: { host: "tcp://192.168.1.50:2376" },
      });

      const config = generator.generateConfig({
        managedNode: node,
        orchestratorUrl: "http://orchestrator:4040",
        orchestratorApiKey: "orch-key",
        containerPort: 5000,
      });

      expect(config.reachableUrl).toBe("http://192.168.1.50:5000");
    });
  });

  // ── applyConfig ────────────────────────────────────────────────────────

  describe("applyConfig", () => {
    const config: MeshConnectionConfig = {
      nodeApiKey: "test-key",
      reachableUrl: "http://localhost:4041",
      orchestratorUrl: "http://orchestrator:4040",
      orchestratorApiKey: "orch-key",
      containerPort: 4041,
      envVars: {
        FUSION_DAEMON_TOKEN: "test-key",
        PORT: "4041",
        FUSION_NODE_NAME: "test-node",
      },
    };

    it("sets status to recreating, recreates container, updates to running", async () => {
      const generator = createGenerator();
      const node = createManagedNode();

      mockCentral.getManagedDockerNode.mockResolvedValue(node);
      mockDockerClient.recreateContainer.mockResolvedValue("new-container-id");
      mockCentral.updateManagedDockerNode.mockResolvedValue({
        ...node,
        status: "running",
        containerId: "new-container-id",
      });

      await generator.applyConfig("dn_test123", config, { host: undefined });

      // Status set to "recreating" first
      expect(mockCentral.updateManagedDockerNode).toHaveBeenCalledWith(
        "dn_test123",
        expect.objectContaining({ status: "recreating" }),
      );

      // Container recreated with correct params
      expect(mockDockerClient.recreateContainer).toHaveBeenCalledWith(
        "container_abc",
        expect.objectContaining({
          envVars: config.envVars,
          imageName: "runfusion/fusion:latest",
          volumeMounts: [],
        }),
      );

      // Final update with running status
      expect(mockCentral.updateManagedDockerNode).toHaveBeenCalledWith(
        "dn_test123",
        expect.objectContaining({
          status: "running",
          containerId: "new-container-id",
          apiKey: "test-key",
          reachableUrl: "http://localhost:4041",
          envVars: config.envVars,
        }),
      );
    });

    it("throws descriptive error when node has no containerId", async () => {
      const generator = createGenerator();
      const node = createManagedNode({ containerId: null });

      mockCentral.getManagedDockerNode.mockResolvedValue(node);

      await expect(
        generator.applyConfig("dn_test123", config, { host: undefined }),
      ).rejects.toThrow("has no container ID");
    });

    it("sets status to error and re-throws when recreation fails", async () => {
      const generator = createGenerator();
      const node = createManagedNode();

      mockCentral.getManagedDockerNode.mockResolvedValue(node);
      mockDockerClient.recreateContainer.mockRejectedValue(new Error("Docker error"));

      await expect(
        generator.applyConfig("dn_test123", config, { host: undefined }),
      ).rejects.toThrow("Docker error");

      // Status should be set to error
      expect(mockCentral.updateManagedDockerNode).toHaveBeenCalledWith(
        "dn_test123",
        expect.objectContaining({
          status: "error",
          errorMessage: "Docker error",
        }),
      );
    });
  });

  // ── registerInMesh ────────────────────────────────────────────────────

  describe("registerInMesh", () => {
    it("registers node, links it, and returns healthy result", async () => {
      const generator = createGenerator();
      const node = createManagedNode();
      const registeredNode = { id: "node_new", name: "test-node", type: "remote" as const };

      mockCentral.getManagedDockerNode.mockResolvedValue(node);
      mockCentral.registerNode.mockResolvedValue(registeredNode);
      mockCentral.linkManagedDockerNodeToNode.mockResolvedValue(node);
      mockCentral.checkNodeHealth.mockResolvedValue("online");

      const config: MeshConnectionConfig = {
        nodeApiKey: "test-key",
        reachableUrl: "http://localhost:4041",
        orchestratorUrl: "http://orchestrator:4040",
        orchestratorApiKey: "orch-key",
        containerPort: 4041,
        envVars: {},
      };

      const result = await generator.registerInMesh("dn_test123", config);

      expect(mockCentral.registerNode).toHaveBeenCalledWith({
        name: "test-node",
        type: "remote",
        url: "http://localhost:4041",
        apiKey: "test-key",
        maxConcurrent: 2,
      });

      expect(mockCentral.linkManagedDockerNodeToNode).toHaveBeenCalledWith(
        "dn_test123",
        "node_new",
      );

      expect(result.isHealthy).toBe(true);
      expect(result.node).toBe(registeredNode);
      expect(result.config).toBe(config);
    });

    it("returns unhealthy when health check times out", async () => {
      const generator = createGenerator();
      const node = createManagedNode();
      const registeredNode = { id: "node_new", name: "test-node", type: "remote" as const };

      mockCentral.getManagedDockerNode.mockResolvedValue(node);
      mockCentral.registerNode.mockResolvedValue(registeredNode);
      mockCentral.linkManagedDockerNodeToNode.mockResolvedValue(node);
      // Always return "offline" — simulates timeout
      mockCentral.checkNodeHealth.mockResolvedValue("offline");

      const config: MeshConnectionConfig = {
        nodeApiKey: "test-key",
        reachableUrl: "http://localhost:4041",
        orchestratorUrl: "http://orchestrator:4040",
        orchestratorApiKey: "orch-key",
        containerPort: 4041,
        envVars: {},
      };

      // Use fake timers to speed up the timeout test
      vi.useFakeTimers();
      const resultPromise = generator.registerInMesh("dn_test123", config);

      // Fast-forward through the polling
      await vi.advanceTimersByTimeAsync(35_000);

      const result = await resultPromise;

      expect(result.isHealthy).toBe(false);
      expect(result.error).toContain("did not reach online status");

      vi.useRealTimers();
    });

    it("re-throws when registration fails", async () => {
      const generator = createGenerator();
      const node = createManagedNode();

      mockCentral.getManagedDockerNode.mockResolvedValue(node);
      mockCentral.registerNode.mockRejectedValue(new Error("Name collision"));

      const config: MeshConnectionConfig = {
        nodeApiKey: "test-key",
        reachableUrl: "http://localhost:4041",
        orchestratorUrl: "http://orchestrator:4040",
        orchestratorApiKey: "orch-key",
        containerPort: 4041,
        envVars: {},
      };

      await expect(
        generator.registerInMesh("dn_test123", config),
      ).rejects.toThrow("Name collision");
    });
  });

  // ── provisionAndRegister ──────────────────────────────────────────────

  describe("provisionAndRegister", () => {
    it("runs full end-to-end flow: generate → apply → register", async () => {
      const generator = createGenerator();
      const node = createManagedNode();
      const registeredNode = { id: "node_new", name: "test-node", type: "remote" as const };

      mockCentral.getManagedDockerNode.mockResolvedValue(node);
      mockDockerClient.recreateContainer.mockResolvedValue("new-container-id");
      mockCentral.updateManagedDockerNode.mockImplementation((_id: string, updates: Record<string, unknown>) =>
        Promise.resolve({ ...node, ...updates }),
      );
      mockCentral.registerNode.mockResolvedValue(registeredNode);
      mockCentral.linkManagedDockerNodeToNode.mockResolvedValue(node);
      mockCentral.checkNodeHealth.mockResolvedValue("online");

      const result = await generator.provisionAndRegister({
        managedNode: node,
        orchestratorUrl: "http://orchestrator:4040",
        orchestratorApiKey: "orch-key",
        nodeApiKey: "my-key",
        containerPort: 4041,
      });

      expect(result.isHealthy).toBe(true);
      expect(result.config.nodeApiKey).toBe("my-key");
      expect(result.config.envVars.FUSION_DAEMON_TOKEN).toBe("my-key");
      expect(result.node).toBe(registeredNode);
    });

    it("sets managed node to error when apply fails", async () => {
      const generator = createGenerator();
      const node = createManagedNode();

      mockCentral.getManagedDockerNode.mockResolvedValue(node);
      mockCentral.updateManagedDockerNode.mockImplementation((_id: string, updates: Record<string, unknown>) =>
        Promise.resolve({ ...node, ...updates }),
      );
      mockDockerClient.recreateContainer.mockRejectedValue(new Error("Recreate failed"));

      await expect(
        generator.provisionAndRegister({
          managedNode: node,
          orchestratorUrl: "http://orchestrator:4040",
          orchestratorApiKey: "orch-key",
        }),
      ).rejects.toThrow("Recreate failed");

      // Error status update should have happened
      expect(mockCentral.updateManagedDockerNode).toHaveBeenCalledWith(
        "dn_test123",
        expect.objectContaining({
          status: "error",
          errorMessage: "Recreate failed",
        }),
      );
    });

    it("sets managed node to error when register fails", async () => {
      const generator = createGenerator();
      const node = createManagedNode();

      mockCentral.getManagedDockerNode.mockResolvedValue(node);
      mockCentral.updateManagedDockerNode.mockImplementation((_id: string, updates: Record<string, unknown>) =>
        Promise.resolve({ ...node, ...updates }),
      );
      mockDockerClient.recreateContainer.mockResolvedValue("new-container-id");
      mockCentral.registerNode.mockRejectedValue(new Error("Registration failed"));

      await expect(
        generator.provisionAndRegister({
          managedNode: node,
          orchestratorUrl: "http://orchestrator:4040",
          orchestratorApiKey: "orch-key",
        }),
      ).rejects.toThrow("Registration failed");

      expect(mockCentral.updateManagedDockerNode).toHaveBeenCalledWith(
        "dn_test123",
        expect.objectContaining({
          status: "error",
          errorMessage: "Registration failed",
        }),
      );
    });
  });
});
