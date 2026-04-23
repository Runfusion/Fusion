import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Agent, AiSessionSummary } from "../../api";
import type { Toast } from "../../hooks/useToast";

vi.mock("../../hooks/useExecutorStats", () => ({
  useExecutorStats: vi.fn(),
}));

vi.mock("../../hooks/useLiveTranscript", () => ({
  useLiveTranscript: vi.fn(() => ({
    entries: [],
    isConnected: false,
  })),
}));

import { useExecutorStats } from "../../hooks/useExecutorStats";
import { BackgroundTasksIndicator } from "../BackgroundTasksIndicator";
import { ExecutorStatusBar } from "../ExecutorStatusBar";
import { ActiveAgentsPanel } from "../ActiveAgentsPanel";
import { ToastContainer } from "../ToastContainer";

const stylesPath = path.resolve(__dirname, "../../styles.css");

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function expectMobileRule(css: string, selector: string, declaration: string): void {
  const pattern = new RegExp(
    `@media\\s*\\(max-width:\\s*768px\\)\\s*\\{[\\s\\S]*?${escapeRegExp(selector)}\\s*\\{[\\s\\S]*?${escapeRegExp(declaration)}`,
  );
  expect(pattern.test(css)).toBe(true);
}

describe("Utility component mobile adaptations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useExecutorStats).mockReturnValue({
      stats: {
        runningTaskCount: 1,
        blockedTaskCount: 2,
        stuckTaskCount: 0,
        queuedTaskCount: 3,
        inReviewCount: 4,
        executorState: "running",
        maxConcurrent: 5,
        lastActivityAt: new Date().toISOString(),
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
  });

  it("renders BackgroundTasksIndicator pill when sessions exist", () => {
    const sessions: AiSessionSummary[] = [
      {
        id: "sess-1",
        type: "planning",
        status: "generating",
        title: "Refine onboarding flow",
        projectId: "proj-1",
        updatedAt: new Date().toISOString(),
      },
    ];

    render(
      <BackgroundTasksIndicator
        sessions={sessions}
        generating={1}
        needsInput={0}
        onOpenSession={vi.fn()}
        onDismissSession={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /AI 1/i })).toBeTruthy();
  });

  it("renders BackgroundTasksIndicator popover on pill click", () => {
    const sessions: AiSessionSummary[] = [
      {
        id: "sess-2",
        type: "subtask",
        status: "awaiting_input",
        title: "Break down API tasks",
        projectId: "proj-1",
        updatedAt: new Date().toISOString(),
      },
    ];

    render(
      <BackgroundTasksIndicator
        sessions={sessions}
        generating={0}
        needsInput={1}
        onOpenSession={vi.fn()}
        onDismissSession={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /AI 1/i }));

    expect(screen.getByText("Background Tasks")).toBeTruthy();
    expect(screen.getByText("Break down API tasks")).toBeTruthy();
  });

  it("returns null for BackgroundTasksIndicator with no sessions", () => {
    const { container } = render(
      <BackgroundTasksIndicator
        sessions={[]}
        generating={0}
        needsInput={0}
        onOpenSession={vi.fn()}
        onDismissSession={vi.fn()}
      />,
    );

    expect(container.firstChild).toBeNull();
  });

  it("calls onOpenSession when clicking on a milestone_interview session item", () => {
    const onOpenSession = vi.fn();
    const sessions: AiSessionSummary[] = [
      {
        id: "sess-milestone-1",
        type: "milestone_interview",
        status: "awaiting_input",
        title: "Plan milestone scope",
        projectId: "proj-1",
        updatedAt: new Date().toISOString(),
      },
    ];

    render(
      <BackgroundTasksIndicator
        sessions={sessions}
        generating={0}
        needsInput={1}
        onOpenSession={onOpenSession}
        onDismissSession={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /AI 1/i }));
    fireEvent.click(screen.getByText("Plan milestone scope"));

    expect(onOpenSession).toHaveBeenCalledWith(sessions[0]);
  });

  it("calls onOpenSession when clicking on a slice_interview session item", () => {
    const onOpenSession = vi.fn();
    const sessions: AiSessionSummary[] = [
      {
        id: "sess-slice-1",
        type: "slice_interview",
        status: "error",
        title: "Plan slice scope",
        projectId: "proj-1",
        updatedAt: new Date().toISOString(),
      },
    ];

    render(
      <BackgroundTasksIndicator
        sessions={sessions}
        generating={0}
        needsInput={0}
        onOpenSession={onOpenSession}
        onDismissSession={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /AI 1/i }));
    fireEvent.click(screen.getByText("Plan slice scope"));

    expect(onOpenSession).toHaveBeenCalledWith(sessions[0]);
  });

  it("renders ExecutorStatusBar segments", () => {
    render(<ExecutorStatusBar tasks={[]} />);

    const bar = screen.getByRole("status");
    expect(bar).toHaveTextContent("Running");
    expect(bar).toHaveTextContent("Blocked");
    expect(bar).toHaveTextContent("Queued");
    expect(bar).toHaveTextContent("In Review");
  });

  it("renders ActiveAgentsPanel grid and cards when agents are provided", () => {
    const agents: Agent[] = [
      {
        id: "agent-1",
        name: "Live Agent",
        role: "executor",
        state: "active",
        taskId: "FN-555",
        lastHeartbeatAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metadata: {},
      },
    ];

    const { container } = render(<ActiveAgentsPanel agents={agents} />);

    expect(container.querySelector(".active-agents-grid")).toBeTruthy();
    expect(container.querySelectorAll(".live-agent-card").length).toBe(1);
  });

  it("returns null for ActiveAgentsPanel when no agents are active", () => {
    const { container } = render(<ActiveAgentsPanel agents={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders toasts in ToastContainer", () => {
    const toasts: Toast[] = [
      { id: 1, message: "Saved", type: "success" },
      { id: 2, message: "Failed", type: "error" },
    ];

    const { container } = render(<ToastContainer toasts={toasts} onRemove={vi.fn()} />);

    expect(container.querySelector(".toast-container")).toBeTruthy();
    expect(container.querySelector(".toast-success")).toBeTruthy();
    expect(container.querySelector(".toast-error")).toBeTruthy();
  });

  it("contains mobile CSS overrides for adapted utility and layout components", () => {
    const css = fs.readFileSync(stylesPath, "utf-8");

    expectMobileRule(css, ".settings-layout", "flex-direction: column;");
    expectMobileRule(css, ".agent-board", "grid-template-columns: 1fr;");
    expectMobileRule(css, ".active-agents-grid", "grid-template-columns: 1fr;");
    expectMobileRule(css, ".toast-container", "bottom: calc(var(--mobile-nav-height, 44px) + var(--executor-footer-height, 0px) + var(--standalone-bottom-gap, 0px) + env(safe-area-inset-bottom, 0px) + var(--space-lg) + var(--space-2xl));");
    expectMobileRule(css, ".background-tasks-indicator__popover", "position: fixed;");
  });
});
