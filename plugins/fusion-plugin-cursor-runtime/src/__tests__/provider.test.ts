import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../probe.js", () => ({ probeCursorBinary: vi.fn() }));
vi.mock("../process-manager.js", () => ({ discoverCursorModels: vi.fn() }));

import { discoverCursorModels } from "../process-manager.js";
import { probeCursorBinary } from "../probe.js";
import { discoverCursorProviderModels } from "../provider.js";

describe("discoverCursorProviderModels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the override-aware probe binary for model discovery", async () => {
    vi.mocked(probeCursorBinary).mockResolvedValue({
      available: true,
      authenticated: true,
      binaryName: "C:\\Users\\A User\\AppData\\Roaming\\npm\\cursor-agent.cmd",
      binaryPath: "C:\\Users\\A User\\AppData\\Roaming\\npm\\cursor-agent.cmd",
      configuredBinaryPath: "C:\\Users\\A User\\AppData\\Roaming\\npm\\cursor-agent.cmd",
      usingConfiguredBinaryPath: true,
      probeDurationMs: 12,
    });
    vi.mocked(discoverCursorModels).mockResolvedValue({
      models: ["cursor/a"],
      source: "models-json",
      fallbackUsed: false,
    });

    const result = await discoverCursorProviderModels({ binaryPath: "C:\\Users\\A User\\AppData\\Roaming\\npm\\cursor-agent.cmd" });

    expect(probeCursorBinary).toHaveBeenCalledWith({ binaryPath: "C:\\Users\\A User\\AppData\\Roaming\\npm\\cursor-agent.cmd" });
    expect(discoverCursorModels).toHaveBeenCalledWith("C:\\Users\\A User\\AppData\\Roaming\\npm\\cursor-agent.cmd");
    expect(result.models).toEqual([{ id: "cursor/a", label: "cursor/a" }]);
  });

  it("returns probe diagnostics when no effective binary is available", async () => {
    vi.mocked(probeCursorBinary).mockResolvedValue({
      available: false,
      authenticated: false,
      configuredBinaryPath: "/missing/cursor-agent",
      reason: "Configured Cursor CLI binary '/missing/cursor-agent' failed; PATH fallback cursor-agent/cursor also failed",
      probeDurationMs: 10,
    });

    const result = await discoverCursorProviderModels({ binaryPath: "/missing/cursor-agent" });

    expect(discoverCursorModels).not.toHaveBeenCalled();
    expect(result).toEqual({
      models: [],
      source: "probe",
      fallbackUsed: true,
      reason: "Configured Cursor CLI binary '/missing/cursor-agent' failed; PATH fallback cursor-agent/cursor also failed",
    });
  });

  it("carries reasoning/contextWindow metadata through when the discovery result reports it", async () => {
    vi.mocked(probeCursorBinary).mockResolvedValue({
      available: true,
      authenticated: true,
      binaryName: "cursor-agent",
      binaryPath: "cursor-agent",
      probeDurationMs: 5,
    });
    vi.mocked(discoverCursorModels).mockResolvedValue({
      models: ["cursor/a", "cursor/b"],
      source: "models-json",
      fallbackUsed: false,
      modelMeta: { "cursor/a": { reasoning: true, contextWindow: 200000 } },
    });

    const result = await discoverCursorProviderModels();

    expect(result.models).toEqual([
      { id: "cursor/a", label: "cursor/a", reasoning: true, contextWindow: 200000 },
      { id: "cursor/b", label: "cursor/b" },
    ]);
  });
});
