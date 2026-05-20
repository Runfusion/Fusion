import { describe, expect, it, vi } from "vitest";
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
          cacheWriteTokens: 15,
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
    expect(screen.getByText("Cache read")).toBeInTheDocument();
    expect(screen.getByText("Cache write")).toBeInTheDocument();
    expect(screen.getByText("Total")).toBeInTheDocument();
    expect(screen.getByText("1,200")).toBeInTheDocument();
    expect(screen.getByText("450")).toBeInTheDocument();
    expect(screen.getByText("210")).toBeInTheDocument();
    expect(screen.getByText("15")).toBeInTheDocument();
    expect(screen.getByText("1,860")).toBeInTheDocument();
    expect(screen.getByText("Cache hit ratio:")).toBeInTheDocument();
    expect(screen.getByText("14.9%")).toBeInTheDocument();
    expect(screen.getByText("(read 210 / write 15 / input 1,200)")).toBeInTheDocument();

    const firstUsedTime = screen.getByText((_, element) => element?.tagName === "TIME" && element.getAttribute("datetime") === "2026-04-24T09:00:00.000Z");
    const lastUsedTime = screen.getByText((_, element) => element?.tagName === "TIME" && element.getAttribute("datetime") === "2026-04-24T10:15:00.000Z");

    expect(firstUsedTime).toBeInTheDocument();
    expect(lastUsedTime).toBeInTheDocument();
  });

  it("shows dash cache hit ratio when cache/input denominator is zero", () => {
    render(
      <TaskTokenStatsPanel
        loading={false}
        task={makeTask()}
        tokenUsage={{
          inputTokens: 0,
          outputTokens: 12,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 12,
          firstUsedAt: "2026-04-24T09:00:00.000Z",
          lastUsedAt: "2026-04-24T10:15:00.000Z",
        }}
      />,
    );

    expect(screen.getByText("Cache hit ratio:")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.getByText("(read 0 / write 0 / input 0)")).toBeInTheDocument();
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

  it("uses end-to-end execution window for total execution time when available", () => {
    render(
      <TaskTokenStatsPanel
        loading={false}
        tokenUsage={undefined}
        task={makeTask({
          column: "done",
          executionStartedAt: "2026-05-15T13:10:00.000Z",
          executionCompletedAt: "2026-05-15T13:15:00.000Z",
          timedExecutionMs: 120_000,
          workflowStepResults: [
            {
              workflowStepId: "WS-150",
              workflowStepName: "Workflow QA",
              status: "passed",
              startedAt: "2026-05-15T13:12:00.000Z",
              completedAt: "2026-05-15T13:13:00.000Z",
            },
          ],
        })}
      />,
    );

    const metric = screen.getByText("Total execution time").closest(".task-token-stats-panel__metric");
    expect(metric).toHaveTextContent("5m 0s");
  });

  it("shows cumulative active runtime for in-progress tasks", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T13:16:00.000Z"));
    try {
      render(
        <TaskTokenStatsPanel
          loading={false}
          tokenUsage={undefined}
          task={makeTask({
            column: "in-progress",
            cumulativeActiveMs: 240_000,
            executionStartedAt: "2026-05-15T13:15:00.000Z",
            firstExecutionAt: "2026-05-15T08:42:00.000Z",
            timedExecutionMs: undefined,
            workflowStepResults: [],
            log: [],
          })}
        />,
      );

      const metric = screen.getByText("Total execution time").closest(".task-token-stats-panel__metric");
      expect(metric).toHaveTextContent("5m 0s");
      expect(screen.getByText("Wall-clock since first execution")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not double count workflow runtime when timedExecutionMs is present", () => {
    render(
      <TaskTokenStatsPanel
        loading={false}
        tokenUsage={undefined}
        task={makeTask({
          log: [
            { timestamp: "2026-04-24T09:00:00.000Z", action: "[timing] AI execution completed in 120000ms" },
          ],
          timedExecutionMs: 120_000,
          workflowStepResults: [
            {
              workflowStepId: "WS-200",
              workflowStepName: "Workflow QA",
              status: "passed",
              startedAt: "2026-04-24T09:01:00.000Z",
              completedAt: "2026-04-24T09:02:00.000Z",
            },
          ],
        })}
      />,
    );

    const metric = screen.getByText("Total execution time").closest(".task-token-stats-panel__metric");
    expect(metric).toHaveTextContent("2m 0s");
    expect(screen.getByText("Workflow runtime").closest(".task-token-stats-panel__metric")).toHaveTextContent("1m 0s");
  });

  it("uses legacy timed plus workflow fallback when end-to-end and timedExecutionMs are unavailable", () => {
    render(
      <TaskTokenStatsPanel
        loading={false}
        tokenUsage={undefined}
        task={makeTask({
          timedExecutionMs: undefined,
          log: [
            { timestamp: "2026-04-24T09:00:00.000Z", action: "[timing] setup completed in 120000ms" },
          ],
          workflowStepResults: [
            {
              workflowStepId: "WS-300",
              workflowStepName: "Workflow QA",
              status: "passed",
              startedAt: "2026-04-24T09:01:00.000Z",
              completedAt: "2026-04-24T09:02:00.000Z",
            },
          ],
        })}
      />,
    );

    const metric = screen.getByText("Total execution time").closest(".task-token-stats-panel__metric");
    expect(metric).toHaveTextContent("3m 0s");
  });
});
