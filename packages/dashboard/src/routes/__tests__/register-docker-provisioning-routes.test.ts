// @vitest-environment node

import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApiRoutes } from "../../routes.js";
import { request } from "../../test-request.js";

const provisionMock = vi.fn();
const deprovisionMock = vi.fn();
const startContainerMock = vi.fn();
const stopContainerMock = vi.fn();
const restartContainerMock = vi.fn();
const getContainerStatusMock = vi.fn();
const registerNodeMock = vi.fn();
const createManagedDockerNodeMock = vi.fn();
const updateManagedDockerNodeMock = vi.fn();
const listManagedDockerNodesMock = vi.fn();
const deleteManagedDockerNodeMock = vi.fn();
const closeMock = vi.fn();
const initMock = vi.fn().mockResolvedValue(undefined);

const dockerClientServiceMock = {
  getDockerInstance: vi.fn(),
  getContainerInfo: vi.fn(),
};

vi.mock("@fusion/core", () => ({
  DockerProvisioningService: vi.fn().mockImplementation(() => ({
    provision: provisionMock,
    deprovision: deprovisionMock,
    startContainer: startContainerMock,
    stopContainer: stopContainerMock,
    restartContainer: restartContainerMock,
    getContainerStatus: getContainerStatusMock,
  })),
  DockerClientService: vi.fn().mockImplementation(() => dockerClientServiceMock),
  CentralCore: vi.fn().mockImplementation(() => ({
    init: initMock,
    close: closeMock,
    registerNode: registerNodeMock,
    createManagedDockerNode: createManagedDockerNodeMock,
    updateManagedDockerNode: updateManagedDockerNodeMock,
    listManagedDockerNodes: listManagedDockerNodesMock,
    deleteManagedDockerNode: deleteManagedDockerNodeMock,
  })),
  deterministicGuardLocks: new Map(),
}));

function createStore() {
  return {
    getTask: vi.fn(),
    listTasks: vi.fn().mockResolvedValue([]),
    getSettings: vi.fn().mockResolvedValue({}),
    getSettingsFast: vi.fn().mockResolvedValue({}),
    getSettingsByScope: vi.fn().mockResolvedValue({ global: {}, project: {} }),
    getSettingsByScopeFast: vi.fn().mockResolvedValue({ global: {}, project: {} }),
    getGlobalSettingsStore: vi.fn(() => ({ getSettings: vi.fn().mockResolvedValue({}) })),
    getRootDir: vi.fn().mockReturnValue("/tmp"),
    getFusionDir: vi.fn().mockReturnValue("/tmp/.fusion"),
    listWorkflowSteps: vi.fn().mockResolvedValue([]),
    getMissionStore: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  } as any;
}

function app() {
  const server = express();
  server.use(express.json());
  server.use("/api", createApiRoutes(createStore()));
  return server;
}

const VALID_PROVISION_BODY = {
  nodeName: "test-node",
  hostConfig: {},
  imageConfig: { image: "runfusion/fusion", tag: "latest", pullImage: true },
  autoGenerateApiKey: true,
};

describe("registerDockerProvisioningRoutes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    initMock.mockResolvedValue(undefined);
    closeMock.mockResolvedValue(undefined);
  });

  describe("POST /api/docker/provision", () => {
    it("returns success result on valid input", async () => {
      provisionMock.mockResolvedValue({
        success: true,
        containerId: "abc123",
        containerName: "fusion-test-node-abc12345",
        apiKey: "fn_testkey",
        portMapping: "4040:49152",
        durationMs: 1000,
      });
      registerNodeMock.mockResolvedValue({ id: "node_abc123" });
      createManagedDockerNodeMock.mockResolvedValue({ id: "dn_abc" });
      updateManagedDockerNodeMock.mockResolvedValue({ id: "dn_abc" });

      const res = await request(
        app(),
        "POST",
        "/api/docker/provision",
        JSON.stringify(VALID_PROVISION_BODY),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body.success).toBe(true);
      expect(body.containerId).toBe("abc123");
      expect(body.nodeId).toBe("node_abc123");
    });

    it("returns 400 for missing nodeName", async () => {
      const res = await request(
        app(),
        "POST",
        "/api/docker/provision",
        JSON.stringify({ ...VALID_PROVISION_BODY, nodeName: "" }),
        { "Content-Type": "application/json" },
      );
      expect(res.status).toBe(400);
    });

    it("returns 400 for missing hostConfig", async () => {
      const { hostConfig: _, ...body } = VALID_PROVISION_BODY;
      const res = await request(
        app(),
        "POST",
        "/api/docker/provision",
        JSON.stringify(body),
        { "Content-Type": "application/json" },
      );
      expect(res.status).toBe(400);
    });

    it("returns 400 for missing imageConfig", async () => {
      const { imageConfig: _, ...body } = VALID_PROVISION_BODY;
      const res = await request(
        app(),
        "POST",
        "/api/docker/provision",
        JSON.stringify(body),
        { "Content-Type": "application/json" },
      );
      expect(res.status).toBe(400);
    });

    it("returns 400 for invalid image characters", async () => {
      const res = await request(
        app(),
        "POST",
        "/api/docker/provision",
        JSON.stringify({ ...VALID_PROVISION_BODY, imageConfig: { image: "bad image$", tag: "latest", pullImage: true } }),
        { "Content-Type": "application/json" },
      );
      expect(res.status).toBe(400);
    });

    it("returns 400 for invalid tag characters", async () => {
      const res = await request(
        app(),
        "POST",
        "/api/docker/provision",
        JSON.stringify({ ...VALID_PROVISION_BODY, imageConfig: { image: "runfusion/fusion", tag: "bad tag!", pullImage: true } }),
        { "Content-Type": "application/json" },
      );
      expect(res.status).toBe(400);
    });

    it("returns 400 when autoGenerateApiKey=false and no apiKey", async () => {
      const res = await request(
        app(),
        "POST",
        "/api/docker/provision",
        JSON.stringify({ ...VALID_PROVISION_BODY, autoGenerateApiKey: false }),
        { "Content-Type": "application/json" },
      );
      expect(res.status).toBe(400);
    });

    it("returns 400 when autoGenerateApiKey is missing", async () => {
      const { autoGenerateApiKey: _, ...body } = VALID_PROVISION_BODY;
      const res = await request(
        app(),
        "POST",
        "/api/docker/provision",
        JSON.stringify(body),
        { "Content-Type": "application/json" },
      );
      expect(res.status).toBe(400);
    });

    it("returns 400 for nodeName over 64 chars", async () => {
      const res = await request(
        app(),
        "POST",
        "/api/docker/provision",
        JSON.stringify({ ...VALID_PROVISION_BODY, nodeName: "x".repeat(65) }),
        { "Content-Type": "application/json" },
      );
      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/docker/deprovision", () => {
    it("returns success on valid deprovision", async () => {
      deprovisionMock.mockResolvedValue({ success: true });
      listManagedDockerNodesMock.mockResolvedValue([]);

      const res = await request(
        app(),
        "POST",
        "/api/docker/deprovision",
        JSON.stringify({ containerId: "abc123", hostConfig: {} }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(200);
      expect((res.body as Record<string, unknown>).success).toBe(true);
    });

    it("returns 400 for missing containerId", async () => {
      const res = await request(
        app(),
        "POST",
        "/api/docker/deprovision",
        JSON.stringify({ hostConfig: {} }),
        { "Content-Type": "application/json" },
      );
      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/docker/containers/:containerId/start", () => {
    it("returns success result", async () => {
      startContainerMock.mockResolvedValue({ success: true });

      const res = await request(
        app(),
        "POST",
        "/api/docker/containers/abc123/start",
        JSON.stringify({ hostConfig: {} }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(200);
      expect((res.body as Record<string, unknown>).success).toBe(true);
    });
  });

  describe("POST /api/docker/containers/:containerId/stop", () => {
    it("returns success result", async () => {
      stopContainerMock.mockResolvedValue({ success: true });

      const res = await request(
        app(),
        "POST",
        "/api/docker/containers/abc123/stop",
        JSON.stringify({ hostConfig: {} }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(200);
      expect((res.body as Record<string, unknown>).success).toBe(true);
    });
  });

  describe("POST /api/docker/containers/:containerId/restart", () => {
    it("returns success result", async () => {
      restartContainerMock.mockResolvedValue({ success: true });

      const res = await request(
        app(),
        "POST",
        "/api/docker/containers/abc123/restart",
        JSON.stringify({ hostConfig: {} }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(200);
      expect((res.body as Record<string, unknown>).success).toBe(true);
    });
  });

  describe("GET /api/docker/containers/:containerId/status", () => {
    it("returns container status", async () => {
      getContainerStatusMock.mockResolvedValue({
        id: "abc123",
        name: "fusion-test",
        status: "running",
        image: "runfusion/fusion:latest",
        created: 1704067200000,
        state: { running: true, paused: false, restarting: false, dead: false },
      });

      const res = await request(app(), "GET", "/api/docker/containers/abc123/status");

      expect(res.status).toBe(200);
      expect((res.body as Record<string, unknown>).id).toBe("abc123");
      expect((res.body as Record<string, unknown>).status).toBe("running");
    });

    it("returns null for missing container", async () => {
      getContainerStatusMock.mockResolvedValue(null);

      const res = await request(app(), "GET", "/api/docker/containers/abc123/status");

      expect(res.status).toBe(200);
      expect(res.body).toBeNull();
    });
  });

  describe("GET /api/docker/default-image", () => {
    it("returns default image config", async () => {
      const res = await request(app(), "GET", "/api/docker/default-image");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ image: "runfusion/fusion", tag: "latest" });
    });
  });
});
