import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { TaskDetailModal } from "../TaskDetailModal";
import type { TaskDetail, Column, MergeResult, Task } from "@hai/core";

vi.mock("../../api", () => ({
  uploadAttachment: vi.fn(),
  deleteAttachment: vi.fn(),
  updateTask: vi.fn().mockResolvedValue({}),
}));

function makeTask(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "HAI-099",
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

describe("TaskDetailModal", () => {
  it("renders markdown-body without detail-prompt class when prompt exists", () => {
    const { container } = render(
      <TaskDetailModal
        task={makeTask({ prompt: "# Hello\n\nSome **bold** text" })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
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
          prompt: "# HAI-099\n\nFix the login bug\n",
        })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        addToast={noop}
      />,
    );

    // The heading "HAI-099" should be stripped from the markdown
    const markdownBody = container.querySelector(".markdown-body");
    expect(markdownBody?.innerHTML).not.toContain("HAI-099");
    // Description appears in the markdown body
    expect(markdownBody?.textContent).toContain("Fix the login bug");
    // The detail header shows the ID (not duplicated as markdown heading)
    expect(container.querySelector(".detail-id")?.textContent).toBe("HAI-099");
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
        addToast={noop}
      />,
    );
    expect(withTitle.querySelector(".detail-id")?.textContent).toBe("HAI-099");

    // Without title
    const { container: withoutTitle } = render(
      <TaskDetailModal
        task={makeTask({ title: undefined, description: "A description" })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        addToast={noop}
      />,
    );
    expect(withoutTitle.querySelector(".detail-id")?.textContent).toBe("HAI-099");
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
        expect(mockUpload).toHaveBeenCalledWith("HAI-099", imageFile);
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
        expect(mockUpload).toHaveBeenCalledWith("HAI-099", imageFile);
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
        addToast={noop}
      />,
    );

    expect(screen.getByText("(no dependencies)")).toBeTruthy();
  });

  it("renders dependency list when dependencies exist", () => {
    render(
      <TaskDetailModal
        task={makeTask({ dependencies: ["HAI-001", "HAI-002"] })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        addToast={noop}
      />,
    );

    expect(screen.getByText("HAI-001")).toBeTruthy();
    expect(screen.getByText("HAI-002")).toBeTruthy();
    expect(screen.queryByText("(no dependencies)")).toBeNull();
  });

  it("can add a dependency via the dropdown", async () => {
    const { updateTask } = await import("../../api");
    const allTasks: Task[] = [
      { id: "HAI-001", description: "Dep 1", column: "todo" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "", updatedAt: "" },
      { id: "HAI-099", description: "Self", column: "in-progress" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "", updatedAt: "" },
    ];

    render(
      <TaskDetailModal
        task={makeTask({ dependencies: [] })}
        tasks={allTasks}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        addToast={noop}
      />,
    );

    fireEvent.click(screen.getByText("Add Dependency"));
    // Should show HAI-001 in the dropdown but not HAI-099 (self is excluded)
    const dropdown = document.querySelector(".dep-dropdown")!;
    expect(dropdown).toBeTruthy();
    expect(dropdown.textContent).toContain("HAI-001");
    expect(dropdown.querySelectorAll(".dep-dropdown-item")).toHaveLength(1);

    fireEvent.click(screen.getByText("HAI-001"));

    await waitFor(() => {
      expect(updateTask).toHaveBeenCalledWith("HAI-099", { dependencies: ["HAI-001"] });
    });
  });

  it("can remove a dependency", async () => {
    const { updateTask } = await import("../../api");

    render(
      <TaskDetailModal
        task={makeTask({ dependencies: ["HAI-001", "HAI-002"] })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        addToast={noop}
      />,
    );

    const removeButtons = screen.getAllByTitle(/Remove dependency/);
    fireEvent.click(removeButtons[0]); // Remove HAI-001

    await waitFor(() => {
      expect(updateTask).toHaveBeenCalledWith("HAI-099", { dependencies: ["HAI-002"] });
    });
  });
    });
  });

  it("activity list does not have nested scroll constraints", () => {
    const { container } = render(
      <TaskDetailModal
        task={makeTask({
          log: [
            { timestamp: "2026-01-01T00:00:00Z", message: "Created task" },
            { timestamp: "2026-01-01T00:01:00Z", message: "Started work" },
            { timestamp: "2026-01-01T00:02:00Z", message: "Completed step 1" },
          ],
        })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        addToast={noop}
      />,
    );

    const activityList = container.querySelector(".detail-activity-list");
    expect(activityList).toBeTruthy();
    const style = (activityList as HTMLElement).style;
    expect(style.overflowY).not.toBe("auto");
    expect(style.maxHeight).toBe("");
  });
});
