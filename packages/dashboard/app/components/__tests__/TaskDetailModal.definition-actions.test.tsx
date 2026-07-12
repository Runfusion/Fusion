/*
FNXC:PlannerOversight 2026-07-05-00:00:
FN-7604 — the footer "Actions" dropdown button name is matched EXACTLY
(`{ name: "Actions" }`) throughout this file, not via a loose `/actions/i`
regex. The now-universal Oversight overflow trigger's aria-label is
"Oversight actions", which also matches `/actions/i` and made every such
query ambiguous once the trigger stopped being a mobile-only affordance.
*/
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
import { FileBrowserProvider } from "../../context/FileBrowserContext";
import { readBoardWorkflowSelection, removeBoardWorkflowSelection, writeBoardWorkflowSelection } from "../../utils/boardWorkflowSelection";

setupTaskDetailModalHooks();

describe("TaskDetailModal", () => {
  describe("Plan tab edit mode", () => {
    it("shows Edit button in Plan tab", () => {
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

      expect(screen.getByRole("button", { name: "Plan" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Definition" })).toBeNull();
      expect(screen.getByText("Edit")).toBeTruthy();
    });

    it("opens the task PROMPT.md file from the near-top Plan action", async () => {
      const user = userEvent.setup();
      const openFile = vi.fn();
      const { container } = render(
        <FileBrowserProvider openFile={openFile}>
          <TaskDetailModal
            task={makeTask({ id: "FN-099", prompt: "# Test\n\nSpec content." })}
            initialTab="definition"
            onClose={noop}
            onMoveTask={noopMove}
            onDeleteTask={noopDelete}
            onMergeTask={noopMerge}
            onOpenDetail={noopOpenDetail}
            addToast={noop}
          />
        </FileBrowserProvider>,
      );

      const actionRow = container.querySelector(".detail-spec-edit-trigger");
      expect(actionRow).toBeTruthy();
      const promptButton = screen.getByRole("button", { name: "Open PROMPT.md" });
      expect(actionRow?.contains(promptButton)).toBe(true);

      await user.click(promptButton);

      expect(openFile).toHaveBeenCalledWith(".fusion/tasks/FN-099/PROMPT.md", { workspace: "project" });
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

      const planSection = container.querySelector(".detail-section--plan-prompt");
      expect(planSection).toBeTruthy();
      // Initially showing markdown view
      const markdown = container.querySelector(".markdown-body");
      expect(markdown).toBeTruthy();
      expect(planSection?.contains(markdown)).toBe(true);

      // Click Edit button
      fireEvent.click(screen.getByText("Edit"));

      // Should show spec edit textarea (query by class for specificity)
      const editMode = container.querySelector(".spec-editor-edit-mode");
      const textarea = container.querySelector(".spec-editor-textarea") as HTMLTextAreaElement;
      const feedback = container.querySelector(".spec-editor-feedback");
      expect(editMode).toBeTruthy();
      expect(textarea).toBeTruthy();
      expect(feedback).toBeTruthy();
      expect(planSection?.contains(editMode)).toBe(true);
      expect(planSection?.contains(textarea)).toBe(true);
      expect(planSection?.contains(feedback)).toBe(true);
      expect(textarea.value).toBe("# Test\n\nSpec content.");
    });

    it("keeps the no-prompt fallback inside the scoped full-width Plan wrapper", () => {
      const { container } = render(
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

      const planSection = container.querySelector(".detail-section--plan-prompt");
      const fallback = container.querySelector(".detail-prompt");
      expect(planSection).toBeTruthy();
      expect(fallback).toBeTruthy();
      expect(planSection?.contains(fallback)).toBe(true);
    });

    it("keeps embedded Plan edit controls inside the full-width wrapper", () => {
      const { container } = render(
        <TaskDetailContent
          task={makeTask({ prompt: "# Embedded\n\nSpec content." })}
          initialTab="definition"
          embedded
          onRequestClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(container.querySelector(".task-detail-content--embedded")).toBeTruthy();
      const planSection = container.querySelector(".detail-section--plan-prompt");
      fireEvent.click(screen.getByText("Edit"));

      const editMode = container.querySelector(".spec-editor-edit-mode");
      const textarea = container.querySelector(".spec-editor-textarea");
      const feedback = container.querySelector(".spec-editor-feedback");
      expect(planSection).toBeTruthy();
      expect(planSection?.contains(editMode)).toBe(true);
      expect(planSection?.contains(textarea)).toBe(true);
      expect(planSection?.contains(feedback)).toBe(true);
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

      // FNXC:CostAndTerminalTabs FN-7820 (commit 937650472) added the "Cost" tab between Chat and Plan;
      // FN-7826 (commit 17d7bd19e) made the interactive "Terminal" tab always available at the end.
      // In-progress tasks show exactly 13 tabs:
      // Activity, Chat, Cost, Plan, Changes, Review, Comments, Artifacts, Model, Workflow, Stats, Routing, Terminal
      const tabs = container.querySelectorAll(".detail-tab");
      expect(Array.from(tabs).map(t => t.textContent)).toEqual([
        "Activity", "Chat", "Cost", "Plan", "Changes", "Review", "Comments", "Artifacts", "Model", "Workflow", "Stats", "Routing", "Terminal",
      ]);
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

      // FNXC:CostAndTerminalTabs see FN-7820/FN-7826 note above: "Cost" after Chat, "Terminal" at end.
      // In-progress task with workflow steps: 13 tabs (Review after Changes, Workflow after Model)
      const tabs = container.querySelectorAll(".detail-tab");
      expect(Array.from(tabs).map(t => t.textContent)).toEqual([
        "Activity", "Chat", "Cost", "Plan", "Changes", "Review", "Comments", "Artifacts", "Model", "Workflow", "Stats", "Routing", "Terminal",
      ]);
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

      // FNXC:CostAndTerminalTabs see FN-7820/FN-7826 note above. Done task: "Cost" after Summary (before Plan), "Terminal" at end.
      // Done task with commit SHA: Activity, Chat, Summary, Cost, Plan, Changes, Review, Comments, Artifacts, Model, Workflow, Stats, Routing, Terminal (14 tabs, no Commits)
      const tabs = container.querySelectorAll(".detail-tab");
      expect(Array.from(tabs).map(t => t.textContent)).toEqual([
        "Activity", "Chat", "Summary", "Cost", "Plan", "Changes", "Review", "Comments", "Artifacts", "Model", "Workflow", "Stats", "Routing", "Terminal",
      ]);
      // Commits tab should NOT be present
      expect(screen.queryByText("Commits")).toBeNull();
    });

    it("shows 12 tabs for done task with workflow steps and commit SHA (Commits merged into Changes)", () => {
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

      // FNXC:CostAndTerminalTabs see FN-7820/FN-7826 note above.
      // Done task with workflow steps and commit SHA: 14 tabs including Summary, Cost and Review (no Commits)
      const tabs = container.querySelectorAll(".detail-tab");
      expect(Array.from(tabs).map(t => t.textContent)).toEqual([
        "Activity", "Chat", "Summary", "Cost", "Plan", "Changes", "Review", "Comments", "Artifacts", "Model", "Workflow", "Stats", "Routing", "Terminal",
      ]);
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
      // FNXC:CostAndTerminalTabs see FN-7820/FN-7826 note above. Triage has no Changes tab; "Cost" after Chat, "Terminal" at end.
      expect(Array.from(triageTabs).map(t => t.textContent)).toEqual([
        "Activity", "Chat", "Cost", "Plan", "Review", "Comments", "Artifacts", "Model", "Workflow", "Stats", "Routing", "Terminal",
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
      // FNXC:CostAndTerminalTabs see FN-7820/FN-7826 note above (todo, same as triage).
      expect(Array.from(todoTabs).map(t => t.textContent)).toEqual([
        "Activity", "Chat", "Cost", "Plan", "Review", "Comments", "Artifacts", "Model", "Workflow", "Stats", "Routing", "Terminal",
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

    /*
     * FNXC:ReleaseAuthorizationGate 2026-07-09-00:00: the triage release-authorization
     * gate was removed. A task still carrying the legacy release-authorization hold is
     * now treated as an ordinary manual plan-approval hold and renders Approve/Reject
     * Plan normally instead of a distinct, unresolvable reason string.
     */
    it("shows Approve/Reject Plan for a legacy release-authorization hold", () => {
      render(
        <TaskDetailModal
          task={makeTask({
            column: "triage",
            status: "awaiting-approval",
            awaitingApprovalReason: "release-authorization",
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
      expect(screen.queryByText(/Awaiting release authorization/i)).toBeNull();
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
      const actionsBtn = screen.getByRole("button", { name: "Actions" });
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
      const actionsBtn = screen.getByRole("button", { name: "Actions" });
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
      const actionsBtn = screen.getByRole("button", { name: "Actions" });
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
      const actionsBtn = screen.getByRole("button", { name: "Actions" });
      fireEvent.click(actionsBtn);

      fireEvent.click(screen.getByRole("menuitem", { name: "Duplicate" }));

      await waitFor(() => {
        expect(mockDuplicate).toHaveBeenCalledWith("FN-001");
        expect(onClose).toHaveBeenCalled();
      });

    });

    it("mobile task popup Actions menu selects a tapped item once and dismisses", async () => {
      const { pauseTask } = await import("../../api");
      const mockPauseTask = vi.mocked(pauseTask);
      mockPauseTask.mockResolvedValueOnce(makeTask({ id: "FN-001", paused: true }) as Task);
      const addToast = vi.fn();

      render(
        <TaskDetailContent
          task={makeTask({ id: "FN-001", column: "todo", paused: false, userPaused: false })}
          initialTab="definition"
          embedded
          onRequestClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={addToast}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Actions" }));
      const pauseItem = screen.getByRole("menuitem", { name: "Pause" });

      fireEvent.pointerUp(pauseItem, { pointerType: "touch", pointerId: 1 });

      await waitFor(() => expect(mockPauseTask).toHaveBeenCalledWith("FN-001", undefined));
      expect(mockPauseTask).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      expect(addToast).toHaveBeenCalledWith("Paused FN-001", "success");
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
      const actionsBtn = screen.getByRole("button", { name: "Actions" });
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
      const actionsBtn = screen.getByRole("button", { name: "Actions" });
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
      const actionsBtn = screen.getByRole("button", { name: "Actions" });
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
      fireEvent.click(screen.getByRole("button", { name: "Actions" }));
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

      expect(screen.getByRole("button", { name: "Actions" })).toBeTruthy();
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

      fireEvent.click(screen.getByRole("button", { name: "Actions" }));

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

      await userEvent.click(screen.getByRole("button", { name: "Actions" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Unpause" }));

      await waitFor(() => {
        expect(mockUnpauseTask).toHaveBeenCalledTimes(1);
        expect(mockUnpauseTask).toHaveBeenCalledWith("FN-001", undefined);
      });
    });

    it("renders actionable Unpause button for agent-assigned paused tasks", async () => {
      const { fetchAgent, unpauseTask } = await import("../../api");
      const mockFetchAgent = vi.mocked(fetchAgent);
      const mockUnpauseTask = vi.mocked(unpauseTask);
      mockFetchAgent.mockResolvedValue({ id: "agent-1", name: "Agent 1", role: "executor", state: "active" } as any);
      mockUnpauseTask.mockClear();

      render(
        <TaskDetailModal
          task={makeTask({ id: "FN-ASSIGNED", column: "triage", paused: true, assignedAgentId: "agent-1" })}
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

      await userEvent.click(screen.getByRole("button", { name: "Actions" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Unpause" }));

      await waitFor(() => {
        expect(mockUnpauseTask).toHaveBeenCalledTimes(1);
        expect(mockUnpauseTask).toHaveBeenCalledWith("FN-ASSIGNED", undefined);
      });
    });

    it("shows paused-by-agent indicator alongside actionable Unpause for agent-paused tasks", async () => {
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

      await userEvent.click(screen.getByRole("button", { name: "Actions" }));

      expect(screen.getByRole("menuitem", { name: "Unpause" })).toBeTruthy();
      expect(await screen.findByText("Paused by agent")).toBeTruthy();
    });

    it("renders actionable Pause button for agent-assigned tasks that are not paused", async () => {
      const { fetchAgent, pauseTask } = await import("../../api");
      const mockFetchAgent = vi.mocked(fetchAgent);
      const mockPauseTask = vi.mocked(pauseTask);
      mockFetchAgent.mockResolvedValue({ id: "agent-1", name: "Agent 1", role: "executor", state: "active" } as any);
      mockPauseTask.mockClear();

      render(
        <TaskDetailModal
          task={makeTask({ id: "FN-ASSIGNED", column: "triage", paused: false, userPaused: false, assignedAgentId: "agent-1" })}
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

      await userEvent.click(screen.getByRole("button", { name: "Actions" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Pause" }));

      await waitFor(() => {
        expect(mockPauseTask).toHaveBeenCalledTimes(1);
        expect(mockPauseTask).toHaveBeenCalledWith("FN-ASSIGNED", undefined);
      });
    });

    it.each([
      ["paused-only", { paused: true, userPaused: false }, "Unpause"],
      ["userPaused-only", { paused: false, userPaused: true }, "Unpause"],
      ["paused-and-userPaused", { paused: true, userPaused: true }, "Unpause"],
      ["not-paused", { paused: false, userPaused: false }, "Pause"],
    ])("uses the correct Pause/Unpause label for agent-assigned %s tasks", async (_name, state, expectedLabel) => {
      const { fetchAgent } = await import("../../api");
      const mockFetchAgent = vi.mocked(fetchAgent);
      mockFetchAgent.mockResolvedValue({ id: "agent-1", name: "Agent 1", role: "executor", state: "active" } as any);

      render(
        <TaskDetailModal
          task={makeTask({ column: "todo", assignedAgentId: "agent-1", ...state })}
          initialTab="definition"
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      await userEvent.click(screen.getByRole("button", { name: "Actions" }));

      expect(screen.getByRole("menuitem", { name: expectedLabel })).toBeTruthy();
    });

    it.each(["done", "archived"])("hides Pause/Unpause button for %s tasks", async (column) => {
      render(
        <TaskDetailModal
          task={makeTask({ column: column as "done" | "archived", paused: true, userPaused: true, assignedAgentId: "agent-1" })}
          initialTab="definition"
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      await userEvent.click(screen.getByRole("button", { name: "Actions" }));

      expect(screen.queryByRole("menuitem", { name: "Pause" })).toBeNull();
      expect(screen.queryByRole("menuitem", { name: "Unpause" })).toBeNull();
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

      expect(screen.queryByRole("button", { name: "Actions" })).toBeNull();
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
      const actionsBtn = screen.getByRole("button", { name: "Actions" });
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
      const actionsBtn = screen.getByRole("button", { name: "Actions" });
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
      const actionsBtn = screen.getByRole("button", { name: "Actions" });
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
      const actionsBtn = screen.getByRole("button", { name: "Actions" });
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
      const actionsBtn = screen.getByRole("button", { name: "Actions" });
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
      const actionsBtn = screen.getByRole("button", { name: "Actions" });
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
      const actionsBtn = screen.getByRole("button", { name: "Actions" });
      fireEvent.click(actionsBtn);

      fireEvent.click(screen.getByRole("menuitem", { name: "Refine" }));

      // Try to submit with empty text (manually trigger submit since button is disabled)
      const { refineTask } = await import("../../api");

      // Should not call API, instead show error toast
      expect(refineTask).not.toHaveBeenCalled();
    });

    it("opens the refine composer from an initial action request", () => {
      render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "done" })}
          initialAction={{ action: "refine", requestId: 1 }}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.getByText("Refine", { selector: "h3" })).toBeInTheDocument();
      expect(screen.getByPlaceholderText("Enter your feedback here...")).toBeInTheDocument();
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
      const actionsBtn = screen.getByRole("button", { name: "Actions" });
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

    it("preserves non-default workflow context when closing after refinement success", async () => {
      const { fetchBoardWorkflows, refineTask } = await import("../../api");
      vi.mocked(refineTask).mockResolvedValue({ id: "FN-003", column: "todo" } as Task);
      vi.mocked(fetchBoardWorkflows).mockResolvedValueOnce({
        flagEnabled: true,
        defaultWorkflowId: "builtin:coding",
        workflows: [
          { id: "builtin:coding", name: "Coding", columns: [] },
          { id: "WF-active", name: "Custom refinement lane", columns: [] },
        ],
        taskWorkflowIds: { "FN-001": "WF-active" },
      });
      writeBoardWorkflowSelection("project-1", "WF-active");

      const onClose = vi.fn();
      const onTaskUpdated = vi.fn();
      const addToast = vi.fn();
      render(
        <TaskDetailModal
          task={makeTask({ id: "FN-001", column: "done" })}
          projectId="project-1"
          initialTab="definition"
          onClose={onClose}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          onTaskUpdated={onTaskUpdated}
          addToast={addToast}
        />,
      );

      await screen.findByTestId("task-detail-workflow-badge");
      expect(screen.getByTestId("task-detail-workflow-badge")).toHaveTextContent("Custom refinement lane");

      fireEvent.click(screen.getByRole("button", { name: "Actions" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Refine" }));
      fireEvent.change(screen.getByPlaceholderText("Enter your feedback here..."), { target: { value: "Keep the same workflow lane" } });
      fireEvent.click(screen.getByText("Create Refinement Task"));

      await waitFor(() => {
        expect(refineTask).toHaveBeenCalledWith("FN-001", "Keep the same workflow lane", "project-1");
        expect(addToast).toHaveBeenCalledWith("Refinement task created: FN-003", "success");
        expect(onClose).toHaveBeenCalled();
      });
      expect(onTaskUpdated).not.toHaveBeenCalled();
      expect(readBoardWorkflowSelection("project-1")).toBe("WF-active");
      expect(readBoardWorkflowSelection("project-1")).not.toBe("builtin:coding");
      removeBoardWorkflowSelection("project-1");
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
      const actionsBtn = screen.getByRole("button", { name: "Actions" });
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
      const actionsBtn = screen.getByRole("button", { name: "Actions" });
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
      const actionsBtn = screen.getByRole("button", { name: "Actions" });
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
      const actionsBtn = screen.getByRole("button", { name: "Actions" });
      fireEvent.click(actionsBtn);

      // Click Refine from the dropdown
      fireEvent.click(screen.getByRole("menuitem", { name: "Refine" }));

      const inputGroup = container.querySelector(".detail-refine-input-group")!;
      expect(inputGroup.querySelector(".detail-refine-char-count")).toBeTruthy();
      expect(inputGroup.querySelector("button.btn-primary")).toBeTruthy();
    });
  });


});
