import { describe, expect, it, vi } from "vitest";
import { ResearchStepRunner } from "../research/research-step-runner.js";
import { LLMSynthesisProvider } from "../research/providers/llm-synthesis-provider.js";
import { ResearchProviderError } from "../research/types.js";

describe("ResearchStepRunner", () => {
  it("returns provider_not_configured when provider missing", async () => {
    const runner = new ResearchStepRunner();
    const result = await runner.runSourceQuery("hello", "web");
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("provider_not_configured");
  });

  it("classifies timeout errors", async () => {
    const provider = {
      type: "web",
      isConfigured: () => true,
      search: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return [];
      },
      fetchContent: async () => ({ content: "", metadata: {} }),
    };

    const runner = new ResearchStepRunner({ providers: [provider] });
    const result = await runner.runSourceQuery("q", "web", { timeoutMs: 1 });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("timeout");
  });

  it.each([
    ["missing-configuration", "configuration", "MISSING_CREDENTIALS", false],
    ["auth-failed", "provider_denied", "PROVIDER_DENIED", false],
    ["rate-limited", "retryable_transient", "RATE_LIMITED", true],
    ["network-error", "retryable_transient", "PROVIDER_UNAVAILABLE", true],
    ["malformed-response", "malformed_response", "MALFORMED_RESPONSE", false],
  ] as const)("normalizes %s without exposing provider detail", async (code, failureClass, errorCode, retryable) => {
    const secret = "super-secret-token";
    const provider = {
      type: "web-search" as const,
      isConfigured: () => true,
      search: async () => {
        throw new ResearchProviderError({ providerType: "web-search", code, message: `raw body ${secret}`, retryable });
      },
      fetchContent: async () => ({ content: "", metadata: {} }),
    };

    const runner = new ResearchStepRunner({ providers: [provider] });
    const result = await runner.runSourceQuery("q", "web-search");
    expect(result).toMatchObject({ ok: false, error: { failureClass, errorCode, retryable, providerType: "web-search" } });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.error?.remediation).toBeTruthy();
  });

  it("sanitizes unknown provider errors as internal failures", async () => {
    const provider = {
      type: "web",
      isConfigured: () => true,
      search: async () => { throw new Error("raw secret=do-not-return"); },
      fetchContent: async () => ({ content: "", metadata: {} }),
    };
    const result = await new ResearchStepRunner({ providers: [provider] }).runSourceQuery("q", "web");
    expect(result.error).toMatchObject({ failureClass: "internal", errorCode: "INTERNAL_ERROR", retryable: false });
    expect(JSON.stringify(result)).not.toContain("do-not-return");
  });

  it("propagates abort signals", async () => {
    const provider = {
      type: "web",
      isConfigured: () => true,
      search: async (_query: string, _options: unknown, signal?: AbortSignal) => {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 50);
          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted by user"));
          });
        });
        return [];
      },
      fetchContent: async () => ({ content: "", metadata: {} }),
    };

    const runner = new ResearchStepRunner({ providers: [provider] });
    const ac = new AbortController();
    const promise = runner.runSourceQuery("q", "web", { timeoutMs: 3000 }, ac.signal);
    ac.abort();

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("aborted");
  });

  it("returns provider_not_configured for content fetch without configured providers", async () => {
    const runner = new ResearchStepRunner();
    const result = await runner.runContentFetch("https://example.com");
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("provider_not_configured");
  });

  it("prefers requested provider for content fetch and falls back when unavailable", async () => {
    const fetchPrimary = vi.fn(async () => ({ content: "primary", metadata: { provider: "primary" } }));
    const fetchFallback = vi.fn(async () => ({ content: "fallback", metadata: { provider: "fallback" } }));

    const runner = new ResearchStepRunner({
      providers: [
        {
          type: "primary",
          isConfigured: () => true,
          search: async () => [],
          fetchContent: fetchPrimary,
        },
        {
          type: "fallback",
          isConfigured: () => true,
          search: async () => [],
          fetchContent: fetchFallback,
        },
      ],
    });

    const requested = await runner.runContentFetch("https://example.com", "fallback");
    expect(requested.ok).toBe(true);
    expect(requested.data?.metadata.provider).toBe("fallback");

    const missing = await runner.runContentFetch("https://example.com", "missing");
    expect(missing.ok).toBe(true);
    expect(missing.data?.metadata.provider).toBe("primary");
    expect(fetchPrimary).toHaveBeenCalledTimes(1);
    expect(fetchFallback).toHaveBeenCalledTimes(1);
  });

  it("returns provider_not_configured for synthesis when no runner configured", async () => {
    const runner = new ResearchStepRunner();
    const result = await runner.runSynthesis({ query: "q", sources: [], round: 1 });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("provider_not_configured");
  });

  it("classifies synthesis timeout", async () => {
    const runner = new ResearchStepRunner({
      synthesisRunner: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { output: "done", citations: [] };
      },
    });

    const result = await runner.runSynthesis(
      { query: "q", sources: [], round: 1 },
      { timeoutMs: 1 },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: "timeout", failureClass: "timed_out", errorCode: "PROVIDER_TIMEOUT", retryable: true });
  });

  it("classifies malformed production synthesis responses", async () => {
    const session = {
      state: { messages: [{ role: "assistant", content: "not valid synthesis JSON" }] },
      dispose: vi.fn(),
    };
    const provider = new LLMSynthesisProvider({
      projectRoot: process.cwd(),
      createAgent: vi.fn(async () => ({ session })) as never,
      prompt: vi.fn(async () => undefined) as never,
    });

    await expect(provider.synthesize(
      { query: "q", sources: [], round: 1 },
      { provider: "mock", modelId: "scripted" },
    )).rejects.toMatchObject({ code: "malformed-response", retryable: false, message: "The synthesis provider returned an invalid response." });
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it.each([
    ["Missing API key opaque-secret-123456", "missing-configuration"],
    ["403 forbidden: model access denied opaque-secret-123456", "auth-failed"],
    ["You do not have access to model opaque-secret-123456", "auth-failed"],
    ["429 rate limit exceeded opaque-secret-123456", "rate-limited"],
  ] as const)("sanitizes production synthesis runtime failures as %s", async (message, code) => {
    const provider = new LLMSynthesisProvider({
      projectRoot: process.cwd(),
      createAgent: vi.fn(async () => { throw new Error(message); }) as never,
      prompt: vi.fn(async () => undefined) as never,
    });

    let caught: unknown;
    try {
      await provider.synthesize({ query: "q", sources: [], round: 1 }, { provider: "mock", modelId: "scripted" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code, providerType: "llm-synthesis" });
    expect(JSON.stringify(caught)).not.toContain("opaque-secret-123456");
  });

  it("accepts a valid production synthesis response unchanged", async () => {
    const output = JSON.stringify({
      summary: "answer",
      findings: [{ statement: "finding", citations: ["[1]"] }],
      confidence: 0.8,
      followUps: [],
    });
    const session = {
      state: { messages: [{ role: "assistant", content: output }] },
      dispose: vi.fn(),
    };
    const provider = new LLMSynthesisProvider({
      projectRoot: process.cwd(),
      createAgent: vi.fn(async () => ({ session })) as never,
      prompt: vi.fn(async () => undefined) as never,
    });

    await expect(provider.synthesize(
      { query: "q", sources: [{ id: "S-1", type: "web", reference: "https://example.test", status: "completed" }], round: 1 },
      { provider: "mock", modelId: "scripted" },
    )).resolves.toMatchObject({ output, citations: ["https://example.test"], confidence: 0.8 });
  });

  it("leaves successful synthesis unchanged", async () => {
    const runner = new ResearchStepRunner({ synthesisRunner: async () => ({ output: "answer", citations: ["source"] }) });
    await expect(runner.runSynthesis({ query: "q", sources: [], round: 1 })).resolves.toEqual({
      ok: true,
      data: { output: "answer", citations: ["source"] },
    });
  });
});
