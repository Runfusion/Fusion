import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { TaskDetail, TaskTokenUsage } from "@fusion/core";
import { TaskCostTab } from "../TaskCostTab";

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
  return { id: "FN-7820", title: "Cost", column: "in-progress", steps: [], dependencies: [], tokenUsage } as TaskDetail;
}

describe("TaskCostTab", () => {
  it("renders per-model cost breakdown and task total", () => {
    render(<TaskCostTab task={task(usage({
      perModel: [
        { modelProvider: "openai", modelId: "gpt-5-mini", inputTokens: 1_000_000, outputTokens: 1_000_000, cachedTokens: 0, cacheWriteTokens: 0, totalTokens: 2_000_000 },
      ],
    }))} />);

    expect(screen.getByText("Model cost")).toBeInTheDocument();
    const row = screen.getByTestId("task-cost-row");
    expect(within(row).getByText("gpt-5-mini")).toBeInTheDocument();
    expect(within(row).getAllByText("1,000,000")).toHaveLength(2);
    expect(within(row).getByText("2,000,000")).toBeInTheDocument();
    expect(within(row).getByText("$2.25")).toBeInTheDocument();
    expect(screen.getByTestId("task-cost-total")).toHaveTextContent("Total: $2.25");
  });

  it("renders the unavailable sentinel for unpriceable models and total", () => {
    render(<TaskCostTab task={task(usage({ modelProvider: "unknown", modelId: "no-price", inputTokens: 1, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, totalTokens: 1 }))} />);

    const row = screen.getByTestId("task-cost-row");
    expect(within(row).getByText("—")).toBeInTheDocument();
    expect(screen.getByTestId("task-cost-total")).toHaveTextContent("Total: —");
  });

  it("renders an explicit empty state when token usage is missing", () => {
    render(<TaskCostTab task={task()} />);

    expect(screen.getByTestId("task-cost-tab")).toBeInTheDocument();
    expect(screen.getByText("No model token usage has been recorded for this task yet.")).toBeInTheDocument();
    expect(screen.queryByTestId("task-cost-row")).toBeNull();
  });
});
