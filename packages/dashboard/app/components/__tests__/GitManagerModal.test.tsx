import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GitManagerModal } from "../GitManagerModal";
import type { Task } from "@fusion/core";

// Mock the API module with all functions
vi.mock("../../api", async () => {
  return {
    fetchGitStatus: vi.fn(),
    fetchGitCommits: vi.fn(),
    fetchCommitDiff: vi.fn(),
    fetchGitBranches: vi.fn(),
    fetchGitWorktrees: vi.fn(),
    createBranch: vi.fn(),
    checkoutBranch: vi.fn(),
    deleteBranch: vi.fn(),
    fetchRemote: vi.fn(),
    pullBranch: vi.fn(),
    pushBranch: vi.fn(),
    fetchGitStashList: vi.fn(),
    createStash: vi.fn(),
    applyStash: vi.fn(),
    dropStash: vi.fn(),
    fetchFileChanges: vi.fn(),
    fetchUnstagedDiff: vi.fn(),
    stageFiles: vi.fn(),
    unstageFiles: vi.fn(),
    createCommit: vi.fn(),
    discardChanges: vi.fn(),
    fetchGitRemotesDetailed: vi.fn(),
    addGitRemote: vi.fn(),
    removeGitRemote: vi.fn(),
    renameGitRemote: vi.fn(),
    updateGitRemoteUrl: vi.fn(),
    fetchAheadCommits: vi.fn(),
    fetchRemoteCommits: vi.fn(),
    fetchBranchCommits: vi.fn(),
  };
});

import {
  fetchGitStatus,
  fetchGitCommits,
  fetchCommitDiff,
  fetchGitBranches,
  fetchGitWorktrees,
  createBranch,
  checkoutBranch,
  deleteBranch,
  fetchRemote,
  pullBranch,
  pushBranch,
  fetchGitStashList,
  createStash,
  applyStash,
  dropStash,
  fetchFileChanges,
  fetchUnstagedDiff,
  stageFiles,
  unstageFiles,
  createCommit,
  discardChanges,
  fetchGitRemotesDetailed,
  addGitRemote,
  removeGitRemote,
  renameGitRemote,
  updateGitRemoteUrl,
  fetchAheadCommits,
  fetchRemoteCommits,
  fetchBranchCommits,
} from "../../api";

function expectLatestCallStartsWith(mockFn: { mock: { calls: unknown[][] } }, ...expectedArgs: unknown[]) {
  expect(mockFn.mock.calls.length).toBeGreaterThan(0);
  expect(mockFn.mock.calls.at(-1)?.slice(0, expectedArgs.length)).toEqual(expectedArgs);
}

const mockAddToast = vi.fn();

const mockTasks: Task[] = [
  {
    id: "FN-001",
    description: "Test task 1",
    column: "in-progress",
    dependencies: [],
    worktree: "/worktrees/kb-001",
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: "FN-002",
    description: "Test task 2",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

describe("GitManagerModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock implementations
    (fetchGitStatus as any).mockResolvedValue({
      branch: "main",
      commit: "abc1234",
      isDirty: false,
      ahead: 0,
      behind: 0,
    });
    (fetchGitCommits as any).mockResolvedValue([
      {
        hash: "abc1234def5678",
        shortHash: "abc1234",
        message: "Test commit",
        author: "User",
        date: "2026-01-01T00:00:00Z",
        parents: [],
      },
    ]);
    (fetchCommitDiff as any).mockResolvedValue({
      stat: " file.ts | 2 +-",
      patch: "diff --git a/file.ts b/file.ts\n-old\n+new",
    });
    (fetchGitBranches as any).mockResolvedValue([
      { name: "main", isCurrent: true, remote: "origin/main", lastCommitDate: "2026-01-01T00:00:00Z" },
      { name: "feature", isCurrent: false, lastCommitDate: "2026-01-02T00:00:00Z" },
    ]);
    (fetchGitWorktrees as any).mockResolvedValue([
      {
        path: "/worktrees/kb-001",
        branch: "fusion/fn-001",
        isMain: false,
        isBare: false,
        taskId: "FN-001",
      },
      { path: "/repo", branch: "main", isMain: true, isBare: false },
    ]);
    (fetchGitStashList as any).mockResolvedValue([
      {
        index: 0,
        message: "WIP on main: abc1234 Test commit",
        date: "2026-01-01T00:00:00Z",
        branch: "main",
      },
    ]);
    (fetchFileChanges as any).mockResolvedValue([
      { file: "src/app.ts", status: "modified", staged: false },
      { file: "src/index.ts", status: "added", staged: true },
    ]);
    (fetchUnstagedDiff as any).mockResolvedValue({
      stat: " src/app.ts | 5 ++---",
      patch: "diff --git a/src/app.ts b/src/app.ts\n-old\n+new",
    });
    (stageFiles as any).mockResolvedValue({ staged: ["src/app.ts"] });
    (unstageFiles as any).mockResolvedValue({ unstaged: ["src/index.ts"] });
    (createCommit as any).mockResolvedValue({ hash: "def5678", message: "test commit" });
    (createStash as any).mockResolvedValue({ message: "Stash created" });
    (applyStash as any).mockResolvedValue({ message: "Stash applied" });
    (dropStash as any).mockResolvedValue({ message: "Stash dropped" });
    (discardChanges as any).mockResolvedValue({ discarded: ["src/app.ts"] });
    (createBranch as any).mockResolvedValue(undefined);
    (checkoutBranch as any).mockResolvedValue(undefined);
    (deleteBranch as any).mockResolvedValue(undefined);
    (fetchRemote as any).mockResolvedValue({ fetched: true, message: "Fetched" });
    (pullBranch as any).mockResolvedValue({ success: true, message: "Already up to date." });
    (pushBranch as any).mockResolvedValue({ success: true, message: "Push completed" });
    (fetchGitRemotesDetailed as any).mockResolvedValue([
      { name: "origin", fetchUrl: "https://github.com/dustinbyrne/kb.git", pushUrl: "https://github.com/dustinbyrne/kb.git" },
    ]);
    (addGitRemote as any).mockResolvedValue(undefined);
    (removeGitRemote as any).mockResolvedValue(undefined);
    (renameGitRemote as any).mockResolvedValue(undefined);
    (updateGitRemoteUrl as any).mockResolvedValue(undefined);
    (fetchAheadCommits as any).mockResolvedValue([]);
    (fetchRemoteCommits as any).mockResolvedValue([]);
  });

  // ── Basic Rendering ─────────────────────────────────────────

  it("renders nothing when not open", () => {
    const { container } = render(
      <GitManagerModal isOpen={false} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders modal when open", async () => {
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    await waitFor(() => {
      expect(screen.getByText("Git Manager")).toBeInTheDocument();
    });
  });

  it("renders all navigation sections", async () => {
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /status/i })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: /changes/i })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: /commits/i })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: /branches/i })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: /worktrees/i })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: /stashes/i })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: /remotes/i })).toBeInTheDocument();
    });
  });

  // ── Keyboard Navigation ─────────────────────────────────────

  it("closes on Escape key", async () => {
    const onClose = vi.fn();
    render(
      <GitManagerModal isOpen={true} onClose={onClose} tasks={mockTasks} addToast={mockAddToast} />
    );
    await waitFor(() => {
      expect(screen.getByText("Git Manager")).toBeInTheDocument();
    });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("navigates sections with Alt+Arrow keys", async () => {
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    await waitFor(() => {
      expect(screen.getByText("Repository Status")).toBeInTheDocument();
    });

    // Alt+Down should go to Changes
    fireEvent.keyDown(document, { key: "ArrowDown", altKey: true });
    await waitFor(() => {
      expect(fetchFileChanges).toHaveBeenCalled();
    });
  });

  // ── Status Panel ────────────────────────────────────────────

  it("fetches status on mount and shows data", async () => {
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    await waitFor(() => {
      expect(fetchGitStatus).toHaveBeenCalled();
      expect(screen.getByText("main")).toBeInTheDocument();
      expect(screen.getByText("Clean")).toBeInTheDocument();
    });
  });

  it("shows dirty status when working tree is modified", async () => {
    (fetchGitStatus as any).mockResolvedValue({
      branch: "main",
      commit: "abc1234",
      isDirty: true,
      ahead: 0,
      behind: 0,
    });
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    await waitFor(() => {
      expect(screen.getByText("Modified")).toBeInTheDocument();
    });
  });

  it("shows ahead/behind indicators", async () => {
    (fetchGitStatus as any).mockResolvedValue({
      branch: "main",
      commit: "abc1234",
      isDirty: false,
      ahead: 2,
      behind: 3,
    });
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    await waitFor(() => {
      expect(screen.getByText("2")).toBeInTheDocument();
      expect(screen.getByText("3")).toBeInTheDocument();
    });
  });

  it("shows up to date when in sync", async () => {
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    await waitFor(() => {
      expect(screen.getByText("Up to date")).toBeInTheDocument();
    });
  });

  // ── Tab Switching ───────────────────────────────────────────

  it("switches tabs when clicking navigation", async () => {
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    await waitFor(() => {
      expect(screen.getByText("Repository Status")).toBeInTheDocument();
    });

    // Switch to Commits
    fireEvent.click(screen.getByRole("tab", { name: /commits/i }));
    await waitFor(() => {
      expect(fetchGitCommits).toHaveBeenCalled();
    });

    // Switch to Branches
    fireEvent.click(screen.getByRole("tab", { name: /branches/i }));
    await waitFor(() => {
      expect(fetchGitBranches).toHaveBeenCalled();
    });
  });

  // ── Changes Panel ──────────────────────────────────────────

  it("shows file changes in the Changes panel", async () => {
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /changes/i }));

    await waitFor(() => {
      expect(screen.getByText("src/app.ts")).toBeInTheDocument();
      expect(screen.getByText("src/index.ts")).toBeInTheDocument();
    });
  });

  it("shows unstaged and staged file sections", async () => {
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /changes/i }));

    await waitFor(() => {
      expect(screen.getByText("Unstaged Changes (1)")).toBeInTheDocument();
      expect(screen.getByText("Staged Changes (1)")).toBeInTheDocument();
    });
  });

  it("stages all files when Stage All is clicked", async () => {
    const user = userEvent.setup();
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /changes/i }));

    await waitFor(() => {
      expect(screen.getByText("Stage All")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Stage All"));
    await waitFor(() => {
      expectLatestCallStartsWith(stageFiles as any, ["src/app.ts"]);
    });
  });

  it("unstages all files when Unstage All is clicked", async () => {
    const user = userEvent.setup();
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /changes/i }));

    await waitFor(() => {
      expect(screen.getByText("Unstage All")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Unstage All"));
    await waitFor(() => {
      expectLatestCallStartsWith(unstageFiles as any, ["src/index.ts"]);
    });
  });

  it("commits staged changes", async () => {
    const user = userEvent.setup();
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /changes/i }));

    await waitFor(() => {
      expect(screen.getByPlaceholderText("Commit message...")).toBeInTheDocument();
    });

    const textarea = screen.getByPlaceholderText("Commit message...");
    await user.type(textarea, "fix: update app");

    const commitBtn = screen.getByRole("button", { name: /^commit$/i });
    await user.click(commitBtn);

    await waitFor(() => {
      expectLatestCallStartsWith(createCommit as any, "fix: update app");
    });
  });

  it("disables Commit button when no message or no staged files", async () => {
    (fetchFileChanges as any).mockResolvedValue([
      { file: "src/app.ts", status: "modified", staged: false },
    ]);

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /changes/i }));

    await waitFor(() => {
      const commitBtn = screen.getByRole("button", { name: /^commit$/i });
      expect(commitBtn).toBeDisabled();
    });
  });

  it("views diff of unstaged changes", async () => {
    const user = userEvent.setup();
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /changes/i }));

    await waitFor(() => {
      expect(screen.getByText("View Diff")).toBeInTheDocument();
    });

    await user.click(screen.getByText("View Diff"));
    await waitFor(() => {
      expect(fetchUnstagedDiff).toHaveBeenCalled();
    });
  });

  // ── Commits Panel ──────────────────────────────────────────

  it("loads commits and shows them", async () => {
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /commits/i }));

    await waitFor(() => {
      expect(screen.getByText("Test commit")).toBeInTheDocument();
      expect(screen.getByText("abc1234")).toBeInTheDocument();
    });
  });

  it("searches commits by message", async () => {
    const user = userEvent.setup();
    (fetchGitCommits as any).mockResolvedValue([
      { hash: "abc1234", shortHash: "abc1", message: "fix bug", author: "User", date: "2026-01-01T00:00:00Z", parents: [] },
      { hash: "def5678", shortHash: "def5", message: "add feature", author: "User", date: "2026-01-02T00:00:00Z", parents: [] },
    ]);

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /commits/i }));

    await waitFor(() => {
      expect(screen.getByText("fix bug")).toBeInTheDocument();
      expect(screen.getByText("add feature")).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText("Search commits...");
    await user.type(searchInput, "fix");

    await waitFor(() => {
      expect(screen.getByText("fix bug")).toBeInTheDocument();
      expect(screen.queryByText("add feature")).not.toBeInTheDocument();
    });
  });

  it("shows merge badge for merge commits", async () => {
    (fetchGitCommits as any).mockResolvedValue([
      { hash: "abc1234", shortHash: "abc1", message: "Merge branch", author: "User", date: "2026-01-01T00:00:00Z", parents: ["111", "222"] },
    ]);

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /commits/i }));

    await waitFor(() => {
      expect(screen.getByText("merge")).toBeInTheDocument();
    });
  });

  it("shows commit diff when commit is clicked", async () => {
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /commits/i }));

    await waitFor(() => {
      expect(screen.getByText("Test commit")).toBeInTheDocument();
    });

    // Click the commit to expand diff
    fireEvent.click(screen.getByText("Test commit"));
    await waitFor(() => {
      expectLatestCallStartsWith(fetchCommitDiff as any, "abc1234def5678");
    });
  });

  // ── Branches Panel ─────────────────────────────────────────

  it("loads branches and shows current branch", async () => {
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /branches/i }));

    await waitFor(() => {
      // "feature" appears in both the branch list and the base branch dropdown
      const matches = screen.getAllByText("feature");
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("creates a new branch", async () => {
    const user = userEvent.setup();
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /branches/i }));

    await waitFor(() => {
      expect(screen.getByPlaceholderText("New branch name")).toBeInTheDocument();
    });

    const nameInput = screen.getByPlaceholderText("New branch name");
    await user.type(nameInput, "new-feature");

    const createButton = screen.getByRole("button", { name: /create/i });
    await user.click(createButton);

    await waitFor(() => {
      expectLatestCallStartsWith(createBranch as any, "new-feature", undefined);
    });
  });

  it("creates a branch from a selected base", async () => {
    const user = userEvent.setup();
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /branches/i }));

    await waitFor(() => {
      expect(screen.getByPlaceholderText("New branch name")).toBeInTheDocument();
    });

    await user.type(screen.getByPlaceholderText("New branch name"), "hotfix");

    // Select base branch from dropdown
    const select = screen.getByDisplayValue("Base: HEAD");
    await user.selectOptions(select, "feature");

    const createButton = screen.getByRole("button", { name: /create/i });
    await user.click(createButton);

    await waitFor(() => {
      expectLatestCallStartsWith(createBranch as any, "hotfix", "feature");
    });
  });

  it("filters branches by search", async () => {
    const user = userEvent.setup();
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /branches/i }));

    await waitFor(() => {
      const matches = screen.getAllByText("feature");
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });

    const searchInput = screen.getByPlaceholderText("Filter branches...");
    await user.type(searchInput, "feat");

    await waitFor(() => {
      const featureMatches = screen.getAllByText("feature");
      expect(featureMatches.length).toBeGreaterThan(0);
    });
  });

  it("calls checkoutBranch when checkout button clicked", async () => {
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /branches/i }));

    await waitFor(() => {
      const matches = screen.getAllByText("feature");
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });

    // The checkout button is associated with the "feature" branch (non-current)
    const checkoutButtons = screen.getAllByTitle("Checkout");
    expect(checkoutButtons.length).toBeGreaterThan(0);
    fireEvent.click(checkoutButtons[0]);

    await waitFor(() => {
      expectLatestCallStartsWith(checkoutBranch as any, "feature");
    });
  });

  it("calls deleteBranch when delete button clicked", async () => {
    // Mock confirm
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /branches/i }));

    await waitFor(() => {
      const matches = screen.getAllByText("feature");
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });

    const deleteButtons = screen.getAllByTitle("Delete");
    expect(deleteButtons.length).toBeGreaterThan(0);
    fireEvent.click(deleteButtons[0]);

    await waitFor(() => {
      expectLatestCallStartsWith(deleteBranch as any, "feature");
    });
  });

  // ── Branch Selection & Commits ───────────────────────────────

  it("selects a branch and fetches its commits on click", async () => {
    (fetchBranchCommits as any).mockResolvedValue([
      {
        hash: "def456789abc",
        shortHash: "def4567",
        message: "Feature commit",
        author: "Dev",
        date: "2026-03-01T00:00:00Z",
        parents: [],
      },
    ]);
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /branches/i }));

    await waitFor(() => {
      expect(screen.getByTestId("branches-panel")).toBeInTheDocument();
    });

    // Find the branch items inside the branches list
    const branchItems = screen.getByTestId("branches-panel").querySelectorAll(".gm-branch-item");
    // "feature" is the non-current branch, should be the second one
    expect(branchItems.length).toBe(2);
    fireEvent.click(branchItems[1]);

    await waitFor(() => {
      expectLatestCallStartsWith(fetchBranchCommits as any, "feature", 10);
    });

    await waitFor(() => {
      expect(screen.getByText("Feature commit")).toBeInTheDocument();
      expect(screen.getByText("def4567")).toBeInTheDocument();
    });
  });

  it("deselects a branch when clicking it again", async () => {
    (fetchBranchCommits as any).mockResolvedValue([
      {
        hash: "def456789abc",
        shortHash: "def4567",
        message: "Feature commit",
        author: "Dev",
        date: "2026-03-01T00:00:00Z",
        parents: [],
      },
    ]);
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /branches/i }));

    await waitFor(() => {
      expect(screen.getByTestId("branches-panel")).toBeInTheDocument();
    });

    const branchItems = screen.getByTestId("branches-panel").querySelectorAll(".gm-branch-item");
    fireEvent.click(branchItems[1]);

    await waitFor(() => {
      expectLatestCallStartsWith(fetchBranchCommits as any, "feature", 10);
    });

    // Click again to deselect
    fireEvent.click(branchItems[1]);

    await waitFor(() => {
      expect(screen.queryByText("Commits on feature")).not.toBeInTheDocument();
    });
  });

  it("shows loading state while fetching branch commits", async () => {
    // Make fetchBranchCommits hang (never resolve)
    (fetchBranchCommits as any).mockImplementation(() => new Promise(() => {}));
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /branches/i }));

    await waitFor(() => {
      expect(screen.getByTestId("branches-panel")).toBeInTheDocument();
    });

    const branchItems = screen.getByTestId("branches-panel").querySelectorAll(".gm-branch-item");
    fireEvent.click(branchItems[1]);

    await waitFor(() => {
      expect(screen.getByText("Loading commits...")).toBeInTheDocument();
    });
  });

  it("closes branch details via close button", async () => {
    (fetchBranchCommits as any).mockResolvedValue([
      {
        hash: "def456789abc",
        shortHash: "def4567",
        message: "Feature commit",
        author: "Dev",
        date: "2026-03-01T00:00:00Z",
        parents: [],
      },
    ]);
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /branches/i }));

    await waitFor(() => {
      expect(screen.getByTestId("branches-panel")).toBeInTheDocument();
    });

    const branchItems = screen.getByTestId("branches-panel").querySelectorAll(".gm-branch-item");
    fireEvent.click(branchItems[1]);

    await waitFor(() => {
      expect(screen.getByText("Commits on feature")).toBeInTheDocument();
    });

    // Click the close button
    const closeBtn = screen.getByTestId("close-branch-details");
    fireEvent.click(closeBtn);

    await waitFor(() => {
      expect(screen.queryByText("Commits on feature")).not.toBeInTheDocument();
    });
  });

  it("expands commit diff when clicking a commit in branch view", async () => {
    (fetchBranchCommits as any).mockResolvedValue([
      {
        hash: "def456789abc",
        shortHash: "def4567",
        message: "Feature commit",
        author: "Dev",
        date: "2026-03-01T00:00:00Z",
        parents: [],
      },
    ]);
    (fetchCommitDiff as any).mockResolvedValue({
      stat: " file.ts | 2 +-",
      patch: "diff --git a/file.ts b/file.ts\n-old\n+new",
    });
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /branches/i }));

    await waitFor(() => {
      expect(screen.getByTestId("branches-panel")).toBeInTheDocument();
    });

    const branchItems = screen.getByTestId("branches-panel").querySelectorAll(".gm-branch-item");
    fireEvent.click(branchItems[1]);

    await waitFor(() => {
      expect(screen.getByText("Feature commit")).toBeInTheDocument();
    });

    // Click on the commit to expand diff
    const commitRow = screen.getByTestId("branch-commit-def4567");
    fireEvent.click(commitRow);

    await waitFor(() => {
      expectLatestCallStartsWith(fetchCommitDiff as any, "def456789abc");
    });
  });

  it("handles fetchBranchCommits error gracefully", async () => {
    (fetchBranchCommits as any).mockRejectedValue(new Error("Network error"));
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /branches/i }));

    await waitFor(() => {
      expect(screen.getByTestId("branches-panel")).toBeInTheDocument();
    });

    const branchItems = screen.getByTestId("branches-panel").querySelectorAll(".gm-branch-item");
    fireEvent.click(branchItems[1]);

    await waitFor(() => {
      expectLatestCallStartsWith(fetchBranchCommits as any, "feature", 10);
    });

    // Should show empty state since fetch failed
    await waitFor(() => {
      expect(screen.getByText("No commits found")).toBeInTheDocument();
    });
  });

  it("shows merge badge for merge commits in branch view", async () => {
    (fetchBranchCommits as any).mockResolvedValue([
      {
        hash: "def456789abc",
        shortHash: "def4567",
        message: "Merge PR #42",
        author: "Dev",
        date: "2026-03-01T00:00:00Z",
        parents: ["abc123", "def456"],
      },
    ]);
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /branches/i }));

    await waitFor(() => {
      expect(screen.getByTestId("branches-panel")).toBeInTheDocument();
    });

    const branchItems = screen.getByTestId("branches-panel").querySelectorAll(".gm-branch-item");
    fireEvent.click(branchItems[1]);

    await waitFor(() => {
      expect(screen.getByText("merge")).toBeInTheDocument();
    });
  });

  // ── relativeDate function ──────────────────────────────────────

  it("shows em-dash for branches with empty lastCommitDate", async () => {
    (fetchGitBranches as any).mockResolvedValue([
      { name: "main", isCurrent: true, lastCommitDate: "" },
    ]);
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /branches/i }));

    // With empty lastCommitDate, the date span should not render at all
    // because the component conditionally renders only when lastCommitDate is truthy
    await waitFor(() => {
      const panel = screen.getByTestId("branches-panel");
      const branchDates = panel.querySelectorAll(".gm-branch-date");
      expect(branchDates.length).toBe(0);
    });
  });

  it("shows em-dash for branches with invalid lastCommitDate", async () => {
    (fetchGitBranches as any).mockResolvedValue([
      { name: "stale", isCurrent: true, lastCommitDate: "not-a-date" },
    ]);
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /branches/i }));

    await waitFor(() => {
      const panel = screen.getByTestId("branches-panel");
      const dateSpan = panel.querySelector(".gm-branch-date");
      expect(dateSpan).toBeTruthy();
      expect(dateSpan!.textContent).toBe("—");
    });
  });

  // ── Worktrees Panel ────────────────────────────────────────

  it("loads worktrees and shows task associations", async () => {
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /worktrees/i }));

    await waitFor(() => {
      expect(screen.getByText("FN-001")).toBeInTheDocument();
      expect(screen.getByText("2 total")).toBeInTheDocument();
      expect(screen.getByText("1 in use")).toBeInTheDocument();
    });
  });

  it("shows worktree branch and path", async () => {
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /worktrees/i }));

    await waitFor(() => {
      expect(screen.getByText("fusion/fn-001")).toBeInTheDocument();
    });
  });

  // ── Stashes Panel ──────────────────────────────────────────

  it("loads stashes and shows them", async () => {
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /stashes/i }));

    await waitFor(() => {
      expect(screen.getByText("stash@{0}")).toBeInTheDocument();
      expect(screen.getByText("WIP on main: abc1234 Test commit")).toBeInTheDocument();
    });
  });

  it("creates a stash", async () => {
    const user = userEvent.setup();
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /stashes/i }));

    await waitFor(() => {
      expect(screen.getByPlaceholderText("Stash message (optional)")).toBeInTheDocument();
    });

    await user.type(screen.getByPlaceholderText("Stash message (optional)"), "my stash");
    // The "Stash" button is the submit button in the create form
    const stashBtn = screen.getByRole("button", { name: /^stash$/i });
    await user.click(stashBtn);

    await waitFor(() => {
      expectLatestCallStartsWith(createStash as any, "my stash");
    });
  });

  it("applies a stash", async () => {
    const user = userEvent.setup();
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /stashes/i }));

    await waitFor(() => {
      expect(screen.getByText("Apply")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Apply"));
    await waitFor(() => {
      expectLatestCallStartsWith(applyStash as any, 0, false);
    });
  });

  it("pops a stash (apply and drop)", async () => {
    const user = userEvent.setup();
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /stashes/i }));

    await waitFor(() => {
      expect(screen.getByText("Pop")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Pop"));
    await waitFor(() => {
      expectLatestCallStartsWith(applyStash as any, 0, true);
    });
  });

  it("drops a stash with confirmation", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /stashes/i }));

    await waitFor(() => {
      expect(screen.getByTitle("Drop stash")).toBeInTheDocument();
    });

    await user.click(screen.getByTitle("Drop stash"));
    await waitFor(() => {
      expectLatestCallStartsWith(dropStash as any, 0);
    });
  });

  it("shows empty stash state", async () => {
    (fetchGitStashList as any).mockResolvedValue([]);

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /stashes/i }));

    await waitFor(() => {
      expect(screen.getByText("No stashes")).toBeInTheDocument();
    });
  });

  // ── Remotes Panel ──────────────────────────────────────────

  it("shows remote operation buttons in sync card", async () => {
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    await waitFor(() => {
      expect(screen.getByTestId("remote-sync-card")).toBeInTheDocument();
    });

    const syncCard = screen.getByTestId("remote-sync-card");
    expect(syncCard.textContent).toContain("Fetch");
    expect(syncCard.textContent).toContain("Pull");
    expect(syncCard.textContent).toContain("Push");
  });

  it("calls fetchRemote when Fetch button clicked", async () => {
    const user = userEvent.setup();
    (fetchGitRemotesDetailed as any).mockResolvedValue([
      { name: "origin", fetchUrl: "https://github.com/test/repo.git", pushUrl: "" },
    ]);

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    // Wait for sync card and scope button search within it to avoid matching the Refresh button
    const syncCard = await screen.findByTestId("remote-sync-card");
    const fetchButton = within(syncCard).getByRole("button", { name: /fetch/i });
    await user.click(fetchButton);

    await waitFor(() => {
      expect(fetchRemote).toHaveBeenCalled();
    });
  });

  it("calls pullBranch when Pull button clicked", async () => {
    const user = userEvent.setup();
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    // Wait for sync card and scope button search within it
    const syncCard = await screen.findByTestId("remote-sync-card");
    const pullButton = within(syncCard).getByRole("button", { name: /pull/i });
    await user.click(pullButton);

    await waitFor(() => {
      expect(pullBranch).toHaveBeenCalled();
    });
  });

  it("calls pushBranch when Push button clicked", async () => {
    const user = userEvent.setup();
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    // Wait for sync card and scope button search within it
    const syncCard = await screen.findByTestId("remote-sync-card");
    const pushButton = within(syncCard).getByRole("button", { name: /push/i });
    await user.click(pushButton);

    await waitFor(() => {
      expect(pushBranch).toHaveBeenCalled();
    });
  });

  it("shows error toast when fetch fails", async () => {
    const user = userEvent.setup();
    (fetchGitRemotesDetailed as any).mockResolvedValue([
      { name: "origin", fetchUrl: "https://github.com/test/repo.git", pushUrl: "" },
    ]);
    (fetchRemote as any).mockRejectedValue(new Error("Network error"));

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    // Wait for sync card and scope button search within it
    const syncCard = await screen.findByTestId("remote-sync-card");
    const fetchButton = within(syncCard).getByRole("button", { name: /fetch/i });
    await user.click(fetchButton);

    await waitFor(() => {
      expect(mockAddToast).toHaveBeenCalledWith("Network error", "error");
    });
  });

  it("shows ahead/behind indicators in sync card", async () => {
    (fetchGitStatus as any).mockResolvedValue({
      branch: "main",
      commit: "abc1234",
      isDirty: false,
      ahead: 2,
      behind: 3,
    });

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    await waitFor(() => {
      expect(screen.getByTestId("remote-sync-card")).toBeInTheDocument();
    });

    const syncCard = screen.getByTestId("remote-sync-card");
    expect(syncCard.textContent).toContain("2 to push");
    expect(syncCard.textContent).toContain("3 to pull");
  });

  // ── Remote Management Tests ───────────────────────────────────

  it("shows list of remotes with URLs", async () => {
    (fetchGitRemotesDetailed as any).mockResolvedValue([
      { name: "origin", fetchUrl: "https://github.com/dustinbyrne/kb.git", pushUrl: "https://github.com/dustinbyrne/kb.git" },
      { name: "upstream", fetchUrl: "https://github.com/upstream/kb.git", pushUrl: "git@github.com:upstream/kb.git" },
    ]);

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    await waitFor(() => {
      expect(screen.getByText("origin")).toBeInTheDocument();
      expect(screen.getByText("upstream")).toBeInTheDocument();
    });
  });

  it("shows loading state while fetching remotes", async () => {
    (fetchGitRemotesDetailed as any).mockReturnValue(new Promise(() => {}));

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    await waitFor(() => {
      expect(screen.getByText("Loading...")).toBeInTheDocument();
    });
  });

  it("adds a new remote successfully", async () => {
    const user = userEvent.setup();
    (fetchGitRemotesDetailed as any).mockResolvedValue([]);
    (addGitRemote as any).mockResolvedValue(undefined);

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    await waitFor(() => {
      expect(screen.getByTestId("remote-selector")).toBeInTheDocument();
    });

    await user.click(screen.getByTitle("Add Remote"));

    const nameInput = screen.getByPlaceholderText("Remote name");
    const urlInput = screen.getByPlaceholderText("Repository URL");

    await user.type(nameInput, "newremote");
    await user.type(urlInput, "https://github.com/test/repo.git");

    await user.click(screen.getByRole("button", { name: /^add$/i }));

    await waitFor(() => {
      expectLatestCallStartsWith(addGitRemote as any, "newremote", "https://github.com/test/repo.git");
      expect(mockAddToast).toHaveBeenCalledWith("Remote 'newremote' added successfully", "success");
    });
  });

  it("shows error when adding remote fails", async () => {
    const user = userEvent.setup();
    (fetchGitRemotesDetailed as any).mockResolvedValue([]);
    (addGitRemote as any).mockRejectedValue(new Error("Remote 'newremote' already exists"));

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    await waitFor(() => {
      expect(screen.getByTestId("remote-selector")).toBeInTheDocument();
    });

    await user.click(screen.getByTitle("Add Remote"));

    const nameInput = screen.getByPlaceholderText("Remote name");
    const urlInput = screen.getByPlaceholderText("Repository URL");

    await user.type(nameInput, "newremote");
    await user.type(urlInput, "https://github.com/test/repo.git");

    await user.click(screen.getByRole("button", { name: /^add$/i }));

    await waitFor(() => {
      expect(mockAddToast).toHaveBeenCalledWith("Remote 'newremote' already exists", "error");
    });
  });

  it("removes a remote with confirmation", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    (fetchGitRemotesDetailed as any).mockResolvedValue([
      { name: "origin", fetchUrl: "https://github.com/dustinbyrne/kb.git", pushUrl: "https://github.com/dustinbyrne/kb.git" },
    ]);
    (removeGitRemote as any).mockResolvedValue(undefined);

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    await waitFor(() => {
      expect(screen.getByText("origin")).toBeInTheDocument();
    });

    const removeButton = screen.getByTitle("Remove remote");
    await user.click(removeButton);

    await waitFor(() => {
      expect(window.confirm).toHaveBeenCalledWith("Are you sure you want to remove remote 'origin'?");
      expectLatestCallStartsWith(removeGitRemote as any, "origin");
      expect(mockAddToast).toHaveBeenCalledWith("Remote 'origin' removed", "success");
    });
  });

  it("renames a remote in detail panel", async () => {
    const user = userEvent.setup();
    (fetchGitRemotesDetailed as any).mockResolvedValue([
      { name: "origin", fetchUrl: "https://github.com/dustinbyrne/kb.git", pushUrl: "https://github.com/dustinbyrne/kb.git" },
    ]);
    (renameGitRemote as any).mockResolvedValue(undefined);

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    await waitFor(() => {
      expect(screen.getByTestId("remote-detail-card")).toBeInTheDocument();
    });

    const renameButton = screen.getByTitle("Edit remote name");
    await user.click(renameButton);

    const nameInput = screen.getByDisplayValue("origin");
    await user.clear(nameInput);
    await user.type(nameInput, "upstream");

    const saveButton = nameInput.closest(".gm-remote-edit")?.querySelector(".btn.btn-sm.btn-primary");
    expect(saveButton).toBeTruthy();
    await user.click(saveButton as HTMLButtonElement);

    await waitFor(() => {
      expectLatestCallStartsWith(renameGitRemote as any, "origin", "upstream");
      expect(mockAddToast).toHaveBeenCalledWith("Remote renamed to 'upstream'", "success");
    });
  });

  it("updates remote URL in detail panel", async () => {
    const user = userEvent.setup();
    (fetchGitRemotesDetailed as any).mockResolvedValue([
      { name: "origin", fetchUrl: "https://old-url.com/repo.git", pushUrl: "https://old-url.com/repo.git" },
    ]);
    (updateGitRemoteUrl as any).mockResolvedValue(undefined);

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    await waitFor(() => {
      expect(screen.getByTestId("remote-detail-card")).toBeInTheDocument();
    });

    const editButton = screen.getByTitle("Edit remote URL");
    await user.click(editButton);

    const urlInput = screen.getByDisplayValue("https://old-url.com/repo.git");
    await user.clear(urlInput);
    await user.type(urlInput, "https://new-url.com/repo.git");

    const saveButton = urlInput.closest(".gm-remote-edit")?.querySelector(".btn.btn-sm.btn-primary");
    expect(saveButton).toBeTruthy();
    await user.click(saveButton as HTMLButtonElement);

    await waitFor(() => {
      expectLatestCallStartsWith(updateGitRemoteUrl as any, "origin", "https://new-url.com/repo.git");
      expect(mockAddToast).toHaveBeenCalledWith("Remote URL updated", "success");
    });
  });

  // ── Edit Affordance Regression ──────────────────────────────────

  it("shows editor-style icon for remote name edit action in detail panel", async () => {
    (fetchGitRemotesDetailed as any).mockResolvedValue([
      { name: "origin", fetchUrl: "https://github.com/a/b.git", pushUrl: "https://github.com/a/b.git" },
    ]);

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    await waitFor(() => {
      expect(screen.getByTestId("remote-detail-card")).toBeInTheDocument();
    });

    const nameEditBtn = screen.getByTitle("Edit remote name");
    expect(nameEditBtn).toBeInTheDocument();
    expect(nameEditBtn).toBeVisible();
    fireEvent.click(nameEditBtn);
    expect(screen.getByDisplayValue("origin")).toBeInTheDocument();
  });

  it("shows editor-style icon for remote URL edit action in detail panel", async () => {
    (fetchGitRemotesDetailed as any).mockResolvedValue([
      { name: "origin", fetchUrl: "https://github.com/a/b.git", pushUrl: "https://github.com/a/b.git" },
    ]);

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    await waitFor(() => {
      expect(screen.getByTestId("remote-detail-card")).toBeInTheDocument();
    });

    const urlEditBtn = screen.getByTitle("Edit remote URL");
    expect(urlEditBtn).toBeInTheDocument();
    expect(urlEditBtn).toBeVisible();
    fireEvent.click(urlEditBtn);
    expect(screen.getByDisplayValue("https://github.com/a/b.git")).toBeInTheDocument();
  });

  it("distinguishes name edit and URL edit controls with unique titles", async () => {
    (fetchGitRemotesDetailed as any).mockResolvedValue([
      { name: "origin", fetchUrl: "https://github.com/a/b.git", pushUrl: "https://github.com/a/b.git" },
    ]);

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    // Wait for both cards to appear
    await waitFor(() => {
      expect(screen.getByTestId("remote-sync-card")).toBeInTheDocument();
      expect(screen.getByTestId("remote-detail-card")).toBeInTheDocument();
    });

    // Both edit buttons are in the detail card
    const detailCard = screen.getByTestId("remote-detail-card");
    const nameEditBtn = within(detailCard).getByTitle("Edit remote name");
    const urlEditBtn = within(detailCard).getByTitle("Edit remote URL");
    expect(nameEditBtn).not.toBe(urlEditBtn);

    fireEvent.click(nameEditBtn);
    expect(screen.getByDisplayValue("origin")).toBeInTheDocument();

    // After clicking edit, the button is replaced with input + cancel button inside .gm-remote-edit
    const cancelBtn = screen.getByTitle("Cancel");
    expect(cancelBtn).toBeTruthy();
    fireEvent.click(cancelBtn);

    fireEvent.click(urlEditBtn);
    expect(screen.getByDisplayValue("https://github.com/a/b.git")).toBeInTheDocument();
  });

  it("preserves rename API call behavior through edit affordance", async () => {
    (fetchGitRemotesDetailed as any).mockResolvedValue([
      { name: "origin", fetchUrl: "https://github.com/a/b.git", pushUrl: "https://github.com/a/b.git" },
    ]);
    (renameGitRemote as any).mockResolvedValue(undefined);

    const user = userEvent.setup();
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    await waitFor(() => {
      expect(screen.getByTestId("remote-detail-card")).toBeInTheDocument();
    });

    const nameEditBtn = screen.getByTitle("Edit remote name");
    await user.click(nameEditBtn);

    const nameInput = screen.getByDisplayValue("origin");
    await user.clear(nameInput);
    await user.type(nameInput, "upstream");

    const saveButton = nameInput.closest(".gm-remote-edit")?.querySelector(".btn.btn-sm.btn-primary");
    expect(saveButton).toBeTruthy();
    await user.click(saveButton as HTMLButtonElement);

    await waitFor(() => {
      expectLatestCallStartsWith(renameGitRemote as any, "origin", "upstream");
    });
  });

  it("preserves URL update API call behavior through edit affordance", async () => {
    (fetchGitRemotesDetailed as any).mockResolvedValue([
      { name: "origin", fetchUrl: "https://old-url.com/repo.git", pushUrl: "https://old-url.com/repo.git" },
    ]);
    (updateGitRemoteUrl as any).mockResolvedValue(undefined);

    const user = userEvent.setup();
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    await waitFor(() => {
      expect(screen.getByTestId("remote-detail-card")).toBeInTheDocument();
    });

    const urlEditBtn = screen.getByTitle("Edit remote URL");
    await user.click(urlEditBtn);

    const urlInput = screen.getByDisplayValue("https://old-url.com/repo.git");
    await user.clear(urlInput);
    await user.type(urlInput, "https://new-url.com/repo.git");

    const saveButton = urlInput.closest(".gm-remote-edit")?.querySelector(".btn.btn-sm.btn-primary");
    expect(saveButton).toBeTruthy();
    await user.click(saveButton as HTMLButtonElement);

    await waitFor(() => {
      expectLatestCallStartsWith(updateGitRemoteUrl as any, "origin", "https://new-url.com/repo.git");
    });
  });

  it("handles API errors gracefully", async () => {
    (fetchGitRemotesDetailed as any).mockRejectedValue(new Error("Failed to load remotes"));

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    await waitFor(() => {
      expect(mockAddToast).toHaveBeenCalledWith("Failed to load remotes", "error");
    });
  });

  // ── Error States ───────────────────────────────────────────

  it("shows error state when data fetch fails", async () => {
    (fetchGitStatus as any).mockRejectedValue(new Error("Connection failed"));

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );

    await waitFor(() => {
      expect(screen.getByText("Connection failed")).toBeInTheDocument();
    });
  });

  it("shows retry button on error", async () => {
    (fetchGitStatus as any).mockRejectedValue(new Error("Connection failed"));

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );

    await waitFor(() => {
      expect(screen.getByText("Retry")).toBeInTheDocument();
    });
  });

  // ── Loading States ─────────────────────────────────────────

  it("shows loading indicator while fetching data", async () => {
    // Make fetchGitStatus very slow
    (fetchGitStatus as any).mockReturnValue(new Promise(() => {}));

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );

    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  // ── Commits to Push Section ───────────────────────────────────

  it("shows commits to push section when ahead > 0", async () => {
    (fetchGitStatus as any).mockResolvedValue({
      branch: "main",
      commit: "abc1234",
      isDirty: false,
      ahead: 2,
      behind: 0,
    });
    (fetchAheadCommits as any).mockResolvedValue([
      { hash: "aaa1111", shortHash: "aaa1", message: "First ahead commit", author: "Dev", date: "2026-01-01T00:00:00Z", parents: [] },
      { hash: "bbb2222", shortHash: "bbb2", message: "Second ahead commit", author: "Dev", date: "2026-01-02T00:00:00Z", parents: [] },
    ]);

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    await waitFor(() => {
      expect(screen.getByTestId("commits-to-push")).toBeInTheDocument();
      expect(screen.getByText("First ahead commit")).toBeInTheDocument();
      expect(screen.getByText("Second ahead commit")).toBeInTheDocument();
    });
  });

  it("shows empty state when ahead > 0 but no ahead commits returned", async () => {
    (fetchGitStatus as any).mockResolvedValue({
      branch: "main",
      commit: "abc1234",
      isDirty: false,
      ahead: 1,
      behind: 0,
    });
    (fetchAheadCommits as any).mockResolvedValue([]);

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    await waitFor(() => {
      expect(screen.getByTestId("commits-to-push")).toBeInTheDocument();
      expect(screen.getByText(/No ahead commits found/)).toBeInTheDocument();
    });
  });

  it("does not show commits to push when ahead === 0", async () => {
    (fetchGitStatus as any).mockResolvedValue({
      branch: "main",
      commit: "abc1234",
      isDirty: false,
      ahead: 0,
      behind: 0,
    });

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    await waitFor(() => {
      expect(screen.getByText("origin")).toBeInTheDocument();
    });

    expect(screen.queryByTestId("commits-to-push")).not.toBeInTheDocument();
  });

  it("re-fetches ahead commits when status changes after fetch operation", async () => {
    // This test verifies the regression fix: ahead commits are re-fetched when
    // the ahead count changes after a remote action.
    //
    // Setup: mock status to go from ahead=0 → ahead=2 after fetch
    // 1st call: mount (status tab)
    // 2nd call: remotes tab load
    // 3rd call: parent's handleFetch refreshes status
    (fetchGitStatus as any)
      .mockResolvedValueOnce({
        branch: "main", commit: "abc1234", isDirty: false, ahead: 0, behind: 0,
      })
      .mockResolvedValueOnce({
        branch: "main", commit: "abc1234", isDirty: false, ahead: 0, behind: 0,
      })
      .mockResolvedValueOnce({
        branch: "main", commit: "abc1234", isDirty: false, ahead: 2, behind: 0,
      });

    // fetchAheadCommits should not be called initially (ahead=0)
    (fetchAheadCommits as any).mockResolvedValue([]);

    const user = userEvent.setup();
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );

    // Switch to remotes tab (uses 2nd mock: ahead=0)
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    await waitFor(() => {
      expect(screen.getByText("origin")).toBeInTheDocument();
    });

    // No commits-to-push section since ahead=0
    expect(screen.queryByTestId("commits-to-push")).not.toBeInTheDocument();

    // Now mock ahead commits to return data when called next
    (fetchAheadCommits as any).mockResolvedValue([
      { hash: "aaa1111", shortHash: "aaa1", message: "Ahead commit after fetch", author: "Dev", date: "2026-01-01T00:00:00Z", parents: [] },
      { hash: "bbb2222", shortHash: "bbb2", message: "Another ahead commit", author: "Dev", date: "2026-01-02T00:00:00Z", parents: [] },
    ]);

    // Click the Refresh button in the header to trigger a full status refresh
    // This causes fetchGitStatus to be called again (3rd mock: ahead=2)
    const refreshBtn = screen.getByTitle("Refresh");
    await user.click(refreshBtn);

    // After status refresh, ahead=2 triggers loadAheadCommits
    await waitFor(() => {
      expect(fetchAheadCommits).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(screen.getByTestId("commits-to-push")).toBeInTheDocument();
      expect(screen.getByText("Ahead commit after fetch")).toBeInTheDocument();
      expect(screen.getByText("Another ahead commit")).toBeInTheDocument();
    });
  });

  it("clears ahead commits after push succeeds and ahead count drops to 0", async () => {
    const user = userEvent.setup();

    // First call: initial mount (status tab)
    // Second call: switching to remotes tab — shows ahead commits
    // Third call: after push — ahead drops to 0
    (fetchGitStatus as any)
      .mockResolvedValueOnce({
        branch: "main",
        commit: "abc1234",
        isDirty: false,
        ahead: 2,
        behind: 0,
      })
      .mockResolvedValueOnce({
        branch: "main",
        commit: "abc1234",
        isDirty: false,
        ahead: 2,
        behind: 0,
      })
      .mockResolvedValueOnce({
        branch: "main",
        commit: "abc1234",
        isDirty: false,
        ahead: 0,
        behind: 0,
      });

    (fetchAheadCommits as any).mockResolvedValue([
      { hash: "aaa1111", shortHash: "aaa1", message: "First commit", author: "Dev", date: "2026-01-01T00:00:00Z", parents: [] },
      { hash: "bbb2222", shortHash: "bbb2", message: "Second commit", author: "Dev", date: "2026-01-02T00:00:00Z", parents: [] },
    ]);

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    // Initially shows commits to push
    await waitFor(() => {
      expect(screen.getByTestId("commits-to-push")).toBeInTheDocument();
    });

    // Push — parent handler refreshes status (3rd mock returns ahead: 0)
    // Use getAllByRole since "2 commit(s) to push" text also matches /push/i
    const pushButtons = screen.getAllByRole("button").filter(
      (btn) => btn.textContent?.includes("Push") && !btn.textContent?.includes("commit")
    );
    expect(pushButtons.length).toBeGreaterThan(0);
    await user.click(pushButtons[0]);

    // After push, commits-to-push section should disappear
    await waitFor(() => {
      expect(screen.queryByTestId("commits-to-push")).not.toBeInTheDocument();
    });
  });

  // ── Remote Selection & Recent Commits ──────────────────────────

  it("shows recent commits section for auto-selected remote", async () => {
    (fetchRemoteCommits as any).mockResolvedValue([
      { hash: "rc1", shortHash: "rc1", message: "Remote commit 1", author: "Dev", date: "2026-01-01T00:00:00Z", parents: [] },
    ]);

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    await waitFor(() => {
      expect(screen.getByTestId("remote-commits-section")).toBeInTheDocument();
      expect(screen.getByText("Remote commit 1")).toBeInTheDocument();
    });
  });

  it("shows empty state when remote has no commits", async () => {
    (fetchRemoteCommits as any).mockResolvedValue([]);

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    await waitFor(() => {
      expect(screen.getByText(/No commits found on origin/)).toBeInTheDocument();
    });
  });

  it("shows error state when remote commits fetch fails", async () => {
    (fetchRemoteCommits as any).mockRejectedValue(new Error("Network failure"));

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    await waitFor(() => {
      expect(screen.getByText("Network failure")).toBeInTheDocument();
    });
  });

  it("does not show remote commits section when no remotes configured", async () => {
    (fetchGitRemotesDetailed as any).mockResolvedValue([]);

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    await waitFor(() => {
      expect(screen.getByText("No remotes")).toBeInTheDocument();
    });

    expect(screen.queryByTestId("remote-commits-section")).not.toBeInTheDocument();
  });

  it("highlights selected remote in selector", async () => {
    (fetchGitRemotesDetailed as any).mockResolvedValue([
      { name: "origin", fetchUrl: "https://github.com/a/b.git", pushUrl: "https://github.com/a/b.git" },
      { name: "upstream", fetchUrl: "https://github.com/c/d.git", pushUrl: "https://github.com/c/d.git" },
    ]);

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    await waitFor(() => {
      expect(screen.getByTestId("remote-selector")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByTestId("remote-sync-card")).toBeInTheDocument();
    });

    const remoteSelector = screen.getByTestId("remote-selector");
    const selectorItems = remoteSelector.querySelectorAll(".gm-remote-selector-item");
    expect(selectorItems.length).toBe(2);
    expect(selectorItems[0].classList.contains("selected")).toBe(true);
  });

  it("shows compact remote selector with hostnames, not full URLs", async () => {
    (fetchGitRemotesDetailed as any).mockResolvedValue([
      { name: "origin", fetchUrl: "https://github.com/user/repo.git", pushUrl: "https://github.com/user/repo.git" },
    ]);

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    await waitFor(() => {
      expect(screen.getByTestId("remote-selector")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByTestId("remote-detail-card")).toBeInTheDocument();
    });

    const selector = screen.getByTestId("remote-selector");
    // Selector shows the remote name
    expect(within(selector).getByText("origin")).toBeInTheDocument();
    // Selector shows hostname, not full URL
    expect(within(selector).getByText("github.com")).toBeInTheDocument();
    // Full URL should NOT be in the selector — only in the detail card
    expect(selector.textContent).not.toContain("https://github.com/user/repo.git");
    // Full URL appears in the detail card
    expect(screen.getByTestId("remote-detail-card").textContent).toContain("https://github.com/user/repo.git");
  });

  it("shows default badge for origin remote only", async () => {
    (fetchGitRemotesDetailed as any).mockResolvedValue([
      { name: "origin", fetchUrl: "https://github.com/user/repo.git", pushUrl: "" },
      { name: "upstream", fetchUrl: "https://gitlab.com/other/repo.git", pushUrl: "" },
    ]);

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    await waitFor(() => {
      expect(screen.getByTestId("remote-selector")).toBeInTheDocument();
    });

    // Only origin has default badge — look for "default" text in selector
    const selector = screen.getByTestId("remote-selector");
    const badges = within(selector).getAllByText("default");
    expect(badges.length).toBe(1);
    expect(within(selector).getByText("upstream")).toBeInTheDocument();
  });

  it("shows full URLs and edit controls only for selected remote", async () => {
    (fetchGitRemotesDetailed as any).mockResolvedValue([
      { name: "origin", fetchUrl: "https://github.com/user/repo.git", pushUrl: "" },
      { name: "upstream", fetchUrl: "https://gitlab.com/other/repo.git", pushUrl: "" },
    ]);

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    await waitFor(() => {
      expect(screen.getByTestId("remote-detail-card")).toBeInTheDocument();
    });

    // Detail card shows full URL for auto-selected remote (origin)
    expect(screen.getByTestId("remote-detail-card").textContent).toContain("https://github.com/user/repo.git");
    // upstream URL should NOT appear in the detail card
    expect(screen.getByTestId("remote-detail-card").textContent).not.toContain("gitlab.com/other/repo.git");
    // Edit buttons are in the detail card
    expect(screen.getByTitle("Edit remote URL")).toBeInTheDocument();
  });

  it("shows placeholder in detail panel when no remote selected", async () => {
    (fetchGitRemotesDetailed as any).mockResolvedValue([
      { name: "origin", fetchUrl: "https://github.com/user/repo.git", pushUrl: "" },
    ]);

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    // Remote is auto-selected, so detail card should be visible
    await waitFor(() => {
      expect(screen.getByTestId("remote-detail-card")).toBeInTheDocument();
    });

    // When there are no remotes, the detail panel shows a placeholder
    (fetchGitRemotesDetailed as any).mockResolvedValue([]);
    // Trigger reload by switching tabs
    fireEvent.click(screen.getByRole("tab", { name: /status/i }));
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    await waitFor(() => {
      expect(screen.getByText("No remotes")).toBeInTheDocument();
    });

    // Detail panel should show empty state message
    expect(screen.getByText("Select a remote to view details")).toBeInTheDocument();
  });

  // ── Refresh Button ─────────────────────────────────────────

  it("refreshes data when refresh button is clicked", async () => {
    const user = userEvent.setup();
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );

    await waitFor(() => {
      expect(screen.getByText("Repository Status")).toBeInTheDocument();
    });

    const refreshBtn = screen.getByTitle("Refresh");
    await user.click(refreshBtn);

    // Should call fetchGitStatus again (already called once on mount)
    await waitFor(() => {
      expect(fetchGitStatus).toHaveBeenCalledTimes(2);
    });
  });

  // ── Remotes Tab: Click-to-Diff for Commits to Push ────────────

  it("expands diff when clicking a commit in Commits to Push", async () => {
    (fetchGitStatus as any).mockResolvedValue({
      branch: "main",
      commit: "abc1234",
      isDirty: false,
      ahead: 2,
      behind: 0,
    });
    (fetchAheadCommits as any).mockResolvedValue([
      { hash: "aaa1111", shortHash: "aaa1", message: "First ahead commit", author: "Dev", date: "2026-01-01T00:00:00Z", parents: [] },
      { hash: "bbb2222", shortHash: "bbb2", message: "Second ahead commit", author: "Dev", date: "2026-01-02T00:00:00Z", parents: [] },
    ]);
    (fetchCommitDiff as any).mockResolvedValue({
      stat: " file.ts | 3 ++-",
      patch: "diff --git a/file.ts b/file.ts\n-old\n+new",
    });

    const user = userEvent.setup();
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    // Wait for ahead commits to appear
    await waitFor(() => {
      expect(screen.getByTestId("commits-to-push")).toBeInTheDocument();
      expect(screen.getByText("First ahead commit")).toBeInTheDocument();
    });

    // Click on the commit to expand diff
    await user.click(screen.getByText("First ahead commit"));

    await waitFor(() => {
      expectLatestCallStartsWith(fetchCommitDiff as any, "aaa1111");
    });

    // Diff content should be rendered
    await waitFor(() => {
      expect(screen.getByText(/file\.ts \| 3/)).toBeInTheDocument();
      expect(screen.getByText(/-old/)).toBeInTheDocument();
      expect(screen.getByText(/\+new/)).toBeInTheDocument();
    });
  });

  it("collapses diff when clicking same ahead commit again", async () => {
    (fetchGitStatus as any).mockResolvedValue({
      branch: "main",
      commit: "abc1234",
      isDirty: false,
      ahead: 1,
      behind: 0,
    });
    (fetchAheadCommits as any).mockResolvedValue([
      { hash: "aaa1111", shortHash: "aaa1", message: "Toggle commit", author: "Dev", date: "2026-01-01T00:00:00Z", parents: [] },
    ]);
    (fetchCommitDiff as any).mockResolvedValue({
      stat: " file.ts | 1 +",
      patch: "diff --git a/file.ts\n+line",
    });

    const user = userEvent.setup();
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    await waitFor(() => {
      expect(screen.getByText("Toggle commit")).toBeInTheDocument();
    });

    // Click to expand
    await user.click(screen.getByText("Toggle commit"));
    await waitFor(() => {
      expectLatestCallStartsWith(fetchCommitDiff as any, "aaa1111");
    });

    // Diff should be visible
    await waitFor(() => {
      expect(screen.getByText(/file\.ts \| 1/)).toBeInTheDocument();
    });

    // Click again to collapse (use first match — the compact header is the clickable element)
    await user.click(screen.getAllByText("Toggle commit")[0]);

    // Diff content should be gone
    await waitFor(() => {
      expect(screen.queryByText(/file\.ts \| 1/)).not.toBeInTheDocument();
    });
  });

  it("shows error state when diff fetch fails for ahead commit", async () => {
    (fetchGitStatus as any).mockResolvedValue({
      branch: "main",
      commit: "abc1234",
      isDirty: false,
      ahead: 1,
      behind: 0,
    });
    (fetchAheadCommits as any).mockResolvedValue([
      { hash: "aaa1111", shortHash: "aaa1", message: "Error commit", author: "Dev", date: "2026-01-01T00:00:00Z", parents: [] },
    ]);
    (fetchCommitDiff as any).mockRejectedValue(new Error("Diff load failed"));

    const user = userEvent.setup();
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    await waitFor(() => {
      expect(screen.getByText("Error commit")).toBeInTheDocument();
    });

    // Click to expand
    await user.click(screen.getByText("Error commit"));

    // Should show error fallback
    await waitFor(() => {
      expect(screen.getByText("Failed to load diff")).toBeInTheDocument();
    });
  });

  // ── Remotes Tab: Click-to-Diff for Remote Commits ─────────────

  it("expands diff when clicking a commit in remote commits section", async () => {
    (fetchRemoteCommits as any).mockResolvedValue([
      { hash: "rc1hash1", shortHash: "rc1", message: "Remote commit 1", author: "Dev", date: "2026-01-01T00:00:00Z", parents: [] },
      { hash: "rc2hash2", shortHash: "rc2", message: "Remote commit 2", author: "Dev", date: "2026-01-02T00:00:00Z", parents: [] },
    ]);
    (fetchCommitDiff as any).mockResolvedValue({
      stat: " src/app.ts | 5 ++---",
      patch: "diff --git a/src/app.ts\n-old line\n+new line",
    });

    const user = userEvent.setup();
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    // Wait for remote commits to appear
    await waitFor(() => {
      expect(screen.getByTestId("remote-commits-section")).toBeInTheDocument();
      expect(screen.getByText("Remote commit 1")).toBeInTheDocument();
    });

    // Click on the remote commit to expand diff
    await user.click(screen.getByText("Remote commit 1"));

    await waitFor(() => {
      expectLatestCallStartsWith(fetchCommitDiff as any, "rc1hash1");
    });

    // Diff content should be rendered
    await waitFor(() => {
      expect(screen.getByText(/src\/app\.ts \| 5/)).toBeInTheDocument();
    });
  });

  it("collapses diff when clicking same remote commit again", async () => {
    (fetchRemoteCommits as any).mockResolvedValue([
      { hash: "rc1hash1", shortHash: "rc1", message: "Remote toggle commit", author: "Dev", date: "2026-01-01T00:00:00Z", parents: [] },
    ]);
    (fetchCommitDiff as any).mockResolvedValue({
      stat: " file.ts | 2 +",
      patch: "diff --git a/file.ts\n+line",
    });

    const user = userEvent.setup();
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    await waitFor(() => {
      expect(screen.getByText("Remote toggle commit")).toBeInTheDocument();
    });

    // Click to expand
    await user.click(screen.getByText("Remote toggle commit"));
    await waitFor(() => {
      expectLatestCallStartsWith(fetchCommitDiff as any, "rc1hash1");
    });

    // Diff should be visible
    await waitFor(() => {
      expect(screen.getByText(/file\.ts \| 2/)).toBeInTheDocument();
    });

    // Click again to collapse (use first match — the compact header is the clickable element)
    await user.click(screen.getAllByText("Remote toggle commit")[0]);

    // Diff content should be gone
    await waitFor(() => {
      expect(screen.queryByText(/file\.ts \| 2/)).not.toBeInTheDocument();
    });
  });

  it("shows error state when diff fetch fails for remote commit", async () => {
    (fetchRemoteCommits as any).mockResolvedValue([
      { hash: "rc1hash1", shortHash: "rc1", message: "Error remote commit", author: "Dev", date: "2026-01-01T00:00:00Z", parents: [] },
    ]);
    (fetchCommitDiff as any).mockRejectedValue(new Error("Diff load failed"));

    const user = userEvent.setup();
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    await waitFor(() => {
      expect(screen.getByText("Error remote commit")).toBeInTheDocument();
    });

    // Click to expand
    await user.click(screen.getByText("Error remote commit"));

    // Should show error fallback
    await waitFor(() => {
      expect(screen.getByText("Failed to load diff")).toBeInTheDocument();
    });
  });

  it("only expands one diff at a time in remote commits list", async () => {
    (fetchRemoteCommits as any).mockResolvedValue([
      { hash: "rc1hash1", shortHash: "rc1", message: "First remote", author: "Dev", date: "2026-01-01T00:00:00Z", parents: [] },
      { hash: "rc2hash2", shortHash: "rc2", message: "Second remote", author: "Dev", date: "2026-01-02T00:00:00Z", parents: [] },
    ]);
    (fetchCommitDiff as any).mockResolvedValue({
      stat: " file.ts | 1 +",
      patch: "diff --git a/file.ts\n+line",
    });

    const user = userEvent.setup();
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    await waitFor(() => {
      expect(screen.getByText("First remote")).toBeInTheDocument();
      expect(screen.getByText("Second remote")).toBeInTheDocument();
    });

    // Click first commit
    await user.click(screen.getByText("First remote"));
    await waitFor(() => {
      expectLatestCallStartsWith(fetchCommitDiff as any, "rc1hash1");
    });

    // Click second commit — should collapse first, expand second
    await user.click(screen.getByText("Second remote"));
    await waitFor(() => {
      expectLatestCallStartsWith(fetchCommitDiff as any, "rc2hash2");
    });

    // fetchCommitDiff should have been called for both commits
    expect(fetchCommitDiff).toHaveBeenCalledTimes(2);
  });

  // ── projectId Propagation ───────────────────────────────────────

  describe("projectId propagation", () => {
    it("passes projectId to fetchGitRemotesDetailed when remotes tab loads", async () => {
      render(
        <GitManagerModal
          isOpen={true}
          onClose={vi.fn()}
          tasks={mockTasks}
          addToast={mockAddToast}
          projectId="proj-abc"
        />
      );
      fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

      await waitFor(() => {
        expect(fetchGitRemotesDetailed).toHaveBeenCalledWith("proj-abc");
      });
    });

    it("passes projectId to fetchRemote when Fetch is clicked", async () => {
      const user = userEvent.setup();
      // Ensure remotes are available for selection
      (fetchGitRemotesDetailed as any).mockResolvedValue([
        { name: "origin", fetchUrl: "https://github.com/dustinbyrne/kb.git", pushUrl: "https://github.com/dustinbyrne/kb.git" },
      ]);
      render(
        <GitManagerModal
          isOpen={true}
          onClose={vi.fn()}
          tasks={mockTasks}
          addToast={mockAddToast}
          projectId="proj-abc"
        />
      );
      fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

      // Wait for the sync card to appear (indicates remote is selected)
      const syncCard = await screen.findByTestId("remote-sync-card");

      // Scope button search within the sync card to avoid matching the Refresh button
      const fetchButton = within(syncCard).getByRole("button", { name: /fetch/i });
      await user.click(fetchButton);

      await waitFor(() => {
        expectLatestCallStartsWith(fetchRemote as any, undefined, "proj-abc");
      });
    });

    it("passes projectId to fetchAheadCommits when ahead commits are loaded", async () => {
      // Mock status with ahead > 0 to trigger loadAheadCommits
      (fetchGitStatus as any).mockResolvedValue({
        branch: "main",
        commit: "abc1234",
        isDirty: false,
        ahead: 2,
        behind: 0,
      });
      (fetchAheadCommits as any).mockResolvedValue([
        {
          hash: "aaa1111",
          shortHash: "aaa1",
          message: "Ahead commit 1",
          author: "Dev",
          date: "2026-01-01T00:00:00Z",
          parents: [],
        },
      ]);

      render(
        <GitManagerModal
          isOpen={true}
          onClose={vi.fn()}
          tasks={mockTasks}
          addToast={mockAddToast}
          projectId="proj-abc"
        />
      );
      fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

      await waitFor(() => {
        expect(fetchAheadCommits).toHaveBeenCalledWith("proj-abc");
      });
    });

    it("passes projectId to fetchRemoteCommits when remote commits are loaded", async () => {
      (fetchRemoteCommits as any).mockResolvedValue([
        {
          hash: "rc1",
          shortHash: "rc1",
          message: "Remote commit 1",
          author: "Dev",
          date: "2026-01-01T00:00:00Z",
          parents: [],
        },
      ]);

      render(
        <GitManagerModal
          isOpen={true}
          onClose={vi.fn()}
          tasks={mockTasks}
          addToast={mockAddToast}
          projectId="proj-abc"
        />
      );
      fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

      await waitFor(() => {
        expect(fetchRemoteCommits).toHaveBeenCalledWith("origin", undefined, 10, "proj-abc");
      });
    });

    it("passes projectId to addGitRemote when adding a new remote", async () => {
      const user = userEvent.setup();
      (fetchGitRemotesDetailed as any).mockResolvedValue([]);
      (addGitRemote as any).mockResolvedValue(undefined);

      render(
        <GitManagerModal
          isOpen={true}
          onClose={vi.fn()}
          tasks={mockTasks}
          addToast={mockAddToast}
          projectId="proj-abc"
        />
      );
      fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

      await waitFor(() => {
        expect(screen.getByTitle("Add Remote")).toBeInTheDocument();
      });

      await user.click(screen.getByTitle("Add Remote"));

      const nameInput = screen.getByPlaceholderText("Remote name");
      const urlInput = screen.getByPlaceholderText("Repository URL");

      await user.type(nameInput, "newremote");
      await user.type(urlInput, "https://github.com/test/repo.git");

      await user.click(screen.getByRole("button", { name: /^add$/i }));

      await waitFor(() => {
        expect(addGitRemote).toHaveBeenCalledWith("newremote", "https://github.com/test/repo.git", "proj-abc");
      });
    });

    it("passes projectId to removeGitRemote when removing a remote", async () => {
      const user = userEvent.setup();
      vi.spyOn(window, "confirm").mockReturnValue(true);
      (fetchGitRemotesDetailed as any).mockResolvedValue([
        {
          name: "origin",
          fetchUrl: "https://github.com/dustinbyrne/kb.git",
          pushUrl: "https://github.com/dustinbyrne/kb.git",
        },
      ]);
      (removeGitRemote as any).mockResolvedValue(undefined);

      render(
        <GitManagerModal
          isOpen={true}
          onClose={vi.fn()}
          tasks={mockTasks}
          addToast={mockAddToast}
          projectId="proj-abc"
        />
      );
      fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

      await waitFor(() => {
        expect(screen.getByText("origin")).toBeInTheDocument();
      });

      const removeButton = screen.getByTitle("Remove remote");
      await user.click(removeButton);

      await waitFor(() => {
        expect(removeGitRemote).toHaveBeenCalledWith("origin", "proj-abc");
      });
    });

    it("passes projectId to renameGitRemote when renaming a remote", async () => {
      const user = userEvent.setup();
      (fetchGitRemotesDetailed as any).mockResolvedValue([
        {
          name: "origin",
          fetchUrl: "https://github.com/dustinbyrne/kb.git",
          pushUrl: "https://github.com/dustinbyrne/kb.git",
        },
      ]);
      (renameGitRemote as any).mockResolvedValue(undefined);

      render(
        <GitManagerModal
          isOpen={true}
          onClose={vi.fn()}
          tasks={mockTasks}
          addToast={mockAddToast}
          projectId="proj-abc"
        />
      );
      fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

      await waitFor(() => {
        expect(screen.getByTestId("remote-detail-card")).toBeInTheDocument();
      });

      const detailCard = screen.getByTestId("remote-detail-card");
      const renameButton = within(detailCard).getByTitle("Edit remote name");
      await user.click(renameButton);

      const nameInput = screen.getByDisplayValue("origin");
      await user.clear(nameInput);
      await user.type(nameInput, "upstream");

      const saveButton = nameInput.closest(".gm-remote-edit")?.querySelector(".btn.btn-sm.btn-primary");
      expect(saveButton).toBeTruthy();
      await user.click(saveButton as HTMLButtonElement);

      await waitFor(() => {
        expect(renameGitRemote).toHaveBeenCalledWith("origin", "upstream", "proj-abc");
      });
    });

    it("passes projectId to updateGitRemoteUrl when updating remote URL", async () => {
      const user = userEvent.setup();
      (fetchGitRemotesDetailed as any).mockResolvedValue([
        {
          name: "origin",
          fetchUrl: "https://old-url.com/repo.git",
          pushUrl: "https://old-url.com/repo.git",
        },
      ]);
      (updateGitRemoteUrl as any).mockResolvedValue(undefined);

      render(
        <GitManagerModal
          isOpen={true}
          onClose={vi.fn()}
          tasks={mockTasks}
          addToast={mockAddToast}
          projectId="proj-abc"
        />
      );
      fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

      await waitFor(() => {
        expect(screen.getByTestId("remote-detail-card")).toBeInTheDocument();
      });

      const editButton = screen.getByTitle("Edit remote URL");
      await user.click(editButton);

      const urlInput = screen.getByDisplayValue("https://old-url.com/repo.git");
      await user.clear(urlInput);
      await user.type(urlInput, "https://new-url.com/repo.git");

      const saveButton = urlInput.closest(".gm-remote-edit")?.querySelector(".btn.btn-sm.btn-primary");
      expect(saveButton).toBeTruthy();
      await user.click(saveButton as HTMLButtonElement);

      await waitFor(() => {
        expect(updateGitRemoteUrl).toHaveBeenCalledWith("origin", "https://new-url.com/repo.git", "proj-abc");
      });
    });
  });
});
