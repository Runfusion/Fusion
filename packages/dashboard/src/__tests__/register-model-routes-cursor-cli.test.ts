import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    access: vi.fn().mockResolvedValue(undefined),
    // FNXC:ModelCatalog 2026-07-08-00:05 (FN-7696): this fixture intentionally
    // omits a "cursor-cli" key so the toggle path (useCursorCli ->
    // configuredProviders.add) is proven on its own, not masked by an
    // auth.json entry. Before the fix, cursor-cli rows were dropped by the
    // final configuredProviders filter regardless of this fixture.
    readFile: vi.fn().mockResolvedValue('{"anthropic":{},"openai":{}}'),
  };
});

vi.mock("../cursor-model-cache.js", () => ({
  getCursorPickerModels: vi.fn(),
  CURSOR_PICKER_PROVIDER_ID: "cursor-cli",
}));

import type { Router } from "express";
import { getCursorPickerModels } from "../cursor-model-cache.js";
import { registerModelRoutes } from "../routes/register-model-routes.js";

const mockedGetCursorPickerModels = vi.mocked(getCursorPickerModels);

function setup(
  useCursorCli?: boolean,
  registryModels?: Array<{ provider: string; id: string; name: string; reasoning: boolean; contextWindow: number }>,
  cursorCliBinaryPath?: unknown,
) {
  const getHandlers = new Map<string, (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>>();
  const router = {
    get: vi.fn((path: string, handler: (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>) => {
      getHandlers.set(path, handler);
    }),
  } as unknown as Router;

  const store = {
    getGlobalSettingsStore: () => ({
      getSettings: vi.fn().mockResolvedValue({ useCursorCli, cursorCliBinaryPath }),
    }),
    getSettingsFast: vi.fn().mockResolvedValue({}),
  };

  const runtimeLogger = {
    child: vi.fn(() => ({ warn: vi.fn() })),
  };

  const modelRegistry = {
    refresh: vi.fn(),
    getAvailable: vi.fn(
      () =>
        registryModels ?? [{ provider: "openai", id: "gpt-5", name: "GPT-5", reasoning: true, contextWindow: 128000 }],
    ),
  };

  registerModelRoutes({
    router,
    store: store as never,
    runtimeLogger: runtimeLogger as never,
    options: { modelRegistry } as never,
  } as never);

  return getHandlers.get("/models")!;
}

async function invoke(handler: (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>) {
  const json = vi.fn();
  await handler({}, { json });
  return json.mock.calls[0][0] as { models: Array<{ provider: string; id: string; name: string }> };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("registerModelRoutes cursor-cli merge and filter", () => {
  it("filters cursor-cli models when useCursorCli is false, even when discovery would return some", async () => {
    mockedGetCursorPickerModels.mockResolvedValue([
      { provider: "cursor-cli", id: "cursor/gpt-5", name: "GPT-5", reasoning: false, contextWindow: 0 },
    ]);
    const handler = setup(false);
    const response = await invoke(handler);
    expect(response.models.some((model) => model.provider === "cursor-cli")).toBe(false);
    // Discovery must not even be attempted when the toggle is off.
    expect(mockedGetCursorPickerModels).not.toHaveBeenCalled();
  });

  it("includes discovered cursor-cli models when useCursorCli is true, via the toggle alone (no auth.json entry needed)", async () => {
    mockedGetCursorPickerModels.mockResolvedValue([
      { provider: "cursor-cli", id: "cursor/gpt-5", name: "GPT-5", reasoning: false, contextWindow: 0 },
      { provider: "cursor-cli", id: "cursor/sonnet", name: "Sonnet", reasoning: false, contextWindow: 0 },
    ]);
    const handler = setup(true);
    const response = await invoke(handler);
    const cursorRows = response.models.filter((m) => m.provider === "cursor-cli");
    expect(cursorRows.map((m) => m.id).sort()).toEqual(["cursor/gpt-5", "cursor/sonnet"]);
  });

  it("preserves all pre-existing rows (openai, anthropic-style) alongside newly-surfaced cursor-cli rows", async () => {
    mockedGetCursorPickerModels.mockResolvedValue([
      { provider: "cursor-cli", id: "cursor/gpt-5", name: "GPT-5", reasoning: false, contextWindow: 0 },
    ]);
    const registryModels = [
      { provider: "openai", id: "gpt-5", name: "GPT-5", reasoning: true, contextWindow: 128000 },
      { provider: "droid-cli", id: "droid-1", name: "Droid 1", reasoning: false, contextWindow: 0 },
    ];
    const handler = setup(true, registryModels);
    const response = await invoke(handler);
    expect(response.models.some((m) => m.provider === "openai" && m.id === "gpt-5")).toBe(true);
    expect(response.models.some((m) => m.provider === "cursor-cli" && m.id === "cursor/gpt-5")).toBe(true);
  });

  it("dedupes by provider/id when a discovered id collides with an existing registry row — existing row wins", async () => {
    const registryModels = [
      { provider: "cursor-cli", id: "cursor/gpt-5", name: "Registry GPT-5 (pre-existing)", reasoning: true, contextWindow: 128000 },
    ];
    mockedGetCursorPickerModels.mockResolvedValue([
      { provider: "cursor-cli", id: "cursor/gpt-5", name: "Discovered GPT-5 (should be dropped)", reasoning: false, contextWindow: 0 },
    ]);
    const handler = setup(true, registryModels);
    const response = await invoke(handler);
    const cursorRows = response.models.filter((m) => m.provider === "cursor-cli" && m.id === "cursor/gpt-5");
    expect(cursorRows).toHaveLength(1);
    expect(cursorRows[0]?.name).toBe("Registry GPT-5 (pre-existing)");
  });

  it("degrades to zero cursor-cli rows (HTTP 200, existing rows intact) when discovery returns empty", async () => {
    mockedGetCursorPickerModels.mockResolvedValue([]);
    const handler = setup(true);
    const response = await invoke(handler);
    expect(response.models.some((m) => m.provider === "cursor-cli")).toBe(false);
    expect(response.models.some((m) => m.provider === "openai" && m.id === "gpt-5")).toBe(true);
  });

  it("degrades to zero cursor-cli rows (never rejects the handler) when discovery throws", async () => {
    mockedGetCursorPickerModels.mockRejectedValue(new Error("cursor-agent unavailable"));
    const handler = setup(true);
    const response = await invoke(handler);
    expect(response.models.some((m) => m.provider === "cursor-cli")).toBe(false);
    expect(response.models.some((m) => m.provider === "openai" && m.id === "gpt-5")).toBe(true);
  });

  it("surfaces a single discovered model", async () => {
    mockedGetCursorPickerModels.mockResolvedValue([
      { provider: "cursor-cli", id: "cursor/only", name: "Only", reasoning: false, contextWindow: 0 },
    ]);
    const handler = setup(true);
    const response = await invoke(handler);
    expect(response.models.filter((m) => m.provider === "cursor-cli")).toHaveLength(1);
  });

  it("final response is deduped by provider/id across all merged sources", async () => {
    mockedGetCursorPickerModels.mockResolvedValue([
      { provider: "cursor-cli", id: "cursor/dup", name: "A", reasoning: false, contextWindow: 0 },
    ]);
    const registryModels = [
      { provider: "openai", id: "gpt-5", name: "GPT-5", reasoning: true, contextWindow: 128000 },
      { provider: "openai", id: "gpt-5", name: "GPT-5 dup", reasoning: true, contextWindow: 128000 },
    ];
    const handler = setup(true, registryModels);
    const response = await invoke(handler);
    const keys = response.models.map((m) => `${m.provider}/${m.id}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

/*
FNXC:CursorCli 2026-07-08-00:20:
FN-7699: the machine-local cursorCliBinaryPath operator override (already
honored by the auth/probe/status paths in register-auth-routes.ts) must also
apply to model-picker discovery, so an operator whose cursor-agent is not on
PATH still sees Cursor models in the picker. These tests assert the
normalized override is threaded into getCursorPickerModels({ binaryPath })
verbatim, that blank/undefined preserves binaryPath: undefined (PATH
auto-detection), and that the toggle-off gate (FN-7696) is not regressed.
*/
describe("registerModelRoutes cursorCliBinaryPath threading", () => {
  it("threads a set cursorCliBinaryPath override into getCursorPickerModels verbatim", async () => {
    mockedGetCursorPickerModels.mockResolvedValue([
      { provider: "cursor-cli", id: "cursor/gpt-5", name: "GPT-5", reasoning: false, contextWindow: 0 },
    ]);
    const handler = setup(true, undefined, "/opt/Cursor/cursor-agent");
    const response = await invoke(handler);
    expect(mockedGetCursorPickerModels).toHaveBeenCalledWith({ binaryPath: "/opt/Cursor/cursor-agent" });
    expect(response.models.some((m) => m.provider === "cursor-cli" && m.id === "cursor/gpt-5")).toBe(true);
  });

  it("threads a Windows-shim-style override path verbatim, with no mangling", async () => {
    mockedGetCursorPickerModels.mockResolvedValue([]);
    const winPath = "C:\\Users\\A User\\AppData\\Roaming\\npm\\cursor-agent.cmd";
    const handler = setup(true, undefined, winPath);
    await invoke(handler);
    expect(mockedGetCursorPickerModels).toHaveBeenCalledWith({ binaryPath: winPath });
  });

  it("passes binaryPath: undefined when cursorCliBinaryPath is absent (PATH auto-detection preserved)", async () => {
    mockedGetCursorPickerModels.mockResolvedValue([]);
    const handler = setup(true, undefined, undefined);
    await invoke(handler);
    expect(mockedGetCursorPickerModels).toHaveBeenCalledWith({ binaryPath: undefined });
  });

  it("passes binaryPath: undefined when cursorCliBinaryPath is blank/whitespace-only", async () => {
    mockedGetCursorPickerModels.mockResolvedValue([]);
    const handler = setup(true, undefined, "   ");
    await invoke(handler);
    expect(mockedGetCursorPickerModels).toHaveBeenCalledWith({ binaryPath: undefined });
  });

  it("passes binaryPath: undefined when cursorCliBinaryPath is an empty string", async () => {
    mockedGetCursorPickerModels.mockResolvedValue([]);
    const handler = setup(true, undefined, "");
    await invoke(handler);
    expect(mockedGetCursorPickerModels).toHaveBeenCalledWith({ binaryPath: undefined });
  });

  it("does not surface cursor-cli rows or call getCursorPickerModels when useCursorCli is false, regardless of cursorCliBinaryPath", async () => {
    const handler = setup(false, undefined, "/opt/Cursor/cursor-agent");
    const response = await invoke(handler);
    expect(mockedGetCursorPickerModels).not.toHaveBeenCalled();
    expect(response.models.some((m) => m.provider === "cursor-cli")).toBe(false);
  });
});
