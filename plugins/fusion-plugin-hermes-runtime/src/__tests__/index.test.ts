import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockResolveCli } = vi.hoisted(() => ({
  mockResolveCli: vi.fn().mockReturnValue({
    binaryPath: "hermes",
    model: undefined,
    provider: undefined,
    maxTurns: 12,
    yolo: false,
    cliTimeoutMs: 300_000,
  }),
}));

vi.mock("../cli-spawn.js", async () => {
  const actual = await vi.importActual<typeof import("../cli-spawn.js")>(
    "../cli-spawn.js",
  );
  return {
    ...actual,
    resolveCliSettings: mockResolveCli,
  };
});

import plugin, {
  hermesRuntimeMetadata,
  hermesRuntimeFactory,
  HERMES_RUNTIME_ID,
} from "../index.js";
import { HermesRuntimeAdapter } from "../runtime-adapter.js";

function createMockContext(settings: Record<string, unknown> = {}) {
  return {
    pluginId: "fusion-plugin-hermes-runtime",
    settings,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    emitEvent: vi.fn(),
    taskStore: { getTask: vi.fn() },
  };
}

describe("hermes-runtime plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveCli.mockReturnValue({
      binaryPath: "hermes",
      model: undefined,
      provider: undefined,
      maxTurns: 12,
      yolo: false,
      cliTimeoutMs: 300_000,
    });
  });

  it("has expected manifest identity", () => {
    expect(plugin.manifest.id).toBe("fusion-plugin-hermes-runtime");
    expect(plugin.manifest.name).toBe("Hermes Runtime Plugin");
    expect(plugin.state).toBe("installed");
  });

  it("registers runtime metadata and exports matching constants", () => {
    expect(HERMES_RUNTIME_ID).toBe("hermes");
    expect(plugin.runtime?.metadata.runtimeId).toBe("hermes");
    expect(plugin.runtime?.metadata.name).toBe("Hermes Runtime");
    expect(plugin.runtime?.metadata.description).toContain("hermes");
    expect(plugin.manifest.runtime).toEqual(hermesRuntimeMetadata);
  });

  it("onLoad logs selected binary path & model and emits loaded event", async () => {
    mockResolveCli.mockReturnValue({
      binaryPath: "/opt/homebrew/bin/hermes",
      model: "claude-sonnet-4-5",
      provider: "anthropic",
      maxTurns: 12,
      yolo: false,
      cliTimeoutMs: 300_000,
    });
    const ctx = createMockContext({ binaryPath: "/opt/homebrew/bin/hermes" });
    await plugin.hooks!.onLoad!(ctx as any);
    expect(mockResolveCli).toHaveBeenCalledWith(ctx.settings);
    expect(ctx.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("/opt/homebrew/bin/hermes"),
    );
    expect(ctx.emitEvent).toHaveBeenCalledWith("hermes-runtime:loaded", {
      runtimeId: "hermes",
      version: plugin.manifest.version,
    });
  });

  it("factory returns a HermesRuntimeAdapter", async () => {
    const ctx = createMockContext({ binaryPath: "hermes" });
    const runtime = (await hermesRuntimeFactory(ctx as any)) as HermesRuntimeAdapter;
    expect(runtime).toBeInstanceOf(HermesRuntimeAdapter);
    expect(runtime.id).toBe("hermes");
  });
});
