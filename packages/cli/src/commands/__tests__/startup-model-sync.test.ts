import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

import { handleCheaperInferenceApiKeySaved, normalizeOpencodeGoModel, parseOpencodeModelsOutput, refreshOpencodeGoModels, syncStartupModels } from "../startup-model-sync.js";

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
    // OrcaRouter sync runs alongside OpenRouter by default; give it a benign
    // catalog response so OpenRouter-focused tests do not consume an undefined mock.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ data: [] }),
    });
    // Cheaper Inference sync also runs by default when a key is stored.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ data: [] }),
    });
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
        expect.objectContaining({ id: "gpt-5" }),
        expect.objectContaining({ id: "custom" }),
      ]),
    }));
    expect(log).toHaveBeenCalledWith("openrouter", expect.stringContaining("Synced"));
    expect(log).toHaveBeenCalledWith("opencode-go", expect.stringContaining("Synced"));
  });

  it("respects disabled settings", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const registerProvider = vi.fn();

    await syncStartupModels({
      getSettings: vi.fn().mockResolvedValue({ openrouterModelSync: false, opencodeGoModelSync: false, orcarouterModelSync: false, cheaperinferenceModelSync: false }),
      authStorage: { getApiKey: vi.fn() },
      modelRegistry: { registerProvider },
      log: vi.fn(),
    });

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(registerProvider).not.toHaveBeenCalled();
  });

  it("syncs OrcaRouter models as a named OpenAI-compatible provider", async () => {
    mockOpenRouterFetchSequence({ ok: true });

    const registerProvider = vi.fn();
    const log = vi.fn();
    await syncStartupModels({
      getSettings: vi.fn().mockResolvedValue({
        openrouterModelSync: false,
        orcarouterModelSync: true,
        opencodeGoModelSync: false,
      }),
      authStorage: { getApiKey: vi.fn().mockResolvedValue("sk-orca-test") },
      modelRegistry: { registerProvider },
      log,
    });

    const orcaRouterCall = registerProvider.mock.calls.find(([name]) => name === "orcarouter");
    expect(orcaRouterCall).toBeDefined();
    expect(orcaRouterCall?.[1]).toMatchObject({
      baseUrl: "https://api.orcarouter.ai/v1",
      apiKey: "ORCAROUTER_API_KEY",
      api: "openai-completions",
      models: expect.any(Array),
    });
    expect(log).toHaveBeenCalledWith("orcarouter", expect.stringContaining("Synced"));
  });

  it("sends an OrcaRouter bearer token when an API key is stored", async () => {
    mockOpenRouterFetchSequence({ ok: true });

    await syncStartupModels({
      getSettings: vi.fn().mockResolvedValue({
        openrouterModelSync: false,
        orcarouterModelSync: true,
        opencodeGoModelSync: false,
      }),
      authStorage: { getApiKey: vi.fn().mockResolvedValue("sk-orca-secret") },
      modelRegistry: { registerProvider: vi.fn() },
      log: vi.fn(),
    });

    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some(([url]) => String(url).includes("api.orcarouter.ai"))).toBe(true);
    const orcaCall = calls.find(([url]) => String(url).includes("api.orcarouter.ai"))!;
    expect(orcaCall?.[1]).toEqual({
      headers: { Authorization: "Bearer sk-orca-secret" },
    });
  });

  it("syncs Cheaper Inference text models as a named OpenAI-compatible provider", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        data: [
          {
            id: "gpt-5.4-mini",
            type: "text",
            context_length: 400000,
            max_output_tokens: 128000,
            capabilities: { vision: true, reasoning: true },
            pricing: {
              input_per_million: "0.487500",
              output_per_million: "2.925000",
              cache_read_input_per_million: "0.048750",
              cache_write_input_per_million: "0.487500",
            },
          },
          { id: "image-model", type: "image" },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const registerProvider = vi.fn();
    const log = vi.fn();
    await syncStartupModels({
      getSettings: vi.fn().mockResolvedValue({
        openrouterModelSync: false,
        orcarouterModelSync: false,
        cheaperinferenceModelSync: true,
        opencodeGoModelSync: false,
      }),
      authStorage: { getApiKey: vi.fn().mockResolvedValue("ci_live_test") },
      modelRegistry: { registerProvider },
      log,
    });

    expect(fetchMock).toHaveBeenCalledWith("https://api.cheaperinference.com/v1/models", {
      headers: { Authorization: "Bearer ci_live_test" },
      signal: expect.any(AbortSignal),
    });
    expect(registerProvider).toHaveBeenCalledWith("cheaperinference", {
      baseUrl: "https://api.cheaperinference.com/v1",
      apiKey: "CHEAPER_INFERENCE_API_KEY",
      api: "openai-completions",
      models: [
        {
          id: "gpt-5.4-mini",
          name: "gpt-5.4-mini",
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 0.4875, output: 2.925, cacheRead: 0.04875, cacheWrite: 0.4875 },
          contextWindow: 400000,
          maxTokens: 128000,
        },
      ],
    });
    expect(log).toHaveBeenCalledWith("cheaperinference", "Synced 1 models from Cheaper Inference API");
  });

  it("skips Cheaper Inference sync when no API key is stored", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const registerProvider = vi.fn();

    await syncStartupModels({
      getSettings: vi.fn().mockResolvedValue({
        openrouterModelSync: false,
        orcarouterModelSync: false,
        cheaperinferenceModelSync: true,
        opencodeGoModelSync: false,
      }),
      authStorage: { getApiKey: vi.fn().mockResolvedValue(undefined) },
      modelRegistry: { registerProvider },
      log: vi.fn(),
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(registerProvider).not.toHaveBeenCalled();
  });

  it("aborts a stalled Cheaper Inference catalog read and continues with later syncs", async () => {
    const deadline = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: { signal: AbortSignal }) => ({
      ok: true,
      status: 200,
      // The body never arrives; only the request signal can end the read.
      json: () => new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("The operation was aborted due to timeout")));
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    mockSpawn.mockImplementation(() => {
      const proc = createSpawnProcess();
      queueMicrotask(() => {
        proc.stdout.emit("data", Buffer.from("opencode/foo\n"));
        proc.emit("exit", 0);
      });
      return proc;
    });

    const registerProvider = vi.fn();
    const log = vi.fn();
    try {
      const run = syncStartupModels({
        getSettings: vi.fn().mockResolvedValue({
          openrouterModelSync: false,
          orcarouterModelSync: false,
          cheaperinferenceModelSync: true,
          opencodeGoModelSync: true,
        }),
        authStorage: { getApiKey: vi.fn().mockResolvedValue("ci_live_test") },
        modelRegistry: { registerProvider },
        log,
      });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
      deadline.abort();
      await run;
      expect(timeoutSpy).toHaveBeenCalledWith(15_000);
    } finally {
      timeoutSpy.mockRestore();
    }

    expect(log).toHaveBeenCalledWith("cheaperinference", expect.stringContaining("Failed to sync models"));
    expect(registerProvider).not.toHaveBeenCalledWith("cheaperinference", expect.anything());
    expect(registerProvider).toHaveBeenCalledWith("opencode-go", expect.anything());
  });

  it("syncs Cheaper Inference models after its API key is saved", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ data: [{ id: "gpt-5.4-mini", type: "text" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const registerProvider = vi.fn();
    const log = vi.fn();

    await handleCheaperInferenceApiKeySaved(
      { getApiKey: vi.fn().mockResolvedValue("ci_live_test") },
      { getSettings: vi.fn().mockResolvedValue({}) },
      { registerProvider },
      log,
    );

    expect(fetchMock).toHaveBeenCalledWith("https://api.cheaperinference.com/v1/models", expect.objectContaining({
      headers: { Authorization: "Bearer ci_live_test" },
    }));
    expect(registerProvider).toHaveBeenCalledWith("cheaperinference", expect.objectContaining({
      models: [expect.objectContaining({ id: "gpt-5.4-mini" })],
    }));
    expect(log).toHaveBeenCalledWith("cheaperinference", "Synced 1 models from Cheaper Inference API");
  });

  it("skips Cheaper Inference key-save sync when disabled by settings", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const registerProvider = vi.fn();

    await handleCheaperInferenceApiKeySaved(
      { getApiKey: vi.fn().mockResolvedValue("ci_live_test") },
      { getSettings: vi.fn().mockResolvedValue({ cheaperinferenceModelSync: false }) },
      { registerProvider },
      vi.fn(),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(registerProvider).not.toHaveBeenCalled();
  });

  it("logs Cheaper Inference key-save sync failures without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    const log = vi.fn();

    await expect(handleCheaperInferenceApiKeySaved(
      { getApiKey: vi.fn().mockResolvedValue("ci_live_test") },
      { getSettings: vi.fn().mockResolvedValue({}) },
      { registerProvider: vi.fn() },
      log,
    )).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledWith("cheaperinference", "Failed to sync models: network");
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
      models: [expect.objectContaining({ id: "gpt-5" })],
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

  it("deduplicates models when CLI emits both prefix forms", async () => {
    mockSpawn.mockImplementation(() => {
      const proc = createSpawnProcess();
      queueMicrotask(() => {
        proc.stdout.emit("data", Buffer.from("opencode/foo\nopencode-go/foo\nopencode/bar\n"));
        proc.emit("exit", 0);
      });
      return proc;
    });

    const registerProvider = vi.fn();
    await refreshOpencodeGoModels({ modelRegistry: { registerProvider }, log: vi.fn() });

    expect(registerProvider).toHaveBeenCalledWith("opencode-go", expect.objectContaining({
      models: [
        expect.objectContaining({ id: "foo" }),
        expect.objectContaining({ id: "bar" }),
      ],
    }));
  });

  it("throws on empty model ID after prefix stripping", () => {
    expect(() => normalizeOpencodeGoModel("opencode/")).toThrow("no model name");
    expect(() => normalizeOpencodeGoModel("opencode-go/")).toThrow("no model name");
  });

  it("accepts apiKey and passes it as env var to spawn", async () => {
    mockSpawn.mockImplementation(() => {
      const proc = createSpawnProcess();
      queueMicrotask(() => {
        proc.stdout.emit("data", Buffer.from("opencode/foo\n"));
        proc.emit("exit", 0);
      });
      return proc;
    });

    const registerProvider = vi.fn();
    await refreshOpencodeGoModels({ modelRegistry: { registerProvider }, log: vi.fn(), apiKey: "test-key" });

    expect(mockSpawn).toHaveBeenCalledWith(
      "opencode",
      ["models", "opencode", "--refresh"],
      expect.objectContaining({
        env: expect.objectContaining({ OPENCODE_API_KEY: "test-key" }),
      }),
    );
  });
});
