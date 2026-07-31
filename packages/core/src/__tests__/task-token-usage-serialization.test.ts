import { describe, expect, it } from "vitest";
import { rowToTask } from "../task-store/serialization.js";
import type { TaskRow } from "../task-store/persistence.js";

function legacyUsageRow(): TaskRow {
  return {
    id: "FN-8598",
    lineageId: null,
    title: "Cost badge fixture",
    description: "",
    priority: "normal",
    column: "todo",
    status: null,
    currentStep: 0,
    createdAt: "2026-07-19T08:00:00.000Z",
    tokenUsageInputTokens: 1_000_000,
    tokenUsageOutputTokens: 0,
    tokenUsageCachedTokens: 0,
    tokenUsageCacheWriteTokens: null,
    tokenUsageTotalTokens: 1_000_000,
    tokenUsageFirstUsedAt: null,
    tokenUsageLastUsedAt: null,
    tokenUsageModelProvider: "openai",
    tokenUsageModelId: "gpt-5-mini",
    tokenUsagePerModel: null,
  } as TaskRow;
}

describe("rowToTask token usage", () => {
  it("preserves positive legacy usage when optional timestamps and cache-write fields are NULL", () => {
    const task = rowToTask(legacyUsageRow());

    expect(task.tokenUsage).toMatchObject({
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 1_000_000,
      firstUsedAt: "2026-07-19T08:00:00.000Z",
      lastUsedAt: "2026-07-19T08:00:00.000Z",
      modelProvider: "openai",
      modelId: "gpt-5-mini",
    });
  });
});
