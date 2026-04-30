import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { TaskStore } from "@fusion/core";
import { request } from "../../test-request.js";
import { createApiRoutes } from "../../routes.js";

describe("custom provider routes", () => {
  let homeDir: string;
  const refresh = vi.fn();

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(os.tmpdir(), "fn-custom-provider-"));
    vi.stubEnv("HOME", homeDir);
    vi.stubEnv("USERPROFILE", homeDir);
    refresh.mockReset();
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes({
      getRootDir: () => "/tmp/project",
      getFusionDir: () => "/tmp/project/.fusion",
      getDatabase: () => ({ exec: vi.fn(), prepare: vi.fn().mockReturnValue({ run: vi.fn(), get: vi.fn(), all: vi.fn() }) }),
      listTasks: vi.fn().mockResolvedValue([]),
      getGlobalSettingsStore: vi.fn().mockReturnValue({ getSettings: vi.fn().mockResolvedValue({}) }),
    } as unknown as TaskStore, { modelRegistry: { refresh, getAvailable: () => [] } }));
    return app;
  }

  it("supports create/read/update/delete and refreshes model registry", async () => {
    const app = buildApp();

    const createRes = await request(app, "POST", "/api/custom-providers", JSON.stringify({
      id: "my-openai-proxy",
      name: "My OpenAI Proxy",
      baseUrl: "https://proxy.example.com/v1",
      api: "openai-completions",
      apiKey: "MY_API_KEY",
      models: [{ id: "gpt-4o-mini", name: "GPT 4o Mini" }],
    }), { "Content-Type": "application/json" });

    expect(createRes.status).toBe(201);
    expect(refresh).toHaveBeenCalledTimes(1);

    const getRes = await request(app, "GET", "/api/custom-providers");
    expect(getRes.status).toBe(200);
    expect((getRes.body as { providers: Array<{ id: string }> }).providers.map((p) => p.id)).toContain("my-openai-proxy");

    const updateRes = await request(app, "PUT", "/api/custom-providers/my-openai-proxy", JSON.stringify({
      id: "ignored-id",
      baseUrl: "https://proxy2.example.com/v1",
      api: "openai-responses",
      models: [{ id: "gpt-4.1" }],
    }), { "Content-Type": "application/json" });

    expect(updateRes.status).toBe(200);
    expect((updateRes.body as { provider: { id: string; baseUrl: string; api: string } }).provider).toMatchObject({
      id: "my-openai-proxy",
      baseUrl: "https://proxy2.example.com/v1",
      api: "openai-responses",
    });

    const deleteRes = await request(app, "DELETE", "/api/custom-providers/my-openai-proxy");
    expect(deleteRes.status).toBe(204);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("validates bad id, built-in id, invalid URL, and missing fields", async () => {
    const app = buildApp();

    const badId = await request(app, "POST", "/api/custom-providers", JSON.stringify({
      id: "Bad_ID",
      baseUrl: "https://proxy.example.com/v1",
      api: "openai-completions",
      models: [{ id: "m1" }],
    }), { "Content-Type": "application/json" });
    expect(badId.status).toBe(400);

    const builtIn = await request(app, "POST", "/api/custom-providers", JSON.stringify({
      id: "openai",
      baseUrl: "https://proxy.example.com/v1",
      api: "openai-completions",
      models: [{ id: "m1" }],
    }), { "Content-Type": "application/json" });
    expect(builtIn.status).toBe(400);

    const invalidUrl = await request(app, "POST", "/api/custom-providers", JSON.stringify({
      id: "custom-openai",
      baseUrl: "ftp://proxy.example.com/v1",
      api: "openai-completions",
      models: [{ id: "m1" }],
    }), { "Content-Type": "application/json" });
    expect(invalidUrl.status).toBe(400);

    const missingModels = await request(app, "POST", "/api/custom-providers", JSON.stringify({
      id: "custom-openai",
      baseUrl: "https://proxy.example.com/v1",
      api: "openai-completions",
      models: [],
    }), { "Content-Type": "application/json" });
    expect(missingModels.status).toBe(400);
  });

  it("creates models.json automatically when missing", async () => {
    const app = buildApp();

    const res = await request(app, "GET", "/api/custom-providers");
    expect(res.status).toBe(200);

    const modelsPath = path.join(homeDir, ".fusion", "agent", "models.json");
    const content = await readFile(modelsPath, "utf8");
    expect(JSON.parse(content)).toEqual({ providers: {} });
  });
});
