import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { GitHubImportModal } from "../GitHubImportModal";
import {
  apiFetchGitHubIssues,
  apiImportGitHubIssue,
  apiFetchGitHubPulls,
  apiFetchGitHubPullDetail,
  apiFetchGitHubIssueDetail,
  apiCloseGitHubIssue,
  apiImportGitHubPull,
  apiFetchGitLabProjectIssues,
  apiFetchGitLabGroupIssues,
  apiFetchGitLabMergeRequests,
  apiImportGitLabProjectIssue,
  apiImportGitLabGroupIssue,
  apiImportGitLabMergeRequest,
  fetchSettings,
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
    apiFetchGitHubIssueDetail: vi.fn(),
    apiCloseGitHubIssue: vi.fn(),
    apiImportGitHubPull: vi.fn(),
    apiFetchGitLabProjectIssues: vi.fn(),
    apiFetchGitLabGroupIssues: vi.fn(),
    apiFetchGitLabMergeRequests: vi.fn(),
    apiImportGitLabProjectIssue: vi.fn(),
    apiImportGitLabGroupIssue: vi.fn(),
    apiImportGitLabMergeRequest: vi.fn(),
    fetchSettings: vi.fn(),
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

  it("makes the embedded import body fill the pane outside the mobile media block", () => {
    const source = readFileSync(resolve(__dirname, "../GitHubImportModal.css"), "utf8");
    const topLevelEmbeddedBodyRules = Array.from(
      source.matchAll(/(?:^|\n)\.github-import-modal--embedded \.github-import-modal__body\s*\{[^}]*\}/g),
      (match) => match[0],
    );

    // FNXC:GitHubImport 2026-06-28-00:00: Issues and Pull Requests share `.github-import-workspace`, so the base embedded body fill rule protects both tabs in wide two-pane and narrow stacked layouts before the <=640px media override applies.
    expect(topLevelEmbeddedBodyRules.some((rule) => rule.includes("flex: 1;") && rule.includes("min-height: 0;") && rule.includes("overflow-y: auto;"))).toBe(true);

    const mobileEmbeddedBodyRule = source.match(/@media \(max-width: 640px\) \{[\s\S]*?\.github-import-modal--embedded \.github-import-modal__body\s*\{[^}]*\}/)?.[0] ?? "";
    expect(mobileEmbeddedBodyRule).toContain("flex: 1;");
    expect(mobileEmbeddedBodyRule).toContain("overflow-y: auto;");
  });

  it("keeps the non-embedded modal body and dialog sizing rules unchanged", () => {
    const source = readFileSync(resolve(__dirname, "../GitHubImportModal.css"), "utf8");
    const baseModalBodyRule = source.match(/(?:^|\n)\.github-import-modal__body\s*\{[^}]*\}/)?.[0] ?? "";

    expect(baseModalBodyRule).toContain("display: flex;");
    expect(baseModalBodyRule).toContain("flex-direction: column;");
    expect(baseModalBodyRule).toContain("padding: var(--space-lg) var(--space-xl);");
    expect(baseModalBodyRule).toContain("overflow-y: auto;");
    expect(baseModalBodyRule).toContain("min-height: 0;");
    expect(baseModalBodyRule).not.toContain("flex: 1;");
    expect(source).toContain(".github-import-modal:not(.github-import-modal--embedded) {");
    expect(source).toContain(".modal-overlay:has(.github-import-modal:not(.github-import-modal--embedded)) {");
    expect(source).toContain(".modal.github-import-modal:not(.github-import-modal--embedded) {");
  });

  it("styles import type tabs like the Artifacts button bar", () => {
    const source = readFileSync(resolve(__dirname, "../GitHubImportModal.css"), "utf8");
    const tabsRule = source.match(/\.github-import-tabs\s*\{[^}]*\}/)?.[0] ?? "";
    const tabRule = source.match(/\.github-import-tab\s*\{[^}]*\}/)?.[0] ?? "";
    const activeRule = source.match(/\.github-import-tab\.active\s*\{[^}]*\}/)?.[0] ?? "";

    expect(tabsRule).toContain("background: transparent;");
    expect(tabsRule).toContain("border-bottom: none;");
    expect(tabRule).toContain("border: 1px solid var(--border);");
    expect(tabRule).toContain("background: var(--surface);");
    expect(activeRule).toContain("color: var(--todo);");
    expect(activeRule).toContain("border-color: var(--todo);");
    expect(activeRule).toContain("background: color-mix(in srgb, var(--todo) 12%, transparent);");
  });

  /*
   * FNXC:GitHubImport 2026-07-07-00:00:
   * FN-7657 introduced per-project persistence for the import view (provider/tab/labels/remote/selection) under
   * `kb-dashboard-github-import-state` (unscoped when no projectId is passed, `kb:{projectId}:...` otherwise). Most
   * pre-existing tests in this file render without a projectId and therefore share the SAME unscoped storage key, so
   * that key (and the projectIds exercised anywhere in this file) must be cleared before EVERY test or state written
   * by one test would leak into the next test's initial render.
   */
  const GITHUB_IMPORT_STATE_KEY = "kb-dashboard-github-import-state";
  const clearAllPersistedImportState = () => {
    window.localStorage.removeItem(GITHUB_IMPORT_STATE_KEY);
    for (const projectId of ["project-1", "project-2", "project-a", "project-b"]) {
      window.localStorage.removeItem(`kb:${projectId}:${GITHUB_IMPORT_STATE_KEY}`);
    }
  };

  beforeEach(() => {
    vi.clearAllMocks();
    clearAllPersistedImportState();
    vi.mocked(fetchGitRemotes).mockReset();
    vi.mocked(apiFetchGitHubIssues).mockReset();
    vi.mocked(apiImportGitHubIssue).mockReset();
    vi.mocked(apiFetchGitHubPulls).mockReset();
    vi.mocked(apiFetchGitHubPullDetail).mockReset();
    vi.mocked(apiFetchGitHubIssueDetail).mockReset();
    vi.mocked(apiCloseGitHubIssue).mockReset();
    vi.mocked(apiImportGitHubPull).mockReset();
    vi.mocked(apiFetchGitLabProjectIssues).mockReset();
    vi.mocked(apiFetchGitLabGroupIssues).mockReset();
    vi.mocked(apiFetchGitLabMergeRequests).mockReset();
    vi.mocked(apiImportGitLabProjectIssue).mockReset();
    vi.mocked(apiImportGitLabGroupIssue).mockReset();
    vi.mocked(apiImportGitLabMergeRequest).mockReset();
    vi.mocked(fetchSettings).mockReset();
    vi.mocked(fetchSettings).mockResolvedValue({ gitlabEnabled: true } as never);
    // Set default mock for apiFetchGitHubIssues to return empty array (prevents undefined issues state)
    vi.mocked(apiFetchGitHubIssues).mockResolvedValue([]);
    vi.mocked(apiFetchGitHubPulls).mockResolvedValue([]);
    vi.mocked(apiFetchGitHubPullDetail).mockResolvedValue({ comments: [], checks: [] });
    vi.mocked(apiFetchGitHubIssueDetail).mockResolvedValue({ comments: [] });
    vi.mocked(apiCloseGitHubIssue).mockResolvedValue(undefined);
    vi.mocked(apiFetchGitLabProjectIssues).mockResolvedValue([]);
    vi.mocked(apiFetchGitLabGroupIssues).mockResolvedValue([]);
    vi.mocked(apiFetchGitLabMergeRequests).mockResolvedValue([]);
    vi.mocked(apiImportGitLabProjectIssue).mockResolvedValue(mockTask);
    vi.mocked(apiImportGitLabGroupIssue).mockResolvedValue(mockTask);
    vi.mocked(apiImportGitLabMergeRequest).mockResolvedValue(mockTask);
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

  it("fetches, previews, and imports GitLab project issues", async () => {
    vi.mocked(fetchGitRemotes).mockResolvedValueOnce([]);
    vi.mocked(apiFetchGitLabProjectIssues).mockResolvedValueOnce([
      { resourceKind: "project_issue", id: 1, iid: 2, projectId: 3, projectPath: "group/project", title: "GitLab bug", description: "Body", webUrl: "https://gitlab.example.com/group/project/-/issues/2", state: "opened", labels: ["bug"] },
    ]);
    vi.mocked(apiImportGitLabProjectIssue).mockResolvedValueOnce({ ...mockTask, id: "FN-099", title: "GitLab bug", description: "Body\n\nSource: https://gitlab.example.com/group/project/-/issues/2" });

    render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: "GitLab" }));
    fireEvent.change(screen.getByLabelText("GitLab project path or ID"), { target: { value: "group/project" } });
    fireEvent.click(screen.getByRole("button", { name: /Load/ }));

    expect(await screen.findByText(/#2 GitLab bug/)).toBeTruthy();
    fireEvent.click(screen.getByText(/#2 GitLab bug/));
    expect(await screen.findByTestId("gitlab-import-preview-body")).toHaveTextContent("Body");
    fireEvent.click(screen.getAllByRole("button", { name: "Import" })[0]);

    await waitFor(() => expect(apiImportGitLabProjectIssue).toHaveBeenCalledWith("group/project", 2, undefined));
    expect(onImport).toHaveBeenCalledWith(expect.objectContaining({ id: "FN-099" }));
  });

  it("shows disabled GitLab import controls without fetching when GitLab is off", async () => {
    vi.mocked(fetchGitRemotes).mockResolvedValueOnce([]);
    vi.mocked(fetchSettings).mockResolvedValueOnce({ gitlabEnabled: false } as never);

    render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: "GitLab" }));

    expect(await screen.findByTestId("gitlab-import-disabled")).toHaveTextContent("GitLab integration disabled");
    expect(screen.getByRole("button", { name: /Load/ })).toBeDisabled();
    expect(screen.getByLabelText("GitLab project path or ID")).toBeDisabled();
    expect(screen.getByRole("tab", { name: "Group issues" })).toBeDisabled();
    expect(apiFetchGitLabProjectIssues).not.toHaveBeenCalled();
    expect(apiImportGitLabProjectIssue).not.toHaveBeenCalled();
  });

  it("fetches group issues and merge requests without GitHub-only copy", async () => {
    vi.mocked(fetchGitRemotes).mockResolvedValue([]);
    vi.mocked(apiFetchGitLabGroupIssues).mockResolvedValueOnce([
      { resourceKind: "group_issue", id: 3, iid: 7, projectId: 8, projectPath: "group/project", groupPath: "group", title: "Group issue", description: null, webUrl: "https://gitlab.example.com/group/project/-/issues/7", state: "opened", labels: [] },
    ]);
    vi.mocked(apiFetchGitLabMergeRequests).mockResolvedValueOnce([
      { resourceKind: "merge_request", id: 4, iid: 5, projectId: 8, projectPath: "group/project", title: "Review me", description: "MR body", webUrl: "https://gitlab.example.com/group/project/-/merge_requests/5", state: "opened", labels: [], sourceBranch: "feat", targetBranch: "main" },
    ]);
    vi.mocked(apiImportGitLabGroupIssue).mockResolvedValueOnce({ ...mockTask, id: "FN-100", title: "Group issue" });
    vi.mocked(apiImportGitLabMergeRequest).mockResolvedValueOnce({ ...mockTask, id: "FN-101", title: "Review MR !5: Review me" });

    render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: "GitLab" }));

    fireEvent.click(screen.getByRole("tab", { name: "Group issues" }));
    fireEvent.change(screen.getByLabelText("GitLab group path or ID"), { target: { value: "group" } });
    fireEvent.click(screen.getByRole("button", { name: /Load/ }));
    expect(await screen.findByText(/#7 Group issue/)).toBeInTheDocument();
    fireEvent.click(screen.getByText(/#7 Group issue/));
    expect(screen.getByTestId("gitlab-import-preview-body")).toHaveTextContent("(no description)");
    fireEvent.click(screen.getAllByRole("button", { name: "Import" })[0]);
    await waitFor(() => expect(apiImportGitLabGroupIssue).toHaveBeenCalledWith(expect.objectContaining({ iid: 7 }), "group", undefined));

    fireEvent.click(screen.getByRole("tab", { name: "Merge requests" }));
    fireEvent.change(screen.getByLabelText("GitLab project path or ID"), { target: { value: "group/project" } });
    fireEvent.click(screen.getByRole("button", { name: /Load/ }));
    expect(await screen.findByText(/!5 Review me/)).toBeInTheDocument();
    fireEvent.click(screen.getByText(/!5 Review me/));
    expect(screen.getByTestId("gitlab-import-preview-body")).toHaveTextContent("MR body");
    expect(screen.getByTestId("gitlab-import-panel").textContent).not.toContain("GitHub");
    fireEvent.click(screen.getAllByRole("button", { name: "Import" })[0]);
    await waitFor(() => expect(apiImportGitLabMergeRequest).toHaveBeenCalledWith("group/project", 5, undefined));
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

    // FNXC:GitHubImport 2026-06-23-02:00: embedded sidebar drops the bottom Cancel+Import bar (no modal to cancel)
    // and surfaces the import action at the TOP of the preview pane via github-import-action-top. The non-embedded
    // modal keeps its bottom Cancel+Import bar.
    it("removes the bottom action bar in embedded mode but keeps the top import button", async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce([]);
      const { container } = render(
        <GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} presentation="embedded" />,
      );

      await waitFor(() => {
        expect(screen.getByText("Import Tasks")).toBeTruthy();
      });
      // No bottom Cancel+Import bar in embedded mode.
      expect(container.querySelector(".github-import-modal__actions")).toBeNull();
      expect(screen.queryByRole("button", { name: /Cancel/i })).toBeNull();
      // Top import action present.
      expect(screen.getByTestId("github-import-action-top")).toBeTruthy();
    });

    it("keeps the bottom action bar with Cancel in modal mode plus the top import button", async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce([]);
      const { container } = render(
        <GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />,
      );

      await waitFor(() => {
        expect(screen.getByText("Import from GitHub")).toBeTruthy();
      });
      expect(container.querySelector(".github-import-modal__actions")).not.toBeNull();
      expect(screen.getByRole("button", { name: /Cancel/i })).toBeTruthy();
      expect(screen.getByTestId("github-import-action-top")).toBeTruthy();
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

      const importButton = screen.getByTestId("github-import-action-top") as HTMLButtonElement;
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
      fireEvent.click(screen.getByTestId("github-import-action-top"));

      await waitFor(() => {
        expect(apiImportGitHubIssue).toHaveBeenCalledWith("dustinbyrne", "kb", 1, "project-1");
        expect(onImport).toHaveBeenCalledWith(mockTask);
        expect(onClose).not.toHaveBeenCalled();
        expect(screen.getByText("Import from GitHub")).toBeTruthy();
      });
    });

    it("stays open and returns desktop issue imports to the no-selection list state", async () => {
      const issues = [
        { number: 1, title: "First Issue", body: null, html_url: "https://github.com/owner/repo/issues/1", labels: [] },
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

      const importButton = screen.getByTestId("github-import-action-top") as HTMLButtonElement;
      const radio = screen.getByRole("radio", { name: /Select issue #1/i }) as HTMLInputElement;
      fireEvent.click(radio);
      expect(await screen.findByTestId("github-import-preview-card")).toBeTruthy();
      expect(importButton.disabled).toBe(false);

      fireEvent.click(importButton);

      await waitFor(() => {
        expect(apiImportGitHubIssue).toHaveBeenCalledWith("owner", "repo", 1, "project-1");
        expect(onClose).not.toHaveBeenCalled();
        expect(radio.checked).toBe(false);
        expect(screen.queryByTestId("github-import-preview-card")).toBeNull();
        expect(screen.getByTestId("github-import-preview-empty")).toHaveTextContent("No issue selected");
        expect((screen.getByTestId("github-import-action-top") as HTMLButtonElement).disabled).toBe(true);
      });

      rerender(
        <GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[mockTask]} projectId="project-1" />,
      );

      await waitFor(() => {
        expect(screen.getByText("First Issue")).toBeTruthy();
        expect(screen.getByText("Imported")).toBeTruthy();
      });
    });

    it("returns modal bottom issue imports to the list without dismissing the modal", async () => {
      const issues = [
        { number: 2, title: "Bottom Action Issue", body: "Body", html_url: "https://github.com/owner/repo/issues/2", labels: [] },
      ];
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce([{ name: "origin", owner: "owner", repo: "repo", url: "" }]);
      vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce(issues);
      vi.mocked(apiImportGitHubIssue).mockResolvedValueOnce({ ...mockTask, id: "FN-002" });

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} projectId="project-1" />);

      await waitFor(() => expect(screen.getByText("Bottom Action Issue")).toBeTruthy());
      fireEvent.click(screen.getByRole("radio", { name: /Select issue #2/i }));
      expect(await screen.findByTestId("github-import-preview-card")).toBeTruthy();

      const bottomImportButton = screen.getAllByRole("button", { name: "Import" }).at(-1) as HTMLButtonElement;
      fireEvent.click(bottomImportButton);

      await waitFor(() => {
        expect(apiImportGitHubIssue).toHaveBeenCalledWith("owner", "repo", 2, "project-1");
        expect(onClose).not.toHaveBeenCalled();
        expect(screen.queryByTestId("github-import-preview-card")).toBeNull();
        expect(screen.getByTestId("github-import-preview-empty")).toHaveTextContent("No issue selected");
        expect((screen.getByRole("radio", { name: /Select issue #2/i }) as HTMLInputElement).checked).toBe(false);
      });
    });

    it("keeps the selected issue preview open when issue import fails", async () => {
      const issues = [
        { number: 3, title: "Retry Issue", body: "Retry body", html_url: "https://github.com/owner/repo/issues/3", labels: [] },
      ];
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce([{ name: "origin", owner: "owner", repo: "repo", url: "" }]);
      vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce(issues);
      vi.mocked(apiImportGitHubIssue).mockRejectedValueOnce(new Error("already imported elsewhere"));

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} projectId="project-1" />);

      await waitFor(() => expect(screen.getByText("Retry Issue")).toBeTruthy());
      const radio = screen.getByRole("radio", { name: /Select issue #3/i }) as HTMLInputElement;
      fireEvent.click(radio);
      expect(await screen.findByTestId("github-import-preview-card")).toHaveTextContent("Retry Issue");

      fireEvent.click(screen.getByTestId("github-import-action-top"));

      await waitFor(() => {
        expect(screen.getByText("already imported elsewhere")).toBeTruthy();
        expect(radio.checked).toBe(true);
        expect(screen.getByTestId("github-import-preview-card")).toHaveTextContent("Retry Issue");
        expect(screen.queryByTestId("github-import-preview-empty")).toBeNull();
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

    it("returns mobile issue imports from preview to the active list pane", async () => {
      Object.defineProperty(window, "innerWidth", {
        writable: true,
        configurable: true,
        value: 480,
      });
      window.dispatchEvent(new Event("resize"));

      const issues = [
        { number: 1, title: "Mobile Import Issue", body: "Body", html_url: "https://github.com/owner/repo/issues/1", labels: [] },
      ];
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
      vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce(issues);
      vi.mocked(apiImportGitHubIssue).mockResolvedValueOnce(mockTask);

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      await waitFor(() => expect(screen.getByText("Mobile Import Issue")).toBeTruthy());
      fireEvent.click(screen.getByRole("radio", { name: /Select issue #1/i }));

      const previewPane = screen.getByTestId("github-import-preview-pane");
      const listPane = screen.getByTestId("github-import-list-pane");
      await waitFor(() => expect(previewPane.classList.contains("active")).toBe(true));
      expect(listPane.classList.contains("active")).toBe(false);

      fireEvent.click(screen.getByTestId("github-import-action-top"));

      await waitFor(() => {
        expect(apiImportGitHubIssue).toHaveBeenCalledWith("dustinbyrne", "kb", 1, undefined);
        expect(previewPane.classList.contains("active")).toBe(false);
        expect(listPane.classList.contains("active")).toBe(true);
        expect(screen.queryByTestId("github-import-preview-card")).toBeNull();
        expect(screen.getByTestId("github-import-preview-empty")).toHaveTextContent("No issue selected");
      });
    });

    it("returns mobile issue close from preview to the active list pane", async () => {
      Object.defineProperty(window, "innerWidth", {
        writable: true,
        configurable: true,
        value: 480,
      });
      window.dispatchEvent(new Event("resize"));

      const issues = [
        { number: 4, title: "Mobile Close Issue", body: "Body", html_url: "https://github.com/owner/repo/issues/4", labels: [], state: "open" as const },
      ];
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
      vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce(issues);

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      await waitFor(() => expect(screen.getByText("Mobile Close Issue")).toBeTruthy());
      fireEvent.click(screen.getByRole("radio", { name: /Select issue #4/i }));

      const previewPane = screen.getByTestId("github-import-preview-pane");
      const listPane = screen.getByTestId("github-import-list-pane");
      await waitFor(() => expect(previewPane.classList.contains("active")).toBe(true));

      fireEvent.click(await screen.findByTestId("github-import-issue-close"));

      await waitFor(() => {
        expect(apiCloseGitHubIssue).toHaveBeenCalledWith("dustinbyrne/kb", 4);
        expect(previewPane.classList.contains("active")).toBe(false);
        expect(listPane.classList.contains("active")).toBe(true);
        expect(screen.queryByTestId("github-import-preview-card")).toBeNull();
        expect(screen.getByTestId("github-import-preview-empty")).toHaveTextContent("No issue selected");
      });
      expect(await screen.findByTestId("github-import-issue-close-toast")).toHaveTextContent("Issue #4 closed");
    });

    it("keeps the mobile issue preview active when import fails", async () => {
      Object.defineProperty(window, "innerWidth", {
        writable: true,
        configurable: true,
        value: 480,
      });
      window.dispatchEvent(new Event("resize"));

      const issues = [
        { number: 6, title: "Mobile Retry Issue", body: "Body", html_url: "https://github.com/owner/repo/issues/6", labels: [] },
      ];
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
      vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce(issues);
      vi.mocked(apiImportGitHubIssue).mockRejectedValueOnce(new Error("Duplicate server error"));

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      await waitFor(() => expect(screen.getByText("Mobile Retry Issue")).toBeTruthy());
      fireEvent.click(screen.getByRole("radio", { name: /Select issue #6/i }));
      const previewPane = screen.getByTestId("github-import-preview-pane");
      await waitFor(() => expect(previewPane.classList.contains("active")).toBe(true));

      fireEvent.click(screen.getByTestId("github-import-action-top"));

      await waitFor(() => {
        expect(screen.getByText("Duplicate server error")).toBeTruthy();
        expect(previewPane.classList.contains("active")).toBe(true);
        expect(screen.getByTestId("github-import-preview-card")).toHaveTextContent("Mobile Retry Issue");
      });
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
          { author: "alice", body: "First comment from alice", createdAt: "2024-01-01T00:00:00Z", authorIsBot: false, authorAvatarUrl: "https://github.com/alice.png?size=40" },
          { author: "github-actions[bot]", body: "Second comment from bot", createdAt: "2024-01-02T00:00:00Z", authorIsBot: true },
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
      await waitFor(() => {
        expect(comments.textContent).toContain("alice");
        expect(comments.textContent).toContain("First comment from alice");
        expect(comments.textContent).toContain("github-actions[bot]");
        expect(comments.textContent).toContain("Second comment from bot");
      });

      // FNXC:GitHubImport 2026-06-23-03:30: per-comment testid + human/bot indicator via data-comment-author-type.
      const commentEls = within(comments).getAllByTestId("github-import-comment");
      expect(commentEls).toHaveLength(2);
      expect(commentEls[0].getAttribute("data-comment-author-type")).toBe("human");
      expect(commentEls[1].getAttribute("data-comment-author-type")).toBe("bot");
      // Human/bot badge labels render.
      expect(commentEls[0].textContent).toContain("Human");
      expect(commentEls[1].textContent).toContain("Bot");
      // Avatar image renders for the human author (with the provided avatar URL).
      const avatarImg = commentEls[0].querySelector("img.github-import-comment__avatar-img") as HTMLImageElement | null;
      expect(avatarImg?.getAttribute("src")).toBe("https://github.com/alice.png?size=40");
      // Readable timestamp renders with the full ISO as the title/datetime.
      const timeEl = commentEls[0].querySelector("time");
      expect(timeEl?.getAttribute("title")).toBe("2024-01-01T00:00:00Z");
      expect(timeEl?.textContent?.length).toBeGreaterThan(0);
    });

    // FNXC:GitHubImport 2026-06-23-03:30: The Human filter hides bot comments; All (default) shows both.
    it("filters bot comments out when the comments filter is set to Human", async () => {
      Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 1200 });

      const pulls = [
        { number: 11, title: "Filter PR", body: "PR body", html_url: "https://github.com/owner/repo/pull/11", headBranch: "feature", baseBranch: "main" },
      ];
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
      vi.mocked(apiFetchGitHubPulls).mockResolvedValueOnce(pulls);
      vi.mocked(apiFetchGitHubPullDetail).mockResolvedValueOnce({
        comments: [
          { author: "alice", body: "human comment text", createdAt: "2024-01-01T00:00:00Z", authorIsBot: false },
          { author: "dependabot[bot]", body: "bot comment text", createdAt: "2024-01-02T00:00:00Z", authorIsBot: true },
        ],
        checks: [],
      });

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      fireEvent.click(await screen.findByRole("tab", { name: /Pull Requests/i }));
      await waitFor(() => {
        expect(screen.getByText("Filter PR")).toBeTruthy();
      });
      fireEvent.click(screen.getByRole("radio", { name: /Select pull request #11/i }));

      const comments = await screen.findByTestId("github-import-pr-comments");
      // Default (All): both comments show.
      await waitFor(() => {
        expect(within(comments).getAllByTestId("github-import-comment")).toHaveLength(2);
      });

      // Switch to Human: bot comment is hidden.
      const filter = within(comments).getByTestId("github-import-comments-filter");
      fireEvent.click(within(filter).getByText("Human"));
      await waitFor(() => {
        const remaining = within(comments).getAllByTestId("github-import-comment");
        expect(remaining).toHaveLength(1);
        expect(remaining[0].getAttribute("data-comment-author-type")).toBe("human");
      });
      expect(comments.textContent).not.toContain("bot comment text");
    });

    // FNXC:GitHubImport 2026-06-23-03:30: Prev/Next nav advances the active comment index across the thread.
    it("advances the active comment with the prev/next navigation", async () => {
      Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 1200 });

      const pulls = [
        { number: 13, title: "Nav PR", body: "PR body", html_url: "https://github.com/owner/repo/pull/13", headBranch: "feature", baseBranch: "main" },
      ];
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
      vi.mocked(apiFetchGitHubPulls).mockResolvedValueOnce(pulls);
      vi.mocked(apiFetchGitHubPullDetail).mockResolvedValueOnce({
        comments: [
          { author: "alice", body: "comment one", createdAt: "2024-01-01T00:00:00Z", authorIsBot: false },
          { author: "bob", body: "comment two", createdAt: "2024-01-02T00:00:00Z", authorIsBot: false },
        ],
        checks: [],
      });

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      fireEvent.click(await screen.findByRole("tab", { name: /Pull Requests/i }));
      await waitFor(() => {
        expect(screen.getByText("Nav PR")).toBeTruthy();
      });
      fireEvent.click(screen.getByRole("radio", { name: /Select pull request #13/i }));

      const comments = await screen.findByTestId("github-import-pr-comments");
      const prev = await within(comments).findByTestId("github-import-comment-prev");
      const next = within(comments).getByTestId("github-import-comment-next");

      // At the first comment: prev disabled, next enabled.
      expect((prev as HTMLButtonElement).disabled).toBe(true);
      expect((next as HTMLButtonElement).disabled).toBe(false);

      // Advance to the last comment: next becomes disabled, prev enabled.
      fireEvent.click(next);
      await waitFor(() => {
        expect((next as HTMLButtonElement).disabled).toBe(true);
        expect((prev as HTMLButtonElement).disabled).toBe(false);
      });
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

    // FNXC:GitHubImport 2026-06-23-03:15: Selecting an issue fetches its detail and renders the full comment thread below the body (mirrors the PR tab; issues have no checks).
    it("renders the selected issue's comments from the detail fetch", async () => {
      Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 1200 });

      const issues = [
        { number: 7, title: "Detail Issue", body: "Issue body text", html_url: "https://github.com/owner/repo/issues/7", labels: [], state: "open" as const, author: "carol" },
      ];
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
      vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce(issues);
      vi.mocked(apiFetchGitHubIssueDetail).mockResolvedValueOnce({
        comments: [
          { author: "alice", body: "First issue comment", createdAt: "2024-01-01T00:00:00Z", authorIsBot: false },
          { author: "bob", body: "Second issue comment", createdAt: "2024-01-02T00:00:00Z", authorIsBot: false },
        ],
      });

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      await waitFor(() => {
        expect(screen.getByText("Detail Issue")).toBeTruthy();
      });

      fireEvent.click(screen.getByRole("radio", { name: /Select issue #7/i }));

      // Detail fetch is scoped to the selected issue by "owner/repo" + number.
      await waitFor(() => {
        expect(vi.mocked(apiFetchGitHubIssueDetail)).toHaveBeenCalledWith("dustinbyrne/kb", 7);
      });

      const comments = await screen.findByTestId("github-import-issue-comments");

      // Body still renders immediately, independent of detail.
      expect(screen.getByTestId("github-import-preview-body").textContent).toContain("Issue body text");

      // Full comment thread renders, chronological, with authors + bodies.
      await waitFor(() => {
        expect(comments.textContent).toContain("alice");
        expect(comments.textContent).toContain("First issue comment");
        expect(comments.textContent).toContain("bob");
        expect(comments.textContent).toContain("Second issue comment");
      });
    });

    // FNXC:GitHubImport 2026-07-02-00:00: Successful Close issue returns to the issue list/no-selection state; failure stays on the preview so the user can retry.
    it("closes the selected issue via the close API and returns desktop to the no-selection list state", async () => {
      Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 1200 });

      const issues = [
        { number: 5, title: "Closable Issue", body: "Body", html_url: "https://github.com/owner/repo/issues/5", labels: [], state: "open" as const, author: "dave" },
      ];
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
      vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce(issues);

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      await waitFor(() => {
        expect(screen.getByText("Closable Issue")).toBeTruthy();
      });

      fireEvent.click(screen.getByRole("radio", { name: /Select issue #5/i }));

      const closeButton = await screen.findByTestId("github-import-issue-close");
      fireEvent.click(closeButton);

      // Calls the close API scoped to "owner/repo" + number.
      await waitFor(() => {
        expect(vi.mocked(apiCloseGitHubIssue)).toHaveBeenCalledWith("dustinbyrne/kb", 5);
      });

      // Success toast surfaces without dismissing the modal, while the completed issue preview is cleared.
      expect(await screen.findByTestId("github-import-issue-close-toast")).toHaveTextContent("Issue #5 closed");

      await waitFor(() => {
        expect((screen.getByRole("radio", { name: /Select issue #5/i }) as HTMLInputElement).checked).toBe(false);
        expect(screen.queryByTestId("github-import-preview-card")).toBeNull();
        expect(screen.getByTestId("github-import-preview-empty")).toHaveTextContent("No issue selected");
        expect(screen.queryByTestId("github-import-issue-close")).toBeNull();
      });

      expect(onClose).not.toHaveBeenCalled();
    });

    it("keeps the selected issue preview open when close fails", async () => {
      Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 1200 });

      const issues = [
        { number: 8, title: "Close Retry Issue", body: "Retry close body", html_url: "https://github.com/owner/repo/issues/8", labels: [], state: "open" as const, author: "dave" },
      ];
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
      vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce(issues);
      vi.mocked(apiCloseGitHubIssue).mockRejectedValueOnce(new Error("close failed"));

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      await waitFor(() => expect(screen.getByText("Close Retry Issue")).toBeTruthy());
      const radio = screen.getByRole("radio", { name: /Select issue #8/i }) as HTMLInputElement;
      fireEvent.click(radio);
      expect(await screen.findByTestId("github-import-preview-card")).toHaveTextContent("Close Retry Issue");

      fireEvent.click(await screen.findByTestId("github-import-issue-close"));

      await waitFor(() => {
        expect(apiCloseGitHubIssue).toHaveBeenCalledWith("dustinbyrne/kb", 8);
        expect(screen.getByTestId("github-import-issue-close-toast")).toHaveTextContent("close failed");
        expect(radio.checked).toBe(true);
        expect(screen.getByTestId("github-import-preview-card")).toHaveTextContent("Close Retry Issue");
        expect(screen.getByTestId("github-import-issue-close")).toBeTruthy();
      });
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

      fireEvent.click(screen.getByTestId("github-import-action-top"));

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
      const importButton = screen.getByTestId("github-import-action-top") as HTMLButtonElement;
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
      fireEvent.click(screen.getByTestId("github-import-action-top"));

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

      const importButton = screen.getByTestId("github-import-action-top") as HTMLButtonElement;
      fireEvent.click(screen.getByRole("radio", { name: /Select pull request #1/i }));
      expect(importButton.disabled).toBe(false);

      fireEvent.click(importButton);

      await waitFor(() => {
        expect(apiImportGitHubPull).toHaveBeenCalledWith("owner", "repo", 1, "project-1");
        expect(onClose).not.toHaveBeenCalled();
      });

      await waitFor(() => {
        expect((screen.getByTestId("github-import-action-top") as HTMLButtonElement).disabled).toBe(true);
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

  /*
   * FNXC:GitHubImport 2026-07-07-00:00:
   * FN-7657 symptom verification. The embedded Import Tasks view fully unmounts on navigation away (e.g. to Board) and
   * remounts fresh on return; before this fix every one of these fields reset to defaults on remount. These tests
   * unmount + remount a fresh instance with the SAME projectId to simulate exactly that, and assert restoration.
   */
  describe("import state retention on exit and return (FN-7657)", () => {
    const GITHUB_IMPORT_STATE_KEY = "kb-dashboard-github-import-state";
    const originalInnerWidth = window.innerWidth;

    const clearImportState = (projectId?: string) => {
      const key = projectId ? `kb:${projectId}:${GITHUB_IMPORT_STATE_KEY}` : GITHUB_IMPORT_STATE_KEY;
      window.localStorage.removeItem(key);
    };

    beforeEach(() => {
      clearImportState("project-1");
      clearImportState("project-2");
      clearImportState(undefined);
    });

    afterEach(() => {
      clearImportState("project-1");
      clearImportState("project-2");
      clearImportState(undefined);
      Object.defineProperty(window, "innerWidth", {
        writable: true,
        configurable: true,
        value: originalInnerWidth,
      });
      window.dispatchEvent(new Event("resize"));
    });

    it("restores the active tab, label filter, and selected issue after unmount and remount for the same project", async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValue(singleRemote);
      vi.mocked(apiFetchGitHubIssues).mockResolvedValue([
        { number: 1, title: "Persisted Issue", body: "Body", html_url: "https://github.com/dustinbyrne/kb/issues/1", labels: [] },
      ]);

      const first = render(
        <GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} projectId="project-1" presentation="embedded" />,
      );

      await waitFor(() => {
        expect(screen.getByText("Persisted Issue")).toBeTruthy();
      });

      fireEvent.change(screen.getByPlaceholderText(/Filter:/), { target: { value: "bug" } });
      // The label change re-triggers auto-load (briefly disabling the list); wait for it to settle before selecting.
      await waitFor(() => {
        expect(screen.getByRole("radio", { name: /Select issue #1/i })).not.toBeDisabled();
      });
      fireEvent.click(screen.getByRole("radio", { name: /Select issue #1/i }));

      await waitFor(() => {
        expect(within(screen.getByTestId("github-import-preview-card")).getByText("Persisted Issue")).toBeTruthy();
      });

      // Simulate navigating away from the embedded view (component fully unmounts).
      first.unmount();

      // Simulate returning to the view: a brand-new instance mounts for the same project.
      render(
        <GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} projectId="project-1" presentation="embedded" />,
      );

      await waitFor(() => {
        expect((screen.getByPlaceholderText(/Filter:/) as HTMLInputElement).value).toBe("bug");
      });
      await waitFor(() => {
        expect(within(screen.getByTestId("github-import-preview-card")).getByText("Persisted Issue")).toBeTruthy();
      });
    });

    it("restores the Pull Requests tab and selected PR after unmount and remount", async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValue(singleRemote);
      vi.mocked(apiFetchGitHubPulls).mockResolvedValue(mockPulls);

      const first = render(
        <GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} projectId="project-1" presentation="embedded" />,
      );

      fireEvent.click(await screen.findByRole("tab", { name: /Pull Requests/i }));
      await waitFor(() => {
        expect(screen.getByText("Test PR")).toBeTruthy();
      });
      fireEvent.click(screen.getByRole("radio", { name: /Select pull request #1/i }));
      await waitFor(() => {
        expect(within(screen.getByTestId("github-import-preview-card")).getByText("Test PR")).toBeTruthy();
      });

      first.unmount();

      render(
        <GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} projectId="project-1" presentation="embedded" />,
      );

      // Restored straight to the Pull Requests tab, with the prior PR selection re-applied.
      await waitFor(() => {
        expect(screen.getByRole("tab", { name: /Pull Requests/i })).toHaveAttribute("aria-selected", "true");
      });
      await waitFor(() => {
        expect(within(screen.getByTestId("github-import-preview-card")).getByText("Test PR")).toBeTruthy();
      });
    });

    it("restores GitLab provider, resource inputs, and selection after unmount and remount", async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValue([]);
      vi.mocked(apiFetchGitLabProjectIssues).mockResolvedValue([
        { resourceKind: "project_issue", id: 1, iid: 2, projectId: 3, projectPath: "group/project", title: "GitLab bug", description: "Body", webUrl: "https://gitlab.example.com/group/project/-/issues/2", state: "opened", labels: ["bug"] },
      ]);

      const first = render(
        <GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} projectId="project-1" presentation="embedded" />,
      );

      fireEvent.click(await screen.findByRole("button", { name: "GitLab" }));
      fireEvent.change(screen.getByLabelText("GitLab project path or ID"), { target: { value: "group/project" } });
      fireEvent.click(screen.getByRole("button", { name: /Load/ }));

      fireEvent.click(await screen.findByText(/#2 GitLab bug/));
      await waitFor(() => {
        expect(screen.getByTestId("gitlab-import-preview-card")).toBeTruthy();
      });

      first.unmount();

      render(
        <GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} projectId="project-1" presentation="embedded" />,
      );

      // Provider tab and GitLab project input are restored immediately from persisted state.
      await waitFor(() => {
        expect(screen.getByRole("button", { name: "GitLab" })).toHaveAttribute("aria-pressed", "true");
      });
      await waitFor(() => {
        expect((screen.getByLabelText("GitLab project path or ID") as HTMLInputElement).value).toBe("group/project");
      });
      // The hydrated-on-mount auto-load re-fetches the list and re-applies the restored selection.
      await waitFor(() => {
        expect(screen.getByTestId("gitlab-import-preview-card")).toBeTruthy();
      });
    });

    it("keeps the existing default remote auto-detect behavior when no state has ever been persisted", async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
      vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce([
        { number: 9, title: "Fresh Issue", body: "", html_url: "https://github.com/dustinbyrne/kb/issues/9", labels: [] },
      ]);

      render(
        <GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} projectId="project-1" presentation="embedded" />,
      );

      // No persisted state exists for this project: the single detected remote is still auto-selected and its issues load.
      await waitFor(() => {
        expect(screen.getByTestId("github-import-single-remote")).toBeTruthy();
        expect(apiFetchGitHubIssues).toHaveBeenCalledWith("dustinbyrne", "kb", 30, undefined);
        expect(screen.getByText("Fresh Issue")).toBeTruthy();
      });
    });

    it("does not leak persisted state across different projects", async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValue(singleRemote);
      vi.mocked(apiFetchGitHubIssues).mockResolvedValue([
        { number: 1, title: "Project One Issue", body: "", html_url: "https://github.com/dustinbyrne/kb/issues/1", labels: [] },
      ]);

      const first = render(
        <GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} projectId="project-1" presentation="embedded" />,
      );
      await waitFor(() => expect(screen.getByText("Project One Issue")).toBeTruthy());
      fireEvent.change(screen.getByPlaceholderText(/Filter:/), { target: { value: "bug" } });
      // The label change re-triggers auto-load (briefly disabling the list); wait for it to settle before selecting.
      await waitFor(() => {
        expect(screen.getByRole("radio", { name: /Select issue #1/i })).not.toBeDisabled();
      });
      fireEvent.click(screen.getByRole("radio", { name: /Select issue #1/i }));
      await waitFor(() => {
        expect(within(screen.getByTestId("github-import-preview-card")).getByText("Project One Issue")).toBeTruthy();
      });
      first.unmount();

      // (project-1's own selection is verified above; now assert isolation for project-2.)
      // A different project must NOT see project-1's persisted filter/selection.
      render(
        <GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} projectId="project-2" presentation="embedded" />,
      );

      await waitFor(() => {
        expect((screen.getByPlaceholderText(/Filter:/) as HTMLInputElement).value).toBe("");
      });
      expect(screen.getByTestId("github-import-preview-empty")).toBeTruthy();
    });

    it("clears gracefully when a persisted selection is no longer present in the reloaded list", async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValue(singleRemote);
      vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce([
        { number: 1, title: "Will Vanish", body: "", html_url: "https://github.com/dustinbyrne/kb/issues/1", labels: [] },
      ]);

      const first = render(
        <GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} projectId="project-1" presentation="embedded" />,
      );
      await waitFor(() => expect(screen.getByText("Will Vanish")).toBeTruthy());
      fireEvent.click(screen.getByRole("radio", { name: /Select issue #1/i }));
      await waitFor(() => {
        expect(within(screen.getByTestId("github-import-preview-card")).getByText("Will Vanish")).toBeTruthy();
      });
      first.unmount();

      // On return, the reloaded list no longer contains issue #1 (e.g. closed/merged/deleted upstream).
      vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce([
        { number: 2, title: "Still Here", body: "", html_url: "https://github.com/dustinbyrne/kb/issues/2", labels: [] },
      ]);

      render(
        <GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} projectId="project-1" presentation="embedded" />,
      );

      // No crash and no stuck preview: the stale selection is dropped and the list/empty-preview state renders cleanly.
      await waitFor(() => {
        expect(screen.getByText("Still Here")).toBeTruthy();
      });
      expect(screen.getByTestId("github-import-preview-empty")).toBeTruthy();
    });

    it("does not strand a restored selection on an empty mobile preview pane after remount", async () => {
      Object.defineProperty(window, "innerWidth", {
        writable: true,
        configurable: true,
        value: 480,
      });
      window.dispatchEvent(new Event("resize"));

      vi.mocked(fetchGitRemotes).mockResolvedValue(singleRemote);
      vi.mocked(apiFetchGitHubIssues).mockResolvedValue([
        { number: 1, title: "Mobile Persisted Issue", body: "", html_url: "https://github.com/dustinbyrne/kb/issues/1", labels: [] },
      ]);

      const first = render(
        <GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} projectId="project-1" presentation="embedded" />,
      );
      await waitFor(() => expect(screen.getByText("Mobile Persisted Issue")).toBeTruthy());
      fireEvent.click(screen.getByRole("radio", { name: /Select issue #1/i }));
      first.unmount();

      render(
        <GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} projectId="project-1" presentation="embedded" />,
      );

      // A fresh mount always starts on the list pane (never the preview pane), so a restored selection can never strand
      // the user staring at a bare/empty preview — the list (with the restored selection re-applied) is visible instead.
      await waitFor(() => {
        const listPane = screen.getByTestId("github-import-list-pane");
        expect(listPane.classList.contains("active")).toBe(true);
        expect(screen.getByTestId("github-import-preview-pane").classList.contains("active")).toBe(false);
      });
      await waitFor(() => {
        const radio = screen.getByRole("radio", { name: /Select issue #1/i }) as HTMLInputElement;
        expect(radio.checked).toBe(true);
      });
    });
  });
});
