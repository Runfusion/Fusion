// @vitest-environment node

import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerSettingsMemoryRoutes } from "../register-settings-memory-routes.js";
import { request as performRequest } from "../../test-request.js";

const { resolveWorktrunkBinaryMock, probeWorktrunkMock } = vi.hoisted(() => ({
  resolveWorktrunkBinaryMock: vi.fn(),
  probeWorktrunkMock: vi.fn(),
}));

vi.mock("@fusion/engine", async () => {
  const actual = await vi.importActual<typeof import("@fusion/engine")>("@fusion/engine");
  return {
    ...actual,
    resolveWorktrunkBinary: resolveWorktrunkBinaryMock,
    probeWorktrunk: probeWorktrunkMock,
  };
});

function createApp() {
  const router = express.Router();
  const scopedStore = {
    getSettings: vi.fn(async () => ({ worktrunk: { enabled: false } })),
    updateSettings: vi.fn(async (patch: Record<string, unknown>) => patch),
  };

  registerSettingsMemoryRoutes(
    {
      router,
      options: {},
      store: {} as any,
      runtimeLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as any,
      getProjectContext: vi.fn(async () => ({ store: scopedStore, projectId: "p1" })),
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
});
