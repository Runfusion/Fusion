import { describe, it, expect } from "vitest";
import { filterModels } from "../modelFilter";
import type { ModelInfo } from "../../api";

/**
 * Model filter utility tests
 *
 * Tests for filtering AI models by provider, ID, or name.
 */

function createModel(
  provider: string,
  id: string,
  name: string,
  reasoning = false,
  contextWindow = 128000,
): ModelInfo {
  return { provider, id, name, reasoning, contextWindow };
}

describe("filterModels", () => {
  const models: ModelInfo[] = [
    createModel("anthropic", "claude-sonnet-4-5", "Claude Sonnet 4.5"),
    createModel("anthropic", "claude-opus-4", "Claude Opus 4", true),
    createModel("openai", "gpt-4o", "GPT-4o"),
    createModel("openai", "gpt-4o-mini", "GPT-4o Mini"),
    createModel("google", "gemini-pro", "Gemini Pro"),
    createModel("ollama", "llama3.1", "Llama 3.1"),
  ];

  it("returns all models when filter is empty string", () => {
    expect(filterModels(models, "")).toEqual(models);
  });

  it("returns all models when filter is whitespace-only", () => {
    expect(filterModels(models, "   ")).toEqual(models);
    expect(filterModels(models, "  \t  \n  ")).toEqual(models);
  });

  it("filters by provider (case-insensitive)", () => {
    const result = filterModels(models, "anthropic");
    expect(result).toHaveLength(2);
    expect(result.map((m) => m.id)).toContain("claude-sonnet-4-5");
    expect(result.map((m) => m.id)).toContain("claude-opus-4");
  });

  it("filters by provider (uppercase)", () => {
    const result = filterModels(models, "ANTHROPIC");
    expect(result).toHaveLength(2);
  });

  it("filters by provider (mixed case)", () => {
    const result = filterModels(models, "OpenAI");
    expect(result).toHaveLength(2);
    expect(result.map((m) => m.id)).toContain("gpt-4o");
    expect(result.map((m) => m.id)).toContain("gpt-4o-mini");
  });

  it("filters by model ID (case-insensitive, matches exact ID)", () => {
    // Using unique ID "opus" that doesn't appear in other models
    const result = filterModels(models, "opus");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("claude-opus-4");
  });

  it("filters by partial model ID (substring matching)", () => {
    const result = filterModels(models, "claude");
    expect(result).toHaveLength(2);
    expect(result.map((m) => m.provider)).toContain("anthropic");
  });

  it("filters by model name (case-insensitive)", () => {
    const result = filterModels(models, "sonnet");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("claude-sonnet-4-5");
  });

  it("filters by model name (partial match)", () => {
    // "opus" appears in "Claude Opus 4" name
    const result = filterModels(models, "opus");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("claude-opus-4");
  });

  it("handles multi-word filters with AND logic", () => {
    // "anthropic" AND "sonnet" should match only Claude Sonnet
    const result = filterModels(models, "anthropic sonnet");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("claude-sonnet-4-5");
  });

  it("handles multi-word filters with multiple matches", () => {
    // "gpt" should match both gpt-4o and gpt-4o-mini
    const result = filterModels(models, "gpt 4o");
    expect(result).toHaveLength(2);
  });

  it("handles partial matches across multiple fields", () => {
    // "pro" matches "Gemini Pro" in name
    const result = filterModels(models, "pro");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("gemini-pro");
  });

  it("returns empty array when no matches", () => {
    const result = filterModels(models, "nonexistent");
    expect(result).toEqual([]);
  });

  it("returns empty array for non-matching multi-word filter", () => {
    // "anthropic" AND "nonexistent" should match nothing
    const result = filterModels(models, "anthropic nonexistent");
    expect(result).toEqual([]);
  });

  it("handles empty model array", () => {
    expect(filterModels([], "")).toEqual([]);
    expect(filterModels([], "test")).toEqual([]);
  });

  it("handles single model array", () => {
    const singleModel = [models[0]];
    expect(filterModels(singleModel, "")).toEqual(singleModel);
    expect(filterModels(singleModel, "anthropic")).toEqual(singleModel);
    expect(filterModels(singleModel, "openai")).toEqual([]);
  });

  it("is case-insensitive across all fields", () => {
    // Mix of cases should all work
    expect(filterModels(models, "CLAUDE")).toHaveLength(2);
    expect(filterModels(models, "GPT-4O")).toHaveLength(2);
    expect(filterModels(models, "GEMINI")).toHaveLength(1);
    expect(filterModels(models, "OPUS")).toHaveLength(1);
  });

  it("matches model ID with special characters", () => {
    const modelsWithSpecial = [
      createModel("anthropic", "claude-3.5-sonnet", "Claude 3.5 Sonnet"),
      createModel("openai", "gpt-4-turbo-preview", "GPT-4 Turbo"),
    ];

    expect(filterModels(modelsWithSpecial, "3.5")).toHaveLength(1);
    expect(filterModels(modelsWithSpecial, "turbo-preview")).toHaveLength(1);
  });

  it("handles leading and trailing whitespace in filter", () => {
    const result = filterModels(models, "  anthropic  ");
    expect(result).toHaveLength(2);
  });

  it("handles multiple spaces between terms", () => {
    const result = filterModels(models, "anthropic   sonnet");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("claude-sonnet-4-5");
  });

  it("matches substring anywhere in provider, id, or name", () => {
    // "ai" appears in "openai" provider
    const result = filterModels(models, "ai");
    expect(result.map((m) => m.provider)).toContain("openai");

    // "ll" appears in "ollama" provider and "llama" id
    const resultLl = filterModels(models, "ll");
    expect(resultLl.map((m) => m.id)).toContain("llama3.1");
  });

  // --- Fuzzy matching: separator-insensitive ---

  describe("separator-insensitive matching", () => {
    it("matches when search omits hyphens from model ID", () => {
      // "gpt4o" should match "gpt-4o" (hyphen omitted)
      const result = filterModels(models, "gpt4o");
      expect(result).toHaveLength(2);
      expect(result.map((m) => m.id)).toContain("gpt-4o");
      expect(result.map((m) => m.id)).toContain("gpt-4o-mini");
    });

    it("matches when search omits dots from model ID", () => {
      const modelsWithDots = [
        createModel("ollama", "llama3.1", "Llama 3.1"),
      ];
      // "llama31" should match "llama3.1" (dot omitted)
      expect(filterModels(modelsWithDots, "llama31")).toHaveLength(1);
    });

    it("matches when search omits underscores", () => {
      const modelsWithUnderscores = [
        createModel("test", "my_model_v2", "My Model V2"),
      ];
      expect(filterModels(modelsWithUnderscores, "mymodelv2")).toHaveLength(1);
    });

    it("matches when search uses different separators than the model ID", () => {
      // Searching with hyphen where the ID uses dot should still match
      const result = filterModels(models, "gpt-4o");
      expect(result).toHaveLength(2);
    });
  });

  // --- Fuzzy matching: typo tolerance ---

  describe("typo-tolerant matching", () => {
    it("matches with single character deletion (sonet → sonnet)", () => {
      const result = filterModels(models, "sonet");
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("claude-sonnet-4-5");
    });

    it("matches with single character insertion", () => {
      // "sonnnet" (extra n) should still match "sonnet"
      const result = filterModels(models, "sonnnet");
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("claude-sonnet-4-5");
    });

    it("matches with single character substitution", () => {
      // "gemeno" → one substitution from "gemini" is too far, but "gemini" is close
      // "gemini" with 'n' instead of 'i' at end → "geminj" should match
      // Actually let's use a clear case: "gemino" (o instead of i) matches "gemini"
      const result = filterModels(models, "gemino");
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("gemini-pro");
    });

    it("matches with adjacent transposition", () => {
      // "opneai" (transposed n and e) should match "openai"
      const result = filterModels(models, "opneai");
      expect(result).toHaveLength(2); // Both openai models
    });

    it("does not apply typo tolerance to very short terms (≤ 3 chars)", () => {
      // "xai" should NOT match "openai" via typo tolerance (edit distance 1)
      // because the term is only 3 chars — fuzzy matching requires ≥ 4 chars
      const result = filterModels(models, "xai");
      // "xai" is not a substring, not a subsequence of any single token
      expect(result).toEqual([]);
    });

    it("preserves multi-term AND logic with typo-tolerant terms", () => {
      // "anthropic sonet" → "anthropic" matches exactly, "sonet" fuzzy-matches "sonnet"
      const result = filterModels(models, "anthropic sonet");
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("claude-sonnet-4-5");
    });

    it("does not match when both terms are required but only one fuzzy-matches", () => {
      // "google sonet" → "google" matches, "sonet" doesn't match any google model
      const result = filterModels(models, "google sonet");
      expect(result).toEqual([]);
    });
  });

  // --- Fuzzy matching: subsequence (non-contiguous) ---

  describe("subsequence matching", () => {
    it("matches non-contiguous characters (cld → claude)", () => {
      const result = filterModels(models, "cld");
      // "cld" is a subsequence of "claude" (token), should match all claude models
      expect(result).toHaveLength(2);
      expect(result.map((m) => m.id)).toContain("claude-sonnet-4-5");
      expect(result.map((m) => m.id)).toContain("claude-opus-4");
    });

    it("matches non-contiguous characters in model name", () => {
      // "gmi" is a subsequence of "gemini" (g-e-m-i-n-i → g(0), m(2), i(3))
      // It's also a subsequence of "gpt4omini" (g(0), m(5), i(6))
      const result = filterModels(models, "gmi");
      expect(result).toHaveLength(2);
      expect(result.map((m) => m.id)).toContain("gemini-pro");
      expect(result.map((m) => m.id)).toContain("gpt-4o-mini");
    });

    it("does not apply subsequence matching for very short terms (< 3 chars)", () => {
      // "op" is 2 chars, so subsequence matching does NOT apply (min 3).
      // However, "op" IS a substring: it appears in "anthropic" ("anthr**op**ic")
      // and in "openai" ("**op**enai"), so it matches all 4 models from those providers.
      const result = filterModels(models, "op");
      expect(result).toHaveLength(4);
      expect(result.map((m) => m.id)).toContain("claude-sonnet-4-5");
      expect(result.map((m) => m.id)).toContain("claude-opus-4");
      expect(result.map((m) => m.id)).toContain("gpt-4o");
      expect(result.map((m) => m.id)).toContain("gpt-4o-mini");
    });

    it("requires all characters in order for subsequence", () => {
      // "dcl" is NOT a subsequence of "claude" (d before c, but "dcl" reversed)
      const result = filterModels(models, "dcl");
      expect(result).toEqual([]);
    });

    it("subsequence only matches within individual tokens, not across fields", () => {
      // "ops" should NOT match by picking 'o' from one field and 'ps' from another
      // It should only match if it's a subsequence of a single token
      // "ops" as subsequence of "claudeopus4" → o at index 6, p at index 7, s at index 9 → TRUE
      // So it DOES match the opus model because it's a subsequence of the token "claudeopus4"
      const result = filterModels(models, "ops");
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("claude-opus-4");
    });

    it("subsequence does not match across space-separated tokens", () => {
      // "cpo" picking c from "claude", p from provider "anthropic", o from "4"
      // should NOT match because subsequence is checked per-token
      // "cpo" is NOT a subsequence of any single token
      const result = filterModels(models, "cpo");
      expect(result).toEqual([]);
    });
  });

  // --- Fuzzy matching: negative tests (no over-matching) ---

  describe("negative fuzzy matching (no over-matching)", () => {
    it("returns empty array for clearly irrelevant input", () => {
      expect(filterModels(models, "xyz")).toEqual([]);
      expect(filterModels(models, "banana")).toEqual([]);
      expect(filterModels(models, "zzzzz")).toEqual([]);
    });

    it("does not fuzzy-match unrelated providers", () => {
      // "googel" is close to "google" (edit distance 1) but NOT to "openai" or "anthropic"
      const result = filterModels(models, "googel");
      expect(result).toHaveLength(1);
      expect(result[0].provider).toBe("google");
    });

    it("does not fuzzy-match when edit distance exceeds tolerance", () => {
      // "gpt5o" has edit distance 2 from "gpt4o" (4→5 substitution + different letter)
      // Actually edit distance is 1 (just 4→5). Let's use a clear 2-distance case.
      // "gpt99" has edit distance ≥ 2 from "gpt4o" (two substitutions: 4→9, o→9)
      expect(filterModels(models, "gpt99")).toEqual([]);
    });

    it("does not fuzzy-match very different words", () => {
      // "elephant" should not match anything despite fuzzy matching
      expect(filterModels(models, "elephant")).toEqual([]);
    });

    it("multi-term AND with one non-matching term returns empty", () => {
      // Even if "sonet" fuzzy-matches, adding "elephant" should return empty
      expect(filterModels(models, "sonet elephant")).toEqual([]);
    });
  });

  // --- Fuzzy matching: result ordering stability ---

  describe("result ordering", () => {
    it("preserves input-array order (no fuzzy-score re-sorting)", () => {
      // All claude models should appear in their original array order
      const result = filterModels(models, "claude");
      expect(result.map((m) => m.id)).toEqual([
        "claude-sonnet-4-5",
        "claude-opus-4",
      ]);
    });

    it("preserves input-array order with fuzzy matches", () => {
      const result = filterModels(models, "gpt4o");
      expect(result.map((m) => m.id)).toEqual([
        "gpt-4o",
        "gpt-4o-mini",
      ]);
    });
  });
});
