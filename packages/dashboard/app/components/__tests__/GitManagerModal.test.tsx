import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GitManagerModal } from "../GitManagerModal";
import type { Task } from "@kb/core";

// Mock the API module
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
  };
});

import {
  fetchGitStatus,
  fetchGitCommits,
  fetchGitBranches,
  fetchGitWorktrees,
  createBranch,
  checkoutBranch,
  deleteBranch,
  fetchRemote,
  pullBranch,
  pushBranch,
} from "../../api";

const mockAddToast = vi.fn();

const mockTasks: Task[] = [
  { id: "KB-001", description: "Test task 1", column: "in-progress", dependencies: [], worktree: "/worktrees/kb-001" },
  { id: "KB-002", description: "Test task 2", column: "todo", dependencies: [] },
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
      { hash: "abc1234", shortHash: "abc1", message: "Test commit", author: "User", date: "2026-01-01", parents: [] },
    ]);
    (fetchGitBranches as any).mockResolvedValue([
      { name: "main", isCurrent: true, remote: "origin/main" },
      { name: "feature", isCurrent: false },
    ]);
    (fetchGitWorktrees as any).mockResolvedValue([
      { path: "/worktrees/kb-001", branch: "kb/kb-001", isMain: false, isBare: false, taskId: "KB-001" },
      { path: "/repo", branch: "main", isMain: true, isBare: false },
    ]);
  });

  it("renders nothing when not open", () => {
    const { container } = render(
      <GitManagerModal
        isOpen={false}
        onClose={vi.fn()}
        tasks={mockTasks}
        addToast={mockAddToast}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders modal when open", async () => {
    render(
      <GitManagerModal
        isOpen={true}
        onClose={vi.fn()}
        tasks={mockTasks}
        addToast={mockAddToast}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Git Manager")).toBeInTheDocument();
    });
  });

  it("fetches status on mount", async () => {
    render(
      <GitManagerModal
        isOpen={true}
        onClose={vi.fn()}
        tasks={mockTasks}
        addToast={mockAddToast}
      />
    );

    await waitFor(() => {
      expect(fetchGitStatus).toHaveBeenCalled();
    });
  });

  it("switches tabs when clicking navigation", async () => {
    render(
      <GitManagerModal
        isOpen={true}
        onClose={vi.fn()}
        tasks={mockTasks}
        addToast={mockAddToast}
      />
    );

    // Wait for initial load
    await waitFor(() => {
      expect(screen.getByText("Repository Status")).toBeInTheDocument();
    });

    // Click Commits tab
    fireEvent.click(screen.getByText("Commits"));
    await waitFor(() => {
      expect(fetchGitCommits).toHaveBeenCalled();
    });

    // Click Branches tab
    fireEvent.click(screen.getByText("Branches"));
    await waitFor(() => {
      expect(fetchGitBranches).toHaveBeenCalled();
    });
  });

  it("closes on Escape key", async () => {
    const onClose = vi.fn();
    render(
      <GitManagerModal
        isOpen={true}
        onClose={onClose}
        tasks={mockTasks}
        addToast={mockAddToast}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Git Manager")).toBeInTheDocument();
    });

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("shows status information", async () => {
    render(
      <GitManagerModal
        isOpen={true}
        onClose={vi.fn()}
        tasks={mockTasks}
        addToast={mockAddToast}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("main")).toBeInTheDocument();
      expect(screen.getByText("Clean")).toBeInTheDocument();
    });
  });

  it("loads commits and shows them", async () => {
    render(
      <GitManagerModal
        isOpen={true}
        onClose={vi.fn()}
        tasks={mockTasks}
        addToast={mockAddToast}
      />
    );

    fireEvent.click(screen.getByText("Commits"));

    await waitFor(() => {
      expect(screen.getByText("Test commit")).toBeInTheDocument();
    });
  });

  it("loads branches and shows current branch", async () => {
    render(
      <GitManagerModal
        isOpen={true}
        onClose={vi.fn()}
        tasks={mockTasks}
        addToast={mockAddToast}
      />
    );

    fireEvent.click(screen.getByText("Branches"));

    await waitFor(() => {
      expect(screen.getByText("main")).toBeInTheDocument();
      expect(screen.getByText("feature")).toBeInTheDocument();
    });
  });

  it("loads worktrees and shows task associations", async () => {
    render(
      <GitManagerModal
        isOpen={true}
        onClose={vi.fn()}
        tasks={mockTasks}
        addToast={mockAddToast}
      />
    );

    fireEvent.click(screen.getByText("Worktrees"));

    await waitFor(() => {
      expect(screen.getByText("KB-001")).toBeInTheDocument();
      expect(screen.getByText("2 total")).toBeInTheDocument();
    });
  });

  it("calls createBranch when form is submitted", async () => {
    const user = userEvent.setup();
    (createBranch as any).mockResolvedValue(undefined);

    render(
      <GitManagerModal
        isOpen={true}
        onClose={vi.fn()}
        tasks={mockTasks}
        addToast={mockAddToast}
      />
    );

    fireEvent.click(screen.getByText("Branches"));

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

  it("calls checkoutBranch when checkout button clicked", async () => {
    const user = userEvent.setup();
    (checkoutBranch as any).mockResolvedValue(undefined);

    render(
      <GitManagerModal
        isOpen={true}
        onClose={vi.fn()}
        tasks={mockTasks}
        addToast={mockAddToast}
      />
    );

    fireEvent.click(screen.getByText("Branches"));

    await waitFor(() => {
      expect(screen.getByText("feature")).toBeInTheDocument();
    });
  });

  it("shows remote operations buttons", async () => {
    render(
      <GitManagerModal
        isOpen={true}
        onClose={vi.fn()}
        tasks={mockTasks}
        addToast={mockAddToast}
      />
    );

    fireEvent.click(screen.getByText("Remotes"));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /fetch/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /pull/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /push/i })).toBeInTheDocument();
    });
  });

  it("calls fetchRemote when Fetch button clicked", async () => {
    const user = userEvent.setup();
    (fetchRemote as any).mockResolvedValue({ fetched: true, message: "Fetched" });

    render(
      <GitManagerModal
        isOpen={true}
        onClose={vi.fn()}
        tasks={mockTasks}
        addToast={mockAddToast}
      />
    );

    fireEvent.click(screen.getByText("Remotes"));

    const fetchButton = await screen.findByRole("button", { name: /fetch/i });
    await user.click(fetchButton);

    await waitFor(() => {
      expect(fetchRemote).toHaveBeenCalled();
    });
  });

  it("shows error toast when fetch fails", async () => {
    const user = userEvent.setup();
    (fetchRemote as any).mockRejectedValue(new Error("Network error"));

    render(
      <GitManagerModal
        isOpen={true}
        onClose={vi.fn()}
        tasks={mockTasks}
        addToast={mockAddToast}
      />
    );

    fireEvent.click(screen.getByText("Remotes"));

    const fetchButton = await screen.findByRole("button", { name: /fetch/i });
    await user.click(fetchButton);

    await waitFor(() => {
      expect(mockAddToast).toHaveBeenCalledWith("Network error", "error");
    });
  });

  it("shows ahead/behind indicators in status", async () => {
    (fetchGitStatus as any).mockResolvedValue({
      branch: "main",
      commit: "abc1234",
      isDirty: false,
      ahead: 2,
      behind: 3,
    });

    render(
      <GitManagerModal
        isOpen={true}
        onClose={vi.fn()}
        tasks={mockTasks}
        addToast={mockAddToast}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("2")).toBeInTheDocument();
      expect(screen.getByText("3")).toBeInTheDocument();
    });
  });
});
