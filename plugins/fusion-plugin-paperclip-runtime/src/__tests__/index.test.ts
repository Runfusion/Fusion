import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockProbePaperclipInstance, mockResolvePaperclipConfig, mockAdapterCtor, MockAdapter } = vi.hoisted(() => {
  const mockProbe = vi.fn();
  const mockResolve = vi.fn((settings?: Record<string, unknown>) => ({
    apiUrl: "http://localhost:3100",
    apiKey: undefined,
    agentId: undefined,
    companyId: undefined,
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
    mockProbePaperclipInstance: mockProbe,
    mockResolvePaperclipConfig: mockResolve,
    mockAdapterCtor: adapterCtor,
    MockAdapter: Adapter,
  };
});

vi.mock("../pi-module.js", () => ({
  probePaperclipInstance: mockProbePaperclipInstance,
  resolvePaperclipConfig: mockResolvePaperclipConfig,
}));

vi.mock("../runtime-adapter.js", () => ({
  PaperclipRuntimeAdapter: MockAdapter,
}));

import plugin from "../index.js";

describe("paperclip-runtime plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProbePaperclipInstance.mockResolvedValue({ ok: true, deploymentMode: "local_trusted" });
  });

  it("keeps manifest identity unchanged", () => {
    expect(plugin.manifest.id).toBe("fusion-plugin-paperclip-runtime");
    expect(plugin.manifest.runtime?.runtimeId).toBe("paperclip");
    expect(plugin.manifest.name).toBe("Paperclip Runtime Plugin");
    expect(plugin.runtime?.metadata.runtimeId).toBe("paperclip");
  });

  it("factory resolves settings and passes config/logger to adapter", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const ctx = {
      settings: {
        apiUrl: "http://paperclip.example",
        apiKey: "secret",
        agentId: "AG-1",
        companyId: "CO-1",
      },
      logger,
    };

    await plugin.runtime!.factory(ctx as any);

    expect(mockResolvePaperclipConfig).toHaveBeenCalledWith(ctx.settings);
    expect(mockAdapterCtor).toHaveBeenCalledWith(
      {
        apiUrl: "http://paperclip.example",
        apiKey: "secret",
        agentId: "AG-1",
        companyId: "CO-1",
      },
      logger,
    );
  });

  it("onLoad probes Paperclip and logs success without leaking apiKey", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const ctx = {
      settings: {
        apiUrl: "http://paperclip.example",
        apiKey: "super-secret",
      },
      logger,
    };

    await plugin.hooks.onLoad!(ctx as any);

    expect(mockProbePaperclipInstance).toHaveBeenCalledWith("http://paperclip.example", "super-secret");
    expect(logger.info).toHaveBeenCalledWith(
      "Paperclip Runtime Plugin loaded (apiUrl=http://paperclip.example)",
    );
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain("super-secret");
  });

  it("onLoad logs warning when probe fails", async () => {
    mockProbePaperclipInstance.mockResolvedValue({ ok: false, error: "ECONNREFUSED" });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    await plugin.hooks.onLoad!({ settings: {}, logger } as any);

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("probe failed"));
  });
});
