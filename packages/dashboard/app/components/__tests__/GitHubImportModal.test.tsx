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

  it("renders semantic sections and idle states before issues are loaded", async () => {
    vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
    render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Repository source" })).toBeTruthy();
      expect(screen.getByRole("heading", { name: /Filters & sync/i })).toBeTruthy();
      expect(screen.getByRole("heading", { name: "Results" })).toBeTruthy();
      expect(screen.getByRole("heading", { name: "Preview" })).toBeTruthy();
    });

    expect(screen.getByTestId("github-import-results-idle")).toBeTruthy();
    expect(screen.getByTestId("github-import-preview-empty")).toBeTruthy();
  });

  it("has optional labels input", async () => {
    vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
    render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

    await waitFor(() => {
      expect(screen.getByLabelText(/Labels/)).toBeTruthy();
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
        const loadButton = screen.getByRole("button", { name: /Load/i }) as HTMLButtonElement;
        expect(loadButton.disabled).toBe(true);
      });
    });
  });

  describe("with single remote", () => {
    it("auto-selects the remote and shows it as a ready card", async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      await waitFor(() => {
        const remoteCard = screen.getByTestId("github-import-single-remote");
        expect(within(remoteCard).getByText("Auto-detected remote")).toBeTruthy();
        expect(within(remoteCard).getByText(/origin/i)).toBeTruthy();
        expect(within(remoteCard).getByText("dustinbyrne/kb")).toBeTruthy();
        expect(within(remoteCard).getByText("Ready")).toBeTruthy();
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
      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      await waitFor(() => {
        const loadButton = screen.getByRole("button", { name: /Load/i }) as HTMLButtonElement;
        expect(loadButton.disabled).toBe(false);
      });
    });

    it("calls apiFetchGitHubIssues when Load is clicked", async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
      vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce([]);

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      await waitFor(() => {
        expect(screen.getByTestId("github-import-single-remote")).toBeTruthy();
      });

      fireEvent.click(screen.getByRole("button", { name: /Load/i }));

      await waitFor(() => {
        expect(apiFetchGitHubIssues).toHaveBeenCalledWith("dustinbyrne", "kb", 30, undefined);
      });
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
        expect(options).toContain("Select a remote...");
        expect(options).toContain("origin (dustinbyrne/kb)");
        expect(options).toContain("upstream (upstream/kb)");
      });
    });

    it("disables Load button when no remote is selected", async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(multipleRemotes);
      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      await waitFor(() => {
        const loadButton = screen.getByRole("button", { name: /Load/i }) as HTMLButtonElement;
        expect(loadButton.disabled).toBe(true);
      });
    });

    it("enables Load button after selecting a remote", async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(multipleRemotes);
      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      await waitFor(() => {
        expect(screen.getByRole("combobox")).toBeTruthy();
      });

      fireEvent.change(screen.getByRole("combobox"), { target: { value: "origin" } });

      const loadButton = screen.getByRole("button", { name: /Load/i }) as HTMLButtonElement;
      expect(loadButton.disabled).toBe(false);
    });

    it("switches owner/repo when changing remote selection", async () => {
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
      fireEvent.click(screen.getByRole("button", { name: /Load/i }));

      await waitFor(() => {
        expect(apiFetchGitHubIssues).toHaveBeenCalledWith("dustinbyrne", "kb", 30, undefined);
        expect(screen.getByText("Issue from origin")).toBeTruthy();
      });

      fireEvent.change(select, { target: { value: "upstream" } });
      fireEvent.click(screen.getByRole("button", { name: /Load/i }));

      await waitFor(() => {
        expect(apiFetchGitHubIssues).toHaveBeenLastCalledWith("upstream", "kb", 30, undefined);
        expect(screen.getByText("Issue from upstream")).toBeTruthy();
      });
    });
  });

  describe("issue loading and import", () => {
    it("displays fetched issues after loading", async () => {
      const issues = [
        { number: 1, title: "First Issue", body: "Body 1", html_url: "https://github.com/owner/repo/issues/1", labels: [] },
        { number: 2, title: "Second Issue", body: "Body 2", html_url: "https://github.com/owner/repo/issues/2", labels: [] },
      ];
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
      vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce(issues);

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      await waitFor(() => {
        expect(screen.getByTestId("github-import-single-remote")).toBeTruthy();
      });

      fireEvent.click(screen.getByRole("button", { name: /Load/i }));

      await waitFor(() => {
        expect(screen.getByText("First Issue")).toBeTruthy();
        expect(screen.getByText("Second Issue")).toBeTruthy();
      });
    });

    it("shows the preview empty state before selection and fills it after selecting an issue", async () => {
      const issues = [
        { number: 1, title: "First Issue", body: "Body 1", html_url: "https://github.com/owner/repo/issues/1", labels: [] },
      ];
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
      vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce(issues);

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      await waitFor(() => {
        expect(screen.getByTestId("github-import-preview-empty")).toBeTruthy();
      });

      fireEvent.click(screen.getByRole("button", { name: /Load/i }));

      await waitFor(() => {
        expect(screen.getByText("First Issue")).toBeTruthy();
      });

      fireEvent.click(screen.getByRole("radio", { name: /Select issue #1/i }));

      const previewCard = await screen.findByTestId("github-import-preview-card");
      expect(within(previewCard).getByText("First Issue")).toBeTruthy();
      expect(within(previewCard).getByText("Body 1")).toBeTruthy();
      expect(screen.queryByTestId("github-import-preview-empty")).toBeNull();
    });

    it("disables Import button when no issue is selected", async () => {
      const issues = [
        { number: 1, title: "First Issue", body: "Body 1", html_url: "https://github.com/owner/repo/issues/1", labels: [] },
      ];
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
      vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce(issues);

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      await waitFor(() => {
        expect(screen.getByTestId("github-import-single-remote")).toBeTruthy();
      });

      fireEvent.click(screen.getByRole("button", { name: /Load/i }));

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
        expect(screen.getByTestId("github-import-single-remote")).toBeTruthy();
      });

      fireEvent.click(screen.getByRole("button", { name: /Load/i }));

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
        expect(screen.getByTestId("github-import-single-remote")).toBeTruthy();
      });

      fireEvent.click(screen.getByRole("button", { name: /Load/i }));

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
        expect(screen.getByTestId("github-import-single-remote")).toBeTruthy();
      });

      fireEvent.click(screen.getByRole("button", { name: /Load/i }));

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
        expect(screen.getByTestId("github-import-results-idle")).toBeTruthy();
      });

      fireEvent.click(screen.getByRole("button", { name: /Load/i }));

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
        expect(screen.getByTestId("github-import-single-remote")).toBeTruthy();
      });

      fireEvent.click(screen.getByRole("button", { name: /Load/i }));

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
        expect(screen.getByTestId("github-import-single-remote")).toBeTruthy();
      });

      fireEvent.click(screen.getByRole("button", { name: /Load/i }));

      await waitFor(() => {
        expect(screen.getByText("bug")).toBeTruthy();
        expect(screen.getByText("urgent")).toBeTruthy();
      });
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
