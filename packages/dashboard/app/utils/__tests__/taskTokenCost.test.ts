import { describe, expect, it } from "vitest";
import type { TaskDetail, TaskTokenUsage } from "@fusion/core";
import { buildTokenCostRows, formatCost, hasTaskCost, taskTotalCost, totalCostForRows } from "../taskTokenCost";

function usage(overrides: Partial<TaskTokenUsage> = {}): TaskTokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    firstUsedAt: "2026-01-01T00:00:00Z",
    lastUsedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function task(tokenUsage?: TaskTokenUsage): TaskDetail {
  return { id: "FN-7820", title: "Cost", column: "done", steps: [], dependencies: [], tokenUsage } as TaskDetail;
}

describe("taskTokenCost", () => {
  it("prices and merges per-model buckets", () => {
    const rows = buildTokenCostRows(task(usage({
      perModel: [
        { modelProvider: "openai", modelId: "gpt-5-mini", inputTokens: 1_000_000, outputTokens: 1_000_000, cachedTokens: 0, cacheWriteTokens: 0, totalTokens: 2_000_000 },
        { modelProvider: "openai", modelId: "gpt-5-mini", inputTokens: 500_000, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, totalTokens: 500_000 },
      ],
    })), "(unknown)");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ modelProvider: "openai", modelId: "gpt-5-mini", inputTokens: 1_500_000, outputTokens: 1_000_000, totalTokens: 2_500_000 });
    expect(formatCost(rows[0].cost.usd, rows[0].cost.unavailable)).toBe("$2.38");
    expect(formatCost(totalCostForRows(rows).usd, totalCostForRows(rows).unavailable)).toBe("$2.38");
  });

  it("prices aggregate-only fallback usage", () => {
    const result = taskTotalCost(task(usage({ modelProvider: "openai", modelId: "gpt-5-mini", inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, totalTokens: 1_000_000 })));
    expect(formatCost(result.usd, result.unavailable)).toBe("$0.25");
  });

  it("marks unpriceable positive-token rows and totals unavailable", () => {
    const rows = buildTokenCostRows(task(usage({ modelProvider: "unknown", modelId: "no-price", inputTokens: 10, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, totalTokens: 10 })), "(unknown)");
    expect(rows[0].cost.unavailable).toBe(true);
    expect(formatCost(rows[0].cost.usd, rows[0].cost.unavailable)).toBe("—");
    expect(formatCost(totalCostForRows(rows).usd, totalCostForRows(rows).unavailable)).toBe("—");
  });

  it("does not fabricate cost for zero usage", () => {
    const zeroTask = task(usage({ modelProvider: "unknown", modelId: "no-price" }));
    const total = taskTotalCost(zeroTask);
    expect(hasTaskCost(zeroTask)).toBe(false);
    expect(formatCost(total.usd, total.unavailable)).toBe("—");
  });

  it("detects positive task cost availability without requiring pricing", () => {
    expect(hasTaskCost(task())).toBe(false);
    expect(hasTaskCost(task(usage()))).toBe(false);
    expect(hasTaskCost(task(usage({ totalTokens: 1 })))).toBe(true);
    expect(hasTaskCost(task(usage({ perModel: [{ modelProvider: "x", modelId: "y", inputTokens: 1, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, totalTokens: 1 }] })))).toBe(true);
  });
});
