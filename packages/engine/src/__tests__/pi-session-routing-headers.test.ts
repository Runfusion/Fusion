import { describe, it, expect } from "vitest";
import type { AuthResult } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { attachSessionRoutingHeaders, buildSessionRoutingHeaders } from "../pi.js";

// FNXC:SessionRouting 2026-06-23-16:40:
// Issue #1675: chat completion requests must carry X-Session-Id and
// X-Session-Affinity so LLM gateways can sticky-route and observability tools
// can group the stateless API calls of one conversation into a single trace.
//
// FNXC:SessionRouting 2026-07-16-19:05:
// FN-8142 (pi 0.80.8+) moved the routing-header seam off ModelRegistry.getApiKeyAndHeaders
// onto ModelRuntime.getAuth. The invariant is unchanged: the resolved auth's headers must
// carry the routing pair, provider-specific headers/apiKey must survive, failed/absent
// resolutions must pass through untouched, and a missing getAuth must not break session creation.

describe("buildSessionRoutingHeaders", () => {
  it("emits X-Session-Id and X-Session-Affinity with the same identifier", () => {
    expect(buildSessionRoutingHeaders("sess-123")).toEqual({
      "X-Session-Id": "sess-123",
      "X-Session-Affinity": "sess-123",
    });
  });
});

describe("attachSessionRoutingHeaders", () => {
  // Minimal stand-in for the bits of ModelRuntime the wrapper touches.
  function makeRuntime(
    resolve: (model: unknown) => Promise<AuthResult | undefined>,
  ): ModelRuntime {
    return { getAuth: resolve } as unknown as ModelRuntime;
  }

  const anyModel = { provider: "anthropic", id: "claude" } as never;

  it("merges the routing headers into resolved request headers", async () => {
    const runtime = makeRuntime(async () => ({ auth: { apiKey: "sk-live" } }));
    attachSessionRoutingHeaders(runtime, "sess-abc");

    const result = await runtime.getAuth(anyModel);

    expect(result).toEqual({
      auth: {
        apiKey: "sk-live",
        headers: {
          "X-Session-Id": "sess-abc",
          "X-Session-Affinity": "sess-abc",
        },
      },
    });
  });

  it("preserves the resolved apiKey and any provider-specific headers", async () => {
    const runtime = makeRuntime(async () => ({
      auth: {
        apiKey: "sk-custom",
        headers: { "HTTP-Referer": "https://example.com", "X-Title": "Fusion" },
      },
    }));
    attachSessionRoutingHeaders(runtime, "sess-xyz");

    const result = await runtime.getAuth(anyModel);

    if (!result) throw new Error("expected an auth result");
    expect(result.auth.apiKey).toBe("sk-custom");
    expect(result.auth.headers).toEqual({
      "HTTP-Referer": "https://example.com",
      "X-Title": "Fusion",
      "X-Session-Id": "sess-xyz",
      "X-Session-Affinity": "sess-xyz",
    });
  });

  it("does not alter failed (undefined) auth resolutions", async () => {
    const runtime = makeRuntime(async () => undefined);
    attachSessionRoutingHeaders(runtime, "sess-fail");

    const result = await runtime.getAuth(anyModel);

    expect(result).toBeUndefined();
  });

  it("no-ops without throwing when getAuth is absent", () => {
    // If a future pi-coding-agent rename removes the method, the wrapper must not
    // break session creation. It leaves the runtime untouched and warns instead.
    const runtime = {} as ModelRuntime;

    expect(() => attachSessionRoutingHeaders(runtime, "sess-none")).not.toThrow();
    expect((runtime as unknown as Record<string, unknown>).getAuth).toBeUndefined();
  });
});
