import { describe, expect, it, vi } from "vitest";
vi.mock("../probe.js", () => ({ probeClaudeBinary: vi.fn() }));
import { probeClaudeBinary } from "../probe.js";
import { discoverClaudeProviderModels } from "../provider.js";
describe("discoverClaudeProviderModels", () => {
 it("returns qualified provider-safe Claude ids when bridge is available", async () => { vi.mocked(probeClaudeBinary).mockResolvedValue({ available:true, probeDurationMs:1 }); const result=await discoverClaudeProviderModels(); expect(result.models.map((m)=>m.id)).toContain("claude-sonnet-4-20250514"); expect(result.fallbackUsed).toBe(false); });
 it("degrades to empty fallback when the bridge is unavailable", async () => { vi.mocked(probeClaudeBinary).mockResolvedValue({ available:false, reason:"missing", probeDurationMs:1 }); await expect(discoverClaudeProviderModels()).resolves.toMatchObject({models:[],fallbackUsed:true,reason:"missing"}); });
});
