import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  mockProbe,
  mockResolve,
  mockAdapterCtor,
  MockAdapter,
} = vi.hoisted(() => {
  const probe = vi.fn();
  const resolve = vi.fn((settings?: Record<string, unknown>) => ({
    apiUrl: "http://localhost:3100",
    apiKey: undefined as string | undefined,
    agentId: undefined as string | undefined,
    companyId: undefined as string | undefined,
    mode: "rolling-issue" as const,
    runTimeoutMs: 600_000,
    pollIntervalMs: 500,
    pollIntervalMaxMs: 2_000,
    ...(settings ?? {}),
  }));
  const adapterCtor = vi.fn();
  class Adapter {
    readonly id = "paperclip";
    readonly name = "Paperclip Runtime";
    constructor(...args: unknown[]) {
      adapterCtor(...args);
    }
  }
  return {
    mockProbe: probe,
    mockResolve: resolve,
    mockAdapterCtor: adapterCtor,
    MockAdapter: Adapter,
  };
});

vi.mock("../paperclip-client.js", () => ({
  probePaperclipConnection: mockProbe,
  resolvePaperclipConfig: mockResolve,
  // Re-exported by the plugin module — unused inside tests but must resolve.
  listCompanyAgents: vi.fn(),
}));

vi.mock("../runtime-adapter.js", () => ({
  PaperclipRuntimeAdapter: MockAdapter,
}));

import plugin from "../index.js";

describe("paperclip-runtime plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProbe.mockResolvedValue({
      available: true,
      apiUrl: "http://localhost:3100",
      probeDurationMs: 5,
      identity: {
        agentId: "AG-1",
        agentName: "Coder",
        role: "engineer",
        companyId: "CO-1",
        companyName: "Acme",
      },
    });
  });

  it("manifest identity stays stable", () => {
    expect(plugin.manifest.id).toBe("fusion-plugin-paperclip-runtime");
    expect(plugin.manifest.runtime?.runtimeId).toBe("paperclip");
    expect(plugin.runtime?.metadata.runtimeId).toBe("paperclip");
  });

  it("factory passes resolved config + logger to adapter ctor", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const ctx = {
      settings: {
        apiUrl: "http://paperclip.example",
        apiKey: "secret",
        agentId: "AG-X",
      },
      logger,
    };
    await plugin.runtime!.factory(ctx as any);
    expect(mockResolve).toHaveBeenCalledWith(ctx.settings);
    expect(mockAdapterCtor).toHaveBeenCalledTimes(1);
    expect(mockAdapterCtor.mock.calls[0][1]).toBe(logger);
  });

  it("onLoad probes and logs success without leaking apiKey", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const ctx = {
      settings: { apiUrl: "http://paperclip.example", apiKey: "super-secret" },
      logger,
    };
    await plugin.hooks!.onLoad!(ctx as any);
    expect(mockProbe).toHaveBeenCalledWith({
      apiUrl: "http://paperclip.example",
      apiKey: "super-secret",
    });
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain("super-secret");
  });

  it("onLoad warns when probe is unavailable", async () => {
    mockProbe.mockResolvedValue({
      available: false,
      apiUrl: "http://localhost:3100",
      probeDurationMs: 1,
      reason: "ECONNREFUSED",
    });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await plugin.hooks!.onLoad!({ settings: {}, logger } as any);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("probe failed"));
  });
});
