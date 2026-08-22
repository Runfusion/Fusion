import { describe, expect, it, vi } from "vitest";
vi.mock("../probe.js", () => ({ probeClaudeBinary: vi.fn() }));
import { probeClaudeBinary } from "../probe.js";
import { discoverClaudeProviderModels } from "../provider.js";
import { createEventBridge } from "../acp/event-bridge.js";
describe("discoverClaudeProviderModels", () => {
 it("returns qualified provider-safe Claude ids when bridge is available", async () => { vi.mocked(probeClaudeBinary).mockResolvedValue({ available:true, probeDurationMs:1 }); const result=await discoverClaudeProviderModels(); expect(result.models.map((m)=>m.id)).toContain("claude-sonnet-4-20250514"); expect(result.fallbackUsed).toBe(false); });
 it("degrades to empty fallback when the bridge is unavailable", async () => { vi.mocked(probeClaudeBinary).mockResolvedValue({ available:false, reason:"missing", probeDurationMs:1 }); await expect(discoverClaudeProviderModels()).resolves.toMatchObject({models:[],fallbackUsed:true,reason:"missing"}); });
});

/*
FNXC:ChatStreaming 2026-08-19-13:52:
The Claude ACP bridge normalizes before callbacks append output, preserving numeric model versions and URL path segments in both Chat text and independent thinking streams.
*/
describe("Claude ACP stream numeric token preservation", () => {
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
