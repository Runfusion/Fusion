import { describe, expect, it, vi } from "vitest";
import plugin, { AGENT_BROWSER_SETTINGS_SCHEMA } from "../index.js";
import manifestJson from "../../manifest.json";

const { probeMock } = vi.hoisted(() => ({
  probeMock: vi.fn(async () => ({ available: false, reason: "`agent-browser` not found on PATH" } as { available: boolean; reason?: string; version?: string })),
}));

vi.mock("../probe.js", () => ({
  probeAgentBrowserBinary: probeMock,
}));

describe("agent-browser plugin index", () => {
  it("exports canonical plugin id and manifest metadata", () => {
    expect(plugin.manifest.id).toBe("fusion-plugin-agent-browser");
    expect(manifestJson.id).toBe("fusion-plugin-agent-browser");
    expect(plugin.manifest.setup?.binaryName).toBe("agent-browser");
  });

  it("emits load event on successful probe", async () => {
    probeMock.mockResolvedValueOnce({ available: true, version: "1.0.0" });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const emitEvent = vi.fn();
    await plugin.hooks.onLoad?.({
      pluginId: plugin.manifest.id,
      taskStore: {} as never,
      settings: { promptExecutorSystem: "Use browser evidence" },
      logger,
      emitEvent,
    });
    expect(emitEvent).toHaveBeenCalledWith("agent-browser:loaded", expect.objectContaining({ available: true, version: "1.0.0" }));
    expect(plugin.promptContributions?.contributions.some((p) => p.content.includes("Use browser evidence"))).toBe(true);
  });

  it("emits unavailable payload when probe throws", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const emitEvent = vi.fn();
    probeMock.mockRejectedValueOnce(new Error("boom"));
    await plugin.hooks.onLoad?.({
      pluginId: plugin.manifest.id,
      taskStore: {} as never,
      settings: {},
      logger,
      emitEvent,
    });
    expect(logger.error).toHaveBeenCalled();
    expect(emitEvent).toHaveBeenCalledWith("agent-browser:loaded", expect.objectContaining({ available: false, error: "boom" }));
  });

  it("has canonical settings keys", () => {
    expect(Object.keys(AGENT_BROWSER_SETTINGS_SCHEMA)).toEqual([
      "enabled",
      "installChannel",
      "commandTimeoutMs",
      "headlessMode",
      "allowedDomains",
      "promptExecutorSystem",
      "promptExecutorTask",
      "promptTriage",
      "promptReviewer",
      "promptHeartbeat",
      "skillExposure",
    ]);
    expect(AGENT_BROWSER_SETTINGS_SCHEMA.installChannel?.defaultValue).toBe("stable");
  });
});
