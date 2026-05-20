import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskDetailModal } from "../TaskDetailModal";
import * as api from "../../api";
import { makeTask, noop, noopDelete, noopMerge, noopMove, noopOpenDetail, setupTaskDetailModalHooks } from "./TaskDetailModal.test-helpers";

setupTaskDetailModalHooks();

describe("TaskDetailModal rebind banner", () => {
  it("shows banner only for in-review tasks with missing branch", () => {
    const { rerender } = render(
      <TaskDetailModal
        task={makeTask({ column: "in-review", branch: null, worktree: "/tmp/wt" })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    expect(screen.getByText("Branch needs reattachment")).toBeTruthy();

    rerender(
      <TaskDetailModal
        task={makeTask({ column: "in-review", branch: "fusion/fn-099", worktree: null })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );
    // FN-5113: branch present + worktree cleared is the healthy post-handoff/post-rebind state (see AGENTS.md FN-5083). Banner must NOT show.
    expect(screen.queryByText("Branch needs reattachment")).toBeNull();

    rerender(
      <TaskDetailModal
        task={makeTask({ column: "in-review", branch: "fusion/fn-099", worktree: "/tmp/wt" })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );
    expect(screen.queryByText("Branch needs reattachment")).toBeNull();
  });

  it("calls recover endpoint and renders applied result", async () => {
    const recoverSpy = vi.spyOn(api, "recoverBranchBinding").mockResolvedValueOnce({
      taskId: "FN-099",
      result: "applied",
      branch: "fusion/fn-099",
      aheadCount: 2,
      integrationBase: "main",
      previousBranch: null,
    });

    render(
      <TaskDetailModal
        task={makeTask({ column: "in-review", branch: null, worktree: null })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Reattach branch" }));

    expect(recoverSpy).toHaveBeenCalledWith("FN-099", undefined);
    expect(await screen.findByText(/Reattached fusion\/fn-099/)).toBeTruthy();
  });

  it("renders skipped reason and candidates", async () => {
    vi.spyOn(api, "recoverBranchBinding").mockResolvedValueOnce({
      taskId: "FN-099",
      result: "skipped",
      reason: "ambiguous-candidates",
      candidates: [
        { branch: "fusion/FN-099", aheadCount: 1 },
        { branch: "fusion/fn-099", aheadCount: 2 },
      ],
    });

    render(
      <TaskDetailModal
        task={makeTask({ column: "in-review", branch: null, worktree: null })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Reattach branch" }));

    expect(await screen.findByText(/Reattachment skipped: ambiguous-candidates/)).toBeTruthy();
    expect(screen.getByText(/fusion\/FN-099/)).toBeTruthy();
  });
});
