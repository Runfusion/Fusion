// @vitest-environment node

import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetCreateFnAgentForInsights,
  __setCreateFnAgentForInsights,
  registerSettingsMemoryRoutes,
} from "../register-settings-memory-routes.js";
import { request as performRequest } from "../../test-request.js";

const {
  resolveWorktrunkBinaryMock,
  probeWorktrunkMock,
  readMemoryMock,
  readInsightsMemoryMock,
  buildInsightExtractionPromptMock,
  processAndAuditInsightExtractionMock,
  processMemoryDreamsMock,
  processAgentMemoryDreamsMock,
  resolvePlanningSettingsModelMock,
} = vi.hoisted(() => ({
  resolveWorktrunkBinaryMock: vi.fn(),
  probeWorktrunkMock: vi.fn(),
  readMemoryMock: vi.fn(),
  readInsightsMemoryMock: vi.fn(),
  buildInsightExtractionPromptMock: vi.fn(),
  processAndAuditInsightExtractionMock: vi.fn(),
  processMemoryDreamsMock: vi.fn(),
  processAgentMemoryDreamsMock: vi.fn(),
  resolvePlanningSettingsModelMock: vi.fn(),
}));

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return {
    ...actual,
    readMemory: readMemoryMock,
    readInsightsMemory: readInsightsMemoryMock,
    buildInsightExtractionPrompt: buildInsightExtractionPromptMock,
    processAndAuditInsightExtraction: processAndAuditInsightExtractionMock,
    processMemoryDreams: processMemoryDreamsMock,
    processAgentMemoryDreams: processAgentMemoryDreamsMock,
    AgentStore: class {
      async init() {}
      async listAgents() { return []; }
    },
    resolvePlanningSettingsModel: resolvePlanningSettingsModelMock,
  };
});

vi.mock("@fusion/engine", async () => {
  const actual = await vi.importActual<typeof import("@fusion/engine")>("@fusion/engine");
  return {
    ...actual,
    resolveWorktrunkBinary: resolveWorktrunkBinaryMock,
    probeWorktrunk: probeWorktrunkMock,
  };
});

function createApp(pluginRunner?: Record<string, unknown>) {
  const router = express.Router();
  const scopedStore = {
    getSettings: vi.fn(async () => ({ worktrunk: { enabled: false }, memoryDreamsEnabled: true })),
    getRootDir: vi.fn(() => "/tmp/project"),
    getFusionDir: vi.fn(() => "/tmp/project/.fusion"),
    // FNXC:PostgresCutover 2026-07-16-06:30: all scoped-store doubles expose
    // the backend accessor even when the mocked AgentStore does not consume it.
    getAsyncLayer: vi.fn(() => undefined),
    updateSettings: vi.fn(async (patch: Record<string, unknown>) => patch),
  };

  registerSettingsMemoryRoutes(
    {
      router,
      options: { pluginRunner },
      store: {} as any,
      runtimeLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as any,
      getProjectContext: vi.fn(async () => ({
        store: scopedStore,
        // FNXC:PostgresCutover 2026-07-16-06:30: memory routes resolve the
        // project identity through the engine before constructing async agents.
        engine: {
          getProjectId: () => "p1",
          getRoutineStore: () => undefined,
        },
        projectId: "p1",
      })),
      rethrowAsApiError: (err: unknown) => {
        throw err;
      },
    },
    {
      githubToken: undefined,
      validateModelPresets: vi.fn(() => undefined),
      sanitizeOverlapIgnorePaths: vi.fn(() => undefined),
      discoverDashboardPiExtensions: vi.fn(async () => ({
        manifestPaths: [],
        disabledIds: [],
      })),
    },
  );

  const app = express();
  app.use(express.json());
  app.use("/api", router);
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err?.statusCode ?? 500).json({ error: err?.message ?? String(err) });
  });

  return { app, scopedStore };
}

async function patchSettings(app: express.Express, body: unknown) {
  const res = await performRequest(app, "PUT", "/api/settings", JSON.stringify(body), {
    "Content-Type": "application/json",
  });
  return { status: res.status, body: res.body };
}

describe("register-settings-memory-routes worktrunk gate", () => {
  beforeEach(() => {
    resolveWorktrunkBinaryMock.mockReset();
    probeWorktrunkMock.mockReset();
    readMemoryMock.mockReset();
    readInsightsMemoryMock.mockReset();
    buildInsightExtractionPromptMock.mockReset();
    processAndAuditInsightExtractionMock.mockReset();
    processMemoryDreamsMock.mockReset();
    processAgentMemoryDreamsMock.mockReset();
    resolvePlanningSettingsModelMock.mockReset();
    __resetCreateFnAgentForInsights();
  });

  it("rejects worktrunk.enabled=true when binary is unavailable", async () => {
    const { app, scopedStore } = createApp();
    resolveWorktrunkBinaryMock.mockRejectedValueOnce(new Error("missing"));

    const res = await patchSettings(app, { worktrunk: { enabled: true } });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("worktrunk integration cannot be enabled until the worktrunk binary is installed and verified");
    expect(scopedStore.updateSettings).not.toHaveBeenCalled();
  });

  it("accepts worktrunk.enabled=true when binary resolves and probes", async () => {
    const { app, scopedStore } = createApp();
    resolveWorktrunkBinaryMock.mockResolvedValueOnce({ binaryPath: "/tmp/wt" });
    probeWorktrunkMock.mockResolvedValueOnce({ ok: true, version: "1.0.0" });

    const res = await patchSettings(app, { worktrunk: { enabled: true } });

    expect(res.status).toBe(200);
    expect(scopedStore.updateSettings).toHaveBeenCalledTimes(1);
    expect(scopedStore.updateSettings).toHaveBeenCalledWith({ worktrunk: { enabled: true } });
  });

  it("accepts worktrunk.enabled=false without verification", async () => {
    const { app, scopedStore } = createApp();

    const res = await patchSettings(app, { worktrunk: { enabled: false } });

    expect(res.status).toBe(200);
    expect(resolveWorktrunkBinaryMock).not.toHaveBeenCalled();
    expect(probeWorktrunkMock).not.toHaveBeenCalled();
    expect(scopedStore.updateSettings).toHaveBeenCalledTimes(1);
  });

  it("accepts settings patch without worktrunk changes", async () => {
    const { app, scopedStore } = createApp();

    const res = await patchSettings(app, { autoMerge: true });

    expect(res.status).toBe(200);
    expect(resolveWorktrunkBinaryMock).not.toHaveBeenCalled();
    expect(probeWorktrunkMock).not.toHaveBeenCalled();
    expect(scopedStore.updateSettings).toHaveBeenCalledTimes(1);
  });

  it("passes enabled plugin skills to memory dream processing", async () => {
    const pluginRunner = {
      getPluginSkills: vi.fn(() => [
        { pluginId: "fusion-plugin-compound-engineering", skill: { name: "ce-debug" } },
        { pluginId: "disabled-plugin", skill: { name: "disabled-skill", enabled: false } },
      ]),
    };
    const { app } = createApp(pluginRunner);
    let capturedOptions: any;
    __setCreateFnAgentForInsights(async (options: any) => {
      capturedOptions = options;
      return {
        session: {
          prompt: vi.fn(async () => "dream result"),
          state: { messages: [{ role: "assistant", content: "dream result" }] },
          dispose: vi.fn(),
        },
      };
    });
    resolvePlanningSettingsModelMock.mockReturnValue({ provider: "mock", modelId: "model" });
    processMemoryDreamsMock.mockImplementation(async (_rootDir: string, executePrompt: (prompt: string) => Promise<string>) => {
      await executePrompt("dream prompt");
      return { dreams: true, longTermUpdates: false };
    });
    processAgentMemoryDreamsMock.mockResolvedValue([]);

    const res = await performRequest(app, "POST", "/api/memory/dream", "{}", {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(pluginRunner.getPluginSkills).toHaveBeenCalledTimes(1);
    expect(capturedOptions.skillSelection).toMatchObject({
      projectRootDir: "/tmp/project",
      sessionPurpose: "executor",
    });
    expect(capturedOptions.skillSelection.requestedSkillNames).toEqual(["fusion", "ce-debug"]);
  });

  it("uses executor fallback skills when memory dream processing has no plugin runner", async () => {
    const { app } = createApp();
    let capturedOptions: any;
    __setCreateFnAgentForInsights(async (options: any) => {
      capturedOptions = options;
      return {
        session: {
          prompt: vi.fn(async () => "dream result"),
          state: { messages: [{ role: "assistant", content: "dream result" }] },
          dispose: vi.fn(),
        },
      };
    });
    resolvePlanningSettingsModelMock.mockReturnValue({ provider: "mock", modelId: "model" });
    processMemoryDreamsMock.mockImplementation(async (_rootDir: string, executePrompt: (prompt: string) => Promise<string>) => {
      await executePrompt("dream prompt");
      return { dreams: false, longTermUpdates: false };
    });
    processAgentMemoryDreamsMock.mockResolvedValue([]);

    const res = await performRequest(app, "POST", "/api/memory/dream", "{}", {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(capturedOptions.skillSelection).toMatchObject({
      projectRootDir: "/tmp/project",
      sessionPurpose: "executor",
    });
    expect(capturedOptions.skillSelection.requestedSkillNames).toEqual(["fusion"]);
  });

  it("passes enabled plugin skills to manual insight extraction", async () => {
    const pluginRunner = {
      getPluginSkills: vi.fn(() => [
        { pluginId: "fusion-plugin-compound-engineering", skill: { name: "ce-debug" } },
        { pluginId: "disabled-plugin", skill: { name: "disabled-skill", enabled: false } },
      ]),
    };
    const { app } = createApp(pluginRunner);
    let capturedOptions: any;
    __setCreateFnAgentForInsights(async (options: any) => {
      capturedOptions = options;
      return {
        session: {
          prompt: vi.fn(async () => "{\"insights\":[]}"),
          dispose: vi.fn(),
        },
      };
    });
    resolvePlanningSettingsModelMock.mockReturnValue({ provider: "mock", modelId: "model" });
    readMemoryMock.mockResolvedValue({ content: "working notes" });
    readInsightsMemoryMock.mockResolvedValue(null);
    buildInsightExtractionPromptMock.mockReturnValue("extract insights");
    processAndAuditInsightExtractionMock.mockResolvedValue({
      extraction: { summary: "Extracted", insightCount: 0 },
      pruning: { applied: false },
    });

    const res = await performRequest(app, "POST", "/api/memory/extract", "{}", {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(pluginRunner.getPluginSkills).toHaveBeenCalledTimes(1);
    expect(capturedOptions.skillSelection).toMatchObject({
      projectRootDir: "/tmp/project",
      sessionPurpose: "executor",
    });
    expect(capturedOptions.skillSelection.requestedSkillNames).toEqual(["fusion", "ce-debug"]);
  });

  it("uses executor fallback skills when manual insight extraction has no plugin runner", async () => {
    const { app } = createApp();
    let capturedOptions: any;
    __setCreateFnAgentForInsights(async (options: any) => {
      capturedOptions = options;
      return {
        session: {
          prompt: vi.fn(async () => "{\"insights\":[]}"),
          dispose: vi.fn(),
        },
      };
    });
    resolvePlanningSettingsModelMock.mockReturnValue({ provider: "mock", modelId: "model" });
    readMemoryMock.mockResolvedValue({ content: "working notes" });
    readInsightsMemoryMock.mockResolvedValue(null);
    buildInsightExtractionPromptMock.mockReturnValue("extract insights");
    processAndAuditInsightExtractionMock.mockResolvedValue({
      extraction: { summary: "Extracted", insightCount: 0 },
      pruning: { applied: false },
    });

    const res = await performRequest(app, "POST", "/api/memory/extract", "{}", {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(capturedOptions.skillSelection).toMatchObject({
      projectRootDir: "/tmp/project",
      sessionPurpose: "executor",
    });
    expect(capturedOptions.skillSelection.requestedSkillNames).toEqual(["fusion"]);
  });
});
