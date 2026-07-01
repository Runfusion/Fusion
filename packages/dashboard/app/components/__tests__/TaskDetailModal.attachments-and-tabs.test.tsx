import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  makeTask,
  noop,
  noopDelete,
  noopMerge,
  noopMove,
  noopOpenDetail,
  mockConfirm,
  mockUsePluginUiSlots,
  expectBaseRule,
  getCssRuleBlock,
  readDashboardStylesSource,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import { TaskDetailModal, TaskDetailContent } from "../TaskDetailModal";

vi.mock("../BranchGroupCard", () => ({
  BranchGroupCard: ({ groupId }: { groupId: string }) => (
    <section className="card branch-group-card" data-testid="mock-branch-group-card" aria-label={`Mock branch group ${groupId}`}>
      <button type="button">Mock branch group toggle {groupId}</button>
    </section>
  ),
}));

/*
FNXC:TaskDetailTabs 2026-06-17-08:20:
FN-7306 labels the stable internal `chat` tab as Activity, while later Chat-first detail work keeps that legacy `chat` id only for explicit Activity requests. Definition-tab regression coverage must prove omitted non-done task details now land on planner Chat, Activity remains selectable, and explicit `initialTab="definition"` still opens the Definition surface for prompt, GitHub tracking, and dependency sections.

FNXC:TaskDetailPlannerChat 2026-06-30-23:58:
Omitted non-done TaskDetailModal renders open the top-level planner Chat first/default. Activity controls (`Live`, `Feed`, `Raw Logs`, and the activity expand toggle) are intentionally mounted only after selecting Activity or using an explicit legacy Activity tab request.
*/
setupTaskDetailModalHooks();

describe("TaskDetailModal", () => {
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
        expect(mockUpload).toHaveBeenCalledWith("FN-099", imageFile, undefined);
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
          initialTab="definition"
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
      mockUpload.mockResolvedValueOnce(
        new Promise((resolve) => {
          resolveUpload = resolve;
        }) as any,
      );

      render(
        <TaskDetailModal
          task={makeTask()}
          initialTab="definition"
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

      const modal = container.querySelector(".task-detail-content")!;
      const imageFile = new File(["fake-image"], "dropped.png", { type: "image/png" });

      await act(async () => {
        fireEvent.drop(modal, {
          dataTransfer: {
            files: [imageFile],
          },
        });
      });

      await waitFor(() => {
        expect(mockUpload).toHaveBeenCalledWith("FN-099", imageFile, undefined);
        expect(addToast).toHaveBeenCalledWith("Screenshot attached", "success");
      });
    });
  });

  it("renders (no dependencies) when dependencies is empty", () => {
    render(
      <TaskDetailModal
        task={makeTask({ dependencies: [] })}
        initialTab="definition"
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
    const allTasks: Task[] = [
      { id: "FN-001", title: "First dependency", description: "Desc 1", column: "todo" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "", updatedAt: "" },
      { id: "FN-002", title: "Second dependency", description: "Desc 2", column: "todo" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "", updatedAt: "" },
    ];

    render(
      <TaskDetailModal
        task={makeTask({ dependencies: ["FN-001", "FN-002"] })}
        initialTab="definition"
        tasks={allTasks}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    // Check that dependency IDs are rendered
    const depIds = document.querySelectorAll(".detail-dep-id");
    expect(depIds).toHaveLength(2);
    expect(depIds[0].textContent).toBe("FN-001");
    expect(depIds[1].textContent).toBe("FN-002");

    // Check that dependency labels (titles) are rendered
    const depLabels = document.querySelectorAll(".detail-dep-label");
    expect(depLabels).toHaveLength(2);
    expect(depLabels[0].textContent).toBe("First dependency");
    expect(depLabels[1].textContent).toBe("Second dependency");

    expect(screen.queryByText("(no dependencies)")).toBeNull();
  });

  it("can add a dependency via the dropdown", async () => {
    const { updateTask } = await import("../../api");
    const allTasks: Task[] = [
      { id: "FN-001", description: "Dep 1", column: "todo" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "", updatedAt: "" },
      { id: "FN-099", description: "Self", column: "in-progress" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "", updatedAt: "" },
    ];

    render(
      <TaskDetailModal
        task={makeTask({ dependencies: [] })}
        initialTab="definition"
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
    expect(dropdown.textContent).toContain("FN-001");
    expect(dropdown.querySelectorAll(".dep-dropdown-item")).toHaveLength(1);

    fireEvent.click(screen.getByText("FN-001"));

    await waitFor(() => {
      expect(updateTask).toHaveBeenCalledWith("FN-099", { dependencies: ["FN-001"] }, undefined);
    });
  });

  it("can remove a dependency", async () => {
    const { updateTask } = await import("../../api");

    render(
      <TaskDetailModal
        task={makeTask({ dependencies: ["FN-001", "FN-002"] })}
        initialTab="definition"
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
      expect(updateTask).toHaveBeenCalledWith("FN-099", { dependencies: ["FN-002"] }, undefined);
    });
  });

  it("renders in-review PR content only in the Pull Request tab body", () => {
    const { container } = render(
      <TaskDetailModal
        task={makeTask({ column: "in-review", status: "creating-pr", dependencies: ["FN-001"] })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    expect(container.querySelector(".detail-pr-section")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Pull Request" }));

    const prSection = container.querySelector(".detail-pr-section");
    expect(prSection).toBeTruthy();
    expect(prSection?.querySelector(".pr-section")).toBeTruthy();
  });

  it("defines tokenized spacing rules for detail-pr-tab layout", () => {
    const css = readDashboardStylesSource();
    expectBaseRule(css, ".detail-pr-tab", "gap: var(--space-lg);");
    expectBaseRule(css, ".detail-pr-tab .detail-section,\n.detail-pr-section", "margin-top: 0;");
    expectBaseRule(css, ".pr-hint--warning", "padding: var(--space-md);");
    expectBaseRule(css, ".pr-hint--conflict", "padding: var(--space-md);");
    expectBaseRule(css, ".pr-hint--success", "padding: var(--space-md);");
    expectBaseRule(css, ".pr-conflict-section", "padding: var(--space-md);");
    expectBaseRule(css, ".pr-merge-error", "padding: var(--space-md);");
    expectBaseRule(css, ".pr-error", "padding: var(--space-md);");
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

    // Select Activity before asserting its segmented controls
    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    fireEvent.click(screen.getByRole("tab", { name: "Feed" }));

    const activityList = container.querySelector(".detail-activity-list");
    expect(activityList).toBeTruthy();
    const style = (activityList as HTMLElement).style;
    expect(style.overflowY).not.toBe("auto");
    expect(style.maxHeight).toBe("");
  });

  it("renders dependency dropdown items sorted newest-first by createdAt", () => {
    const allTasks: Task[] = [
      { id: "FN-001", description: "Oldest", column: "todo" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
      { id: "FN-003", description: "Newest", column: "todo" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "2026-03-01T00:00:00Z", updatedAt: "2026-03-01T00:00:00Z" },
      { id: "FN-002", description: "Middle", column: "todo" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "2026-02-01T00:00:00Z", updatedAt: "2026-02-01T00:00:00Z" },
      { id: "FN-099", description: "Self", column: "in-progress" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "2026-03-15T00:00:00Z", updatedAt: "2026-03-15T00:00:00Z" },
    ];

    render(
      <TaskDetailModal
        task={makeTask({ dependencies: [] })}
        initialTab="definition"
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
    expect(ids).toEqual(["FN-003", "FN-002", "FN-001"]);
  });

  it("renders tasks with identical createdAt sorted newest-ID-first in dependency dropdown", () => {
    const allTasks: Task[] = [
      { id: "FN-001", description: "First", column: "todo" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
      { id: "FN-002", description: "Second", column: "todo" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
      { id: "FN-003", description: "Third", column: "todo" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
      { id: "FN-099", description: "Self", column: "in-progress" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
    ];

    render(
      <TaskDetailModal
        task={makeTask({ dependencies: [] })}
        initialTab="definition"
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
    expect(ids).toEqual(["FN-003", "FN-002", "FN-001"]);
  });

  describe("tab toggle", () => {
    it("restores planner Chat as the omitted non-done default when Chat-first is enabled", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ prompt: "# Hello\n\nContent" })}
          taskDetailChatFirst
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.getByText("Plan")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Logs" })).toBeNull();
      expect(screen.getByRole("button", { name: "Chat" })).toHaveClass("detail-tab-active");
      expect(screen.getByTestId("task-planner-chat-panel")).toBeTruthy();
      expect(screen.getByTestId("task-planner-chat-expand-toggle")).toHaveAttribute("aria-label", "Collapse planner chat");
      expect(container.querySelector(".task-detail-content")).toHaveClass("task-detail-content--planner-chat-expanded");
      expect(container.querySelector(".activity-segmented-control")).toBeNull();
      expect(screen.queryByTestId("task-chat-expand-toggle")).toBeNull();
      expect(screen.queryByText("Agent Log")).toBeNull();
      expect(screen.queryByRole("tab", { name: "Live" })).toBeNull();
      expect(screen.queryByRole("tab", { name: "Current" })).toBeNull();
      expect(container.querySelector(".detail-section--chat")).toBeNull();
      expect(container.querySelector("[data-testid='task-chat-tab']")).toBeNull();
      expect(container.querySelector(".detail-activity")).toBeNull();
      expect(container.querySelector("[data-testid='agent-log-viewer']")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Activity" }));
      expect(container.querySelector(".activity-segmented-control")).toBeTruthy();
      expect(screen.getByRole("tab", { name: "Live" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("tab", { name: "Feed" }));
      expect(container.querySelector(".detail-activity")).toBeTruthy();
      expect(screen.getByRole("tab", { name: "Feed" })).toHaveAttribute("aria-selected", "true");
    });

    it("switches to Feed segment via Activity tab and shows activity feed", () => {
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

      // Select Activity before asserting its segmented controls
      fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    fireEvent.click(screen.getByRole("tab", { name: "Feed" }));

      // Activity section should be visible
      expect(container.querySelector(".detail-activity")).toBeTruthy();
      // Activity list should be visible
      expect(container.querySelector(".detail-activity-list")).toBeTruthy();
      // Definition content should be hidden
      expect(container.querySelector(".markdown-body")).toBeNull();
    });

    it("Feed segment renders log entries correctly", () => {
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

      // Select Activity before asserting its segmented controls
      fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    fireEvent.click(screen.getByRole("tab", { name: "Feed" }));

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

    it("Feed segment preserves legacy text/detail and duplicate entries", () => {
      const duplicateEntry = { timestamp: "2026-01-01T00:02:00Z", action: "Repeated diagnostic", outcome: "same payload" };
      const { container } = render(
        <TaskDetailModal
          task={makeTask({
            log: [
              { timestamp: "2026-01-01T00:00:00Z", text: "Legacy text entry", detail: "Legacy detail body" } as any,
              duplicateEntry,
              { ...duplicateEntry },
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

      fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    fireEvent.click(screen.getByRole("tab", { name: "Feed" }));

      const actions = Array.from(container.querySelectorAll(".detail-log-action")).map((entry) => entry.textContent);
      const outcomes = Array.from(container.querySelectorAll(".detail-log-outcome")).map((entry) => entry.textContent);
      expect(actions).toEqual(["Repeated diagnostic", "Repeated diagnostic", "Legacy text entry"]);
      expect(outcomes).toEqual(["same payload", "same payload", "Legacy detail body"]);
    });

    it("Feed segment keeps action/outcome rendering intact", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({
            log: [
              { timestamp: "2026-01-01T00:01:00Z", action: "Started work", outcome: "Step completed successfully" },
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

      fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    fireEvent.click(screen.getByRole("tab", { name: "Feed" }));

      const actions = container.querySelectorAll(".detail-log-action");
      const outcomes = container.querySelectorAll(".detail-log-outcome");
      expect(actions).toHaveLength(2);
      expect(outcomes).toHaveLength(1);
      expect(Array.from(actions).map((entry) => entry.textContent)).toEqual(["Created task", "Started work"]);
      expect(outcomes[0].textContent).toBe("Step completed successfully");
    });

    it("Activity timeline CSS keeps action/outcome high-contrast and timestamp secondary", () => {
      const stylesCssText = readDashboardStylesSource();
      expect(stylesCssText).toContain(".detail-log-action");

      const actionRule = getCssRuleBlock(stylesCssText, ".detail-log-action");
      const outcomeRule = getCssRuleBlock(stylesCssText, ".detail-log-outcome");
      const timestampRule = getCssRuleBlock(stylesCssText, ".detail-log-timestamp");

      expect(actionRule).toContain("color: var(--text);");
      expect(outcomeRule).toContain("color: var(--text);");
      expect(outcomeRule).toContain("background: var(--surface);");
      expect(timestampRule).toContain("color: var(--text-muted);");
      expect(timestampRule).not.toContain("color: var(--text);");
    });

    it("Feed segment shows empty state when no logs", () => {
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

      // Select Activity before asserting its segmented controls
      fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    fireEvent.click(screen.getByRole("tab", { name: "Feed" }));

      // Activity section should be visible
      expect(container.querySelector(".detail-activity")).toBeTruthy();
      // Empty state should be shown
      expect(container.querySelector(".detail-log-empty")).toBeTruthy();
      expect(screen.getByText("(no activity)")).toBeTruthy();
      // Activity list should NOT be present when empty
      expect(container.querySelector(".detail-activity-list")).toBeNull();
    });

    it("can switch between all tabs and Activity segments", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({
            prompt: "# Hello\n\nContent",
            log: [{ timestamp: "2026-01-01T00:00:00Z", action: "Test" }],
          })}
          initialTab="definition"
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

      // Select Activity, then Feed segment
      fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    fireEvent.click(screen.getByRole("tab", { name: "Feed" }));
      expect(container.querySelector(".detail-activity")).toBeTruthy();
      expect(container.querySelector(".markdown-body")).toBeNull();

      // Switch to Raw Activity segment within Activity tab
      fireEvent.click(screen.getByText("Raw Logs"));
      expect(container.querySelector("[data-testid='agent-log-viewer']")).toBeTruthy();
      expect(container.querySelector(".detail-activity")).toBeNull();

      // Switch back to Feed segment within Activity tab.
    fireEvent.click(screen.getByRole("tab", { name: "Feed" }));
      expect(container.querySelector(".detail-activity")).toBeTruthy();
      expect(container.querySelector("[data-testid='agent-log-viewer']")).toBeNull();

      // Switch to Comments tab
      fireEvent.click(screen.getByText("Comments"));
      expect(screen.getByPlaceholderText(/Add a comment/)).toBeTruthy();
      expect(container.querySelector(".detail-activity")).toBeNull();

      // Switch back to Definition tab
      fireEvent.click(screen.getByText("Plan"));
      expect(container.querySelector(".markdown-body")).toBeTruthy();
      expect(container.querySelector(".detail-activity")).toBeNull();

    });

    it("switches to Raw Activity segment via Activity tab and back", async () => {
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

      // Click Activity tab, then Raw Activity segment
      fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    fireEvent.click(screen.getByRole("tab", { name: "Feed" }));
      fireEvent.click(screen.getByText("Raw Logs"));

      // Agent log viewer should appear
      expect(container.querySelector("[data-testid='agent-log-viewer']")).toBeTruthy();
      // Definition content should be hidden
      expect(container.querySelector(".markdown-body")).toBeNull();

      // Click Definition tab to go back
      fireEvent.click(screen.getByText("Plan"));

      // Definition content should reappear
      expect(container.querySelector(".markdown-body")).toBeTruthy();
      expect(container.querySelector("[data-testid='agent-log-viewer']")).toBeNull();
    });

    it("passes enabled=true to useAgentLogs only when Activity → Raw Logs segment is active", async () => {
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

      // Default: planner Chat active → Raw Logs fetching stays disabled
      const initialCall = mockUseAgentLogs.mock.calls[mockUseAgentLogs.mock.calls.length - 1];
      expect(initialCall[1]).toBe(false);

      // Select Activity and Feed — Raw Logs fetching stays disabled
      fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    fireEvent.click(screen.getByRole("tab", { name: "Feed" }));
      const afterLogsClick = mockUseAgentLogs.mock.calls[mockUseAgentLogs.mock.calls.length - 1];
      expect(afterLogsClick[1]).toBe(false);

      // Switch to Raw Activity segment — enabled should become true
      fireEvent.click(screen.getByText("Raw Logs"));
      const afterAgentLog = mockUseAgentLogs.mock.calls[mockUseAgentLogs.mock.calls.length - 1];
      expect(afterAgentLog[1]).toBe(true);
    });

    it("switches to Comments tab", async () => {
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

      // Click Comments tab
      fireEvent.click(screen.getByText("Comments"));

      // Comments content should appear
      const headings = screen.getAllByText("Comments");
      expect(headings.length).toBeGreaterThanOrEqual(1);
      expect(screen.getByPlaceholderText(/Add a comment/)).toBeTruthy();
      // Definition content should be hidden
      expect(container.querySelector(".markdown-body")).toBeNull();
    });

    it("shows correct top-level tabs without Logs", async () => {
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

      // For an in-progress task (no workflow steps, no merge commit), the
      // top-level tabs are: Activity, Chat, Plan, Changes, Review, Comments,
      // Artifacts, Model, Workflow, Stats, Routing.
      const tabTexts = ["Activity", "Chat", "Plan", "Changes", "Review", "Comments", "Artifacts", "Model", "Workflow", "Stats", "Routing"];
      const tabs = screen.getAllByRole("button").filter((b) =>
        tabTexts.includes(b.textContent || "")
      );
      expect(tabs.map((tab) => tab.textContent)).toEqual(tabTexts);
      expect(tabs[0].textContent).toBe("Activity");
      expect(tabs[1].textContent).toBe("Chat");
      expect(tabs[2].textContent).toBe("Plan");
      expect(tabs[3].textContent).toBe("Changes");
      expect(screen.queryByRole("button", { name: "Logs" })).toBeNull();

      expect(container.querySelectorAll(".detail-tab").length).toBe(11);
      // Workflow tab should always appear even when no workflow steps are configured
      expect(screen.getByText("Workflow")).toBeInTheDocument();
      // Commits tab should NOT appear for non-done tasks
      expect(screen.queryByText("Commits")).toBeNull();
    });
  });

  describe("Chat full-height layout", () => {
    it("FN-6347 defines chat modal-body and section fill-height CSS for desktop and mobile", () => {
      const css = readDashboardStylesSource();
      const bodyRule = getCssRuleBlock(css, ".detail-body--chat");
      const sectionRule = getCssRuleBlock(css, ".detail-section--chat");
      const mobileCss = css.slice(css.indexOf("@media (max-width: 768px)"));
      const mobileBodyRule = getCssRuleBlock(mobileCss, ".detail-body--chat");
      const mobileSectionRule = getCssRuleBlock(mobileCss, ".detail-section--chat");

      expectBaseRule(css, ".detail-body--planner-chat", "display: flex");
      expectBaseRule(css, ".detail-body--planner-chat", "flex-direction: column");
      expectBaseRule(css, ".detail-body--planner-chat", "min-height: 0");
      expectBaseRule(css, ".detail-body--planner-chat", "overflow-y: hidden");
      expect(sectionRule).toContain("display: flex");
      expect(sectionRule).toContain("flex-direction: column");
      expect(sectionRule).toContain("flex: 1");
      expect(sectionRule).toContain("min-height: 0");
      expectBaseRule(mobileCss, ".detail-body--chat", "overflow-y: hidden");
      expectBaseRule(mobileCss, ".detail-body--chat", "min-height: 0");
      expect(mobileSectionRule).toContain("flex: 1");
      expect(mobileSectionRule).toContain("min-height: 0");
    });

    it("FN-6370/FN-6517 defines expanded chat chrome CSS for desktop and mobile", () => {
      const css = readDashboardStylesSource();
      const expandedTitleRule = getCssRuleBlock(css, ".task-detail-content--chat-expanded .detail-title-row");
      const expandedMetaRule = getCssRuleBlock(css, ".task-detail-content--chat-expanded .detail-meta");
      const expandedTabsRule = getCssRuleBlock(css, ".task-detail-content--chat-expanded .detail-tabs");
      const expandedActionsRule = getCssRuleBlock(css, ".task-detail-content--chat-expanded .modal-actions");
      const expandedHeaderRule = getCssRuleBlock(css, ".task-detail-content--chat-expanded .modal-header");
      const expandedBodyRule = getCssRuleBlock(css, ".task-detail-content--chat-expanded .detail-body--chat");
      const expandedSectionRule = getCssRuleBlock(css, ".task-detail-content--chat-expanded .detail-section--chat");
      const mobileCss = css.slice(css.indexOf("@media (max-width: 768px)"));
      const mobileTitleRule = getCssRuleBlock(mobileCss, ".task-detail-content--chat-expanded .detail-title-row");
      const mobileTabsRule = getCssRuleBlock(mobileCss, ".task-detail-content--chat-expanded .detail-tabs");
      const mobileActionsRule = getCssRuleBlock(mobileCss, ".task-detail-content--chat-expanded .modal-actions");

      expect(expandedTitleRule).not.toContain("display: none");
      expect(expandedMetaRule).toContain("display: none");
      expect(expandedTabsRule).toContain("display: none");
      expect(expandedActionsRule).toContain("display: none");
      expect(expandedHeaderRule).toContain("justify-content: space-between");
      expect(expandedBodyRule).toContain("flex: 1");
      expect(expandedBodyRule).toContain("min-height: 0");
      expect(expandedSectionRule).toContain("margin-top: 0");
      expect(mobileTitleRule).not.toContain("display: none");
      expect(mobileTabsRule).toContain("display: none");
      expect(mobileActionsRule).toContain("display: none");
    });

    it("FN-6370/FN-6517 expands and collapses Activity Live without leaving chrome hidden", () => {
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

      fireEvent.click(screen.getByRole("button", { name: "Activity" }));
      const content = container.querySelector(".task-detail-content");
      const titleRow = container.querySelector(".detail-title-row");
      expect(content).not.toHaveClass("task-detail-content--chat-expanded");
      expect(titleRow).toHaveTextContent("FN-099");
      expect(container.querySelector(".detail-tabs")).toBeTruthy();
      expect(container.querySelector(".modal-actions")).toBeTruthy();

      fireEvent.click(screen.getByTestId("task-chat-expand-toggle"));
      expect(content).toHaveClass("task-detail-content--chat-expanded");
      expect(titleRow).toHaveTextContent("FN-099");
      expect(titleRow).toHaveTextContent("In Progress");
      expect(container.querySelector(".detail-tabs")).toBeTruthy();
      expect(container.querySelector(".modal-actions")).toBeTruthy();
      expect(screen.getByTestId("task-chat-expand-toggle")).toHaveAttribute("aria-label", "Collapse activity");
      expect(screen.getByTestId("task-chat-expand-toggle")).toHaveAttribute("aria-pressed", "true");

      fireEvent.click(screen.getByTestId("task-chat-expand-toggle"));
      expect(content).not.toHaveClass("task-detail-content--chat-expanded");
      expect(titleRow).toHaveTextContent("FN-099");
      expect(container.querySelector(".detail-tabs")).toBeTruthy();
      expect(container.querySelector(".modal-actions")).toBeTruthy();
      expect(screen.getByTestId("task-chat-expand-toggle")).toHaveAttribute("aria-label", "Expand activity to full modal");
      expect(screen.getByTestId("task-chat-expand-toggle")).toHaveAttribute("aria-pressed", "false");
    });

    it("FN-7325 keeps Activity expansion available and sticky across Live, Feed, and Raw Logs", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({
            prompt: "# Hello\n\nContent",
            log: [{ timestamp: "2026-01-01T00:00:00Z", action: "Expanded feed entry", outcome: "visible" }],
          })}
          taskDetailChatFirst
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const content = container.querySelector(".task-detail-content");
      expect(screen.getByTestId("task-planner-chat-expand-toggle")).toHaveAttribute("aria-label", "Collapse planner chat");
      expect(screen.queryByTestId("task-chat-expand-toggle")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Activity" }));
      expect(screen.getByRole("tab", { name: "Live" })).toHaveAttribute("aria-selected", "true");
      expect(screen.getByTestId("task-chat-expand-toggle")).toHaveAttribute("aria-label", "Expand activity to full modal");

      fireEvent.click(screen.getByTestId("task-chat-expand-toggle"));
      expect(content).toHaveClass("task-detail-content--chat-expanded");
      expect(screen.getByTestId("task-chat-expand-toggle")).toHaveAttribute("aria-label", "Collapse activity");

    fireEvent.click(screen.getByRole("tab", { name: "Feed" }));
      expect(content).toHaveClass("task-detail-content--chat-expanded");
      expect(screen.getByTestId("task-chat-expand-toggle")).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByText("Expanded feed entry")).toBeInTheDocument();
      expect(container.querySelector(".detail-activity-list")).toBeTruthy();

      fireEvent.click(screen.getByRole("tab", { name: "Raw Logs" }));
      expect(content).toHaveClass("task-detail-content--chat-expanded");
      expect(screen.getByTestId("task-chat-expand-toggle")).toHaveAttribute("aria-pressed", "true");
      expect(container.querySelector("[data-testid='agent-log-viewer']")).toBeTruthy();
    });

    it("FN-7325 resets Activity expansion on task changes but preserves legacy logs routing", () => {
      const { container, rerender } = render(
        <TaskDetailContent
          task={makeTask({ id: "FN-099", prompt: "# Hello\n\nContent" })}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
          addToast={noop}
          initialTab="chat"
        />,
      );

      fireEvent.click(screen.getByTestId("task-chat-expand-toggle"));
      expect(container.querySelector(".task-detail-content")).toHaveClass("task-detail-content--chat-expanded");

      rerender(
        <TaskDetailContent
          task={makeTask({ id: "FN-100", prompt: "# Next\n\nContent" })}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
          addToast={noop}
          initialTab="logs"
        />,
      );

      expect(container.querySelector(".task-detail-content")).not.toHaveClass("task-detail-content--chat-expanded");
      expect(screen.getByRole("tab", { name: "Feed" })).toHaveAttribute("aria-selected", "true");
      expect(screen.getByTestId("task-chat-expand-toggle")).toHaveAttribute("aria-label", "Expand activity to full modal");
    });

    it("FN-7320 removes branch group chrome only while Activity is expanded", () => {
      const branchContext = { groupId: "BG-7320", source: "planning", assignmentMode: "shared" } as const;
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ prompt: "# Hello\n\nContent", branchContext })}
          taskDetailChatFirst
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const content = container.querySelector(".task-detail-content");
      expect(content).not.toHaveClass("task-detail-content--chat-expanded");
      expect(screen.getByTestId("mock-branch-group-card")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Mock branch group toggle BG-7320" })).toBeInTheDocument();
      expect(screen.queryByTestId("task-chat-expand-toggle")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Activity" }));
      fireEvent.click(screen.getByTestId("task-chat-expand-toggle"));
      expect(content).toHaveClass("task-detail-content--chat-expanded");
      expect(screen.queryByTestId("mock-branch-group-card")).toBeNull();
      expect(screen.queryByRole("button", { name: "Mock branch group toggle BG-7320" })).toBeNull();

      fireEvent.click(screen.getByTestId("task-chat-expand-toggle"));
      expect(content).not.toHaveClass("task-detail-content--chat-expanded");
      expect(screen.getByTestId("mock-branch-group-card")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Mock branch group toggle BG-7320" })).toBeInTheDocument();
    });

    it("FN-7320 expands Activity for tasks without branch groups without rendering branch shells", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ prompt: "# Hello\n\nContent", branchContext: undefined })}
          taskDetailChatFirst
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.queryByTestId("mock-branch-group-card")).toBeNull();
      expect(screen.queryByTestId("task-chat-expand-toggle")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Activity" }));
      fireEvent.click(screen.getByTestId("task-chat-expand-toggle"));
      expect(container.querySelector(".task-detail-content")).toHaveClass("task-detail-content--chat-expanded");
      expect(screen.queryByTestId("mock-branch-group-card")).toBeNull();
      expect(screen.queryByRole("button", { name: /Mock branch group toggle/ })).toBeNull();
    });

    it("FN-6517 keeps the title row visible when embedded chat expands", () => {
      const { container } = render(
        <TaskDetailContent
          task={makeTask({ prompt: "# Hello\n\nContent" })}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
          addToast={noop}
          embedded
          initialTab="chat"
        />,
      );

      const content = container.querySelector(".task-detail-content");
      const titleRow = container.querySelector(".detail-title-row");
      expect(content).toHaveClass("task-detail-content--embedded");
      expect(content).not.toHaveClass("task-detail-content--chat-expanded");
      expect(titleRow).toHaveTextContent("FN-099");

      fireEvent.click(screen.getByTestId("task-chat-expand-toggle"));
      expect(content).toHaveClass("task-detail-content--embedded");
      expect(content).toHaveClass("task-detail-content--chat-expanded");
      expect(titleRow).toHaveTextContent("FN-099");
      expect(titleRow).toHaveTextContent("In Progress");
      expect(container.querySelector(".detail-tabs")).toBeTruthy();
      expect(container.querySelector(".modal-actions")).toBeTruthy();
    });

    it("FN-6370 resets expanded Activity when the active tab changes", () => {
      const { container, rerender } = render(
        <TaskDetailContent
          task={makeTask({ prompt: "# Hello\n\nContent" })}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
          addToast={noop}
          initialTab="chat"
        />,
      );

      const content = container.querySelector(".task-detail-content");
      fireEvent.click(screen.getByTestId("task-chat-expand-toggle"));
      expect(content).toHaveClass("task-detail-content--chat-expanded");

      rerender(
        <TaskDetailContent
          task={makeTask({ prompt: "# Hello\n\nContent" })}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
          addToast={noop}
          initialTab="definition"
        />,
      );

      expect(container.querySelector(".task-detail-content--chat-expanded")).toBeNull();
      expect(screen.queryByTestId("task-chat-expand-toggle")).toBeNull();
    });

    it("FN-6370 resets expanded Activity when entering edit mode", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ column: "triage", prompt: "# Hello\n\nContent" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Activity" }));
      fireEvent.click(screen.getByTestId("task-chat-expand-toggle"));
      expect(container.querySelector(".task-detail-content")).toHaveClass("task-detail-content--chat-expanded");

      fireEvent.click(screen.getByLabelText("Edit task"));
      expect(container.querySelector(".task-detail-content--chat-expanded")).toBeNull();
      expect(screen.queryByTestId("task-chat-expand-toggle")).toBeNull();
    });

    it("FN-6532 restores planner Chat first when Chat-first is enabled while preserving explicit Activity requests", () => {
      const { container, rerender } = render(
        <TaskDetailModal
          task={makeTask({ prompt: "# Hello\n\nContent" })}
          taskDetailChatFirst
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const tabs = Array.from(container.querySelectorAll<HTMLButtonElement>(".detail-tab"));
      expect(tabs.map((tab) => tab.textContent)).toEqual(expect.arrayContaining(["Chat", "Activity", "Plan"]));
      expect(tabs[0]).toHaveTextContent("Chat");
      expect(tabs[1]).toHaveTextContent("Activity");
      const plannerChatTab = screen.getByRole("button", { name: "Chat" });
      const activityTab = screen.getByRole("button", { name: "Activity" });
      const definitionTab = screen.getByRole("button", { name: "Plan" });
      expect(plannerChatTab.compareDocumentPosition(activityTab) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(activityTab.compareDocumentPosition(definitionTab) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(plannerChatTab).toHaveClass("detail-tab-active");
      expect(activityTab).not.toHaveClass("detail-tab-active");
      expect(definitionTab).not.toHaveClass("detail-tab-active");
      expect(container.querySelector(".detail-section--planner-chat [data-testid='task-planner-chat-panel']")).toBeTruthy();
      expect(container.querySelector(".detail-section--chat [data-testid='task-chat-tab']")).toBeNull();

      rerender(
        <TaskDetailModal
          task={makeTask({ prompt: "# Hello\n\nContent" })}
          initialTab="logs"
          taskDetailChatFirst
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.getByRole("button", { name: "Activity" })).toHaveClass("detail-tab-active");
      expect(screen.getByRole("tab", { name: "Feed" })).toHaveAttribute("aria-selected", "true");
      expect(container.querySelector(".detail-tabs .detail-tab:first-child")).toHaveTextContent("Chat");
      expect(container.querySelector(".detail-section--chat")).toBeNull();
      expect(container.querySelector(".detail-activity")).toBeTruthy();
    });

    it("FN-6574 renders Definition-only content when initialTab requests definition", () => {
      const blocker = makeTask({ id: "FN-6574", title: "Definition task", prompt: "# Spec\n\nDefinition body unique text.", dependencies: ["FN-100"], githubTracking: { enabled: true } });
      const dependency = makeTask({ id: "FN-100", title: "Dependency task" });
      const dependent = makeTask({ id: "FN-200", title: "Dependent task", dependencies: ["FN-6574"] });
      const { container } = render(
        <TaskDetailModal
          task={blocker}
          tasks={[blocker, dependency, dependent]}
          initialTab="definition"
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.getByRole("button", { name: "Plan" })).toHaveClass("detail-tab-active");
      expect(screen.getByRole("button", { name: "Activity" })).not.toHaveClass("detail-tab-active");
      expect(container.querySelector(".detail-section--chat")).toBeNull();
      expect(screen.getByText("Definition body unique text.")).toBeInTheDocument();
      expect(screen.getByText("GitHub tracking")).toBeInTheDocument();
      expect(screen.getByText("Dependencies")).toBeInTheDocument();
      expect(screen.getByText("Blocking")).toBeInTheDocument();
      expect(container).toHaveTextContent("FN-100");
      expect(container).toHaveTextContent("FN-200");
    });

    it("FN-6347 applies chat modifiers only while the Activity tab is active", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ prompt: "# Hello\n\nContent" })}
          taskDetailChatFirst
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(container.querySelector(".detail-body--planner-chat")).toBeTruthy();
      expect(container.querySelector(".detail-section--planner-chat")).toBeTruthy();
      expect(container.querySelector(".detail-body--chat")).toBeNull();
      expect(container.querySelector(".detail-section--chat")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Activity" }));
      const chatBody = container.querySelector(".detail-body--chat");
      const chatSection = container.querySelector(".detail-section--chat");
      expect(chatBody).toBeTruthy();
      expect(chatBody).not.toHaveClass("detail-body--agent-log");
      expect(chatSection).toBeTruthy();
      expect(chatSection!.querySelector("[data-testid='task-chat-tab']")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Feed" }));
      fireEvent.click(screen.getByText("Raw Logs"));
      expect(container.querySelector(".detail-body--chat")).toBeNull();
      expect(container.querySelector(".detail-section--chat")).toBeNull();
      expect(container.querySelector(".detail-body--agent-log")).toBeTruthy();
    });

    it("FN-6347 removes the chat body modifier while editing", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ column: "triage", prompt: "# Hello\n\nContent" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Activity" }));
      expect(container.querySelector(".detail-body--chat")).toBeTruthy();

      fireEvent.click(screen.getByLabelText("Edit task"));
      expect(container.querySelector(".detail-body--chat")).toBeNull();
      expect(container.querySelector(".detail-section--chat")).toBeNull();
    });
  });

  describe("Raw Logs full-height layout", () => {
    it("applies detail-body--agent-log class when Activity → Raw Logs segment is active", () => {
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

      // Initially, detail-body should NOT have the agent-log modifier
      expect(container.querySelector(".detail-body--agent-log")).toBeNull();

      // Switch to Activity tab, then Raw Activity segment
      fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    fireEvent.click(screen.getByRole("tab", { name: "Feed" }));
      expect(container.querySelector(".detail-body--agent-log")).toBeNull(); // Feed segment default

      fireEvent.click(screen.getByText("Raw Logs"));

      // detail-body should now have the agent-log modifier class
      expect(container.querySelector(".detail-body--agent-log")).toBeTruthy();

      // Switch back to Definition tab
      fireEvent.click(screen.getByText("Plan"));

      // modifier class should be removed
      expect(container.querySelector(".detail-body--agent-log")).toBeNull();
    });

    it("wraps AgentLogViewer in detail-section--agent-log class", () => {
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

      // Switch to Activity tab, then Raw Activity segment
      fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    fireEvent.click(screen.getByRole("tab", { name: "Feed" }));
      fireEvent.click(screen.getByText("Raw Logs"));

      // The section wrapping AgentLogViewer should have the full-height class
      const section = container.querySelector(".detail-section--agent-log");
      expect(section).toBeTruthy();
      expect(section!.querySelector("[data-testid='agent-log-viewer']")).toBeTruthy();
    });

    it("does not apply detail-body--agent-log when editing", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ column: "triage", prompt: "# Hello\n\nContent" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Switch to Activity tab, then Raw Activity segment first
      fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    fireEvent.click(screen.getByRole("tab", { name: "Feed" }));
      fireEvent.click(screen.getByText("Raw Logs"));
      expect(container.querySelector(".detail-body--agent-log")).toBeTruthy();

      // Now enter edit mode via the pencil button in the header
      const editBtn = screen.getByLabelText("Edit task");
      fireEvent.click(editBtn);

      // The detail-body--agent-log class should be removed while editing
      expect(container.querySelector(".detail-body--agent-log")).toBeNull();
    });
  });


});
