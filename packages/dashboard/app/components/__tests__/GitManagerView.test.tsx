import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * FN-426: Git Manager becomes a real destination so nothing depends on the optional right dock. This suite proves the
 * PAGE contract: one header, no fake close affordance, no overlay/floating window, and the Pull Requests section
 * hosting the SAME PullRequestView the retired standalone route used — including its linked-detail selection.
 */
const { pullRequestProps } = vi.hoisted(() => ({ pullRequestProps: [] as Array<Record<string, unknown>> }));

vi.mock("../PullRequestView", () => ({
  PullRequestView: (props: Record<string, unknown>) => {
    pullRequestProps.push(props);
    return <div data-testid="mock-pull-request-view" data-pr-id={String(props.pullRequestId)} data-project-id={String(props.projectId)} />;
  },
}));

vi.mock("../FloatingWindow", () => ({
  FloatingWindow: ({ children }: { children: React.ReactNode }) => <div data-testid="unexpected-floating-window">{children}</div>,
}));

vi.mock("../../api", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../api");
  return {
    ...actual,
    fetchGitStatus: vi.fn(async () => ({ branch: "main", ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, clean: true })),
    fetchFileChanges: vi.fn(async () => []),
    fetchGitCommits: vi.fn(async () => []),
    fetchGitBranches: vi.fn(async () => []),
    fetchWorktrees: vi.fn(async () => []),
    fetchStashes: vi.fn(async () => []),
    fetchStashRecovery: vi.fn(async () => ({ entries: [] })),
    fetchGitRemotes: vi.fn(async () => []),
    detectWorkspace: vi.fn(async () => ({ isWorkspace: false, repos: [] })),
  };
});

import { GitManagerView } from "../GitManagerView";

afterEach(() => {
  cleanup();
  pullRequestProps.length = 0;
  vi.clearAllMocks();
});

describe("GitManagerView", () => {
  it("renders Git Manager as a page with a single header and no floating window", async () => {
    render(<GitManagerView projectId="project-1" addToast={vi.fn()} />);

    expect(await screen.findByTestId("git-manager-view")).toBeInTheDocument();
    expect(screen.getByTestId("git-manager-view-title")).toHaveTextContent("Git Manager");
    expect(screen.queryByTestId("unexpected-floating-window")).not.toBeInTheDocument();
    expect(screen.getAllByRole("heading", { name: "Git Manager" })).toHaveLength(1);
  });

  it("lands on the Pull Requests section and forwards the linked pull request", async () => {
    render(<GitManagerView projectId="project-1" addToast={vi.fn()} initialSection="pull-requests" selectedPullRequestId="pr-42" />);

    const pr = await screen.findByTestId("mock-pull-request-view");
    expect(pr).toHaveAttribute("data-pr-id", "pr-42");
    expect(pr).toHaveAttribute("data-project-id", "project-1");
  });

  it("opens Pull Requests from the section nav without a linked selection", async () => {
    const user = userEvent.setup();
    render(<GitManagerView projectId="project-1" addToast={vi.fn()} />);

    await user.click(await screen.findByRole("tab", { name: "Pull Requests" }));
    await waitFor(() => expect(screen.getByTestId("mock-pull-request-view")).toBeInTheDocument());
    expect(screen.getByTestId("mock-pull-request-view")).toHaveAttribute("data-pr-id", "undefined");
  });

  it("keeps the retained Git sections reachable, including Stash Recovery", async () => {
    render(<GitManagerView projectId="project-1" addToast={vi.fn()} />);

    for (const name of ["Status", "Changes", "Commits", "Branches", "Worktrees", "Stashes", "Recovery", "Remotes", "Pull Requests"]) {
      expect(await screen.findByRole("tab", { name })).toBeInTheDocument();
    }
  });
});
