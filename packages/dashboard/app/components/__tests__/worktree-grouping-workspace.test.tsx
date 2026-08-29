import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Task } from "@fusion/core";
import { WorktreeGroup } from "../WorktreeGroup";

vi.mock("../TaskCard", () => ({
  TaskCard: ({ task }: { task: Task }) => <div data-testid={`task-${task.id}`}>{task.id}</div>,
}));
vi.mock("lucide-react", () => ({
  ClipboardList: () => <svg data-testid="clipboard-icon" />,
  GitBranch: () => <svg data-testid="git-branch-icon" />,
}));

const workspaceTask = {
  id: "FN-9044",
  title: "Workspace task",
  description: "",
  column: "in-progress",
  dependencies: [],
  steps: [],
  currentStep: 0,
  log: [],
  createdAt: "2026-08-03T00:00:00.000Z",
  updatedAt: "2026-08-03T00:00:00.000Z",
  workspaceWorktrees: {
    "repo-a": { worktreePath: "/ws/repo-a/.worktrees/FN-9044", branch: "fusion/FN-9044" },
    "repo-b": { worktreePath: "/ws/repo-b/.worktrees/FN-9044", branch: "fusion/FN-9044" },
  },
} as Task;

function renderGroup(kind: "workspace" | "unassigned", task: Task, repoCount?: number) {
  return render(
    <WorktreeGroup
      {...({
        kind,
        label: kind === "workspace" ? "FN-9044" : "Unassigned",
        repoCount,
        activeTasks: [task],
        queuedTasks: [],
        onOpenDetail: vi.fn(),
        addToast: vi.fn(),
      } as React.ComponentProps<typeof WorktreeGroup>)}
    />,
  );
}

describe("WorktreeGroup workspace headers", () => {
  it("renders the workspace group, not Unassigned, with a git branch icon and one task card", () => {
    renderGroup("workspace", workspaceTask, 2);

    expect(screen.getByText("FN-9044 · 2 repos")).toBeInTheDocument();
    expect(screen.queryByText("Unassigned")).not.toBeInTheDocument();
    expect(screen.getByTestId("git-branch-icon")).toBeInTheDocument();
    expect(screen.queryByTestId("clipboard-icon")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("task-FN-9044")).toHaveLength(1);
  });

  it("keeps a genuinely worktree-less task in the Unassigned group", () => {
    renderGroup("unassigned", { ...workspaceTask, id: "FN-unassigned", workspaceWorktrees: undefined });

    expect(screen.getByText("Unassigned")).toBeInTheDocument();
    expect(screen.getByTestId("clipboard-icon")).toBeInTheDocument();
    expect(screen.getAllByTestId("task-FN-unassigned")).toHaveLength(1);
  });
});
