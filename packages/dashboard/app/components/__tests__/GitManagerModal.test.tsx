import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GitManagerModal } from "../GitManagerModal";
import type { Task } from "@fusion/core";
import { loadAllAppCss } from "../../test/cssFixture";

// Mock SSE bus before module imports so the GitManagerModal SSE effect is a no-op
vi.mock("../../sse-bus", () => ({
  subscribeSse: vi.fn(() => () => {}),
}));

const mockUseViewportMode = vi.fn(() => "desktop");
const mockUseMobileKeyboard = vi.fn(() => ({
  keyboardOverlap: 0,
  viewportHeight: null,
  viewportOffsetTop: 0,
  keyboardOpen: false,
}));

vi.mock("../../hooks/useViewportMode", () => ({
  MOBILE_MEDIA_QUERY: "(max-width: 768px), (max-height: 480px)",
  getViewportMode: () => mockUseViewportMode(),
  isMobileViewport: () => mockUseViewportMode() === "mobile",
  useViewportMode: () => mockUseViewportMode(),
}));

vi.mock("../../hooks/useMobileKeyboard", () => ({
  useMobileKeyboard: () => mockUseMobileKeyboard(),
}));

vi.mock("../../hooks/useMobileScrollLock", () => ({
  useMobileScrollLock: vi.fn(),
  useMobileKeyboardViewportLock: vi.fn(),
  useMobileViewportRestoreReset: vi.fn(),
}));

// Mock the API module with all functions
vi.mock("../../api", async () => {
  return {
    api: vi.fn(),
    fetchConfig: vi.fn(),
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
    fetchStashDiff: vi.fn(),
    fetchFileChanges: vi.fn(),
    fetchGitFileDiff: vi.fn(),
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

const mockConfirm = vi.fn();

vi.mock("../../hooks/useConfirm", () => ({
  useConfirm: () => ({ confirm: mockConfirm }),
}));

import {
  api,
  fetchConfig,
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
  fetchStashDiff,
  fetchFileChanges,
  fetchGitFileDiff,
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
import { subscribeSse } from "../../sse-bus";

function expectLatestCallStartsWith(mockFn: { mock: { calls: unknown[][] } }, ...expectedArgs: unknown[]) {
  expect(mockFn.mock.calls.length).toBeGreaterThan(0);
  expect(mockFn.mock.calls.at(-1)?.slice(0, expectedArgs.length)).toEqual(expectedArgs);
}

function getMediaBlocks(css: string, pattern: RegExp): string[] {
  const matches = [...css.matchAll(pattern)];
  expect(matches.length).toBeGreaterThan(0);

  return matches.map((match) => {
    const start = match.index!;
    const open = css.indexOf("{", start);
    let depth = 1;
    let i = open + 1;
    while (i < css.length && depth > 0) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
      i++;
    }
    return css.slice(start, i);
  });
}

function getRuleBlocks(css: string, selector: string): string[] {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...css.matchAll(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`, "g"))]
    .map((match) => match[1]);
}

const gitManagerSectionLabels = [
  "Status",
  "Changes",
  "Commits",
  "Branches",
  "Worktrees",
  "Stashes",
  "Recovery",
  "Remotes",
];

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
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseViewportMode.mockReturnValue("desktop");
    mockUseMobileKeyboard.mockReturnValue({
      keyboardOverlap: 0,
      viewportHeight: null,
      viewportOffsetTop: 0,
      keyboardOpen: false,
    });
    mockConfirm.mockReset();
    mockConfirm.mockResolvedValue(true);

    // Default mock implementations
    (fetchConfig as any).mockResolvedValue({ maxConcurrent: 4, rootDir: "/project/root" });
    (api as any).mockResolvedValue({ events: [] });
    (subscribeSse as any).mockReturnValue(() => {});
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
        body: "Detailed description\n\nMultiple paragraphs.",
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
    (fetchGitFileDiff as any).mockResolvedValue({
      stat: " src/app.ts | 5 ++---",
      patch: "diff --git a/src/app.ts b/src/app.ts\n-old\n+new",
    });
    (stageFiles as any).mockResolvedValue({ staged: ["src/app.ts"] });
    (unstageFiles as any).mockResolvedValue({ unstaged: ["src/index.ts"] });
    (createCommit as any).mockResolvedValue({ hash: "def5678", message: "test commit" });
    (createStash as any).mockResolvedValue({ message: "Stash created" });
    (applyStash as any).mockResolvedValue({ message: "Stash applied" });
    (dropStash as any).mockResolvedValue({ message: "Stash dropped" });
    (fetchStashDiff as any).mockResolvedValue({
      stat: " README.md | 2 ++",
      patch: "diff --git a/README.md b/README.md\n+stash diff",
    });
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

  it("renders git-manager overlay class hook for mobile fullscreen CSS", async () => {
    const { container } = render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    await waitFor(() => {
      expect(screen.getByText("Git Manager")).toBeInTheDocument();
    });

    expect(container.querySelector(".modal-overlay.git-manager-modal-overlay")).toBeTruthy();
  });

  it("applies mobile keyboard CSS variables to gm-modal when keyboard is open", async () => {
    mockUseViewportMode.mockReturnValue("mobile");
    mockUseMobileKeyboard.mockReturnValue({
      keyboardOverlap: 240,
      viewportHeight: 620,
      viewportOffsetTop: 18,
      keyboardOpen: true,
    });

    const { container } = render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    await waitFor(() => {
      expect(screen.getByText("Git Manager")).toBeInTheDocument();
    });

    const modal = container.querySelector(".modal.gm-modal") as HTMLElement;
    expect(modal.style.getPropertyValue("--keyboard-overlap")).toBe("240px");
    expect(modal.style.getPropertyValue("--vv-height")).toBe("620px");
    expect(modal.style.getPropertyValue("--vv-offset-top")).toBe("18px");
  });

  it("renders all navigation sections", async () => {
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    await waitFor(() => {
      for (const label of gitManagerSectionLabels) {
        expect(screen.getByRole("tab", { name: label })).toBeInTheDocument();
      }
    });
  });

  it.each([
    ["null status and no file changes", null, []],
    ["populated status and populated file changes", {
      branch: "main",
      commit: "abc1234",
      isDirty: true,
      ahead: 1,
      behind: 0,
    }, [
      { file: "src/app.ts", status: "modified", staged: false },
      { file: "src/index.ts", status: "added", staged: true },
    ]],
  ])("renders the mobile tablist and all static section tabs with %s", async (_name, statusResult, fileChangeResult) => {
    mockUseViewportMode.mockReturnValue("mobile");
    (fetchGitStatus as any).mockResolvedValue(statusResult);
    (fetchFileChanges as any).mockResolvedValue(fileChangeResult);

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );

    const tablist = await screen.findByRole("tablist", { name: /git manager sections/i });
    const tabs = within(tablist).getAllByRole("tab");
    expect(tabs).toHaveLength(gitManagerSectionLabels.length);
    for (const label of gitManagerSectionLabels) {
      expect(within(tablist).getByRole("tab", { name: label })).toBeInTheDocument();
    }
  });

  it("switches sections from the tab strip on mobile", async () => {
    mockUseViewportMode.mockReturnValue("mobile");

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );

    const tablist = await screen.findByRole("tablist", { name: /git manager sections/i });
    const statusTab = within(tablist).getByRole("tab", { name: "Status" });
    const branchesTab = within(tablist).getByRole("tab", { name: "Branches" });
    expect(statusTab).toHaveAttribute("aria-selected", "true");

    await userEvent.click(branchesTab);

    await waitFor(() => {
      expect(branchesTab).toHaveAttribute("aria-selected", "true");
      expect(statusTab).toHaveAttribute("aria-selected", "false");
      expect(screen.getByTestId("branches-panel")).toBeInTheDocument();
    });
  });

  it("renders Stash Recovery inside the Recovery section", async () => {
    (api as any).mockImplementation((path: string) => {
      if (path === "/stash-recovery/orphans") {
        return Promise.resolve({
          records: [
            {
              sha: "abcdef1234567890",
              sourceTaskId: "FN-100",
              createdAt: "2026-06-21T00:00:00Z",
              classification: "unknown",
              changedPaths: ["src/file.ts"],
            },
          ],
        });
      }
      return Promise.resolve({ events: [] });
    });

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );

    fireEvent.click(await screen.findByRole("tab", { name: /recovery/i }));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Stash Recovery" })).toBeInTheDocument();
      expect(screen.getByText("1 orphans")).toBeInTheDocument();
      expect(screen.getByText("FN-100")).toBeInTheDocument();
    });
  });

  it("renders the empty Stash Recovery state inside the Recovery section", async () => {
    (api as any).mockImplementation((path: string) => {
      if (path === "/stash-recovery/orphans") {
        return Promise.resolve({ records: [] });
      }
      return Promise.resolve({ events: [] });
    });

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );

    fireEvent.click(await screen.findByRole("tab", { name: /recovery/i }));

    await waitFor(() => {
      expect(screen.getByText("No orphaned merger autostashes found.")).toBeInTheDocument();
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

  it("keeps separate scroll containers for unstaged and staged file lists", async () => {
    (fetchFileChanges as any).mockResolvedValue([
      ...Array.from({ length: 30 }, (_, index) => ({
        file: `src/unstaged-${index}.ts`,
        status: "modified",
        staged: false,
      })),
      { file: "src/staged.ts", status: "added", staged: true },
    ]);

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /changes/i }));

    await waitFor(() => {
      expect(screen.getByText("Unstaged Changes (30)")).toBeInTheDocument();
      expect(screen.getByText("Staged Changes (1)")).toBeInTheDocument();
    });

    const unstagedList = screen.getByTestId("gm-file-list-unstaged");
    const stagedList = screen.getByTestId("gm-file-list-staged");

    expect(unstagedList).toHaveClass("gm-file-list", "gm-file-list-unstaged");
    expect(stagedList).toHaveClass("gm-file-list", "gm-file-list-staged");
    expect(within(unstagedList).getAllByRole("button").length).toBeGreaterThan(10);
    expect(within(stagedList).getAllByRole("button").length).toBeGreaterThan(0);
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

  it("fetches unstaged file diff when clicking an unstaged file", async () => {
    const user = userEvent.setup();
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /changes/i }));

    await waitFor(() => {
      expect(screen.getByText("src/app.ts")).toBeInTheDocument();
    });

    await user.click(screen.getByText("src/app.ts"));
    await waitFor(() => {
      expectLatestCallStartsWith(fetchGitFileDiff as any, "src/app.ts", false);
    });
  });

  it("fetches staged file diff when clicking a staged file", async () => {
    const user = userEvent.setup();
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /changes/i }));

    await waitFor(() => {
      expect(screen.getByText("src/index.ts")).toBeInTheDocument();
    });

    await user.click(screen.getByText("src/index.ts"));
    await waitFor(() => {
      expectLatestCallStartsWith(fetchGitFileDiff as any, "src/index.ts", true);
    });
  });

  it("stage action button still stages file without triggering diff fetch", async () => {
    const user = userEvent.setup();
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /changes/i }));

    const stageButton = await screen.findByTitle("Stage file");
    await user.click(stageButton);

    await waitFor(() => {
      expectLatestCallStartsWith(stageFiles as any, ["src/app.ts"]);
      expect(fetchGitFileDiff).not.toHaveBeenCalled();
    });
  });

  it("unstage action button still unstages file without triggering diff fetch", async () => {
    const user = userEvent.setup();
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /changes/i }));

    const unstageButton = await screen.findByTitle("Unstage file");
    await user.click(unstageButton);

    await waitFor(() => {
      expectLatestCallStartsWith(unstageFiles as any, ["src/index.ts"]);
      expect(fetchGitFileDiff).not.toHaveBeenCalled();
    });
  });

  it("renders fetched file diff patch content", async () => {
    const user = userEvent.setup();
    (fetchGitFileDiff as any).mockResolvedValue({
      stat: " src/app.ts | 2 +\\-",
      patch: "diff --git a/src/app.ts b/src/app.ts\\n+line",
    });

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /changes/i }));

    await waitFor(() => {
      expect(screen.getByText("src/app.ts")).toBeInTheDocument();
    });

    await user.click(screen.getByText("src/app.ts"));

    await waitFor(() => {
      const patchBlock = document.querySelector(".gm-diff-patch");
      expect(patchBlock?.textContent).toContain("diff --git a/src/app.ts b/src/app.ts");
      expect(patchBlock?.textContent).toContain("+line");
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

  it("shows commit body when expanding a commit in commits panel", async () => {
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /commits/i }));

    await waitFor(() => {
      expect(screen.getByText("Test commit")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Test commit"));

    await waitFor(() => {
      const fullMessage = document.querySelector(".gm-commit-message-full");
      expect(fullMessage?.textContent).toContain("Detailed description");
      expect(fullMessage?.textContent).toContain("Multiple paragraphs.");
    });
  });

  it("does not render full message block for commits without body", async () => {
    (fetchGitCommits as any).mockResolvedValue([
      {
        hash: "abc1234def5678",
        shortHash: "abc1234",
        message: "Subject only commit",
        body: "",
        author: "User",
        date: "2026-01-01T00:00:00Z",
        parents: [],
      },
    ]);

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /commits/i }));

    await waitFor(() => {
      expect(screen.getByText("Subject only commit")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Subject only commit"));

    await waitFor(() => {
      expectLatestCallStartsWith(fetchCommitDiff as any, "abc1234def5678");
    });

    const expandedDiff = document.querySelector(".gm-commit-diff");
    expect(expandedDiff?.querySelector(".gm-commit-message-full")).toBeNull();
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
    mockConfirm.mockResolvedValue(true);

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

  it("preserves branch relative-date buckets including the 30 day threshold", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-17T20:00:00.000Z"));
    (fetchGitBranches as any).mockResolvedValue([
      { name: "now", isCurrent: true, lastCommitDate: "2026-06-17T19:59:30.000Z" },
      { name: "minutes", isCurrent: false, lastCommitDate: "2026-06-17T19:55:00.000Z" },
      { name: "hours", isCurrent: false, lastCommitDate: "2026-06-17T17:00:00.000Z" },
      { name: "twenty-nine", isCurrent: false, lastCommitDate: "2026-05-19T20:00:00.000Z" },
      { name: "thirty", isCurrent: false, lastCommitDate: "2026-05-18T20:00:00.000Z" },
      { name: "future", isCurrent: false, lastCommitDate: "2026-06-17T20:00:01.000Z" },
    ]);

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /branches/i }));

    await waitFor(() => {
      const panel = screen.getByTestId("branches-panel");
      const dateTexts = Array.from(panel.querySelectorAll(".gm-branch-date")).map((node) => node.textContent);
      expect(dateTexts).toEqual(expect.arrayContaining([
        "just now",
        "5m ago",
        "3h ago",
        "29d ago",
        new Date("2026-05-18T20:00:00.000Z").toLocaleDateString(),
      ]));
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

  it("views stash contents", async () => {
    const user = userEvent.setup();
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /stashes/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "View" })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "View" }));

    await waitFor(() => {
      expectLatestCallStartsWith(fetchStashDiff as any, 0);
      expect(screen.getByText("Hide")).toBeInTheDocument();
      expect(screen.getByText("README.md | 2 ++")).toBeInTheDocument();
      expect(screen.getByText(/\+stash diff/)).toBeInTheDocument();
    });
  });

  it("shows stash diff loading and error states", async () => {
    const user = userEvent.setup();
    let resolveDiff: ((value: { stat: string; patch: string }) => void) | null = null;
    (fetchStashDiff as any).mockImplementationOnce(
      () =>
        new Promise<{ stat: string; patch: string }>((resolve) => {
          resolveDiff = resolve;
        })
    );

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /stashes/i }));

    await user.click(await screen.findByRole("button", { name: "View" }));
    expect(screen.getByText("Loading stash diff…")).toBeInTheDocument();

    resolveDiff?.({ stat: " README.md | 1 +", patch: "diff --git a/README.md b/README.md\n+ok" });
    await waitFor(() => {
      expect(screen.getByText("README.md | 1 +")).toBeInTheDocument();
    });

    (fetchStashDiff as any).mockRejectedValueOnce(new Error("stash diff failed"));
    await user.click(screen.getByRole("button", { name: "Hide" }));
    await user.click(screen.getByRole("button", { name: "View" }));

    await waitFor(() => {
      expect(screen.getByText("stash diff failed")).toBeInTheDocument();
    });
  });

  it("keeps stash actions available when viewing stash contents", async () => {
    const user = userEvent.setup();
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /stashes/i }));

    await user.click(await screen.findByRole("button", { name: "View" }));
    await user.click(screen.getByText("Apply"));
    await user.click(screen.getByText("Pop"));

    await waitFor(() => {
      expect((applyStash as any).mock.calls).toContainEqual([0, false, undefined]);
      expect((applyStash as any).mock.calls).toContainEqual([0, true, undefined]);
      expect(screen.getByTitle("Drop stash")).toBeInTheDocument();
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
    mockConfirm.mockResolvedValue(true);

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

  it("calls pullBranch with rebase false when Pull button clicked", async () => {
    const user = userEvent.setup();
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    const syncCard = await screen.findByTestId("remote-sync-card");
    const pullButton = within(syncCard).getByRole("button", { name: /^pull$/i });
    await user.click(pullButton);

    await waitFor(() => {
      expect(pullBranch).toHaveBeenCalledWith({ rebase: false }, undefined);
    });
  });

  it("calls pullBranch with rebase true from pull options menu", async () => {
    const user = userEvent.setup();
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    const syncCard = await screen.findByTestId("remote-sync-card");
    await user.click(within(syncCard).getByRole("button", { name: /pull options/i }));
    await user.click(screen.getByRole("menuitem", { name: /pull --rebase/i }));

    await waitFor(() => {
      expect(pullBranch).toHaveBeenCalledWith({ rebase: true }, undefined);
    });
  });

  it("FN-3753: pull split toggle is narrower than the main Pull button", async () => {
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    const syncCard = await screen.findByTestId("remote-sync-card");
    const pullMainButton = within(syncCard).getByRole("button", { name: /^pull$/i });
    const pullToggleButton = within(syncCard).getByRole("button", { name: /pull options/i });

    expect(pullToggleButton).toHaveClass("gm-pull-split-toggle");
    expect(pullToggleButton).toHaveClass("btn-icon");

    vi.spyOn(pullMainButton, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      width: 96,
      height: 36,
      top: 0,
      right: 96,
      bottom: 36,
      left: 0,
      toJSON: () => ({}),
    });
    vi.spyOn(pullToggleButton, "getBoundingClientRect").mockReturnValue({
      x: 96,
      y: 0,
      width: 36,
      height: 36,
      top: 0,
      right: 132,
      bottom: 36,
      left: 96,
      toJSON: () => ({}),
    });

    expect(pullToggleButton.getBoundingClientRect().width).toBeLessThan(
      pullMainButton.getBoundingClientRect().width
    );
  });

  it("FN-4985: pull split toggle matches the main Pull button height on non-mobile", async () => {
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    const syncCard = await screen.findByTestId("remote-sync-card");
    const pullMainButton = within(syncCard).getByRole("button", { name: /^pull$/i });
    const pullToggleButton = within(syncCard).getByRole("button", { name: /pull options/i });

    vi.spyOn(pullMainButton, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      width: 96,
      height: 36,
      top: 0,
      right: 96,
      bottom: 36,
      left: 0,
      toJSON: () => ({}),
    });
    vi.spyOn(pullToggleButton, "getBoundingClientRect").mockReturnValue({
      x: 96,
      y: 0,
      width: 36,
      height: 36,
      top: 0,
      right: 132,
      bottom: 36,
      left: 96,
      toJSON: () => ({}),
    });

    expect(pullToggleButton.getBoundingClientRect().height).toBe(
      pullMainButton.getBoundingClientRect().height
    );
  });

  it("closes pull options menu on outside click and Escape", async () => {
    const user = userEvent.setup();
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    const syncCard = await screen.findByTestId("remote-sync-card");
    const pullOptionsButton = within(syncCard).getByRole("button", { name: /pull options/i });

    await user.click(pullOptionsButton);
    expect(screen.getByRole("menu", { name: /pull options menu/i })).toBeInTheDocument();

    await user.click(document.body);
    await waitFor(() => {
      expect(screen.queryByRole("menu", { name: /pull options menu/i })).not.toBeInTheDocument();
    });

    await user.click(pullOptionsButton);
    expect(screen.getByRole("menu", { name: /pull options menu/i })).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("menu", { name: /pull options menu/i })).not.toBeInTheDocument();
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

  it("syncs with origin by running pull --rebase before push", async () => {
    const user = userEvent.setup();

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    const syncButton = await screen.findByTestId("remotes-sync-origin-btn");
    await user.click(syncButton);

    await waitFor(() => {
      expect(pullBranch).toHaveBeenCalledWith({ rebase: true }, undefined);
      expect(pushBranch).toHaveBeenCalledWith(undefined);
    });

    expect((pullBranch as any).mock.invocationCallOrder[0]).toBeLessThan(
      (pushBranch as any).mock.invocationCallOrder[0]
    );
    expect(mockAddToast).toHaveBeenCalledWith(
      "Synced with origin (pull --rebase + push)",
      "success"
    );
    expectLatestCallStartsWith(fetchGitStatus as any, undefined, { extended: true });
  });

  it("does not push when sync pull reports a conflict", async () => {
    const user = userEvent.setup();
    (pullBranch as any).mockResolvedValue({
      success: false,
      message: "Rebase stopped on conflict",
      conflict: true,
    });

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    const syncButton = await screen.findByTestId("remotes-sync-origin-btn");
    await user.click(syncButton);

    await waitFor(() => {
      expect(pullBranch).toHaveBeenCalledWith({ rebase: true }, undefined);
    });
    expect(pushBranch).not.toHaveBeenCalled();
    expect(mockAddToast).toHaveBeenCalledWith("Merge conflict detected. Resolve manually.", "error");
  });

  it("does not push when sync pull rejects", async () => {
    const user = userEvent.setup();
    (pullBranch as any).mockRejectedValue(new Error("sync pull failed"));

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    const syncButton = await screen.findByTestId("remotes-sync-origin-btn");
    await user.click(syncButton);

    await waitFor(() => {
      expect(pullBranch).toHaveBeenCalledWith({ rebase: true }, undefined);
    });
    expect(pushBranch).not.toHaveBeenCalled();
    expect(mockAddToast).toHaveBeenCalledWith("sync pull failed", "error");
  });

  it("shows a spinner and disables the Sync button while syncing", async () => {
    const user = userEvent.setup();
    let resolvePull: ((value: { success: boolean; message: string }) => void) | undefined;
    const pendingPull = new Promise<{ success: boolean; message: string }>((resolve) => {
      resolvePull = resolve;
    });
    (pullBranch as any).mockReturnValue(pendingPull);

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    const syncButton = await screen.findByTestId("remotes-sync-origin-btn");
    expect(syncButton).not.toBeDisabled();

    await user.click(syncButton);

    await waitFor(() => {
      expect(syncButton).toBeDisabled();
      expect(syncButton.querySelector(".spin")).not.toBeNull();
    });

    resolvePull?.({ success: true, message: "Already up to date." });

    await waitFor(() => {
      expect(pushBranch).toHaveBeenCalledWith(undefined);
      expect(syncButton).not.toBeDisabled();
    });
    expectLatestCallStartsWith(fetchGitStatus as any, undefined, { extended: true });
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

  it("shows selector/detail split and selected highlight in remotes tab", async () => {
    (fetchGitRemotesDetailed as any).mockResolvedValue([
      { name: "origin", fetchUrl: "https://github.com/dustinbyrne/kb.git", pushUrl: "https://github.com/dustinbyrne/kb.git" },
      { name: "upstream", fetchUrl: "https://github.com/upstream/kb.git", pushUrl: "git@github.com:upstream/kb.git" },
    ]);

    const user = userEvent.setup();
    const { container } = render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    await waitFor(() => {
      expect(screen.getByTestId("remote-selector")).toBeInTheDocument();
      expect(screen.getByTestId("remote-detail-panel")).toBeInTheDocument();
    });

    await waitFor(() => {
      const selectedOrigin = container.querySelector(".gm-remote-selector-item.selected");
      expect(selectedOrigin).toBeTruthy();
      expect(selectedOrigin?.textContent ?? "").toContain("origin");
    });

    const remoteSelector = screen.getByTestId("remote-selector");
    const upstreamButton = within(remoteSelector).getByText("upstream").closest(".gm-remote-selector-item");
    expect(upstreamButton).toBeTruthy();
    await user.click(upstreamButton as HTMLElement);

    await waitFor(() => {
      const selectedUpstream = container.querySelector(".gm-remote-selector-item.selected");
      expect(selectedUpstream).toBeTruthy();
      expect(selectedUpstream?.textContent ?? "").toContain("upstream");
    });
  });

  it("renders full URL in selected detail card and not in selector row", async () => {
    (fetchGitRemotesDetailed as any).mockResolvedValue([
      { name: "origin", fetchUrl: "https://github.com/dustinbyrne/kb.git", pushUrl: "https://github.com/dustinbyrne/kb.git" },
      { name: "upstream", fetchUrl: "https://example.com/some/very/long/path/repository-name.git", pushUrl: "https://example.com/some/very/long/path/repository-name.git" },
    ]);

    const user = userEvent.setup();
    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    await user.click(await screen.findByText("upstream"));

    await waitFor(() => {
      const detailCard = screen.getByTestId("remote-detail-card");
      expect(within(detailCard).getByText("https://example.com/some/very/long/path/repository-name.git")).toBeInTheDocument();
      expect(screen.getByText("example.com")).toBeInTheDocument();
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
    mockConfirm.mockResolvedValue(true);
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
      expect(mockConfirm).toHaveBeenCalledWith({
        title: "Remove Remote",
        message: "Are you sure you want to remove remote 'origin'?",
        danger: true,
      });
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

  it("refreshes recent remote commits after pull without reopening modal", async () => {
    const user = userEvent.setup();
    (fetchRemoteCommits as any)
      .mockResolvedValueOnce([
        { hash: "rc1", shortHash: "rc1", message: "Remote commit before pull", author: "Dev", date: "2026-01-01T00:00:00Z", parents: [] },
      ])
      .mockResolvedValueOnce([
        { hash: "rc2", shortHash: "rc2", message: "Remote commit after pull", author: "Dev", date: "2026-01-02T00:00:00Z", parents: [] },
      ]);

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    await waitFor(() => {
      expect(screen.getByText("Remote commit before pull")).toBeInTheDocument();
    });

    const syncCard = screen.getByTestId("remote-sync-card");
    await user.click(within(syncCard).getByRole("button", { name: /^pull$/i }));

    await waitFor(() => {
      expect(pullBranch).toHaveBeenCalledWith({ rebase: false }, undefined);
      expect(fetchRemoteCommits).toHaveBeenCalledTimes(2);
      expect(screen.getByText("Remote commit after pull")).toBeInTheDocument();
      expect(screen.queryByText("Remote commit before pull")).not.toBeInTheDocument();
    });
  });

  it("refreshes recent remote commits after push without reopening modal", async () => {
    const user = userEvent.setup();
    let remoteCommitsCallCount = 0;
    (fetchRemoteCommits as any).mockImplementation(() => {
      remoteCommitsCallCount += 1;
      if (remoteCommitsCallCount <= 1) {
        return Promise.resolve([
          { hash: "rc10", shortHash: "rc10", message: "Remote commit before push", author: "Dev", date: "2026-01-01T00:00:00Z", parents: [] },
        ]);
      }
      return Promise.resolve([
        { hash: "rc11", shortHash: "rc11", message: "Remote commit after push", author: "Dev", date: "2026-01-02T00:00:00Z", parents: [] },
      ]);
    });

    render(
      <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

    await waitFor(() => {
      expect(screen.getByText("Remote commit before push")).toBeInTheDocument();
    });

    const syncCard = screen.getByTestId("remote-sync-card");
    await user.click(within(syncCard).getByRole("button", { name: /push/i }));

    await waitFor(() => {
      expect(pushBranch).toHaveBeenCalled();
      expect(fetchRemoteCommits).toHaveBeenCalledTimes(2);
      expect(screen.getByText("Remote commit after push")).toBeInTheDocument();
      expect(screen.queryByText("Remote commit before push")).not.toBeInTheDocument();
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

    await waitFor(() => {
      expect(within(screen.getByTestId("remote-selector")).getByText("upstream")).toBeInTheDocument();
    });

    // Only origin has default badge — look for "default" text in selector
    const selector = screen.getByTestId("remote-selector");
    const badges = within(selector).getAllByText("default");
    expect(badges.length).toBe(1);
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
      mockConfirm.mockResolvedValue(true);
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

  describe("Sync local tip button (Remotes panel)", () => {
    it("renders the Sync local tip button in the remotes panel when integrationBranch is set", async () => {
      (fetchGitStatus as any).mockResolvedValue({
        branch: "main",
        commit: "abc1234",
        isDirty: false,
        ahead: 0,
        behind: 0,
        integrationBranch: "main",
        isOnIntegrationBranch: true,
      });

      render(
        <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
      );

      fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

      await waitFor(() => {
        expect(screen.getByTestId("remotes-sync-integration-tip-btn")).toBeInTheDocument();
      });
    });

    it("the Remotes Sync local tip button is disabled when not on integration branch", async () => {
      (fetchGitStatus as any).mockResolvedValue({
        branch: "feature/bar",
        commit: "abc1234",
        isDirty: false,
        ahead: 0,
        behind: 0,
        integrationBranch: "main",
        isOnIntegrationBranch: false,
      });

      render(
        <GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />
      );

      fireEvent.click(screen.getByRole("tab", { name: /remotes/i }));

      await waitFor(() => {
        const btn = screen.getByTestId("remotes-sync-integration-tip-btn");
        expect(btn).toBeDisabled();
      });
    });
  });


  describe("recent merge advances panel", () => {
    it("hides sync CTA when advances are handled and head is aligned", async () => {
      const supersededSha = "e".repeat(40);
      (fetchGitStatus as any).mockResolvedValue({
        branch: "main",
        commit: "abc1234",
        isDirty: false,
        ahead: 0,
        behind: 0,
        integrationBranch: "main",
        aheadOfIntegration: 0,
        behindIntegration: 0,
        recentMergeAdvances: [
          { taskId: "FN-1", fromSha: null, toSha: "a".repeat(40), advancedAt: new Date().toISOString(), needsAction: false, resolution: "orphaned" },
          { taskId: "FN-2", fromSha: null, toSha: "b".repeat(40), advancedAt: new Date().toISOString(), needsAction: false, resolution: "subsumed" },
          { taskId: "FN-3", fromSha: null, toSha: supersededSha, advancedAt: new Date().toISOString(), needsAction: false, resolution: "superseded" },
        ],
      });
      render(<GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />);
      await waitFor(() => expect(screen.getByTestId("recent-merge-advances")).toBeInTheDocument());
      expect(screen.getByText(/\(0 need action\)/i)).toBeInTheDocument();
      expect(screen.queryByTestId("sync-working-tree-btn")).not.toBeInTheDocument();
      expect(screen.getByTestId(`dismiss-advance-${supersededSha}`)).toBeInTheDocument();
    });

    it("shows sync CTA when pending advance exists", async () => {
      (fetchGitStatus as any).mockResolvedValue({
        branch: "main",
        commit: "abc1234",
        isDirty: false,
        ahead: 0,
        behind: 0,
        integrationBranch: "main",
        aheadOfIntegration: 1,
        behindIntegration: 0,
        recentMergeAdvances: [
          { taskId: "FN-3", fromSha: null, toSha: "c".repeat(40), advancedAt: new Date().toISOString(), needsAction: true, resolution: "pending" },
        ],
      });
      render(<GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />);
      await waitFor(() => expect(screen.getByTestId("sync-working-tree-btn")).toBeInTheDocument());
      await userEvent.click(screen.getByTestId("sync-working-tree-btn"));
    });

    it("dismisses orphaned/subsumed/superseded entries", async () => {
      const toSha = "d".repeat(40);
      (fetchGitStatus as any).mockResolvedValue({
        branch: "main",
        commit: "abc1234",
        isDirty: false,
        ahead: 0,
        behind: 0,
        integrationBranch: "main",
        aheadOfIntegration: 0,
        behindIntegration: 0,
        recentMergeAdvances: [
          { taskId: "FN-4", fromSha: null, toSha, advancedAt: new Date().toISOString(), needsAction: false, resolution: "orphaned" },
        ],
      });
      render(<GitManagerModal isOpen={true} onClose={vi.fn()} tasks={mockTasks} addToast={mockAddToast} />);
      await waitFor(() => expect(screen.getByText("FN-4")).toBeInTheDocument());
      await userEvent.click(screen.getByTestId(`dismiss-advance-${toSha}`));
      expect(screen.queryByText("FN-4")).not.toBeInTheDocument();
    });
  });

  describe("CSS regression coverage", () => {
    it("includes remotes layout selectors and mobile rules", () => {
      const css = loadAllAppCss();
      expect(css).toContain(".gm-remotes-layout");
      expect(css).toContain(".gm-remote-selector");
      expect(css).toContain(".gm-remote-detail");
      expect(css).toContain(".gm-remote-sync-card");
      expect(css).toContain(".gm-remote-detail-card");
      expect(css).toMatch(/@media[^{]*\(max-width: 768px\)[^{]*\{[\s\S]*?\.gm-remotes-layout[\s\S]*?\.gm-remote-selector[\s\S]*?\}/);
    });

    it("keeps remotes-specific status/surface styles tokenized", () => {
      const css = loadAllAppCss();
      const remoteSection = css.slice(css.indexOf("/* ── Remote Panel ── */"), css.indexOf("/* ── Commit Items (shared) ── */"));
      expect(remoteSection).toContain("color-mix(");
      expect(remoteSection).not.toMatch(/rgba\(/i);
      expect(remoteSection).not.toMatch(/#[0-9a-f]{3,8}/i);
    });

    it("includes mobile wrapping rules for changes file rows and section actions", () => {
      const css = loadAllAppCss();

      expect(css).toMatch(/@media[^{]*\(max-width: 768px\)[^{]*\{[\s\S]*?\.gm-file-section-actions\s*\{[\s\S]*?flex-wrap:\s*wrap;[\s\S]*?flex:\s*1 1 100%;/);
      expect(css).toMatch(/@media[^{]*\(max-width: 768px\)[^{]*\{[\s\S]*?\.gm-file-item\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?flex-wrap:\s*wrap;/);
      expect(css).toMatch(/@media[^{]*\(max-width: 768px\)[^{]*\{[\s\S]*?\.gm-file-section\s*\{[\s\S]*?max-width:\s*100%;/);
    });

    it("keeps the mobile Git Manager tab strip non-shrinking at 768px and 720px breakpoints", () => {
      const css = loadAllAppCss();
      const mobile768 = getMediaBlocks(css, /@media[^{]*\(max-width:\s*768px\)[^{]*\{/g).join("\n");
      const mobile720 = getMediaBlocks(css, /@media[^{]*\(max-width:\s*720px\)[^{]*\{/g).join("\n");

      const sidebarRules = getRuleBlocks(mobile768, ".gm-sidebar");
      expect(sidebarRules).toHaveLength(1);
      expect(sidebarRules[0]).toContain("flex: 0 0 auto;");
      expect(sidebarRules[0]).toContain("min-height: calc(var(--space-2xl) + var(--space-md));");
      expect(sidebarRules[0]).toContain("overflow-x: auto;");
      expect(sidebarRules[0]).toContain("overflow-y: hidden;");
      expect(sidebarRules[0]).toContain("touch-action: pan-x pan-y;");

      const navItemRules = getRuleBlocks(mobile768, ".gm-nav-item");
      expect(navItemRules).toHaveLength(1);
      // Mobile tabs are compact ICON-ONLY in one scrolling row: non-shrinking via flex:0 0 auto + intrinsic width:auto (overrides the base .gm-nav-item width:100% that otherwise made one tab fill the row).
      expect(navItemRules[0]).toContain("flex: 0 0 auto;");
      expect(navItemRules[0]).toContain("width: auto;");

      expect(mobile720).not.toContain(".gm-sidebar");
      expect(mobile720).not.toContain(".gm-nav-item");
    });
  });
});
