import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../PrPanel", () => ({
  PrPanel: () => <div data-testid="pr-panel-stub">PR Panel</div>,
}));

import {
  makeTask,
  noop,
  noopDelete,
  noopMerge,
  noopMove,
  noopOpenDetail,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import { TaskDetailModal } from "../TaskDetailModal";

setupTaskDetailModalHooks();

describe("TaskDetailModal Pull Request tab", () => {
  it("shows Pull Request tab only for in-review tasks", () => {
    const { rerender } = render(
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

    expect(screen.queryByRole("button", { name: "Pull Request" })).toBeNull();

    rerender(
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

    expect(screen.getByRole("button", { name: "Pull Request" })).toBeInTheDocument();
  });

  it("renders PrPanel and in-review stall badge in Pull Request tab, not Definition tab", () => {
    const inReviewStall = {
      code: "merge-failed" as const,
      reason: "merge failed",
      observedAt: "2026-01-01T00:00:00Z",
      consecutiveFailures: 2,
      mergeRetries: 2,
      maxAutoMergeRetries: 3,
    };

    const { container } = render(
      <TaskDetailModal
        task={makeTask({ column: "in-review", inReviewStall })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    expect(screen.queryByTestId("pr-panel-stub")).toBeNull();
    expect(document.querySelector(".detail-in-review-stall")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Pull Request" }));

    expect(screen.getByTestId("pr-panel-stub")).toBeInTheDocument();
    expect(document.querySelector(".detail-in-review-stall")).toBeTruthy();
  });
});
