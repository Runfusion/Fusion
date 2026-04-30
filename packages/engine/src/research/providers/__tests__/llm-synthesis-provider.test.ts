import { beforeEach, describe, expect, it, vi } from "vitest";

const { createFnAgentMock, promptWithFallbackMock, disposeMock } = vi.hoisted(() => ({
  disposeMock: vi.fn(),
  createFnAgentMock: vi.fn(),
  promptWithFallbackMock: vi.fn(),
}));

vi.mock("../../../pi.js", () => ({
  createFnAgent: createFnAgentMock,
  promptWithFallback: promptWithFallbackMock,
}));

import { LLMSynthesisProvider, buildSynthesisPrompt, extractCitations } from "../llm-synthesis-provider.js";

describe("LLMSynthesisProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const session = { state: { messages: [] as Array<{ role: string; content: string }> }, dispose: disposeMock };
    createFnAgentMock.mockResolvedValue({ session });
    promptWithFallbackMock.mockImplementation(async (s: typeof session, _prompt: string) => {
      s.state.messages.push({ role: "assistant", content: '```json\n{"summary":"ok","confidence":0.8}\n```\n[1]' });
    });
  });

  it("builds synthesis output with citations", async () => {
    const provider = new LLMSynthesisProvider({ projectRoot: "/tmp" });
    const result = await provider.synthesize(
      {
        query: "q",
        round: 1,
        sources: [{ id: "1", type: "web", reference: "https://a", status: "completed", title: "A", content: "hello" }],
      },
      { provider: "openai", modelId: "gpt-5" },
    );

    expect(promptWithFallbackMock).toHaveBeenCalled();
    expect(result.citations).toEqual(["https://a"]);
    expect(result.confidence).toBe(0.8);
    expect(disposeMock).toHaveBeenCalled();
  });

  it("includes query and sources in prompt", () => {
    const prompt = buildSynthesisPrompt(
      { query: "query", round: 2, sources: [{ id: "s", type: "web", reference: "https://x", status: "completed", title: "Title", content: "Body" }] },
      [{ id: "s", type: "web", reference: "https://x", status: "completed", title: "Title", content: "Body" }],
    );
    expect(prompt).toContain("Query: query");
    expect(prompt).toContain("Reference: https://x");
    expect(prompt).toContain("Return valid JSON");
  });

  it("extracts citations by index", () => {
    const citations = extractCitations("Findings [1] and [2]", [
      { id: "1", type: "web", reference: "a", status: "completed" },
      { id: "2", type: "web", reference: "b", status: "completed" },
    ]);
    expect(citations).toEqual(["a", "b"]);
  });

  it("maps abort and timeout", async () => {
    const provider = new LLMSynthesisProvider({ projectRoot: "/tmp", timeoutMs: 20 });
    promptWithFallbackMock.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    await expect(
      provider.synthesize({ query: "q", round: 1, sources: [] }, { provider: "openai", modelId: "gpt-4o" }),
    ).rejects.toMatchObject({ code: "timeout" });

    promptWithFallbackMock.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    const controller = new AbortController();
    const pending = provider.synthesize({ query: "q", round: 1, sources: [] }, { provider: "openai", modelId: "gpt-4o" }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "abort" });
  });

  it("reports provider availability", () => {
    const provider = new LLMSynthesisProvider({ projectRoot: "/tmp" });
    expect(provider.isConfigured()).toBe(true);
  });

  it("truncates sources to character budget", async () => {
    const provider = new LLMSynthesisProvider({ projectRoot: "/tmp" });
    const manySources = Array.from({ length: 30 }, (_, i) => ({
      id: String(i),
      type: "web" as const,
      reference: `https://src/${i}`,
      status: "completed" as const,
      content: "x".repeat(8000),
      metadata: { confidence: i },
    }));

    await provider.synthesize({ query: "q", round: 1, sources: manySources }, { provider: "openai", modelId: "small-model" });
    const promptArg = promptWithFallbackMock.mock.calls[0]?.[1] as string;
    expect(promptArg.length).toBeLessThan(35_000);
  });

  it("maps model failures", async () => {
    const provider = new LLMSynthesisProvider({ projectRoot: "/tmp" });
    promptWithFallbackMock.mockRejectedValueOnce(new Error("model down"));
    await expect(provider.synthesize({ query: "q", round: 1, sources: [] }, { provider: "openai", modelId: "gpt-4o" })).rejects.toMatchObject({
      code: "provider-unavailable",
    });
  });
});
