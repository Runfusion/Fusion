import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TaskTokenStatsPanel } from "../TaskTokenStatsPanel";
import type { Task } from "@fusion/core";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-400",
    description: "Stats panel task",
    column: "in-progress",
    dependencies: [],
    steps: [{ name: "One", status: "done" }, { name: "Two", status: "in-progress" }],
    currentStep: 1,
    log: [
      { timestamp: "2026-04-24T09:00:00.000Z", action: "[timing] Worktree init command completed in 120ms" },
      { timestamp: "2026-04-24T09:01:00.000Z", action: "Started execution" },
      { timestamp: "2026-04-24T09:02:00.000Z", action: "[timing] [verification] test command succeeded (exit 0) in 3400ms" },
    ],
    workflowStepResults: [
      {
        workflowStepId: "WS-001",
        workflowStepName: "QA Check",
        status: "passed",
        startedAt: "2026-04-24T09:10:00.000Z",
        completedAt: "2026-04-24T09:10:07.000Z",
      },
    ],
    status: "executing",
    paused: false,
    executionMode: "fast",
    recoveryRetryCount: 1,
    workflowStepRetries: 2,
    mergeRetries: 3,
    taskDoneRetryCount: 4,
    stuckKillCount: 1,
    postReviewFixCount: 2,
    assignedAgentId: "agent-1",
    checkedOutBy: "executor-1",
    blockedBy: "FN-300",
    sessionFile: ".fusion/sessions/FN-400.json",
    createdAt: "2026-04-24T09:00:00.000Z",
    updatedAt: "2026-04-24T09:30:00.000Z",
    ...overrides,
  };
}

describe("TaskTokenStatsPanel", () => {
  it("renders loading state while task detail token usage is hydrating", () => {
    render(<TaskTokenStatsPanel loading tokenUsage={undefined} task={makeTask()} />);

    expect(screen.getByText("Execution Timing")).toBeInTheDocument();
    expect(screen.getByText("Execution Details")).toBeInTheDocument();
    expect(screen.getByText("Token Usage")).toBeInTheDocument();
    expect(screen.getByText("Loading token statistics…")).toBeInTheDocument();
    expect(screen.queryByText("No token usage recorded for this task yet.")).toBeNull();
  });

  it("renders empty token state when detail is loaded without usage", () => {
    render(<TaskTokenStatsPanel loading={false} tokenUsage={undefined} task={makeTask()} />);

    expect(screen.getByText("No token usage recorded for this task yet.")).toBeInTheDocument();
    expect(screen.queryByText("Loading token statistics…")).toBeNull();
  });

  it("renders execution timing, details, and token totals", () => {
    render(
      <TaskTokenStatsPanel
        loading={false}
        task={makeTask()}
        tokenUsage={{
          inputTokens: 1200,
          outputTokens: 450,
          cachedTokens: 210,
          totalTokens: 1860,
          firstUsedAt: "2026-04-24T09:00:00.000Z",
          lastUsedAt: "2026-04-24T10:15:00.000Z",
        }}
      />,
    );

    expect(screen.getByText("Timing events")).toBeInTheDocument();
    expect(screen.getByText("Workflow runtime")).toBeInTheDocument();
    expect(screen.getByText("Execution mode")).toBeInTheDocument();
    expect(screen.getByText("Fast")).toBeInTheDocument();
    expect(screen.getByText("Runtime status")).toBeInTheDocument();
    expect(screen.getByText("executing")).toBeInTheDocument();

    expect(screen.getByText("Input")).toBeInTheDocument();
    expect(screen.getByText("Output")).toBeInTheDocument();
    expect(screen.getByText("Cached")).toBeInTheDocument();
    expect(screen.getByText("Total")).toBeInTheDocument();
    expect(screen.getByText("1,200")).toBeInTheDocument();
    expect(screen.getByText("450")).toBeInTheDocument();
    expect(screen.getByText("210")).toBeInTheDocument();
    expect(screen.getByText("1,860")).toBeInTheDocument();

    const firstUsedTime = screen.getByText((_, element) => element?.tagName === "TIME" && element.getAttribute("datetime") === "2026-04-24T09:00:00.000Z");
    const lastUsedTime = screen.getByText((_, element) => element?.tagName === "TIME" && element.getAttribute("datetime") === "2026-04-24T10:15:00.000Z");

    expect(firstUsedTime).toBeInTheDocument();
    expect(lastUsedTime).toBeInTheDocument();
  });

  it("gracefully handles logs without timing patterns", () => {
    render(
      <TaskTokenStatsPanel
        loading={false}
        tokenUsage={undefined}
        task={makeTask({
          log: [{ timestamp: "2026-04-24T09:00:00.000Z", action: "Non timing entry" }],
          workflowStepResults: [],
        })}
      />,
    );

    expect(screen.getByText("No timed events recorded yet.")).toBeInTheDocument();
    expect(screen.getByText("No completed workflow step timings yet.")).toBeInTheDocument();
  });

  it("falls back to timedExecutionMs when live task updates strip timing log entries", () => {
    render(
      <TaskTokenStatsPanel
        loading={false}
        tokenUsage={undefined}
        task={makeTask({
          log: [],
          timedExecutionMs: 240_000,
          workflowStepResults: [],
        })}
      />,
    );

    expect(screen.getByText("Timed duration")).toBeInTheDocument();
    expect(screen.getAllByText("4m 0s").length).toBeGreaterThan(0);
  });
});
