import { describe, expect, it } from "vitest";
import { ResearchStepRunner } from "../research-step-runner.js";

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

  it("classifies provider errors", async () => {
    const provider = {
      type: "web",
      isConfigured: () => true,
      search: async () => {
        throw new Error("rate limit exceeded");
      },
      fetchContent: async () => ({ content: "", metadata: {} }),
    };

    const runner = new ResearchStepRunner({ providers: [provider] });
    const result = await runner.runSourceQuery("q", "web");
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("provider_error");
    expect(result.error?.message).toContain("rate limit exceeded");
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
    expect(result.error?.code).toBe("timeout");
  });
});
