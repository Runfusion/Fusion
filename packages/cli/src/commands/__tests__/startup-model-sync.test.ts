import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

import { parseOpencodeModelsOutput, syncStartupModels } from "../startup-model-sync.js";

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

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        data: [{ id: "openai/gpt-4o", name: "GPT-4o", context_length: 128000 }],
      }),
    }));

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
