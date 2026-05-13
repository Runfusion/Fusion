import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

describe("TaskDetailModal GitHub tracking CTA", () => {
  it("disables create tracking issue when task has no usable title", async () => {
    const user = userEvent.setup();
    render(
      <TaskDetailModal
        task={makeTask({
          githubTracking: { enabled: true },
          title: "",
          description: "",
        })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Expand GitHub tracking details" }));
    const button = screen.getByRole("button", { name: "Create tracking issue" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Add a title or description so a tracking issue can be created.");
    expect(screen.getByText("Tracking issue will be created once this task has a title or description to summarize.")).toBeInTheDocument();
  });

  it("enables create tracking issue when task title is present", async () => {
    const user = userEvent.setup();
    render(
      <TaskDetailModal
        task={makeTask({
          githubTracking: { enabled: true },
          title: "Real title",
          description: "",
        })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Expand GitHub tracking details" }));
    expect(screen.getByRole("button", { name: "Create tracking issue" })).toBeEnabled();
    expect(screen.queryByText("Tracking issue will be created once this task has a title or description to summarize.")).not.toBeInTheDocument();
  });

  it("enables create tracking issue when task description has a non-empty first line", async () => {
    const user = userEvent.setup();
    render(
      <TaskDetailModal
        task={makeTask({
          githubTracking: { enabled: true },
          title: "",
          description: "A meaningful first line.\nMore text.",
        })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Expand GitHub tracking details" }));
    expect(screen.getByRole("button", { name: "Create tracking issue" })).toBeEnabled();
    expect(screen.queryByText("Tracking issue will be created once this task has a title or description to summarize.")).not.toBeInTheDocument();
  });
});

describe("TaskDetailModal in-review stall diagnostics", () => {
  it("renders diagnostic row and jumps to highlighted activity entry", async () => {
    const user = userEvent.setup();
    render(
      <TaskDetailModal
        task={makeTask({
          column: "in-review",
          inReviewStall: {
            code: "merge-blocker",
            reason: "Workflow pre-merge check failed",
            observedAt: "2026-05-13T00:00:00.000Z",
          },
          log: [
            { timestamp: "2026-05-13T00:01:00.000Z", action: "In-review stall surfaced [merge-blocker]: Workflow pre-merge check failed" },
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

    expect(screen.getByText("Merge blocked by a pre-merge check")).toBeInTheDocument();
    expect(screen.getByText("Workflow pre-merge check failed")).toBeInTheDocument();
    expect(screen.getByText("Open the Review tab to see which step is blocking, then fix the failure or override the step.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "View activity log" }));
    expect(screen.getByRole("button", { name: "Activity" })).toHaveClass("log-subview-btn-active");
    const highlighted = document.querySelector(".detail-log-entry--stall-highlight .detail-log-action");
    expect(highlighted?.textContent).toContain("In-review stall surfaced [merge-blocker]");
  });

  it("shows no-log copy when no matching stall entry exists", () => {
    render(
      <TaskDetailModal
        task={makeTask({
          column: "in-review",
          inReviewStall: {
            code: "merge-blocker",
            reason: "Workflow pre-merge check failed",
            observedAt: "2026-05-13T00:00:00.000Z",
          },
          log: [{ timestamp: "2026-05-13T00:01:00.000Z", action: "Something else" }],
        })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    expect(screen.getByText("No log entry yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "View activity log" })).not.toBeInTheDocument();
  });

  it.each([
    {
      label: "paused in-review task",
      task: makeTask({
        column: "in-review",
        paused: true,
        inReviewStall: {
          code: "merge-blocker",
          reason: "Workflow pre-merge check failed",
          observedAt: "2026-05-13T00:00:00.000Z",
        },
      }),
    },
    {
      label: "non in-review task",
      task: makeTask({
        column: "in-progress",
        inReviewStall: {
          code: "merge-blocker",
          reason: "Workflow pre-merge check failed",
          observedAt: "2026-05-13T00:00:00.000Z",
        },
      }),
    },
  ])("does not render diagnostic row for $label", ({ task }) => {
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

    expect(screen.queryByText("Merge blocked by a pre-merge check")).not.toBeInTheDocument();
  });
});
