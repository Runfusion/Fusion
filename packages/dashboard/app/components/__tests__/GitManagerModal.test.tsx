import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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
} from "../../api";

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
      expect(stageFiles).toHaveBeenCalledWith(["src/app.ts"]);
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
      expect(unstageFiles).toHaveBeenCalledWith(["src/index.ts"]);
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
      expect(createCommit).toHaveBeenCalledWith("fix: update app");
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
      expect(fetchCommitDiff).toHaveBeenCalledWith("abc1234def5678");
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
      expect(createBranch).toHaveBeenCalledWith("new-feature", undefined);
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
      expect(createBranch).toHaveBeenCalledWith("hotfix", "feature");
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
      expect(checkoutBranch).toHaveBeenCalledWith("feature");
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
      expect(deleteBranch).toHaveBeenCalledWith("feature");
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
      expect(createStash).toHaveBeenCalledWith("my stash");
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
      expect(applyStash).toHaveBeenCalledWith(0, false);
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
      expect(applyStash).toHaveBeenCalledWith(0, true);
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
      expect(dropStash).toHaveBeenCalledWith(0);
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

  it("shows remote operation buttons", async () => {
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /fetch/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /pull/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /push/i })).toBeInTheDocument();
    });
  });

  it("calls fetchRemote when Fetch button clicked", async () => {
    const user = userEvent.setup();
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    const fetchButton = await screen.findByRole("button", { name: /fetch/i });
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

    const pullButton = await screen.findByRole("button", { name: /pull/i });
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

    const pushButton = await screen.findByRole("button", { name: /push/i });
    await user.click(pushButton);

    await waitFor(() => {
      expect(pushBranch).toHaveBeenCalled();
    });
  });

  it("shows error toast when fetch fails", async () => {
    const user = userEvent.setup();
    (fetchRemote as any).mockRejectedValue(new Error("Network error"));

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    const fetchButton = await screen.findByRole("button", { name: /fetch/i });
    await user.click(fetchButton);

    await waitFor(() => {
      expect(mockAddToast).toHaveBeenCalledWith("Network error", "error");
    });
  });

  it("shows ahead/behind remote indicators", async () => {
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
      expect(screen.getByText("2 commit(s) to push")).toBeInTheDocument();
      expect(screen.getByText("3 commit(s) to pull")).toBeInTheDocument();
    });
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
      expect(screen.getByText("Loading remotes...")).toBeInTheDocument();
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
      expect(screen.getByText("Add Remote")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Add Remote"));

    const nameInput = screen.getByPlaceholderText("Remote name (e.g., origin)");
    const urlInput = screen.getByPlaceholderText("Repository URL");

    await user.type(nameInput, "origin");
    await user.type(urlInput, "https://github.com/test/repo.git");

    await user.click(screen.getByRole("button", { name: /^add$/i }));

    await waitFor(() => {
      expect(addGitRemote).toHaveBeenCalledWith("origin", "https://github.com/test/repo.git");
      expect(mockAddToast).toHaveBeenCalledWith("Remote 'origin' added successfully", "success");
    });
  });

  it("shows error when adding remote fails", async () => {
    const user = userEvent.setup();
    (fetchGitRemotesDetailed as any).mockResolvedValue([]);
    (addGitRemote as any).mockRejectedValue(new Error("Remote 'origin' already exists"));

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    await waitFor(() => {
      expect(screen.getByText("Add Remote")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Add Remote"));

    const nameInput = screen.getByPlaceholderText("Remote name (e.g., origin)");
    const urlInput = screen.getByPlaceholderText("Repository URL");

    await user.type(nameInput, "origin");
    await user.type(urlInput, "https://github.com/test/repo.git");

    await user.click(screen.getByRole("button", { name: /^add$/i }));

    await waitFor(() => {
      expect(mockAddToast).toHaveBeenCalledWith("Remote 'origin' already exists", "error");
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
      expect(removeGitRemote).toHaveBeenCalledWith("origin");
      expect(mockAddToast).toHaveBeenCalledWith("Remote 'origin' removed", "success");
    });
  });

  it("renames a remote", async () => {
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
      expect(screen.getByText("origin")).toBeInTheDocument();
    });

    const renameButton = screen.getByTitle("Rename remote");
    await user.click(renameButton);

    // The input should appear - find it by its autoFocus or by looking for an input
    const nameInput = screen.getByDisplayValue("origin");
    await user.clear(nameInput);
    await user.type(nameInput, "upstream");

    const saveButton = nameInput.closest(".gm-remote-edit")?.querySelector(".btn.btn-sm.btn-primary");
    expect(saveButton).toBeTruthy();
    await user.click(saveButton as HTMLButtonElement);

    await waitFor(() => {
      expect(renameGitRemote).toHaveBeenCalledWith("origin", "upstream");
      expect(mockAddToast).toHaveBeenCalledWith("Remote renamed to 'upstream'", "success");
    });
  });

  it("updates remote URL", async () => {
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
      expect(screen.getByText("origin")).toBeInTheDocument();
    });

    const editButton = screen.getByTitle("Edit URL");
    await user.click(editButton);

    const urlInput = screen.getByDisplayValue("https://old-url.com/repo.git");
    await user.clear(urlInput);
    await user.type(urlInput, "https://new-url.com/repo.git");

    const saveButton = urlInput.closest(".gm-remote-edit")?.querySelector(".btn.btn-sm.btn-primary");
    expect(saveButton).toBeTruthy();
    await user.click(saveButton as HTMLButtonElement);

    await waitFor(() => {
      expect(updateGitRemoteUrl).toHaveBeenCalledWith("origin", "https://new-url.com/repo.git");
      expect(mockAddToast).toHaveBeenCalledWith("Remote URL updated", "success");
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
      expect(screen.getByText("No remotes configured")).toBeInTheDocument();
    });

    expect(screen.queryByTestId("remote-commits-section")).not.toBeInTheDocument();
  });

  it("highlights selected remote in the list", async () => {
    (fetchGitRemotesDetailed as any).mockResolvedValue([
      { name: "origin", fetchUrl: "https://github.com/a/b.git", pushUrl: "https://github.com/a/b.git" },
      { name: "upstream", fetchUrl: "https://github.com/c/d.git", pushUrl: "https://github.com/c/d.git" },
    ]);

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    // First remote (origin) should be auto-selected
    await waitFor(() => {
      const originItem = screen.getByText("origin").closest(".gm-remote-item");
      expect(originItem?.classList.contains("selected")).toBe(true);
    });
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
});
