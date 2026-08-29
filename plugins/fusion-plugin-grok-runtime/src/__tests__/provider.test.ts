import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../probe.js", () => ({ probeGrokBinary: vi.fn() }));
vi.mock("../process-manager.js", () => ({ discoverGrokModels: vi.fn() }));

import { discoverGrokModels } from "../process-manager.js";
import { probeGrokBinary } from "../probe.js";
import { discoverGrokProviderModels } from "../provider.js";
import { createEventBridge } from "../acp/event-bridge.js";

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

/*
FNXC:ChatStreaming 2026-08-19-13:52:
The Grok ACP bridge normalizes before callbacks append output, preserving numeric model versions and URL path segments in both Chat text and independent thinking streams.
*/
describe("Grok ACP stream numeric token preservation", () => {
  it("keeps dotted source links and thinking versions intact", () => {
    const onText = vi.fn<(text: string) => void>();
    const onThinking = vi.fn<(text: string) => void>();
    const bridge = createEventBridge({ onText, onThinking });
    for (const text of [
      "[GPT‑5.",
      "6 Luna](https://developers.openai.com/api/docs/models/gpt-5.",
      "6-luna) [GPT‑5.",
      "6 Sol](https://developers.openai.com/api/docs/models/gpt-5.",
      "6-sol) [GPT‑5.",
      "6 Terra](https://developers.openai.com/api/docs/models/gpt-5.",
      "6-terra)",
    ]) {
      bridge.handleSessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } } as any);
    }
    bridge.handleSessionUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Version 5." } } as any);
    bridge.handleSessionUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "6" } } as any);

    const output = onText.mock.calls.map(([text]) => text).join("");
    expect(output).not.toContain("5. 6");
    expect(output).toContain("GPT‑5.6 Luna");
    expect(output).toContain("/gpt-5.6-luna");
    expect(output).toContain("/gpt-5.6-sol");
    expect(output).toContain("/gpt-5.6-terra");
    expect(onThinking.mock.calls.map(([text]) => text).join("")).toBe("Version 5.6");
  });
});
