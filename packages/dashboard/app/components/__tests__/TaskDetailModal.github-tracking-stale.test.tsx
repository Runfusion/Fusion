import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeTask, noopDelete, noopMerge, noopMove, noopOpenDetail, setupTaskDetailModalHooks } from "./TaskDetailModal.test-helpers";
import { TaskDetailModal } from "../TaskDetailModal";

setupTaskDetailModalHooks();

describe("TaskDetailModal GitHub tracking stale await guards (FN-5148)", () => {
  it("ignores stale enable-tracking result after navigating to another task", async () => {
    const user = userEvent.setup();
    const onTaskUpdated = vi.fn();
    const addToast = vi.fn();

    let resolveUpdate!: (value: any) => void;
    const deferred = new Promise((resolve) => {
      resolveUpdate = resolve;
    });
    const { updateTask } = await import("../../api");
    const mockUpdateTask = vi.mocked(updateTask);
    mockUpdateTask.mockImplementationOnce(() => deferred as any);

    const taskA = makeTask({ id: "FN-A", title: "A", column: "todo", githubTracking: { enabled: false } });
    const taskB = makeTask({ id: "FN-B", title: "B", column: "todo", githubTracking: { enabled: false } });

    const { rerender } = render(
      <TaskDetailModal
        task={taskA}
        onClose={() => {}}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        onTaskUpdated={onTaskUpdated}
        addToast={addToast}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Enable GitHub tracking" }));
    rerender(
      <TaskDetailModal
        task={taskB}
        onClose={() => {}}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        onTaskUpdated={onTaskUpdated}
        addToast={addToast}
      />,
    );

    resolveUpdate({ ...taskA, githubTracking: { enabled: true } });

    await waitFor(() => {
      expect(onTaskUpdated).not.toHaveBeenCalledWith(expect.objectContaining({ id: "FN-A" }));
    });
    expect(addToast).not.toHaveBeenCalledWith(expect.stringContaining("FN-A"), "error");
    expect(screen.getByLabelText("Enabling GitHub tracking")).toBeInTheDocument();
  });

  it("ignores stale repo-override save result after navigating to another task", async () => {
    const user = userEvent.setup();
    const onTaskUpdated = vi.fn();

    let resolveUpdate!: (value: any) => void;
    const deferred = new Promise((resolve) => {
      resolveUpdate = resolve;
    });

    const { updateTask } = await import("../../api");
    const mockUpdateTask = vi.mocked(updateTask);
    mockUpdateTask.mockImplementationOnce(() => deferred as any);

    const taskA = makeTask({ id: "FN-A", title: "A", column: "todo", githubTracking: { enabled: false } });
    const taskB = makeTask({ id: "FN-B", title: "B", column: "todo", githubTracking: { enabled: false } });

    const { rerender } = render(
      <TaskDetailModal
        task={taskA}
        onClose={() => {}}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        onTaskUpdated={onTaskUpdated}
        addToast={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Expand GitHub tracking details" }));
    const repoInput = screen.getByPlaceholderText("owner/repo");
    await user.type(repoInput, "octo/demo");
    await user.click(screen.getByRole("button", { name: "Save" }));

    rerender(
      <TaskDetailModal
        task={taskB}
        onClose={() => {}}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        onTaskUpdated={onTaskUpdated}
        addToast={() => {}}
      />,
    );

    resolveUpdate({ ...taskA, githubTracking: { enabled: false, repoOverride: "octo/demo" } });

    await waitFor(() => {
      expect(onTaskUpdated).not.toHaveBeenCalledWith(expect.objectContaining({ id: "FN-A" }));
    });
  });

  it("ignores stale create-tracking-issue retry result after navigating to another task", async () => {
    const user = userEvent.setup();
    const onTaskUpdated = vi.fn();

    let resolveUpdate!: (value: any) => void;
    const deferred = new Promise((resolve) => {
      resolveUpdate = resolve;
    });

    const { updateTask } = await import("../../api");
    const mockUpdateTask = vi.mocked(updateTask);
    mockUpdateTask.mockImplementationOnce(() => deferred as any);

    const taskA = makeTask({ id: "FN-A", title: "A", column: "todo", githubTracking: { enabled: true } });
    const taskB = makeTask({ id: "FN-B", title: "B", column: "todo", githubTracking: { enabled: false } });

    const { rerender } = render(
      <TaskDetailModal
        task={taskA}
        onClose={() => {}}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        onTaskUpdated={onTaskUpdated}
        addToast={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Expand GitHub tracking details" }));
    await user.click(screen.getByRole("button", { name: "Create tracking issue" }));

    rerender(
      <TaskDetailModal
        task={taskB}
        onClose={() => {}}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        onTaskUpdated={onTaskUpdated}
        addToast={() => {}}
      />,
    );

    resolveUpdate({ ...taskA, githubTracking: { enabled: true } });

    await waitFor(() => {
      expect(onTaskUpdated).not.toHaveBeenCalledWith(expect.objectContaining({ id: "FN-A" }));
    });
  });

  it("applies enable-tracking result when still viewing the same task", async () => {
    const user = userEvent.setup();
    const onTaskUpdated = vi.fn();

    const taskA = makeTask({ id: "FN-A", title: "A", column: "todo", githubTracking: { enabled: false } });
    const { updateTask } = await import("../../api");
    const mockUpdateTask = vi.mocked(updateTask);
    mockUpdateTask.mockResolvedValueOnce({ ...taskA, githubTracking: { enabled: true } } as any);

    render(
      <TaskDetailModal
        task={taskA}
        onClose={() => {}}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        onTaskUpdated={onTaskUpdated}
        addToast={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Enable GitHub tracking" }));

    await waitFor(() => {
      expect(onTaskUpdated).toHaveBeenCalledTimes(1);
      expect(onTaskUpdated).toHaveBeenCalledWith(expect.objectContaining({ id: "FN-A" }));
    });
  });
});
