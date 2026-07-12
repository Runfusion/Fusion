import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: "<svg data-testid='mock-mermaid-svg'></svg>" }),
  },
}));

const mockEmbeddedTerminal = vi.fn((props: Record<string, unknown>) => (
  <div data-testid="mock-worktree-terminal" data-props={JSON.stringify(props)} />
));

vi.mock("../TerminalModal", () => ({
  TerminalModal: (props: Record<string, unknown>) => mockEmbeddedTerminal(props),
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
import * as dashboardApi from "../../api";

setupTaskDetailModalHooks();

function renderDetail(task = makeTask({ id: "FN-7813", worktree: "/repo/.worktrees/FN-7813" }), initialTab: "definition" | "worktree-terminal" = "definition") {
  return render(
    <TaskDetailModal
      initialTab={initialTab}
      task={task}
      projectId="proj-123"
      onClose={noop}
      onMoveTask={noopMove}
      onDeleteTask={noopDelete}
      onMergeTask={noopMerge}
      onOpenDetail={noopOpenDetail}
      addToast={noop}
    />,
  );
}

describe("TaskDetailModal worktree terminal tab", () => {
  beforeEach(() => {
    mockEmbeddedTerminal.mockClear();
    vi.spyOn(dashboardApi, "api").mockResolvedValue({ sessions: [] });
  });

  it("shows the interactive Terminal tab when a single-task worktree exists", async () => {
    renderDetail();

    expect(await screen.findByRole("button", { name: "Terminal" })).toBeInTheDocument();
  });

  it("hides the interactive Terminal tab when no worktree exists", async () => {
    renderDetail(makeTask({ id: "FN-7813", worktree: undefined }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "Terminal" })).toBeNull());
  });

  it("hides the interactive Terminal tab for workspace tasks without a singular worktree", async () => {
    renderDetail(makeTask({
      id: "FN-7813",
      worktree: undefined,
      workspaceWorktrees: {
        "packages/app": { worktreePath: "/repo/.worktrees/FN-7813-app", branch: "fusion/FN-7813-app" },
      },
    }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "Terminal" })).toBeNull());
  });

  it("falls back from the active worktree terminal tab when eligibility drops", async () => {
    const { rerender } = renderDetail(undefined, "worktree-terminal");

    fireEvent.click(await screen.findByRole("button", { name: "Terminal" }));
    expect(await screen.findByTestId("mock-worktree-terminal")).toBeInTheDocument();

    rerender(
      <TaskDetailModal
        initialTab="worktree-terminal"
        task={makeTask({ id: "FN-7813", worktree: undefined })}
        projectId="proj-123"
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Plan" })).toHaveClass("detail-tab-active");
    });
    expect(screen.queryByTestId("mock-worktree-terminal")).toBeNull();
  });

  it("passes the task worktree and task-scoped namespace into embedded TerminalModal", async () => {
    renderDetail(undefined, "worktree-terminal");

    fireEvent.click(await screen.findByRole("button", { name: "Terminal" }));
    await screen.findByTestId("mock-worktree-terminal");

    expect(mockEmbeddedTerminal).toHaveBeenLastCalledWith(expect.objectContaining({
      embedded: true,
      isOpen: true,
      defaultCwd: "/repo/.worktrees/FN-7813",
      scopeId: "FN-7813",
      projectId: "proj-123",
    }));
  });

  it("renders distinct Session and Terminal tab labels when an agent session exists", async () => {
    vi.mocked(dashboardApi.api).mockResolvedValueOnce({
      sessions: [{
        id: "cli-1",
        taskId: "FN-7813",
        projectId: "proj-123",
        adapterId: "claude-local",
        agentState: "busy",
        terminationReason: null,
        autonomyPosture: null,
      }],
    });

    renderDetail();

    expect(await screen.findByRole("button", { name: "Session" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Terminal" })).toBeInTheDocument();
  });
});
