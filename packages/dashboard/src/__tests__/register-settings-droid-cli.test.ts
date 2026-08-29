import { describe, expect, it, vi } from "vitest";
import type { Router } from "express";
import { registerSettingsMemoryRoutes } from "../routes/register-settings-memory-routes.js";

function setup(initialUseDroidCli = false) {
  const putHandlers = new Map<string, (req: { body: Record<string, unknown> }, res: { json: (body: unknown) => void }) => Promise<void>>();
  const router = {
    get: vi.fn(),
    put: vi.fn((path: string, handler: (req: { body: Record<string, unknown> }, res: { json: (body: unknown) => void }) => Promise<void>) => {
      putHandlers.set(path, handler);
    }),
    post: vi.fn(),
    delete: vi.fn(),
  } as unknown as Router;

  let globalSettings = { useDroidCli: initialUseDroidCli } as Record<string, unknown>;
  const onUseDroidCliToggled = vi.fn();

  const store = {
    getGlobalSettingsStore: () => ({
      getSettings: vi.fn(async () => globalSettings),
      invalidateCache: vi.fn(),
    }),
    updateGlobalSettings: vi.fn(async (patch: Record<string, unknown>) => {
      globalSettings = { ...globalSettings, ...patch };
      return globalSettings;
    }),
  };

  registerSettingsMemoryRoutes(
    {
      router,
      store: store as never,
      options: {
        onUseDroidCliToggled,
        engineManager: { getAllEngines: () => new Map() },
      } as never,
      runtimeLogger: { warn: vi.fn() } as never,
      getProjectContext: vi.fn() as never,
      rethrowAsApiError: (err: unknown): never => {
        throw err;
      },
    } as never,
    {
      validateModelPresets: () => undefined,
      sanitizeOverlapIgnorePaths: () => undefined,
      discoverDashboardPiExtensions: async () => ({ entries: [] }) as never,
    },
  );

  return {
    putSettingsGlobal: putHandlers.get("/settings/global")!,
    onUseDroidCliToggled,
  };
}

describe("registerSettingsMemoryRoutes useDroidCli hook", () => {
  it("fires onUseDroidCliToggled on transition", async () => {
    const { putSettingsGlobal, onUseDroidCliToggled } = setup(false);
    await putSettingsGlobal({ body: { useDroidCli: true } }, { json: vi.fn() });
    expect(onUseDroidCliToggled).toHaveBeenCalledWith(false, true);
  });

  it("does not fire onUseDroidCliToggled when value does not change", async () => {
    const { putSettingsGlobal, onUseDroidCliToggled } = setup(true);
    await putSettingsGlobal({ body: { useDroidCli: true } }, { json: vi.fn() });
    expect(onUseDroidCliToggled).not.toHaveBeenCalled();
  });

  it("does not fire onUseDroidCliToggled for unrelated settings updates", async () => {
    const { putSettingsGlobal, onUseDroidCliToggled } = setup(false);
    await putSettingsGlobal({ body: { defaultProvider: "openai" } }, { json: vi.fn() });
    expect(onUseDroidCliToggled).not.toHaveBeenCalled();
  });
});
