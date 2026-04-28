import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockResolveCliConfig, mockProbeBinary } = vi.hoisted(() => ({
  mockResolveCliConfig: vi.fn().mockReturnValue({
    binaryPath: "openclaw",
    agentId: "main",
    model: undefined,
    thinking: "off",
    cliTimeoutSec: 0,
    cliTimeoutMs: 300_000,
    useGateway: false,
  }),
  mockProbeBinary: vi.fn().mockResolvedValue({
    available: true,
    binaryPath: "/opt/homebrew/bin/openclaw",
    version: "OpenClaw 2026.4.26",
    probeDurationMs: 12,
  }),
}));

vi.mock("../pi-module.js", async () => {
  const actual = await vi.importActual<typeof import("../pi-module.js")>(
    "../pi-module.js",
  );
  return {
    ...actual,
    resolveCliConfig: mockResolveCliConfig,
  };
});

vi.mock("../probe.js", async () => {
  const actual = await vi.importActual<typeof import("../probe.js")>(
    "../probe.js",
  );
  return {
    ...actual,
    probeOpenClawBinary: mockProbeBinary,
  };
});

import plugin, {
  openclawRuntimeMetadata,
  openclawRuntimeFactory,
  OPENCLAW_RUNTIME_ID,
} from "../index.js";
import { OpenClawRuntimeAdapter } from "../runtime-adapter.js";

interface MockLogger {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
}

function createMockContext(settings: Record<string, unknown> = {}) {
  const logger: MockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return {
    pluginId: "fusion-plugin-openclaw-runtime",
    settings,
    logger,
    emitEvent: vi.fn(),
    taskStore: { getTask: vi.fn() },
  };
}

describe("openclaw-runtime plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveCliConfig.mockReturnValue({
      binaryPath: "openclaw",
      agentId: "main",
      model: undefined,
      thinking: "off",
      cliTimeoutSec: 0,
      cliTimeoutMs: 300_000,
      useGateway: false,
    });
    mockProbeBinary.mockResolvedValue({
      available: true,
      binaryPath: "/opt/homebrew/bin/openclaw",
      version: "OpenClaw 2026.4.26",
      probeDurationMs: 12,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("manifest identity is stable", () => {
    expect(plugin.manifest.id).toBe("fusion-plugin-openclaw-runtime");
    expect(plugin.manifest.name).toBe("OpenClaw Runtime Plugin");
    expect(plugin.state).toBe("installed");
    expect(plugin.runtime?.metadata.runtimeId).toBe(OPENCLAW_RUNTIME_ID);
    expect(plugin.manifest.runtime).toEqual(openclawRuntimeMetadata);
  });

  it("onLoad probes binary and logs binary path + version", async () => {
    const ctx = createMockContext({});
    await plugin.hooks!.onLoad!(ctx as any);
    expect(mockProbeBinary).toHaveBeenCalledWith({ binaryPath: "openclaw" });
    expect(ctx.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("openclaw"),
    );
    expect(ctx.emitEvent).toHaveBeenCalledWith(
      "openclaw-runtime:loaded",
      expect.objectContaining({
        runtimeId: OPENCLAW_RUNTIME_ID,
        binaryAvailable: true,
      }),
    );
  });

  it("onLoad logs warning when binary missing", async () => {
    mockProbeBinary.mockResolvedValueOnce({
      available: false,
      probeDurationMs: 5,
      reason: "`openclaw` not found on PATH",
    });
    const ctx = createMockContext({});
    await plugin.hooks!.onLoad!(ctx as any);
    expect(ctx.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("not detected"),
    );
  });

  it("factory returns an OpenClawRuntimeAdapter instance", async () => {
    const runtime = (await openclawRuntimeFactory(
      createMockContext({ binaryPath: "/usr/bin/openclaw", agentId: "ops" }) as any,
    )) as OpenClawRuntimeAdapter;
    expect(runtime).toBeInstanceOf(OpenClawRuntimeAdapter);
    expect(runtime.id).toBe("openclaw");
  });

  it("factory creation does not throw with empty settings", async () => {
    await expect(
      openclawRuntimeFactory(createMockContext() as any),
    ).resolves.toBeInstanceOf(OpenClawRuntimeAdapter);
  });

  it("onUnload does not throw", () => {
    expect(() => plugin.hooks!.onUnload?.()).not.toThrow();
  });
});
