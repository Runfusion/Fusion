import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  makeTask,
  noop,
  noopMerge,
  noopMove,
  noopOpenDetail,
  setupTaskDetailModalHooks,
  mockConfirm,
  mockConfirmWithChoice,
  mockConfirmWithCheckbox,
} from "./TaskDetailModal.test-helpers";
import { TaskDetailModal } from "../TaskDetailModal";

setupTaskDetailModalHooks();

describe("TaskDetailModal allowResurrection delete flow", () => {
  it("passes allowResurrection=true when checkbox is checked", async () => {
    const user = userEvent.setup();
    const onDeleteTask = vi.fn(async () => makeTask());
    mockConfirmWithCheckbox.mockResolvedValueOnce({ choice: "primary", checkboxValue: true });

    render(
      <TaskDetailModal
        task={makeTask()}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={onDeleteTask}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));

    await waitFor(() => {
      expect(onDeleteTask).toHaveBeenCalledWith("FN-099", { allowResurrection: true });
    });
  });

  it("passes allowResurrection=false when checkbox is left unchecked", async () => {
    const user = userEvent.setup();
    const onDeleteTask = vi.fn(async () => makeTask());
    mockConfirmWithCheckbox.mockResolvedValueOnce({ choice: "primary", checkboxValue: false });

    render(
      <TaskDetailModal
        task={makeTask()}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={onDeleteTask}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));

    await waitFor(() => {
      expect(onDeleteTask).toHaveBeenCalledWith("FN-099", { allowResurrection: false });
    });
  });

  it("keeps allowResurrection value on dependency-conflict retry", async () => {
    const user = userEvent.setup();
    const conflict = new Error("conflict") as Error & { details: { code: string; dependentIds: string[] } };
    conflict.details = { code: "TASK_HAS_DEPENDENTS", dependentIds: ["FN-100"] };
    const onDeleteTask = vi
      .fn()
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce(makeTask());
    mockConfirmWithCheckbox.mockResolvedValueOnce({ choice: "primary", checkboxValue: true });
    mockConfirm.mockResolvedValueOnce(true);

    render(
      <TaskDetailModal
        task={makeTask()}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={onDeleteTask}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));

    await waitFor(() => {
      expect(onDeleteTask).toHaveBeenNthCalledWith(2, "FN-099", {
        removeDependencyReferences: true,
        removeLineageReferences: true,
        githubIssueAction: undefined,
        allowResurrection: true,
      });
    });
  });

  it("archive branch stays delete-unaffected", async () => {
    const user = userEvent.setup();
    const onDeleteTask = vi.fn(async () => makeTask());
    const onArchiveTask = vi.fn(async () => makeTask({ column: "archived" }));
    mockConfirmWithChoice.mockResolvedValueOnce("tertiary");

    render(
      <TaskDetailModal
        task={makeTask({ column: "done" })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={onDeleteTask}
        onArchiveTask={onArchiveTask}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));

    await waitFor(() => {
      expect(onArchiveTask).toHaveBeenCalledWith("FN-099");
      expect(onDeleteTask).not.toHaveBeenCalled();
      expect(mockConfirmWithCheckbox).not.toHaveBeenCalled();
    });
  });
});
