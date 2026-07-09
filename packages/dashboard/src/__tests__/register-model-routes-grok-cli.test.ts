import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    access: vi.fn().mockResolvedValue(undefined),
    // FNXC:GrokCli 2026-07-08-00:05 (FN-7705): this fixture intentionally
    // omits a "grok-cli" key so the toggle path (useGrokCli ->
    // configuredProviders.add) is proven on its own, not masked by an
    // auth.json entry, mirroring the Cursor CLI fixture.
    readFile: vi.fn().mockResolvedValue('{"anthropic":{},"openai":{}}'),
  };
});

vi.mock("../grok-model-cache.js", () => ({
  getGrokPickerModels: vi.fn(),
  GROK_PICKER_PROVIDER_ID: "grok-cli",
}));

import type { Router } from "express";
import { getGrokPickerModels } from "../grok-model-cache.js";
import { registerModelRoutes } from "../routes/register-model-routes.js";

const mockedGetGrokPickerModels = vi.mocked(getGrokPickerModels);

function setup(
  useGrokCli?: boolean,
  registryModels?: Array<{ provider: string; id: string; name: string; reasoning: boolean; contextWindow: number }>,
  grokCliBinaryPath?: unknown,
) {
  const getHandlers = new Map<string, (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>>();
  const router = {
    get: vi.fn((path: string, handler: (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>) => {
      getHandlers.set(path, handler);
    }),
  } as unknown as Router;

  const store = {
    getGlobalSettingsStore: () => ({
      getSettings: vi.fn().mockResolvedValue({ useGrokCli, grokCliBinaryPath }),
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

describe("registerModelRoutes grok-cli merge and filter", () => {
  it("filters grok-cli models when useGrokCli is false, even when discovery would return some", async () => {
    mockedGetGrokPickerModels.mockResolvedValue([
      { provider: "grok-cli", id: "grok-4", name: "Grok 4", reasoning: false, contextWindow: 0 },
    ]);
    const handler = setup(false);
    const response = await invoke(handler);
    expect(response.models.some((model) => model.provider === "grok-cli")).toBe(false);
    // Discovery must not even be attempted when the toggle is off.
    expect(mockedGetGrokPickerModels).not.toHaveBeenCalled();
  });

  it("includes discovered grok-cli models when useGrokCli is true, via the toggle alone (no auth.json entry needed)", async () => {
    mockedGetGrokPickerModels.mockResolvedValue([
      { provider: "grok-cli", id: "grok-4", name: "Grok 4", reasoning: false, contextWindow: 0 },
      { provider: "grok-cli", id: "grok-4-fast", name: "Grok 4 Fast", reasoning: false, contextWindow: 0 },
    ]);
    const handler = setup(true);
    const response = await invoke(handler);
    const grokRows = response.models.filter((m) => m.provider === "grok-cli");
    expect(grokRows.map((m) => m.id).sort()).toEqual(["grok-4", "grok-4-fast"]);
  });

  it("preserves all pre-existing rows (openai, droid-cli-style) alongside newly-surfaced grok-cli rows", async () => {
    mockedGetGrokPickerModels.mockResolvedValue([
      { provider: "grok-cli", id: "grok-4", name: "Grok 4", reasoning: false, contextWindow: 0 },
    ]);
    const registryModels = [
      { provider: "openai", id: "gpt-5", name: "GPT-5", reasoning: true, contextWindow: 128000 },
      { provider: "droid-cli", id: "droid-1", name: "Droid 1", reasoning: false, contextWindow: 0 },
    ];
    const handler = setup(true, registryModels);
    const response = await invoke(handler);
    expect(response.models.some((m) => m.provider === "openai" && m.id === "gpt-5")).toBe(true);
    expect(response.models.some((m) => m.provider === "grok-cli" && m.id === "grok-4")).toBe(true);
  });

  it("dedupes by provider/id when a discovered id collides with an existing registry row — existing row wins", async () => {
    const registryModels = [
      { provider: "grok-cli", id: "grok-4", name: "Registry Grok 4 (pre-existing)", reasoning: true, contextWindow: 128000 },
    ];
    mockedGetGrokPickerModels.mockResolvedValue([
      { provider: "grok-cli", id: "grok-4", name: "Discovered Grok 4 (should be dropped)", reasoning: false, contextWindow: 0 },
    ]);
    const handler = setup(true, registryModels);
    const response = await invoke(handler);
    const grokRows = response.models.filter((m) => m.provider === "grok-cli" && m.id === "grok-4");
    expect(grokRows).toHaveLength(1);
    expect(grokRows[0]?.name).toBe("Registry Grok 4 (pre-existing)");
  });

  it("degrades to zero grok-cli rows (HTTP 200, existing rows intact) when discovery returns empty", async () => {
    mockedGetGrokPickerModels.mockResolvedValue([]);
    const handler = setup(true);
    const response = await invoke(handler);
    expect(response.models.some((m) => m.provider === "grok-cli")).toBe(false);
    expect(response.models.some((m) => m.provider === "openai" && m.id === "gpt-5")).toBe(true);
  });

  it("degrades to zero grok-cli rows (never rejects the handler) when discovery throws", async () => {
    mockedGetGrokPickerModels.mockRejectedValue(new Error("grok unavailable"));
    const handler = setup(true);
    const response = await invoke(handler);
    expect(response.models.some((m) => m.provider === "grok-cli")).toBe(false);
    expect(response.models.some((m) => m.provider === "openai" && m.id === "gpt-5")).toBe(true);
  });

  it("surfaces a single discovered model", async () => {
    mockedGetGrokPickerModels.mockResolvedValue([
      { provider: "grok-cli", id: "grok-only", name: "Only", reasoning: false, contextWindow: 0 },
    ]);
    const handler = setup(true);
    const response = await invoke(handler);
    expect(response.models.filter((m) => m.provider === "grok-cli")).toHaveLength(1);
  });

  it("final response is deduped by provider/id across all merged sources", async () => {
    mockedGetGrokPickerModels.mockResolvedValue([
      { provider: "grok-cli", id: "grok-dup", name: "A", reasoning: false, contextWindow: 0 },
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
FNXC:GrokCli 2026-07-08-00:20:
FN-7705: mirrors the Cursor CLI binaryPath threading coverage
(register-model-routes-cursor-cli.test.ts) so the machine-local
grokCliBinaryPath operator override also applies to model-picker discovery.
*/
describe("registerModelRoutes grokCliBinaryPath threading", () => {
  it("threads a set grokCliBinaryPath override into getGrokPickerModels verbatim", async () => {
    mockedGetGrokPickerModels.mockResolvedValue([
      { provider: "grok-cli", id: "grok-4", name: "Grok 4", reasoning: false, contextWindow: 0 },
    ]);
    const handler = setup(true, undefined, "/opt/Grok/grok");
    const response = await invoke(handler);
    expect(mockedGetGrokPickerModels).toHaveBeenCalledWith({ binaryPath: "/opt/Grok/grok" });
    expect(response.models.some((m) => m.provider === "grok-cli" && m.id === "grok-4")).toBe(true);
  });

  it("threads a Windows-shim-style override path verbatim, with no mangling", async () => {
    mockedGetGrokPickerModels.mockResolvedValue([]);
    const winPath = "C:\\Users\\A User\\AppData\\Roaming\\npm\\grok.cmd";
    const handler = setup(true, undefined, winPath);
    await invoke(handler);
    expect(mockedGetGrokPickerModels).toHaveBeenCalledWith({ binaryPath: winPath });
  });

  it("passes binaryPath: undefined when grokCliBinaryPath is absent (PATH auto-detection preserved)", async () => {
    mockedGetGrokPickerModels.mockResolvedValue([]);
    const handler = setup(true, undefined, undefined);
    await invoke(handler);
    expect(mockedGetGrokPickerModels).toHaveBeenCalledWith({ binaryPath: undefined });
  });

  it("passes binaryPath: undefined when grokCliBinaryPath is blank/whitespace-only", async () => {
    mockedGetGrokPickerModels.mockResolvedValue([]);
    const handler = setup(true, undefined, "   ");
    await invoke(handler);
    expect(mockedGetGrokPickerModels).toHaveBeenCalledWith({ binaryPath: undefined });
  });

  it("does not surface grok-cli rows or call getGrokPickerModels when useGrokCli is false, regardless of grokCliBinaryPath", async () => {
    const handler = setup(false, undefined, "/opt/Grok/grok");
    const response = await invoke(handler);
    expect(mockedGetGrokPickerModels).not.toHaveBeenCalled();
    expect(response.models.some((m) => m.provider === "grok-cli")).toBe(false);
  });
});
