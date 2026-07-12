// @vitest-environment node

import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { request as performRequest } from "../../test-request.js";
import { registerSystemRoutes, __resetSystemJobsForTests } from "../register-system-routes.js";

type App = Parameters<typeof performRequest>[0];

 
async function getJson(app: App, path: string): Promise<{ status: number; body: any }> {
  const res = await performRequest(app, "GET", path);
  return { status: res.status, body: res.body };
}

 
async function postJson(app: App, path: string, payload: unknown = {}): Promise<{ status: number; body: any }> {
  const res = await performRequest(app, "POST", path, JSON.stringify(payload), {
    "content-type": "application/json",
  });
  return { status: res.status, body: res.body };
}

/*
FNXC:SystemPanel 2026-07-12-12:00:
Contract tests for the System panel API: capability discovery must reflect the
injected systemControl/systemLogs, every unsupported control must 409 with a
reason (never silently no-op), restart must call the host requestRestart hook,
the rebuild job must stream/buffer real build output, engine restart must
pause+resume each running project engine, and agent restart-all must bounce
only ACTIVE agents (operator-paused agents stay paused).
*/

const agentStoreState: { agents: Array<{ id: string; state: string }> } = { agents: [] };

vi.mock("@fusion/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/core")>();
  return {
    ...actual,
    AgentStore: class {
      constructor(_opts: unknown) {}
      async init(): Promise<void> {}
      async listAgents(): Promise<Array<{ id: string; state: string }>> {
        return agentStoreState.agents;
      }
    },
  };
});

function createLogger(): never {
  const logger: Record<string, unknown> = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  };
  logger.child = vi.fn(() => logger);
  return logger as never;
}

interface HarnessOptions {
  options?: Record<string, unknown>;
  deps?: Partial<Parameters<typeof registerSystemRoutes>[1]>;
  store?: Record<string, unknown>;
}

function createApp(harness: HarnessOptions = {}) {
  const router = express.Router();
  const rethrowAsApiError = vi.fn((error: unknown) => {
    throw error;
  });

  registerSystemRoutes(
    {
      router,
      store: (harness.store ?? {}) as never,
      options: harness.options as never,
      runtimeLogger: createLogger(),
      planningLogger: createLogger(),
      chatLogger: createLogger(),
      getProjectIdFromRequest: vi.fn(() => "proj-1"),
      getScopedStore: vi.fn(async () => ({}) as never),
      getProjectContext: vi.fn(async () => ({
        projectId: "proj-1",
        engine: undefined,
        store: { getFusionDir: () => "/tmp/fusion-test" } as never,
      })),
      prioritizeProjectsForCurrentDirectory: (projects) => projects,
      emitRemoteRouteDiagnostic: vi.fn(),
      emitAuthSyncAuditLog: vi.fn(),
      parseScopeParam: vi.fn(),
      resolveAutomationStore: vi.fn() as never,
      resolveRoutineStore: vi.fn() as never,
      resolveRoutineRunner: vi.fn() as never,
      registerDispose: vi.fn(),
      dispose: vi.fn(),
      rethrowAsApiError,
    },
    {
      hasHeartbeatExecutor: harness.deps?.hasHeartbeatExecutor ?? false,
      heartbeatMonitor: harness.deps?.heartbeatMonitor,
      isHeartbeatMonitorForProject: harness.deps?.isHeartbeatMonitorForProject ?? vi.fn(() => false),
      resolveHeartbeatMonitor: harness.deps?.resolveHeartbeatMonitor ?? vi.fn(() => undefined),
    },
  );

  const app = express();
  app.use(express.json());
  app.use("/api", router);
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err?.statusCode ?? 500).json({ error: err?.message ?? String(err) });
  });

  return { app };
}

const tempRoots: string[] = [];

function createFakeSourceCheckout(buildScriptBody: string): string {
  const root = mkdtempSync(join(tmpdir(), "fusion-system-routes-"));
  tempRoots.push(root);
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts", "dev-prebuild-client.mjs"), buildScriptBody);
  return root;
}

afterAll(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

beforeEach(() => {
  __resetSystemJobsForTests();
  agentStoreState.agents = [];
});

describe("GET /system/info", () => {
  it("reports no capabilities when the host wired nothing", async () => {
    const { app } = createApp();
    const res = await getJson(app, "/api/system/info");
    expect(res.status).toBe(200);
    expect(res.body.restartSupported).toBe(false);
    expect(res.body.rebuildSupported).toBe(false);
    expect(res.body.logsSupported).toBe(false);
    expect(res.body.engineAvailable).toBe(false);
    expect(res.body.pid).toBe(process.pid);
  });

  it("reflects injected systemControl and systemLogs capabilities", async () => {
    const { app } = createApp({
      options: {
        systemControl: { supervised: true, requestRestart: vi.fn(() => true), sourceWorkspaceRoot: "/checkout" },
        systemLogs: { getRecent: vi.fn(() => []), subscribe: vi.fn(() => () => {}) },
        engineManager: {},
      },
    });
    const res = await getJson(app, "/api/system/info");
    expect(res.body.restartSupported).toBe(true);
    expect(res.body.rebuildSupported).toBe(true);
    expect(res.body.sourceWorkspaceRoot).toBe("/checkout");
    expect(res.body.logsSupported).toBe(true);
    expect(res.body.engineAvailable).toBe(true);
  });
});

describe("POST /system/restart", () => {
  it("409s when the host did not wire system control", async () => {
    const { app } = createApp();
    const res = await postJson(app, "/api/system/restart");
    expect(res.status).toBe(409);
  });

  it("409s when there is no supervising parent to respawn", async () => {
    const requestRestart = vi.fn(() => false);
    const { app } = createApp({ options: { systemControl: { supervised: false, requestRestart } } });
    const res = await postJson(app, "/api/system/restart");
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/supervis/i);
  });

  it("202s and forwards the reason to the host restart hook", async () => {
    const requestRestart = vi.fn(() => true);
    const { app } = createApp({ options: { systemControl: { supervised: true, requestRestart } } });
    const res = await postJson(app, "/api/system/restart", { reason: "test-restart" });
    expect(res.status).toBe(202);
    expect(res.body.scheduled).toBe(true);
    expect(requestRestart).toHaveBeenCalledWith("test-restart");
  });
});

describe("POST /system/rebuild", () => {
  it("409s when not running from a source checkout", async () => {
    const { app } = createApp({ options: { systemControl: { supervised: true, requestRestart: vi.fn(() => true) } } });
    const res = await postJson(app, "/api/system/rebuild", { scope: "app" });
    expect(res.status).toBe(409);
  });

  it("runs the build script, buffers output, and schedules a restart on success", async () => {
    const root = createFakeSourceCheckout("console.log('build-line-1');\nconsole.log('build-line-2');\n");
    const requestRestart = vi.fn(() => true);
    const { app } = createApp({
      options: { systemControl: { supervised: true, requestRestart, sourceWorkspaceRoot: root } },
    });

    const started = await postJson(app, "/api/system/rebuild", { scope: "app", restart: true });
    expect(started.status).toBe(202);
    expect(started.body.status).toBe("running");

    await vi.waitFor(async () => {
      const current = await getJson(app, "/api/system/rebuild/current");
      expect(current.body.job.status).toBe("succeeded");
    }, { timeout: 10_000, interval: 100 });

    const current = await getJson(app, "/api/system/rebuild/current");
    const lineTexts = current.body.job.lines.map((line: { text: string }) => line.text);
    expect(lineTexts).toContain("build-line-1");
    expect(lineTexts).toContain("build-line-2");
    expect(current.body.job.restartScheduled).toBe(true);
    expect(requestRestart).toHaveBeenCalledWith("rebuild:app");
  });

  it("marks the job failed when the build exits non-zero and does not restart", async () => {
    const root = createFakeSourceCheckout("console.error('boom');\nprocess.exit(3);\n");
    const requestRestart = vi.fn(() => true);
    const { app } = createApp({
      options: { systemControl: { supervised: true, requestRestart, sourceWorkspaceRoot: root } },
    });

    const started = await postJson(app, "/api/system/rebuild", { scope: "app" });
    expect(started.status).toBe(202);

    await vi.waitFor(async () => {
      const current = await getJson(app, "/api/system/rebuild/current");
      expect(current.body.job.status).toBe("failed");
    }, { timeout: 10_000, interval: 100 });

    expect(requestRestart).not.toHaveBeenCalled();
  });

  it("rejects a second concurrent rebuild", async () => {
    const root = createFakeSourceCheckout("setTimeout(() => {}, 400);\n");
    const { app } = createApp({
      options: { systemControl: { supervised: true, requestRestart: vi.fn(() => true), sourceWorkspaceRoot: root } },
    });
    const first = await postJson(app, "/api/system/rebuild", { scope: "app" });
    expect(first.status).toBe(202);
    const second = await postJson(app, "/api/system/rebuild", { scope: "app" });
    expect(second.status).toBe(409);

    // Let the short-lived build child exit before the test ends so the
    // subprocess guard sees no leaked children.
    await vi.waitFor(async () => {
      const current = await getJson(app, "/api/system/rebuild/current");
      expect(current.body.job.status).not.toBe("running");
    }, { timeout: 10_000, interval: 100 });
  });
});

describe("GET /system/logs", () => {
  it("409s without a log provider", async () => {
    const { app } = createApp();
    const res = await getJson(app, "/api/system/logs");
    expect(res.status).toBe(409);
  });

  it("returns recent entries with the requested limit", async () => {
    const getRecent = vi.fn((limit?: number) => [
      { timestamp: new Date(), level: "info" as const, message: `limit=${limit}` },
    ]);
    const { app } = createApp({
      options: { systemLogs: { getRecent, subscribe: vi.fn(() => () => {}) } },
    });
    const res = await getJson(app, "/api/system/logs?limit=42");
    expect(res.status).toBe(200);
    expect(getRecent).toHaveBeenCalledWith(42);
    expect(res.body.entries[0].message).toBe("limit=42");
  });
});

describe("POST /system/engine/restart", () => {
  it("409s when the engine manager is unavailable", async () => {
    const { app } = createApp();
    const res = await postJson(app, "/api/system/engine/restart");
    expect(res.status).toBe(409);
  });

  it("pause+resumes each running project engine and reports failures", async () => {
    const pauseProject = vi.fn(async () => {});
    const resumeProject = vi.fn(async (id: string) => {
      if (id === "p2") throw new Error("resume failed");
    });
    const engineManager = {
      getEngine: (id: string) => (id === "p3" ? undefined : {}),
      pauseProject,
      resumeProject,
    };
    const centralCore = {
      listProjects: vi.fn(async () => [{ id: "p1" }, { id: "p2" }, { id: "p3" }]),
    };
    const { app } = createApp({ options: { engineManager, centralCore } });

    const res = await postJson(app, "/api/system/engine/restart");
    expect(res.status).toBe(200);
    expect(res.body.restarted).toEqual(["p1"]);
    expect(res.body.failed).toEqual([{ projectId: "p2", error: "resume failed" }]);
    // p3 has no running engine — must not be touched.
    expect(pauseProject).toHaveBeenCalledTimes(2);
  });
});

describe("POST /system/agents/restart-all", () => {
  it("bounces only active agents and leaves paused agents untouched", async () => {
    agentStoreState.agents = [
      { id: "agent-active", state: "active" },
      { id: "agent-paused", state: "paused" },
      { id: "agent-disabled", state: "disabled" },
    ];
    const pauseAgent = vi.fn(async () => ({}));
    const resumeAgent = vi.fn(async () => ({}));
    const monitor = { pauseAgent, resumeAgent };
    const { app } = createApp({
      deps: {
        hasHeartbeatExecutor: true,
        heartbeatMonitor: monitor as never,
        isHeartbeatMonitorForProject: vi.fn(() => true),
        resolveHeartbeatMonitor: vi.fn(() => monitor as never),
      },
    });

    const res = await postJson(app, "/api/system/agents/restart-all");
    expect(res.status).toBe(200);
    expect(res.body.restarted).toEqual(["agent-active"]);
    expect(pauseAgent).toHaveBeenCalledTimes(1);
    expect(pauseAgent).toHaveBeenCalledWith("agent-active", expect.objectContaining({ stopActiveRun: true }));
    expect(resumeAgent).toHaveBeenCalledWith("agent-active", expect.objectContaining({ clearPauseReason: true }));
  });

  it("409s when no lifecycle monitor is available", async () => {
    agentStoreState.agents = [{ id: "agent-active", state: "active" }];
    const { app } = createApp();
    const res = await postJson(app, "/api/system/agents/restart-all");
    expect(res.status).toBe(409);
  });
});

describe("POST /system/plugins/reload-all", () => {
  it("reloads only started plugins", async () => {
    const reloadPlugin = vi.fn(async () => {});
    const { app } = createApp({
      store: {
        getPluginStore: () => ({
          listPlugins: vi.fn(async () => [
            { id: "plugin-started", state: "started" },
            { id: "plugin-stopped", state: "stopped" },
          ]),
        }),
      },
      options: { pluginRunner: { reloadPlugin } },
    });
    const res = await postJson(app, "/api/system/plugins/reload-all");
    expect(res.status).toBe(200);
    expect(res.body.reloaded).toEqual(["plugin-started"]);
    expect(reloadPlugin).toHaveBeenCalledTimes(1);
  });

  it("409s when the plugin runner is unavailable", async () => {
    const { app } = createApp({
      store: { getPluginStore: () => ({ listPlugins: vi.fn(async () => []) }) },
    });
    const res = await postJson(app, "/api/system/plugins/reload-all");
    expect(res.status).toBe(409);
  });
});
