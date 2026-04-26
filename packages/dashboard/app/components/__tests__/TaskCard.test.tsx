import { afterEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { TaskCard } from "../TaskCard";
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

  it("renders fast-mode indicator only when executionMode is fast", () => {
    const { container, rerender } = render(
      <TaskCard task={makeTask({ executionMode: "fast" })} onOpenDetail={noop} addToast={noop} />,
    );

    expect(container.querySelector(".card-execution-mode-badge")?.textContent).toBe("Fast");

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

    expect(container.querySelector(".card-execution-mode-badge")?.textContent).toBe("Fast");
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
            { name: "Step 1", status: "failed" },
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

  it("shows timer chip for in-progress cards when timestamp fields exist", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-25T12:30:00.000Z"));

    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "in-progress",
          columnMovedAt: "2026-04-25T12:18:00.000Z",
          updatedAt: "2026-04-25T12:10:00.000Z",
          createdAt: "2026-04-25T12:00:00.000Z",
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const timer = container.querySelector(".card-time-indicator");
    expect(timer).not.toBeNull();
    expect(timer?.textContent).toContain("12m");
    expect(timer?.getAttribute("title")).toContain("In progress since");
    expect(timer?.getAttribute("aria-label")).toContain("Elapsed time 12m");
  });

  it("shows fixed processing-duration timer chip for done cards", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-25T18:00:00.000Z"));

    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "done",
          columnMovedAt: "2026-04-25T15:00:00.000Z",
          updatedAt: "2026-04-25T15:00:00.000Z",
          createdAt: "2026-04-25T13:00:00.000Z",
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const timer = container.querySelector(".card-time-indicator");
    expect(timer).not.toBeNull();
    expect(timer?.textContent).toContain("2h");
    expect(timer?.getAttribute("title")).toContain("Processing took 2h");
    expect(timer?.getAttribute("aria-label")).toContain("Completed processing duration 2h");
  });

  it("renders files-changed metadata and timer chip in the same footer row", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-25T18:00:00.000Z"));

    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "done",
          columnMovedAt: "2026-04-25T15:00:00.000Z",
          updatedAt: "2026-04-25T15:00:00.000Z",
          createdAt: "2026-04-25T13:00:00.000Z",
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

    const footerRow = container.querySelector(".card-footer-row");
    const filesChanged = container.querySelector(".card-session-files");
    const timer = container.querySelector(".card-time-indicator");

    expect(footerRow).not.toBeNull();
    expect(filesChanged).not.toBeNull();
    expect(timer).not.toBeNull();
    expect(footerRow?.contains(filesChanged)).toBe(true);
    expect(footerRow?.contains(timer)).toBe(true);
    expect(filesChanged?.nextElementSibling).toBe(timer);
    expect(Array.from(footerRow?.children ?? [])).toEqual([filesChanged, timer]);
  });
  it.each(["triage", "todo", "in-review", "archived"] as const)(
    "does not render timer chip for %s cards",
    (column) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-04-25T18:00:00.000Z"));

      const { container } = render(
        <TaskCard
          task={makeTask({
            column,
            columnMovedAt: "2026-04-25T15:00:00.000Z",
            updatedAt: "2026-04-25T14:00:00.000Z",
            createdAt: "2026-04-25T13:00:00.000Z",
          })}
          onOpenDetail={noop}
          addToast={noop}
        />,
      );

      expect(container.querySelector(".card-time-indicator")).toBeNull();
    },
  );

  it("suppresses timer chip when all timestamp fallbacks are invalid or missing", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-25T18:00:00.000Z"));

    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "in-progress",
          columnMovedAt: "not-a-date",
          updatedAt: "also-not-a-date",
          createdAt: undefined as unknown as string,
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(container.querySelector(".card-time-indicator")).toBeNull();
  });

  it.each([
    {
      createdAt: "2026-04-25T09:00:00.000Z",
      columnMovedAt: "2026-04-25T09:00:59.000Z",
      expected: "<1m",
    },
    {
      createdAt: "2026-04-25T09:00:00.000Z",
      columnMovedAt: "2026-04-25T10:00:00.000Z",
      expected: "1h",
    },
    {
      createdAt: "2026-04-25T09:00:00.000Z",
      columnMovedAt: "2026-04-26T09:00:00.000Z",
      expected: "1d",
    },
  ])(
    "formats done processing-duration label as $expected at boundary",
    ({ createdAt, columnMovedAt, expected }) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-04-26T12:00:00.000Z"));

      const { container } = render(
        <TaskCard
          task={makeTask({
            column: "done",
            columnMovedAt,
            updatedAt: columnMovedAt,
            createdAt,
          })}
          onOpenDetail={noop}
          addToast={noop}
        />,
      );

      const timer = container.querySelector(".card-time-indicator");
      expect(timer).not.toBeNull();
      expect(timer?.textContent).toContain(expected);
    },
  );

  it("keeps done processing-duration timer stable when clock advances", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-25T18:00:00.000Z"));

    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "done",
          columnMovedAt: "2026-04-25T15:00:00.000Z",
          updatedAt: "2026-04-25T15:00:00.000Z",
          createdAt: "2026-04-25T13:00:00.000Z",
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(container.querySelector(".card-time-indicator")?.textContent).toContain("2h");

    act(() => {
      vi.advanceTimersByTime(2 * 60 * 60_000);
    });

    expect(container.querySelector(".card-time-indicator")?.textContent).toContain("2h");
  });

  it("uses createdAt for done duration when updatedAt equals completion timestamp", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-25T18:00:00.000Z"));

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

    const timer = container.querySelector(".card-time-indicator");
    expect(timer).not.toBeNull();
    expect(timer?.textContent).toContain("2h");
    expect(timer?.textContent).not.toContain("<1m");
    expect(timer?.getAttribute("title")).toContain("Processing took 2h");
  });

  it("refreshes in-progress timer chip on 30s cadence", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-25T12:00:30.000Z"));

    const { container } = render(
      <TaskCard
        task={makeTask({
          column: "in-progress",
          columnMovedAt: "2026-04-25T12:00:00.000Z",
          updatedAt: "2026-04-25T11:59:00.000Z",
          createdAt: "2026-04-25T11:58:00.000Z",
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
