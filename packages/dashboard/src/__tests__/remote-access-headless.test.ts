// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";
import { createServer } from "../server.js";
import { get as performGet, request as performRequest } from "../test-request.js";

function createMockStore(overrides: Partial<TaskStore> = {}): TaskStore {
  return {
    getTask: vi.fn(),
    listTasks: vi.fn().mockResolvedValue([]),
    createTask: vi.fn(),
    moveTask: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    mergeTask: vi.fn(),
    archiveTask: vi.fn(),
    unarchiveTask: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({}),
    updateSettings: vi.fn(),
    logEntry: vi.fn().mockResolvedValue(undefined),
    getAgentLogs: vi.fn().mockResolvedValue([]),
    addSteeringComment: vi.fn(),
    updatePrInfo: vi.fn().mockResolvedValue(undefined),
    updateIssueInfo: vi.fn().mockResolvedValue(undefined),
    getRootDir: vi.fn().mockReturnValue("/fake/root"),
    getFusionDir: vi.fn().mockReturnValue("/fake/root/.fusion"),
    getDatabase: vi.fn().mockReturnValue({
      exec: vi.fn(),
      prepare: vi.fn().mockReturnValue({ run: vi.fn().mockReturnValue({ changes: 0 }), get: vi.fn(), all: vi.fn().mockReturnValue([]) }),
    }),
    getMissionStore: vi.fn().mockReturnValue({
      listMissions: vi.fn().mockReturnValue([]),
      createMission: vi.fn(),
      getMissionWithHierarchy: vi.fn(),
      updateMission: vi.fn(),
      getMission: vi.fn(),
      deleteMission: vi.fn(),
      listMilestonesByMission: vi.fn().mockReturnValue([]),
      createMilestone: vi.fn(),
      updateMilestone: vi.fn(),
      getMilestone: vi.fn(),
      deleteMilestone: vi.fn(),
      listTasksByMilestone: vi.fn().mockReturnValue([]),
      createMissionTask: vi.fn(),
      updateMissionTask: vi.fn(),
      getMissionTask: vi.fn(),
      deleteMissionTask: vi.fn(),
    }),
    on: vi.fn(),
    off: vi.fn(),
    ...overrides,
  } as unknown as TaskStore;
}

async function GET(app: ReturnType<typeof createServer>, path: string) {
  return performGet(app, path);
}

async function REQUEST(
  app: ReturnType<typeof createServer>,
  method: string,
  path: string,
  body?: unknown,
) {
  return performRequest(
    app,
    method,
    path,
    body === undefined ? undefined : JSON.stringify(body),
    body === undefined ? {} : { "Content-Type": "application/json" },
  );
}

describe("remote access headless parity", () => {
  function buildRemoteAccessSettings() {
    return {
      activeProvider: "cloudflare" as const,
      providers: {
        tailscale: {
          enabled: false,
          hostname: "tail.example.ts.net",
          targetPort: 4040,
          acceptRoutes: false,
        },
        cloudflare: {
          enabled: true,
          tunnelName: "demo",
          tunnelToken: "cf-secret-token",
          ingressUrl: "https://demo.example.com",
        },
      },
      tokenStrategy: {
        persistent: {
          enabled: true,
          token: "frt_persistent_token",
        },
        shortLived: {
          enabled: true,
          ttlMs: 120000,
          maxTtlMs: 86400000,
        },
      },
      lifecycle: {
        rememberLastRunning: true,
        wasRunningOnShutdown: true,
        lastRunningProvider: "cloudflare" as const,
      },
    };
  }

  function buildServer(headless: boolean) {
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({
        remoteAccess: buildRemoteAccessSettings(),
      }),
    });

    const status = {
      provider: "cloudflare" as const,
      state: "running" as const,
      pid: 12345,
      startedAt: new Date().toISOString(),
      stoppedAt: null,
      url: "https://live.example.com",
      lastError: null,
    };

    const engine = {
      getTaskStore: vi.fn().mockReturnValue(store),
      getAutomationStore: vi.fn(),
      getRuntime: vi.fn().mockReturnValue({
        getMissionAutopilot: vi.fn(),
        getMissionExecutionLoop: vi.fn(),
      }),
      getHeartbeatMonitor: vi.fn(),
      getWorkingDirectory: vi.fn().mockReturnValue("/fake/root"),
      getRoutineStore: vi.fn(),
      getRoutineRunner: vi.fn(),
      onMerge: vi.fn(),
      getRemoteTunnelManager: vi.fn().mockReturnValue({
        getStatus: vi.fn().mockReturnValue(status),
      }),
      getRemoteTunnelRestoreDiagnostics: vi.fn().mockReturnValue({
        outcome: "skipped",
        reason: "runtime_prerequisite_missing",
        at: new Date().toISOString(),
        provider: "cloudflare",
      }),
      startRemoteTunnel: vi.fn().mockResolvedValue(status),
      stopRemoteTunnel: vi.fn().mockResolvedValue({
        ...status,
        provider: null,
        state: "stopped",
        pid: null,
        stoppedAt: new Date().toISOString(),
        url: null,
      }),
    };

    return {
      app: createServer(store, { headless, engine: engine as never }),
      engine,
    };
  }

  it("returns parity-compatible /api/remote/status payload between headless and non-headless", async () => {
    const dashboard = buildServer(false);
    const headless = buildServer(true);

    const [dashboardRes, headlessRes] = await Promise.all([
      GET(dashboard.app, "/api/remote/status"),
      GET(headless.app, "/api/remote/status"),
    ]);

    expect(dashboardRes.status).toBe(200);
    expect(headlessRes.status).toBe(200);

    expect(dashboardRes.body).toMatchObject({
      provider: "cloudflare",
      state: "running",
      restore: {
        outcome: "skipped",
        reason: "runtime_prerequisite_missing",
        provider: "cloudflare",
      },
    });

    expect(headlessRes.body).toMatchObject({
      provider: "cloudflare",
      state: "running",
      restore: {
        outcome: "skipped",
        reason: "runtime_prerequisite_missing",
        provider: "cloudflare",
      },
    });

    expect(JSON.stringify(dashboardRes.body)).not.toContain("cf-secret-token");
    expect(JSON.stringify(headlessRes.body)).not.toContain("cf-secret-token");
  });

  it("uses engine lifecycle controls for /api/remote/tunnel/start and /api/remote/tunnel/stop", async () => {
    const { app, engine } = buildServer(true);

    const startRes = await REQUEST(app, "POST", "/api/remote/tunnel/start", {});
    const stopRes = await REQUEST(app, "POST", "/api/remote/tunnel/stop", {});

    expect(startRes.status).toBe(200);
    expect(stopRes.status).toBe(200);
    expect(engine.startRemoteTunnel).toHaveBeenCalledTimes(1);
    expect(engine.stopRemoteTunnel).toHaveBeenCalledTimes(1);
    expect(startRes.body).toMatchObject({ state: "running", provider: "cloudflare" });
    expect(stopRes.body).toMatchObject({ state: "stopped", provider: null });
  });
});
