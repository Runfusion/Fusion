import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const {
  getDockerInstanceMock,
  pullMock,
  followProgressMock,
  createContainerMock,
  startMock,
  stopMock,
  removeMock,
  restartMock,
  inspectMock,
  getImageInspectMock,
  getContainerMock,
  dockerCtor,
} = vi.hoisted(() => {
  const pullMock = vi.fn();
  const followProgressMock = vi.fn();
  const createContainerMock = vi.fn();
  const startMock = vi.fn();
  const stopMock = vi.fn();
  const removeMock = vi.fn();
  const restartMock = vi.fn();
  const inspectMock = vi.fn();
  const getImageInspectMock = vi.fn();
  const getContainerMock = vi.fn();
  const dockerCtor = vi.fn();

  getContainerMock.mockReturnValue({
    start: startMock,
    stop: stopMock,
    remove: removeMock,
    restart: restartMock,
    inspect: inspectMock,
  });

  return {
    getDockerInstanceMock: vi.fn(),
    pullMock,
    followProgressMock,
    createContainerMock,
    startMock,
    stopMock,
    removeMock,
    restartMock,
    inspectMock,
    getImageInspectMock,
    getContainerMock,
    dockerCtor,
  };
});

vi.mock("../docker/docker-client.js", () => ({
  DockerClientService: vi.fn().mockImplementation(function () {
    return {
      getDockerInstance: getDockerInstanceMock,
      getContainerInfo: vi.fn(),
    };
  }),
}));

import { DockerProvisioningService } from "../docker/docker-provisioning.js";
import { DockerClientService } from "../docker/docker-client.js";
import type { DockerProvisionInput } from "../types";

function createMockDocker() {
  return {
    pull: pullMock,
    modem: { followProgress: followProgressMock },
    createContainer: createContainerMock,
    getImage: vi.fn(() => ({ inspect: getImageInspectMock })),
    getContainer: getContainerMock,
  };
}

function createBaseInput(overrides?: Partial<DockerProvisionInput>): DockerProvisionInput {
  return {
    nodeName: "test-node",
    hostConfig: {},
    imageConfig: {
      image: "runfusion/fusion",
      tag: "latest",
      pullImage: true,
    },
    autoGenerateApiKey: true,
    ...overrides,
  };
}

describe("DockerProvisioningService", () => {
  let service: DockerProvisioningService;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01"));

    const mockDocker = createMockDocker();
    getDockerInstanceMock.mockResolvedValue(mockDocker);
    pullMock.mockResolvedValue("stream");
    followProgressMock.mockImplementation((_stream: unknown, cb: (err: Error | null) => void) => cb(null));
    createContainerMock.mockResolvedValue({
      id: "container-abc123",
      start: startMock,
      inspect: inspectMock,
      remove: removeMock,
    });
    startMock.mockResolvedValue(undefined);
    inspectMock.mockResolvedValue({
      Id: "container-abc123",
      NetworkSettings: { Ports: { "4040/tcp": [{ HostPort: "49152" }] } },
    });
    removeMock.mockResolvedValue(undefined);
    stopMock.mockResolvedValue(undefined);
    restartMock.mockResolvedValue(undefined);
    getImageInspectMock.mockResolvedValue({});

    const clientService = new DockerClientService();
    service = new DockerProvisioningService(clientService);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("provision", () => {
    it("provisions a container successfully", async () => {
      const result = await service.provision(createBaseInput());

      expect(result.success).toBe(true);
      expect(result.containerId).toBe("container-abc123");
      expect(result.containerName).toMatch(/^fusion-test-node-[a-f0-9]{8}$/);
      expect(result.apiKey).toMatch(/^fn_[a-f0-9]+$/);
      expect(result.portMapping).toBe("4040:49152");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);

      // Verify delegation to DockerClientService
      expect(getDockerInstanceMock).toHaveBeenCalledWith({});

      // Verify image pull
      expect(pullMock).toHaveBeenCalledWith("runfusion/fusion:latest", undefined);

      // Verify container creation
      expect(createContainerMock).toHaveBeenCalledWith(
        expect.objectContaining({
          Image: "runfusion/fusion:latest",
          ExposedPorts: { "4040/tcp": {} },
        }),
      );

      // Verify environment includes required vars
      const createCall = createContainerMock.mock.calls[0][0];
      expect(createCall.Env).toContain("FUSION_NODE_NAME=test-node");
      expect(createCall.Env).toContain("FUSION_MODE=serve");
      expect(createCall.Env).toContain("FUSION_PORT=4040");
      expect(createCall.Env).toContain("FUSION_DATA_DIR=/data");
      expect(createCall.Env.some((e: string) => e.startsWith("FUSION_API_KEY="))).toBe(true);

      // Verify labels
      expect(createCall.Labels).toEqual(
        expect.objectContaining({
          "fusion.managed": "true",
          "fusion.node-name": "test-node",
        }),
      );

      // Verify HostConfig
      expect(createCall.HostConfig.RestartPolicy).toEqual({ Name: "unless-stopped" });
      expect(createCall.HostConfig.PortBindings).toEqual({ "4040/tcp": [{ HostPort: "0" }] });
    });

    it("includes extra CLIs in environment", async () => {
      const result = await service.provision(
        createBaseInput({ extraClis: ["claude", "droid"] }),
      );

      expect(result.success).toBe(true);
      const createCall = createContainerMock.mock.calls[0][0];
      expect(createCall.Env).toContain("FUSION_EXTRA_CLIS=claude,droid");
    });

    it("applies resource limits to HostConfig", async () => {
      await service.provision(
        createBaseInput({
          resourceConfig: {
            cpuLimit: 2,
            memoryLimitMb: 4096,
            memorySwapMb: 8192,
          },
        }),
      );

      const hostConfig = createContainerMock.mock.calls[0][0].HostConfig;
      expect(hostConfig.Memory).toBe(4096 * 1024 * 1024);
      expect(hostConfig.NanoCpus).toBe(2_000_000_000);
      expect(hostConfig.MemorySwap).toBe(8192 * 1024 * 1024);
    });

    it("applies custom network config", async () => {
      await service.provision(
        createBaseInput({ network: "fusion-net" }),
      );

      const createCall = createContainerMock.mock.calls[0][0];
      expect(createCall.NetworkingConfig).toEqual({
        EndpointsConfig: { "fusion-net": {} },
      });
    });

    it("uses persistent volume mount", async () => {
      await service.provision(
        createBaseInput({ persistentVolume: "fusion-data" }),
      );

      const hostConfig = createContainerMock.mock.calls[0][0].HostConfig;
      expect(hostConfig.Binds).toContain("fusion-data:/data");
    });

    it("appends user-provided volume mounts", async () => {
      await service.provision(
        createBaseInput({
          persistentVolume: "fusion-data",
          volumeMounts: ["/host/path:/container/path"],
        }),
      );

      const hostConfig = createContainerMock.mock.calls[0][0].HostConfig;
      expect(hostConfig.Binds).toEqual(["fusion-data:/data", "/host/path:/container/path"]);
    });

    it("appends user-provided environment variables", async () => {
      await service.provision(
        createBaseInput({ environment: ["CUSTOM_VAR=value"] }),
      );

      const createCall = createContainerMock.mock.calls[0][0];
      expect(createCall.Env).toContain("CUSTOM_VAR=value");
    });

    it("uses user-provided API key when autoGenerateApiKey is false", async () => {
      const result = await service.provision(
        createBaseInput({
          autoGenerateApiKey: false,
          apiKey: "my-custom-key",
        }),
      );

      expect(result.success).toBe(true);
      expect(result.apiKey).toBe("my-custom-key");
      const createCall = createContainerMock.mock.calls[0][0];
      expect(createCall.Env).toContain("FUSION_API_KEY=my-custom-key");
    });

    it("returns error on image pull failure", async () => {
      pullMock.mockRejectedValue(new Error("registry unavailable"));

      const result = await service.provision(createBaseInput());

      expect(result.success).toBe(false);
      expect(result.failedStage).toBe("image-pull");
      expect(result.error).toContain("registry unavailable");
    });

    it("returns error when local image not found and pullImage is false", async () => {
      getImageInspectMock.mockRejectedValue(new Error("no such image"));

      const result = await service.provision(
        createBaseInput({ imageConfig: { image: "runfusion/fusion", tag: "latest", pullImage: false } }),
      );

      expect(result.success).toBe(false);
      expect(result.failedStage).toBe("image-pull");
      expect(result.error).toContain("not found locally");
    });

    it("returns error on container create failure", async () => {
      createContainerMock.mockRejectedValue(new Error("name conflict"));

      const result = await service.provision(createBaseInput());

      expect(result.success).toBe(false);
      expect(result.failedStage).toBe("container-create");
      expect(result.error).toContain("name conflict");
    });

    it("returns error on container start failure and cleans up", async () => {
      startMock.mockRejectedValue(new Error("port already in use"));

      const result = await service.provision(createBaseInput());

      expect(result.success).toBe(false);
      expect(result.failedStage).toBe("container-start");
      expect(result.error).toContain("port already in use");
      expect(removeMock).toHaveBeenCalledWith({ force: true });
    });

    it("passes registry auth when credentials are provided", async () => {
      await service.provision(
        createBaseInput({
          imageConfig: {
            image: "ghcr.io/runfusion/fusion",
            tag: "v1",
            pullImage: true,
            registryUsername: "user",
            registryPassword: "pass",
          },
        }),
      );

      expect(pullMock).toHaveBeenCalledWith(
        "ghcr.io/runfusion/fusion:v1",
        { authconfig: { username: "user", password: "pass" } },
      );
    });

    it("delegates getDockerInstance to DockerClientService", async () => {
      const hostConfig = { host: "tcp://1.2.3.4:2376" };
      await service.provision(createBaseInput({ hostConfig }));

      expect(getDockerInstanceMock).toHaveBeenCalledWith(hostConfig);
    });

    it("includes reachableUrl in environment when provided", async () => {
      await service.provision(
        createBaseInput({ reachableUrl: "http://my-node:4040" }),
      );

      const createCall = createContainerMock.mock.calls[0][0];
      expect(createCall.Env).toContain("FUSION_REACHABLE_URL=http://my-node:4040");
    });

    it("merges user-provided labels", async () => {
      await service.provision(
        createBaseInput({ labels: { env: "production" } }),
      );

      const createCall = createContainerMock.mock.calls[0][0];
      expect(createCall.Labels).toEqual({
        "fusion.managed": "true",
        "fusion.node-name": "test-node",
        env: "production",
      });
    });
  });

  describe("deprovision", () => {
    it("stops and removes container", async () => {
      const result = await service.deprovision("container-123", {}, false);

      expect(result.success).toBe(true);
      expect(getContainerMock).toHaveBeenCalledWith("container-123");
      expect(stopMock).toHaveBeenCalledWith({ t: 10 });
      expect(removeMock).toHaveBeenCalledWith({ force: true, v: false });
    });

    it("passes removeVolumes flag to remove", async () => {
      await service.deprovision("container-123", {}, true);

      expect(removeMock).toHaveBeenCalledWith({ force: true, v: true });
    });

    it("proceeds to remove when container is already stopped", async () => {
      stopMock.mockRejectedValue(new Error("is not running"));

      const result = await service.deprovision("container-123", {}, false);

      expect(result.success).toBe(true);
      expect(removeMock).toHaveBeenCalled();
    });

    it("proceeds to remove on 'already stopped' error", async () => {
      stopMock.mockRejectedValue(new Error("already stopped"));

      const result = await service.deprovision("container-123", {}, false);

      expect(result.success).toBe(true);
      expect(removeMock).toHaveBeenCalled();
    });

    it("returns error on remove failure", async () => {
      removeMock.mockRejectedValue(new Error("removal failed"));

      const result = await service.deprovision("container-123", {}, false);

      expect(result.success).toBe(false);
      expect(result.error).toContain("removal failed");
    });
  });

  describe("startContainer", () => {
    it("starts a container", async () => {
      const result = await service.startContainer("container-123", {});

      expect(result.success).toBe(true);
      expect(getContainerMock).toHaveBeenCalledWith("container-123");
      expect(startMock).toHaveBeenCalled();
    });

    it("returns error on start failure", async () => {
      startMock.mockRejectedValue(new Error("already running"));

      const result = await service.startContainer("container-123", {});

      expect(result.success).toBe(false);
      expect(result.error).toContain("already running");
    });
  });

  describe("stopContainer", () => {
    it("stops a container", async () => {
      const result = await service.stopContainer("container-123", {});

      expect(result.success).toBe(true);
      expect(stopMock).toHaveBeenCalledWith({ t: 10 });
    });

    it("returns error on stop failure", async () => {
      stopMock.mockRejectedValue(new Error("not running"));

      const result = await service.stopContainer("container-123", {});

      expect(result.success).toBe(false);
      expect(result.error).toContain("not running");
    });
  });

  describe("restartContainer", () => {
    it("restarts a container", async () => {
      const result = await service.restartContainer("container-123", {});

      expect(result.success).toBe(true);
      expect(restartMock).toHaveBeenCalled();
    });

    it("returns error on restart failure", async () => {
      restartMock.mockRejectedValue(new Error("timeout"));

      const result = await service.restartContainer("container-123", {});

      expect(result.success).toBe(false);
      expect(result.error).toContain("timeout");
    });
  });

  describe("getContainerStatus", () => {
    it("returns container status via DockerClientService", async () => {
      const mockDocker = createMockDocker();
      mockDocker.getContainer = vi.fn().mockReturnValue({
        inspect: vi.fn().mockResolvedValue({
          Id: "container-abc",
          Name: "/fusion-test",
          State: { Status: "running", Running: true, Paused: false, Restarting: false, Dead: false },
          Config: { Image: "runfusion/fusion:latest" },
          Created: "2025-01-01T00:00:00Z",
        }),
      });
      getDockerInstanceMock.mockResolvedValue(mockDocker);

      const result = await service.getContainerStatus("container-abc", {});

      expect(result).not.toBeNull();
      expect(result!.id).toBe("container-abc");
      expect(result!.name).toBe("fusion-test");
      expect(result!.status).toBe("running");
      expect(result!.state.running).toBe(true);
    });

    it("returns null for non-existent container", async () => {
      const mockDocker = createMockDocker();
      mockDocker.getContainer = vi.fn().mockReturnValue({
        inspect: vi.fn().mockRejectedValue(new Error("404 no such container")),
      });
      getDockerInstanceMock.mockResolvedValue(mockDocker);

      const result = await service.getContainerStatus("nonexistent", {});

      expect(result).toBeNull();
    });

    it("delegates to getDockerInstance with hostConfig", async () => {
      const hostConfig = { host: "tcp://1.2.3.4:2376" };
      const mockDocker = createMockDocker();
      mockDocker.getContainer = vi.fn().mockReturnValue({
        inspect: vi.fn().mockRejectedValue(new Error("404")),
      });
      getDockerInstanceMock.mockResolvedValue(mockDocker);

      await service.getContainerStatus("abc", hostConfig);

      expect(getDockerInstanceMock).toHaveBeenCalledWith(hostConfig);
    });
  });
});
