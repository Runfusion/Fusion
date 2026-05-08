import { describe, expect, it, vi } from "vitest";
import { generateReply } from "../reply.js";

function makeCtx(overrides: Record<string, unknown> = {}) {
  const prompt = vi.fn();
  const createAiSession = vi.fn().mockResolvedValue({
    session: {
      prompt,
      state: { messages: [{ role: "assistant", content: "hello back" }] },
    },
  });

  return {
    settings: {},
    taskStore: { getRootDir: () => "/repo" },
    createAiSession,
    ...overrides,
  } as any;
}

describe("generateReply", () => {
  it("creates ai session with readonly tools and cwd root", async () => {
    const ctx = makeCtx();
    await expect(generateReply(ctx, "1555", "hi", [])).resolves.toBe("hello back");
    expect(ctx.createAiSession).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/repo", tools: "readonly" }));
  });

  it("uses system prompt override and transcript continuity", async () => {
    const prompt = vi.fn();
    const ctx = makeCtx({
      settings: { agentSystemPrompt: "custom prompt" },
      createAiSession: vi.fn().mockResolvedValue({ session: { prompt, state: { messages: [{ role: "assistant", content: "ok" }] } } }),
    });

    await generateReply(ctx, "1555", "new", [{ role: "user", text: "old", createdAt: "t" }]);
    expect(ctx.createAiSession).toHaveBeenCalledWith(expect.objectContaining({ systemPrompt: "custom prompt" }));
    expect(prompt.mock.calls[0][0]).toContain("User: old");
    expect(prompt.mock.calls[0][0]).toContain("User: new");
  });

  it("throws on empty assistant content", async () => {
    const ctx = makeCtx({
      createAiSession: vi.fn().mockResolvedValue({ session: { prompt: vi.fn(), state: { messages: [{ role: "assistant", content: "   " }] } } }),
    });
    await expect(generateReply(ctx, "1555", "hi", [])).rejects.toThrow("no assistant text");
  });

  it("throws when createAiSession missing", async () => {
    const ctx = makeCtx({ createAiSession: undefined });
    await expect(generateReply(ctx, "1555", "hi", [])).rejects.toThrow("AI session factory unavailable");
  });
});
