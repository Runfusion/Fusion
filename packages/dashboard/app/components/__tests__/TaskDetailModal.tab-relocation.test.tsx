import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAppFile } from "../../test/cssFixture";
import {
  makeTask,
  mockFetchOverlapBlockerReport,
  noop,
  noopDelete,
  noopMerge,
  noopMove,
  noopOpenDetail,
  readDashboardStylesSource,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import { TaskDetailContent, TaskDetailModal } from "../TaskDetailModal";

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

const DESKTOP_WIDTH = 1024;
const MOBILE_WIDTH = 375;

function setViewportWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: width });
  window.dispatchEvent(new Event("resize"));
}

const workspaceLandingTask = makeTask({
  worktree: undefined,
  workspaceWorktrees: {
    "repo-a": {
      worktreePath: "/workspace/repo-a/.worktrees/FN-289",
      branch: "fusion/FN-289-repo-a",
      landedSha: "abcdef1234567890",
    },
    "repo-b": {
      worktreePath: "/workspace/repo-b/.worktrees/FN-289",
      branch: "fusion/FN-289-repo-b",
    },
  },
});

describe("TaskDetail workspace repository summary relocation", () => {
  afterEach(() => {
    setViewportWidth(DESKTOP_WIDTH);
  });

  it("shows landing progress only after navigating from Plan to Details", () => {
    const { container } = render(
      <TaskDetailContent
        {...sharedProps}
        embedded
        initialTab="definition"
        task={workspaceLandingTask}
      />,
    );

    expect(screen.queryByTestId("workspace-worktrees-summary")).toBeNull();
    expect(screen.queryByText(/1 of 2 repos landed/i)).toBeNull();
    expect(container.querySelector(".detail-section--workspace-repos")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Details" }));

    const summary = screen.getByTestId("workspace-worktrees-summary");
    expect(within(summary).getByText(/1 of 2 repos landed/i)).toBeInTheDocument();
    expect(within(summary).getByText("repo-a")).toBeInTheDocument();
    expect(within(summary).getByText("repo-b")).toBeInTheDocument();
    expect(within(summary).getByText("abcdef12")).toBeInTheDocument();

    const originalPromptSection = container.querySelector(".detail-section--original-prompt");
    const workspaceSection = container.querySelector(".detail-section--workspace-repos");
    expect(originalPromptSection).not.toBeNull();
    expect(originalPromptSection?.nextElementSibling).toBe(workspaceSection);
  });

  it("renders landing progress in the overlay modal Details body", () => {
    const { baseElement } = render(
      <TaskDetailModal
        {...sharedProps}
        initialTab="details"
        onClose={noop}
        task={workspaceLandingTask}
      />,
    );

    const workspaceSection = baseElement.querySelector(".detail-section--workspace-repos");
    expect(workspaceSection).not.toBeNull();
    expect(workspaceSection?.querySelector('[data-testid="workspace-worktrees-summary"]')).not.toBeNull();
  });

  it("removes landing progress when navigating to every neighboring tab", () => {
    render(
      <TaskDetailContent
        {...sharedProps}
        embedded
        initialTab="details"
        task={workspaceLandingTask}
      />,
    );

    expect(screen.getByTestId("workspace-worktrees-summary")).toBeInTheDocument();
    for (const tabName of ["Plan", "Activity", "Dependencies", "Workflow"]) {
      fireEvent.click(screen.getByRole("button", { name: tabName }));
      expect(screen.queryByTestId("workspace-worktrees-summary")).toBeNull();
    }
  });

  it("renders landing progress in Details at the mobile breakpoint", () => {
    setViewportWidth(MOBILE_WIDTH);

    render(
      <TaskDetailContent
        {...sharedProps}
        embedded
        initialTab="details"
        task={workspaceLandingTask}
      />,
    );

    expect(screen.getByTestId("workspace-worktrees-summary")).toBeInTheDocument();
    expect(screen.getByText(/1 of 2 repos landed/i)).toBeInTheDocument();
  });

  it.each([
    ["single repository", { worktree: "/workspace/.worktrees/FN-289", workspaceWorktrees: undefined }],
    ["undefined workspace map", { worktree: undefined, workspaceWorktrees: undefined }],
    ["empty workspace map", { worktree: undefined, workspaceWorktrees: {} }],
  ])("does not leave an empty workspace section for %s", (_label, overrides) => {
    const { container } = render(
      <TaskDetailContent
        {...sharedProps}
        embedded
        initialTab="details"
        task={makeTask(overrides)}
      />,
    );

    expect(container.querySelector(".detail-section--workspace-repos")).toBeNull();
    expect(screen.queryByTestId("workspace-worktrees-summary")).toBeNull();
    expect(screen.queryByLabelText("Workspace repos")).toBeNull();
  });

  it("preserves landed, failed, and pending repository details in Details", () => {
    render(
      <TaskDetailContent
        {...sharedProps}
        embedded
        initialTab="details"
        task={makeTask({
          worktree: undefined,
          error: "Workspace partial-land failed",
          workspaceWorktrees: {
            "repo-a": {
              worktreePath: "/workspace/repo-a/.worktrees/FN-289",
              branch: "fusion/FN-289-repo-a",
              landedSha: "abcdef1234567890",
            },
            "repo-b": {
              worktreePath: "/workspace/repo-b/.worktrees/FN-289",
              branch: "fusion/FN-289-repo-b",
              landFailure: {
                message: "squash failed: conflict",
                at: "2026-08-29T00:00:00.000Z",
              },
            },
            "repo-c": {
              worktreePath: "/workspace/repo-c/.worktrees/FN-289",
              branch: "fusion/FN-289-repo-c",
            },
          },
        })}
      />,
    );

    expect(screen.getAllByTestId("workspace-repo-status-landed")).toHaveLength(1);
    expect(screen.getAllByTestId("workspace-repo-status-failed")).toHaveLength(1);
    expect(screen.getAllByTestId("workspace-repo-status-pending")).toHaveLength(1);
    expect(screen.getByText("squash failed: conflict")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-partial-land-detail")).toHaveTextContent("Workspace partial-land failed");
    expect(screen.getByText(/1 of 3 repos landed/i)).toBeInTheDocument();
  });

  it("keeps exactly one full detail renderer and the compact TaskCard renderer", () => {
    const css = readDashboardStylesSource();
    const taskCardSource = readAppFile("components/TaskCard.tsx");
    const taskDetailSource = readAppFile("components/TaskDetailModal.tsx");
    const taskCardRenderers = taskCardSource.match(/<WorkspaceWorktreesSummary\b[^>]*\/>/g) ?? [];
    const taskDetailRenderers = taskDetailSource.match(/<WorkspaceWorktreesSummary\b[^>]*\/>/g) ?? [];

    expect(css).not.toContain(".task-detail-content--planner-chat-expanded .workspace-worktrees-summary");
    expect(taskCardRenderers).toHaveLength(1);
    expect(taskCardRenderers[0]).toContain("compact");
    expect(taskDetailRenderers).toHaveLength(1);
    expect(taskDetailRenderers[0]).not.toContain("compact");
    expect([...taskCardRenderers, ...taskDetailRenderers]).toHaveLength(2);
  });
});
