// @vitest-environment node

import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApiRoutes } from "../../routes.js";
import { request } from "../../test-request.js";

const secretsStore = {
  listSecrets: vi.fn(),
  createSecret: vi.fn(),
  updateSecret: vi.fn(),
  deleteSecret: vi.fn(),
  revealSecret: vi.fn(),
};

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return {
    ...actual,
    isSecretScope: actual.isSecretScope,
    isSecretAccessPolicy: actual.isSecretAccessPolicy,
  };
});

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
    getSecretsStore: vi.fn().mockResolvedValue(secretsStore),
    /*
    FNXC:PluginMcpServers 2026-07-24-01:25:
    FN-8491 (3cd023fa4) binds a project-scoped plugin-MCP provider on every getProjectContext.
    Exposing getProjectScopedPluginMcpServers marks this mock as runtime-owned so the binder
    short-circuits instead of calling getPluginStore().
    */
    getProjectScopedPluginMcpServers: vi.fn().mockResolvedValue([]),
  } as any;
}

function app() {
  const server = express();
  server.use(express.json());
  server.use("/api", createApiRoutes(createStore()));
  return server;
}

describe("register-secrets-routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    secretsStore.createSecret.mockResolvedValue({ id: "sec_1" });
    secretsStore.updateSecret.mockResolvedValue({ id: "sec_1" });
  });

  it("POST /api/secrets rejects non-string key", async () => {
    const res = await request(app(), "POST", "/api/secrets", JSON.stringify({ scope: "project", key: 123, value: "v" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(String((res.body as any).error)).toContain("key must be a non-empty string");
  });

  it("POST /api/secrets rejects non-string value", async () => {
    const res = await request(app(), "POST", "/api/secrets", JSON.stringify({ scope: "project", key: "K", value: 123 }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(String((res.body as any).error)).toContain("value must be a string");
  });

  it("POST /api/secrets rejects invalid scope", async () => {
    const res = await request(app(), "POST", "/api/secrets", JSON.stringify({ scope: "local", key: "K", value: "v" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(String((res.body as any).error)).toContain("scope must be 'project' or 'global'");
  });

  it("POST /api/secrets rejects invalid accessPolicy", async () => {
    const res = await request(
      app(),
      "POST",
      "/api/secrets",
      JSON.stringify({ scope: "project", key: "K", value: "v", accessPolicy: "banana" }),
      {
        "Content-Type": "application/json",
      },
    );

    expect(res.status).toBe(400);
    expect(String((res.body as any).error)).toContain("accessPolicy must be one of: auto, prompt, deny");
  });

  it("POST /api/secrets accepts valid payload and passes narrowed values", async () => {
    const res = await request(
      app(),
      "POST",
      "/api/secrets",
      JSON.stringify({ scope: "global", key: "MY_KEY", value: "secret", accessPolicy: "deny" }),
      {
        "Content-Type": "application/json",
      },
    );

    expect(res.status).toBe(201);
    expect(secretsStore.createSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "global",
        key: "MY_KEY",
        plaintextValue: "secret",
        accessPolicy: "deny",
      }),
    );
  });

  it("PATCH /api/secrets/:scope/:id rejects invalid accessPolicy", async () => {
    const res = await request(
      app(),
      "PATCH",
      "/api/secrets/project/sec_1",
      JSON.stringify({ accessPolicy: "banana" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect(String((res.body as any).error)).toContain("accessPolicy must be one of: auto, prompt, deny");
  });

  it("PATCH /api/secrets/:scope/:id allows null accessPolicy passthrough", async () => {
    const res = await request(
      app(),
      "PATCH",
      "/api/secrets/project/sec_1",
      JSON.stringify({ accessPolicy: null }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(secretsStore.updateSecret).toHaveBeenCalledWith("sec_1", "project", { accessPolicy: null });
  });
});
