import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeTask,
  mockFetchOverlapBlockerReport,
  noop,
  noopDelete,
  noopMerge,
  noopMove,
  noopOpenDetail,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import { TaskDetailContent } from "../TaskDetailModal";

setupTaskDetailModalHooks();

const sharedProps = {
  onDeleteTask: noopDelete,
  onMergeTask: noopMerge,
  onOpenDetail: noopOpenDetail,
  addToast: noop,
};

describe("TaskDetailModal tab relocation", () => {
  beforeEach(() => {
    mockFetchOverlapBlockerReport.mockReset();
    mockFetchOverlapBlockerReport.mockResolvedValue({
      taskId: "FN-099",
      blockerId: "FN-194",
      blockerColumn: "todo",
      reason: "ok",
      taskScopeCount: 1,
      blockerScopeCount: 1,
      overlaps: [],
    });
  });

  it("reserves Plan for progress and the generated prompt while Details owns the original prompt", () => {
    const { container } = render(
      <TaskDetailContent
        {...sharedProps}
        embedded
        initialTab="definition"
        task={makeTask({
          description: "# Operator request",
          prompt: "# Generated plan",
          steps: [{ title: "Implement", status: "pending" }],
          dependencies: ["FN-100"],
        })}
        tasks={[makeTask({ id: "FN-100", title: "Dependency" })]}
      />,
    );

    expect(container.querySelector(".detail-step-progress")).not.toBeNull();
    expect(container.querySelector(".detail-section--plan-prompt")).not.toBeNull();
    expect(container.querySelector(".detail-section--original-prompt")).toBeNull();
    expect(container.querySelector(".detail-deps")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(container.querySelector(".detail-section--original-prompt")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Expand original prompt" })).toBeInTheDocument();
  });

  it("routes the retries deep link to Details", () => {
    render(
      <TaskDetailContent
        {...sharedProps}
        embedded
        initialTab="retries"
        task={makeTask({ retrySummary: { total: 1 } })}
      />,
    );

    expect(screen.getByRole("button", { name: "Details" })).toHaveClass("detail-tab-active");
  });

  it("folds Routing and Debug into Details as collapsed disclosures", async () => {
    render(
      <TaskDetailContent
        {...sharedProps}
        embedded
        initialTab="details"
        task={makeTask()}
      />,
    );

    expect(screen.getByRole("button", { name: "Expand routing details" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "Expand debug details" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Task Routing")).toBeNull();
    expect(screen.queryByTestId("spec-lock-report")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Expand routing details" }));
    expect(await screen.findByText("Task Routing")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Collapse routing details" })).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(screen.getByRole("button", { name: "Expand debug details" }));
    expect(await screen.findByTestId("spec-lock-report")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Collapse debug details" })).toHaveAttribute("aria-expanded", "true");
  });

  it("renders every overlap pair and identifies a matched blocker glob in Dependencies", async () => {
    mockFetchOverlapBlockerReport.mockResolvedValue({
      taskId: "FN-099",
      blockerId: "FN-194",
      blockerColumn: "todo",
      reason: "ok",
      taskScopeCount: 2,
      blockerScopeCount: 2,
      overlaps: [
        { path: "packages/dashboard/app/components/TaskDetailModal.tsx", blockerPath: "packages/dashboard/app/components/*" },
        { path: "packages/engine/src/scheduler.ts", blockerPath: "packages/engine/src/scheduler.ts" },
      ],
    });

    render(
      <TaskDetailContent
        {...sharedProps}
        embedded
        initialTab="dependencies"
        task={makeTask({ overlapBlockedBy: "FN-194" })}
      />,
    );

    await waitFor(() => expect(mockFetchOverlapBlockerReport).toHaveBeenCalledWith("FN-099", undefined));
    expect(await screen.findByText("packages/dashboard/app/components/TaskDetailModal.tsx")).toBeInTheDocument();
    expect(screen.getByText("matches packages/dashboard/app/components/*")).toBeInTheDocument();
    expect(screen.getByText("packages/engine/src/scheduler.ts")).toBeInTheDocument();
  });

  it("shows the overlap report loading state while the Dependencies request is pending", async () => {
    mockFetchOverlapBlockerReport.mockImplementation(() => new Promise(() => {}));

    render(
      <TaskDetailContent
        {...sharedProps}
        embedded
        initialTab="dependencies"
        task={makeTask({ overlapBlockedBy: "FN-194" })}
      />,
    );

    expect(await screen.findByText("Loading overlapping files…")).toBeInTheDocument();
  });

  it("explains when the blocker declares no file scope", async () => {
    mockFetchOverlapBlockerReport.mockResolvedValue({
      taskId: "FN-099",
      blockerId: "FN-194",
      blockerColumn: "todo",
      reason: "ok",
      taskScopeCount: 1,
      blockerScopeCount: 0,
      overlaps: [],
    });

    render(
      <TaskDetailContent
        {...sharedProps}
        embedded
        initialTab="dependencies"
        task={makeTask({ overlapBlockedBy: "FN-194" })}
      />,
    );

    expect(await screen.findByText("The blocker declares no file scope.")).toBeInTheDocument();
  });

  it("explains when the stored scopes no longer overlap", async () => {
    mockFetchOverlapBlockerReport.mockResolvedValue({
      taskId: "FN-099",
      blockerId: "FN-194",
      blockerColumn: "todo",
      reason: "no-overlap",
      taskScopeCount: 1,
      blockerScopeCount: 1,
      overlaps: [],
    });

    render(
      <TaskDetailContent
        {...sharedProps}
        embedded
        initialTab="dependencies"
        task={makeTask({ overlapBlockedBy: "FN-194" })}
      />,
    );

    expect(await screen.findByText("No overlapping files found.")).toBeInTheDocument();
  });

  it("keeps the blocker controls visible when the overlap report request fails", async () => {
    mockFetchOverlapBlockerReport.mockRejectedValue(new Error("offline"));

    render(
      <TaskDetailContent
        {...sharedProps}
        embedded
        initialTab="dependencies"
        task={makeTask({ overlapBlockedBy: "FN-194" })}
      />,
    );

    expect(await screen.findByText("Could not load overlapping files.")).toBeInTheDocument();
    expect(screen.getByText(/File scope overlap blocker:/)).toHaveTextContent("FN-194");
    expect(screen.getByRole("button", { name: "Clear" })).toBeInTheDocument();
  });

  it("does not request overlap details outside Dependencies", async () => {
    render(
      <TaskDetailContent
        {...sharedProps}
        embedded
        initialTab="definition"
        task={makeTask({ overlapBlockedBy: "FN-194" })}
      />,
    );

    await waitFor(() => expect(screen.getByRole("button", { name: "Plan" })).toHaveClass("detail-tab-active"));
    expect(mockFetchOverlapBlockerReport).not.toHaveBeenCalled();
  });
});
