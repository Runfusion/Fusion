import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { GitHubImportModal } from "../GitHubImportModal";
import { apiFetchGitHubIssues, apiImportGitHubIssue, fetchGitRemotes } from "../../api";
import type { Task } from "@kb/core";
import type { GitRemote } from "../../api";

// Mock the API module
vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    apiFetchGitHubIssues: vi.fn(),
    apiImportGitHubIssue: vi.fn(),
    fetchGitRemotes: vi.fn(),
  };
});

const mockTask: Task = {
  id: "KB-001",
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

const singleRemote: GitRemote[] = [
  { name: "origin", owner: "dustinbyrne", repo: "kb", url: "https://github.com/dustinbyrne/kb.git" },
];

const multipleRemotes: GitRemote[] = [
  { name: "origin", owner: "dustinbyrne", repo: "kb", url: "https://github.com/dustinbyrne/kb.git" },
  { name: "upstream", owner: "upstream", repo: "kb", url: "https://github.com/upstream/kb.git" },
];

describe("GitHubImportModal", () => {
  const onClose = vi.fn();
  const onImport = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchGitRemotes).mockReset();
    vi.mocked(apiFetchGitHubIssues).mockReset();
    vi.mocked(apiImportGitHubIssue).mockReset();
    // Set default mock for apiFetchGitHubIssues to return empty array (prevents undefined issues state)
    vi.mocked(apiFetchGitHubIssues).mockResolvedValue([]);
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

      const loadButton = screen.getByRole("button", { name: /Load issues/i }) as HTMLButtonElement;
      expect(loadButton.disabled).toBe(false);
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

    it("disables Load button when no remote is selected", async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(multipleRemotes);
      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      await waitFor(() => {
        expect(screen.getByRole("combobox")).toBeTruthy();
      });

      const loadButton = screen.getByRole("button", { name: /Load issues/i }) as HTMLButtonElement;
      expect(loadButton.disabled).toBe(true);
    });

    it("enables Load button and auto-loads after selecting a remote", async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(multipleRemotes);
      vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce([
        { number: 1, title: "Auto-loaded from origin", body: "", html_url: "https://github.com/dustinbyrne/kb/issues/1", labels: [] },
      ]);

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      await waitFor(() => {
        expect(screen.getByRole("combobox")).toBeTruthy();
      });

      fireEvent.change(screen.getByRole("combobox"), { target: { value: "origin" } });

      await waitFor(() => {
        expect(apiFetchGitHubIssues).toHaveBeenCalledWith("dustinbyrne", "kb", 30, undefined);
        expect(screen.getByText("Auto-loaded from origin")).toBeTruthy();
      });

      // After loading completes, button should be enabled
      const loadButton = screen.getByRole("button", { name: /Load issues/i }) as HTMLButtonElement;
      expect(loadButton.disabled).toBe(false);
    });

    it("switches owner/repo and auto-loads when changing remote selection", async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(multipleRemotes);
      vi.mocked(apiFetchGitHubIssues)
        .mockResolvedValueOnce([{ number: 1, title: "Issue from origin", body: "", html_url: "https://github.com/dustinbyrne/kb/issues/1", labels: [] }])
        .mockResolvedValueOnce([{ number: 2, title: "Issue from upstream", body: "", html_url: "https://github.com/upstream/kb/issues/2", labels: [] }]);

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      await waitFor(() => {
        expect(screen.getByRole("combobox")).toBeTruthy();
      });

      const select = screen.getByRole("combobox");
      fireEvent.change(select, { target: { value: "origin" } });

      await waitFor(() => {
        expect(apiFetchGitHubIssues).toHaveBeenCalledWith("dustinbyrne", "kb", 30, undefined);
        expect(screen.getByText("Issue from origin")).toBeTruthy();
      });

      fireEvent.change(select, { target: { value: "upstream" } });

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

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      await waitFor(() => {
        expect(screen.getByText("First Issue")).toBeTruthy();
      });

      fireEvent.click(screen.getByRole("radio", { name: /Select issue #1/i }));
      fireEvent.click(screen.getByRole("button", { name: /Import$/i }));

      await waitFor(() => {
        expect(apiImportGitHubIssue).toHaveBeenCalledWith("dustinbyrne", "kb", 1);
        expect(onImport).toHaveBeenCalledWith(mockTask);
        expect(onClose).toHaveBeenCalled();
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
});
