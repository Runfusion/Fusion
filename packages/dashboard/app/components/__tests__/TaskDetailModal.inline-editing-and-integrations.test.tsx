import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
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
  readDashboardStylesSource,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import { TaskDetailModal, TaskDetailContent } from "../TaskDetailModal";

setupTaskDetailModalHooks();

describe("TaskDetailModal", () => {
  describe("source issue metadata", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("renders source issue collapsed by default and expands details on toggle", async () => {
      const user = userEvent.setup();
      render(
        <TaskDetailModal
          task={makeTask({
            sourceIssue: {
              provider: "github",
              repository: "runfusion/fusion",
              externalIssueId: "I_kgDOExample",
              issueNumber: 2473,
              url: "https://github.com/runfusion/fusion/issues/2473",
            },
          })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.getByText("Source issue")).toBeTruthy();
      expect(screen.getByLabelText("GitHub source issue")).toBeTruthy();
      const summaryIssueLink = screen.getByRole("link", { name: "(#2473)" });
      expect(summaryIssueLink).toHaveAttribute(
        "href",
        "https://github.com/runfusion/fusion/issues/2473",
      );
      expect(summaryIssueLink.classList.contains("detail-source-link--summary")).toBe(true);
      expect(screen.queryByText("Provider")).toBeNull();

      const toggle = screen.getByRole("button", { name: "Expand source issue details" });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      const chevron = screen.getByTestId("chevron-right-icon");
      expect(chevron.classList.contains("detail-source-chevron--expanded")).toBe(false);

      await user.click(toggle);

      expect(screen.getByRole("button", { name: "Collapse source issue details" })).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByText("Provider")).toBeTruthy();
      expect(screen.getByText("github")).toBeTruthy();
      expect(screen.getByText("runfusion/fusion")).toBeTruthy();
      const sourceLink = screen.getByRole("link", { name: "https://github.com/runfusion/fusion/issues/2473" });
      expect(sourceLink).toHaveAttribute("href", "https://github.com/runfusion/fusion/issues/2473");
      expect(sourceLink).toHaveAttribute("target", "_blank");
      expect(screen.getByTestId("chevron-right-icon").classList.contains("detail-source-chevron--expanded")).toBe(true);
    });

    it("applies compact GitHub source summary styling contracts", () => {
      const css = readDashboardStylesSource();

      expectBaseRule(css, ".detail-source-provider-badge", "border-radius: var(--radius-pill);");
      expectBaseRule(css, ".detail-source-provider-badge", "background: color-mix(in srgb, var(--text-muted) 18%, transparent);");
      expectBaseRule(css, ".detail-source-link--summary", "text-decoration: none;");
      expectBaseRule(css, ".detail-source-section .detail-source-grid", "margin-top: var(--space-sm);");
      expectBaseRule(css, ".detail-source-section .detail-source-grid", "padding-top: var(--space-sm);");
    });

    it("does not render GitHub badge for non-github providers", () => {
      render(
        <TaskDetailModal
          task={makeTask({
            sourceIssue: {
              provider: "gitlab",
              repository: "runfusion/fusion",
              externalIssueId: "42",
              issueNumber: 42,
              url: "https://gitlab.com/runfusion/fusion/-/issues/42",
            },
          })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.queryByLabelText("GitHub source issue")).toBeNull();
      expect(screen.getByRole("link", { name: "(#42)" })).toBeTruthy();
    });

    it("hides source issue read section when sourceIssue metadata is missing", () => {
      render(
        <TaskDetailModal
          task={makeTask({ sourceIssue: undefined })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.queryByText("Source issue")).toBeNull();
      expect(screen.queryByText("No source issue metadata recorded.")).toBeNull();
    });

    it("prefills source issue inputs in edit mode", async () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({
            id: "FN-001",
            column: "todo",
            sourceIssue: {
              provider: "github",
              repository: "runfusion/fusion",
              externalIssueId: "I_kgDOExample",
              issueNumber: 2473,
              url: "https://github.com/runfusion/fusion/issues/2473",
            },
          })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(container.querySelector(".modal-edit-btn")!);
      fireEvent.click(screen.getByTestId("task-form-more-options-toggle"));

      await waitFor(() => {
        expect((screen.getByTestId("task-source-provider-input") as HTMLInputElement).value).toBe("github");
      });
      expect((screen.getByTestId("task-source-repository-input") as HTMLInputElement).value).toBe("runfusion/fusion");
      expect((screen.getByTestId("task-source-external-id-input") as HTMLInputElement).value).toBe("I_kgDOExample");
      expect((screen.getByTestId("task-source-url-input") as HTMLInputElement).value).toBe("https://github.com/runfusion/fusion/issues/2473");
    });

    it("renders source issue block below Model Configuration in edit mode", async () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({
            id: "FN-001",
            column: "todo",
            sourceIssue: {
              provider: "github",
              repository: "runfusion/fusion",
              externalIssueId: "I_kgDOExample",
              issueNumber: 2473,
            },
          })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(container.querySelector(".modal-edit-btn")!);
      fireEvent.click(screen.getByTestId("task-form-more-options-toggle"));

      await waitFor(() => {
        const modelLabel = screen.getByText("Model Configuration");
        const sourceLabel = screen.getByText("Source Issue");
        const workflowSection = screen.getByTestId("workflow-steps-section");

        expect(
          modelLabel.compareDocumentPosition(sourceLabel) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
        expect(
          sourceLabel.compareDocumentPosition(workflowSection) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      });
    });

    it("sends sourceIssue payload when source metadata is edited", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockResolvedValueOnce({ id: "FN-001" } as Task);

      const { container } = render(
        <TaskDetailModal
          task={makeTask({
            id: "FN-001",
            column: "todo",
            sourceIssue: {
              provider: "github",
              repository: "runfusion/fusion",
              externalIssueId: "I_kgDOExample",
              issueNumber: 2473,
              url: "https://github.com/runfusion/fusion/issues/2473",
            },
          })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(container.querySelector(".modal-edit-btn")!);
      fireEvent.click(screen.getByTestId("task-form-more-options-toggle"));
      fireEvent.change(screen.getByTestId("task-source-provider-input"), { target: { value: "gitlab" } });
      fireEvent.change(screen.getByTestId("task-source-repository-input"), { target: { value: "runfusion/dashboard" } });
      fireEvent.change(screen.getByTestId("task-source-external-id-input"), { target: { value: "I_kgDONew" } });
      fireEvent.change(screen.getByTestId("task-source-url-input"), { target: { value: "https://gitlab.com/runfusion/dashboard/-/issues/2473" } });

      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", expect.objectContaining({
          sourceIssue: {
            provider: "gitlab",
            repository: "runfusion/dashboard",
            externalIssueId: "I_kgDONew",
            issueNumber: 2473,
            url: "https://gitlab.com/runfusion/dashboard/-/issues/2473",
          },
        }), undefined);
      });
    });

    it("sends sourceIssue: null when all source metadata fields are cleared", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockResolvedValueOnce({ id: "FN-001" } as Task);

      const { container } = render(
        <TaskDetailModal
          task={makeTask({
            id: "FN-001",
            column: "todo",
            sourceIssue: {
              provider: "github",
              repository: "runfusion/fusion",
              externalIssueId: "I_kgDOExample",
              issueNumber: 2473,
              url: "https://github.com/runfusion/fusion/issues/2473",
            },
          })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(container.querySelector(".modal-edit-btn")!);
      fireEvent.click(screen.getByTestId("task-form-more-options-toggle"));
      fireEvent.change(screen.getByTestId("task-source-provider-input"), { target: { value: "" } });
      fireEvent.change(screen.getByTestId("task-source-repository-input"), { target: { value: "" } });
      fireEvent.change(screen.getByTestId("task-source-external-id-input"), { target: { value: "" } });
      fireEvent.change(screen.getByTestId("task-source-url-input"), { target: { value: "" } });

      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", expect.objectContaining({ sourceIssue: null }), undefined);
      });
    });

    it("keeps edit mode active and shows error toast when source metadata save fails", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockRejectedValueOnce(new Error("source patch failed"));
      const addToast = vi.fn();

      const { container } = render(
        <TaskDetailModal
          task={makeTask({
            id: "FN-001",
            column: "todo",
            sourceIssue: {
              provider: "github",
              repository: "runfusion/fusion",
              externalIssueId: "I_kgDOExample",
              issueNumber: 2473,
            },
          })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={addToast}
        />,
      );

      fireEvent.click(container.querySelector(".modal-edit-btn")!);
      fireEvent.click(screen.getByTestId("task-form-more-options-toggle"));
      fireEvent.change(screen.getByTestId("task-source-provider-input"), { target: { value: "gitlab" } });
      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith("Failed to update FN-001: source patch failed", "error");
      });
      expect(container.querySelector("#task-form-title")).toBeTruthy();
    });
  });

  describe("inline editing", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("shows Edit button in header when task is in triage column", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "triage", title: "Test task" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const editButton = container.querySelector(".modal-edit-btn");
      expect(editButton).toBeTruthy();
    });

    it("shows Edit button in header when task is in todo column", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "todo", title: "Test task" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const editButton = container.querySelector(".modal-edit-btn");
      expect(editButton).toBeTruthy();
    });

    it("does not show Edit button when task is in in-progress column", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "in-progress", title: "Test task" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const editButton = container.querySelector(".modal-edit-btn");
      expect(editButton).toBeNull();
    });

    it("does not show Edit button when already in edit mode", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "triage", title: "Test task" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Enter edit mode
      const editButton = container.querySelector(".modal-edit-btn");
      expect(editButton).toBeTruthy();
      fireEvent.click(editButton!);

      // Edit button should be hidden now
      expect(container.querySelector(".modal-edit-btn")).toBeNull();
      // But TaskForm title input should be visible
      expect(container.querySelector("#task-form-title")).toBeTruthy();
    });

    it("entering edit mode shows title input and description textarea", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "triage", title: "Test task", description: "Test description" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Initially shows title as h2
      expect(container.querySelector("h2.detail-title")).toBeTruthy();
      expect(container.querySelector("#task-form-title")).toBeNull();

      // Enter edit mode
      fireEvent.click(container.querySelector(".modal-edit-btn")!);

      // Now shows edit form with TaskForm fields
      expect(container.querySelector("h2.detail-title")).toBeNull();
      expect(container.querySelector("#task-form-title")).toBeTruthy();
      expect(container.querySelector("#task-form-description")).toBeTruthy();
    });

    it("clicking Cancel exits edit mode without saving", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "triage", title: "Original title", description: "Original description" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Enter edit mode
      fireEvent.click(container.querySelector(".modal-edit-btn")!);

      // Change values
      const titleInput = container.querySelector("#task-form-title") as HTMLInputElement;
      fireEvent.change(titleInput, { target: { value: "Modified title" } });

      // Click Cancel
      fireEvent.click(screen.getByText("Cancel"));

      // Should exit edit mode without saving
      expect(container.querySelector("#task-form-title")).toBeNull();
      expect(container.querySelector("h2.detail-title")?.textContent).toBe("Original title");
    });

    it("clicking Save calls updateTask with correct parameters", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockResolvedValueOnce({ id: "FN-001" } as Task);

      const { container } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "triage", title: "Original title", description: "Original description" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Enter edit mode
      fireEvent.click(container.querySelector(".modal-edit-btn")!);

      // Change values
      const titleInput = container.querySelector("#task-form-title") as HTMLInputElement;
      const descTextarea = container.querySelector("#task-form-description") as HTMLTextAreaElement;
      fireEvent.change(titleInput, { target: { value: "New title" } });
      fireEvent.change(descTextarea, { target: { value: "New description" } });

      // Click Save
      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", expect.objectContaining({
          title: "New title",
          description: "New description",
        }), undefined);
      });
    });

    it("Save button is enabled in edit mode", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "triage", title: "Test title", description: "Test description" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Enter edit mode
      fireEvent.click(container.querySelector(".modal-edit-btn")!);

      const saveButton = screen.getByText("Save");
      expect(saveButton.hasAttribute("disabled")).toBe(false);
    });

    it("Save button shows 'Saving…' during save operation", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      // Delay the resolution to keep isSaving true
      mockUpdate.mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve({ id: "FN-001" } as Task), 100)));

      const { container } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "triage", title: "Original" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Enter edit mode
      fireEvent.click(container.querySelector(".modal-edit-btn")!);

      const titleInput = container.querySelector("#task-form-title") as HTMLInputElement;
      fireEvent.change(titleInput, { target: { value: "Changed title" } });

      // Click Save
      fireEvent.click(screen.getByText("Save"));

      // Should show "Saving…" immediately
      expect(screen.getByText("Saving…")).toBeTruthy();
    });

    it("successful save shows toast and exits edit mode", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockResolvedValueOnce({ id: "FN-001" } as Task);

      const addToast = vi.fn();

      const { container } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "triage", title: "Original" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={addToast}
        />,
      );

      // Enter edit mode
      fireEvent.click(container.querySelector(".modal-edit-btn")!);

      const titleInput = container.querySelector("#task-form-title") as HTMLInputElement;
      fireEvent.change(titleInput, { target: { value: "Changed title" } });

      // Click Save
      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith("Updated FN-001", "success");
      });

      // Should exit edit mode
      expect(container.querySelector("#task-form-title")).toBeNull();
    });

    it("failed save shows toast with error and stays in edit mode", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockRejectedValueOnce(new Error("Network error"));

      const addToast = vi.fn();

      const { container } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "triage", title: "Original" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={addToast}
        />,
      );

      // Enter edit mode
      fireEvent.click(container.querySelector(".modal-edit-btn")!);

      const titleInput = container.querySelector("#task-form-title") as HTMLInputElement;
      fireEvent.change(titleInput, { target: { value: "Changed title" } });

      // Click Save
      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith("Failed to update FN-001: Network error", "error");
      });

      // Should stay in edit mode
      expect(container.querySelector("#task-form-title")).toBeTruthy();
    });

    it("Escape key exits edit mode", async () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "triage", title: "Test title" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Enter edit mode
      fireEvent.click(container.querySelector(".modal-edit-btn")!);
      expect(container.querySelector("#task-form-title")).toBeTruthy();

      // Press Escape (handled via document-level keydown listener)
      await act(async () => {
        const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
        document.dispatchEvent(event);
      });

      // Should exit edit mode
      expect(container.querySelector("#task-form-title")).toBeNull();
    });

    it("edit mode shows both title and description fields", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "triage", title: "Test title", description: "Test description" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Enter edit mode
      fireEvent.click(container.querySelector(".modal-edit-btn")!);

      // Both title and description should be present in TaskForm
      expect(container.querySelector("#task-form-title")).toBeTruthy();
      expect(container.querySelector("#task-form-description")).toBeTruthy();
    });

    it("edit mode renders model configuration and workflow steps", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "triage", title: "Test task" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Enter edit mode
      fireEvent.click(container.querySelector(".modal-edit-btn")!);

      // Model configuration and workflow steps should be present via TaskForm
      expect(screen.getByText(/Model Configuration/i)).toBeTruthy();
      expect(screen.getByText(/Workflow Steps/i)).toBeTruthy();
    });

    it("save sends only changed fields via updateTask", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockResolvedValueOnce({ id: "FN-001" } as Task);

      const { container } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "triage", title: "Test", description: "Desc", dependencies: ["FN-002"] })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Enter edit mode
      fireEvent.click(container.querySelector(".modal-edit-btn")!);

      const descTextarea = container.querySelector("#task-form-description") as HTMLTextAreaElement;
      fireEvent.change(descTextarea, { target: { value: "Updated desc" } });

      // Click Save
      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", {
          description: "Updated desc",
        }, undefined);
      });
    });

    it("includes priority in update payload only when changed", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockResolvedValue({ id: "FN-001" } as Task);

      const { container } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "triage", title: "Test", description: "Desc", priority: "normal" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(container.querySelector(".modal-edit-btn")!);

      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdate).not.toHaveBeenCalled();
      });

      fireEvent.click(container.querySelector(".modal-edit-btn")!);
      fireEvent.click(screen.getByTestId("task-form-more-options-toggle"));
      fireEvent.change(container.querySelector("#task-priority") as HTMLSelectElement, { target: { value: "urgent" } });
      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", { priority: "urgent" }, undefined);
      });
    });

    it("sends executionMode: \"fast\" when changed from standard to fast", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockResolvedValue({ id: "FN-001" } as Task);

      const { container } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "triage", title: "Test", description: "Desc", executionMode: "standard" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(container.querySelector(".modal-edit-btn")!);
      fireEvent.change(screen.getByTestId("task-form-execution-mode-select"), { target: { value: "fast" } });
      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", { executionMode: "fast" }, undefined);
      });
    });

    it("sends executionMode: null when changed from fast to standard", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockResolvedValue({ id: "FN-001" } as Task);

      const { container } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "triage", title: "Test", description: "Desc", executionMode: "fast" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(container.querySelector(".modal-edit-btn")!);
      fireEvent.change(screen.getByTestId("task-form-execution-mode-select"), { target: { value: "standard" } });
      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", { executionMode: null }, undefined);
      });
    });

    it("omits executionMode from update payload when unchanged", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockResolvedValue({ id: "FN-001" } as Task);

      const { container } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "triage", title: "Test", description: "Desc", executionMode: "fast" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(container.querySelector(".modal-edit-btn")!);
      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdate).not.toHaveBeenCalled();
      });
    });

    it("renders normalized priority in detail metadata", async () => {
      render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "triage", description: "Priority metadata", priority: undefined })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const prioritySelect = screen.getByRole("combobox", { name: "Task priority" }) as HTMLSelectElement;
      expect(prioritySelect.value).toBe("normal");
    });

    it("updates priority inline and propagates successful save", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      const onTaskUpdated = vi.fn();
      const addToast = vi.fn();
      const updatedTask = makeTask({ id: "FN-001", column: "triage", priority: "urgent" });
      mockUpdate.mockResolvedValueOnce(updatedTask as Task);

      render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "triage", description: "Priority metadata", priority: "normal" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          onTaskUpdated={onTaskUpdated}
          addToast={addToast}
        />,
      );

      fireEvent.change(screen.getByRole("combobox", { name: "Task priority" }), {
        target: { value: "urgent" },
      });

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", { priority: "urgent" }, undefined);
      });
      expect(onTaskUpdated).toHaveBeenCalledWith(updatedTask);
      expect(addToast).toHaveBeenCalledWith("Priority updated to urgent", "success");
    });

    it("does not call updateTask when inline priority is unchanged", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);

      render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "triage", description: "Priority metadata", priority: "high" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.change(screen.getByRole("combobox", { name: "Task priority" }), {
        target: { value: "high" },
      });

      await waitFor(() => {
        expect(mockUpdate).not.toHaveBeenCalled();
      });
    });

    it("reverts inline priority when save fails", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      const addToast = vi.fn();
      mockUpdate.mockRejectedValueOnce(new Error("Request failed"));

      render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "triage", description: "Priority metadata", priority: "low" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={addToast}
        />,
      );

      const prioritySelect = screen.getByRole("combobox", { name: "Task priority" }) as HTMLSelectElement;
      fireEvent.change(prioritySelect, { target: { value: "urgent" } });

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", { priority: "urgent" }, undefined);
      });
      await waitFor(() => {
        expect(prioritySelect.value).toBe("low");
      });
      expect(addToast).toHaveBeenCalledWith("Failed to update FN-001: Request failed", "error");
    });

    it("toggles inline execution mode from standard to fast", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      const addToast = vi.fn();
      const onTaskUpdated = vi.fn();
      const updatedTask = makeTask({ id: "FN-001", column: "todo", executionMode: "fast" });
      mockUpdate.mockResolvedValueOnce(updatedTask as Task);

      render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "todo", executionMode: "standard" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          onTaskUpdated={onTaskUpdated}
          addToast={addToast}
        />,
      );

      const toggle = screen.getByRole("button", { name: "Execution mode: standard" });
      fireEvent.click(toggle);

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", { executionMode: "fast" }, undefined);
      });
      expect(onTaskUpdated).toHaveBeenCalledWith(updatedTask);
      expect(addToast).toHaveBeenCalledWith("Execution mode updated to fast", "success");
      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Execution mode: fast" })).toHaveAttribute("aria-pressed", "true");
      });
    });

    it("toggles inline execution mode from fast to standard", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockResolvedValueOnce(makeTask({ id: "FN-001", column: "todo", executionMode: null }) as Task);

      render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "todo", executionMode: "fast" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Execution mode: fast" }));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", { executionMode: null }, undefined);
      });
      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Execution mode: standard" })).toHaveAttribute("aria-pressed", "false");
      });
    });

    it("reverts inline execution mode when save fails", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      const addToast = vi.fn();
      mockUpdate.mockRejectedValueOnce(new Error("Request failed"));

      render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "todo", executionMode: "standard" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={addToast}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Execution mode: standard" }));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", { executionMode: "fast" }, undefined);
      });
      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Execution mode: standard" })).toHaveAttribute("aria-pressed", "false");
      });
      expect(addToast).toHaveBeenCalledWith("Failed to update FN-001: Request failed", "error");
    });

    it("disables inline execution mode toggle while save is in-flight", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(() => resolve(makeTask({ executionMode: "fast" }) as Task), 100)),
      );

      render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "todo", executionMode: "standard" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const toggle = screen.getByRole("button", { name: "Execution mode: standard" });
      fireEvent.click(toggle);
      expect(toggle).toBeDisabled();

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", { executionMode: "fast" }, undefined);
      });
    });

    it("pre-populates form with existing task values", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "todo", title: "My Task", description: "My Description" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Enter edit mode
      fireEvent.click(container.querySelector(".modal-edit-btn")!);

      const titleInput = container.querySelector("#task-form-title") as HTMLInputElement;
      const descTextarea = container.querySelector("#task-form-description") as HTMLTextAreaElement;
      expect(titleInput.value).toBe("My Task");
      expect(descTextarea.value).toBe("My Description");
    });

    it("pre-populates working/base branch inputs and saves changed branch only", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockResolvedValueOnce({ id: "FN-001" } as Task);

      const { container } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "todo", branch: "feature/fn-3422", baseBranch: "develop" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(container.querySelector(".modal-edit-btn")!);

      const workingBranchInput = container.querySelector("#task-working-branch") as HTMLInputElement;
      const baseBranchInput = container.querySelector("#task-base-branch") as HTMLInputElement;
      expect(workingBranchInput.value).toBe("feature/fn-3422");
      expect(baseBranchInput.value).toBe("develop");

      fireEvent.change(workingBranchInput, { target: { value: "feature/fn-3422-updated" } });
      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", { branch: "feature/fn-3422-updated" }, undefined);
      });
    });

    it("saves changed baseBranch independently of branch", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockResolvedValueOnce({ id: "FN-001" } as Task);

      const { container } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "todo", branch: "feature/fn-3422", baseBranch: "develop" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(container.querySelector(".modal-edit-btn")!);
      fireEvent.change(container.querySelector("#task-base-branch") as HTMLInputElement, { target: { value: "release/2026-05" } });
      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", { baseBranch: "release/2026-05" }, undefined);
      });
    });

    it("sends null branch fields when working/base branches are cleared", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockResolvedValueOnce({ id: "FN-001" } as Task);

      const { container } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "todo", branch: "feature/fn-3422", baseBranch: "main" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(container.querySelector(".modal-edit-btn")!);
      fireEvent.change(container.querySelector("#task-working-branch") as HTMLInputElement, { target: { value: "" } });
      fireEvent.change(container.querySelector("#task-base-branch") as HTMLInputElement, { target: { value: "" } });
      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith(
          "FN-001",
          expect.objectContaining({ branch: null, baseBranch: null }),
          undefined,
        );
      });
    });

    it("propagates auto-saved description updates via onTaskUpdated", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdateTask = vi.mocked(updateTask);
      const onTaskUpdated = vi.fn();

      const initialTask = makeTask({
        id: "FN-001",
        column: "todo",
        title: "My Task",
        description: "Old Description",
      });
      const updatedTask = {
        ...initialTask,
        description: "New Description",
      };

      mockUpdateTask.mockResolvedValueOnce(updatedTask);

      const { container } = render(
        <TaskDetailModal
          task={initialTask}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          onTaskUpdated={onTaskUpdated}
          addToast={noop}
        />,
      );

      fireEvent.click(container.querySelector(".modal-edit-btn")!);

      const descTextarea = container.querySelector("#task-form-description") as HTMLTextAreaElement;
      fireEvent.change(descTextarea, { target: { value: "New Description" } });

      await waitFor(() => {
        expect(mockUpdateTask).toHaveBeenCalledWith("FN-001", { description: "New Description" }, undefined);
        expect(onTaskUpdated).toHaveBeenCalledWith(updatedTask);
      }, { timeout: 3500 });
    });

    it("uses updated model values in edit mode after saving from the Model tab", async () => {
      const { fetchModels, updateTask } = await import("../../api");
      const mockFetchModels = vi.mocked(fetchModels);
      const mockUpdateTask = vi.mocked(updateTask);
      const user = userEvent.setup();

      const availableModels = [
        { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true, contextWindow: 200000 },
        { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
      ];
      mockFetchModels.mockResolvedValue({
        models: availableModels,
        favoriteProviders: [],
        favoriteModels: [],
      });

      const initialTask = makeTask({ id: "FN-001", column: "triage", title: "Model sync test" });
      const updatedAfterExecutor: Task = {
        ...initialTask,
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
      };
      const updatedAfterValidator: Task = {
        ...updatedAfterExecutor,
        validatorModelProvider: "openai",
        validatorModelId: "gpt-4o",
      };

      mockUpdateTask
        .mockResolvedValueOnce(updatedAfterExecutor)
        .mockResolvedValueOnce(updatedAfterValidator);

      function StatefulModal() {
        const [task, setTask] = useState<TaskDetail>(initialTask);

        return (
          <TaskDetailModal
            task={task}
            onClose={noop}
            onMoveTask={noopMove}
            onDeleteTask={noopDelete}
            onMergeTask={noopMerge}
            onOpenDetail={noopOpenDetail}
            onTaskUpdated={(updated) => setTask((prev) => ({ ...prev, ...updated }))}
            addToast={noop}
          />
        );
      }

      const { container } = render(<StatefulModal />);

      await user.click(screen.getByText("Model"));
      await waitFor(() => {
        expect(screen.getByLabelText("Executor Model")).toBeInTheDocument();
      });

      await user.click(screen.getByLabelText("Executor Model"));
      await user.click(screen.getByText("Claude Sonnet 4.5"));

      await waitFor(() => {
        expect(mockUpdateTask).toHaveBeenNthCalledWith(
          1,
          "FN-001",
          expect.objectContaining({
            modelProvider: "anthropic",
            modelId: "claude-sonnet-4-5",
          }),
        );
      });

      await user.click(screen.getByLabelText("Reviewer Model"));
      await user.click(screen.getByText("GPT-4o"));

      await waitFor(() => {
        expect(mockUpdateTask).toHaveBeenNthCalledWith(
          2,
          "FN-001",
          {
            validatorModelProvider: "openai",
            validatorModelId: "gpt-4o",
          },
        );
      });

      fireEvent.click(container.querySelector(".modal-edit-btn")!);

      await waitFor(() => {
        expect(screen.getByLabelText("Executor Model")).toHaveTextContent("Claude Sonnet 4.5");
        expect(screen.getByLabelText("Reviewer Model")).toHaveTextContent("GPT-4o");
      });
    });

    it("renders Save and Cancel in the modal footer, not inside the edit form body", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "triage", title: "Test task" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Enter edit mode
      fireEvent.click(container.querySelector(".modal-edit-btn")!);

      // The edit form body should NOT contain the Save or Cancel action buttons
      const editForm = container.querySelector(".modal-edit-form");
      expect(editForm).toBeTruthy();
      const formButtons = Array.from(editForm!.querySelectorAll("button"));
      const formButtonTexts = formButtons.map((b) => b.textContent);
      expect(formButtonTexts).not.toContain("Save");
      expect(formButtonTexts).not.toContain("Cancel");
      expect(formButtonTexts).not.toContain("Saving…");

      // The modal-actions footer should contain the Save and Cancel buttons
      const modalActions = container.querySelector(".modal-actions");
      expect(modalActions).toBeTruthy();
      const footerButtons = modalActions!.querySelectorAll("button");
      const buttonTexts = Array.from(footerButtons).map((b) => b.textContent);
      expect(buttonTexts).toContain("Cancel");
      expect(buttonTexts).toContain("Save");
    });

    it("renders keyboard hint in the modal footer when editing", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "triage", title: "Test task" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Enter edit mode
      fireEvent.click(container.querySelector(".modal-edit-btn")!);

      // The hint should be in the modal-actions footer, not inside the edit form body
      const editForm = container.querySelector(".modal-edit-form");
      expect(editForm!.querySelector(".modal-edit-hint")).toBeNull();

      const modalActions = container.querySelector(".modal-actions");
      expect(modalActions!.querySelector(".modal-edit-hint")).toBeTruthy();
    });

    it("shows normal modal actions (not edit actions) when not editing", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "todo", title: "Test task" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Should NOT be in edit mode — no edit hint, no Save/Cancel in footer
      const modalActions = container.querySelector(".modal-actions");
      expect(modalActions!.querySelector(".modal-edit-hint")).toBeNull();

      const footerButtons = modalActions!.querySelectorAll("button");
      const buttonTexts = Array.from(footerButtons).map((b) => b.textContent);
      expect(buttonTexts).not.toContain("Save");
      expect(buttonTexts).not.toContain("Cancel");
      // Should contain Actions dropdown and Move primary action
      expect(buttonTexts).toContain("Actions");
      expect(buttonTexts.some((t) => t?.includes("Move to"))).toBe(true);
    });
  });


  describe("comment state propagation (FN-845)", () => {
    it("passes onTaskUpdated to TaskComments when provided", async () => {
      const { addSteeringComment } = await import("../../api");
      const onTaskUpdated = vi.fn();
      const updatedTask = makeTask({
        comments: [{ id: "c1", text: "New comment", author: "user", createdAt: "2026-01-01T00:00:00.000Z" }],
      });
      vi.mocked(addSteeringComment).mockResolvedValueOnce(updatedTask);

      render(
        <TaskDetailModal
          task={makeTask()}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          onTaskUpdated={onTaskUpdated}
          addToast={noop}
        />,
      );

      // Switch to Comments tab
      fireEvent.click(screen.getByText("Comments"));

      // Add a comment
      fireEvent.change(screen.getByPlaceholderText(/Add a comment/), { target: { value: "New comment" } });
      fireEvent.click(screen.getByText("Add Comment"));

      await waitFor(() => {
        expect(addSteeringComment).toHaveBeenCalledWith("FN-099", "New comment", undefined);
        expect(onTaskUpdated).toHaveBeenCalledWith(updatedTask);
      });
    });

    it("comment mutations still work when onTaskUpdated is not provided", async () => {
      const { addSteeringComment } = await import("../../api");
      const addToast = vi.fn();
      vi.mocked(addSteeringComment).mockResolvedValueOnce(makeTask({
        comments: [{ id: "c1", text: "Hello", author: "user", createdAt: "2026-01-01T00:00:00.000Z" }],
      }));

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

      // Switch to Comments tab
      fireEvent.click(screen.getByText("Comments"));

      // Add a comment — should succeed without error even without onTaskUpdated
      fireEvent.change(screen.getByPlaceholderText(/Add a comment/), { target: { value: "Hello" } });
      fireEvent.click(screen.getByText("Add Comment"));

      await waitFor(() => {
        expect(addSteeringComment).toHaveBeenCalledWith("FN-099", "Hello", undefined);
        expect(addToast).toHaveBeenCalledWith("Comment added", "success");
      });
    });
  });


  describe("Workflow step ordering in edit mode (FN-836)", () => {
    it("sends ordered enabledWorkflowSteps when saving with reordered steps", async () => {
      const { updateTask, fetchWorkflowSteps } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockResolvedValueOnce({ id: "FN-001" } as Task);
      vi.mocked(fetchWorkflowSteps).mockResolvedValueOnce([
        { id: "WS-001", name: "QA Check", description: "Run tests", prompt: "Check tests", mode: "prompt" as const, enabled: true, createdAt: "", updatedAt: "" },
        { id: "WS-002", name: "Security Audit", description: "Check security", prompt: "Check security", mode: "prompt" as const, enabled: true, createdAt: "", updatedAt: "" },
      ]);

      const { container } = render(
        <TaskDetailModal
          task={makeTask({
            id: "FN-001",
            column: "triage",
            title: "Test",
            description: "Desc",
            enabledWorkflowSteps: ["WS-001", "WS-002"],
          })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Enter edit mode
      fireEvent.click(container.querySelector(".modal-edit-btn")!);

      // Wait for workflow steps to load and reorder controls to appear
      await waitFor(() => {
        expect(screen.getByTestId("workflow-step-order")).toBeTruthy();
      });

      // Move WS-002 up (swap with WS-001)
      fireEvent.click(screen.getByTestId("workflow-step-move-up-WS-002"));

      // Save
      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", expect.objectContaining({
          enabledWorkflowSteps: ["WS-002", "WS-001"],
        }), undefined);
      });
    });
  });


  describe("agent assignment", () => {
    it("shows Assign Agent button when task has no assigned agent", () => {
      render(
        <TaskDetailModal
          task={makeTask({ assignedAgentId: undefined })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.getByRole("button", { name: "Assign Agent" })).toBeInTheDocument();
    });

    it("shows assigned agent chip and clear button when task has assignedAgentId", async () => {
      const { fetchAgent } = await import("../../api");
      vi.mocked(fetchAgent).mockResolvedValue({
        id: "agent-002",
        name: "Pipeline Helper",
        role: "executor",
        state: "active",
        metadata: {},
        heartbeatHistory: [],
        completedRuns: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      } as any);

      render(
        <TaskDetailModal
          task={makeTask({ assignedAgentId: "agent-002" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("Pipeline Helper")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Unassign agent" })).toBeInTheDocument();
      });
    });

    it("assigns selected agent via assignTask", async () => {
      const { fetchAgents, assignTask } = await import("../../api");
      vi.mocked(fetchAgents).mockResolvedValue([
        {
          id: "agent-001",
          name: "Task Runner",
          role: "executor",
          state: "active",
          metadata: {},
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ] as any);
      vi.mocked(assignTask).mockResolvedValue(makeTask({ assignedAgentId: "agent-001" }) as any);

      render(
        <TaskDetailModal
          task={makeTask({ assignedAgentId: undefined })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      await userEvent.click(screen.getByRole("button", { name: "Assign Agent" }));
      await userEvent.click(screen.getByRole("button", { name: /Task Runner/i }));

      await waitFor(() => {
        expect(assignTask).toHaveBeenCalledWith("FN-099", "agent-001", undefined);
      });
    });

    it("clears assigned agent via assignTask(null)", async () => {
      const { fetchAgent, assignTask } = await import("../../api");
      vi.mocked(fetchAgent).mockResolvedValue({
        id: "agent-005",
        name: "Doc Bot",
        role: "executor",
        state: "active",
        metadata: {},
        heartbeatHistory: [],
        completedRuns: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      } as any);
      vi.mocked(assignTask).mockResolvedValue(makeTask({ assignedAgentId: undefined }) as any);

      render(
        <TaskDetailModal
          task={makeTask({ assignedAgentId: "agent-005" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      await userEvent.click(screen.getByRole("button", { name: "Unassign agent" }));

      await waitFor(() => {
        expect(assignTask).toHaveBeenCalledWith("FN-099", null, undefined);
      });
    });
  });

  describe("optimistic opening with Task", () => {
    beforeEach(async () => {
      const { fetchTaskDetail } = await import("../../api");
      vi.mocked(fetchTaskDetail).mockReset();
    });

    it("renders immediately when opened with a Task prop (no prompt)", async () => {
      const { fetchTaskDetail } = await import("../../api");
      vi.mocked(fetchTaskDetail).mockResolvedValueOnce({
        id: "FN-200",
        description: "Optimistic task",
        column: "todo",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        prompt: "# Spec",
      } as TaskDetail);

      const task: Task = {
        id: "FN-200",
        description: "Optimistic task",
        column: "todo",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      } as Task;

      const { container } = render(
        <TaskDetailModal
          task={task}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Modal renders immediately without crashing
      expect(container.querySelector(".modal-overlay")).toBeTruthy();
      expect(screen.getByText("FN-200")).toBeDefined();
    });

    it("calls fetchTaskDetail on mount when prop is Task without prompt", async () => {
      const { fetchTaskDetail } = await import("../../api");
      const mockFetch = vi.mocked(fetchTaskDetail);
      mockFetch.mockResolvedValueOnce({
        id: "FN-201",
        description: "Optimistic task",
        column: "todo",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        prompt: "# Spec",
      } as TaskDetail);

      const task: Task = {
        id: "FN-201",
        description: "Optimistic task",
        column: "todo",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      } as Task;

      render(
        <TaskDetailModal
          task={task}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith("FN-201", undefined);
      });
    });

    it("does NOT call fetchTaskDetail when prop is already a TaskDetail with prompt", async () => {
      const { fetchTaskDetail } = await import("../../api");
      const mockFetch = vi.mocked(fetchTaskDetail);

      const detail: TaskDetail = {
        id: "FN-202",
        description: "Full detail task",
        column: "todo",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        prompt: "# Full spec",
      } as TaskDetail;

      render(
        <TaskDetailModal
          task={detail}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Give a tick for any async operations
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockFetch).not.toHaveBeenCalledWith("FN-202", undefined);
    });

    it("shows loading state in spec area when detailLoading is true", async () => {
      const { fetchTaskDetail } = await import("../../api");
      const mockFetch = vi.mocked(fetchTaskDetail);
      // Set up a pending promise so loading state persists
      mockFetch.mockResolvedValueOnce(new Promise(() => {}) as any);

      const task: Task = {
        id: "FN-203",
        description: "Loading spec test",
        column: "todo",
        dependencies: [],
        steps: [{ name: "Plan", status: "in-progress" }],
        currentStep: 0,
        log: [{ timestamp: "2026-04-24T09:00:00.000Z", action: "[timing] setup in 120ms" }],
        executionMode: "fast",
        status: "executing",
        assignedAgentId: "agent-loading",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      } as Task;

      render(
        <TaskDetailModal
          task={task}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.getByText("Loading specification…")).toBeDefined();
      // Token stats now live in their own Stats tab — switch to it before
      // asserting on token-loading text.
      fireEvent.click(screen.getByRole("button", { name: "Stats" }));
      expect(screen.getByText("Execution Timing")).toBeInTheDocument();
      expect(screen.getByText("Execution Details")).toBeInTheDocument();
      expect(screen.getByText("Loading token statistics…")).toBeDefined();
      expect(screen.getAllByText("Fast").length).toBeGreaterThan(0);
      expect(screen.getByText("executing")).toBeInTheDocument();
    });

    it("shows spec content after fetchTaskDetail resolves", async () => {
      const { fetchTaskDetail } = await import("../../api");
      const mockFetch = vi.mocked(fetchTaskDetail);

      const task: Task = {
        id: "FN-204",
        description: "Async spec test",
        column: "todo",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      } as Task;

      const fullDetail: TaskDetail = {
        ...task,
        prompt: "# Async Spec\n\nThis is the loaded spec content.",
        log: [
          { timestamp: "2026-04-24T09:00:00.000Z", action: "[timing] prepare env in 120ms" },
          { timestamp: "2026-04-24T09:01:00.000Z", action: "[timing] run tests in 3400ms" },
        ],
        workflowStepResults: [
          {
            workflowStepId: "WS-101",
            workflowStepName: "Workflow QA",
            status: "passed",
            startedAt: "2026-04-24T09:10:00.000Z",
            completedAt: "2026-04-24T09:10:07.000Z",
          },
        ],
        executionMode: "fast",
        status: "executing",
        mergeRetries: 1,
        workflowStepRetries: 2,
        recoveryRetryCount: 3,
        taskDoneRetryCount: 4,
        tokenUsage: {
          inputTokens: 1200,
          outputTokens: 450,
          cachedTokens: 210,
          totalTokens: 1860,
          firstUsedAt: "2026-04-24T09:00:00.000Z",
          lastUsedAt: "2026-04-24T10:15:00.000Z",
        },
      } as TaskDetail;

      // Resolve with full detail
      mockFetch.mockResolvedValueOnce(fullDetail);

      const { container } = render(
        <TaskDetailModal
          task={task}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Initially shows loading
      expect(screen.getByText("Loading specification…")).toBeDefined();

      // After fetch resolves, spec content appears
      await waitFor(() => {
        const markdownBody = container.querySelector(".markdown-body");
        expect(markdownBody).toBeTruthy();
      }, { timeout: 3000 });

      // Loading indicator should be gone
      expect(screen.queryByText("Loading specification…")).toBeNull();

      // Token stats live behind the Stats tab now.
      fireEvent.click(screen.getByRole("button", { name: "Stats" }));
      expect(screen.queryByText("Loading token statistics…")).toBeNull();
      expect(screen.getByText("Execution Timing")).toBeInTheDocument();
      expect(screen.getByText("Execution Details")).toBeInTheDocument();
      expect(screen.getByText("Timing events")).toBeInTheDocument();
      expect(screen.getByText("Workflow runtime")).toBeInTheDocument();
      expect(screen.getByText("Execution mode")).toBeInTheDocument();
      expect(screen.getByText("Runtime status")).toBeInTheDocument();
      expect(screen.getAllByText("Fast").length).toBeGreaterThan(0);
      expect(screen.getByText("executing")).toBeInTheDocument();
      expect(screen.getByText((1200).toLocaleString())).toBeInTheDocument();
      expect(screen.getByText((450).toLocaleString())).toBeInTheDocument();
      expect(screen.getByText((210).toLocaleString())).toBeInTheDocument();
      expect(screen.getByText((1860).toLocaleString())).toBeInTheDocument();
      const firstUsed = container.querySelector('time[datetime="2026-04-24T09:00:00.000Z"]');
      const lastUsed = container.querySelector('time[datetime="2026-04-24T10:15:00.000Z"]');
      expect(firstUsed).toBeTruthy();
      expect(lastUsed).toBeTruthy();
    });

    it("preserves fullDetail.log when SSE-stripped task prop has empty log", async () => {
      // Regression: SSE strips `log` to [] in task list payloads (see
      // stripTaskListHeavyFields in packages/dashboard/src/sse.ts). The modal
      // merges live `task` over `fullDetail` to keep tokenUsage/status fresh,
      // which previously clobbered fullDetail.log and emptied the Activity tab.
      const { fetchTaskDetail } = await import("../../api");
      const mockFetch = vi.mocked(fetchTaskDetail);

      const strippedTask: Task = {
        id: "FN-LOG-1",
        description: "SSE stripped task",
        column: "in-progress",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };

      mockFetch.mockResolvedValueOnce({
        ...strippedTask,
        prompt: "# Spec",
        log: [
          { timestamp: "2026-04-24T09:00:00.000Z", action: "Created task" },
          { timestamp: "2026-04-24T09:01:00.000Z", action: "Started executor", outcome: "OK" },
        ],
      } as TaskDetail);

      const { container } = render(
        <TaskDetailModal
          task={strippedTask}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Wait for fetchTaskDetail to resolve.
      await waitFor(() => {
        expect(container.querySelector(".markdown-body")).toBeTruthy();
      }, { timeout: 3000 });

      fireEvent.click(screen.getByText("Logs"));

      const activityList = container.querySelector(".detail-activity-list");
      expect(activityList).toBeTruthy();
      const logEntries = container.querySelectorAll(".detail-log-entry");
      expect(logEntries).toHaveLength(2);
      expect(logEntries[0].textContent).toContain("Started executor");
      expect(logEntries[1].textContent).toContain("Created task");
    });

    it("shows token stats empty state once detail is loaded without usage", async () => {
      const { fetchTaskDetail } = await import("../../api");
      const mockFetch = vi.mocked(fetchTaskDetail);

      const task: Task = {
        id: "FN-205",
        description: "No token stats",
        column: "todo",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      } as Task;

      mockFetch.mockResolvedValueOnce({
        ...task,
        prompt: "# Async Spec\n\nSpec without usage.",
        tokenUsage: undefined,
      } as TaskDetail);

      render(
        <TaskDetailModal
          task={task}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Token stats live behind the Stats tab now — wait for the modal to
      // settle, then switch tabs and assert on the empty state.
      await waitFor(() => {
        expect(screen.queryByText("Loading specification…")).toBeNull();
      });
      fireEvent.click(screen.getByRole("button", { name: "Stats" }));
      await waitFor(() => {
        expect(screen.getByText("No token usage recorded for this task yet.")).toBeInTheDocument();
      });
    });
  });

  describe("PluginSlot integration", () => {
    it("renders plugin tabs when plugins register for task-detail-tab slot", async () => {
      mockUsePluginUiSlots.mockReturnValue({
        slots: [
          { pluginId: "plugin-a", slot: { slotId: "task-detail-tab", label: "Plugin A Tab", componentPath: "./a.js" } },
          { pluginId: "plugin-b", slot: { slotId: "task-detail-tab", label: "Plugin B Tab", componentPath: "./b.js" } },
        ],
        getSlotsForId: (id: string) => id === "task-detail-tab" ? [
          { pluginId: "plugin-a", slot: { slotId: "task-detail-tab", label: "Plugin A Tab", componentPath: "./a.js" } },
          { pluginId: "plugin-b", slot: { slotId: "task-detail-tab", label: "Plugin B Tab", componentPath: "./b.js" } },
        ] : [],
        loading: false,
        error: null,
      } as any);

      render(
        <TaskDetailModal
          task={makeTask()}
          onClose={noop}
          onOpenDetail={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          addToast={noop}
        />
      );

      // Both plugin tabs should appear
      expect(screen.getByText("Plugin A Tab")).toBeDefined();
      expect(screen.getByText("Plugin B Tab")).toBeDefined();
    });

    it("shows only the selected plugin tab content when plugin tab is clicked", async () => {
      mockUsePluginUiSlots.mockReturnValue({
        slots: [
          { pluginId: "plugin-a", slot: { slotId: "task-detail-tab", label: "Plugin A Tab", componentPath: "./a.js" } },
          { pluginId: "plugin-b", slot: { slotId: "task-detail-tab", label: "Plugin B Tab", componentPath: "./b.js" } },
        ],
        getSlotsForId: (id: string) => id === "task-detail-tab" ? [
          { pluginId: "plugin-a", slot: { slotId: "task-detail-tab", label: "Plugin A Tab", componentPath: "./a.js" } },
          { pluginId: "plugin-b", slot: { slotId: "task-detail-tab", label: "Plugin B Tab", componentPath: "./b.js" } },
        ] : [],
        loading: false,
        error: null,
      } as any);

      const { container } = render(
        <TaskDetailModal
          task={makeTask()}
          onClose={noop}
          onOpenDetail={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          addToast={noop}
        />
      );

      await userEvent.click(screen.getByText("Plugin B Tab"));

      const slots = container.querySelectorAll('[data-slot-id="task-detail-tab"]');
      expect(slots).toHaveLength(1);
      expect(slots[0]).toHaveAttribute("data-plugin-id", "plugin-b");
      expect(container.querySelector('[data-plugin-id="plugin-a"]')).toBeNull();
    });

    it("renders no extra tabs when no plugins register", () => {
      mockUsePluginUiSlots.mockReturnValue({
        slots: [],
        getSlotsForId: vi.fn(() => []),
        loading: false,
        error: null,
      });

      render(
        <TaskDetailModal
          task={makeTask()}
          onClose={noop}
          onOpenDetail={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          addToast={noop}
        />
      );

      // Only standard tabs should be visible (Definition, Logs, etc.)
      expect(screen.getByText("Definition")).toBeDefined();
      expect(screen.getByText("Logs")).toBeDefined();
      // Plugin tabs should not exist
      expect(screen.queryByText("Plugin A Tab")).toBeNull();
    });
  });

  describe("github tracking section", () => {
    it("renders linked issue as link when url exists", () => {
      render(
        <TaskDetailModal
          task={makeTask({
            githubTracking: {
              enabled: true,
              issue: {
                owner: "runfusion",
                repo: "fusion",
                number: 123,
                url: "https://github.com/runfusion/fusion/issues/123",
                createdAt: "2026-01-01T00:00:00Z",
              },
            },
            issueInfo: { url: "https://github.com/runfusion/fusion/issues/123", number: 123, state: "open", title: "Issue" },
          })}
          onClose={noop}
          onOpenDetail={noopOpenDetail}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          addToast={noop}
        />,
      );

      expect(screen.getByText("GitHub tracking")).toBeTruthy();
      expect(screen.getByRole("link", { name: "runfusion/fusion#123" })).toHaveAttribute("href", "https://github.com/runfusion/fusion/issues/123");
    });

    it("shows section when tracking is disabled and task is in an eligible column", () => {
      render(
        <TaskDetailModal
          task={makeTask({ column: "todo", githubTracking: { enabled: false } })}
          onClose={noop}
          onOpenDetail={noopOpenDetail}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          addToast={noop}
        />,
      );

      expect(screen.getByText("GitHub tracking")).toBeTruthy();
      expect(screen.getByText("Tracking is currently disabled")).toBeTruthy();
    });

    it("hides section when tracking is disabled and task is not in an eligible column", () => {
      render(
        <TaskDetailModal
          task={makeTask({ column: "done", githubTracking: { enabled: false } })}
          onClose={noop}
          onOpenDetail={noopOpenDetail}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          addToast={noop}
        />,
      );

      expect(screen.queryByText("GitHub tracking")).toBeNull();
    });

    it("sends githubTracking disabled→enabled toggle payload", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockResolvedValueOnce({ id: "FN-001" } as Task);

      render(
        <TaskDetailModal
          task={makeTask({
            id: "FN-001",
            column: "todo",
            githubTracking: {
              enabled: false,
              issue: {
                owner: "runfusion",
                repo: "fusion",
                number: 99,
                url: "https://github.com/runfusion/fusion/issues/99",
                createdAt: "2026-01-01T00:00:00Z",
              },
            },
          })}
          onClose={noop}
          onOpenDetail={noopOpenDetail}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          addToast={noop}
        />,
      );

      const toggle = screen.getByLabelText("Enable GitHub tracking") as HTMLInputElement;
      expect(toggle.checked).toBe(false);

      fireEvent.click(toggle);

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", { githubTracking: { enabled: true } }, undefined);
      });
      expect(toggle.checked).toBe(true);
    });

    it("sends githubTracking enabled→disabled toggle payload", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockResolvedValueOnce({ id: "FN-001" } as Task);

      render(
        <TaskDetailModal
          task={makeTask({
            id: "FN-001",
            column: "in-progress",
            githubTracking: {
              enabled: true,
            },
          })}
          onClose={noop}
          onOpenDetail={noopOpenDetail}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByLabelText("Enable GitHub tracking"));
      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", { githubTracking: { enabled: false } }, undefined);
      });
    });

    it("sends repo override updates and null when cleared", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockResolvedValue({ id: "FN-001" } as Task);

      render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "todo", githubTracking: { enabled: true, repoOverride: "runfusion/fusion" } })}
          onClose={noop}
          onOpenDetail={noopOpenDetail}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          addToast={noop}
        />,
      );

      fireEvent.change(screen.getByPlaceholderText("owner/repo"), { target: { value: "runfusion/cli" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", { githubTracking: { repoOverride: "runfusion/cli" } }, undefined);
      });

      fireEvent.change(screen.getByPlaceholderText("owner/repo"), { target: { value: "   " } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", { githubTracking: { repoOverride: null } }, undefined);
      });
    });

    it("unlinks issue after confirm and skips on cancel", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockResolvedValue({ id: "FN-001" } as Task);

      mockConfirm.mockResolvedValueOnce(false);
      render(
        <TaskDetailModal
          task={makeTask({
            id: "FN-001",
            column: "todo",
            githubTracking: {
              enabled: true,
              issue: {
                owner: "runfusion",
                repo: "fusion",
                number: 200,
                url: "https://github.com/runfusion/fusion/issues/200",
                createdAt: "2026-01-01T00:00:00Z",
              },
            },
          })}
          onClose={noop}
          onOpenDetail={noopOpenDetail}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Unlink GitHub issue" }));
      await waitFor(() => {
        expect(mockUpdate).not.toHaveBeenCalledWith("FN-001", { githubTracking: { issue: null } }, undefined);
      });

      mockConfirm.mockResolvedValueOnce(true);
      fireEvent.click(screen.getByRole("button", { name: "Unlink GitHub issue" }));
      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-001", { githubTracking: { issue: null } }, undefined);
      });
    });
  });
});
