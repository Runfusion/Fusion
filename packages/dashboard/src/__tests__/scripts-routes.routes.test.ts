// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import type { TaskStore } from "@fusion/core";
import { createApiRoutes } from "../routes.js";
import { request as performRequest, get as performGet } from "../test-request.js";

const terminalServiceMock = vi.hoisted(() => ({
  createSession: vi.fn(),
  waitForReady: vi.fn(),
  writeInput: vi.fn(),
}));

vi.mock("../terminal-service.js", () => ({
  getTerminalService: vi.fn(() => terminalServiceMock),
}));

function createMockGlobalSettingsStore() {
  return {
    getSettings: vi.fn().mockResolvedValue({}),
    updateSettings: vi.fn().mockResolvedValue({}),
    getSettingsPath: vi.fn().mockReturnValue("/fake/home/.fusion/settings.json"),
    init: vi.fn().mockResolvedValue(false),
  };
}

function createMockMissionStore() {
  return {
    createSession: vi.fn().mockResolvedValue({ id: "session-1", status: "active" }),
    getSession: vi.fn().mockResolvedValue({ id: "session-1", status: "active", answers: [] }),
    updateSession: vi.fn().mockResolvedValue(undefined),
    addAnswer: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    listSessions: vi.fn().mockResolvedValue([]),
    generatePlan: vi.fn().mockResolvedValue({ plan: "Test plan", steps: [] }),
  };
}

function createMockStore(overrides: Partial<TaskStore> = {}): TaskStore {
  return {
    getTask: vi.fn(),
    listTasks: vi.fn().mockResolvedValue([]),
    createTask: vi.fn(),
    moveTask: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    mergeTask: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({}),
    updateSettings: vi.fn(),
    mutateScript: vi.fn().mockResolvedValue([]),
    updateGlobalSettings: vi.fn(),
    getSettingsByScope: vi.fn().mockResolvedValue({ global: {}, project: {} }),
    getGlobalSettingsStore: vi.fn().mockReturnValue(createMockGlobalSettingsStore()),
    logEntry: vi.fn().mockResolvedValue(undefined),
    getAgentLogs: vi.fn().mockResolvedValue([]),
    addComment: vi.fn(),
    addTaskComment: vi.fn(),
    updateTaskComment: vi.fn(),
    deleteTaskComment: vi.fn(),
    updatePrInfo: vi.fn().mockResolvedValue(undefined),
    updateIssueInfo: vi.fn().mockResolvedValue(undefined),
    getRootDir: vi.fn().mockReturnValue("/fake/root"),
    listWorkflowSteps: vi.fn().mockResolvedValue([]),
    createWorkflowStep: vi.fn(),
    getWorkflowStep: vi.fn(),
    updateWorkflowStep: vi.fn(),
    deleteWorkflowStep: vi.fn(),
    getMissionStore: vi.fn().mockReturnValue(createMockMissionStore()),
    /*
    FNXC:PluginMcpServers 2026-07-24-02:05:
    FN-8491 (3cd023fa4) made resolveProjectContext bind a project-scoped plugin
    MCP provider on every getProjectContext call; a store exposing
    getProjectScopedPluginMcpServers is treated as runtime-owned and skips the
    binder (which would otherwise 500 on getPluginStore()).
    */
    getProjectScopedPluginMcpServers: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as TaskStore;
}

async function GET(app: express.Express, path: string): Promise<{ status: number; body: any }> {
  const res = await performGet(app, path);
  return { status: res.status, body: res.body };
}

async function REQUEST(
  app: express.Express,
  method: string,
  path: string,
  body?: Buffer | string,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  const res = await performRequest(app, method, path, body, headers);
  return { status: res.status, body: res.body };
}

describe("Scripts routes", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = createMockStore();
    vi.clearAllMocks();
    terminalServiceMock.createSession.mockResolvedValue({
      success: true,
      session: { id: "term-script" },
    });
    terminalServiceMock.waitForReady.mockResolvedValue(undefined);
    terminalServiceMock.writeInput.mockReturnValue(true);
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  it("GET /api/scripts returns all scripts from script store", async () => {
    vi.mocked(store.getSettings).mockResolvedValueOnce({
      scripts: { build: "pnpm build", test: "pnpm test" },
    } as any);

    const res = await GET(buildApp(), "/api/scripts");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ build: "pnpm build", test: "pnpm test" });
  });

  it("GET /api/scripts keeps the legacy map and exposes an enriched catalog mode", async () => {
    vi.mocked(store.getSettings)
      .mockResolvedValueOnce({ scripts: {} } as any)
      .mockResolvedValueOnce({
        scripts: { "Build production": "pnpm build", test: "pnpm test" },
        scriptMetadata: { "Build production": { description: "Production bundle" } },
      } as any);

    expect((await GET(buildApp(), "/api/scripts")).body).toEqual({});
    expect((await GET(buildApp(), "/api/scripts?catalog=1")).body).toEqual([
      { name: "Build production", command: "pnpm build", description: "Production bundle" },
      { name: "test", command: "pnpm test" },
    ]);
  });

  it("POST /api/scripts creates or renames names with spaces and metadata atomically", async () => {
    vi.mocked(store.mutateScript).mockResolvedValueOnce([
      { name: "Build production", command: "pnpm build", description: "Production bundle" },
    ]);
    const res = await REQUEST(buildApp(), "POST", "/api/scripts", JSON.stringify({
      originalName: "build", name: " Build production ", command: "pnpm build", description: "Production bundle",
    }), { "Content-Type": "application/json" });

    expect(res.status).toBe(200);
    expect(store.mutateScript).toHaveBeenCalledWith({
      originalName: "build", name: " Build production ", command: "pnpm build", description: "Production bundle",
    });
    expect(res.body).toEqual({ name: "Build production", command: "pnpm build", description: "Production bundle" });
  });

  it("POST /api/scripts returns 400 for missing name", async () => {
    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/scripts",
      JSON.stringify({ command: "echo hi" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("name is required");
  });

  it("POST /api/scripts returns 400 for missing command", async () => {
    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/scripts",
      JSON.stringify({ name: "build" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("command is required");
  });

  it("POST /api/scripts accepts Unicode and punctuation", async () => {
    vi.mocked(store.mutateScript).mockResolvedValueOnce([{ name: "Déployer 🚀!", command: "echo hi" }]);
    const res = await REQUEST(buildApp(), "POST", "/api/scripts", JSON.stringify({
      name: "Déployer 🚀!", command: "echo hi",
    }), { "Content-Type": "application/json" });
    expect(res.status).toBe(200);
    expect(store.mutateScript).toHaveBeenCalledWith({ name: "Déployer 🚀!", command: "echo hi", originalName: undefined, description: undefined });
  });

  it("DELETE /api/scripts/:name removes an encoded spaced name and its metadata", async () => {
    vi.mocked(store.mutateScript).mockResolvedValueOnce([{ name: "test", command: "pnpm test" }]);
    const res = await REQUEST(buildApp(), "DELETE", "/api/scripts/Build%20production");
    expect(res.status).toBe(200);
    expect(store.mutateScript).toHaveBeenCalledWith({
      originalName: "Build production", name: "Build production", delete: true,
    });
    expect(res.body).toEqual({ test: "pnpm test" });
  });

  it("POST /api/scripts returns a typed conflict without a fallback write", async () => {
    vi.mocked(store.mutateScript).mockRejectedValueOnce(Object.assign(new Error("Script 'test' already exists"), { code: "SCRIPT_NAME_CONFLICT" }));
    const res = await REQUEST(buildApp(), "POST", "/api/scripts", JSON.stringify({
      originalName: "build", name: "test", command: "pnpm build",
    }), { "Content-Type": "application/json" });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "Script 'test' already exists", details: { code: "SCRIPT_NAME_CONFLICT" } });
    expect(store.updateSettings).not.toHaveBeenCalled();
  });

  it.each([
    [{ name: 42, command: "echo hi" }, "name is required"],
    [{ name: "build", command: 42 }, "command is required"],
    [{ name: "build", command: "echo hi", originalName: 42 }, "originalName must be a string"],
    [{ name: "build", command: "echo hi", description: 42 }, "description must be a string"],
  ])("POST /api/scripts validates field types", async (payload, expected) => {
    const res = await REQUEST(buildApp(), "POST", "/api/scripts", JSON.stringify(payload), { "Content-Type": "application/json" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain(expected);
    expect(store.mutateScript).not.toHaveBeenCalled();
  });

  it("POST /api/scripts/:name/run accepts an encoded spaced name and waits for terminal readiness", async () => {
    vi.mocked(store.getSettings).mockResolvedValueOnce({ scripts: { "Build production": "pnpm build" } } as any);
    let resolveReady!: () => void;
    terminalServiceMock.waitForReady.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveReady = resolve;
      }),
    );

    const responsePromise = REQUEST(
      buildApp(),
      "POST",
      "/api/scripts/Build%20production/run",
      JSON.stringify({ args: ["--filter", "@fusion/dashboard"] }),
      { "Content-Type": "application/json" },
    );

    await vi.waitFor(() => {
      expect(terminalServiceMock.waitForReady).toHaveBeenCalledWith("term-script");
    });
    expect(terminalServiceMock.writeInput).not.toHaveBeenCalled();

    resolveReady();
    const res = await responsePromise;

    expect(res.status).toBe(201);
    expect(terminalServiceMock.createSession).toHaveBeenCalledWith({ cwd: "/fake/root" });
    expect(terminalServiceMock.writeInput).toHaveBeenCalledTimes(1);
    expect(terminalServiceMock.writeInput).toHaveBeenCalledWith(
      "term-script",
      'pnpm build "--filter" "@fusion/dashboard"\n',
    );
    expect(res.body).toEqual({
      sessionId: "term-script",
      command: 'pnpm build "--filter" "@fusion/dashboard"',
    });
  });
});
