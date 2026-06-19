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
  readDashboardStylesSource,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import { TaskDetailModal, TaskDetailContent } from "../TaskDetailModal";

setupTaskDetailModalHooks();

describe("TaskDetailModal", () => {
  describe("Definition tab edit mode", () => {
    it("shows Edit button in Definition tab", () => {
      render(
        <TaskDetailModal
          task={makeTask({ prompt: "# Test\n\nSpec content." })}
          initialTab="definition"
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.getByText("Edit")).toBeTruthy();
    });

    it("clicking Edit shows textarea with current prompt content", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ prompt: "# Test\n\nSpec content." })}
          initialTab="definition"
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Initially showing markdown view
      expect(container.querySelector(".markdown-body")).toBeTruthy();

      // Click Edit button
      fireEvent.click(screen.getByText("Edit"));

      // Should show spec edit textarea (query by class for specificity)
      const textarea = container.querySelector(".spec-editor-textarea") as HTMLTextAreaElement;
      expect(textarea).toBeTruthy();
      expect(textarea.value).toBe("# Test\n\nSpec content.");
    });

    it("clicking Cancel returns to view mode without saving", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ prompt: "# Test Task\n\nTest specification." })}
          initialTab="definition"
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByText("Edit"));
      const textarea = container.querySelector(".spec-editor-textarea") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "Modified content" } });

      // Click Cancel
      fireEvent.click(screen.getByText("Cancel"));

      // Should show markdown view with original content
      expect(container.querySelector(".markdown-body")).toBeTruthy();
      expect(container.querySelector(".spec-editor-textarea")).toBeNull();
    });

    it("saving updates the task and returns to view mode", async () => {
      const { updateTask } = await import("../../api");
      const mockUpdate = vi.mocked(updateTask);
      mockUpdate.mockResolvedValueOnce({ id: "FN-099" } as Task);

      const { container } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-099", prompt: "# Original" })}
          initialTab="definition"
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByText("Edit"));
      const textarea = container.querySelector(".spec-editor-textarea") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "# Updated" } });

      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("FN-099", { prompt: "# Updated" }, undefined);
      });

      // Should return to view mode
      expect(container.querySelector(".markdown-body")).toBeTruthy();
    });

    it("AI revision feedback section appears in edit mode", () => {
      render(
        <TaskDetailModal
          task={makeTask({ prompt: "# Test" })}
          initialTab="definition"
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByText("Edit"));

      expect(screen.getByText("Ask AI to Revise")).toBeTruthy();
      expect(screen.getByPlaceholderText(/e.g., 'Add more details/)).toBeTruthy();
      expect(screen.getByText("Request AI Revision")).toBeTruthy();
    });

    it("requesting AI revision works and closes modal", async () => {
      const { requestSpecRevision } = await import("../../api");
      vi.mocked(requestSpecRevision).mockResolvedValueOnce({} as any);
      const onClose = vi.fn();
      const addToast = vi.fn();

      render(
        <TaskDetailModal
          task={makeTask({ id: "FN-099", column: "todo", prompt: "# Test" })}
          initialTab="definition"
          onClose={onClose}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={addToast}
        />,
      );

      fireEvent.click(screen.getByText("Edit"));

      const feedbackInput = screen.getByPlaceholderText(/e.g., 'Add more details/);
      fireEvent.change(feedbackInput, { target: { value: "Please add more error handling details" } });

      fireEvent.click(screen.getByText("Request AI Revision"));

      await waitFor(() => {
        expect(requestSpecRevision).toHaveBeenCalledWith("FN-099", "Please add more error handling details", undefined);
        expect(addToast).toHaveBeenCalledWith("AI revision requested. Task moved to planning.", "success");
        expect(onClose).toHaveBeenCalled();
      });
    });

    it("shows all tabs in correct order for in-progress task", () => {
      const { container } = render(
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

      // In-progress tasks show exactly 11 tabs:
      // Chat, Definition, Logs, Changes, Review, Comments, Documents, Model, Workflow, Stats, Routing
      const tabs = container.querySelectorAll(".detail-tab");
      expect(tabs.length).toBe(11);
      expect(tabs[0].textContent).toBe("Chat");
      expect(tabs[1].textContent).toBe("Definition");
      expect(tabs[2].textContent).toBe("Logs");
      expect(tabs[3].textContent).toBe("Changes");
      expect(tabs[4].textContent).toBe("Review");
      expect(tabs[5].textContent).toBe("Comments");
      expect(tabs[6].textContent).toBe("Documents");
      expect(tabs[7].textContent).toBe("Model");
      expect(tabs[8].textContent).toBe("Workflow");
      expect(tabs[9].textContent).toBe("Stats");
      expect(tabs[10].textContent).toBe("Routing");
      // Commits tab should NOT be present for non-done tasks
      expect(screen.queryByText("Commits")).toBeNull();
    });

    it("shows Workflow tab in correct position when enabledWorkflowSteps is non-empty", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ enabledWorkflowSteps: ["WS-001"] })}
          initialTab="definition"
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // In-progress task with workflow steps: 11 tabs (Review after Changes, Workflow after Model)
      const tabs = container.querySelectorAll(".detail-tab");
      expect(tabs.length).toBe(11);
      expect(tabs[0].textContent).toBe("Chat");
      expect(tabs[1].textContent).toBe("Definition");
      expect(tabs[2].textContent).toBe("Logs");
      expect(tabs[3].textContent).toBe("Changes");
      expect(tabs[4].textContent).toBe("Review");
      expect(tabs[5].textContent).toBe("Comments");
      expect(tabs[6].textContent).toBe("Documents");
      expect(tabs[7].textContent).toBe("Model");
      expect(tabs[8].textContent).toBe("Workflow");
      expect(tabs[9].textContent).toBe("Stats");
      expect(tabs[10].textContent).toBe("Routing");
    });

    it("does NOT show Commits tab for done task with mergeDetails.commitSha (changes merged into Changes tab)", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({
            column: "done",
            mergeDetails: { commitSha: "abc1234567890", filesChanged: 3 },
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

      // Done task with commit SHA: Chat, Definition, Logs, Changes, Review, Comments, Documents, Model, Workflow, Stats, Routing (11 tabs, no Commits)
      const tabs = container.querySelectorAll(".detail-tab");
      expect(tabs.length).toBe(11);
      expect(tabs[0].textContent).toBe("Chat");
      expect(tabs[1].textContent).toBe("Definition");
      expect(tabs[2].textContent).toBe("Logs");
      expect(tabs[3].textContent).toBe("Changes");
      expect(tabs[4].textContent).toBe("Review");
      expect(tabs[5].textContent).toBe("Comments");
      expect(tabs[6].textContent).toBe("Documents");
      expect(tabs[7].textContent).toBe("Model");
      expect(tabs[8].textContent).toBe("Workflow");
      expect(tabs[9].textContent).toBe("Stats");
      expect(tabs[10].textContent).toBe("Routing");
      // Commits tab should NOT be present
      expect(screen.queryByText("Commits")).toBeNull();
    });

    it("shows 11 tabs for done task with workflow steps and commit SHA (Commits merged into Changes)", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({
            column: "done",
            mergeDetails: { commitSha: "abc1234567890", filesChanged: 3 },
            enabledWorkflowSteps: ["WS-001"],
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

      // Done task with workflow steps and commit SHA: 11 tabs including Review (no Commits)
      const tabs = container.querySelectorAll(".detail-tab");
      expect(tabs.length).toBe(11);
      expect(tabs[0].textContent).toBe("Chat");
      expect(tabs[1].textContent).toBe("Definition");
      expect(tabs[2].textContent).toBe("Logs");
      expect(tabs[3].textContent).toBe("Changes");
      expect(tabs[4].textContent).toBe("Review");
      expect(tabs[5].textContent).toBe("Comments");
      expect(tabs[6].textContent).toBe("Documents");
      expect(tabs[7].textContent).toBe("Model");
      expect(tabs[8].textContent).toBe("Workflow");
      expect(tabs[9].textContent).toBe("Stats");
      expect(tabs[10].textContent).toBe("Routing");
      // Commits tab should NOT be present
      expect(screen.queryByText("Commits")).toBeNull();
    });

    it("does NOT show Changes tab for triage/todo tasks", () => {
      const { container: triageContainer } = render(
        <TaskDetailModal
          task={makeTask({ column: "triage" })}
          initialTab="definition"
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const triageTabs = triageContainer.querySelectorAll(".detail-tab");
      expect(triageTabs.length).toBe(10); // Chat, Definition, Logs, Review, Comments, Documents, Model, Workflow, Stats, Routing
      expect(Array.from(triageTabs).map(t => t.textContent)).toEqual([
        "Chat", "Definition", "Logs", "Review", "Comments", "Documents", "Model", "Workflow", "Stats", "Routing",
      ]);

      const { container: todoContainer } = render(
        <TaskDetailModal
          task={makeTask({ column: "todo" })}
          initialTab="definition"
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const todoTabs = todoContainer.querySelectorAll(".detail-tab");
      expect(todoTabs.length).toBe(10); // Chat, Definition, Logs, Review, Comments, Documents, Model, Workflow, Stats, Routing
      expect(Array.from(todoTabs).map(t => t.textContent)).toEqual([
        "Chat", "Definition", "Logs", "Review", "Comments", "Documents", "Model", "Workflow", "Stats", "Routing",
      ]);
    });

    it("shows empty state and Edit button when no prompt", () => {
      render(
        <TaskDetailModal
          task={makeTask({ prompt: "" })}
          initialTab="definition"
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.getByText("(no prompt)")).toBeTruthy();
      expect(screen.getByText("Edit")).toBeTruthy();
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
          initialTab="definition"
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
          initialTab="definition"
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
            status: "planning",
            prompt: "# Task Spec",
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
          initialTab="definition"
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
            id: "FN-001",
            column: "triage",
            status: "awaiting-approval",
            prompt: "# Task Spec",
          })}
          initialTab="definition"
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
        expect(mockApprovePlan).toHaveBeenCalledWith("FN-001", undefined);
      });
      expect(addToast).toHaveBeenCalledWith("Plan approved — FN-001 moved to Todo", "success");
      expect(onClose).toHaveBeenCalled();
    });

    it("calls rejectPlan API and shows success toast when Reject Plan is confirmed", async () => {
      const { rejectPlan } = await import("../../api");
      const mockRejectPlan = vi.mocked(rejectPlan);
      const addToast = vi.fn();
      const onClose = vi.fn();

      // Mock confirm to return true
            mockConfirm.mockResolvedValue(true);

      render(
        <TaskDetailModal
          task={makeTask({
            id: "FN-001",
            column: "triage",
            status: "awaiting-approval",
            prompt: "# Task Spec",
          })}
          initialTab="definition"
          onClose={onClose}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={addToast}
        />,
      );

      fireEvent.click(screen.getByText("Reject Plan"));

      expect(mockConfirm).toHaveBeenCalledWith({
        title: "Reject Plan",
        message: "Reject this plan? The specification will be discarded and regenerated.",
        danger: true,
      });

      await waitFor(() => {
        expect(mockRejectPlan).toHaveBeenCalledWith("FN-001", undefined);
      });
      expect(addToast).toHaveBeenCalledWith(
        "Plan rejected — FN-001 returned to Planning for replanning",
        "info"
      );
      expect(onClose).toHaveBeenCalled();

    });

    it("does not call rejectPlan API when Reject Plan is cancelled", async () => {
      const { rejectPlan } = await import("../../api");
      const mockRejectPlan = vi.mocked(rejectPlan);
      mockRejectPlan.mockClear(); // Clear any previous calls

      const addToast = vi.fn();

      // Mock confirm to return false
            mockConfirm.mockResolvedValue(false);

      render(
        <TaskDetailModal
          task={makeTask({
            column: "triage",
            status: "awaiting-approval",
            prompt: "# Task Spec",
          })}
          initialTab="definition"
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={addToast}
        />,
      );

      fireEvent.click(screen.getByText("Reject Plan"));

      expect(mockConfirm).toHaveBeenCalled();
      expect(mockRejectPlan).not.toHaveBeenCalled();
      expect(addToast).not.toHaveBeenCalled();

    });

    it("shows error toast when approvePlan fails", async () => {
      const { approvePlan } = await import("../../api");
      const mockApprovePlan = vi.mocked(approvePlan);
      mockApprovePlan.mockRejectedValueOnce(new Error("Network error"));

      const addToast = vi.fn();

      render(
        <TaskDetailModal
          task={makeTask({
            id: "FN-001",
            column: "triage",
            status: "awaiting-approval",
            prompt: "# Task Spec",
          })}
          initialTab="definition"
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
            mockConfirm.mockResolvedValue(true);

      render(
        <TaskDetailModal
          task={makeTask({
            id: "FN-001",
            column: "triage",
            status: "awaiting-approval",
            prompt: "# Task Spec",
          })}
          initialTab="definition"
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

    });
  });

  describe("Duplicate button", () => {
    it("renders Duplicate button in modal actions when onDuplicateTask is provided (in Actions dropdown)", () => {
      render(
        <TaskDetailModal
          task={makeTask()}
          initialTab="definition"
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          onDuplicateTask={vi.fn()}
          addToast={noop}
        />,
      );

      // Open Actions dropdown to see Duplicate
      const actionsBtn = screen.getByRole("button", { name: /actions/i });
      fireEvent.click(actionsBtn);

      expect(screen.getByRole("menuitem", { name: "Duplicate" })).toBeTruthy();
    });

    it("does NOT render Duplicate button when onDuplicateTask is not provided", () => {
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

      // Open Actions dropdown - Duplicate should not be there
      const actionsBtn = screen.getByRole("button", { name: /actions/i });
      fireEvent.click(actionsBtn);
      expect(screen.queryByRole("menuitem", { name: "Duplicate" })).toBeNull();
    });

    it("clicking Duplicate shows confirmation dialog", () => {
            mockConfirm.mockResolvedValue(false);

      render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001" })}
          initialTab="definition"
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          onDuplicateTask={vi.fn()}
          addToast={noop}
        />,
      );

      // Open Actions dropdown first
      const actionsBtn = screen.getByRole("button", { name: /actions/i });
      fireEvent.click(actionsBtn);

      fireEvent.click(screen.getByRole("menuitem", { name: "Duplicate" }));

      expect(mockConfirm).toHaveBeenCalledWith({
        title: "Duplicate Task",
        message: "Duplicate FN-001? This will create a new task in Triage with the same description and prompt.",
      });

    });

    it("confirming duplicate calls onDuplicateTask and closes modal", async () => {
            mockConfirm.mockResolvedValue(true);

      const mockDuplicate = vi.fn().mockResolvedValue({ id: "FN-002" } as Task);
      const onClose = vi.fn();

      render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001" })}
          initialTab="definition"
          onClose={onClose}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          onDuplicateTask={mockDuplicate}
          addToast={noop}
        />,
      );

      // Open Actions dropdown first
      const actionsBtn = screen.getByRole("button", { name: /actions/i });
      fireEvent.click(actionsBtn);

      fireEvent.click(screen.getByRole("menuitem", { name: "Duplicate" }));

      await waitFor(() => {
        expect(mockDuplicate).toHaveBeenCalledWith("FN-001");
        expect(onClose).toHaveBeenCalled();
      });

    });

    it("successful duplicate shows success toast with new task ID", async () => {
            mockConfirm.mockResolvedValue(true);

      const mockDuplicate = vi.fn().mockResolvedValue({ id: "FN-002" } as Task);
      const addToast = vi.fn();

      render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001" })}
          initialTab="definition"
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          onDuplicateTask={mockDuplicate}
          addToast={addToast}
        />,
      );

      // Open Actions dropdown first
      const actionsBtn = screen.getByRole("button", { name: /actions/i });
      fireEvent.click(actionsBtn);

      fireEvent.click(screen.getByRole("menuitem", { name: "Duplicate" }));

      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith("Duplicated FN-001 → FN-002", "success");
      });

    });

    it("cancelling confirmation does not call onDuplicateTask", () => {
            mockConfirm.mockResolvedValue(false);

      const mockDuplicate = vi.fn().mockResolvedValue({ id: "FN-002" } as Task);

      render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001" })}
          initialTab="definition"
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          onDuplicateTask={mockDuplicate}
          addToast={noop}
        />,
      );

      // Open Actions dropdown first
      const actionsBtn = screen.getByRole("button", { name: /actions/i });
      fireEvent.click(actionsBtn);

      fireEvent.click(screen.getByRole("menuitem", { name: "Duplicate" }));

      expect(mockDuplicate).not.toHaveBeenCalled();

    });

    it("shows error toast when duplicate fails", async () => {
            mockConfirm.mockResolvedValue(true);

      const mockDuplicate = vi.fn().mockRejectedValue(new Error("Duplicate failed"));
      const addToast = vi.fn();

      render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001" })}
          initialTab="definition"
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          onDuplicateTask={mockDuplicate}
          addToast={addToast}
        />,
      );

      // Open Actions dropdown first
      const actionsBtn = screen.getByRole("button", { name: /actions/i });
      fireEvent.click(actionsBtn);

      fireEvent.click(screen.getByRole("menuitem", { name: "Duplicate" }));

      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith("Duplicate failed", "error");
      });

    });
  });

  describe("Refinement button", () => {
    it.each<[Column, boolean]>([
      ["done", true],
      ["in-review", true],
      ["todo", false],
      ["in-progress", false],
    ])("Refine action visibility in column=%s is %s", (column, shouldShow) => {
      render(
        <TaskDetailModal
          task={makeTask({ column })}
          initialTab="definition"
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: /actions/i }));
      const item = screen.queryByRole("menuitem", { name: "Refine" });
      if (shouldShow) expect(item).toBeTruthy();
      else expect(item).toBeNull();
    });

    it("does NOT render Refine button for 'triage' column tasks (no Actions dropdown)", () => {
      render(
        <TaskDetailModal
          task={makeTask({ column: "triage" })}
          initialTab="definition"
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );
      expect(screen.queryByText("Refine")).toBeNull();
    });

    it("renders Actions dropdown for a paused triage task", () => {
      render(
        <TaskDetailModal
          task={makeTask({ column: "triage", paused: true })}
          initialTab="definition"
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.getByRole("button", { name: /actions/i })).toBeTruthy();
    });

    it("renders Unpause button for a paused triage task", () => {
      render(
        <TaskDetailModal
          task={makeTask({ column: "triage", paused: true })}
          initialTab="definition"
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: /actions/i }));

      expect(screen.getByRole("menuitem", { name: "Unpause" })).toBeTruthy();
    });

    it("renders Unpause for userPaused-only tasks and unpauses once", async () => {
      const { unpauseTask } = await import("../../api");
      const mockUnpauseTask = vi.mocked(unpauseTask);

      render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "todo", paused: undefined, userPaused: true })}
          initialTab="definition"
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      await userEvent.click(screen.getByRole("button", { name: /actions/i }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Unpause" }));

      await waitFor(() => {
        expect(mockUnpauseTask).toHaveBeenCalledTimes(1);
        expect(mockUnpauseTask).toHaveBeenCalledWith("FN-001", undefined);
      });
    });

    it("hides Pause/Unpause button for agent-assigned tasks", async () => {
      const { fetchAgent } = await import("../../api");
      const mockFetchAgent = vi.mocked(fetchAgent);
      mockFetchAgent.mockResolvedValue({ id: "agent-1", name: "Agent 1", role: "executor", state: "active" } as any);

      render(
        <TaskDetailModal
          task={makeTask({ column: "triage", paused: true, assignedAgentId: "agent-1" })}
          initialTab="definition"
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      await waitFor(() => {
        expect(mockFetchAgent).toHaveBeenCalledWith("agent-1", undefined);
      });

      await userEvent.click(screen.getByRole("button", { name: /actions/i }));

      await waitFor(() => {
        expect(screen.queryByRole("menuitem", { name: "Pause" })).toBeNull();
        expect(screen.queryByRole("menuitem", { name: "Unpause" })).toBeNull();
      });
    });

    it("shows paused-by-agent indicator for agent-paused tasks", async () => {
      const { fetchAgent } = await import("../../api");
      const mockFetchAgent = vi.mocked(fetchAgent);
      mockFetchAgent.mockResolvedValue({ id: "agent-1", name: "Agent 1", role: "executor", state: "paused" } as any);

      render(
        <TaskDetailModal
          task={makeTask({ column: "triage", paused: true, assignedAgentId: "agent-1", pausedByAgentId: "agent-1" })}
          initialTab="definition"
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      await waitFor(() => {
        expect(mockFetchAgent).toHaveBeenCalledWith("agent-1", undefined);
      });

      await userEvent.click(screen.getByRole("button", { name: /actions/i }));

      expect(await screen.findByText("Paused by agent")).toBeTruthy();
    });

    it("does NOT render Actions dropdown for a non-paused, non-awaiting-approval, non-retryable triage task", () => {
      render(
        <TaskDetailModal
          task={makeTask({ column: "triage", paused: false, status: "todo" })}
          initialTab="definition"
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.queryByRole("button", { name: /actions/i })).toBeNull();
    });

    it("clicking Refine opens the refinement modal", () => {
      render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "done" })}
          initialTab="definition"
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Open Actions dropdown first
      const actionsBtn = screen.getByRole("button", { name: /actions/i });
      fireEvent.click(actionsBtn);

      fireEvent.click(screen.getByRole("menuitem", { name: "Refine" }));

      expect(screen.getByText("Refine", { selector: "h3" })).toBeTruthy();
      expect(screen.getByPlaceholderText("Enter your feedback here...")).toBeTruthy();
    });

    it("shows character counter in refinement modal", () => {
      render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "done" })}
          initialTab="definition"
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Open Actions dropdown first
      const actionsBtn = screen.getByRole("button", { name: /actions/i });
      fireEvent.click(actionsBtn);

      fireEvent.click(screen.getByRole("menuitem", { name: "Refine" }));

      expect(screen.getByText("0/2000 characters")).toBeTruthy();
    });

    it("character counter updates when typing feedback", async () => {
      render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "done" })}
          initialTab="definition"
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Open Actions dropdown first
      const actionsBtn = screen.getByRole("button", { name: /actions/i });
      fireEvent.click(actionsBtn);

      fireEvent.click(screen.getByRole("menuitem", { name: "Refine" }));

      const textarea = screen.getByPlaceholderText("Enter your feedback here...");
      await act(async () => {
        fireEvent.change(textarea, { target: { value: "Need to fix the error handling" } });
      });

      expect(screen.getByText("30/2000 characters")).toBeTruthy();
    });

    it("submit button is disabled when feedback is empty", () => {
      render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "done" })}
          initialTab="definition"
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Open Actions dropdown first
      const actionsBtn = screen.getByRole("button", { name: /actions/i });
      fireEvent.click(actionsBtn);

      fireEvent.click(screen.getByRole("menuitem", { name: "Refine" }));

      const submitButton = screen.getByText("Create Refinement Task");
      expect(submitButton.hasAttribute("disabled")).toBe(true);
    });

    it("submit button is enabled when feedback is entered", async () => {
      render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "done" })}
          initialTab="definition"
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Open Actions dropdown first
      const actionsBtn = screen.getByRole("button", { name: /actions/i });
      fireEvent.click(actionsBtn);

      fireEvent.click(screen.getByRole("menuitem", { name: "Refine" }));

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
          task={makeTask({ id: "FN-001", column: "done" })}
          initialTab="definition"
          onClose={onClose}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Open Actions dropdown first
      const actionsBtn = screen.getByRole("button", { name: /actions/i });
      fireEvent.click(actionsBtn);

      fireEvent.click(screen.getByRole("menuitem", { name: "Refine" }));
      fireEvent.click(screen.getByText("Cancel"));

      // Modal should be closed, but detail modal stays open (onClose not called)
      expect(screen.queryByText("Refine", { selector: "h3" })).toBeNull();
      expect(onClose).not.toHaveBeenCalled();
    });

    it("shows error toast when submitting empty feedback", async () => {
      const addToast = vi.fn();

      render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "done" })}
          initialTab="definition"
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={addToast}
        />,
      );

      // Open Actions dropdown first
      const actionsBtn = screen.getByRole("button", { name: /actions/i });
      fireEvent.click(actionsBtn);

      fireEvent.click(screen.getByRole("menuitem", { name: "Refine" }));

      // Try to submit with empty text (manually trigger submit since button is disabled)
      const { refineTask } = await import("../../api");

      // Should not call API, instead show error toast
      expect(refineTask).not.toHaveBeenCalled();
    });

    it("calls refineTask and closes modal on successful submission", async () => {
      const { refineTask } = await import("../../api");
      vi.mocked(refineTask).mockResolvedValue({ id: "FN-002", column: "triage" } as Task);

      const onClose = vi.fn();
      const addToast = vi.fn();

      render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "done" })}
          initialTab="definition"
          onClose={onClose}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={addToast}
        />,
      );

      // Open Actions dropdown first
      const actionsBtn = screen.getByRole("button", { name: /actions/i });
      fireEvent.click(actionsBtn);

      fireEvent.click(screen.getByRole("menuitem", { name: "Refine" }));

      const textarea = screen.getByPlaceholderText("Enter your feedback here...");
      fireEvent.change(textarea, { target: { value: "Need to add more tests" } });

      fireEvent.click(screen.getByText("Create Refinement Task"));

      await waitFor(() => {
        expect(refineTask).toHaveBeenCalledWith("FN-001", "Need to add more tests", undefined);
        expect(addToast).toHaveBeenCalledWith("Refinement task created: FN-002", "success");
        expect(onClose).toHaveBeenCalled();
      });
    });

    it("shows error toast when refineTask fails", async () => {
      const { refineTask } = await import("../../api");
      vi.mocked(refineTask).mockRejectedValue(new Error("Task must be in 'done' or 'in-review' column"));

      const addToast = vi.fn();

      render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "done" })}
          initialTab="definition"
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={addToast}
        />,
      );

      // Open Actions dropdown first
      const actionsBtn = screen.getByRole("button", { name: /actions/i });
      fireEvent.click(actionsBtn);

      // Click Refine from the dropdown
      fireEvent.click(screen.getByRole("menuitem", { name: "Refine" }));

      const textarea = screen.getByPlaceholderText("Enter your feedback here...");
      fireEvent.change(textarea, { target: { value: "Need to add more tests" } });

      fireEvent.click(screen.getByText("Create Refinement Task"));

      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith("Task must be in 'done' or 'in-review' column", "error");
      });
    });

    it("renders submit button inside the input group adjacent to textarea", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "done" })}
          initialTab="definition"
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Open Actions dropdown first
      const actionsBtn = screen.getByRole("button", { name: /actions/i });
      fireEvent.click(actionsBtn);

      // Click Refine from the dropdown
      fireEvent.click(screen.getByRole("menuitem", { name: "Refine" }));

      // The submit button should be inside .detail-refine-input-group (the input area)
      const inputGroup = container.querySelector(".detail-refine-input-group");
      expect(inputGroup).toBeTruthy();
      const submitButton = inputGroup!.querySelector("button.btn-primary");
      expect(submitButton).toBeTruthy();
      expect(submitButton!.textContent).toBe("Create Refinement Task");

      // The submit button should NOT be in the footer .modal-actions
      const modalActions = container.querySelector(".detail-refine-modal .modal-actions");
      expect(modalActions).toBeTruthy();
      expect(modalActions!.querySelector("button.btn-primary")).toBeNull();
    });

    it("submit button in input group follows the same disabled/enabled rules", async () => {
      render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "done" })}
          initialTab="definition"
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Open Actions dropdown first
      const actionsBtn = screen.getByRole("button", { name: /actions/i });
      fireEvent.click(actionsBtn);

      // Click Refine from the dropdown
      fireEvent.click(screen.getByRole("menuitem", { name: "Refine" }));

      // Submit button starts disabled (no feedback)
      const submitButton = screen.getByText("Create Refinement Task");
      expect(submitButton.hasAttribute("disabled")).toBe(true);

      // Enter feedback to enable it
      const textarea = screen.getByPlaceholderText("Enter your feedback here...");
      await act(async () => {
        fireEvent.change(textarea, { target: { value: "Some feedback" } });
      });

      expect(submitButton.hasAttribute("disabled")).toBe(false);
    });

    it("character count and submit button are siblings in the input group", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "done" })}
          initialTab="definition"
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Open Actions dropdown first
      const actionsBtn = screen.getByRole("button", { name: /actions/i });
      fireEvent.click(actionsBtn);

      // Click Refine from the dropdown
      fireEvent.click(screen.getByRole("menuitem", { name: "Refine" }));

      const inputGroup = container.querySelector(".detail-refine-input-group")!;
      expect(inputGroup.querySelector(".detail-refine-char-count")).toBeTruthy();
      expect(inputGroup.querySelector("button.btn-primary")).toBeTruthy();
    });
  });


});
