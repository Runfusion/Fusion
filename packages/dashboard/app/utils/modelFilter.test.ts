import { describe, it, expect } from "vitest";
import { filterModels } from "./modelFilter";
import type { ModelInfo } from "../api";

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
});
