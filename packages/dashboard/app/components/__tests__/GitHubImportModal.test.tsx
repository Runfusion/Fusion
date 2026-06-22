import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { GitHubImportModal } from "../GitHubImportModal";
import {
  apiFetchGitHubIssues,
  apiImportGitHubIssue,
  apiFetchGitHubPulls,
  apiFetchGitHubPullDetail,
  apiImportGitHubPull,
  fetchGitRemotes,
} from "../../api";
import type { Task } from "@fusion/core";
import type { GitRemote } from "../../api";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Mock the API module
vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    apiFetchGitHubIssues: vi.fn(),
    apiImportGitHubIssue: vi.fn(),
    apiFetchGitHubPulls: vi.fn(),
    apiFetchGitHubPullDetail: vi.fn(),
    apiImportGitHubPull: vi.fn(),
    fetchGitRemotes: vi.fn(),
  };
});

const mockTask: Task = {
  id: "FN-001",
  title: "Test Issue",
  description: "Test body\n\nSource: https://github.com/owner/repo/issues/1",
  column: "triage",
  dependencies: [],
  steps: [],
  currentStep: 0,
  log: [],
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

const mockPRTask: Task = {
  id: "FN-002",
  title: "Review PR #1: Test PR",
  description: "Review and address any issues in this pull request.\n\nPR: https://github.com/owner/repo/pull/1\nBranch: feature → main\n\nPR body",
  column: "triage",
  dependencies: [],
  steps: [],
  currentStep: 0,
  log: [],
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

const singleRemote: GitRemote[] = [
  { name: "origin", owner: "dustinbyrne", repo: "kb", url: "https://github.com/dustinbyrne/kb.git" },
];

const multipleRemotes: GitRemote[] = [
  { name: "origin", owner: "dustinbyrne", repo: "kb", url: "https://github.com/dustinbyrne/kb.git" },
  { name: "upstream", owner: "upstream", repo: "kb", url: "https://github.com/upstream/kb.git" },
];

const multipleRemotesWithoutOrigin: GitRemote[] = [
  { name: "upstream", owner: "upstream", repo: "kb", url: "https://github.com/upstream/kb.git" },
  { name: "fork", owner: "dustinbyrne", repo: "kb", url: "https://github.com/dustinbyrne/kb.git" },
];

const mockPulls = [
  { number: 1, title: "Test PR", body: "PR body", html_url: "https://github.com/owner/repo/pull/1", headBranch: "feature", baseBranch: "main" },
  { number: 2, title: "Another PR", body: "Another PR body", html_url: "https://github.com/owner/repo/pull/2", headBranch: "bugfix", baseBranch: "main" },
];

describe("GitHubImportModal", () => {
  const onClose = vi.fn();
  const onImport = vi.fn();

  it("uses color-mix tokens for focus and selection surfaces", () => {
    const source = readFileSync(resolve(__dirname, "../GitHubImportModal.css"), "utf8");
    expect(source).not.toContain("rgba(var(--color-primary-rgb)");
    expect(source).not.toContain("rgba(var(--in-progress-rgb)");
    expect(source).toContain("color-mix(in srgb, var(--in-progress) 12%, transparent)");
    expect(source).toContain("Some hardcoded colors below");
  });

  it("keeps mobile preview content vertically scrollable inside the active pane", () => {
    const source = readFileSync(resolve(__dirname, "../GitHubImportModal.css"), "utf8");
    expect(source).toContain(".github-import-preview-pane.mobile.active {\n    display: flex;\n    flex: 1;\n    min-height: 0;\n    max-height: none;\n    overflow: hidden;");
    expect(source).toContain(".github-import-preview-pane.mobile.active .github-import-pane-content {\n    flex: 1;\n    min-height: 0;\n    overflow-y: auto;\n    overscroll-behavior: contain;");
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchGitRemotes).mockReset();
    vi.mocked(apiFetchGitHubIssues).mockReset();
    vi.mocked(apiImportGitHubIssue).mockReset();
    vi.mocked(apiFetchGitHubPulls).mockReset();
    vi.mocked(apiFetchGitHubPullDetail).mockReset();
    vi.mocked(apiImportGitHubPull).mockReset();
    // Set default mock for apiFetchGitHubIssues to return empty array (prevents undefined issues state)
    vi.mocked(apiFetchGitHubIssues).mockResolvedValue([]);
    vi.mocked(apiFetchGitHubPulls).mockResolvedValue([]);
    vi.mocked(apiFetchGitHubPullDetail).mockResolvedValue({ comments: [], checks: [] });
    onClose.mockReset();
    onImport.mockReset();
  });

  it("renders when isOpen is true", async () => {
    vi.mocked(fetchGitRemotes).mockResolvedValueOnce([]);
    render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

    await waitFor(() => {
      expect(screen.getByText("Import from GitHub")).toBeTruthy();
    });
  });

  it("does not render when isOpen is false", () => {
    render(<GitHubImportModal isOpen={false} onClose={onClose} onImport={onImport} tasks={[]} />);
    expect(screen.queryByText("Import from GitHub")).toBeNull();
  });

  // FNXC:EmbeddedPresentation 2026-06-22-12:00:
  // presentation="embedded" was a zero-coverage branch. Assert the embedded contract via useEmbeddedPresentation:
  // embedded root class present, no fixed .modal-overlay backdrop, no close button, and Escape does NOT dismiss.
  describe("embedded presentation", () => {
    it("renders the embedded root class with no modal overlay or close button", async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce([]);
      const { container } = render(
        <GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} presentation="embedded" />,
      );

      await waitFor(() => {
        expect(screen.getByText("Import Tasks")).toBeTruthy();
      });
      expect(container.querySelector(".github-import-embedded")).not.toBeNull();
      expect(container.querySelector(".github-import-modal--embedded")).not.toBeNull();
      // No fixed full-screen overlay backdrop, and no modal-header / close button in embedded mode.
      expect(container.querySelector(".modal-overlay")).toBeNull();
      expect(screen.queryByText("Import from GitHub")).toBeNull();
      expect(container.querySelector(".github-import-modal__header")).toBeNull();
    });

    it("does not dismiss on Escape in embedded mode", async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce([]);
      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} presentation="embedded" />);

      await waitFor(() => {
        expect(screen.getByText("Import Tasks")).toBeTruthy();
      });
      fireEvent.keyDown(document, { key: "Escape" });
      expect(onClose).not.toHaveBeenCalled();
    });

    it("keeps the modal overlay and Escape-to-close in modal mode", async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce([]);
      const { container } = render(
        <GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />,
      );

      await waitFor(() => {
        expect(screen.getByText("Import from GitHub")).toBeTruthy();
      });
      expect(container.querySelector(".modal-overlay")).not.toBeNull();
      expect(container.querySelector(".github-import-modal--embedded")).toBeNull();
      fireEvent.keyDown(document, { key: "Escape" });
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("renders compact toolbar and two-pane layout", async () => {
    vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
    render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

    await waitFor(() => {
      // Toolbar should be present
      expect(screen.getByTestId("github-import-toolbar")).toBeTruthy();
      // Two panes should be present
      expect(screen.getByTestId("github-import-list-pane")).toBeTruthy();
      expect(screen.getByTestId("github-import-preview-pane")).toBeTruthy();
      // Pane headings
      expect(screen.getByRole("heading", { name: "Issues" })).toBeTruthy();
      expect(screen.getByRole("heading", { name: "Preview" })).toBeTruthy();
    });

    expect(screen.getByTestId("github-import-results-idle")).toBeTruthy();
    expect(screen.getByTestId("github-import-preview-empty")).toBeTruthy();
  });

  it("shows compact toolbar with remote, filter, and load button", async () => {
    vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
    render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

    await waitFor(() => {
      const toolbar = screen.getByTestId("github-import-toolbar");
      expect(toolbar).toBeTruthy();
      // Remote pill should be in toolbar
      expect(within(toolbar).getByTestId("github-import-single-remote")).toBeTruthy();
      // Filter input
      expect(within(toolbar).getByPlaceholderText(/Filter:/)).toBeTruthy();
      // Load button
      expect(within(toolbar).getByRole("button", { name: /Load/i })).toBeTruthy();
    });
  });

  it("displays two-pane layout on desktop after loading issues", async () => {
    const issues = [
      { number: 1, title: "First Issue", body: "Body 1", html_url: "https://github.com/owner/repo/issues/1", labels: [] },
    ];
    vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
    vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce(issues);

    render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

    await waitFor(() => {
      expect(screen.getByTestId("github-import-list-pane")).toBeTruthy();
      expect(screen.getByTestId("github-import-preview-pane")).toBeTruthy();
      expect(screen.getByText("First Issue")).toBeTruthy();
    });
  });

  it("preview pane shows selected issue details", async () => {
    const issues = [
      { number: 1, title: "First Issue", body: "Body 1", html_url: "https://github.com/owner/repo/issues/1", labels: [] },
    ];
    vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
    vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce(issues);

    render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

    await waitFor(() => {
      expect(screen.getByText("First Issue")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("radio", { name: /Select issue #1/i }));

    const previewCard = await screen.findByTestId("github-import-preview-card");
    expect(within(previewCard).getByText("First Issue")).toBeTruthy();
    expect(within(previewCard).getByText("Body 1")).toBeTruthy();
    expect(screen.queryByTestId("github-import-preview-empty")).toBeNull();
  });

  it("preserves the no-description fallback for empty and null issue bodies", async () => {
    const issues = [
      { number: 1, title: "Empty Issue", body: "", html_url: "https://github.com/owner/repo/issues/1", labels: [] },
      { number: 2, title: "Null Issue", body: null, html_url: "https://github.com/owner/repo/issues/2", labels: [] },
    ];
    vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
    vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce(issues);

    render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

    await waitFor(() => {
      expect(screen.getByText("Empty Issue")).toBeTruthy();
      expect(screen.getByText("Null Issue")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("radio", { name: /Select issue #1/i }));
    let previewCard = await screen.findByTestId("github-import-preview-card");
    expect(within(previewCard).getByText("(no description)")).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: /Select issue #2/i }));
    previewCard = await screen.findByTestId("github-import-preview-card");
    expect(within(previewCard).getByText("(no description)")).toBeTruthy();
  });

  it("has optional labels input with filter placeholder", async () => {
    vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
    render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Filter:/)).toBeTruthy();
    });
  });

  describe("with no remotes", () => {
    it("shows 'No GitHub remotes detected' message", async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce([]);
      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      await waitFor(() => {
        expect(screen.getByText(/No GitHub remotes detected/)).toBeTruthy();
      });
    });

    it("disables Load button when no remotes available", async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce([]);
      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      await waitFor(() => {
        expect(screen.getByText(/No GitHub remotes detected/)).toBeTruthy();
      });

      const loadButton = screen.getByRole("button", { name: /Load issues/i }) as HTMLButtonElement;
      expect(loadButton.disabled).toBe(true);
    });
  });

  describe("with single remote", () => {
    it("loads remotes using the active project id", async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} projectId="project-1" />);

      await waitFor(() => {
        expect(fetchGitRemotes).toHaveBeenCalledWith("project-1");
      });
    });

    it("ignores stale remote responses after the active project changes", async () => {
      const projectARemote: GitRemote[] = [
        { name: "origin", owner: "project-a", repo: "old-repo", url: "https://github.com/project-a/old-repo.git" },
      ];
      const projectBRemote: GitRemote[] = [
        { name: "origin", owner: "project-b", repo: "new-repo", url: "https://github.com/project-b/new-repo.git" },
      ];
      let resolveProjectA!: (value: GitRemote[]) => void;
      let resolveProjectB!: (value: GitRemote[]) => void;
      vi.mocked(fetchGitRemotes)
        .mockImplementationOnce(() => new Promise((resolve) => {
          resolveProjectA = resolve;
        }))
        .mockImplementationOnce(() => new Promise((resolve) => {
          resolveProjectB = resolve;
        }));

      const { rerender } = render(
        <GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} projectId="project-a" />,
      );

      await waitFor(() => {
        expect(fetchGitRemotes).toHaveBeenCalledWith("project-a");
      });

      rerender(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} projectId="project-b" />);

      await waitFor(() => {
        expect(fetchGitRemotes).toHaveBeenCalledWith("project-b");
      });

      await act(async () => {
        resolveProjectB(projectBRemote);
      });

      await waitFor(() => {
        expect(screen.getByText("project-b/new-repo")).toBeTruthy();
      });

      await act(async () => {
        resolveProjectA(projectARemote);
      });

      await waitFor(() => {
        expect(screen.getByText("project-b/new-repo")).toBeTruthy();
        expect(screen.queryByText("project-a/old-repo")).toBeNull();
      });
    });

    it("auto-selects the remote and shows compact pill", async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      await waitFor(() => {
        const remoteCard = screen.getByTestId("github-import-single-remote");
        expect(within(remoteCard).getByText(/origin/i)).toBeTruthy();
        expect(within(remoteCard).getByText("dustinbyrne/kb")).toBeTruthy();
      });
    });

    it("does not show a dropdown", async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      await waitFor(() => {
        expect(screen.queryByRole("combobox")).toBeNull();
      });
    });

    it("enables Load button when remote is auto-selected", async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
      // Mock empty response so loading finishes quickly
      vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce([]);

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      // Wait for auto-load to complete (issues appear or empty state shows)
      await waitFor(() => {
        const resultsSection = screen.queryByText(/No open issues found/) || screen.queryByTestId("github-import-results-idle");
        expect(resultsSection).toBeTruthy();
      });

      await waitFor(() => {
        const loadButton = screen.getByRole("button", { name: /Load issues/i }) as HTMLButtonElement;
        expect(loadButton.disabled).toBe(false);
      });
    });

    it("auto-loads issues when single remote is detected", async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
      vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce([
        { number: 1, title: "Auto-loaded Issue", body: "Body", html_url: "https://github.com/dustinbyrne/kb/issues/1", labels: [] },
      ]);

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      await waitFor(() => {
        expect(apiFetchGitHubIssues).toHaveBeenCalledWith("dustinbyrne", "kb", 30, undefined);
      });

      expect(screen.getByText("Auto-loaded Issue")).toBeTruthy();
    });
  });

  describe("with multiple remotes", () => {
    it("shows a dropdown with all remotes", async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(multipleRemotes);
      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      await waitFor(() => {
        expect(screen.getByRole("combobox")).toBeTruthy();
      });
    });

    it("dropdown has placeholder and all remote options", async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(multipleRemotes);
      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      await waitFor(() => {
        const select = screen.getByRole("combobox") as HTMLSelectElement;
        const options = Array.from(select.options).map((option) => option.text);
        expect(options).toContain("Select remote…");
        expect(options).toContain("origin (dustinbyrne/kb)");
        expect(options).toContain("upstream (upstream/kb)");
      });
    });

    it("defaults to origin and auto-loads when multiple remotes include origin", async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(multipleRemotes);
      vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce([
        { number: 1, title: "Auto-loaded from origin", body: "", html_url: "https://github.com/dustinbyrne/kb/issues/1", labels: [] },
      ]);

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      await waitFor(() => {
        const select = screen.getByRole("combobox") as HTMLSelectElement;
        expect(select.value).toBe("origin");
        expect(apiFetchGitHubIssues).toHaveBeenCalledWith("dustinbyrne", "kb", 30, undefined);
        expect(screen.getByText("Auto-loaded from origin")).toBeTruthy();
      });

      const loadButton = screen.getByRole("button", { name: /Load issues/i }) as HTMLButtonElement;
      expect(loadButton.disabled).toBe(false);
    });

    it("keeps placeholder selected and does not auto-load when multiple remotes omit origin", async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(multipleRemotesWithoutOrigin);
      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      await waitFor(() => {
        const select = screen.getByRole("combobox") as HTMLSelectElement;
        expect(select.value).toBe("");
      });

      const loadButton = screen.getByRole("button", { name: /Load issues/i }) as HTMLButtonElement;
      expect(loadButton.disabled).toBe(true);
      expect(apiFetchGitHubIssues).not.toHaveBeenCalled();
    });

    it("switches owner/repo and auto-loads when changing remote selection", async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(multipleRemotes);
      vi.mocked(apiFetchGitHubIssues)
        .mockResolvedValueOnce([{ number: 1, title: "Issue from origin", body: "", html_url: "https://github.com/dustinbyrne/kb/issues/1", labels: [] }])
        .mockResolvedValueOnce([{ number: 2, title: "Issue from upstream", body: "", html_url: "https://github.com/upstream/kb/issues/2", labels: [] }]);

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      await waitFor(() => {
        const select = screen.getByRole("combobox") as HTMLSelectElement;
        expect(select.value).toBe("origin");
        expect(apiFetchGitHubIssues).toHaveBeenCalledWith("dustinbyrne", "kb", 30, undefined);
        expect(screen.getByText("Issue from origin")).toBeTruthy();
      });

      fireEvent.change(screen.getByRole("combobox"), { target: { value: "upstream" } });

      await waitFor(() => {
        expect(apiFetchGitHubIssues).toHaveBeenLastCalledWith("upstream", "kb", 30, undefined);
        expect(screen.getByText("Issue from upstream")).toBeTruthy();
      });
    });
  });

  describe("issue loading and import", () => {
    it("displays auto-loaded issues for single remote", async () => {
      const issues = [
        { number: 1, title: "First Issue", body: "Body 1", html_url: "https://github.com/owner/repo/issues/1", labels: [] },
        { number: 2, title: "Second Issue", body: "Body 2", html_url: "https://github.com/owner/repo/issues/2", labels: [] },
      ];
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
      vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce(issues);

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      await waitFor(() => {
        expect(screen.getByText("First Issue")).toBeTruthy();
        expect(screen.getByText("Second Issue")).toBeTruthy();
      });
    });

    it("disables Import button when no issue is selected", async () => {
      const issues = [
        { number: 1, title: "First Issue", body: "Body 1", html_url: "https://github.com/owner/repo/issues/1", labels: [] },
      ];
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
      vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce(issues);

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      await waitFor(() => {
        expect(screen.getByText("First Issue")).toBeTruthy();
      });

      const importButton = screen.getByRole("button", { name: /Import$/i }) as HTMLButtonElement;
      expect(importButton.disabled).toBe(true);
    });

    it("calls apiImportGitHubIssue and onImport when Import is clicked", async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
      vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce([
        { number: 1, title: "First Issue", body: "Body 1", html_url: "https://github.com/owner/repo/issues/1", labels: [] },
      ]);
      vi.mocked(apiImportGitHubIssue).mockResolvedValueOnce(mockTask);

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} projectId="project-1" />);

      await waitFor(() => {
        expect(screen.getByText("First Issue")).toBeTruthy();
      });

      fireEvent.click(screen.getByRole("radio", { name: /Select issue #1/i }));
      fireEvent.click(screen.getByRole("button", { name: /Import$/i }));

      await waitFor(() => {
        expect(apiImportGitHubIssue).toHaveBeenCalledWith("dustinbyrne", "kb", 1, "project-1");
        expect(onImport).toHaveBeenCalledWith(mockTask);
        expect(onClose).not.toHaveBeenCalled();
        expect(screen.getByText("Import from GitHub")).toBeTruthy();
      });
    });

    it("stays open and resets selection after successful issue import", async () => {
      const issues = [
        { number: 1, title: "First Issue", body: "Body 1", html_url: "https://github.com/owner/repo/issues/1", labels: [] },
      ];
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce([{ name: "origin", owner: "owner", repo: "repo", url: "" }]);
      vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce(issues);
      vi.mocked(apiImportGitHubIssue).mockResolvedValueOnce(mockTask);

      const { rerender } = render(
        <GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} projectId="project-1" />,
      );

      await waitFor(() => {
        expect(screen.getByText("First Issue")).toBeTruthy();
      });

      const importButton = screen.getByRole("button", { name: /Import$/i }) as HTMLButtonElement;
      fireEvent.click(screen.getByRole("radio", { name: /Select issue #1/i }));
      expect(importButton.disabled).toBe(false);

      fireEvent.click(importButton);

      await waitFor(() => {
        expect(apiImportGitHubIssue).toHaveBeenCalledWith("owner", "repo", 1, "project-1");
        expect(onClose).not.toHaveBeenCalled();
      });

      await waitFor(() => {
        expect((screen.getByRole("button", { name: /Import$/i }) as HTMLButtonElement).disabled).toBe(true);
      });

      rerender(
        <GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[mockTask]} projectId="project-1" />,
      );

      await waitFor(() => {
        expect(screen.getByText("First Issue")).toBeTruthy();
        expect(screen.getByText("Imported")).toBeTruthy();
      });
    });

    it("shows 'Imported' badge for already imported issues", async () => {
      const existingTask: Task = {
        ...mockTask,
        description: "Existing\n\nSource: https://github.com/owner/repo/issues/1",
      };
      const issues = [
        { number: 1, title: "First Issue", body: "Body 1", html_url: "https://github.com/owner/repo/issues/1", labels: [] },
      ];
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce([{ name: "origin", owner: "owner", repo: "repo", url: "" }]);
      vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce(issues);

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[existingTask]} />);

      await waitFor(() => {
        expect(screen.getByText("Imported")).toBeTruthy();
      });
    });

    it("disables radio buttons for already imported issues", async () => {
      const existingTask: Task = {
        ...mockTask,
        description: "Existing\n\nSource: https://github.com/owner/repo/issues/1",
      };
      const issues = [
        { number: 1, title: "First Issue", body: "Body 1", html_url: "https://github.com/owner/repo/issues/1", labels: [] },
      ];
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce([{ name: "origin", owner: "owner", repo: "repo", url: "" }]);
      vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce(issues);

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[existingTask]} />);

      await waitFor(() => {
        const radio = screen.getByRole("radio", { name: /Select issue #1/i }) as HTMLInputElement;
        expect(radio.disabled).toBe(true);
      });
    });

    it("renders the empty results state when GitHub returns no open issues", async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
      vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce([]);

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      await waitFor(() => {
        expect(screen.getByText("No open issues found")).toBeTruthy();
        expect(screen.getByText(/Try a different label filter/)).toBeTruthy();
      });
    });

    it("displays error state on fetch failure", async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
      vi.mocked(apiFetchGitHubIssues).mockRejectedValueOnce(new Error("Repository not found"));

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      await waitFor(() => {
        expect(screen.getByText("Could not load issues")).toBeTruthy();
        expect(screen.getByText("Repository not found")).toBeTruthy();
      });
    });

    it("displays label chips for issues with labels", async () => {
      const issues = [
        { number: 1, title: "Bug Issue", body: "Body", html_url: "https://github.com/owner/repo/issues/1", labels: [{ name: "bug" }, { name: "urgent" }] },
      ];
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
      vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce(issues);

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      await waitFor(() => {
        expect(screen.getByText("bug")).toBeTruthy();
        expect(screen.getByText("urgent")).toBeTruthy();
      });
    });

    it("re-fetches issues when Load is clicked with different labels", async () => {
      // Set up mocks - first for auto-load, second for manual refresh
      vi.mocked(apiFetchGitHubIssues)
        .mockResolvedValueOnce([{ number: 1, title: "Issue without labels", body: "", html_url: "https://github.com/dustinbyrne/kb/issues/1", labels: [] }])
        .mockResolvedValueOnce([{ number: 2, title: "Bug issue", body: "", html_url: "https://github.com/dustinbyrne/kb/issues/2", labels: [{ name: "bug" }] }]);

      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      // Wait for initial auto-load without labels
      await waitFor(() => {
        expect(apiFetchGitHubIssues).toHaveBeenCalledWith("dustinbyrne", "kb", 30, undefined);
        expect(screen.getByText("Issue without labels")).toBeTruthy();
      });

      // Enter label filter
      const labelsInput = screen.getByPlaceholderText(/Filter:/);
      fireEvent.change(labelsInput, { target: { value: "bug" } });

      // Find and click the Load button by id (more reliable)
      const loadButton = screen.getByTestId("github-import-toolbar").querySelector("#gh-load") as HTMLButtonElement;
      fireEvent.click(loadButton);

      // Verify re-fetch with labels
      await waitFor(() => {
        expect(apiFetchGitHubIssues).toHaveBeenLastCalledWith("dustinbyrne", "kb", 30, ["bug"]);
        expect(screen.getByText("Bug issue")).toBeTruthy();
      });
    });
  });

  describe("mobile responsive view", () => {
    const originalInnerWidth = window.innerWidth;

    afterEach(() => {
      // Restore window width
      Object.defineProperty(window, "innerWidth", {
        writable: true,
        configurable: true,
        value: originalInnerWidth,
      });
      window.dispatchEvent(new Event("resize"));
    });

    it("defaults to origin and auto-loads on mobile", async () => {
      Object.defineProperty(window, "innerWidth", {
        writable: true,
        configurable: true,
        value: 640,
      });
      window.dispatchEvent(new Event("resize"));

      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(multipleRemotes);
      vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce([
        { number: 1, title: "Mobile origin issue", body: "", html_url: "https://github.com/dustinbyrne/kb/issues/1", labels: [] },
      ]);

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      await waitFor(() => {
        const select = screen.getByRole("combobox") as HTMLSelectElement;
        expect(select.value).toBe("origin");
        expect(apiFetchGitHubIssues).toHaveBeenCalledWith("dustinbyrne", "kb", 30, undefined);
        expect(screen.getByText("Mobile origin issue")).toBeTruthy();
      });

      expect(screen.getByTestId("github-import-list-pane").classList.contains("mobile")).toBe(true);
    });

    it("shows back button in preview header when on mobile", async () => {
      // Set mobile viewport
      Object.defineProperty(window, "innerWidth", {
        writable: true,
        configurable: true,
        value: 480,
      });

      const issues = [
        { number: 1, title: "First Issue", body: "Body 1", html_url: "https://github.com/owner/repo/issues/1", labels: [] },
      ];
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
      vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce(issues);

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      await waitFor(() => {
        expect(screen.getByText("First Issue")).toBeTruthy();
      });

      // Select an issue
      fireEvent.click(screen.getByRole("radio", { name: /Select issue #1/i }));

      // Back button should be visible
      await waitFor(() => {
        expect(screen.getByTestId("github-import-back-button")).toBeTruthy();
      });
    });

    it("mobile back button returns to list view", async () => {
      // Set mobile viewport
      Object.defineProperty(window, "innerWidth", {
        writable: true,
        configurable: true,
        value: 480,
      });

      const issues = [
        { number: 1, title: "First Issue", body: "Body 1", html_url: "https://github.com/owner/repo/issues/1", labels: [] },
      ];
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
      vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce(issues);

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      await waitFor(() => {
        expect(screen.getByText("First Issue")).toBeTruthy();
      });

      // Select an issue to show preview
      fireEvent.click(screen.getByRole("radio", { name: /Select issue #1/i }));

      // Wait for preview to show
      await waitFor(() => {
        expect(screen.getByTestId("github-import-back-button")).toBeTruthy();
      });

      // Click back button
      fireEvent.click(screen.getByTestId("github-import-back-button"));

      // Preview pane should be hidden (back button won't be visible in list view)
      // The back button is still in DOM but hidden via CSS - check that preview pane doesn't have 'active' class
      const previewPane = screen.getByTestId("github-import-preview-pane");
      expect(previewPane.classList.contains("active")).toBe(false);
    });

    it("renders long selected issue body in full on mobile without a truncation ellipsis", async () => {
      Object.defineProperty(window, "innerWidth", {
        writable: true,
        configurable: true,
        value: 480,
      });

      const beyondPreviousCutoff = "visible body text after the old cutoff";
      const longBody = `${"A".repeat(210)} ${beyondPreviousCutoff}`;
      const issues = [
        { number: 1, title: "Long Issue", body: longBody, html_url: "https://github.com/owner/repo/issues/1", labels: [] },
      ];
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
      vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce(issues);

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      await waitFor(() => {
        expect(screen.getByText("Long Issue")).toBeTruthy();
      });

      fireEvent.click(screen.getByRole("radio", { name: /Select issue #1/i }));

      const previewPane = screen.getByTestId("github-import-preview-pane");
      await waitFor(() => {
        expect(previewPane.classList.contains("active")).toBe(true);
      });

      const previewCard = await screen.findByTestId("github-import-preview-card");
      expect(within(previewCard).getByText((content) => content.includes(beyondPreviousCutoff))).toBeTruthy();
      expect(previewCard.textContent).toContain(longBody);
      expect(previewCard.textContent).not.toContain(`${"A".repeat(200)}…`);
    });

    it("renders long selected pull request body in full on mobile without a truncation ellipsis", async () => {
      Object.defineProperty(window, "innerWidth", {
        writable: true,
        configurable: true,
        value: 480,
      });

      const beyondPreviousCutoff = "visible pull request body text after the old cutoff";
      const longBody = `${"P".repeat(210)} ${beyondPreviousCutoff}`;
      const pulls = [
        { number: 1, title: "Long PR", body: longBody, html_url: "https://github.com/owner/repo/pull/1", headBranch: "feature", baseBranch: "main" },
      ];
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
      vi.mocked(apiFetchGitHubPulls).mockResolvedValueOnce(pulls);

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      fireEvent.click(await screen.findByRole("tab", { name: /Pull Requests/i }));

      await waitFor(() => {
        expect(screen.getByText("Long PR")).toBeTruthy();
      });

      fireEvent.click(screen.getByRole("radio", { name: /Select pull request #1/i }));

      const previewPane = screen.getByTestId("github-import-preview-pane");
      await waitFor(() => {
        expect(previewPane.classList.contains("active")).toBe(true);
      });

      const previewCard = await screen.findByTestId("github-import-preview-card");
      expect(within(previewCard).getByText((content) => content.includes(beyondPreviousCutoff))).toBeTruthy();
      expect(previewCard.textContent).toContain(longBody);
      expect(previewCard.textContent).not.toContain(`${"P".repeat(200)}…`);
    });

    // FNXC:GitHubImport 2026-06-23-01:00: Selecting a PR fetches its detail and renders the full comment thread + per-check status below the body, scoped to PRs (issues unchanged).
    it("renders the selected PR's checks and comments from the detail fetch", async () => {
      Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 1200 });

      const pulls = [
        { number: 7, title: "Detail PR", body: "PR body text", html_url: "https://github.com/owner/repo/pull/7", headBranch: "feature", baseBranch: "main" },
      ];
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
      vi.mocked(apiFetchGitHubPulls).mockResolvedValueOnce(pulls);
      vi.mocked(apiFetchGitHubPullDetail).mockResolvedValueOnce({
        comments: [
          { author: "alice", body: "First comment from alice", createdAt: "2024-01-01T00:00:00Z" },
          { author: "bob", body: "Second comment from bob", createdAt: "2024-01-02T00:00:00Z" },
        ],
        checks: [
          { name: "build", status: "completed", conclusion: "success" },
          { name: "lint", status: "completed", conclusion: "failure" },
        ],
      });

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      fireEvent.click(await screen.findByRole("tab", { name: /Pull Requests/i }));
      await waitFor(() => {
        expect(screen.getByText("Detail PR")).toBeTruthy();
      });

      fireEvent.click(screen.getByRole("radio", { name: /Select pull request #7/i }));

      // Detail fetch is scoped to the selected PR by "owner/repo" + number.
      await waitFor(() => {
        expect(vi.mocked(apiFetchGitHubPullDetail)).toHaveBeenCalledWith("dustinbyrne/kb", 7);
      });

      const checks = await screen.findByTestId("github-import-pr-checks");
      const comments = await screen.findByTestId("github-import-pr-comments");

      // Body still renders immediately, independent of detail.
      expect(screen.getByTestId("github-import-preview-body").textContent).toContain("PR body text");

      // Per-check status surfaces both name and conclusion.
      await waitFor(() => {
        expect(checks.textContent).toContain("build");
        expect(checks.textContent).toContain("success");
        expect(checks.textContent).toContain("lint");
        expect(checks.textContent).toContain("failure");
      });
      // Failed check gets the failure pill variant.
      expect(checks.querySelector(".github-import-pr-check-pill--failure")).toBeTruthy();
      expect(checks.querySelector(".github-import-pr-check-pill--success")).toBeTruthy();

      // Full comment thread renders, chronological, with authors + bodies.
      expect(comments.textContent).toContain("alice");
      expect(comments.textContent).toContain("First comment from alice");
      expect(comments.textContent).toContain("bob");
      expect(comments.textContent).toContain("Second comment from bob");
    });

    // FNXC:GitHubImport 2026-06-23-01:00: Empty detail shows the "No checks"/"No comments" empty states.
    it("shows empty states when the selected PR has no checks or comments", async () => {
      Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 1200 });

      const pulls = [
        { number: 9, title: "Bare PR", body: "Bare body", html_url: "https://github.com/owner/repo/pull/9", headBranch: "feature", baseBranch: "main" },
      ];
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
      vi.mocked(apiFetchGitHubPulls).mockResolvedValueOnce(pulls);
      vi.mocked(apiFetchGitHubPullDetail).mockResolvedValueOnce({ comments: [], checks: [] });

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      fireEvent.click(await screen.findByRole("tab", { name: /Pull Requests/i }));
      await waitFor(() => {
        expect(screen.getByText("Bare PR")).toBeTruthy();
      });

      fireEvent.click(screen.getByRole("radio", { name: /Select pull request #9/i }));

      expect(await screen.findByTestId("github-import-pr-checks-empty")).toBeTruthy();
      expect(await screen.findByTestId("github-import-pr-comments-empty")).toBeTruthy();
    });

    // FNXC:GitHubImport 2026-06-22-18:30: Desktop preview must show the FULL issue/PR body (no 200-char clamp). The list response already carries the complete body, so no detail fetch is needed.
    it("renders long selected issue body in full on desktop without a truncation ellipsis", async () => {
      Object.defineProperty(window, "innerWidth", {
        writable: true,
        configurable: true,
        value: 1200,
      });

      const beyondDesktopCutoff = "desktop issue text after the cutoff";
      const longBody = `${"I".repeat(210)} ${beyondDesktopCutoff}`;
      const issues = [
        { number: 1, title: "Long Desktop Issue", body: longBody, html_url: "https://github.com/owner/repo/issues/1", labels: [] },
      ];
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
      vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce(issues);

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      await waitFor(() => {
        expect(screen.getByText("Long Desktop Issue")).toBeTruthy();
      });

      fireEvent.click(screen.getByRole("radio", { name: /Select issue #1/i }));

      const previewCard = await screen.findByTestId("github-import-preview-card");
      expect(previewCard.textContent).toContain(longBody);
      expect(previewCard.textContent).toContain(beyondDesktopCutoff);
      expect(previewCard.textContent).not.toContain(`${"I".repeat(200)}…`);
      // Body renders as markdown via the shared MailboxMessageContent surface.
      expect(screen.getByTestId("github-import-preview-body")).toBeTruthy();
    });

    it("renders long selected pull request body in full on desktop without a truncation ellipsis", async () => {
      Object.defineProperty(window, "innerWidth", {
        writable: true,
        configurable: true,
        value: 1200,
      });

      const beyondDesktopCutoff = "desktop pull request text after the cutoff";
      const longBody = `${"R".repeat(210)} ${beyondDesktopCutoff}`;
      const pulls = [
        { number: 1, title: "Long Desktop PR", body: longBody, html_url: "https://github.com/owner/repo/pull/1", headBranch: "feature", baseBranch: "main" },
      ];
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
      vi.mocked(apiFetchGitHubPulls).mockResolvedValueOnce(pulls);

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      fireEvent.click(await screen.findByRole("tab", { name: /Pull Requests/i }));

      await waitFor(() => {
        expect(screen.getByText("Long Desktop PR")).toBeTruthy();
      });

      fireEvent.click(screen.getByRole("radio", { name: /Select pull request #1/i }));

      const previewCard = await screen.findByTestId("github-import-preview-card");
      expect(previewCard.textContent).toContain(longBody);
      expect(previewCard.textContent).toContain(beyondDesktopCutoff);
      expect(previewCard.textContent).not.toContain(`${"R".repeat(200)}…`);
      expect(screen.getByTestId("github-import-preview-body")).toBeTruthy();
    });

    // FNXC:GitHubImport 2026-06-22-18:30: Full-issue preview must surface key metadata (state, author, GitHub URL) alongside the full markdown body.
    it("renders full issue metadata (state, author, GitHub link) in the desktop preview", async () => {
      Object.defineProperty(window, "innerWidth", {
        writable: true,
        configurable: true,
        value: 1200,
      });

      const issues = [
        {
          number: 7,
          title: "Metadata Issue",
          body: "**bold** issue body with `code`",
          html_url: "https://github.com/owner/repo/issues/7",
          labels: [{ name: "bug" }],
          state: "open" as const,
          author: "octocat",
        },
      ];
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
      vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce(issues);

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      await waitFor(() => {
        expect(screen.getByText("Metadata Issue")).toBeTruthy();
      });

      fireEvent.click(screen.getByRole("radio", { name: /Select issue #7/i }));

      const previewCard = await screen.findByTestId("github-import-preview-card");
      expect(within(previewCard).getByText("open")).toBeTruthy();
      expect(within(previewCard).getByText(/octocat/)).toBeTruthy();
      expect(within(previewCard).getByText("bug")).toBeTruthy();
      const link = within(previewCard).getByRole("link", { name: /View on GitHub/i }) as HTMLAnchorElement;
      expect(link.getAttribute("href")).toBe("https://github.com/owner/repo/issues/7");
      // Markdown is rendered (bold/code become elements, not literal asterisks/backticks).
      const body = screen.getByTestId("github-import-preview-body");
      expect(body.querySelector("strong")).toBeTruthy();
      expect(body.querySelector("code")).toBeTruthy();
    });

    it("returns to list view on mobile after successful import", async () => {
      Object.defineProperty(window, "innerWidth", {
        writable: true,
        configurable: true,
        value: 480,
      });

      const issues = [
        { number: 1, title: "First Issue", body: "Body 1", html_url: "https://github.com/owner/repo/issues/1", labels: [] },
      ];
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce([{ name: "origin", owner: "owner", repo: "repo", url: "" }]);
      vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce(issues);
      vi.mocked(apiImportGitHubIssue).mockResolvedValueOnce(mockTask);

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} projectId="project-1" />);

      await waitFor(() => {
        expect(screen.getByText("First Issue")).toBeTruthy();
      });

      fireEvent.click(screen.getByRole("radio", { name: /Select issue #1/i }));

      const previewPane = screen.getByTestId("github-import-preview-pane");
      await waitFor(() => {
        expect(previewPane.classList.contains("active")).toBe(true);
      });

      fireEvent.click(screen.getByRole("button", { name: /Import$/i }));

      await waitFor(() => {
        expect(apiImportGitHubIssue).toHaveBeenCalledWith("owner", "repo", 1, "project-1");
      });

      expect(previewPane.classList.contains("active")).toBe(false);
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe("list pane resize handle", () => {
    const originalInnerWidth = window.innerWidth;

    const setViewportWidth = (width: number) => {
      Object.defineProperty(window, "innerWidth", {
        writable: true,
        configurable: true,
        value: width,
      });
      window.dispatchEvent(new Event("resize"));
    };

    const renderWithIssues = async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
      vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce([
        { number: 1, title: "Resize Test Issue", body: "Body", html_url: "https://github.com/owner/repo/issues/1", labels: [] },
      ]);

      const rendered = render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      await waitFor(() => {
        expect(screen.getByText("Resize Test Issue")).toBeTruthy();
      });

      return rendered;
    };

    const renderWithEmptyIssues = async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
      vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce([]);

      const rendered = render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      await waitFor(() => {
        expect(screen.getByText("No open issues found")).toBeTruthy();
      });

      return rendered;
    };

    const renderWithPulls = async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
      vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce([]);
      vi.mocked(apiFetchGitHubPulls).mockResolvedValueOnce([
        { number: 7, title: "Resize Test Pull", body: "Pull body", html_url: "https://github.com/owner/repo/pull/7", headBranch: "feature", baseBranch: "main" },
      ]);

      const rendered = render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      fireEvent.click(screen.getByRole("tab", { name: /Pull Requests/i }));

      await waitFor(() => {
        expect(screen.getByText("Resize Test Pull")).toBeTruthy();
      });

      return rendered;
    };

    const stubPointerCapture = (handle: HTMLElement) => {
      handle.setPointerCapture = vi.fn();
      handle.releasePointerCapture = vi.fn();
      handle.hasPointerCapture = vi.fn(() => true);
    };

    const dragHandle = (handle: HTMLElement, startX: number, endX: number) => {
      stubPointerCapture(handle);
      fireEvent.pointerDown(handle, { pointerId: 1, clientX: startX });
      fireEvent.pointerMove(document, { pointerId: 1, clientX: endX });
      fireEvent.pointerUp(document, { pointerId: 1, clientX: endX });
    };

    /*
     * FNXC:GitHubImport 2026-06-23-00:30:
     * The list pane defaults narrow (256px) and clamps to [160px, 480px] (the absolute cap; a 50%-of-container cap also
     * applies once the workspace is measured, which jsdom reports as 0 so the absolute cap governs here). Width persists
     * per-project via projectStorage under the unscoped key `kb-dashboard-github-import-list-width` (no projectId in tests).
     * Pointer drags map absolute pointer X to the list width relative to the workspace left edge (jsdom rect is all-zeros).
     */
    const LIST_WIDTH_KEY = "kb-dashboard-github-import-list-width";

    beforeEach(() => {
      window.localStorage.removeItem(LIST_WIDTH_KEY);
      setViewportWidth(1200);
    });

    afterEach(() => {
      window.localStorage.removeItem(LIST_WIDTH_KEY);
      setViewportWidth(originalInnerWidth);
    });

    it("renders handle only in the side-by-side two-pane band", async () => {
      await renderWithIssues();
      expect(screen.getByTestId("github-import-resize-handle")).toBeTruthy();
      expect(screen.getByTestId("github-import-list-pane").getAttribute("style")).toContain("flex: 0 0 256px");

      setViewportWidth(800);

      await waitFor(() => {
        expect(screen.queryByTestId("github-import-resize-handle")).toBeNull();
      });
      expect(screen.getByTestId("github-import-list-pane").getAttribute("style") ?? "").not.toContain("flex: 0 0");

      setViewportWidth(480);

      await waitFor(() => {
        expect(screen.queryByTestId("github-import-resize-handle")).toBeNull();
      });
      expect(screen.getByTestId("github-import-list-pane").getAttribute("style") ?? "").not.toContain("flex: 0 0");
    });

    it("resizes the list pane with pointer drags and clamps to bounds", async () => {
      await renderWithIssues();
      const handle = screen.getByTestId("github-import-resize-handle");
      const listPane = screen.getByTestId("github-import-list-pane");

      // jsdom workspace rect is all-zeros, so the pane width equals the clamped absolute pointer X.
      dragHandle(handle, 256, 300);
      expect(handle.getAttribute("aria-valuenow")).toBe("300");
      expect(listPane.getAttribute("style")).toContain("flex: 0 0 300px");

      dragHandle(handle, 300, 200);
      expect(handle.getAttribute("aria-valuenow")).toBe("200");
      expect(listPane.getAttribute("style")).toContain("flex: 0 0 200px");

      // Below the 160px minimum clamps up.
      dragHandle(handle, 200, 40);
      expect(handle.getAttribute("aria-valuenow")).toBe("160");
      expect(listPane.getAttribute("style")).toContain("flex: 0 0 160px");

      // Above the 480px maximum clamps down.
      dragHandle(handle, 40, 900);
      expect(handle.getAttribute("aria-valuenow")).toBe("480");
      expect(listPane.getAttribute("style")).toContain("flex: 0 0 480px");
    });

    it("exposes the resize width as an inline CSS var for the embedded container query", async () => {
      await renderWithIssues();
      const listPane = screen.getByTestId("github-import-list-pane");
      expect(listPane.getAttribute("style")).toContain("--gh-import-list-width: 256px");

      const handle = screen.getByTestId("github-import-resize-handle");
      dragHandle(handle, 256, 320);
      expect(listPane.getAttribute("style")).toContain("--gh-import-list-width: 320px");
    });

    it("renders the desktop handle regardless of list content or active tab", async () => {
      const mounted = await renderWithEmptyIssues();
      expect(screen.getByTestId("github-import-resize-handle")).toBeTruthy();
      expect(screen.getByTestId("github-import-list-pane").getAttribute("style")).toContain("flex: 0 0 256px");
      mounted.unmount();

      vi.clearAllMocks();
      window.localStorage.removeItem(LIST_WIDTH_KEY);
      setViewportWidth(1200);

      await renderWithPulls();
      expect(screen.getByTestId("github-import-resize-handle")).toBeTruthy();
      expect(screen.getByTestId("github-import-list-pane").getAttribute("style")).toContain("flex: 0 0 256px");
    });
    it.each([
      [{ key: "ArrowRight" }, 272],
      [{ key: "ArrowLeft" }, 240],
      [{ key: "ArrowRight", shiftKey: true }, 320],
    ])("handles keyboard nudge %#", async (eventInit, expected) => {
      await renderWithIssues();
      const handle = screen.getByTestId("github-import-resize-handle");

      fireEvent.keyDown(handle, eventInit);

      expect(handle.getAttribute("aria-valuenow")).toBe(String(expected));
    });

    it("supports Home and End keys", async () => {
      await renderWithIssues();
      const handle = screen.getByTestId("github-import-resize-handle");

      fireEvent.keyDown(handle, { key: "Home" });
      expect(handle.getAttribute("aria-valuenow")).toBe("160");

      fireEvent.keyDown(handle, { key: "End" });
      expect(handle.getAttribute("aria-valuenow")).toBe("480");
    });

    it("clamps keyboard resizing to min and max bounds", async () => {
      await renderWithIssues();
      const handle = screen.getByTestId("github-import-resize-handle");

      for (let i = 0; i < 30; i += 1) {
        fireEvent.keyDown(handle, { key: "ArrowLeft" });
      }
      expect(handle.getAttribute("aria-valuenow")).toBe("160");

      for (let i = 0; i < 60; i += 1) {
        fireEvent.keyDown(handle, { key: "ArrowRight" });
      }
      expect(handle.getAttribute("aria-valuenow")).toBe("480");
    });

    it("persists width across remounts", async () => {
      const mounted = await renderWithIssues();
      let handle = screen.getByTestId("github-import-resize-handle");

      fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
      expect(handle.getAttribute("aria-valuenow")).toBe("320");
      // Persisted under the projectStorage key (unscoped without a projectId).
      expect(window.localStorage.getItem(LIST_WIDTH_KEY)).toBe("320");

      mounted.unmount();

      await renderWithIssues();
      handle = await screen.findByTestId("github-import-resize-handle");
      expect(handle.getAttribute("aria-valuenow")).toBe("320");
    });

    it("clamps an out-of-range stored width back into bounds on mount", async () => {
      window.localStorage.setItem(LIST_WIDTH_KEY, "9000");
      await renderWithIssues();
      // Stored value above the 480px max is clamped down on read.
      expect(screen.getByTestId("github-import-resize-handle").getAttribute("aria-valuenow")).toBe("480");
    });

    it("falls back to default width for invalid stored values", async () => {
      window.localStorage.setItem(LIST_WIDTH_KEY, "not-a-number");
      await renderWithIssues();

      expect(screen.getByTestId("github-import-resize-handle").getAttribute("aria-valuenow")).toBe("256");
    });
  });

  describe("modal actions", () => {
    it("closes modal on Cancel button click", async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce([]);
      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /Cancel/i })).toBeTruthy();
      });

      fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));
      expect(onClose).toHaveBeenCalled();
    });

    it("closes modal on X button click", async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce([]);
      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      await waitFor(() => {
        expect(screen.getByLabelText("Close import modal")).toBeTruthy();
      });

      fireEvent.click(screen.getByLabelText("Close import modal"));
      expect(onClose).toHaveBeenCalled();
    });
  });

  // ============================================================================
  // PULL REQUEST TAB TESTS
  // ============================================================================

  describe("PR tab", () => {
    it("renders Issues and Pull Requests tabs", async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce([]);
      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      await waitFor(() => {
        expect(screen.getByRole("tab", { name: /Issues/i })).toBeTruthy();
        expect(screen.getByRole("tab", { name: /Pull Requests/i })).toBeTruthy();
      });
    });

    it("switches to Pull Requests tab when clicked", async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      await waitFor(() => {
        expect(screen.getByRole("tab", { name: /Pull Requests/i })).toBeTruthy();
      });

      // Click on Pull Requests tab
      fireEvent.click(screen.getByRole("tab", { name: /Pull Requests/i }));

      // Should show Pull Requests heading
      await waitFor(() => {
        expect(screen.getByRole("heading", { name: "Pull Requests" })).toBeTruthy();
      });
    });

    it("shows filter input for Issues tab, hint text for Pulls tab", async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      await waitFor(() => {
        // Default is Issues tab, should show filter input
        expect(screen.getByPlaceholderText(/Filter:/)).toBeTruthy();
      });

      // Click on Pull Requests tab
      fireEvent.click(screen.getByRole("tab", { name: /Pull Requests/i }));

      await waitFor(() => {
        // Should show hint text instead of filter input
        expect(screen.queryByPlaceholderText(/Filter:/)).toBeNull();
        expect(screen.getByText(/Open pull requests from/i)).toBeTruthy();
      });
    });

    it("auto-loads pull requests when switching to Pulls tab with remote selected", async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
      vi.mocked(apiFetchGitHubPulls).mockResolvedValueOnce(mockPulls);

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      await waitFor(() => {
        expect(screen.getByRole("tab", { name: /Pull Requests/i })).toBeTruthy();
      });

      // Click on Pull Requests tab
      fireEvent.click(screen.getByRole("tab", { name: /Pull Requests/i }));

      // Should auto-load PRs
      await waitFor(() => {
        expect(apiFetchGitHubPulls).toHaveBeenCalledWith("dustinbyrne", "kb", 30);
        expect(screen.getByText("Test PR")).toBeTruthy();
      });
    });

    it("uses the default origin remote when switching to Pull Requests", async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(multipleRemotes);
      vi.mocked(apiFetchGitHubPulls).mockResolvedValueOnce(mockPulls);

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      await waitFor(() => {
        const select = screen.getByRole("combobox") as HTMLSelectElement;
        expect(select.value).toBe("origin");
      });

      fireEvent.click(screen.getByRole("tab", { name: /Pull Requests/i }));

      await waitFor(() => {
        expect(apiFetchGitHubPulls).toHaveBeenCalledWith("dustinbyrne", "kb", 30);
        expect(screen.getByText("Test PR")).toBeTruthy();
      });
    });

    it("displays PR list with branch info", async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
      vi.mocked(apiFetchGitHubPulls).mockResolvedValueOnce(mockPulls);

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      // Switch to Pull Requests tab
      fireEvent.click(screen.getByRole("tab", { name: /Pull Requests/i }));

      await waitFor(() => {
        expect(screen.getByText("Test PR")).toBeTruthy();
        // Check for branch info
        expect(screen.getByText(/feature → main/)).toBeTruthy();
      });
    });

    it("selects PR and shows preview with branch info", async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
      vi.mocked(apiFetchGitHubPulls).mockResolvedValueOnce(mockPulls);

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      // Switch to Pull Requests tab
      fireEvent.click(screen.getByRole("tab", { name: /Pull Requests/i }));

      await waitFor(() => {
        expect(screen.getByText("Test PR")).toBeTruthy();
      });

      // Select the PR
      fireEvent.click(screen.getByRole("radio", { name: /Select pull request #1/i }));

      // Preview should show with branch info
      const previewCard = await screen.findByTestId("github-import-preview-card");
      expect(within(previewCard).getByText("Test PR")).toBeTruthy();
      expect(within(previewCard).getByText(/feature → main/)).toBeTruthy();
    });

    it("disables Import button when no PR is selected", async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
      vi.mocked(apiFetchGitHubPulls).mockResolvedValueOnce(mockPulls);

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      // Switch to Pull Requests tab
      fireEvent.click(screen.getByRole("tab", { name: /Pull Requests/i }));

      await waitFor(() => {
        expect(screen.getByText("Test PR")).toBeTruthy();
      });

      // Import button should be disabled
      const importButton = screen.getByRole("button", { name: /Import$/i }) as HTMLButtonElement;
      expect(importButton.disabled).toBe(true);
    });

    it("calls apiImportGitHubPull when Import is clicked on PRs tab", async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
      vi.mocked(apiFetchGitHubPulls).mockResolvedValueOnce(mockPulls);
      vi.mocked(apiImportGitHubPull).mockResolvedValueOnce(mockPRTask);

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} projectId="project-1" />);

      // Switch to Pull Requests tab
      fireEvent.click(screen.getByRole("tab", { name: /Pull Requests/i }));

      await waitFor(() => {
        expect(screen.getByText("Test PR")).toBeTruthy();
      });

      // Select the PR
      fireEvent.click(screen.getByRole("radio", { name: /Select pull request #1/i }));

      // Click Import
      fireEvent.click(screen.getByRole("button", { name: /Import$/i }));

      await waitFor(() => {
        expect(apiImportGitHubPull).toHaveBeenCalledWith("dustinbyrne", "kb", 1, "project-1");
        expect(onImport).toHaveBeenCalledWith(mockPRTask);
        expect(onClose).not.toHaveBeenCalled();
        expect(screen.getByText("Import from GitHub")).toBeTruthy();
      });
    });

    it("stays open and resets selection after successful PR import", async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce([{ name: "origin", owner: "owner", repo: "repo", url: "" }]);
      vi.mocked(apiFetchGitHubPulls).mockResolvedValueOnce(mockPulls);
      vi.mocked(apiImportGitHubPull).mockResolvedValueOnce(mockPRTask);

      const { rerender } = render(
        <GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} projectId="project-1" />,
      );

      fireEvent.click(screen.getByRole("tab", { name: /Pull Requests/i }));

      await waitFor(() => {
        expect(screen.getByText("Test PR")).toBeTruthy();
      });

      const importButton = screen.getByRole("button", { name: /Import$/i }) as HTMLButtonElement;
      fireEvent.click(screen.getByRole("radio", { name: /Select pull request #1/i }));
      expect(importButton.disabled).toBe(false);

      fireEvent.click(importButton);

      await waitFor(() => {
        expect(apiImportGitHubPull).toHaveBeenCalledWith("owner", "repo", 1, "project-1");
        expect(onClose).not.toHaveBeenCalled();
      });

      await waitFor(() => {
        expect((screen.getByRole("button", { name: /Import$/i }) as HTMLButtonElement).disabled).toBe(true);
      });

      rerender(
        <GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[mockPRTask]} projectId="project-1" />,
      );

      await waitFor(() => {
        expect(screen.getByText("Test PR")).toBeTruthy();
        expect(screen.getByText("Imported")).toBeTruthy();
      });
    });

    it("shows 'Imported' badge for already imported PRs", async () => {
      const existingTask: Task = {
        ...mockPRTask,
        description: "Review and address any issues in this pull request.\n\nPR: https://github.com/owner/repo/pull/1",
      };
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce([{ name: "origin", owner: "owner", repo: "repo", url: "" }]);
      vi.mocked(apiFetchGitHubPulls).mockResolvedValueOnce(mockPulls);

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[existingTask]} />);

      // Switch to Pull Requests tab
      fireEvent.click(screen.getByRole("tab", { name: /Pull Requests/i }));

      await waitFor(() => {
        expect(screen.getByText("Imported")).toBeTruthy();
      });
    });

    it("disables radio buttons for already imported PRs", async () => {
      const existingTask: Task = {
        ...mockPRTask,
        description: "Review and address any issues in this pull request.\n\nPR: https://github.com/owner/repo/pull/1",
      };
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce([{ name: "origin", owner: "owner", repo: "repo", url: "" }]);
      vi.mocked(apiFetchGitHubPulls).mockResolvedValueOnce(mockPulls);

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[existingTask]} />);

      // Switch to Pull Requests tab
      fireEvent.click(screen.getByRole("tab", { name: /Pull Requests/i }));

      await waitFor(() => {
        const radio = screen.getByRole("radio", { name: /Select pull request #1/i }) as HTMLInputElement;
        expect(radio.disabled).toBe(true);
      });
    });

    it("shows empty state when no open pull requests found", async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
      vi.mocked(apiFetchGitHubPulls).mockResolvedValueOnce([]);

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      // Switch to Pull Requests tab
      fireEvent.click(screen.getByRole("tab", { name: /Pull Requests/i }));

      await waitFor(() => {
        expect(screen.getByText("No open pull requests found")).toBeTruthy();
      });
    });

    it("clears selection when switching tabs", async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
      vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce([
        { number: 1, title: "Issue 1", body: "Body", html_url: "https://github.com/dustinbyrne/kb/issues/1", labels: [] },
      ]);
      vi.mocked(apiFetchGitHubPulls).mockResolvedValueOnce(mockPulls);

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      // Wait for issues to load
      await waitFor(() => {
        expect(screen.getByText("Issue 1")).toBeTruthy();
      });

      // Select an issue
      fireEvent.click(screen.getByRole("radio", { name: /Select issue #1/i }));

      // Verify selection
      let previewCard = await screen.findByTestId("github-import-preview-card");
      expect(within(previewCard).getByText("Issue 1")).toBeTruthy();

      // Switch to PR tab
      fireEvent.click(screen.getByRole("tab", { name: /Pull Requests/i }));

      await waitFor(() => {
        expect(screen.getByText("Test PR")).toBeTruthy();
      });

      // Should show empty preview (issue selection cleared)
      previewCard = screen.getByTestId("github-import-preview-empty");
      expect(previewCard).toBeTruthy();
    });

    it("displays error state on PR fetch failure", async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
      vi.mocked(apiFetchGitHubPulls).mockRejectedValueOnce(new Error("Repository not found"));

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      // Switch to Pull Requests tab
      fireEvent.click(screen.getByRole("tab", { name: /Pull Requests/i }));

      await waitFor(() => {
        expect(screen.getByText("Could not load pull requests")).toBeTruthy();
        expect(screen.getByText("Repository not found")).toBeTruthy();
      });
    });

    it("shows PR count and imported count in header", async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
      vi.mocked(apiFetchGitHubPulls).mockResolvedValueOnce(mockPulls);

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      // Switch to Pull Requests tab
      fireEvent.click(screen.getByRole("tab", { name: /Pull Requests/i }));

      await waitFor(() => {
        // Should show 2 pull requests, 0 imported
        expect(screen.getByText("2 pull requests")).toBeTruthy();
        expect(screen.getByText("0 imported")).toBeTruthy();
      });
    });
  });
});
