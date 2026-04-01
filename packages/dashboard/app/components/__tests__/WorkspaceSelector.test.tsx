import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceSelector } from "../WorkspaceSelector";
import type { WorkspaceInfo } from "../../hooks/useWorkspaces";

const workspaces: WorkspaceInfo[] = [
  {
    id: "FN-123",
    label: "FN-123",
    title: "Implement a very long task title that should be truncated in the dropdown list",
    worktree: "/repo/.worktrees/kb-123",
    kind: "task",
  },
  {
    id: "FN-200",
    label: "FN-200",
    title: "Short title",
    worktree: "/repo/.worktrees/kb-200",
    kind: "task",
  },
];

describe("WorkspaceSelector", () => {
  it("shows the project name when project root is selected", () => {
    render(
      <WorkspaceSelector
        currentWorkspace="project"
        projectName="kb"
        workspaces={workspaces}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /kb/i })).toBeInTheDocument();
  });

  it("opens the menu and highlights the current workspace", async () => {
    const user = userEvent.setup();
    render(
      <WorkspaceSelector
        currentWorkspace="FN-200"
        projectName="kb"
        workspaces={workspaces}
        onSelect={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /KB-200/i }));

    expect(screen.getByText("Project Root")).toBeInTheDocument();
    const menu = screen.getByRole("listbox", { name: /select workspace/i });
    const activeOption = within(menu).getByRole("button", { name: /KB-200 Short title/i });
    expect(activeOption.className).toContain("active");
  });

  it("calls onSelect and closes when choosing a workspace", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <WorkspaceSelector
        currentWorkspace="project"
        projectName="kb"
        workspaces={workspaces}
        onSelect={onSelect}
      />,
    );

    await user.click(screen.getByRole("button", { name: /kb/i }));
    await user.click(screen.getByRole("button", { name: /KB-123/i }));

    expect(onSelect).toHaveBeenCalledWith("FN-123");
    expect(screen.queryByText("Task Worktrees")).not.toBeInTheDocument();
  });

  it("truncates long task titles in the dropdown", async () => {
    const user = userEvent.setup();
    render(
      <WorkspaceSelector
        currentWorkspace="project"
        projectName="kb"
        workspaces={workspaces}
        onSelect={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /kb/i }));

    expect(screen.getByText(/Implement a very long task title that shoul/)).toBeInTheDocument();
    expect(screen.getByText(/…$/)).toBeInTheDocument();
  });
});
