import { describe, expect, it } from "vitest";
import { GrokRuntimeAdapter } from "../runtime-adapter.js";

describe("GrokRuntimeAdapter", () => {
  it("creates a session with default model fallback", async () => {
    const adapter = new GrokRuntimeAdapter();
    const result = await adapter.createSession({ systemPrompt: "sys" });
    expect(result.session.model).toBe("grok/default");
    expect(result.session.systemPrompt).toBe("sys");
  });

  it("promptWithFallback resolves without throwing", async () => {
    const adapter = new GrokRuntimeAdapter();
    await expect(adapter.promptWithFallback()).resolves.toBeUndefined();
  });

  it("describeModel formats grok prefix", () => {
    const adapter = new GrokRuntimeAdapter();
    expect(adapter.describeModel({ model: "grok/pro" })).toBe("grok/grok/pro");
  });
});
