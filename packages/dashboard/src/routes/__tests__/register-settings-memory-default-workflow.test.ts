// @vitest-environment node

/**
 * FNXC:DefaultWorkflowWriteValidation 2026-10-14-23:58 (RUFU-391):
 * `PUT /api/settings` is the write surface that could persist an unresolvable `defaultWorkflowId` without
 * ever consulting the workflow catalog — `PUT /project/default-workflow` validated and this route did not,
 * so the same bad id was refused through one door and silently stored through the other. These cases pin
 * both halves of the new contract on the generic save: a refusal that never reaches `updateSettings`, and
 * the deliberate byte-identical carve-out that keeps a project already carrying a legacy default savable.
 *
 * The `@fusion/core` mock spreads `importActual`, so the verdict under test is the REAL shared predicate
 * (`validateProjectDefaultWorkflowRef`), not a stub of it.
 */

import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerSettingsMemoryRoutes } from "../register-settings-memory-routes.js";
import { request as performRequest } from "../../test-request.js";

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return {
    ...actual,
    readMemory: vi.fn(async () => ""),
    readInsightsMemory: vi.fn(async () => ""),
    buildInsightExtractionPrompt: vi.fn(() => ""),
    processAndAuditInsightExtraction: vi.fn(async () => {}),
    processMemoryDreams: vi.fn(async () => {}),
    processAgentMemoryDreams: vi.fn(async () => {}),
    resolvePlanningSettingsModel: vi.fn(() => undefined),
    AgentStore: class {
      async init() {}
      async listAgents() {
        return [];
      }
    },
  };
});

function createApp(projectSettings: Record<string, unknown> = {}) {
  const router = express.Router();
  const scopedStore = {
    getSettings: vi.fn(async () => projectSettings),
    getRootDir: vi.fn(() => "/tmp/project"),
    getFusionDir: vi.fn(() => "/tmp/project/.fusion"),
    getAsyncLayer: vi.fn(() => undefined),
    getWorkflowDefinition: vi.fn(async () => undefined),
    isPluginInstalled: vi.fn(async () => false),
    updateSettings: vi.fn(async (patch: Record<string, unknown>) => patch),
  };

  registerSettingsMemoryRoutes(
    {
      router,
      options: { pluginRunner: undefined },
      store: {} as any,
      runtimeLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as any,
      getProjectContext: vi.fn(async () => ({
        store: scopedStore,
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
      sanitizeBooleanSetting: vi.fn((_name: string, value: unknown) => value),
      sanitizeOverlapIgnorePaths: vi.fn(() => undefined),
      discoverDashboardPiExtensions: vi.fn(async () => ({ manifestPaths: [], disabledIds: [] })),
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

describe("PUT /api/settings defaultWorkflowId gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refuses an unresolvable id and never reaches the settings write", async () => {
    const { app, scopedStore } = createApp({ defaultWorkflowId: undefined });

    const res = await patchSettings(app, { defaultWorkflowId: "wf-typed-by-hand" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("'wf-typed-by-hand'");
    expect(scopedStore.updateSettings).not.toHaveBeenCalled();
  });

  it("accepts an enabled built-in default", async () => {
    const { app, scopedStore } = createApp({ defaultWorkflowId: undefined });

    const res = await patchSettings(app, { defaultWorkflowId: "builtin:coding" });

    expect(res.status).toBe(200);
    expect(scopedStore.updateSettings).toHaveBeenCalledTimes(1);
  });

  it("refuses a fragment id with the project-default sentence", async () => {
    const { app, scopedStore } = createApp({ defaultWorkflowId: undefined });
    scopedStore.getWorkflowDefinition.mockImplementation(async () => ({ id: "wf-palette", kind: "fragment" }));

    const res = await patchSettings(app, { defaultWorkflowId: "wf-palette" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Workflow 'wf-palette' is a fragment and cannot be set as the project default");
    expect(scopedStore.updateSettings).not.toHaveBeenCalled();
  });

  /*
   * The carve-out control: a project whose STORED default no longer resolves (written before this gate
   * existed) must still be savable, otherwise its whole Settings page becomes unsaveable over a key the
   * operator never touched. The pair of assertions proves the short-circuit specifically — an id that
   * merely happens to be unknown is refused one test above, so the difference here is identity, not
   * validity.
   */
  it("accepts a value identical to the one already stored, without consulting the catalog", async () => {
    const legacyId = "wf-retained-from-an-older-build";
    const { app, scopedStore } = createApp({ defaultWorkflowId: legacyId });

    const res = await patchSettings(app, { defaultWorkflowId: legacyId, taskPrefix: "RUFU" });

    expect(res.status).toBe(200);
    expect(scopedStore.getWorkflowDefinition).not.toHaveBeenCalled();
    expect(scopedStore.updateSettings).toHaveBeenCalledTimes(1);
  });

  it("accepts an explicit clear", async () => {
    const { app, scopedStore } = createApp({ defaultWorkflowId: "builtin:coding" });

    const res = await patchSettings(app, { defaultWorkflowId: null });

    expect(res.status).toBe(200);
    expect(scopedStore.updateSettings).toHaveBeenCalledTimes(1);
  });

  it("leaves a save that does not carry the key untouched by the gate", async () => {
    const { app, scopedStore } = createApp({ defaultWorkflowId: undefined });

    const res = await patchSettings(app, { taskPrefix: "RUFU" });

    expect(res.status).toBe(200);
    expect(scopedStore.getWorkflowDefinition).not.toHaveBeenCalled();
    expect(scopedStore.updateSettings).toHaveBeenCalledTimes(1);
  });
});
