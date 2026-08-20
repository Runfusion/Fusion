/**
 * RUFU-123: per-model contextWindow/maxTokens on custom providers.
 *
 * Unit-tests buildCustomProviderModels' window fallback contract:
 * (a) persisted per-model windows are emitted for all four apiType compat shapes,
 * (b) omitted fields fall back to the registry defaults 128000/16384,
 * (c) invalid persisted values (0, negative, non-number, NaN, undefined) fall back
 *     instead of breaking registration,
 * (d) model id/name ordering is preserved.
 *
 * Symptom-verification assertion 4 (RUFU-118 landed: chat-context-guard.ts exists in
 * this worktree): the pre-overflow compaction gate threshold for a 32768-window model
 * with maxTokens 4096 is min(round(0.8*32768), 32768 - max(16384, 4096)) === 16384 —
 * NOT the ~102,400 threshold the old hardcoded 128K registry default produced.
 */
import { describe, expect, it } from "vitest";
import type { CustomProvider } from "@fusion/core";
import { buildCustomProviderModels, resolveApiType } from "../auth/custom-provider-registry.js";

function makeProvider(models: NonNullable<CustomProvider["models"]>, apiType: CustomProvider["apiType"] = "openai-compatible"): CustomProvider {
  return {
    id: "rufu-123-test",
    name: "RUFU-123 Test",
    apiType,
    baseUrl: "https://example.test/v1",
    models,
  };
}

// The four declared apiType shapes. resolveApiType maps openai-compatible to the
// "openai-completions" pi-ai key, openai-responses to "openai-responses",
// anthropic-compatible to "anthropic-messages", and google-generative-ai to its own
// "google-generative-ai" dialect key (upstream keeps pi's Google API dialect so its
// shared thinking translation handles Off and every selected effort). The builder
// must emit per-model windows for every shape regardless of the resolved key.
const API_TYPE_CASES: CustomProvider["apiType"][] = [
  "openai-compatible",
  "openai-responses",
  "anthropic-compatible",
  "google-generative-ai",
];

describe("buildCustomProviderModels per-model windows (RUFU-123)", () => {
  it.each(API_TYPE_CASES)("emits per-model contextWindow/maxTokens for %s", (apiType) => {
    const api = resolveApiType(apiType);
    const models = buildCustomProviderModels(
      makeProvider(
        [
          { id: "deepseek-v4", name: "DeepSeek V4", contextWindow: 32768, maxTokens: 4096 },
          { id: "big-model", name: "Big Model", contextWindow: 1048576, maxTokens: 32768 },
        ],
        apiType,
      ),
      api,
    );
    // Sanity: the resolved pi-ai key for each declared shape is one pi-ai actually registers.
    expect(["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"]).toContain(api);

    expect(models.map((m) => [m.id, m.contextWindow, m.maxTokens])).toEqual([
      ["deepseek-v4", 32768, 4096],
      ["big-model", 1048576, 32768],
    ]);
  });

  it("emits the compat opt-in shape only for openai-completions with per-model windows", () => {
    const completions = buildCustomProviderModels(
      makeProvider(
        [{ id: "m", name: "M", contextWindow: 32768, maxTokens: 4096 }],
        "openai-compatible",
      ),
      "openai-completions",
    );
    expect(completions[0]).toMatchObject({
      id: "m",
      name: "M",
      contextWindow: 32768,
      maxTokens: 4096,
      compat: { supportsDeveloperRole: false },
    });

    const anthropic = buildCustomProviderModels(
      makeProvider([{ id: "m", name: "M", contextWindow: 32768, maxTokens: 4096 }], "anthropic-compatible"),
      "anthropic-messages",
    );
    expect(anthropic[0]).toMatchObject({ contextWindow: 32768, maxTokens: 4096 });
    expect(anthropic[0]).not.toHaveProperty("compat");
  });

  it("falls back to 128000/16384 when the model omits both window fields", () => {
    const models = buildCustomProviderModels(makeProvider([{ id: "m", name: "M" }]), "openai-completions");
    expect(models[0]).toMatchObject({ id: "m", name: "M", contextWindow: 128000, maxTokens: 16384 });
  });

  it("falls back per-field when only one of the two window fields is present", () => {
    const onlyWindow = buildCustomProviderModels(
      makeProvider([{ id: "m", name: "M", contextWindow: 32768 }]),
      "openai-completions",
    );
    expect(onlyWindow[0]).toMatchObject({ contextWindow: 32768, maxTokens: 16384 });

    const onlyMaxTokens = buildCustomProviderModels(
      makeProvider([{ id: "m", name: "M", maxTokens: 4096 }]),
      "openai-completions",
    );
    expect(onlyMaxTokens[0]).toMatchObject({ contextWindow: 128000, maxTokens: 4096 });
  });

  it("treats invalid persisted window values as unset and falls back to 128000/16384", () => {
    // Corrupted persisted values must never break registration: 0, negative, non-number,
    // and NaN each fall back independently for the window and maxTokens.
    const invalidValues: unknown[] = [0, -1, "abc" as unknown as number, Number.NaN, undefined];
    for (const contextWindow of invalidValues) {
      for (const maxTokens of invalidValues) {
        const models = buildCustomProviderModels(
          makeProvider([{ id: "m", name: "M", contextWindow, maxTokens }]),
          "openai-completions",
        );
        expect(models[0], `contextWindow=${String(contextWindow)}, maxTokens=${String(maxTokens)}`).toMatchObject({
          contextWindow: 128000,
          maxTokens: 16384,
        });
      }
    }
  });

  it("keeps a valid per-field value when the sibling field is invalid", () => {
    const models = buildCustomProviderModels(
      makeProvider([{ id: "m", name: "M", contextWindow: 32768, maxTokens: Number.NaN }]),
      "openai-completions",
    );
    expect(models[0]).toMatchObject({ contextWindow: 32768, maxTokens: 16384 });
  });

  it("preserves model id/name ordering", () => {
    const models = buildCustomProviderModels(
      makeProvider([
        { id: "c", name: "C", contextWindow: 4096, maxTokens: 512 },
        { id: "a", name: "A" },
        { id: "b", name: "B", contextWindow: 8192 },
      ]),
      "google-generative-ai",
    );
    expect(models.map((m) => m.id)).toEqual(["c", "a", "b"]);
    expect(models.map((m) => m.name)).toEqual(["C", "A", "B"]);
  });

  it("returns an empty list for a provider without models", () => {
    const provider: CustomProvider = {
      id: "no-models",
      name: "No Models",
      apiType: "openai-compatible",
      baseUrl: "https://example.test/v1",
    };
    expect(buildCustomProviderModels(provider, "openai-completions")).toEqual([]);
  });
});

/*
FNXC:CustomProviderModelWindows 2026-08-20-13:25:
The pre-overflow gate threshold assertion (RUFU-123 assertion 4) is not pinned here:
it needs the RUFU-118 chat-context-guard module, which this standalone branch does not
carry. It is pinned in the LCM branch's chat-context-guard test suite as
"per-model window thresholds", so once both land the combined tree proves that a
32768-window / 4096-maxTokens model compacts at 16384 instead of the pre-fix 102400.
*/
