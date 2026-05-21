import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

import { parseOpencodeModelsOutput, refreshOpencodeGoModels, syncStartupModels } from "../startup-model-sync.js";

type MockProcess = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

function createSpawnProcess(): MockProcess {
  const proc = new EventEmitter() as MockProcess;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  return proc;
}

describe("startup-model-sync", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  function mockOpenRouterFetchSequence(...responses: Array<{ ok: boolean; status?: number; body?: unknown }>): void {
    const fetchMock = vi.fn();
    for (const response of responses) {
      fetchMock.mockResolvedValueOnce({
        ok: response.ok,
        status: response.status ?? (response.ok ? 200 : 500),
        json: vi.fn().mockResolvedValue(response.body ?? { data: [] }),
      });
    }
    vi.stubGlobal("fetch", fetchMock);
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("syncs OpenRouter and opencode-go models", async () => {
    mockSpawn.mockImplementation(() => {
      const proc = createSpawnProcess();
      queueMicrotask(() => {
        proc.stdout.emit("data", Buffer.from("Models cache refreshed\nopencode/gpt-5\nopencode-go/custom\n"));
        proc.emit("exit", 0);
      });
      return proc;
    });

    mockOpenRouterFetchSequence({
      ok: true,
      body: { data: [{ id: "openai/gpt-4o", name: "GPT-4o", context_length: 128000 }] },
    });

    const registerProvider = vi.fn();
    const log = vi.fn();
    const run = syncStartupModels({
      getSettings: vi.fn().mockResolvedValue({ openrouterModelSync: true, opencodeGoModelSync: true }),
      authStorage: { getApiKey: vi.fn().mockResolvedValue("key") },
      modelRegistry: { registerProvider },
      log,
    });

    await run;

    expect(registerProvider).toHaveBeenCalledWith("openrouter", expect.objectContaining({ models: expect.any(Array) }));
    expect(registerProvider).toHaveBeenCalledWith("opencode-go", expect.objectContaining({
      models: expect.arrayContaining([
        expect.objectContaining({ id: "opencode-go/gpt-5" }),
        expect.objectContaining({ id: "opencode-go/custom" }),
      ]),
    }));
    expect(log).toHaveBeenCalledWith("openrouter", expect.stringContaining("Synced"));
    expect(log).toHaveBeenCalledWith("opencode-go", expect.stringContaining("Synced"));
  });

  it("respects disabled settings", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const registerProvider = vi.fn();

    await syncStartupModels({
      getSettings: vi.fn().mockResolvedValue({ openrouterModelSync: false, opencodeGoModelSync: false }),
      authStorage: { getApiKey: vi.fn() },
      modelRegistry: { registerProvider },
      log: vi.fn(),
    });

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(registerProvider).not.toHaveBeenCalled();
  });

  it("sends default OpenRouter attribution headers", async () => {
    mockOpenRouterFetchSequence({ ok: true });

    await syncStartupModels({
      getSettings: vi.fn().mockResolvedValue({ openrouterModelSync: true, opencodeGoModelSync: false }),
      authStorage: { getApiKey: vi.fn().mockResolvedValue(undefined) },
      modelRegistry: { registerProvider: vi.fn() },
      log: vi.fn(),
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/models"),
      expect.objectContaining({
        headers: expect.objectContaining({
          "HTTP-Referer": "https://runfusion.ai",
          "X-Title": "Fusion",
        }),
      }),
    );
  });

  it("uses custom OpenRouter attribution headers", async () => {
    mockOpenRouterFetchSequence({ ok: true });

    await syncStartupModels({
      getSettings: vi.fn().mockResolvedValue({
        openrouterModelSync: true,
        opencodeGoModelSync: false,
        openrouterAppAttribution: { referer: "https://example.com", title: "ExampleApp" },
      }),
      authStorage: { getApiKey: vi.fn().mockResolvedValue(undefined) },
      modelRegistry: { registerProvider: vi.fn() },
      log: vi.fn(),
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          "HTTP-Referer": "https://example.com",
          "X-Title": "ExampleApp",
        }),
      }),
    );
  });

  it("uses OpenRouter user models endpoint when API key is present", async () => {
    mockOpenRouterFetchSequence({ ok: true });

    await syncStartupModels({
      getSettings: vi.fn().mockResolvedValue({ openrouterModelSync: true, opencodeGoModelSync: false }),
      authStorage: { getApiKey: vi.fn().mockResolvedValue("key") },
      modelRegistry: { registerProvider: vi.fn() },
      log: vi.fn(),
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/models/user"),
      expect.any(Object),
    );
  });

  it("falls back to public OpenRouter endpoint when user endpoint fails", async () => {
    const log = vi.fn();
    mockOpenRouterFetchSequence(
      { ok: false, status: 401 },
      { ok: true, body: { data: [] } },
    );

    await syncStartupModels({
      getSettings: vi.fn().mockResolvedValue({ openrouterModelSync: true, opencodeGoModelSync: false }),
      authStorage: { getApiKey: vi.fn().mockResolvedValue("key") },
      modelRegistry: { registerProvider: vi.fn() },
      log,
    });

    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]?.[0]).toContain("/api/v1/models/user");
    expect(calls[1]?.[0]).toContain("/api/v1/models");
    expect(log).toHaveBeenCalledWith("openrouter", expect.stringContaining("falling back"));
  });

  it("applies OpenRouter model filters as comma-joined query params", async () => {
    mockOpenRouterFetchSequence({ ok: true });

    await syncStartupModels({
      getSettings: vi.fn().mockResolvedValue({
        openrouterModelSync: true,
        opencodeGoModelSync: false,
        openrouterModelFilters: {
          supported_parameters: ["tools", "structured_outputs"],
          output_modalities: ["text"],
        },
      }),
      authStorage: { getApiKey: vi.fn().mockResolvedValue(undefined) },
      modelRegistry: { registerProvider: vi.fn() },
      log: vi.fn(),
    });

    const requestUrl = new URL((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string);
    expect(requestUrl.searchParams.get("supported_parameters")).toBe("tools,structured_outputs");
    expect(requestUrl.searchParams.get("output_modalities")).toBe("text");
  });

  it("passes OpenRouter routing compat and provider headers to model registry", async () => {
    mockOpenRouterFetchSequence({ ok: true });
    const registerProvider = vi.fn();

    await syncStartupModels({
      getSettings: vi.fn().mockResolvedValue({
        openrouterModelSync: true,
        opencodeGoModelSync: false,
        openrouterProviderPreferences: {
          order: ["openai"],
          allow_fallbacks: false,
          sort: "price",
          require_parameters: true,
        },
      }),
      authStorage: { getApiKey: vi.fn().mockResolvedValue("key") },
      modelRegistry: { registerProvider },
      log: vi.fn(),
    });

    expect(registerProvider).toHaveBeenCalledWith(
      "openrouter",
      expect.objectContaining({
        headers: {
          "HTTP-Referer": "https://runfusion.ai",
          "X-Title": "Fusion",
        },
        compat: {
          openRouterRouting: expect.objectContaining({
            order: ["openai"],
            allow_fallbacks: false,
            sort: "price",
            require_parameters: true,
          }),
        },
      }),
    );
  });

  it("returns refresh result for opencode-go happy path", async () => {
    mockSpawn.mockImplementation(() => {
      const proc = createSpawnProcess();
      queueMicrotask(() => {
        proc.stdout.emit("data", Buffer.from("Models cache refreshed\nopencode/gpt-5\n"));
        proc.emit("exit", 0);
      });
      return proc;
    });

    const registerProvider = vi.fn();
    const result = await refreshOpencodeGoModels({ modelRegistry: { registerProvider }, log: vi.fn() });

    expect(result).toEqual({ registeredCount: 1 });
    expect(registerProvider).toHaveBeenCalledWith("opencode-go", expect.objectContaining({
      models: [expect.objectContaining({ id: "opencode-go/gpt-5" })],
    }));
  });

  it("returns no-models reason when cli output has no models", async () => {
    mockSpawn.mockImplementation(() => {
      const proc = createSpawnProcess();
      queueMicrotask(() => {
        proc.stdout.emit("data", Buffer.from("Models cache refreshed\n"));
        proc.emit("exit", 0);
      });
      return proc;
    });

    const result = await refreshOpencodeGoModels({ modelRegistry: { registerProvider: vi.fn() }, log: vi.fn() });
    expect(result).toEqual({ registeredCount: 0, reason: "no-models-from-cli" });
  });

  it("returns cli-failed reason when spawn errors", async () => {
    mockSpawn.mockImplementation(() => {
      const proc = createSpawnProcess();
      queueMicrotask(() => proc.emit("error", new Error("spawn opencode ENOENT")));
      return proc;
    });

    const result = await refreshOpencodeGoModels({ modelRegistry: { registerProvider: vi.fn() }, log: vi.fn() });
    expect(result.registeredCount).toBe(0);
    expect(result.reason).toBe("cli-failed");
    expect(result.error).toContain("ENOENT");
  });

  it("logs failures and continues", async () => {
    mockSpawn.mockImplementation(() => {
      const proc = createSpawnProcess();
      queueMicrotask(() => {
        proc.stderr.emit("data", Buffer.from("provider unavailable"));
        proc.emit("exit", 1);
      });
      return proc;
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    const log = vi.fn();

    const run = syncStartupModels({
      getSettings: vi.fn().mockResolvedValue({ openrouterModelSync: true, opencodeGoModelSync: true }),
      authStorage: { getApiKey: vi.fn().mockResolvedValue(undefined) },
      modelRegistry: { registerProvider: vi.fn() },
      log,
    });

    await run;

    expect(log).toHaveBeenCalledWith("openrouter", expect.stringContaining("Failed to sync models"));
    expect(log).toHaveBeenCalledWith("opencode-go", expect.stringContaining("Failed to sync models"));
  });

  it("parses model ids from opencode CLI output", () => {
    expect(parseOpencodeModelsOutput("Models cache refreshed\nopencode/gpt-5\nfoo\nopencode-go/custom\n")).toEqual([
      "opencode/gpt-5",
      "opencode-go/custom",
    ]);
  });
});
