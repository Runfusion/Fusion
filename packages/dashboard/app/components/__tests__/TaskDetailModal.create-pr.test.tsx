import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrInfo } from "@fusion/core";

const prPanelState = vi.hoisted(() => ({
  latestPrInfo: undefined as PrInfo | undefined,
}));

const prCreateModalState = vi.hoisted(() => ({
  latestProps: null as any,
}));

const taskReviewTabState = vi.hoisted(() => ({
  latestProps: null as any,
}));

vi.mock("../PrPanel", () => ({
  PrPanel: (props: any) => {
    prPanelState.latestPrInfo = props.prInfo;
    return (
      <div>
        <button type="button" onClick={() => props.onRequestCreatePr?.()}>
          Create PR
        </button>
        <div data-testid="pr-panel-pr-number">{props.prInfo?.number ?? "none"}</div>
      </div>
    );
  },
}));

vi.mock("../PrCreateModal", () => ({
  PrCreateModal: (props: any) => {
    prCreateModalState.latestProps = props;
    if (!props.open) {
      return null;
    }
    return (
      <div data-testid="pr-create-modal-stub">
        <button
          type="button"
          onClick={() =>
            props.onCreated({
              number: 321,
              title: "Created PR",
              url: "https://example.test/pr/321",
              status: "open",
              headBranch: "fusion/FN-5020",
              baseBranch: "main",
              commentCount: 0,
            } satisfies PrInfo)
          }
        >
          Stub create
        </button>
        <button type="button" onClick={() => props.onClose()}>
          Stub close
        </button>
      </div>
    );
  },
}));

vi.mock("../TaskReviewTab", () => ({
  TaskReviewTab: (props: any) => {
    taskReviewTabState.latestProps = props;
    return (
      <button type="button" data-testid="task-review-create-pr" onClick={() => props.onRequestCreatePr?.()}>
        Review create PR
      </button>
    );
  },
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

describe("TaskDetailModal create-PR wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prPanelState.latestPrInfo = undefined;
    prCreateModalState.latestProps = null;
    taskReviewTabState.latestProps = null;
  });

  it("opens PrCreateModal from PrPanel and updates prInfo on create", async () => {
    const addToast = vi.fn();
    const onTaskUpdated = vi.fn();
    const task = makeTask({ id: "FN-5020", prInfo: undefined, column: "in-review" });

    render(
      <TaskDetailModal
        task={task}
        projectId="project-123"
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={addToast}
        onTaskUpdated={onTaskUpdated}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Create PR" })).toBeInTheDocument();
    });
    expect(screen.queryByTestId("pr-create-modal-stub")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Create PR" }));

    expect(screen.getByTestId("pr-create-modal-stub")).toBeInTheDocument();
    expect(prCreateModalState.latestProps?.open).toBe(true);
    expect(prCreateModalState.latestProps?.taskId).toBe("FN-5020");
    expect(prCreateModalState.latestProps?.projectId).toBe("project-123");
    expect(prCreateModalState.latestProps?.defaultBaseBranch).toBeUndefined();
    expect(prCreateModalState.latestProps?.addToast).toBe(addToast);

    fireEvent.click(screen.getByRole("button", { name: "Stub create" }));

    expect(screen.queryByTestId("pr-create-modal-stub")).toBeNull();
    expect(prCreateModalState.latestProps?.open).toBe(false);
    expect(screen.getByTestId("pr-panel-pr-number")).toHaveTextContent("321");
    expect(prPanelState.latestPrInfo?.number).toBe(321);
    expect(onTaskUpdated).toHaveBeenCalledWith(expect.objectContaining({
      id: "FN-5020",
      prInfo: expect.objectContaining({ number: 321 }),
    }));
  });

  it("opens the same PrCreateModal from TaskReviewTab without leaving the Review tab and closes via onClose", async () => {
    const task = makeTask({ id: "FN-5021", prInfo: undefined, column: "in-review" });

    render(
      <TaskDetailModal
        task={task}
        projectId="project-123"
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={vi.fn()}
        prAuthAvailable
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    await waitFor(() => expect(screen.getByTestId("task-review-create-pr")).toBeInTheDocument());
    expect(screen.queryByTestId("pr-create-modal-stub")).toBeNull();

    fireEvent.click(screen.getByTestId("task-review-create-pr"));

    expect(await screen.findByTestId("pr-create-modal-stub")).toBeInTheDocument();
    expect(prCreateModalState.latestProps?.open).toBe(true);
    expect(prCreateModalState.latestProps?.taskId).toBe("FN-5021");
    expect(prCreateModalState.latestProps?.projectId).toBe("project-123");
    expect(prCreateModalState.latestProps?.defaultBaseBranch).toBeUndefined();
    expect(taskReviewTabState.latestProps?.prAuthAvailable).toBe(true);
    expect(taskReviewTabState.latestProps?.autoMergeEnabled).toBe(false);
    expect(screen.getByTestId("task-review-create-pr")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Stub close" }));
    expect(screen.queryByTestId("pr-create-modal-stub")).toBeNull();
    expect(prCreateModalState.latestProps?.open).toBe(false);
  });
});
