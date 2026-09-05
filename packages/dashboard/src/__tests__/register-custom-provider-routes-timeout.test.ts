/**
 * Custom-provider routes: per-model `timeoutSeconds` validation and persistence.
 *
 * Contract (mirrors the RUFU-123 contextWindow/maxTokens round-trip):
 *   - `timeoutSeconds` is an optional non-negative finite number (seconds);
 *   - `0` is VALID (it means "timeout disabled" for that model) — unlike the positive-only
 *     window fields it may be persisted as 0;
 *   - omitted values are persisted as absent (legacy entries round-trip byte-identical);
 *   - negative, non-finite, and non-numeric values are rejected with HTTP 400;
 *   - model refresh (manual or the startup auto-refresh of all providers) carries a
 *     persisted timeoutSeconds over by model id, including the 0 "disabled" sentinel
 *     (carry-over seam: mergeRefreshedCustomProviderModels).
 */
import { describe, expect, it, vi } from "vitest";
import type { Router } from "express";
import { ApiError } from "../api-error.js";
import { mergeRefreshedCustomProviderModels, registerCustomProviderRoutes } from "../routes/register-custom-provider-routes.js";

type Handler = (req: { body: unknown; params: Record<string, string> }, res: unknown) => Promise<void>;

function createRouteHarness(existingProviders: Array<Record<string, unknown>> = []) {
  const post = new Map<string, Handler>();
  const put = new Map<string, Handler>();
  const router = {
    // The registrar registers GET/DELETE/POST-probe routes too; only the POST/PUT handlers
    // under test are captured, the rest are no-ops.
    get: vi.fn(),
    delete: vi.fn(),
    post: vi.fn((path: string, handler: Handler) => {
      post.set(path, handler);
    }),
    put: vi.fn((path: string, handler: Handler) => {
      put.set(path, handler);
    }),
  } as unknown as Router;
  const getSettings = vi.fn().mockResolvedValue({ customProviders: existingProviders });
  const updateGlobalSettings = vi.fn().mockResolvedValue(undefined);
  const store = {
    getGlobalSettingsStore: vi.fn(() => ({ getSettings })),
    updateGlobalSettings,
  } as never;

  registerCustomProviderRoutes({
    router,
    store,
    rethrowAsApiError: (err: unknown) => {
      throw err;
    },
  } as never);

  return { post, put, updateGlobalSettings };
}

async function invokeCreate(handler: Handler, body: unknown): Promise<unknown> {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  };
  await handler({ body, params: {} }, res);
  return res.json.mock.calls[0]?.[0];
}

async function invokeUpdate(handler: Handler, id: string, body: unknown): Promise<unknown> {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  };
  await handler({ body, params: { id } }, res);
  return res.json.mock.calls[0]?.[0];
}

const baseProviderBody = {
  name: "Local LLM",
  apiType: "openai-compatible",
  baseUrl: "http://localhost:11434/v1",
};

describe("POST /api/custom-providers per-model timeoutSeconds", () => {
  it("persists timeoutSeconds: 0 (disabled) as 0", async () => {
    const { post, updateGlobalSettings } = createRouteHarness();
    const created = await invokeCreate(post.get("/custom-providers")!, {
      ...baseProviderBody,
      models: [{ id: "slow-buffered", name: "Slow Buffered", timeoutSeconds: 0 }],
    });

    expect((created as { models: Array<Record<string, unknown>> }).models[0].timeoutSeconds).toBe(0);
    const persisted = updateGlobalSettings.mock.calls[0][0] as { customProviders: Array<{ models: Array<Record<string, unknown>> }> };
    expect(persisted.customProviders[0].models[0].timeoutSeconds).toBe(0);
  });

  it("persists a positive timeoutSeconds unchanged", async () => {
    const { post, updateGlobalSettings } = createRouteHarness();
    await invokeCreate(post.get("/custom-providers")!, {
      ...baseProviderBody,
      models: [{ id: "fast", name: "Fast", timeoutSeconds: 1800 }],
    });

    const persisted = updateGlobalSettings.mock.calls[0][0] as { customProviders: Array<{ models: Array<Record<string, unknown>> }> };
    expect(persisted.customProviders[0].models[0].timeoutSeconds).toBe(1800);
  });

  it("persists omitted timeoutSeconds as absent (legacy round-trip unchanged)", async () => {
    const { post, updateGlobalSettings } = createRouteHarness();
    await invokeCreate(post.get("/custom-providers")!, {
      ...baseProviderBody,
      models: [{ id: "legacy", name: "Legacy", contextWindow: 32768, maxTokens: 4096 }],
    });

    const persisted = updateGlobalSettings.mock.calls[0][0] as { customProviders: Array<{ models: Array<Record<string, unknown>> }> };
    expect(persisted.customProviders[0].models[0].timeoutSeconds).toBeUndefined();
    expect("timeoutSeconds" in persisted.customProviders[0].models[0]).toBe(false);
  });

  it.each([
    ["negative", -5],
    ["non-finite", Number.POSITIVE_INFINITY],
    ["string", "300"],
    ["boolean", true],
  ] as const)("rejects %s timeoutSeconds with 400", async (_label, value) => {
    const { post } = createRouteHarness();
    await expect(
      invokeCreate(post.get("/custom-providers")!, {
        ...baseProviderBody,
        models: [{ id: "bad", name: "Bad", timeoutSeconds: value }],
      }),
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining("timeoutSeconds") });
  });
  it("rejects maxTokens >= contextWindow pairs with 400 (inconsistent output reservation)", async () => {
    const { post } = createRouteHarness();
    await expect(
      invokeCreate(post.get("/custom-providers")!, {
        ...baseProviderBody,
        models: [{ id: "bad", name: "Bad", contextWindow: 32768, maxTokens: 32768 }],
      }),
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining("maxTokens") });
  });
});

describe("PUT /api/custom-providers/:id per-model timeoutSeconds", () => {
  const existing = [{ id: "p1", name: "Local LLM", apiType: "openai-compatible", baseUrl: "http://localhost:11434/v1", models: [] }];

  it("persists timeoutSeconds: 0 (disabled) on update", async () => {
    const { put, updateGlobalSettings } = createRouteHarness(existing);
    // The PUT handler reads the existing list; p1 is seeded above.
    await invokeUpdate(put.get("/custom-providers/:id")!, "p1", {
      models: [{ id: "slow", name: "Slow", timeoutSeconds: 0 }],
    });

    const persisted = updateGlobalSettings.mock.calls.at(-1)?.[0] as { customProviders: Array<{ models: Array<Record<string, unknown>> }> };
    expect(persisted.customProviders.some((p) => p.models.some((m) => m.id === "slow" && m.timeoutSeconds === 0))).toBe(true);
  });

  it("rejects negative timeoutSeconds with 400 on update", async () => {
    const { put } = createRouteHarness(existing);
    await expect(
      invokeUpdate(put.get("/custom-providers/:id")!, "p1", {
        models: [{ id: "bad", name: "Bad", timeoutSeconds: -1 }],
      }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe("mergeRefreshedCustomProviderModels: refresh carry-over (all per-model fields)", () => {
  // FNXC:CustomProviderHttpTimeout 2026-08-24-23:35: regression surface for the timeout
  // feature missing the refresh carry-over — every refresh previously rebuilt the model
  // list from probe results (windows + thinking flags only) and dropped timeoutSeconds.

  it("carries a persisted positive timeoutSeconds across a refresh", () => {
    const merged = mergeRefreshedCustomProviderModels(
      [{ id: "qwen38", name: "Qwen 38B" }],
      [{ id: "qwen38", name: "Qwen 38B", timeoutSeconds: 3600 }],
    );
    expect(merged).toEqual([{ id: "qwen38", name: "Qwen 38B", timeoutSeconds: 3600 }]);
  });

  it("carries the timeoutSeconds: 0 (disabled) sentinel across a refresh", () => {
    const merged = mergeRefreshedCustomProviderModels(
      [{ id: "m1", name: "M1" }],
      [{ id: "m1", name: "M1", timeoutSeconds: 0 }],
    );
    expect(merged[0].timeoutSeconds).toBe(0);
  });

  it("carries the pre-existing windows/thinking invariants unchanged", () => {
    const merged = mergeRefreshedCustomProviderModels(
      [{ id: "m1", name: "M1" }],
      [{ id: "m1", name: "M1", contextWindow: 32768, maxTokens: 4096, thinkingFormat: "qwen", reasoning: false }],
    );
    expect(merged[0]).toMatchObject({ contextWindow: 32768, maxTokens: 4096, thinkingFormat: "qwen", reasoning: false });
  });

  it("probe-reported windows win over persisted values while timeoutSeconds still carries", () => {
    const merged = mergeRefreshedCustomProviderModels(
      [{ id: "m1", name: "M1", contextWindow: 65536 }],
      [{ id: "m1", name: "M1", contextWindow: 32768, timeoutSeconds: 600 }],
    );
    expect(merged[0].contextWindow).toBe(65536);
    expect(merged[0].timeoutSeconds).toBe(600);
  });

  it("drops models that no longer exist (list replacement semantics)", () => {
    const merged = mergeRefreshedCustomProviderModels(
      [{ id: "kept", name: "Kept" }],
      [
        { id: "kept", name: "Kept", timeoutSeconds: 900 },
        { id: "gone", name: "Gone", timeoutSeconds: 120 },
      ],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual({ id: "kept", name: "Kept", timeoutSeconds: 900 });
  });

  it("never invents timeoutSeconds for a model without a persisted value", () => {
    const merged = mergeRefreshedCustomProviderModels(
      [{ id: "fresh", name: "Fresh" }],
      [{ id: "fresh", name: "Fresh" }],
    );
    expect(merged[0]).toEqual({ id: "fresh", name: "Fresh" });
    expect("timeoutSeconds" in merged[0]).toBe(false);
  });

  it("drops a probe-reported maxTokens at/above its own contextWindow (inconsistent pair)", () => {
    const merged = mergeRefreshedCustomProviderModels(
      [{ id: "m1", name: "M1", contextWindow: 32768, maxTokens: 32768 }],
      [],
    );
    expect(merged[0].contextWindow).toBe(32768);
    expect(merged[0].maxTokens).toBeUndefined();
    expect("maxTokens" in merged[0]).toBe(false);
  });

  it("keeps a consistent carried-over window pair (drop fires only on in-entry pairs)", () => {
    const merged = mergeRefreshedCustomProviderModels(
      [{ id: "m1", name: "M1" }],
      [{ id: "m1", name: "M1", contextWindow: 32768, maxTokens: 8192, timeoutSeconds: 600 }],
    );
    expect(merged[0]).toMatchObject({ contextWindow: 32768, maxTokens: 8192, timeoutSeconds: 600 });
  });
});
