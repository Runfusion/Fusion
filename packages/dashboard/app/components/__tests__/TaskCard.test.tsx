import { afterEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { TaskCard, formatElapsedDurationDone, __test_areTaskCardPropsEqual } from "../TaskCard";
import type { Task } from "@fusion/core";

// Mock lucide-react to avoid SVG rendering issues in test env
vi.mock("lucide-react", () => ({
  Link: () => null,
  Clock: () => null,
  Pencil: () => null,
  Layers: () => null,
  ChevronDown: () => null,
  Folder: () => null,
  GitPullRequest: () => null,
  CircleDot: () => null,
  Target: () => null,
  Bot: () => null,
  Trash2: () => null,
  RotateCw: () => null,
  Zap: () => <svg data-testid="icon-zap" />,
}));

vi.mock("../ProviderIcon", () => ({
  ProviderIcon: ({ provider }: { provider: string }) => <span data-testid={`provider-icon-${provider}`} />,
}));

// Mock the api module
vi.mock("../../api", () => ({
  fetchTaskDetail: vi.fn(),
  uploadAttachment: vi.fn(),
  fetchMission: vi.fn(),
  fetchAgent: vi.fn(),
}));

import { uploadAttachment, fetchMission, fetchAgent } from "../../api";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-001",
    title: "Test task",
    column: "in-progress",
    status: undefined as any,
    steps: [],
    dependencies: [],
    description: "",
    ...overrides,
  } as Task;
}

const noop = () => {};

afterEach(() => {
  vi.useRealTimers();
});

describe("TaskCard", () => {
  it("renders the card ID text", () => {
    render(<TaskCard task={makeTask()} onOpenDetail={noop} addToast={noop} />);
    expect(screen.getByText("FN-001")).toBeDefined();
  });

  it("clicking PR badge link does not open the task detail modal", () => {
    const onOpenDetail = vi.fn();
    render(
      <TaskCard
        task={makeTask({
          column: "in-review",
          prInfo: {
            url: "https://github.com/owner/repo/pull/42",
            number: 42,
            status: "open",
            title: "PR",
            headBranch: "fusion/fn-001",
            baseBranch: "main",
            commentCount: 0,
          } as any,
        })}
        onOpenDetail={onOpenDetail}
        addToast={noop}
      />,
    );

    fireEvent.click(screen.getByRole("link", { name: "#42" }));
    expect(onOpenDetail).not.toHaveBeenCalled();
  });

  it("clicking issue badge text does not open the task detail modal", () => {
    const onOpenDetail = vi.fn();
    render(
      <TaskCard
        task={makeTask({
          column: "in-review",
          issueInfo: {
            url: "https://github.com/owner/repo/issues/123",
            number: 123,
            state: "open",
            title: "Issue",
          } as any,
        })}
        onOpenDetail={onOpenDetail}
        addToast={noop}
      />,
    );

    fireEvent.click(screen.getByText("#123"));
    expect(onOpenDetail).not.toHaveBeenCalled();
  });

  it("renders the status badge when task.status is set", () => {
    render(
      <TaskCard
        task={makeTask({ status: "executing" })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );
    expect(screen.getByText("executing")).toBeDefined();
  });

  it("renders merge-remediation status as merge-active for in-review tasks", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({ column: "in-review", status: "merging-fix" })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(screen.getByText("Merging fixes…")).toBeDefined();
    const badge = container.querySelector(".card-status-badge");
    expect(badge?.className).toContain("pulsing");
  });

  it("renders the status badge after the card ID in DOM order", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({ status: "executing" })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );
    const cardId = container.querySelector(".card-id")!;
    const badge = container.querySelector(".card-status-badge")!;
    expect(cardId).toBeDefined();
    expect(badge).toBeDefined();
    // Badge should be the next sibling of card-id
    expect(cardId.nextElementSibling).toBe(badge);
  });

  it("does not render a status badge when task.status is falsy", () => {
    const { container } = render(
      <TaskCard task={makeTask({ status: undefined as any })} onOpenDetail={noop} addToast={noop} />,
    );
    expect(container.querySelector(".card-status-badge")).toBeNull();
  });

  it("shows paused by agent label when pausedByAgentId is set", () => {
    render(
      <TaskCard task={makeTask({ paused: true, pausedByAgentId: "agent-1" })} onOpenDetail={noop} addToast={noop} />,
    );

    expect(screen.getByText("paused by agent")).toBeDefined();
  });

  it("shows plain paused label when pausedByAgentId is not set", () => {
    render(
      <TaskCard task={makeTask({ paused: true })} onOpenDetail={noop} addToast={noop} />,
    );

    expect(screen.getByText("paused")).toBeDefined();
    expect(screen.queryByText("paused by agent")).toBeNull();
  });

  it("hides default working branch and default base branch metadata", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({ branch: "fusion/fn-001", baseBranch: "main" })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(container.querySelector(".card-branch-row")).toBeNull();
  });

  it("hides auto-generated suffixed default working branches", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({ branch: "fusion/fn-001-2", baseBranch: "main" })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(container.querySelector(".card-branch-row")).toBeNull();
  });

  it("shows only custom working branch metadata when base branch is default", () => {
    render(
      <TaskCard
        task={makeTask({ branch: "feature/working-only", baseBranch: "main" })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(screen.getByText("Branch")).toBeDefined();
    expect(screen.getByText("feature/working-only")).toBeDefined();
    expect(screen.queryByText("Base")).toBeNull();
  });

  it("shows only non-default base branch metadata when working branch is default", () => {
    render(
      <TaskCard
        task={makeTask({ branch: "fusion/fn-001", baseBranch: "release/2026-05" })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(screen.getByText("Base")).toBeDefined();
    expect(screen.getByText("release/2026-05")).toBeDefined();
    expect(screen.queryByText("Branch")).toBeNull();
  });

  it("shows both chips when branch and base branch are both non-default", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({ branch: "feature/fn-3423-card-branches", baseBranch: "develop" })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const branchRow = container.querySelector(".card-branch-row");
    expect(branchRow).not.toBeNull();
    expect(screen.getByText("Branch")).toBeDefined();
    expect(screen.getByText("feature/fn-3423-card-branches")).toBeDefined();
    expect(screen.getByText("Base")).toBeDefined();
    expect(screen.getByText("develop")).toBeDefined();
  });

  it("keeps long non-default branch names readable via text and title semantics", () => {
    const longBranch = "feature/fn-3423-display-very-long-working-branch-name-for-card-metadata";
    const { container } = render(
      <TaskCard
        task={makeTask({ branch: longBranch, baseBranch: "main" })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const branchChip = container.querySelector(".card-branch-chip");
    expect(branchChip?.getAttribute("title")).toBe(longBranch);
    expect(screen.getByText(longBranch)).toBeDefined();
  });

  it("renders fast-mode indicator only when executionMode is fast", () => {
    const { container, rerender } = render(
      <TaskCard task={makeTask({ executionMode: "fast" })} onOpenDetail={noop} addToast={noop} />,
    );

    const fastBadge = container.querySelector(".card-execution-mode-badge");
    expect(fastBadge).not.toBeNull();
    expect(screen.getByTestId("icon-zap")).toBeDefined();
    expect(fastBadge?.getAttribute("aria-label")).toBe("Fast mode");

    rerender(
      <TaskCard task={makeTask({ executionMode: "standard" })} onOpenDetail={noop} addToast={noop} />,
    );

    expect(container.querySelector(".card-execution-mode-badge")).toBeNull();
  });

  it("updates fast-mode indicator when executionMode changes", () => {
    const { container, rerender } = render(
      <TaskCard task={makeTask({ executionMode: "standard" })} onOpenDetail={noop} addToast={noop} />,
    );

    expect(container.querySelector(".card-execution-mode-badge")).toBeNull();

    rerender(
      <TaskCard task={makeTask({ executionMode: "fast" })} onOpenDetail={noop} addToast={noop} />,
    );

    expect(container.querySelector(".card-execution-mode-badge")).not.toBeNull();
    expect(screen.getByTestId("icon-zap")).toBeDefined();
  });

  describe("retry button on failed tasks", () => {
    it("renders when task is failed and onRetryTask is provided", () => {
      const onRetryTask = vi.fn(async () => ({}) as Task);
      render(
        <TaskCard
          task={makeTask({ column: "todo", status: "failed", error: "Executor crashed" })}
          onOpenDetail={noop}
          addToast={noop}
          onRetryTask={onRetryTask}
        />,
      );

      expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
    });

    it("does not render for non-failed tasks", () => {
      const onRetryTask = vi.fn(async () => ({}) as Task);
      render(
        <TaskCard task={makeTask({ column: "todo", status: "done", error: "Executor crashed" })} onOpenDetail={noop} addToast={noop} onRetryTask={onRetryTask} />,
      );

      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    });

    it("calls onRetryTask with task id", async () => {
      const onRetryTask = vi.fn(async () => ({}) as Task);
      render(
        <TaskCard task={makeTask({ column: "todo", status: "failed", error: "Executor crashed" })} onOpenDetail={noop} addToast={noop} onRetryTask={onRetryTask} />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(onRetryTask).toHaveBeenCalledWith("FN-001"));
    });

    it("shows loading and disabled state while retry is in progress", async () => {
      let resolveRetry: ((value: Task) => void) | null = null;
      const onRetryTask = vi.fn(() => new Promise<Task>((resolve) => { resolveRetry = resolve; }));

      render(
        <TaskCard task={makeTask({ column: "todo", status: "failed", error: "Executor crashed" })} onOpenDetail={noop} addToast={noop} onRetryTask={onRetryTask} />,
      );

      const button = screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement;
      fireEvent.click(button);

      expect(screen.getByRole("button", { name: "Retrying…" })).toBeDefined();
      expect(button.disabled).toBe(true);

      await act(async () => {
        resolveRetry?.({} as Task);
      });

      await waitFor(() => expect(screen.getByRole("button", { name: "Retry" })).toBeDefined());
    });

    it("shows toast when retry fails", async () => {
      const addToast = vi.fn();
      const onRetryTask = vi.fn(async () => {
        throw new Error("network down");
      });

      render(
        <TaskCard task={makeTask({ column: "todo", status: "failed", error: "Executor crashed" })} onOpenDetail={noop} addToast={addToast} onRetryTask={onRetryTask} />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Retry" }));

      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith("Failed to retry FN-001: network down", "error");
      });
    });
  });

  it("renders unified progress counts for task steps + workflow checks", () => {
    render(
      <TaskCard
        task={makeTask({
          steps: [
            { name: "Step 0", status: "done" },
            { name: "Step 1", status: "pending" },
          ],
          enabledWorkflowSteps: ["WS-001", "WS-002", "WS-003"],
          workflowStepResults: [
            {
              workflowStepId: "WS-001",
              workflowStepName: "Browser Verification",
              status: "passed",
            },
            {
              workflowStepId: "WS-002",
              workflowStepName: "Frontend UX Design",
              status: "failed",
            },
          ],
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(screen.getByText("2/5")).toBeDefined();
    expect(screen.getByText("5 steps")).toBeDefined();
  });

  it("uses singular step label when unified progress total is one", () => {
    render(
      <TaskCard
        task={makeTask({
          steps: [{ name: "Step 0", status: "done" }],
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(screen.getByText("1 step")).toBeDefined();
    expect(screen.queryByText("1 steps")).toBeNull();
  });

  it("renders workflow checks after normal steps with mapped statuses and phase badges", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({
          steps: [
            { name: "Step 0", status: "done" },
            { name: "Step 1", status: "failed" as any },
          ],
          enabledWorkflowSteps: ["WS-001", "WS-002", "WS-003"],
          workflowStepResults: [
            {
              workflowStepId: "WS-001",
              workflowStepName: "Browser Verification",
              status: "passed",
            },
            {
              workflowStepId: "WS-002",
              workflowStepName: "Frontend UX Design",
              status: "failed",
              phase: "post-merge",
            },
          ],
        })}
        workflowStepNameLookup={new Map([["WS-003", "Accessibility Audit"]])}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const stepNames = Array.from(container.querySelectorAll(".card-step-name")).map((el) => el.textContent);
    expect(stepNames).toEqual([
      "Step 0",
      "Step 1",
      "Browser Verification",
      "Frontend UX Design",
      "Accessibility Audit",
    ]);

    const dots = container.querySelectorAll(".card-step-dot");
    expect(dots[1]?.className).toContain("card-step-dot--failed");
    expect(dots[1]?.className).not.toContain("card-step-dot--workflow-failed");

    expect(dots[2]?.className).toContain("card-step-dot--done");
    expect(dots[2]?.className).not.toContain("card-step-dot--workflow-failed");

    expect(dots[3]?.className).toContain("card-step-dot--failed");
    expect(dots[3]?.className).toContain("card-step-dot--workflow-failed");

    expect(dots[4]?.className).toContain("card-step-dot--pending");
    expect(dots[4]?.className).not.toContain("card-step-dot--workflow-failed");

    const workflowBadgeElements = container.querySelectorAll(".card-step-workflow-badge");
    const workflowBadges = Array.from(workflowBadgeElements).map((el) => el.textContent);
    expect(workflowBadges).toEqual(["workflow", "workflow", "workflow"]);

    expect(workflowBadgeElements[0]?.className).toContain("card-step-workflow-badge--pre-merge");
    expect(workflowBadgeElements[1]?.className).toContain("card-step-workflow-badge--post-merge");
    expect(workflowBadgeElements[2]?.className).toContain("card-step-workflow-badge--pre-merge");

    workflowBadgeElements.forEach((badge) => {
      expect(badge.getAttribute("title")).toBe("Workflow check");
    });
  });

  it("falls back to workflow result name, then raw ID when lookup names are unavailable", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({
          enabledWorkflowSteps: ["WS-002", "WS-003"],
          workflowStepResults: [
            {
              workflowStepId: "WS-002",
              workflowStepName: "Fallback from result",
              status: "passed",
            },
          ],
        })}
        workflowStepNameLookup={new Map([["WS-002", "   "]])}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const stepNames = Array.from(container.querySelectorAll(".card-step-name")).map((el) => el.textContent);
    expect(stepNames).toEqual(["Fallback from result", "WS-003"]);
  });

  it("shows drop indicator on file dragover and removes on dragleave", () => {
    const { container } = render(
      <TaskCard task={makeTask()} onOpenDetail={noop} addToast={noop} />,
    );
    const card = container.querySelector(".card")!;

    // Simulate file dragover
    fireEvent.dragOver(card, {
      dataTransfer: { types: ["Files"], dropEffect: "none" },
    });
    expect(card.classList.contains("file-drop-target")).toBe(true);

    // Simulate dragleave
    fireEvent.dragLeave(card, {
      dataTransfer: { types: ["Files"] },
    });
    expect(card.classList.contains("file-drop-target")).toBe(false);
  });

  it("does not show drop indicator for non-file drag", () => {
    const { container } = render(
      <TaskCard task={makeTask()} onOpenDetail={noop} addToast={noop} />,
    );
    const card = container.querySelector(".card")!;

    // Simulate card dragover (not files)
    fireEvent.dragOver(card, {
      dataTransfer: { types: ["text/plain"], dropEffect: "none" },
    });
    expect(card.classList.contains("file-drop-target")).toBe(false);
  });

  it("calls uploadAttachment on file drop", async () => {
    const mockUpload = vi.mocked(uploadAttachment);
    mockUpload.mockResolvedValue({
      filename: "abc-test.png",
      originalName: "test.png",
      mimeType: "image/png",
      size: 1024,
      createdAt: new Date().toISOString(),
    });
    const addToast = vi.fn();

    const { container } = render(
      <TaskCard task={makeTask()} onOpenDetail={noop} addToast={addToast} />,
    );
    const card = container.querySelector(".card")!;

    const file = new File(["content"], "test.png", { type: "image/png" });
    fireEvent.drop(card, {
      dataTransfer: { types: ["Files"], files: [file] },
    });

    await waitFor(() => {
      expect(mockUpload).toHaveBeenCalledWith("FN-001", file, undefined);
      expect(addToast).toHaveBeenCalledWith(
        expect.stringContaining("Attached test.png"),
        "success",
      );
    });
  });

  it("shows in-review files-changed chip from modifiedFiles fallback when no worktree diff is available", () => {
    const onOpenDetailWithTab = vi.fn();
    const task = makeTask({
      column: "in-review",
      worktree: undefined,
      modifiedFiles: ["packages/dashboard/app/App.tsx", "packages/dashboard/app/styles.css"],
    });

    render(
      <TaskCard
        task={task}
        onOpenDetail={noop}
        addToast={noop}
        onOpenDetailWithTab={onOpenDetailWithTab}
      />,
    );

    const filesChangedButton = screen.getByRole("button", { name: "2 files changed" });
    expect(filesChangedButton).toBeDefined();
    expect((filesChangedButton as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(filesChangedButton);
    expect(onOpenDetailWithTab).toHaveBeenCalledWith(task, "changes");
  });

  it("shows in-progress files-changed chip from modifiedFiles fallback when no live diff is available", () => {
    const onOpenDetailWithTab = vi.fn();
    const task = makeTask({
      column: "in-progress",
      worktree: undefined,
      modifiedFiles: ["packages/core/src/store.ts", "packages/core/src/types.ts"],
    });

    render(
      <TaskCard
        task={task}
        onOpenDetail={noop}
        addToast={noop}
        onOpenDetailWithTab={onOpenDetailWithTab}
      />,
    );

    const filesChangedButton = screen.getByRole("button", { name: "2 files changed" });
    expect(filesChangedButton).toBeDefined();
    expect((filesChangedButton as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(filesChangedButton);
    expect(onOpenDetailWithTab).toHaveBeenCalledWith(task, "changes");
  });

  it("shows error toast when upload fails", async () => {
    const mockUpload = vi.mocked(uploadAttachment);
    mockUpload.mockRejectedValue(new Error("Upload failed"));
    const addToast = vi.fn();

    const { container } = render(
      <TaskCard task={makeTask()} onOpenDetail={noop} addToast={addToast} />,
    );
    const card = container.querySelector(".card")!;

    const file = new File(["content"], "bad.png", { type: "image/png" });
    fireEvent.drop(card, {
      dataTransfer: { types: ["Files"], files: [file] },
    });

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith(
        expect.stringContaining("Failed to attach bad.png"),
        "error",
      );
    });
  });

  // Size badge positioning regression tests (KB-197)
  it("renders size badge for sized tasks", () => {
    const { container } = render(
      <TaskCard task={makeTask({ size: "S" })} onOpenDetail={noop} addToast={noop} />,
    );
    expect(container.querySelector(".card-size-badge")).not.toBeNull();
    expect(screen.getByText("S")).toBeDefined();
  });

  it("does not render size badge when task has no size", () => {
    const { container } = render(
      <TaskCard task={makeTask({ size: undefined })} onOpenDetail={noop} addToast={noop} />,
    );
    expect(container.querySelector(".card-size-badge")).toBeNull();
  });

  it("renders all three size values with correct CSS classes", () => {
    const sizes: Array<"S" | "M" | "L"> = ["S", "M", "L"];
    const expectedClasses = ["size-s", "size-m", "size-l"];

    sizes.forEach((size, index) => {
      const { container } = render(
        <TaskCard task={makeTask({ size })} onOpenDetail={noop} addToast={noop} />,
      );
      const badge = container.querySelector(".card-size-badge");
      expect(badge).not.toBeNull();
      expect(badge?.classList.contains(expectedClasses[index])).toBe(true);
      // Clean up for next iteration
      container.remove();
    });
  });

  it("places size badge inside card-header-actions container", () => {
    const { container } = render(
      <TaskCard task={makeTask({ size: "M" })} onOpenDetail={noop} addToast={noop} />,
    );
    const actionsContainer = container.querySelector(".card-header-actions");
    const sizeBadge = container.querySelector(".card-size-badge");
    
    expect(actionsContainer).not.toBeNull();
    expect(sizeBadge).not.toBeNull();
    expect(actionsContainer?.contains(sizeBadge)).toBe(true);
  });

  it("places card-header-actions after card-id in DOM order", () => {
    const { container } = render(
      <TaskCard task={makeTask({ size: "S" })} onOpenDetail={noop} addToast={noop} />,
    );
    const cardId = container.querySelector(".card-id")!;
    const actionsContainer = container.querySelector(".card-header-actions")!;
    
    expect(cardId).not.toBeNull();
    expect(actionsContainer).not.toBeNull();
    // The actions container should come after card-id
    expect(
      cardId.compareDocumentPosition(actionsContainer) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("renders edit button inside card-header-actions for editable columns", () => {
    const { container } = render(
      <TaskCard 
        task={makeTask({ column: "todo", size: "S" })} 
        onOpenDetail={noop} 
        addToast={noop}
        onUpdateTask={async () => makeTask()}
      />,
    );
    const actionsContainer = container.querySelector(".card-header-actions");
    const editBtn = container.querySelector(".card-edit-btn");
    
    expect(actionsContainer).not.toBeNull();
    expect(editBtn).not.toBeNull();
    expect(actionsContainer?.contains(editBtn)).toBe(true);
  });

  it("renders archive button inside card-header-actions for done column", () => {
    const { container } = render(
      <TaskCard 
        task={makeTask({ column: "done", size: "L" })} 
        onOpenDetail={noop} 
        addToast={noop}
        onArchiveTask={async () => makeTask()}
      />,
    );
    const actionsContainer = container.querySelector(".card-header-actions");
    const archiveBtn = container.querySelector(".card-archive-btn");
    
    expect(actionsContainer).not.toBeNull();
    expect(archiveBtn).not.toBeNull();
    expect(actionsContainer?.contains(archiveBtn)).toBe(true);
  });

  it("shows timer chip for in-progress cards summing workflow runtime + timed events", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "in-progress",
          workflowStepResults: [
            {
              workflowStepId: "step-1",
              workflowStepName: "Plan",
              phase: "pre-merge" as const,
              status: "passed" as const,
              startedAt: "2026-04-25T12:00:00.000Z",
              completedAt: "2026-04-25T12:08:00.000Z",
            },
          ],
          log: [
            {
              timestamp: "2026-04-25T12:09:00.000Z",
              action: "[timing] llm_call in 240000ms",
              outcome: "",
            } as unknown as Task["log"][number],
          ],
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const timer = container.querySelector(".card-time-indicator");
    expect(timer).not.toBeNull();
    // 8m workflow + 4m timed = 12m
    expect(timer?.textContent).toContain("12m");
    expect(timer?.getAttribute("title")).toContain("In progress 12m");
  });

  it("updates the in-progress timer when timedExecutionMs changes", () => {
    const { container, rerender } = render(
      <TaskCard
        task={makeTask({
          column: "in-progress",
          timedExecutionMs: 60_000,
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(container.querySelector(".card-time-indicator")?.textContent).toContain("1m");

    rerender(
      <TaskCard
        task={makeTask({
          column: "in-progress",
          timedExecutionMs: 120_000,
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(container.querySelector(".card-time-indicator")?.textContent).toContain("2m");
  });

  it("shows timer chip for done cards summing workflow runtime + timed events", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "done",
          columnMovedAt: "2026-04-25T15:00:00.000Z",
          updatedAt: "2026-04-25T15:00:00.000Z",
          createdAt: "2026-04-25T13:00:00.000Z",
          workflowStepResults: [
            {
              workflowStepId: "step-1",
              workflowStepName: "Plan",
              phase: "pre-merge" as const,
              status: "passed" as const,
              startedAt: "2026-04-25T13:00:00.000Z",
              completedAt: "2026-04-25T14:00:00.000Z",
            },
          ],
          log: [
            {
              timestamp: "2026-04-25T14:30:00.000Z",
              action: "[timing] llm_call in 3600000ms",
              outcome: "",
            } as unknown as Task["log"][number],
          ],
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const timer = container.querySelector(".card-time-indicator");
    expect(timer).not.toBeNull();
    // 1h workflow + 1h timed = 2h
    expect(timer?.textContent).toContain("2h");
    expect(timer?.getAttribute("title")).toContain("Execution time 2h");
    expect(timer?.getAttribute("title")).toContain("Completed");
  });

  it("renders GitHub provenance marker for github_import tasks", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "todo",
          sourceType: "github_import",
          sourceMetadata: { issueUrl: "https://github.com/owner/repo/issues/42" },
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const footerRow = container.querySelector(".card-footer-row");
    const provenance = container.querySelector(".card-source-provenance");

    expect(footerRow).not.toBeNull();
    expect(provenance).not.toBeNull();
    expect(provenance?.getAttribute("title")).toContain("https://github.com/owner/repo/issues/42");
    expect(screen.getByTestId("provider-icon-github")).toBeDefined();
  });

  it("does not render GitHub provenance marker for non-imported tasks", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "todo",
          sourceType: "dashboard_ui",
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(container.querySelector(".card-source-provenance")).toBeNull();
    expect(screen.queryByTestId("provider-icon-github")).toBeNull();
  });

  it("renders agent-created provenance badge for automation tasks and prefers sourceMetadata.agentName", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "todo",
          sourceType: "automation",
          sourceAgentId: "agent-123",
          sourceMetadata: { agentName: "Task Robot" },
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const badge = container.querySelector(".card-agent-created-badge");
    expect(badge).not.toBeNull();
    expect(badge?.getAttribute("title")).toBe("Created by agent: Task Robot");
  });

  it("renders agent-created provenance badge for agent_heartbeat tasks", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "todo",
          sourceType: "agent_heartbeat",
          sourceAgentId: "heartbeat-agent-1",
          sourceMetadata: { agentName: "Scheduler Bot" },
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const badge = container.querySelector(".card-agent-created-badge");
    expect(badge).not.toBeNull();
    expect(badge?.getAttribute("title")).toBe("Created by agent: Scheduler Bot");
    expect(badge?.getAttribute("aria-label")).toBe("Created by agent: Scheduler Bot");
  });

  it("renders agent-created provenance badge for legacy sourceAgentId-only tasks", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "todo",
          sourceAgentId: "legacy-agent-1",
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const badge = container.querySelector(".card-agent-created-badge");
    expect(badge).not.toBeNull();
    expect(badge?.getAttribute("title")).toBe("Created by agent: legacy-agent-1");
  });

  it("does not render agent-created provenance badge for non-agent task sources", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "todo",
          sourceType: "dashboard_ui",
          sourceAgentId: undefined,
          sourceMetadata: undefined,
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(container.querySelector(".card-agent-created-badge")).toBeNull();
  });

  it("coexists with GitHub badge and timer metadata", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "done",
          sourceType: "github_import",
          sourceAgentId: "agent-42",
          sourceMetadata: { issueUrl: "https://github.com/owner/repo/issues/7" },
          issueInfo: {
            owner: "owner",
            repo: "repo",
            issueNumber: 7,
            state: "open",
            title: "Fix bug",
          } as any,
          executionStartedAt: "2026-04-25T13:00:00.000Z",
          executionCompletedAt: "2026-04-25T15:00:00.000Z",
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(container.querySelector(".card-github-badge")).not.toBeNull();
    expect(container.querySelector(".card-source-provenance")).not.toBeNull();
    expect(container.querySelector(".card-agent-created-badge")).not.toBeNull();
    expect(container.querySelector(".card-time-indicator")).not.toBeNull();
  });

  it("renders files-changed metadata and timer chip in footer row", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "done",
          columnMovedAt: "2026-04-25T15:00:00.000Z",
          updatedAt: "2026-04-25T15:00:00.000Z",
          createdAt: "2026-04-25T13:00:00.000Z",
          workflowStepResults: [
            {
              workflowStepId: "step-1",
              workflowStepName: "Plan",
              phase: "pre-merge" as const,
              status: "passed" as const,
              startedAt: "2026-04-25T13:00:00.000Z",
              completedAt: "2026-04-25T15:00:00.000Z",
            },
          ],
          mergeDetails: {
            commitSha: "abc123",
            filesChanged: 4,
            insertions: 10,
            deletions: 2,
            mergedAt: "2026-04-25T15:00:00.000Z",
            mergeConfirmed: true,
          },
        })}
        onOpenDetail={noop}
        addToast={noop}
        onOpenDetailWithTab={vi.fn()}
      />,
    );

    const header = container.querySelector(".card-header");
    const footerRow = container.querySelector(".card-footer-row");
    const filesChanged = container.querySelector(".card-session-files");
    const timer = container.querySelector(".card-time-indicator");

    expect(header).not.toBeNull();
    expect(footerRow).not.toBeNull();
    expect(filesChanged).not.toBeNull();
    expect(timer).not.toBeNull();
    expect(footerRow?.contains(filesChanged)).toBe(true);
    expect(footerRow?.contains(timer)).toBe(true);
    expect(header?.contains(timer)).toBe(false);
    expect(Array.from(footerRow?.children ?? [])).toEqual([filesChanged, timer]);
  });

  it("shows timer chip for in-review cards", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "in-review",
          workflowStepResults: [
            {
              workflowStepId: "step-1",
              workflowStepName: "Plan",
              phase: "pre-merge" as const,
              status: "passed" as const,
              startedAt: "2026-04-25T12:00:00.000Z",
              completedAt: "2026-04-25T12:08:00.000Z",
            },
          ],
          log: [
            {
              timestamp: "2026-04-25T12:09:00.000Z",
              action: "[timing] llm_call in 240000ms",
              outcome: "",
            } as unknown as Task["log"][number],
          ],
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const timer = container.querySelector(".card-time-indicator");
    expect(timer).not.toBeNull();
    expect(timer?.textContent).toContain("12m");
    expect(timer?.getAttribute("title")).toContain("Execution time 12m");
    expect(timer?.getAttribute("title")).not.toContain("Completed");
  });

  it("keeps the in-review timer live from executionStartedAt when present", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-25T12:30:00.000Z"));

    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "in-review",
          executionStartedAt: "2026-04-25T12:00:00.000Z",
          columnMovedAt: "2026-04-25T12:12:00.000Z",
          updatedAt: "2026-04-25T12:30:00.000Z",
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const timer = container.querySelector(".card-time-indicator");
    expect(timer).not.toBeNull();
    expect(timer?.textContent).toContain("30m");
    expect(timer?.getAttribute("title")).toBe("Execution time 30m");

    act(() => {
      vi.advanceTimersByTime(5 * 60_000);
    });

    expect(container.querySelector(".card-time-indicator")?.textContent).toContain("35m");
    expect(container.querySelector(".card-time-indicator")?.getAttribute("title")).toBe("Execution time 35m");
  });

  it.each(["merging", "merging-fix"] as const)("shows live merge elapsed in timer chip while task.status is %s", (status) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-25T13:45:00.000Z"));

    try {
      const { container } = render(
        <TaskCard
          task={makeTask({
            column: "in-review",
            status,
            executionStartedAt: "2026-04-25T13:00:00.000Z",
            updatedAt: "2026-04-25T13:44:30.000Z",
            workflowStepResults: [
              {
                workflowStepId: "step-1",
                workflowStepName: "Plan",
                phase: "pre-merge" as const,
                status: "passed" as const,
                startedAt: "2026-04-25T12:00:00.000Z",
                completedAt: "2026-04-25T12:03:00.000Z",
              },
            ],
          })}
          onOpenDetail={noop}
          addToast={noop}
        />,
      );

      const timer = container.querySelector(".card-time-indicator");
      expect(timer).not.toBeNull();
      expect(timer?.textContent).toContain("45m");
      expect(timer?.getAttribute("title")).toBe("Execution time 45m. Merge phase <1m");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not render timer chip for in-review cards without instrumentation data", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "in-review",
          workflowStepResults: undefined,
          log: [],
          timedExecutionMs: undefined,
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(container.querySelector(".card-time-indicator")).toBeNull();
  });

  it.each(["triage", "todo", "archived"] as const)(
    "does not render timer chip for %s cards",
    (column) => {
      const { container } = render(
        <TaskCard
          task={makeTask({
            column,
            workflowStepResults: [
              {
                workflowStepId: "step-1",
                workflowStepName: "Plan",
                phase: "pre-merge" as const,
                status: "passed" as const,
                startedAt: "2026-04-25T13:00:00.000Z",
                completedAt: "2026-04-25T15:00:00.000Z",
              },
            ],
          })}
          onOpenDetail={noop}
          addToast={noop}
        />,
      );

      expect(container.querySelector(".card-time-indicator")).toBeNull();
    },
  );

  it("shows wall-clock timer for in-progress cards when columnMovedAt is available", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-25T12:05:00.000Z"));

    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "in-progress",
          columnMovedAt: "2026-04-25T12:00:00.000Z",
          updatedAt: "2026-04-25T12:00:00.000Z",
          createdAt: "2026-04-25T11:58:00.000Z",
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const timer = container.querySelector(".card-time-indicator");
    expect(timer?.textContent).toContain("5m");
    expect(timer?.getAttribute("title")).toContain("In progress 5m");
  });

  it("prefers executionStartedAt over a newer columnMovedAt for in-progress timers", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-25T12:10:00.000Z"));

    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "in-progress",
          columnMovedAt: "2026-04-25T12:08:00.000Z",
          executionStartedAt: "2026-04-25T12:00:00.000Z",
          updatedAt: "2026-04-25T12:08:00.000Z",
          createdAt: "2026-04-25T11:58:00.000Z",
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const timer = container.querySelector(".card-time-indicator");
    expect(timer?.textContent).toContain("10m");
    expect(timer?.getAttribute("title")).toContain("In progress 10m");
  });

  it("does not render timer chip on done card without instrumentation, even with old timestamps", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "done",
          createdAt: "2026-04-25T10:00:00.000Z",
          columnMovedAt: "2026-04-25T12:30:00.000Z",
          updatedAt: "2026-04-25T12:30:00.000Z",
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(container.querySelector(".card-time-indicator")).toBeNull();
  });

  describe("formatElapsedDuration rounding for done tasks", () => {
    it.each([
      [59_999, "1m"],
      [60_000, "1m"],
      [90_000, "2m"],
      [3_540_000, "1h"],
      [3_600_000, "1h"],
      [86_400_000, "1d"],
    ])("formats %dms as %s for done tasks", (elapsedMs, expected) => {
      expect(formatElapsedDurationDone(elapsedMs)).toBe(expected);
    });

    it("keeps in-progress rounding with floor semantics", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-04-25T12:01:30.000Z"));

      const { container } = render(
        <TaskCard
          task={makeTask({
            column: "in-progress",
            workflowStepResults: [
              {
                workflowStepId: "step-1",
                workflowStepName: "Plan",
                phase: "pre-merge" as const,
                status: "pending" as const,
                startedAt: "2026-04-25T12:00:00.000Z",
              },
            ],
          })}
          onOpenDetail={noop}
          addToast={noop}
        />,
      );

      expect(container.querySelector(".card-time-indicator")?.textContent).toContain("1m");
    });

    it("renders done-card timer with ceiling rounding for fractional minutes", () => {
      const { container } = render(
        <TaskCard
          task={makeTask({
            column: "done",
            createdAt: "2026-04-25T12:00:00.000Z",
            columnMovedAt: "2026-04-25T12:04:30.000Z",
            updatedAt: "2026-04-25T12:04:30.000Z",
            workflowStepResults: [
              {
                workflowStepId: "step-1",
                workflowStepName: "Plan",
                phase: "pre-merge" as const,
                status: "passed" as const,
                startedAt: "2026-04-25T12:00:00.000Z",
                completedAt: "2026-04-25T12:04:30.000Z",
              },
            ],
          })}
          onOpenDetail={noop}
          addToast={noop}
        />,
      );

      expect(container.querySelector(".card-time-indicator")?.textContent).toContain("5m");
    });
  });

  it("live-ticks workflow runtime for in-progress steps", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-25T12:00:30.000Z"));

    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "in-progress",
          workflowStepResults: [
            {
              workflowStepId: "step-1",
              workflowStepName: "Plan",
              phase: "pre-merge" as const,
              status: "pending" as const,
              startedAt: "2026-04-25T12:00:00.000Z",
            },
          ],
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const timer = container.querySelector(".card-time-indicator");
    expect(timer?.textContent).toContain("<1m");

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(container.querySelector(".card-time-indicator")?.textContent).toContain("1m");
  });
});

describe("TaskCard provider icons on agent row", () => {
  it("renders provider icons when task has model overrides", () => {
    render(
      <TaskCard
        task={makeTask({ modelProvider: "anthropic", assignedAgentId: "agent-1" })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(screen.getByTestId("card-provider-icons")).toBeDefined();
    expect(screen.getByTestId("provider-icon-anthropic")).toBeDefined();
  });

  it("deduplicates when executor and validator use same provider", () => {
    render(
      <TaskCard
        task={makeTask({
          modelProvider: "openai",
          validatorModelProvider: "openai",
          planningModelProvider: "anthropic",
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const icons = screen.getByTestId("card-provider-icons");
    expect(icons.querySelectorAll("[data-testid^='provider-icon-']").length).toBe(2);
    expect(screen.getByTestId("provider-icon-openai")).toBeDefined();
    expect(screen.getByTestId("provider-icon-anthropic")).toBeDefined();
  });

  it("renders agent row with provider icons even without assignedAgentId", () => {
    render(
      <TaskCard
        task={makeTask({ modelProvider: "anthropic", assignedAgentId: undefined })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(screen.getByTestId("card-provider-icons")).toBeDefined();
    expect(screen.getByTestId("provider-icon-anthropic")).toBeDefined();
  });

  it("does not render provider icons when no model overrides set", () => {
    render(
      <TaskCard
        task={makeTask({ assignedAgentId: "agent-1" })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(screen.queryByTestId("card-provider-icons")).toBeNull();
  });
});

describe("TaskCard memo comparator provenance behavior", () => {
  it("returns false when sourceMetadata.agentName changes", () => {
    const previousTask = makeTask({ sourceType: "automation", sourceMetadata: { agentName: "Agent One" } });
    const nextTask = makeTask({ sourceType: "automation", sourceMetadata: { agentName: "Agent Two" } });

    const previousProps = {
      task: previousTask,
      onOpenDetail: noop,
      addToast: noop,
    };
    const nextProps = {
      task: nextTask,
      onOpenDetail: noop,
      addToast: noop,
    };

    expect(__test_areTaskCardPropsEqual(previousProps as any, nextProps as any)).toBe(false);
  });

  it("returns false when sourceType changes", () => {
    const previousTask = makeTask({ sourceType: "automation", sourceMetadata: { agentName: "Agent" } });
    const nextTask = makeTask({ sourceType: "dashboard_ui", sourceMetadata: { agentName: "Agent" } });

    expect(
      __test_areTaskCardPropsEqual(
        { task: previousTask, onOpenDetail: noop, addToast: noop } as any,
        { task: nextTask, onOpenDetail: noop, addToast: noop } as any,
      ),
    ).toBe(false);
  });

  it("returns false when sourceAgentId changes", () => {
    const previousTask = makeTask({ sourceType: "automation", sourceAgentId: "agent-a" });
    const nextTask = makeTask({ sourceType: "automation", sourceAgentId: "agent-b" });

    expect(
      __test_areTaskCardPropsEqual(
        { task: previousTask, onOpenDetail: noop, addToast: noop } as any,
        { task: nextTask, onOpenDetail: noop, addToast: noop } as any,
      ),
    ).toBe(false);
  });

  it("returns false when branch changes", () => {
    const previousTask = makeTask({ branch: "feature/old", baseBranch: "main" });
    const nextTask = makeTask({ branch: "feature/new", baseBranch: "main" });

    expect(
      __test_areTaskCardPropsEqual(
        { task: previousTask, onOpenDetail: noop, addToast: noop } as any,
        { task: nextTask, onOpenDetail: noop, addToast: noop } as any,
      ),
    ).toBe(false);
  });

  it("returns false when baseBranch changes", () => {
    const previousTask = makeTask({ branch: "fusion/fn-001", baseBranch: "main" });
    const nextTask = makeTask({ branch: "fusion/fn-001", baseBranch: "release/2026-05" });

    expect(
      __test_areTaskCardPropsEqual(
        { task: previousTask, onOpenDetail: noop, addToast: noop } as any,
        { task: nextTask, onOpenDetail: noop, addToast: noop } as any,
      ),
    ).toBe(false);
  });
});

describe("TaskCard mission badge", () => {
  // Access the internal cache reset helper
  let clearCache: () => void;

  beforeAll(async () => {
    const mod = await import("../TaskCard");
    clearCache = (mod as any).__test_clearMissionTitleCache;
  });

  beforeEach(() => {
    clearCache?.();
    vi.mocked(fetchMission).mockReset();
  });

  it("displays mission title instead of missionId", async () => {
    vi.mocked(fetchMission).mockResolvedValue({
      id: "M-ABC123",
      title: "Database Optimization",
      status: "active",
      interviewState: "completed",
      milestones: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const { container } = render(
      <TaskCard
        task={makeTask({ missionId: "M-ABC123" })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const badge = container.querySelector(".card-mission-badge");
    expect(badge).not.toBeNull();

    await waitFor(() => {
      // MAX_MISSION_TITLE_LENGTH is 12, so first 9 chars + "..."
      expect(badge?.textContent).toContain("Database ...");
    });
  });

  it("abbreviates long mission titles with ellipsis", async () => {
    vi.mocked(fetchMission).mockResolvedValue({
      id: "M-LONG1",
      title: "This Is A Very Long Mission Title That Exceeds Twenty Characters",
      status: "active",
      interviewState: "completed",
      milestones: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const { container } = render(
      <TaskCard
        task={makeTask({ missionId: "M-LONG1" })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const badge = container.querySelector(".card-mission-badge");
    expect(badge).not.toBeNull();

    await waitFor(() => {
      // MAX_MISSION_TITLE_LENGTH is 12, so first 9 chars + "..."
      expect(badge?.textContent).toContain("This Is A...");
    });
  });

  it("falls back to missionId on fetch error", async () => {
    vi.mocked(fetchMission).mockRejectedValue(new Error("Network error"));

    const { container } = render(
      <TaskCard
        task={makeTask({ missionId: "M-ERR99" })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const badge = container.querySelector(".card-mission-badge");
    expect(badge).not.toBeNull();

    await waitFor(() => {
      expect(badge?.textContent).toContain("M-ERR99");
    });
  });

  it("shows mission title in title attribute", async () => {
    vi.mocked(fetchMission).mockResolvedValue({
      id: "M-TITLE",
      title: "Refactor Auth",
      status: "active",
      interviewState: "completed",
      milestones: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const { container } = render(
      <TaskCard
        task={makeTask({ missionId: "M-TITLE" })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const badge = container.querySelector(".card-mission-badge");
    expect(badge).not.toBeNull();

    await waitFor(() => {
      expect(badge?.getAttribute("title")).toBe("Mission: Refactor Auth");
    });
  });

  it("shows short mission title without abbreviation", async () => {
    vi.mocked(fetchMission).mockResolvedValue({
      id: "M-SHORT",
      title: "Auth Fix",
      status: "active",
      interviewState: "completed",
      milestones: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const { container } = render(
      <TaskCard
        task={makeTask({ missionId: "M-SHORT" })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const badge = container.querySelector(".card-mission-badge");
    expect(badge).not.toBeNull();

    await waitFor(() => {
      // "Auth Fix" is 8 chars, well under 20 — no abbreviation needed
      expect(badge?.textContent).toContain("Auth Fix");
      expect(badge?.textContent).not.toContain("...");
    });
  });
});

describe("TaskCard agent badge", () => {
  let clearAgentCache: () => void;

  beforeAll(async () => {
    const mod = await import("../TaskCard");
    clearAgentCache = (mod as { __test_clearAgentNameCache?: () => void }).__test_clearAgentNameCache ?? (() => undefined);
  });

  beforeEach(() => {
    clearAgentCache?.();
    vi.mocked(fetchAgent).mockReset();
  });

  it("renders agent badge when task has assignedAgentId", async () => {
    vi.mocked(fetchAgent).mockResolvedValue({
      id: "agent-001",
      name: "Task Robot",
      role: "executor",
      state: "active",
      metadata: {},
      heartbeatHistory: [],
      completedRuns: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as any);

    render(
      <TaskCard
        task={makeTask({ assignedAgentId: "agent-001" })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTitle("Assigned to Task Robot")).toBeDefined();
      expect(screen.getByText("Task Robot")).toBeDefined();
    });
  });

  it("does not render agent badge when assignedAgentId is undefined", () => {
    render(
      <TaskCard
        task={makeTask()}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(screen.queryByTitle(/Assigned to/)).toBeNull();
  });
});
