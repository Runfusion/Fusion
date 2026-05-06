import { describe, expect, it, vi } from "vitest";
import { checkSetup } from "../setup.js";
import type { PluginContext } from "@fusion/plugin-sdk";
import { probeAgentBrowserBinary } from "../probe.js";

vi.mock("../probe.js", () => ({
  probeAgentBrowserBinary: vi.fn(),
}));

const probeMock = vi.mocked(probeAgentBrowserBinary);

const ctx: PluginContext = {
  pluginId: "fusion-plugin-agent-browser",
  taskStore: {} as PluginContext["taskStore"],
  settings: {},
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  emitEvent: () => undefined,
};

describe("setup hooks", () => {
  it("returns not-installed when binary is missing", async () => {
    probeMock.mockResolvedValueOnce({ available: false, reason: "`agent-browser` not found on PATH", notFound: true });
    const result = await checkSetup(ctx);
    expect(result.status).toBe("not-installed");
  });

  it("returns installed when probe succeeds", async () => {
    probeMock.mockResolvedValueOnce({ available: true, version: "1.2.3", binaryPath: "/usr/bin/agent-browser" });
    const result = await checkSetup(ctx);
    expect(result.status).toBe("installed");
    expect(result.version).toBe("1.2.3");
  });

  it("returns error for non-not-found probe failures", async () => {
    probeMock.mockResolvedValueOnce({ available: false, reason: "Probe timed out after 1000ms" });
    const result = await checkSetup(ctx);
    expect(result.status).toBe("error");
  });
});
