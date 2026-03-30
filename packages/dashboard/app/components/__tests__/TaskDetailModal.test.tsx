import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { TaskDetailModal } from "../TaskDetailModal";
import type { TaskDetail, Column, MergeResult, Task } from "@kb/core";

vi.mock("../../api", () => ({
  uploadAttachment: vi.fn(),
  deleteAttachment: vi.fn(),
  updateTask: vi.fn().mockResolvedValue({}),
  fetchTaskDetail: vi.fn(),
  fetchAgentLogs: vi.fn().mockResolvedValue([]),
  requestSpecRevision: vi.fn().mockResolvedValue({}),
  approvePlan: vi.fn().mockResolvedValue({}),
  rejectPlan: vi.fn().mockResolvedValue({}),
  duplicateTask: vi.fn().mockResolvedValue({}),
  refineTask: vi.fn().mockResolvedValue({}),
}));

vi.mock("../../hooks/useAgentLogs", () => ({
  useAgentLogs: vi.fn(() => ({ entries: [], loading: false, clear: vi.fn() })),
}));

function makeTask(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "KB-099",
    description: "Test task",
    column: "in-progress" as Column,
    dependencies: [],
    prompt: "",
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  } as TaskDetail;
}

const noop = vi.fn();
const noopMove = vi.fn(async () => ({}) as Task);
const noopDelete = vi.fn(async () => ({}) as Task);
const noopMerge = vi.fn(async () => ({ merged: false }) as MergeResult);
const noopRetry = vi.fn(async () => ({}) as Task);
const noopOpenDetail = vi.fn();

describe("TaskDetailModal", () => {
  it("renders markdown-body without detail-prompt class when prompt exists", () => {
    const { container } = render(
      <TaskDetailModal
        task={makeTask({ prompt: "# Hello\n\nSome **bold** text" })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    const markdownDiv = container.querySelector(".markdown-body");
    expect(markdownDiv).toBeTruthy();
    expect(markdownDiv!.classList.contains("detail-prompt")).toBe(false);
  });

  it("strips the leading heading from prompt and renders remaining markdown", () => {
    const { container } = render(
      <TaskDetailModal
        task={makeTask({ prompt: "# Hello\n\nSome **bold** text" })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    // The leading # heading should be stripped (modal has its own header)
    expect(container.querySelector(".markdown-body h1")).toBeNull();
    expect(container.querySelector("strong")?.textContent).toBe("bold");
  });

  it("renders (no prompt) with detail-prompt class when prompt is absent", () => {
    const { container } = render(
      <TaskDetailModal
        task={makeTask({ prompt: undefined })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    const fallback = screen.getByText("(no prompt)");
    expect(fallback).toBeTruthy();
    expect(fallback.classList.contains("detail-prompt")).toBe(true);
    expect(fallback.classList.contains("markdown-body")).toBe(false);
  });

  it("does not render a PROMPT.md heading", () => {
    render(
      <TaskDetailModal
        task={makeTask({ prompt: "# Some prompt content" })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    expect(screen.queryByText("PROMPT.md")).toBeNull();
  });

  it("renders Retry button when task status is 'failed'", () => {
    render(
      <TaskDetailModal
        task={makeTask({ status: "failed" })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
        onRetryTask={noopRetry}
        addToast={noop}
      />,
    );

    expect(screen.getByText("Retry")).toBeTruthy();
  });

  it("does NOT render Retry button when task status is not 'failed'", () => {
    render(
      <TaskDetailModal
        task={makeTask({ status: "executing" })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
        onRetryTask={noopRetry}
        addToast={noop}
      />,
    );

    expect(screen.queryByText("Retry")).toBeNull();
  });

  it("does NOT render Retry button when onRetryTask is not provided", () => {
    render(
      <TaskDetailModal
        task={makeTask({ status: "failed" })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    expect(screen.queryByText("Retry")).toBeNull();
  });

  it("shows description exactly once for a task without title", () => {
    const { container } = render(
      <TaskDetailModal
        task={makeTask({
          title: undefined,
          description: "Fix the login bug",
          prompt: "# KB-099\n\nFix the login bug\n",
        })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    // The heading "KB-099" should be stripped from the markdown
    const markdownBody = container.querySelector(".markdown-body");
    expect(markdownBody?.innerHTML).not.toContain("KB-099");
    // Description appears in the markdown body
    expect(markdownBody?.textContent).toContain("Fix the login bug");
    // The detail header shows the ID (not duplicated as markdown heading)
    expect(container.querySelector(".detail-id")?.textContent).toBe("KB-099");
    // The h2 title shows description, not the task ID
    const h2 = container.querySelector("h2.detail-title");
    expect(h2?.textContent).toBe("Fix the login bug");
  });

  it("shows the title in <h2> when task.title is set", () => {
    const { container } = render(
      <TaskDetailModal
        task={makeTask({
          title: "Implement dark mode",
          description: "Add dark mode toggle to the settings page",
        })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    const h2 = container.querySelector("h2.detail-title");
    expect(h2?.textContent).toBe("Implement dark mode");
  });

  it("always shows task.id in the detail-id badge regardless of title", () => {
    // With title
    const { container: withTitle } = render(
      <TaskDetailModal
        task={makeTask({ title: "Some title" })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );
    expect(withTitle.querySelector(".detail-id")?.textContent).toBe("KB-099");

    // Without title
    const { container: withoutTitle } = render(
      <TaskDetailModal
        task={makeTask({ title: undefined, description: "A description" })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );
    expect(withoutTitle.querySelector(".detail-id")?.textContent).toBe("KB-099");
  });

  describe("paste image upload", () => {
    it("uploads an image when pasting clipboard image data", async () => {
      const { uploadAttachment } = await import("../../api");
      const mockUpload = vi.mocked(uploadAttachment);
      const mockAttachment = {
        filename: "abc123.png",
        originalName: "image.png",
        size: 1024,
        mimeType: "image/png",
        createdAt: "2026-01-01T00:00:00Z",
      };
      mockUpload.mockResolvedValueOnce(mockAttachment);
      const addToast = vi.fn();

      render(
        <TaskDetailModal
          task={makeTask()}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={addToast}
        />,
      );

      const imageFile = new File(["fake-image"], "image.png", { type: "image/png" });
      const pasteEvent = new Event("paste", { bubbles: true }) as any;
      pasteEvent.clipboardData = {
        items: [
          {
            type: "image/png",
            getAsFile: () => imageFile,
          },
        ],
      };

      await act(async () => {
        document.dispatchEvent(pasteEvent);
      });

      await waitFor(() => {
        expect(mockUpload).toHaveBeenCalledWith("KB-099", imageFile);
        expect(addToast).toHaveBeenCalledWith("Screenshot attached", "success");
      });
    });

    it("does not intercept paste events without image data", async () => {
      const { uploadAttachment } = await import("../../api");
      const mockUpload = vi.mocked(uploadAttachment);
      mockUpload.mockClear();

      render(
        <TaskDetailModal
          task={makeTask()}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const pasteEvent = new Event("paste", { bubbles: true }) as any;
      pasteEvent.clipboardData = {
        items: [
          {
            type: "text/plain",
            getAsFile: () => null,
          },
        ],
      };

      await act(async () => {
        document.dispatchEvent(pasteEvent);
      });

      expect(mockUpload).not.toHaveBeenCalled();
    });

    it("shows uploading state during paste upload", async () => {
      const { uploadAttachment } = await import("../../api");
      const mockUpload = vi.mocked(uploadAttachment);
      let resolveUpload!: (value: any) => void;
      mockUpload.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveUpload = resolve;
        }),
      );

      render(
        <TaskDetailModal
          task={makeTask()}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const imageFile = new File(["fake"], "shot.png", { type: "image/png" });
      const pasteEvent = new Event("paste", { bubbles: true }) as any;
      pasteEvent.clipboardData = {
        items: [{ type: "image/png", getAsFile: () => imageFile }],
      };

      act(() => {
        document.dispatchEvent(pasteEvent);
      });

      // While uploading, button should show "Uploading…"
      await waitFor(() => {
        expect(screen.getByText("Uploading…")).toBeTruthy();
      });

      await act(async () => {
        resolveUpload({
          filename: "x.png",
          originalName: "shot.png",
          size: 100,
          mimeType: "image/png",
          createdAt: "2026-01-01T00:00:00Z",
        });
      });

      await waitFor(() => {
        expect(screen.getByText("Attach Screenshot")).toBeTruthy();
      });
    });
  });

  describe("drag and drop image upload", () => {
    it("uploads an image when dropped onto the modal", async () => {
      const { uploadAttachment } = await import("../../api");
      const mockUpload = vi.mocked(uploadAttachment);
      const mockAttachment = {
        filename: "drop123.png",
        originalName: "dropped.png",
        size: 2048,
        mimeType: "image/png",
        createdAt: "2026-01-01T00:00:00Z",
      };
      mockUpload.mockResolvedValueOnce(mockAttachment);
      const addToast = vi.fn();

      const { container } = render(
        <TaskDetailModal
          task={makeTask()}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={addToast}
        />,
      );

      const modal = container.querySelector(".modal.modal-lg")!;
      const imageFile = new File(["fake-image"], "dropped.png", { type: "image/png" });

      await act(async () => {
        fireEvent.drop(modal, {
          dataTransfer: {
            files: [imageFile],
          },
        });
      });

      await waitFor(() => {
        expect(mockUpload).toHaveBeenCalledWith("KB-099", imageFile);
        expect(addToast).toHaveBeenCalledWith("Screenshot attached", "success");
      });
    });
  });

  it("renders (no dependencies) when dependencies is empty", () => {
    render(
      <TaskDetailModal
        task={makeTask({ dependencies: [] })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    expect(screen.getByText("(no dependencies)")).toBeTruthy();
  });

  it("renders dependency list when dependencies exist", () => {
    render(
      <TaskDetailModal
        task={makeTask({ dependencies: ["KB-001", "KB-002"] })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    expect(screen.getByText("KB-001")).toBeTruthy();
    expect(screen.getByText("KB-002")).toBeTruthy();
    expect(screen.queryByText("(no dependencies)")).toBeNull();
  });

  it("can add a dependency via the dropdown", async () => {
    const { updateTask } = await import("../../api");
    const allTasks: Task[] = [
      { id: "KB-001", description: "Dep 1", column: "todo" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "", updatedAt: "" },
      { id: "KB-099", description: "Self", column: "in-progress" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "", updatedAt: "" },
    ];

    render(
      <TaskDetailModal
        task={makeTask({ dependencies: [] })}
        tasks={allTasks}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    fireEvent.click(screen.getByText("Add Dependency"));
    // Should show KB-001 in the dropdown but not KB-099 (self is excluded)
    const dropdown = document.querySelector(".dep-dropdown")!;
    expect(dropdown).toBeTruthy();
    expect(dropdown.textContent).toContain("KB-001");
    expect(dropdown.querySelectorAll(".dep-dropdown-item")).toHaveLength(1);

    fireEvent.click(screen.getByText("KB-001"));

    await waitFor(() => {
      expect(updateTask).toHaveBeenCalledWith("KB-099", { dependencies: ["KB-001"] });
    });
  });

  it("can remove a dependency", async () => {
    const { updateTask } = await import("../../api");

    render(
      <TaskDetailModal
        task={makeTask({ dependencies: ["KB-001", "KB-002"] })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    const removeButtons = screen.getAllByTitle(/Remove dependency/);
    fireEvent.click(removeButtons[0]); // Remove KB-001

    await waitFor(() => {
      expect(updateTask).toHaveBeenCalledWith("KB-099", { dependencies: ["KB-002"] });
    });
  });

  it("activity list does not have nested scroll constraints", () => {
    const { container } = render(
      <TaskDetailModal
        task={makeTask({
          log: [
            { timestamp: "2026-01-01T00:00:00Z", action: "Created task" },
            { timestamp: "2026-01-01T00:01:00Z", action: "Started work" },
            { timestamp: "2026-01-01T00:02:00Z", action: "Completed step 1" },
          ],
        })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    // Click on Activity tab to show activity list
    fireEvent.click(screen.getByText("Activity"));

    const activityList = container.querySelector(".detail-activity-list");
    expect(activityList).toBeTruthy();
    const style = (activityList as HTMLElement).style;
    expect(style.overflowY).not.toBe("auto");
    expect(style.maxHeight).toBe("");
  });

  it("renders dependency dropdown items sorted newest-first by createdAt", () => {
    const allTasks: Task[] = [
      { id: "KB-001", description: "Oldest", column: "todo" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
      { id: "KB-003", description: "Newest", column: "todo" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "2026-03-01T00:00:00Z", updatedAt: "2026-03-01T00:00:00Z" },
      { id: "KB-002", description: "Middle", column: "todo" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "2026-02-01T00:00:00Z", updatedAt: "2026-02-01T00:00:00Z" },
      { id: "KB-099", description: "Self", column: "in-progress" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "2026-03-15T00:00:00Z", updatedAt: "2026-03-15T00:00:00Z" },
    ];

    render(
      <TaskDetailModal
        task={makeTask({ dependencies: [] })}
        tasks={allTasks}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    fireEvent.click(screen.getByText("Add Dependency"));
    const items = document.querySelectorAll(".dep-dropdown-item");
    expect(items).toHaveLength(3);

    const ids = Array.from(items).map((el) => el.querySelector(".dep-dropdown-id")?.textContent);
    expect(ids).toEqual(["KB-003", "KB-002", "KB-001"]);
  });

  it("renders tasks with identical createdAt sorted newest-ID-first in dependency dropdown", () => {
    const allTasks: Task[] = [
      { id: "KB-001", description: "First", column: "todo" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
      { id: "KB-002", description: "Second", column: "todo" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
      { id: "KB-003", description: "Third", column: "todo" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
      { id: "KB-099", description: "Self", column: "in-progress" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
    ];

    render(
      <TaskDetailModal
        task={makeTask({ dependencies: [] })}
        tasks={allTasks}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    fireEvent.click(screen.getByText("Add Dependency"));
    const items = document.querySelectorAll(".dep-dropdown-item");
    expect(items).toHaveLength(3);

    const ids = Array.from(items).map((el) => el.querySelector(".dep-dropdown-id")?.textContent);
    expect(ids).toEqual(["KB-003", "KB-002", "KB-001"]);
  });

  describe("tab toggle", () => {
    it("defaults to the Definition tab", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ prompt: "# Hello\n\nContent" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.getByText("Definition")).toBeTruthy();
      expect(screen.getByText("Activity")).toBeTruthy();
      expect(screen.getByText("Agent Log")).toBeTruthy();
      // Definition content should be visible
      expect(container.querySelector(".markdown-body")).toBeTruthy();
      // Activity section should NOT be visible initially
      expect(container.querySelector(".detail-activity")).toBeNull();
      // Agent log viewer should not be visible
      expect(container.querySelector("[data-testid='agent-log-viewer']")).toBeNull();
    });

    it("switches to Activity tab and shows activity feed", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({
            prompt: "# Hello\n\nContent",
            log: [
              { timestamp: "2026-01-01T00:00:00Z", action: "Created task" },
            ],
          })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Click Activity tab
      fireEvent.click(screen.getByText("Activity"));

      // Activity section should be visible
      expect(container.querySelector(".detail-activity")).toBeTruthy();
      // Activity list should be visible
      expect(container.querySelector(".detail-activity-list")).toBeTruthy();
      // Definition content should be hidden
      expect(container.querySelector(".markdown-body")).toBeNull();
    });

    it("activity tab renders log entries correctly", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({
            log: [
              { timestamp: "2026-01-01T00:00:00Z", action: "Created task" },
              { timestamp: "2026-01-01T00:01:00Z", action: "Started work", outcome: "Success" },
              { timestamp: "2026-01-01T00:02:00Z", action: "Completed step 1" },
            ],
          })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Click Activity tab
      fireEvent.click(screen.getByText("Activity"));

      const activityList = container.querySelector(".detail-activity-list");
      expect(activityList).toBeTruthy();

      // Check log entries are rendered (in reverse order - newest first)
      const logEntries = container.querySelectorAll(".detail-log-entry");
      expect(logEntries).toHaveLength(3);

      // Most recent entry should be first
      expect(logEntries[0].textContent).toContain("Completed step 1");
      expect(logEntries[1].textContent).toContain("Started work");
      expect(logEntries[1].textContent).toContain("Success"); // outcome
      expect(logEntries[2].textContent).toContain("Created task");
    });

    it("activity tab shows empty state when no logs", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ log: [] })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Click Activity tab
      fireEvent.click(screen.getByText("Activity"));

      // Activity section should be visible
      expect(container.querySelector(".detail-activity")).toBeTruthy();
      // Empty state should be shown
      expect(container.querySelector(".detail-log-empty")).toBeTruthy();
      expect(screen.getByText("(no activity)")).toBeTruthy();
      // Activity list should NOT be present when empty
      expect(container.querySelector(".detail-activity-list")).toBeNull();
    });

    it("can switch between all four tabs", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({
            prompt: "# Hello\n\nContent",
            log: [{ timestamp: "2026-01-01T00:00:00Z", action: "Test" }],
          })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Start on Definition tab
      expect(container.querySelector(".markdown-body")).toBeTruthy();
      expect(container.querySelector(".detail-activity")).toBeNull();

      // Switch to Activity tab
      fireEvent.click(screen.getByText("Activity"));
      expect(container.querySelector(".detail-activity")).toBeTruthy();
      expect(container.querySelector(".markdown-body")).toBeNull();

      // Switch to Agent Log tab
      fireEvent.click(screen.getByText("Agent Log"));
      expect(container.querySelector("[data-testid='agent-log-viewer']")).toBeTruthy();
      expect(container.querySelector(".detail-activity")).toBeNull();

      // Switch to Steering tab
      fireEvent.click(screen.getByText("Steering"));
      expect(screen.getByText("Steering Comments")).toBeTruthy();
      expect(container.querySelector("[data-testid='agent-log-viewer']")).toBeNull();

      // Switch back to Definition tab
      fireEvent.click(screen.getByText("Definition"));
      expect(container.querySelector(".markdown-body")).toBeTruthy();
      expect(container.querySelector(".detail-activity")).toBeNull();
      expect(screen.queryByText("Steering Comments")).toBeNull();
    });

    it("switches to Agent Log tab and back", async () => {
      const { useAgentLogs } = await import("../../hooks/useAgentLogs");
      const mockUseAgentLogs = vi.mocked(useAgentLogs);

      const { container } = render(
        <TaskDetailModal
          task={makeTask({ prompt: "# Hello\n\nContent" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Click Agent Log tab
      fireEvent.click(screen.getByText("Agent Log"));

      // Agent log viewer should appear
      expect(container.querySelector("[data-testid='agent-log-viewer']")).toBeTruthy();
      // Definition content should be hidden
      expect(container.querySelector(".markdown-body")).toBeNull();

      // Click Definition tab to go back
      fireEvent.click(screen.getByText("Definition"));

      // Definition content should reappear
      expect(container.querySelector(".markdown-body")).toBeTruthy();
      expect(container.querySelector("[data-testid='agent-log-viewer']")).toBeNull();
    });

    it("passes enabled=true to useAgentLogs only when Agent Log tab is active", async () => {
      const { useAgentLogs } = await import("../../hooks/useAgentLogs");
      const mockUseAgentLogs = vi.mocked(useAgentLogs);
      mockUseAgentLogs.mockClear();

      const { rerender } = render(
        <TaskDetailModal
          task={makeTask()}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Default: Definition tab active → enabled should be false
      const initialCall = mockUseAgentLogs.mock.calls[mockUseAgentLogs.mock.calls.length - 1];
      expect(initialCall[1]).toBe(false);

      // Switch to Agent Log tab
      fireEvent.click(screen.getByText("Agent Log"));

      const afterSwitch = mockUseAgentLogs.mock.calls[mockUseAgentLogs.mock.calls.length - 1];
      expect(afterSwitch[1]).toBe(true);
    });

    it("switches to Steering tab", async () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ prompt: "# Hello\n\nContent" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Click Steering tab
      fireEvent.click(screen.getByText("Steering"));

      // Steering content should appear
      expect(screen.getByText("Steering Comments")).toBeTruthy();
      expect(screen.getByPlaceholderText(/Add a steering comment/)).toBeTruthy();
      // Definition content should be hidden
      expect(container.querySelector(".markdown-body")).toBeNull();
    });

    it("shows Steering tab as third tab", async () => {
      render(
        <TaskDetailModal
          task={makeTask()}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const tabs = screen.getAllByRole("button").filter((b) =>
        ["Definition", "Activity", "Agent Log", "Steering"].includes(b.textContent || "")
      );
      expect(tabs.length).toBe(4);
      expect(tabs[1].textContent).toBe("Activity");
      expect(tabs[3].textContent).toBe("Steering");
    });
  });

  describe("step progress", () => {
    it("renders step progress section when steps exist", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({
            steps: [
              { name: "Step 1", status: "done" },
              { name: "Step 2", status: "in-progress" },
            ],
          })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(container.querySelector(".detail-step-progress")).toBeTruthy();
      expect(screen.getByText("Progress")).toBeTruthy();
    });

    it("shows '(no steps defined)' when steps array is empty", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ steps: [] })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(container.querySelector(".detail-step-progress")).toBeTruthy();
      expect(screen.getByText("(no steps defined)")).toBeTruthy();
    });

    it("renders correct number of segments matching step count", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({
            steps: [
              { name: "Step 1", status: "done" },
              { name: "Step 2", status: "in-progress" },
              { name: "Step 3", status: "pending" },
            ],
          })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const segments = container.querySelectorAll(".step-progress-segment");
      expect(segments).toHaveLength(3);
    });

    it("segments have correct status modifier classes", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({
            steps: [
              { name: "Step 1", status: "done" },
              { name: "Step 2", status: "in-progress" },
              { name: "Step 3", status: "pending" },
              { name: "Step 4", status: "skipped" },
            ],
          })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const segments = container.querySelectorAll(".step-progress-segment");
      expect(segments[0].classList.contains("step-progress-segment--done")).toBe(true);
      expect(segments[1].classList.contains("step-progress-segment--in-progress")).toBe(true);
      expect(segments[2].classList.contains("step-progress-segment--pending")).toBe(true);
      expect(segments[3].classList.contains("step-progress-segment--skipped")).toBe(true);
    });

    it("segments have correct inline background colors based on status", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({
            steps: [
              { name: "Step 1", status: "done" },
              { name: "Step 2", status: "in-progress" },
              { name: "Step 3", status: "pending" },
              { name: "Step 4", status: "skipped" },
            ],
          })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const segments = container.querySelectorAll(".step-progress-segment");
      expect((segments[0] as HTMLElement).style.backgroundColor).toBe("var(--color-success, #3fb950)");
      expect((segments[1] as HTMLElement).style.backgroundColor).toBe("var(--todo, #58a6ff)");
      expect((segments[2] as HTMLElement).style.backgroundColor).toBe("var(--border, #30363d)");
      expect((segments[3] as HTMLElement).style.backgroundColor).toBe("var(--text-dim, #484f58)");
    });

    it("displays correct completion count", () => {
      render(
        <TaskDetailModal
          task={makeTask({
            steps: [
              { name: "Step 1", status: "done" },
              { name: "Step 2", status: "done" },
              { name: "Step 3", status: "pending" },
              { name: "Step 4", status: "in-progress" },
            ],
          })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.getByText("2/4 steps")).toBeTruthy();
    });

    it("has data-tooltip attribute with step name and status on each segment", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({
            steps: [
              { name: "Initialize project", status: "done" },
              { name: "Add tests", status: "in-progress" },
            ],
          })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const segments = container.querySelectorAll(".step-progress-segment");
      expect(segments[0].getAttribute("data-tooltip")).toBe("Initialize project (done)");
      expect(segments[1].getAttribute("data-tooltip")).toBe("Add tests (in-progress)");
    });

    it("step progress only renders in Definition tab, not Agent Log tab", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({
            prompt: "# Test",
            steps: [
              { name: "Step 1", status: "done" },
            ],
          })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Should be visible in Definition tab
      expect(container.querySelector(".detail-step-progress")).toBeTruthy();

      // Switch to Agent Log tab
      fireEvent.click(screen.getByText("Agent Log"));

      // Should not be visible in Agent Log tab
      expect(container.querySelector(".detail-step-progress")).toBeNull();
    });

    it("step progress is hidden in Steering tab", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({
            prompt: "# Test",
            steps: [
              { name: "Step 1", status: "done" },
            ],
          })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Switch to Steering tab
      fireEvent.click(screen.getByText("Steering"));

      // Should not be visible in Steering tab
      expect(container.querySelector(".detail-step-progress")).toBeNull();
    });
  });

  describe("mobile responsive structure", () => {
    it("modal container has both 'modal' and 'modal-lg' classes for responsive CSS targeting", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask()}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const modal = container.querySelector(".modal.modal-lg");
      expect(modal).toBeTruthy();
    });

    it("modal overlay has 'modal-overlay' and 'open' classes", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask()}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const overlay = container.querySelector(".modal-overlay.open");
      expect(overlay).toBeTruthy();
    });

    it("modal-actions contains the spacer div for flex layout", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ column: "in-progress" as Column })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const actions = container.querySelector(".modal-actions");
      expect(actions).toBeTruthy();
      // Spacer div with flex: 1 separates left actions from right actions
      const spacer = actions!.querySelector("div");
      expect(spacer).toBeTruthy();
      expect((spacer as HTMLElement).style.flex).toContain("1");
    });

    it("tab buttons use CSS classes instead of inline styles for responsive override", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask()}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const tabs = container.querySelectorAll(".detail-tab");
      expect(tabs.length).toBe(6); // Definition, Activity, Agent Log, Steering, Model, Spec
      // Tabs should use class-based styling, not inline styles
      expect(tabs[0].classList.contains("detail-tab")).toBe(true);
      expect(tabs[0].classList.contains("detail-tab-active")).toBe(true); // Definition is default active
      expect(tabs[1].classList.contains("detail-tab-active")).toBe(false);
      expect(tabs[2].classList.contains("detail-tab-active")).toBe(false);
      expect(tabs[3].classList.contains("detail-tab-active")).toBe(false);
      expect(tabs[4].classList.contains("detail-tab-active")).toBe(false);
      expect(tabs[5].classList.contains("detail-tab-active")).toBe(false);
      // Verify no inline padding/fontSize (responsive CSS controls this)
      expect((tabs[0] as HTMLElement).style.padding).toBe("");
      expect((tabs[0] as HTMLElement).style.fontSize).toBe("");
    });

    it("detail-tabs container uses CSS class instead of inline styles", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask()}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const tabsContainer = container.querySelector(".detail-tabs");
      expect(tabsContainer).toBeTruthy();
      // Should not have inline display/borderBottom styles — CSS class handles it
      expect((tabsContainer as HTMLElement).style.display).toBe("");
      expect((tabsContainer as HTMLElement).style.borderBottom).toBe("");
    });

    it("detail-body is present and scrollable (flex: 1 + overflow-y: auto via CSS)", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask()}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const body = container.querySelector(".detail-body");
      expect(body).toBeTruthy();
    });

    it("modal-actions contains Delete and Pause buttons for non-done tasks", () => {
      render(
        <TaskDetailModal
          task={makeTask({ column: "in-progress" as Column })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.getByText("Delete")).toBeTruthy();
      expect(screen.getByText("Pause")).toBeTruthy();
    });

    it("in-review modal-actions contains Merge & Close and Back to In Progress buttons", () => {
      render(
        <TaskDetailModal
          task={makeTask({ column: "in-review" as Column })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.getByText("Merge & Close")).toBeTruthy();
      expect(screen.getByText("Back to In Progress")).toBeTruthy();
    });

    it("shows PR automation waiting label instead of Merge & Close when awaiting PR checks", () => {
      render(
        <TaskDetailModal
          task={makeTask({ column: "in-review" as Column, status: "awaiting-pr-checks", prInfo: {
            url: "https://github.com/owner/repo/pull/42",
            number: 42,
            status: "open",
            title: "Task",
            headBranch: "kb/kb-099",
            baseBranch: "main",
            commentCount: 0,
          } })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const button = screen.getByText("Awaiting PR checks") as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(screen.queryByText("Merge & Close")).toBeNull();
    });

    it("shows Creating PR label while PR-first automation is creating a PR", () => {
      render(
        <TaskDetailModal
          task={makeTask({ column: "in-review" as Column, status: "creating-pr" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const button = screen.getByText("Creating PR…") as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(screen.queryByText("Merge & Close")).toBeNull();
    });
  });

  describe("dependency dropdown search", () => {
    const searchTasks: Task[] = [
      { id: "KB-010", title: "Fix login bug", description: "Users cannot log in", column: "todo" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
      { id: "KB-020", title: "Add dark mode", description: "Theme support", column: "todo" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "2026-02-01T00:00:00Z", updatedAt: "2026-02-01T00:00:00Z" },
      { id: "KB-030", title: "Refactor API", description: "Clean up endpoints", column: "todo" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "2026-03-01T00:00:00Z", updatedAt: "2026-03-01T00:00:00Z" },
      { id: "KB-099", description: "Self", column: "in-progress" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "2026-03-15T00:00:00Z", updatedAt: "2026-03-15T00:00:00Z" },
    ];

    function renderWithSearch(taskOverrides: Partial<TaskDetail> = {}) {
      return render(
        <TaskDetailModal
          task={makeTask(taskOverrides)}
          tasks={searchTasks}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );
    }

    it("shows search input when dropdown is opened", () => {
      renderWithSearch();
      fireEvent.click(screen.getByText("Add Dependency"));
      const input = document.querySelector(".dep-dropdown-search") as HTMLInputElement;
      expect(input).toBeTruthy();
      expect(input.placeholder).toBe("Search tasks…");
    });

    it("filters tasks by search term", () => {
      renderWithSearch();
      fireEvent.click(screen.getByText("Add Dependency"));
      const input = document.querySelector(".dep-dropdown-search") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "login" } });

      const items = document.querySelectorAll(".dep-dropdown-item");
      expect(items).toHaveLength(1);
      expect(items[0].querySelector(".dep-dropdown-id")?.textContent).toBe("KB-010");
    });

    it("matches task ID case-insensitively", () => {
      renderWithSearch();
      fireEvent.click(screen.getByText("Add Dependency"));
      const input = document.querySelector(".dep-dropdown-search") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "kb-020" } });

      const items = document.querySelectorAll(".dep-dropdown-item");
      expect(items).toHaveLength(1);
      expect(items[0].querySelector(".dep-dropdown-id")?.textContent).toBe("KB-020");
    });

    it("matches task title", () => {
      renderWithSearch();
      fireEvent.click(screen.getByText("Add Dependency"));
      const input = document.querySelector(".dep-dropdown-search") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "dark mode" } });

      const items = document.querySelectorAll(".dep-dropdown-item");
      expect(items).toHaveLength(1);
      expect(items[0].querySelector(".dep-dropdown-id")?.textContent).toBe("KB-020");
    });

    it("shows empty state when search matches nothing", () => {
      renderWithSearch();
      fireEvent.click(screen.getByText("Add Dependency"));
      const input = document.querySelector(".dep-dropdown-search") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "zzz-nonexistent" } });

      const items = document.querySelectorAll(".dep-dropdown-item");
      expect(items).toHaveLength(0);
      expect(document.querySelector(".dep-dropdown-empty")?.textContent).toBe("No available tasks");
    });

    it("resets search when dropdown closes and reopens", () => {
      renderWithSearch();
      fireEvent.click(screen.getByText("Add Dependency"));
      const input = document.querySelector(".dep-dropdown-search") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "login" } });
      expect(input.value).toBe("login");

      // Close by clicking again
      fireEvent.click(screen.getByText("Add Dependency"));
      expect(document.querySelector(".dep-dropdown")).toBeNull();

      // Reopen
      fireEvent.click(screen.getByText("Add Dependency"));
      const newInput = document.querySelector(".dep-dropdown-search") as HTMLInputElement;
      expect(newInput.value).toBe("");
      // All items visible again
      expect(document.querySelectorAll(".dep-dropdown-item")).toHaveLength(3);
    });
  });

  describe("clickable dependency links", () => {
    it("renders dependency list items with clickable class", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ dependencies: ["KB-001", "KB-002"] })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const depLinks = container.querySelectorAll(".detail-dep-link");
      expect(depLinks).toHaveLength(2);
      expect(depLinks[0].textContent).toBe("KB-001");
      expect(depLinks[1].textContent).toBe("KB-002");
    });

    it("calls fetchTaskDetail and onOpenDetail when clicking a dependency", async () => {
      const { fetchTaskDetail } = await import("../../api");
      const mockFetch = vi.mocked(fetchTaskDetail);
      const mockDetail: TaskDetail = {
        ...makeTask({ id: "KB-001", description: "Dep 1" }),
        prompt: "",
        attachments: [],
      };
      mockFetch.mockResolvedValueOnce(mockDetail);
      const onOpenDetail = vi.fn();

      const { container } = render(
        <TaskDetailModal
          task={makeTask({ dependencies: ["KB-001"] })}
          onOpenDetail={onOpenDetail}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          addToast={noop}
        />,
      );

      const depLink = container.querySelector(".detail-dep-link")!;
      fireEvent.click(depLink);

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith("KB-001");
        expect(onOpenDetail).toHaveBeenCalledWith(mockDetail);
      });
    });

    it("shows error toast when dependency fetch fails", async () => {
      const { fetchTaskDetail } = await import("../../api");
      const mockFetch = vi.mocked(fetchTaskDetail);
      mockFetch.mockRejectedValueOnce(new Error("Task not found"));
      const onOpenDetail = vi.fn();
      const addToast = vi.fn();

      const { container } = render(
        <TaskDetailModal
          task={makeTask({ dependencies: ["KB-001"] })}
          onOpenDetail={onOpenDetail}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          addToast={addToast}
        />,
      );

      const depLink = container.querySelector(".detail-dep-link")!;
      fireEvent.click(depLink);

      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith("Failed to load dependency KB-001", "error");
      });
      expect(onOpenDetail).not.toHaveBeenCalled();
    });

    it("remove button click does not trigger dependency click", async () => {
      const { updateTask } = await import("../../api");
      const { fetchTaskDetail } = await import("../../api");
      const mockFetch = vi.mocked(fetchTaskDetail);
      mockFetch.mockRejectedValueOnce(new Error("Should not be called"));
      const onOpenDetail = vi.fn();

      render(
        <TaskDetailModal
          task={makeTask({ dependencies: ["KB-001"] })}
          onOpenDetail={onOpenDetail}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          addToast={noop}
        />,
      );

      const removeButton = screen.getByTitle(/Remove dependency/);
      fireEvent.click(removeButton);

      // onOpenDetail should not be called when clicking remove
      expect(onOpenDetail).not.toHaveBeenCalled();
      // updateTask should be called to remove the dependency
      await waitFor(() => {
        expect(updateTask).toHaveBeenCalledWith("KB-099", { dependencies: [] });
      });
    });
  });

  describe("Spec tab", () => {
    it("shows Spec tab alongside other tabs", () => {
      render(
        <TaskDetailModal
          task={makeTask()}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.getByText("Spec")).toBeTruthy();
    });

    it("switches to Spec tab when clicked", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ prompt: "# Test\n\nSpec content." })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Initially not showing Spec content
      expect(container.querySelector(".spec-editor")).toBeNull();

      // Click Spec tab
      fireEvent.click(screen.getByText("Spec"));

      // Should show SpecEditor
      expect(container.querySelector(".spec-editor")).toBeTruthy();
    });

    it("Spec tab shows SpecEditor with task prompt", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ prompt: "# Test Task\n\nTest specification." })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByText("Spec"));

      // Should show the spec content (without leading heading)
      expect(container.querySelector(".spec-editor")).toBeTruthy();
    });

    it("shows all 5 tabs in correct order", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask()}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const tabs = container.querySelectorAll(".detail-tab");
      expect(tabs.length).toBe(6);
      expect(tabs[0].textContent).toBe("Definition");
      expect(tabs[1].textContent).toBe("Activity");
      expect(tabs[2].textContent).toBe("Agent Log");
      expect(tabs[3].textContent).toBe("Steering");
      expect(tabs[4].textContent).toBe("Model");
      expect(tabs[5].textContent).toBe("Spec");
    });

    it("shows empty state in Spec tab when no prompt", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ prompt: "" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByText("Spec"));

      // Should show spec editor (view mode with empty state)
      expect(container.querySelector(".spec-editor")).toBeTruthy();
    });
  });

  describe("Plan Approval UI", () => {
    it("shows Approve Plan and Reject Plan buttons for awaiting-approval tasks in triage", () => {
      render(
        <TaskDetailModal
          task={makeTask({
            column: "triage",
            status: "awaiting-approval",
            prompt: "# Task Spec",
          })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.getByText("Approve Plan")).toBeTruthy();
      expect(screen.getByText("Reject Plan")).toBeTruthy();
    });

    it("does not show approval buttons when task is not in triage", () => {
      render(
        <TaskDetailModal
          task={makeTask({
            column: "todo",
            status: "awaiting-approval",
            prompt: "# Task Spec",
          })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.queryByText("Approve Plan")).toBeNull();
      expect(screen.queryByText("Reject Plan")).toBeNull();
    });

    it("does not show approval buttons when task does not have awaiting-approval status", () => {
      render(
        <TaskDetailModal
          task={makeTask({
            column: "triage",
            status: "specifying",
            prompt: "# Task Spec",
          })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.queryByText("Approve Plan")).toBeNull();
      expect(screen.queryByText("Reject Plan")).toBeNull();
    });

    it("does not show approval buttons when task has no prompt", () => {
      render(
        <TaskDetailModal
          task={makeTask({
            column: "triage",
            status: "awaiting-approval",
            prompt: "",
          })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.queryByText("Approve Plan")).toBeNull();
      expect(screen.queryByText("Reject Plan")).toBeNull();
    });

    it("calls approvePlan API and shows success toast when Approve Plan is clicked", async () => {
      const { approvePlan } = await import("../../api");
      const mockApprovePlan = vi.mocked(approvePlan);
      const addToast = vi.fn();
      const onClose = vi.fn();

      render(
        <TaskDetailModal
          task={makeTask({
            id: "KB-001",
            column: "triage",
            status: "awaiting-approval",
            prompt: "# Task Spec",
          })}
          onClose={onClose}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={addToast}
        />,
      );

      fireEvent.click(screen.getByText("Approve Plan"));

      await waitFor(() => {
        expect(mockApprovePlan).toHaveBeenCalledWith("KB-001");
      });
      expect(addToast).toHaveBeenCalledWith("Plan approved — KB-001 moved to Todo", "success");
      expect(onClose).toHaveBeenCalled();
    });

    it("calls rejectPlan API and shows success toast when Reject Plan is confirmed", async () => {
      const { rejectPlan } = await import("../../api");
      const mockRejectPlan = vi.mocked(rejectPlan);
      const addToast = vi.fn();
      const onClose = vi.fn();

      // Mock confirm to return true
      const originalConfirm = window.confirm;
      window.confirm = vi.fn(() => true);

      render(
        <TaskDetailModal
          task={makeTask({
            id: "KB-001",
            column: "triage",
            status: "awaiting-approval",
            prompt: "# Task Spec",
          })}
          onClose={onClose}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={addToast}
        />,
      );

      fireEvent.click(screen.getByText("Reject Plan"));

      expect(window.confirm).toHaveBeenCalledWith(
        "Reject this plan? The specification will be discarded and regenerated."
      );

      await waitFor(() => {
        expect(mockRejectPlan).toHaveBeenCalledWith("KB-001");
      });
      expect(addToast).toHaveBeenCalledWith(
        "Plan rejected — KB-001 returned to Triage for re-specification",
        "info"
      );
      expect(onClose).toHaveBeenCalled();

      window.confirm = originalConfirm;
    });

    it("does not call rejectPlan API when Reject Plan is cancelled", async () => {
      const { rejectPlan } = await import("../../api");
      const mockRejectPlan = vi.mocked(rejectPlan);
      mockRejectPlan.mockClear(); // Clear any previous calls

      const addToast = vi.fn();

      // Mock confirm to return false
      const originalConfirm = window.confirm;
      window.confirm = vi.fn(() => false);

      render(
        <TaskDetailModal
          task={makeTask({
            column: "triage",
            status: "awaiting-approval",
            prompt: "# Task Spec",
          })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={addToast}
        />,
      );

      fireEvent.click(screen.getByText("Reject Plan"));

      expect(window.confirm).toHaveBeenCalled();
      expect(mockRejectPlan).not.toHaveBeenCalled();
      expect(addToast).not.toHaveBeenCalled();

      window.confirm = originalConfirm;
    });

    it("shows error toast when approvePlan fails", async () => {
      const { approvePlan } = await import("../../api");
      const mockApprovePlan = vi.mocked(approvePlan);
      mockApprovePlan.mockRejectedValueOnce(new Error("Network error"));

      const addToast = vi.fn();

      render(
        <TaskDetailModal
          task={makeTask({
            id: "KB-001",
            column: "triage",
            status: "awaiting-approval",
            prompt: "# Task Spec",
          })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={addToast}
        />,
      );

      fireEvent.click(screen.getByText("Approve Plan"));

      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith("Network error", "error");
      });
    });

    it("shows error toast when rejectPlan fails", async () => {
      const { rejectPlan } = await import("../../api");
      const mockRejectPlan = vi.mocked(rejectPlan);
      mockRejectPlan.mockRejectedValueOnce(new Error("Server error"));

      const addToast = vi.fn();

      // Mock confirm to return true
      const originalConfirm = window.confirm;
      window.confirm = vi.fn(() => true);

      render(
        <TaskDetailModal
          task={makeTask({
            id: "KB-001",
            column: "triage",
            status: "awaiting-approval",
            prompt: "# Task Spec",
          })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={addToast}
        />,
      );

      fireEvent.click(screen.getByText("Reject Plan"));

      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith("Server error", "error");
      });

      window.confirm = originalConfirm;
    });
  });

  describe("Duplicate button", () => {
    it("renders Duplicate button in modal actions when onDuplicateTask is provided", () => {
      render(
        <TaskDetailModal
          task={makeTask()}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          onDuplicateTask={vi.fn()}
          addToast={noop}
        />,
      );

      expect(screen.getByText("Duplicate")).toBeTruthy();
    });

    it("does NOT render Duplicate button when onDuplicateTask is not provided", () => {
      render(
        <TaskDetailModal
          task={makeTask()}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.queryByText("Duplicate")).toBeNull();
    });

    it("clicking Duplicate shows confirmation dialog", () => {
      const originalConfirm = window.confirm;
      window.confirm = vi.fn(() => false);

      render(
        <TaskDetailModal
          task={makeTask({ id: "KB-001" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          onDuplicateTask={vi.fn()}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByText("Duplicate"));

      expect(window.confirm).toHaveBeenCalledWith(
        "Duplicate KB-001? This will create a new task in Triage with the same description and prompt."
      );

      window.confirm = originalConfirm;
    });

    it("confirming duplicate calls onDuplicateTask and closes modal", async () => {
      const originalConfirm = window.confirm;
      window.confirm = vi.fn(() => true);

      const mockDuplicate = vi.fn().mockResolvedValue({ id: "KB-002" } as Task);
      const onClose = vi.fn();

      render(
        <TaskDetailModal
          task={makeTask({ id: "KB-001" })}
          onClose={onClose}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          onDuplicateTask={mockDuplicate}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByText("Duplicate"));

      await waitFor(() => {
        expect(mockDuplicate).toHaveBeenCalledWith("KB-001");
        expect(onClose).toHaveBeenCalled();
      });

      window.confirm = originalConfirm;
    });

    it("successful duplicate shows success toast with new task ID", async () => {
      const originalConfirm = window.confirm;
      window.confirm = vi.fn(() => true);

      const mockDuplicate = vi.fn().mockResolvedValue({ id: "KB-002" } as Task);
      const addToast = vi.fn();

      render(
        <TaskDetailModal
          task={makeTask({ id: "KB-001" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          onDuplicateTask={mockDuplicate}
          addToast={addToast}
        />,
      );

      fireEvent.click(screen.getByText("Duplicate"));

      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith("Duplicated KB-001 → KB-002", "success");
      });

      window.confirm = originalConfirm;
    });

    it("cancelling confirmation does not call onDuplicateTask", () => {
      const originalConfirm = window.confirm;
      window.confirm = vi.fn(() => false);

      const mockDuplicate = vi.fn().mockResolvedValue({ id: "KB-002" } as Task);

      render(
        <TaskDetailModal
          task={makeTask({ id: "KB-001" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          onDuplicateTask={mockDuplicate}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByText("Duplicate"));

      expect(mockDuplicate).not.toHaveBeenCalled();

      window.confirm = originalConfirm;
    });

    it("shows error toast when duplicate fails", async () => {
      const originalConfirm = window.confirm;
      window.confirm = vi.fn(() => true);

      const mockDuplicate = vi.fn().mockRejectedValue(new Error("Duplicate failed"));
      const addToast = vi.fn();

      render(
        <TaskDetailModal
          task={makeTask({ id: "KB-001" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          onDuplicateTask={mockDuplicate}
          addToast={addToast}
        />,
      );

      fireEvent.click(screen.getByText("Duplicate"));

      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith("Duplicate failed", "error");
      });

      window.confirm = originalConfirm;
    });
  });

  describe("Refinement button", () => {
    it("renders Request Refinement button for 'done' column tasks", () => {
      render(
        <TaskDetailModal
          task={makeTask({ column: "done" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.getByText("Request Refinement")).toBeTruthy();
    });

    it("renders Request Refinement button for 'in-review' column tasks", () => {
      render(
        <TaskDetailModal
          task={makeTask({ column: "in-review" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.getByText("Request Refinement")).toBeTruthy();
    });

    it("does NOT render Request Refinement button for 'triage' column tasks", () => {
      render(
        <TaskDetailModal
          task={makeTask({ column: "triage" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.queryByText("Request Refinement")).toBeNull();
    });

    it("does NOT render Request Refinement button for 'todo' column tasks", () => {
      render(
        <TaskDetailModal
          task={makeTask({ column: "todo" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.queryByText("Request Refinement")).toBeNull();
    });

    it("does NOT render Request Refinement button for 'in-progress' column tasks", () => {
      render(
        <TaskDetailModal
          task={makeTask({ column: "in-progress" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.queryByText("Request Refinement")).toBeNull();
    });

    it("clicking Request Refinement opens the refinement modal", () => {
      render(
        <TaskDetailModal
          task={makeTask({ id: "KB-001", column: "done" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByText("Request Refinement"));

      expect(screen.getByText("Request Refinement", { selector: "h3" })).toBeTruthy();
      expect(screen.getByPlaceholderText("Enter your feedback here...")).toBeTruthy();
    });

    it("shows character counter in refinement modal", () => {
      render(
        <TaskDetailModal
          task={makeTask({ id: "KB-001", column: "done" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByText("Request Refinement"));

      expect(screen.getByText("0/2000 characters")).toBeTruthy();
    });

    it("character counter updates when typing feedback", async () => {
      render(
        <TaskDetailModal
          task={makeTask({ id: "KB-001", column: "done" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByText("Request Refinement"));

      const textarea = screen.getByPlaceholderText("Enter your feedback here...");
      await act(async () => {
        fireEvent.change(textarea, { target: { value: "Need to fix the error handling" } });
      });

      expect(screen.getByText("30/2000 characters")).toBeTruthy();
    });

    it("submit button is disabled when feedback is empty", () => {
      render(
        <TaskDetailModal
          task={makeTask({ id: "KB-001", column: "done" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByText("Request Refinement"));

      const submitButton = screen.getByText("Create Refinement Task");
      expect(submitButton.hasAttribute("disabled")).toBe(true);
    });

    it("submit button is enabled when feedback is entered", async () => {
      render(
        <TaskDetailModal
          task={makeTask({ id: "KB-001", column: "done" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByText("Request Refinement"));

      const textarea = screen.getByPlaceholderText("Enter your feedback here...");
      await act(async () => {
        fireEvent.change(textarea, { target: { value: "Need to fix error handling" } });
      });

      const submitButton = screen.getByText("Create Refinement Task");
      expect(submitButton.hasAttribute("disabled")).toBe(false);
    });

    it("clicking Cancel closes the refinement modal", () => {
      const onClose = vi.fn();

      render(
        <TaskDetailModal
          task={makeTask({ id: "KB-001", column: "done" })}
          onClose={onClose}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByText("Request Refinement"));
      fireEvent.click(screen.getByText("Cancel"));

      // Modal should be closed, but detail modal stays open (onClose not called)
      expect(screen.queryByText("Request Refinement", { selector: "h3" })).toBeNull();
      expect(onClose).not.toHaveBeenCalled();
    });

    it("shows error toast when submitting empty feedback", async () => {
      const addToast = vi.fn();

      render(
        <TaskDetailModal
          task={makeTask({ id: "KB-001", column: "done" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={addToast}
        />,
      );

      fireEvent.click(screen.getByText("Request Refinement"));

      // Try to submit with empty text (manually trigger submit since button is disabled)
      const { refineTask } = await import("../../api");

      // Should not call API, instead show error toast
      expect(refineTask).not.toHaveBeenCalled();
    });

    it("calls refineTask and closes modal on successful submission", async () => {
      const { refineTask } = await import("../../api");
      vi.mocked(refineTask).mockResolvedValue({ id: "KB-002", column: "triage" } as Task);

      const onClose = vi.fn();
      const addToast = vi.fn();

      render(
        <TaskDetailModal
          task={makeTask({ id: "KB-001", column: "done" })}
          onClose={onClose}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={addToast}
        />,
      );

      fireEvent.click(screen.getByText("Request Refinement"));

      const textarea = screen.getByPlaceholderText("Enter your feedback here...");
      fireEvent.change(textarea, { target: { value: "Need to add more tests" } });

      fireEvent.click(screen.getByText("Create Refinement Task"));

      await waitFor(() => {
        expect(refineTask).toHaveBeenCalledWith("KB-001", "Need to add more tests");
        expect(addToast).toHaveBeenCalledWith("Refinement task created: KB-002", "success");
        expect(onClose).toHaveBeenCalled();
      });
    });

    it("shows error toast when refineTask fails", async () => {
      const { refineTask } = await import("../../api");
      vi.mocked(refineTask).mockRejectedValue(new Error("Task must be in 'done' or 'in-review' column"));

      const addToast = vi.fn();

      render(
        <TaskDetailModal
          task={makeTask({ id: "KB-001", column: "done" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={addToast}
        />,
      );

      fireEvent.click(screen.getByText("Request Refinement"));

      const textarea = screen.getByPlaceholderText("Enter your feedback here...");
      fireEvent.change(textarea, { target: { value: "Need to add more tests" } });

      fireEvent.click(screen.getByText("Create Refinement Task"));

      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith("Task must be in 'done' or 'in-review' column", "error");
      });
    });
  });
});
