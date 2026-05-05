import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Task } from "@fusion/core";
import { request } from "../test-request.js";
import { createServer } from "../server.js";

const mocks = vi.hoisted(() => ({
  mockInit: vi.fn().mockResolvedValue(undefined),
  mockClose: vi.fn().mockResolvedValue(undefined),
  mockGetNode: vi.fn(),
  mockUpdateNode: vi.fn(),
  mockRegisterNode: vi.fn(),
  mockValidateDockerNodeConfig: vi.fn(),
  mockSanitizeDockerNodeConfigForResponse: vi.fn((config) => config),
}));

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return {
    ...actual,
    CentralCore: vi.fn().mockImplementation(() => ({
      init: mocks.mockInit,
      close: mocks.mockClose,
      getNode: mocks.mockGetNode,
      updateNode: mocks.mockUpdateNode,
      registerNode: mocks.mockRegisterNode,
    })),
    validateDockerNodeConfig: mocks.mockValidateDockerNodeConfig,
    sanitizeDockerNodeConfigForResponse: mocks.mockSanitizeDockerNodeConfigForResponse,
  };
});

class MockStore extends EventEmitter {
  getRootDir() { return "/tmp/fn-3114"; }
  getFusionDir() { return "/tmp/fn-3114/.fusion"; }
  getDatabase() {
    return {
      exec: vi.fn(),
      prepare: vi.fn().mockReturnValue({
        run: vi.fn().mockReturnValue({ changes: 0 }),
        get: vi.fn(),
        all: vi.fn().mockReturnValue([]),
      }),
    };
  }
  getMissionStore() { return { listMissions: vi.fn().mockResolvedValue([]) }; }
  async listTasks(): Promise<Task[]> { return []; }
}

const app = createServer(new MockStore() as any);

const config = {
  image: "runfusion/fusion:latest",
  volumeMounts: [{ hostPath: "fusion-data", containerPath: "/app/.fusion", mode: "rw", type: "volume" }],
  environment: { API_KEY: "x", NORMAL: "y" },
  host: { tlsKey: "/secrets/key.pem" },
  configVersion: 1,
};

describe("docker node config routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockValidateDockerNodeConfig.mockReturnValue({ valid: true, config });
    mocks.mockSanitizeDockerNodeConfigForResponse.mockImplementation((value) => ({
      ...value,
      environment: { ...value.environment, API_KEY: "***" },
      host: value.host ? { ...value.host, tlsKey: "***" } : undefined,
    }));
  });

  it("GET /api/nodes/:id/docker-config returns 404 for missing node", async () => {
    mocks.mockGetNode.mockResolvedValue(undefined);
    const res = await request(app, "GET", "/api/nodes/node-1/docker-config");
    expect(res.status).toBe(404);
  });

  it("GET /api/nodes/:id/docker-config returns null when no config", async () => {
    mocks.mockGetNode.mockResolvedValue({ id: "node-1", dockerConfig: undefined });
    const res = await request(app, "GET", "/api/nodes/node-1/docker-config");
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });

  it("GET returns sanitized config", async () => {
    mocks.mockGetNode.mockResolvedValue({ id: "node-1", dockerConfig: config });
    const res = await request(app, "GET", "/api/nodes/node-1/docker-config");
    expect(res.status).toBe(200);
    expect((res.body as any).environment.API_KEY).toBe("***");
    expect((res.body as any).host.tlsKey).toBe("***");
  });

  it("PUT validates and returns 400 on invalid config", async () => {
    mocks.mockValidateDockerNodeConfig.mockReturnValue({ valid: false, errors: ["bad"] });
    const res = await request(app, "PUT", "/api/nodes/node-1/docker-config", JSON.stringify({ bad: true }), { "Content-Type": "application/json" });
    expect(res.status).toBe(400);
  });

  it("PUT returns 404 for missing node", async () => {
    mocks.mockGetNode.mockResolvedValue(undefined);
    const res = await request(app, "PUT", "/api/nodes/node-1/docker-config", JSON.stringify(config), { "Content-Type": "application/json" });
    expect(res.status).toBe(404);
  });

  it("PUT accepts raw config and returns sanitized", async () => {
    mocks.mockGetNode.mockResolvedValue({ id: "node-1", dockerConfig: config });
    mocks.mockUpdateNode.mockResolvedValue({ dockerConfig: { ...config, configVersion: 2 } });
    const res = await request(app, "PUT", "/api/nodes/node-1/docker-config", JSON.stringify(config), { "Content-Type": "application/json" });
    expect(res.status).toBe(200);
    expect(mocks.mockUpdateNode).toHaveBeenCalledWith("node-1", { dockerConfig: config });
    expect((res.body as any).environment.API_KEY).toBe("***");
  });

  it("PATCH merges partial updates with volume replacement and env null-removal", async () => {
    mocks.mockGetNode.mockResolvedValue({
      id: "node-1",
      dockerConfig: {
        ...config,
        environment: { KEEP: "x", DROP: "y", EMPTY: "" },
        volumeMounts: [{ hostPath: "old", containerPath: "/old", mode: "rw", type: "bind" }],
      },
    });
    mocks.mockUpdateNode.mockResolvedValue({ dockerConfig: { ...config, configVersion: 2 } });

    const patch = {
      volumeMounts: [{ hostPath: "new", containerPath: "/new", mode: "ro", type: "volume" }],
      environment: { DROP: null, ADD: "z", EMPTY: "" },
    };
    const res = await request(app, "PATCH", "/api/nodes/node-1/docker-config", JSON.stringify(patch), { "Content-Type": "application/json" });
    expect(res.status).toBe(200);
    expect(mocks.mockValidateDockerNodeConfig).toHaveBeenCalledWith(expect.objectContaining({
      volumeMounts: patch.volumeMounts,
      environment: { KEEP: "x", EMPTY: "", ADD: "z" },
    }));
  });

  it("PATCH returns 404 for missing node", async () => {
    mocks.mockGetNode.mockResolvedValue(undefined);
    const res = await request(app, "PATCH", "/api/nodes/node-1/docker-config", JSON.stringify({ image: "x" }), { "Content-Type": "application/json" });
    expect(res.status).toBe(404);
  });

  it("PATCH returns 400 when node has no existing config", async () => {
    mocks.mockGetNode.mockResolvedValue({ id: "node-1", dockerConfig: undefined });
    const res = await request(app, "PATCH", "/api/nodes/node-1/docker-config", JSON.stringify({ image: "x" }), { "Content-Type": "application/json" });
    expect(res.status).toBe(400);
  });

  it("GET /diff returns 404 for missing node", async () => {
    mocks.mockGetNode.mockResolvedValue(undefined);
    const res = await request(app, "GET", "/api/nodes/node-1/docker-config/diff");
    expect(res.status).toBe(404);
  });

  it("GET /diff returns null config for non-docker node", async () => {
    mocks.mockGetNode.mockResolvedValue({ id: "node-1", dockerConfig: undefined });
    const res = await request(app, "GET", "/api/nodes/node-1/docker-config/diff");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ config: null });
  });

  it("GET /diff returns v1 diff payload", async () => {
    mocks.mockGetNode.mockResolvedValue({ id: "node-1", dockerConfig: { ...config, configVersion: 3 } });
    const res = await request(app, "GET", "/api/nodes/node-1/docker-config/diff");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ persistedVersion: 3, deployedVersion: null, needsRecreate: false });
  });

  it("config version increments across PUT/PATCH responses", async () => {
    mocks.mockGetNode
      .mockResolvedValueOnce({ id: "node-1", dockerConfig: { ...config, configVersion: 1 } })
      .mockResolvedValueOnce({ id: "node-1", dockerConfig: { ...config, configVersion: 2 } });
    mocks.mockUpdateNode
      .mockResolvedValueOnce({ dockerConfig: { ...config, configVersion: 2 } })
      .mockResolvedValueOnce({ dockerConfig: { ...config, configVersion: 3 } });

    const putRes = await request(app, "PUT", "/api/nodes/node-1/docker-config", JSON.stringify(config), { "Content-Type": "application/json" });
    const patchRes = await request(app, "PATCH", "/api/nodes/node-1/docker-config", JSON.stringify({ image: "runfusion/fusion:stable" }), { "Content-Type": "application/json" });

    expect(putRes.status).toBe(200);
    expect(patchRes.status).toBe(200);
    expect((putRes.body as any).configVersion).toBe(2);
    expect((patchRes.body as any).configVersion).toBe(3);
  });

  it("POST/PATCH /api/nodes pass through dockerConfig", async () => {
    mocks.mockRegisterNode.mockResolvedValue({ id: "node-1" });
    mocks.mockUpdateNode.mockResolvedValue({ id: "node-1" });
    await request(app, "POST", "/api/nodes", JSON.stringify({ name: "n", type: "remote", url: "http://x", dockerConfig: config }), { "Content-Type": "application/json" });
    await request(app, "PATCH", "/api/nodes/node-1", JSON.stringify({ dockerConfig: config }), { "Content-Type": "application/json" });
    expect(mocks.mockRegisterNode).toHaveBeenCalledWith(expect.objectContaining({ dockerConfig: config }));
    expect(mocks.mockUpdateNode).toHaveBeenCalledWith("node-1", expect.objectContaining({ dockerConfig: config }));
  });
});
