import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { makeTask, readDashboardStylesSource, setupTaskDetailModalHooks } from "./TaskDetailModal.test-helpers";
import { TaskSummaryTab } from "../TaskSummaryTab";

setupTaskDetailModalHooks();

function doneTaskWithResults(workflowStepResults: unknown[]) {
  return makeTask({
    column: "done",
    workflowStepResults: workflowStepResults as import("@fusion/core").WorkflowStepResult[],
  });
}

describe("TaskSummaryTab prior-attempts history (FN-7727)", () => {
  it("renders current OpenAI Codex token costs as dollars instead of the unavailable sentinel", () => {
    render(
      <TaskSummaryTab
        task={makeTask({
          column: "done",
          tokenUsage: {
            inputTokens: 1_000_000,
            outputTokens: 200_000,
            cachedTokens: 500_000,
            cacheWriteTokens: 100_000,
            totalTokens: 1_800_000,
            firstUsedAt: "2026-07-01T10:00:00.000Z",
            lastUsedAt: "2026-07-01T10:30:00.000Z",
            perModel: [
              {
                modelProvider: "openai-codex",
                modelId: "gpt-5.5",
                inputTokens: 1_000_000,
                outputTokens: 200_000,
                cachedTokens: 500_000,
                cacheWriteTokens: 100_000,
                totalTokens: 1_800_000,
                firstUsedAt: "2026-07-01T10:00:00.000Z",
                lastUsedAt: "2026-07-01T10:30:00.000Z",
              },
            ],
          },
        })}
      />,
    );

    const section = screen.getByTestId("task-summary-token-cost-section");
    expect(section).toHaveTextContent("$11.25");
    expect(section).not.toHaveTextContent("—");
  });

  it("renders a collapsed prior-attempts affordance for a step with history", () => {
    render(
      <TaskSummaryTab
        task={doneTaskWithResults([
          {
            workflowStepId: "code-review",
            workflowStepName: "Code Review",
            status: "failed",
            output: "attempt-2 feedback",
            startedAt: "2026-07-09T00:02:00Z",
            priorAttempts: [
              {
                workflowStepId: "code-review",
                workflowStepName: "Code Review",
                status: "failed",
                output: "attempt-1 feedback",
                startedAt: "2026-07-09T00:01:00Z",
              },
            ],
          },
        ])}
      />,
    );

    expect(screen.getByText("Code Review")).toBeTruthy();
    const details = screen.getByTestId("task-summary-prior-attempts");
    expect(details).toBeTruthy();
    expect(details.tagName.toLowerCase()).toBe("details");
    expect(screen.getByText("1 previous failed attempt")).toBeTruthy();
    expect(screen.getByText("attempt-1 feedback")).toBeTruthy();
  });

  it("renders nothing (no orphaned shell) when priorAttempts is absent or empty", () => {
    render(
      <TaskSummaryTab
        task={doneTaskWithResults([
          { workflowStepId: "code-review", workflowStepName: "Code Review", status: "passed" },
          { workflowStepId: "plan-review", workflowStepName: "Plan Review", status: "failed", priorAttempts: [] },
        ])}
      />,
    );

    expect(screen.queryByTestId("task-summary-prior-attempts")).toBeNull();
  });

  it("pluralizes multiple prior attempts", () => {
    render(
      <TaskSummaryTab
        task={doneTaskWithResults([
          {
            workflowStepId: "code-review",
            workflowStepName: "Code Review",
            status: "failed",
            startedAt: "T3",
            priorAttempts: [
              { workflowStepId: "code-review", workflowStepName: "Code Review", status: "failed", startedAt: "T2" },
              { workflowStepId: "code-review", workflowStepName: "Code Review", status: "failed", startedAt: "T1" },
            ],
          },
        ])}
      />,
    );

    expect(screen.getByText("2 previous failed attempts")).toBeTruthy();
  });

  it("uses design tokens for the prior-attempts block and includes a mobile breakpoint rule", () => {
    const css = readDashboardStylesSource();
    expect(css).toContain(".task-summary-prior-attempts");
    const mobileBlock = css.slice(css.indexOf("@media (max-width: 768px)"), css.indexOf("/* Spec tab layout"));
    expect(mobileBlock).toContain(".task-summary-prior-attempts");
    expect(css).not.toMatch(/task-summary-prior-attempts[^{}]*#[0-9a-fA-F]{3,8}/);
  });
});
