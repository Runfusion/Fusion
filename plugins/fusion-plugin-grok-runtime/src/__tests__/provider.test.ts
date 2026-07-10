import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../probe.js", () => ({ probeGrokBinary: vi.fn() }));
vi.mock("../process-manager.js", () => ({ discoverGrokModels: vi.fn() }));

import { discoverGrokModels } from "../process-manager.js";
import { probeGrokBinary } from "../probe.js";
import { discoverGrokProviderModels } from "../provider.js";

describe("discoverGrokProviderModels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the override-aware probe binary for model discovery", async () => {
    vi.mocked(probeGrokBinary).mockResolvedValue({
      available: true,
      authenticated: true,
      binaryName: "/usr/local/bin/grok",
      binaryPath: "/usr/local/bin/grok",
      configuredBinaryPath: "/usr/local/bin/grok",
      usingConfiguredBinaryPath: true,
      probeDurationMs: 12,
    });
    vi.mocked(discoverGrokModels).mockResolvedValue({
      models: ["grok-4"],
      source: "models-text",
      fallbackUsed: false,
    });

    const result = await discoverGrokProviderModels({ binaryPath: "/usr/local/bin/grok" });

    expect(probeGrokBinary).toHaveBeenCalledWith({ binaryPath: "/usr/local/bin/grok" });
    expect(discoverGrokModels).toHaveBeenCalledWith("/usr/local/bin/grok");
    expect(result.models).toEqual([{ id: "grok-4", label: "grok-4" }]);
  });

  it("returns probe diagnostics when no effective binary is available", async () => {
    vi.mocked(probeGrokBinary).mockResolvedValue({
      available: false,
      authenticated: false,
      configuredBinaryPath: "/missing/grok",
      reason: "Configured Grok CLI binary '/missing/grok' failed; PATH fallback grok also failed",
      probeDurationMs: 10,
    });

    const result = await discoverGrokProviderModels({ binaryPath: "/missing/grok" });

    expect(discoverGrokModels).not.toHaveBeenCalled();
    expect(result).toEqual({
      models: [],
      source: "probe",
      fallbackUsed: true,
      reason: "Configured Grok CLI binary '/missing/grok' failed; PATH fallback grok also failed",
    });
  });
});
