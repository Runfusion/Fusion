import { describe, it, expect, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { render, screen } from "@testing-library/react";
import { WorkspaceWorktreesSummary, deriveWorkspaceRepoStatus, isWorkspaceTask } from "../WorkspaceWorktreesSummary";

/*
FNXC:Workspace 2026-06-21-00:00:
U3/KTD5 dashboard "doesn't look broken" floor. Asserts the invariant across both surfaces
the summary serves (FN-5893):
- happy path: workspace task (no task.worktree, two workspaceWorktrees entries) renders a
  flat per-repo list + "N repos acquired" placeholder — no crash, not blank.
- regression: single-repo task (task.worktree set, no workspaceWorktrees) renders nothing
  from this guard, so its existing rendering stays unchanged.
Narrow seam: tests the presentational component directly, no API / SSE / timers (FN-5048).
*/

const workspaceTask = {
  worktree: undefined,
  workspaceWorktrees: {
    "repo-a": { worktreePath: "/wt/repo-a", branch: "fusion/fn-1-a" },
    "repo-b": { worktreePath: "/wt/repo-b", branch: "fusion/fn-1-b" },
  },
} as const;

const singleRepoTask = {
  worktree: "/wt/single",
  workspaceWorktrees: undefined,
} as const;

describe("isWorkspaceTask", () => {
  it("is true when worktree is absent and workspaceWorktrees has entries", () => {
    expect(isWorkspaceTask(workspaceTask)).toBe(true);
  });

  it("is false for a single-repo task (worktree set)", () => {
    expect(isWorkspaceTask(singleRepoTask)).toBe(false);
  });

  it("is false when workspaceWorktrees is an empty record", () => {
    expect(isWorkspaceTask({ worktree: undefined, workspaceWorktrees: {} })).toBe(false);
  });

  it("prefers populated acquired workspace entries over stale singular routing", () => {
    expect(
      isWorkspaceTask({ worktree: "/wt/stale", workspaceWorktrees: workspaceTask.workspaceWorktrees }),
    ).toBe(true);
  });
});

describe("WorkspaceWorktreesSummary", () => {
  it("renders a flat per-repo list and placeholder for a two-repo workspace task (no crash, not empty)", () => {
    render(<WorkspaceWorktreesSummary task={workspaceTask} />);

    // Placeholder reflects the repo count.
    expect(screen.getByTestId("workspace-worktrees-placeholder").textContent).toContain("2");
    expect(screen.getByText(/2 repos acquired/i)).toBeTruthy();

    // Flat per-repo list: each repo path, worktree path, and branch is shown.
    const summary = screen.getByTestId("workspace-worktrees-summary");
    expect(summary).toBeTruthy();
    expect(screen.getByText("repo-a")).toBeTruthy();
    expect(screen.getByText("repo-b")).toBeTruthy();
    expect(screen.getByText("/wt/repo-a")).toBeTruthy();
    expect(screen.getByText("/wt/repo-b")).toBeTruthy();
    expect(screen.getByText("fusion/fn-1-a")).toBeTruthy();
    expect(screen.getByText("fusion/fn-1-b")).toBeTruthy();
  });

  it("distinguishes a modified scoped repository from a clean acquired peer", () => {
    render(<WorkspaceWorktreesSummary task={{ worktree: undefined, repositoryScope: { repositories: ["repo-a", "repo-b"] }, modifiedFiles: ["repo-a/src/changed.ts"], workspaceWorktrees: {
      "repo-a": { worktreePath: "/wt/repo-a", branch: "fusion/fn-1-a" },
      "repo-b": { worktreePath: "/wt/repo-b", branch: "fusion/fn-1-b" },
    } }} />);
    expect(screen.getAllByTestId("workspace-repo-scope-scoped")[0]).toHaveTextContent("Modified");
    expect(screen.getByText("No changes — not reviewed")).toBeTruthy();
  });

  it("sends an attributed pre-land scope correction and renders its history", async () => {
    const user = userEvent.setup();
    const onScopeChange = vi.fn(async () => undefined);
    render(<WorkspaceWorktreesSummary task={{ worktree: undefined, repositoryScope: {
      repositories: ["repo-a"], state: "confirmed", revision: 2,
      extensions: [{ repository: "repo-b", requestedAt: "2026-08-21T00:00:00.000Z", requestedBy: "executor", reason: "shared API change", status: "accepted" }],
    }, workspaceWorktrees: workspaceTask.workspaceWorktrees }} onScopeChange={onScopeChange} />);
    expect(screen.getByText(/repo-b: accepted/i)).toBeTruthy();
    const inputs = screen.getAllByRole("textbox");
    await user.type(inputs[0]!, "repo-b");
    await user.type(inputs[1]!, "needed for shared API");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(onScopeChange).toHaveBeenCalledWith({ repositories: ["repo-b"], reason: "needed for shared API", action: "add" });
  });

  it("renders recorded bases and fallback markers only in the full per-repo list", () => {
    render(<WorkspaceWorktreesSummary task={{ worktree: undefined, workspaceWorktrees: {
      "repo-a": { worktreePath: "/wt/repo-a", branch: "fusion/fn-1-a", baseBranch: "release/1.2" },
      "repo-b": { worktreePath: "/wt/repo-b", branch: "fusion/fn-1-b", baseBranch: "main", baseBranchFallbackFrom: "release/1.2" },
      "repo-legacy": { worktreePath: "/wt/legacy", branch: "fusion/fn-1-legacy" },
    } }} />);
    expect(screen.getAllByTestId("workspace-repo-base-branch")).toHaveLength(2);
    expect(screen.getByTestId("workspace-repo-base-fallback")).toHaveAttribute("title", expect.stringContaining("release/1.2"));
    expect(screen.getByTestId("workspace-repo-base-fallback")).toHaveAttribute("title", expect.stringContaining("repo-b"));
  });

  it("renders the acquired workspace entry in full and compact modes despite stale singular routing", () => {
    const staleWorkspaceTask = {
      worktree: "/wt/unrelated-stale-worktree",
      workspaceWorktrees: {
        "repo-acquired": { worktreePath: "/wt/repo-acquired/.worktrees/FN-080", branch: "fusion/FN-080" },
      },
    } as const;
    const { unmount } = render(<WorkspaceWorktreesSummary task={staleWorkspaceTask} />);

    expect(screen.getByText(/1 repo acquired/i)).toBeTruthy();
    expect(screen.getByText("repo-acquired")).toBeTruthy();
    expect(screen.getByText("/wt/repo-acquired/.worktrees/FN-080")).toBeTruthy();
    expect(screen.getByText("fusion/FN-080")).toBeTruthy();
    expect(screen.queryByText("/wt/unrelated-stale-worktree")).toBeNull();

    unmount();
    render(<WorkspaceWorktreesSummary task={staleWorkspaceTask} compact />);
    expect(screen.getByTestId("workspace-worktrees-placeholder")).toHaveTextContent("1 repo acquired");
  });

  it("renders only the compact placeholder in compact mode", () => {
    render(<WorkspaceWorktreesSummary task={workspaceTask} compact />);
    expect(screen.getByTestId("workspace-worktrees-placeholder").textContent).toContain("2 repos");
    // Compact variant omits the full per-repo list.
    expect(screen.queryByTestId("workspace-worktrees-summary")).toBeNull();
    expect(screen.queryByText("/wt/repo-a")).toBeNull();
    expect(screen.queryByTestId("workspace-repo-base-branch")).toBeNull();
    expect(screen.queryByTestId("workspace-repo-base-fallback")).toBeNull();
  });

  it("renders landed, failed, and pending statuses with the partial-land detail", () => {
    render(<WorkspaceWorktreesSummary task={{ worktree: undefined, error: "Workspace partial-land failed", workspaceWorktrees: {
      "repo-a": { worktreePath: "/wt/repo-a", branch: "fusion/fn-1-a", landedSha: "abcdef1234567890" },
      "repo-b": { worktreePath: "/wt/repo-b", branch: "fusion/fn-1-b", landFailure: { message: "squash failed: conflict", at: "2026-08-15T12:00:00.000Z" } },
      "repo-c": { worktreePath: "/wt/repo-c", branch: "fusion/fn-1-c" },
    } }} />);
    expect(screen.getByText("abcdef12")).toBeTruthy();
    expect(screen.getAllByTestId("workspace-repo-status-landed")).toHaveLength(1);
    expect(screen.getAllByTestId("workspace-repo-status-failed")).toHaveLength(1);
    expect(screen.getAllByTestId("workspace-repo-status-pending")).toHaveLength(1);
    expect(screen.getByText("squash failed: conflict")).toBeTruthy();
    expect(screen.getByText(/1 of 3 repos landed/i)).toBeTruthy();
    expect(screen.getByTestId("workspace-partial-land-detail")).toHaveTextContent("Workspace partial-land failed");
    expect(screen.getByRole("list").firstElementChild).toHaveClass("workspace-worktrees-item--wrapping");
  });

  it("renders legacy partial land failures as pending without parsing task.error", () => {
    render(<WorkspaceWorktreesSummary task={{ worktree: undefined, error: "repo-b conflict", workspaceWorktrees: {
      "repo-a": { worktreePath: "/wt/repo-a", branch: "fusion/fn-1-a", landedSha: "abcdef1234567890" },
      "repo-b": { worktreePath: "/wt/repo-b", branch: "fusion/fn-1-b" },
    } }} />);
    expect(screen.getByText("abcdef12")).toBeTruthy();
    expect(screen.getAllByTestId("workspace-repo-status-pending")).toHaveLength(1);
    expect(screen.queryByTestId("workspace-repo-status-failed")).toBeNull();
    expect(screen.getByTestId("workspace-partial-land-detail")).toHaveTextContent("repo-b conflict");
  });

  it("keeps compact mode free of per-repository status details", () => {
    render(<WorkspaceWorktreesSummary compact task={{ worktree: undefined, workspaceWorktrees: {
      "repo-a": { worktreePath: "/wt/repo-a", branch: "fusion/fn-1-a", landedSha: "abcdef1234567890", landFailure: { message: "stale", at: "now" } },
    } }} />);
    expect(screen.queryByTestId(/workspace-repo-status/)).toBeNull();
    expect(screen.queryByText("abcdef12")).toBeNull();
    expect(screen.queryByText("stale")).toBeNull();
  });

  it("derives landed proof before failure, including finalize recovery proof", () => {
    const failure = { message: "failed", at: "now" };
    expect(deriveWorkspaceRepoStatus({ worktreePath: "/wt", branch: "x", landedSha: "landed", landFailure: failure }, "repo-a")).toMatchObject({ status: "landed", landedSha: "landed" });
    expect(deriveWorkspaceRepoStatus({ worktreePath: "/wt", branch: "x", landFailure: failure }, "repo-a", { workspaceLandedShas: { "repo-a": "recovered" } })).toMatchObject({ status: "landed", landedSha: "recovered" });
    expect(deriveWorkspaceRepoStatus({ worktreePath: "/wt", branch: "x", landFailure: failure }, "repo-a")).toMatchObject({ status: "failed" });
    expect(deriveWorkspaceRepoStatus({ worktreePath: "/wt", branch: "x" }, "repo-a")).toMatchObject({ status: "pending" });
  });

  it("renders nothing for a single-repo task, leaving existing rendering unchanged", () => {
    const { container } = render(<WorkspaceWorktreesSummary task={singleRepoTask} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("workspace-worktrees-summary")).toBeNull();
    expect(screen.queryByTestId("workspace-worktrees-placeholder")).toBeNull();
  });

  it("renders nothing when workspaceWorktrees is empty", () => {
    const { container } = render(
      <WorkspaceWorktreesSummary task={{ worktree: undefined, workspaceWorktrees: {} }} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
