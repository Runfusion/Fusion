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
  translateImportContent,
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
    translateImportContent: vi.fn(),
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
    const detailWindow = await screen.findByTestId("floating-window-github-import-detail");
    expect(within(detailWindow).getByTestId("gitlab-import-preview-body")).toHaveTextContent("Body");
    fireEvent.click(screen.getAllByRole("button", { name: "Import" })[0]);

    await waitFor(() => expect(apiImportGitLabProjectIssue).toHaveBeenCalledWith("group/project", 2, undefined));
    expect(onImport).toHaveBeenCalledWith(expect.objectContaining({ id: "FN-099" }));
    const row = screen.getByText(/#2 GitLab bug/).closest("button") as HTMLButtonElement;
    expect(row).toHaveClass("imported");
    expect(row.disabled).toBe(true);
  });

  it("hides the GitLab import provider and keeps GitHub active when GitLab is off", async () => {
    vi.mocked(fetchGitRemotes).mockResolvedValueOnce([]);
    vi.mocked(fetchSettings).mockResolvedValue({ gitlabEnabled: false } as never);

    render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "GitLab" })).toBeNull();
    });
    expect(screen.getByRole("button", { name: "GitHub" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByTestId("gitlab-import-panel")).toBeNull();
    expect(screen.queryByTestId("gitlab-import-disabled")).toBeNull();
    expect(apiFetchGitLabProjectIssues).not.toHaveBeenCalled();
    expect(apiImportGitLabProjectIssue).not.toHaveBeenCalled();
  });

  it("shows the GitLab import provider when GitLab is explicitly enabled", async () => {
    vi.mocked(fetchGitRemotes).mockResolvedValueOnce([]);
    vi.mocked(fetchSettings).mockResolvedValueOnce({ gitlabEnabled: true } as never);

    render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

    expect(await screen.findByRole("button", { name: "GitLab" })).toBeInTheDocument();
  });

  it("shows the GitLab import provider when the GitLab enabled setting is undefined", async () => {
    vi.mocked(fetchGitRemotes).mockResolvedValueOnce([]);
    vi.mocked(fetchSettings).mockResolvedValueOnce({} as never);

    render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

    expect(await screen.findByRole("button", { name: "GitLab" })).toBeInTheDocument();
  });

  it("coerces a persisted GitLab provider to GitHub without auto-loading when GitLab is off", async () => {
    vi.mocked(fetchGitRemotes).mockResolvedValueOnce([]);
    vi.mocked(fetchSettings).mockResolvedValue({ gitlabEnabled: false } as never);
    window.localStorage.setItem(`kb:project-1:${GITHUB_IMPORT_STATE_KEY}`, JSON.stringify({
      provider: "gitlab",
      activeTab: "issues",
      labels: "bug",
      selectedRemoteName: "",
      owner: "",
      repo: "",
      gitlabResource: "project_issue",
      gitlabProject: "group/project",
      gitlabGroup: "",
      selectedIssueNumber: null,
      selectedPullNumber: null,
      selectedGitlabKey: "project_issue:3:2",
    }));

    render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} projectId="project-1" />);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "GitLab" })).toBeNull();
    });
    expect(screen.getByRole("button", { name: "GitHub" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByTestId("gitlab-import-panel")).toBeNull();
    expect(screen.queryByTestId("gitlab-import-disabled")).toBeNull();
    expect(apiFetchGitLabProjectIssues).not.toHaveBeenCalled();
    expect(apiFetchGitLabGroupIssues).not.toHaveBeenCalled();
    expect(apiFetchGitLabMergeRequests).not.toHaveBeenCalled();
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



  it("shows compact toolbar with remote, filter, and load button", async () => {
    vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
    render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

    await waitFor(() => {
      const toolbar = screen.getByTestId("github-import-toolbar");
      expect(toolbar).toBeTruthy();
      // Remote pill should be in toolbar
      expect(within(toolbar).getByTestId("github-import-single-remote")).toBeTruthy();
      /*
      FNXC:GitHubImport 2026-07-15-23:50:
      The filter is a popover now, so its input is absent until the trigger is used — assert the
      trigger instead. Load is icon-only; its accessible name still carries "Load", so the same
      role+name query keeps working and proves the label was not lost for screen readers.
      */
      expect(within(toolbar).getByTestId("github-import-filter-trigger")).toBeTruthy();
      expect(within(toolbar).queryByPlaceholderText(/Filter:/)).toBeNull();
      expect(within(toolbar).getByRole("button", { name: /Load/i })).toBeTruthy();
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

    fireEvent.click(screen.getByRole("button", { name: /Select issue #1/i }));

    const previewCard = await screen.findByTestId("github-import-preview-card");
    expect(within(previewCard).getByText("First Issue")).toBeTruthy();
    expect(within(previewCard).getByText("Body 1")).toBeTruthy();
    expect(screen.queryByTestId("github-import-preview-empty")).toBeNull();
  });

  /*
  FNXC:GitHubImportTranslate 2026-07-14-12:00:
  When selected issue prose is not the dashboard language, the preview must offer Translate / Dismiss and swap title+body after a successful AI translation without changing import provenance.

  FNXC:GitHubImportTranslate 2026-07-15-18:40:
  The swap must cover EVERY surface showing the title, not just the preview card: the detail window's title bar reads from the same translated source, so one item can never display the translated title in the card and the raw upstream title in the bar at the same time. Both surfaces are asserted in both directions (translated, then toggled back).
  */
  it("offers translation when selected issue content is not the dashboard language", async () => {
    const frenchBody =
      "Cette issue décrit le problème avec l'aperçu d'importation et ce que nous devrions changer pour les utilisateurs qui ont du contenu dans une autre langue dans le tableau de bord.";
    const issues = [
      {
        number: 7,
        title: "Problème d'aperçu d'importation",
        body: frenchBody,
        html_url: "https://github.com/owner/repo/issues/7",
        labels: [],
      },
    ];
    vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
    vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce(issues);
    vi.mocked(translateImportContent).mockResolvedValueOnce({
      title: "Import preview problem",
      body: "This issue describes the import preview problem and what we should change for users who have content in another language in the dashboard.",
    });

    render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

    await waitFor(() => {
      expect(screen.getByText(/Problème d'aperçu/)).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /Select issue #7/i }));

    const translateRegion = await screen.findByTestId("github-import-translate");
    expect(translateRegion).toBeTruthy();
    expect(screen.getByTestId("github-import-translate-action")).toBeTruthy();

    fireEvent.click(screen.getByTestId("github-import-translate-action"));

    await waitFor(() => {
      expect(translateImportContent).toHaveBeenCalled();
      expect(screen.getByText("Import preview problem")).toBeTruthy();
    });

    // The detail window's title bar swaps with the card, keeping the issue number paired with the title it belongs to.
    const titleBar = screen.getByTestId("floating-window-drag-handle-github-import-detail");
    expect(titleBar.textContent).toContain("#7 — Import preview problem");
    expect(titleBar.textContent).not.toContain("Problème d'aperçu d'importation");

    expect(screen.getByTestId("github-import-translate-toggle")).toBeTruthy();
    fireEvent.click(screen.getByTestId("github-import-translate-toggle"));
    const previewCard = screen.getByTestId("github-import-preview-card");
    expect(within(previewCard).getByText(/Problème d'aperçu d'importation/)).toBeTruthy();
    // Toggling back to the original must revert the bar too, not strand it on the translation.
    expect(titleBar.textContent).toContain("#7 — Problème d'aperçu d'importation");
  });

  it("does not show translate controls for English content when dashboard language is English", async () => {
    const issues = [
      {
        number: 8,
        title: "Import preview problem",
        body: "This issue describes the problem with the import preview and what we should change for the users that have content in another language when they open the dashboard.",
        html_url: "https://github.com/owner/repo/issues/8",
        labels: [],
      },
    ];
    vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
    vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce(issues);

    render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

    await waitFor(() => {
      expect(screen.getByText("Import preview problem")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /Select issue #8/i }));
    await screen.findByTestId("github-import-preview-card");
    expect(screen.queryByTestId("github-import-translate")).toBeNull();
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

    fireEvent.click(screen.getByRole("button", { name: /Select issue #1/i }));
    let previewCard = await screen.findByTestId("github-import-preview-card");
    expect(within(previewCard).getByText("(no description)")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Select issue #2/i }));
    previewCard = await screen.findByTestId("github-import-preview-card");
    expect(within(previewCard).getByText("(no description)")).toBeTruthy();
  });

  /*
  FNXC:GitHubImport 2026-07-15-23:50:
  The labels filter collapsed into a popover to give the issue list back its vertical space, so the
  input is no longer in the DOM until the trigger is used. This now tests the whole affordance —
  reachable, opens, and still filters — rather than just the input's existence.
  */
  it("reveals the labels filter input from the filter popover", async () => {
    vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
    render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

    await waitFor(() => {
      expect(screen.getByTestId("github-import-filter-trigger")).toBeTruthy();
    });
    // Collapsed by default — this is the vertical space the redesign reclaims.
    expect(screen.queryByPlaceholderText(/Filter:/)).toBeNull();

    fireEvent.click(screen.getByTestId("github-import-filter-trigger"));

    expect(screen.getByTestId("github-import-filter-panel")).toBeTruthy();
    expect(screen.getByPlaceholderText(/Filter:/)).toBeTruthy();
  });

  it("surfaces the active filter on the trigger so collapsing never hides applied state", async () => {
    vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
    render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

    await waitFor(() => expect(screen.getByTestId("github-import-filter-trigger")).toBeTruthy());
    const trigger = screen.getByTestId("github-import-filter-trigger");
    expect(trigger.textContent).toMatch(/Filter/);

    fireEvent.click(trigger);
    fireEvent.change(screen.getByPlaceholderText(/Filter:/), { target: { value: "bug,enhancement" } });

    // The trigger doubles as the readout: a collapsed filter must still be visible state.
    expect(screen.getByTestId("github-import-filter-trigger").textContent).toContain("bug,enhancement");
    expect(screen.getByTestId("github-import-filter-trigger").className).toContain("is-active");
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
        expect(apiFetchGitHubIssues).toHaveBeenCalledWith("dustinbyrne", "kb", 300, undefined);
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
        expect(apiFetchGitHubIssues).toHaveBeenCalledWith("dustinbyrne", "kb", 300, undefined);
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
        expect(apiFetchGitHubIssues).toHaveBeenCalledWith("dustinbyrne", "kb", 300, undefined);
        expect(screen.getByText("Issue from origin")).toBeTruthy();
      });

      fireEvent.change(screen.getByRole("combobox"), { target: { value: "upstream" } });

      await waitFor(() => {
        expect(apiFetchGitHubIssues).toHaveBeenLastCalledWith("upstream", "kb", 300, undefined);
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

    /*
    FNXC:GitHubImport 2026-07-16-16:20:
    Page controls for repos with >1 page (30/page). Asserts page 1 shows only the first 30, the pager reports
    the right page/total, and Next reveals the next page — the behavior missing when the list was capped at 30.
    */
    it("paginates the issue list with Previous/Next controls (30 per page)", async () => {
      const manyIssues = Array.from({ length: 65 }, (_, i) => ({
        number: i + 1, title: `Issue ${i + 1}`, body: `Body ${i + 1}`,
        html_url: `https://github.com/owner/repo/issues/${i + 1}`, labels: [],
      }));
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
      vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce(manyIssues);

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      // Page 1 shows issues 1–30 only.
      await waitFor(() => expect(screen.getByText("Issue 1")).toBeTruthy());
      expect(screen.getByText("Issue 30")).toBeTruthy();
      expect(screen.queryByText("Issue 31")).toBeNull();
      expect(screen.getByText(/Page 1 of 3/)).toBeTruthy();

      // Previous is disabled on the first page; Next advances to page 2 (issues 31–60).
      const prev = screen.getByRole("button", { name: /Previous/i });
      const next = screen.getByRole("button", { name: /Next/i });
      expect((prev as HTMLButtonElement).disabled).toBe(true);

      fireEvent.click(next);
      await waitFor(() => expect(screen.getByText("Issue 31")).toBeTruthy());
      expect(screen.queryByText("Issue 1")).toBeNull();
      expect(screen.getByText("Issue 60")).toBeTruthy();
      expect(screen.getByText(/Page 2 of 3/)).toBeTruthy();
    });

    it("shows no page controls when the issue list fits on one page", async () => {
      const issues = [
        { number: 1, title: "Only Issue", body: "Body", html_url: "https://github.com/owner/repo/issues/1", labels: [] },
      ];
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
      vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce(issues);

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      await waitFor(() => expect(screen.getByText("Only Issue")).toBeTruthy());
      expect(screen.queryByRole("button", { name: /Next/i })).toBeNull();
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

      fireEvent.click(screen.getByRole("button", { name: /Select issue #1/i }));
      fireEvent.click(screen.getByTestId("github-import-action-top"));

      await waitFor(() => {
        expect(apiImportGitHubIssue).toHaveBeenCalledWith("dustinbyrne", "kb", 1, "project-1", "en");
        expect(onImport).toHaveBeenCalledWith(mockTask);
        expect(onClose).not.toHaveBeenCalled();
        expect(screen.getByText("Import from GitHub")).toBeTruthy();
        const row = screen.getByText("First Issue").closest(".issue-item") as HTMLElement;
        expect(row).toHaveClass("imported");
        expect(within(row).getByText("Imported")).toBeTruthy();
        expect(screen.getByRole("button", { name: /Select issue #1/i })).toBeDisabled();
        expect(screen.getByText("1 imported")).toBeTruthy();
      });
    });

    it("preserves optimistic imports across GitHub tabs and clears them after a provider switch", async () => {
      const issues = [
        { number: 1, title: "Context Issue", body: "Body", html_url: "https://github.com/owner/repo/issues/1", labels: [] },
      ];
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce([{ name: "origin", owner: "owner", repo: "repo", url: "" }]);
      vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce(issues).mockResolvedValueOnce(issues);
      vi.mocked(apiFetchGitHubPulls).mockResolvedValueOnce(mockPulls);
      vi.mocked(apiImportGitHubIssue).mockResolvedValueOnce(mockTask);

      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);
      await screen.findByText("Context Issue");
      fireEvent.click(screen.getByRole("button", { name: /Select issue #1/i }));
      fireEvent.click(screen.getByTestId("github-import-action-top"));
      await waitFor(() => expect(screen.getByText("Context Issue").closest(".issue-item")).toHaveClass("imported"));

      fireEvent.click(screen.getByRole("tab", { name: /Pull Requests/i }));
      await screen.findByText("Test PR");
      fireEvent.click(screen.getByRole("tab", { name: /Issues/i }));
      await screen.findByText("Context Issue");
      expect(screen.getByText("Context Issue").closest(".issue-item")).toHaveClass("imported");

      fireEvent.click(await screen.findByRole("button", { name: "GitLab" }));
      fireEvent.click(screen.getByRole("button", { name: "GitHub" }));
      await waitFor(() => expect(screen.getByText("Context Issue").closest(".issue-item")).not.toHaveClass("imported"));
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
      const row = screen.getByRole("button", { name: /Select issue #3/i });
      fireEvent.click(row);
      expect(await screen.findByTestId("github-import-preview-card")).toHaveTextContent("Retry Issue");

      fireEvent.click(screen.getByTestId("github-import-action-top"));

      await waitFor(() => {
        expect(screen.getByText("already imported elsewhere")).toBeTruthy();
        expect(row).toHaveClass("selected");
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

    it("disables list rows for already imported issues", async () => {
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
        const row = screen.getByRole("button", { name: /Select issue #1/i });
        expect(row).toBeDisabled();
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
        expect(apiFetchGitHubIssues).toHaveBeenCalledWith("dustinbyrne", "kb", 300, undefined);
        expect(screen.getByText("Issue without labels")).toBeTruthy();
      });

      // Enter label filter — the input now lives behind the filter popover trigger.
      fireEvent.click(screen.getByTestId("github-import-filter-trigger"));
      const labelsInput = screen.getByPlaceholderText(/Filter:/);
      fireEvent.change(labelsInput, { target: { value: "bug" } });

      // Find and click the Load button by id (more reliable)
      const loadButton = screen.getByTestId("github-import-toolbar").querySelector("#gh-load") as HTMLButtonElement;
      fireEvent.click(loadButton);

      // Verify re-fetch with labels
      await waitFor(() => {
        expect(apiFetchGitHubIssues).toHaveBeenLastCalledWith("dustinbyrne", "kb", 300, ["bug"]);
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

      fireEvent.click(screen.getByRole("button", { name: /Select pull request #7/i }));

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
      fireEvent.click(screen.getByRole("button", { name: /Select pull request #11/i }));

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
      fireEvent.click(screen.getByRole("button", { name: /Select pull request #13/i }));

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

      fireEvent.click(screen.getByRole("button", { name: /Select pull request #9/i }));

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

      fireEvent.click(screen.getByRole("button", { name: /Select issue #7/i }));

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
      const row = screen.getByRole("button", { name: /Select issue #8/i });
      fireEvent.click(row);
      expect(await screen.findByTestId("github-import-preview-card")).toHaveTextContent("Close Retry Issue");

      fireEvent.click(await screen.findByTestId("github-import-issue-close"));

      await waitFor(() => {
        expect(apiCloseGitHubIssue).toHaveBeenCalledWith("dustinbyrne/kb", 8);
        expect(screen.getByTestId("github-import-issue-close-toast")).toHaveTextContent("close failed");
        expect(row).toHaveClass("selected");
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

      fireEvent.click(screen.getByRole("button", { name: /Select issue #1/i }));

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

      fireEvent.click(screen.getByRole("button", { name: /Select pull request #1/i }));

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

      fireEvent.click(screen.getByRole("button", { name: /Select issue #7/i }));

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

    it("shows filter control for Issues tab, hint text for Pulls tab", async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
      render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

      await waitFor(() => {
        // Default is Issues tab. The filter is a popover now, so assert its trigger.
        expect(screen.getByTestId("github-import-filter-trigger")).toBeTruthy();
      });

      // Click on Pull Requests tab
      fireEvent.click(screen.getByRole("tab", { name: /Pull Requests/i }));

      await waitFor(() => {
        // Should show hint text instead of the filter control (trigger AND input both gone).
        expect(screen.queryByTestId("github-import-filter-trigger")).toBeNull();
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
      fireEvent.click(screen.getByRole("button", { name: /Select pull request #1/i }));

      // Preview should show with branch info
      const previewCard = await screen.findByTestId("github-import-preview-card");
      expect(within(previewCard).getByText("Test PR")).toBeTruthy();
      expect(within(previewCard).getByText(/feature → main/)).toBeTruthy();
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
      fireEvent.click(screen.getByRole("button", { name: /Select pull request #1/i }));

      // Click Import
      fireEvent.click(screen.getByTestId("github-import-action-top"));

      await waitFor(() => {
        expect(apiImportGitHubPull).toHaveBeenCalledWith("dustinbyrne", "kb", 1, "project-1");
        expect(onImport).toHaveBeenCalledWith(mockPRTask);
        expect(onClose).not.toHaveBeenCalled();
        expect(screen.getByText("Import from GitHub")).toBeTruthy();
        const row = screen.getByText("Test PR").closest(".issue-item") as HTMLElement;
        expect(row).toHaveClass("imported");
        expect(within(row).getByText("Imported")).toBeTruthy();
        expect(screen.getByRole("button", { name: /Select pull request #1/i })).toBeDisabled();
        expect(screen.getByText("1 imported")).toBeTruthy();
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

    it("disables list rows for already imported PRs", async () => {
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
        const row = screen.getByRole("button", { name: /Select pull request #1/i });
        expect(row).toBeDisabled();
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

      // FN-8004-era redesign: the filter input lives behind a popover trigger now.
      fireEvent.click(screen.getByTestId("github-import-filter-trigger"));
      fireEvent.change(screen.getByPlaceholderText(/Filter:/), { target: { value: "bug" } });
      // The label change re-triggers auto-load (briefly disabling the list); wait for it to settle before selecting.
      await waitFor(() => {
        expect(screen.getByRole("button", { name: /Select issue #1/i })).not.toBeDisabled();
      });
      fireEvent.click(screen.getByRole("button", { name: /Select issue #1/i }));

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
        /*
        FNXC:GitHubImport 2026-07-15-23:55:
        Assert restoration via the collapsed trigger rather than by reopening the popover. The
        trigger renders the persisted filter, so this proves BOTH that FN-7657 persistence survived
        the remount AND that a restored filter is visible without the operator hunting for it — the
        real risk when a control collapses.
        */
        expect(screen.getByTestId("github-import-filter-trigger").textContent).toContain("bug");
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
      fireEvent.click(screen.getByRole("button", { name: /Select pull request #1/i }));
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
        const preview = screen.getByTestId("gitlab-import-preview-card");
        expect(preview).toBeTruthy();
        expect(preview.closest(".github-import-detail-panel")).toBeTruthy();
        expect(preview.closest(".github-import-detail-panel")?.querySelector(".github-import-detail-actions")).toBeTruthy();
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
        expect(apiFetchGitHubIssues).toHaveBeenCalledWith("dustinbyrne", "kb", 300, undefined);
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
      // FN-8004-era redesign: the filter input lives behind a popover trigger now.
      fireEvent.click(screen.getByTestId("github-import-filter-trigger"));
      fireEvent.change(screen.getByPlaceholderText(/Filter:/), { target: { value: "bug" } });
      // The label change re-triggers auto-load (briefly disabling the list); wait for it to settle before selecting.
      await waitFor(() => {
        expect(screen.getByRole("button", { name: /Select issue #1/i })).not.toBeDisabled();
      });
      fireEvent.click(screen.getByRole("button", { name: /Select issue #1/i }));
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
        expect(screen.getByTestId("github-import-filter-trigger").textContent).not.toContain("bug");
      });
      expect(screen.queryByTestId("floating-window-github-import-detail")).toBeNull();
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
      fireEvent.click(screen.getByRole("button", { name: /Select issue #1/i }));
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
      expect(screen.queryByTestId("floating-window-github-import-detail")).toBeNull();
    });


  });

  /*
  FNXC:GitHubImport 2026-07-15-16:35:
  The full-width candidate list must open every provider's detail in the shared FloatingWindow rather than restoring
  the removed split preview pane. These checks keep desktop resize delegation and mobile-sheet CSS scoped together.
  */
  it("opens a GitHub issue detail window with desktop resize handles and clears it on close", async () => {
    vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
    vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce([
      { number: 12, title: "Windowed issue", body: "Windowed issue body", html_url: "https://github.com/owner/repo/issues/12", labels: [] },
    ]);
    render(<GitHubImportModal isOpen onClose={onClose} onImport={onImport} tasks={[]} />);
    await screen.findByText("Windowed issue");
    fireEvent.click(screen.getByRole("button", { name: /select issue #12/i }));
    const detail = await screen.findByTestId("floating-window-github-import-detail");
    expect(within(detail).getByText("Windowed issue body")).toBeTruthy();
    expect(within(detail).getByTestId("github-import-action-top")).toBeTruthy();
    expect(detail.querySelector(".github-import-detail-panel .github-import-detail-actions")).toBeTruthy();
    expect(detail.querySelectorAll(".floating-window__resize-handle")).toHaveLength(8);
    fireEvent.click(within(detail).getByTestId("floating-window-close-github-import-detail"));
    await waitFor(() => expect(screen.queryByTestId("floating-window-github-import-detail")).toBeNull());
  });

  it("opens pull-request detail with fetched checks and comments in the FloatingWindow", async () => {
    vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
    vi.mocked(apiFetchGitHubPulls).mockResolvedValueOnce([mockPulls[0]]);
    vi.mocked(apiFetchGitHubPullDetail).mockResolvedValueOnce({ checks: [{ name: "build", status: "completed", conclusion: "success" }], comments: [{ id: 1, body: "Looks good", user: { login: "reviewer", type: "User" } }] } as never);
    render(<GitHubImportModal isOpen onClose={onClose} onImport={onImport} tasks={[]} />);
    fireEvent.click(screen.getByRole("tab", { name: /pull requests/i }));
    await screen.findByText("Test PR");
    fireEvent.click(screen.getByRole("button", { name: /select pull request #1/i }));
    const detail = await screen.findByTestId("floating-window-github-import-detail");
    expect(within(detail).getByTestId("github-import-action-top")).toBeTruthy();
    expect(detail.querySelector(".github-import-detail-panel .github-import-detail-actions")).toBeTruthy();
    expect(within(detail).getByTestId("github-import-pr-checks")).toBeTruthy();
    expect(await within(detail).findByText("Looks good")).toBeTruthy();
  });

  it("keeps both presentations free of the removed split-pane shells", async () => {
    vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
    const { unmount } = render(<GitHubImportModal isOpen onClose={onClose} onImport={onImport} tasks={[]} presentation="embedded" />);
    await screen.findByTestId("github-import-list-pane");
    expect(document.querySelector(".github-import-preview-pane")).toBeNull();
    expect(document.querySelector(".github-import-resize-handle")).toBeNull();
    unmount();
    vi.mocked(fetchGitRemotes).mockResolvedValueOnce(singleRemote);
    render(<GitHubImportModal isOpen onClose={onClose} onImport={onImport} tasks={[]} presentation="modal" />);
    await screen.findByTestId("github-import-list-pane");
    expect(document.querySelector(".github-import-preview-pane")).toBeNull();
    expect(document.querySelector(".github-import-resize-handle")).toBeNull();
  });

  it("keeps every provider detail panel padded with tokenized bottom actions", () => {
    const source = readFileSync(resolve(__dirname, "../GitHubImportModal.css"), "utf8");
    const detailPanelRule = source.match(/\.github-import-detail-panel\s*\{[^}]*\}/)?.[0] ?? "";
    const actionRowRule = source.match(/\.github-import-detail-actions\s*\{[^}]*\}/)?.[0] ?? "";

    expect(detailPanelRule).toContain("padding: var(--space-lg);");
    expect(actionRowRule).toContain("flex-wrap: wrap;");
    expect(actionRowRule).toContain("gap: var(--space-sm);");
  });

  it("scopes the import detail FloatingWindow as the shared mobile full-screen sheet", () => {
    const source = readFileSync(resolve(__dirname, "../FloatingWindow.css"), "utf8");
    const chatSheetRule = source.match(/\.floating-window--chat\s*\{([^}]*)\}/)?.[1] ?? "";
    const importSheetRule = source.match(/\.floating-window--github-import-detail\s*\{([^}]*)\}/)?.[1] ?? "";
    const taskSheetRule = source.match(/\.floating-window--task-detail\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(importSheetRule).toBe(chatSheetRule);
    expect(importSheetRule).toBe(taskSheetRule);
    expect(importSheetRule).toContain("inset: 0 !important;");
    expect(source).toMatch(/@media \(max-width: 768px\)[\s\S]*\.floating-window--github-import-detail \.floating-window__resize-handle\s*\{\s*display: none;/);
    expect(source).toContain(".floating-window:not(.floating-window--chat):not(.floating-window--github-import-detail)");
  });

  describe("Hide imported", () => {
    const issueItems = [
      { number: 1, title: "Imported issue", body: "", html_url: "https://github.com/owner/repo/issues/1", labels: [] },
      { number: 2, title: "Available issue", body: "", html_url: "https://github.com/owner/repo/issues/2", labels: [] },
    ];
    const gitlabItems = [
      { resourceKind: "project_issue" as const, id: 1, iid: 1, projectId: 3, projectPath: "group/project", title: "Imported GitLab item", description: "", webUrl: "https://gitlab.example.com/group/project/-/issues/1", state: "opened", labels: [] },
      { resourceKind: "project_issue" as const, id: 2, iid: 2, projectId: 3, projectPath: "group/project", title: "Available GitLab item", description: "", webUrl: "https://gitlab.example.com/group/project/-/issues/2", state: "opened", labels: [] },
    ];

    it("filters imported issues and pulls without changing their full imported counts", async () => {
      const importedIssueTask = { ...mockTask, description: "Source: https://github.com/owner/repo/issues/1" };
      const importedPullTask = { ...mockPRTask, description: "PR: https://github.com/owner/repo/pull/1" };
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce([{ name: "origin", owner: "owner", repo: "repo", url: "" }]);
      vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce(issueItems);
      vi.mocked(apiFetchGitHubPulls).mockResolvedValueOnce(mockPulls);
      render(<GitHubImportModal isOpen onClose={onClose} onImport={onImport} tasks={[importedIssueTask, importedPullTask]} projectId="project-1" />);

      await screen.findByText("Imported issue");
      const toggle = screen.getByRole("checkbox", { name: /hide imported/i });
      fireEvent.click(toggle);
      expect(screen.queryByText("Imported issue")).toBeNull();
      expect(screen.getByText("Available issue")).toBeTruthy();
      expect(screen.getByText("1 imported")).toBeTruthy();
      fireEvent.click(toggle);
      expect(await screen.findByText("Imported issue")).toBeTruthy();
      expect(screen.getByText("Imported issue").closest(".issue-item")).toHaveClass("imported");

      fireEvent.click(screen.getByRole("tab", { name: /pull requests/i }));
      await screen.findByText("Test PR");
      fireEvent.click(screen.getByRole("checkbox", { name: /hide imported/i }));
      expect(screen.queryByText("Test PR")).toBeNull();
      expect(screen.getByText("Another PR")).toBeTruthy();
    });

    it("persists the toggle per project and clears a selection that becomes hidden", async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValue([{ name: "origin", owner: "owner", repo: "repo", url: "" }]);
      vi.mocked(apiFetchGitHubIssues).mockResolvedValue(issueItems);
      const view = render(<GitHubImportModal isOpen onClose={onClose} onImport={onImport} tasks={[]} projectId="project-1" />);
      await screen.findByText("Imported issue");
      fireEvent.click(screen.getByRole("button", { name: /select issue #1/i }));
      expect(await screen.findByTestId("github-import-preview-card")).toHaveTextContent("Imported issue");
      view.rerender(<GitHubImportModal isOpen onClose={onClose} onImport={onImport} tasks={[{ ...mockTask, description: "Source: https://github.com/owner/repo/issues/1" }]} projectId="project-1" />);
      fireEvent.click(screen.getByTestId("github-import-hide-imported-toggle"));
      await waitFor(() => expect(screen.queryByTestId("github-import-preview-card")).toBeNull());
      view.unmount();

      render(<GitHubImportModal isOpen onClose={onClose} onImport={onImport} tasks={[]} projectId="project-1" />);
      await screen.findByText("Imported issue");
      expect(screen.getByTestId("github-import-hide-imported-toggle")).toBeChecked();
    });

    it("filters GitLab rows and renders a dedicated all-imported state for every provider", async () => {
      const importedGitlabTask = { ...mockTask, description: "Source: https://gitlab.example.com/group/project/-/issues/1" };
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce([]);
      vi.mocked(apiFetchGitLabProjectIssues).mockResolvedValueOnce(gitlabItems);
      const filteredView = render(<GitHubImportModal isOpen onClose={onClose} onImport={onImport} tasks={[importedGitlabTask]} projectId="project-2" />);
      fireEvent.click(await screen.findByRole("button", { name: "GitLab" }));
      fireEvent.change(screen.getByLabelText("GitLab project path or ID"), { target: { value: "group/project" } });
      fireEvent.click(screen.getByRole("button", { name: "Load" }));
      await screen.findByText(/Imported GitLab item/);
      fireEvent.click(screen.getByTestId("github-import-hide-imported-toggle"));
      expect(screen.queryByText(/Imported GitLab item/)).toBeNull();
      expect(screen.getByText(/Available GitLab item/)).toBeTruthy();

      const allImportedTask = { ...mockTask, description: "Source: https://gitlab.example.com/group/project/-/issues/2" };
      filteredView.unmount();
      window.localStorage.removeItem(`kb:project-2:${GITHUB_IMPORT_STATE_KEY}`);
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce([]);
      vi.mocked(apiFetchGitLabProjectIssues).mockResolvedValueOnce(gitlabItems);
      render(<GitHubImportModal isOpen onClose={onClose} onImport={onImport} tasks={[importedGitlabTask, allImportedTask]} projectId="project-a" />);
      fireEvent.click(await screen.findByRole("button", { name: "GitLab" }));
      fireEvent.change(screen.getByLabelText("GitLab project path or ID"), { target: { value: "group/project" } });
      fireEvent.click(screen.getByRole("button", { name: "Load" }));
      fireEvent.click(await screen.findByTestId("github-import-hide-imported-toggle"));
      expect(await screen.findByTestId("github-import-all-imported-empty")).toHaveTextContent("All loaded items are already imported");
    });

    it("keeps the shared toggle reachable and functional at the mobile breakpoint", async () => {
      const originalInnerWidth = window.innerWidth;
      Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 480 });
      window.dispatchEvent(new Event("resize"));
      const importedIssueTask = { ...mockTask, description: "Source: https://github.com/owner/repo/issues/1" };
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce([{ name: "origin", owner: "owner", repo: "repo", url: "" }]);
      vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce(issueItems);
      const view = render(<GitHubImportModal isOpen onClose={onClose} onImport={onImport} tasks={[importedIssueTask]} projectId="project-b" />);
      await screen.findByText("Imported issue");
      fireEvent.click(screen.getByTestId("github-import-hide-imported-toggle"));
      expect(screen.queryByText("Imported issue")).toBeNull();
      expect(screen.getByText("Available issue")).toBeTruthy();
      view.unmount();

      window.localStorage.removeItem(`kb:project-b:${GITHUB_IMPORT_STATE_KEY}`);
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce([]);
      vi.mocked(apiFetchGitLabProjectIssues).mockResolvedValueOnce(gitlabItems);
      render(<GitHubImportModal isOpen onClose={onClose} onImport={onImport} tasks={[{ ...mockTask, description: "Source: https://gitlab.example.com/group/project/-/issues/1" }]} projectId="project-b" />);
      fireEvent.click(await screen.findByRole("button", { name: "GitLab" }));
      fireEvent.change(screen.getByLabelText("GitLab project path or ID"), { target: { value: "group/project" } });
      fireEvent.click(screen.getByRole("button", { name: "Load" }));
      await screen.findByText(/Imported GitLab item/);
      fireEvent.click(screen.getByTestId("github-import-hide-imported-toggle"));
      expect(screen.queryByText(/Imported GitLab item/)).toBeNull();
      expect(screen.getByText(/Available GitLab item/)).toBeTruthy();
      Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: originalInnerWidth });
      window.dispatchEvent(new Event("resize"));
    });
  });

/*
FNXC:GitHubImport 2026-07-16-00:05:

## Symptom Verification

Original symptom (mobile operator report): the import screen spent ~4 rows on chrome — a provider
row, a tab row, and a boxed ORIGIN/filter/Load stack — leaving ~9 issues visible; and Import lived
ABOVE the preview it acts on, while a second Import in the list footer let you import an issue whose
body you had never opened.

Assertion it is gone: verified in a real browser at 412px (jsdom has no layout, so these tests pin
STRUCTURE and BEHAVIOUR, not geometry). Post-change measurements: control chrome 93px -> 70px (two
rows), toolbar a single 36px row, ~13 issues visible, filter popover clamped inside the viewport,
and the detail action bar sitting below the preview content with an unclipped Import label.

## Surface Enumeration

- Issues tab AND Pull Requests tab (the filter exists only on Issues; the detail bar serves both).
- List footer (Cancel only) vs detail bar (the sole Import).
- Filter collapsed vs open, and the restored-from-persistence case (FN-7657).
- Close issue stays hidden on the PR tab and for already-closed issues — unchanged by the move.
*/
describe("GitHubImportModal — compact mobile layout (operator report)", () => {
  // Inherits the suite's beforeEach (mock reset + defaults); only the remote needs pinning here.
  beforeEach(() => {
    vi.mocked(fetchGitRemotes).mockResolvedValue(singleRemote);
  });

  it("puts provider, type tabs, origin, filter and load in ONE control row", async () => {
    render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

    const controls = await screen.findByTestId("github-import-controls");
    // The row is the whole point: chrome that used to be four stacked bands is one container.
    expect(within(controls).getByRole("button", { name: "GitHub" })).toBeTruthy();
    expect(within(controls).getByRole("tab", { name: /Issues/i })).toBeTruthy();
    expect(within(controls).getByRole("tab", { name: /Pull Requests/i })).toBeTruthy();
    await waitFor(() => {
      expect(within(controls).getByTestId("github-import-single-remote")).toBeTruthy();
    });
    expect(within(controls).getByTestId("github-import-filter-trigger")).toBeTruthy();
    expect(within(controls).getByRole("button", { name: /Load/i })).toBeTruthy();
  });

  it("keeps Load reachable by name even though it is icon-only", async () => {
    render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);
    await waitFor(() => expect(screen.getByTestId("github-import-toolbar")).toBeTruthy());

    // Dropping the visible label must not drop the accessible name.
    const load = screen.getByRole("button", { name: /Load/i });
    expect(load.textContent?.trim()).toBe("");
    expect(load.getAttribute("aria-label")).toMatch(/Load/i);
  });

  it("keeps origin visible rather than hiding it inside the filter popover", async () => {
    render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);

    // Operator decision: origin is context for what you are importing, so it must stay on the row.
    const remote = await screen.findByTestId("github-import-single-remote");
    expect(remote.textContent).toContain("dustinbyrne/kb");
    expect(screen.queryByTestId("github-import-filter-panel")).toBeNull();
  });

  it("closes the filter popover on Escape without closing the modal", async () => {
    render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);
    await waitFor(() => expect(screen.getByTestId("github-import-filter-trigger")).toBeTruthy());

    fireEvent.click(screen.getByTestId("github-import-filter-trigger"));
    expect(screen.getByTestId("github-import-filter-panel")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });

    // The popover is the innermost layer: Escape dismisses IT, and must not also close the modal.
    expect(screen.queryByTestId("github-import-filter-panel")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("offers Import ONLY in the detail preview, never in the list footer", async () => {
    render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);
    await waitFor(() => expect(screen.getByTestId("github-import-toolbar")).toBeTruthy());

    /*
    Two Imports (footer + preview) split the action across two places and let an operator import an
    issue sight-unseen. The footer keeps Cancel — the modal still needs a dismiss — but Import is
    now exclusively the detail bar's.
    */
    const footer = document.querySelector(".github-import-modal__actions");
    expect(footer).toBeTruthy();
    const footerButtons = [...footer!.querySelectorAll("button")].map((b) => b.textContent?.trim());
    expect(footerButtons).toEqual(["Cancel"]);
    expect(footerButtons).not.toContain("Import");
  });
});

describe("GitHubImportModal — detail actions sit at the bottom (operator report)", () => {
  // Inherits the suite's beforeEach (mock reset + defaults); only the remote needs pinning here.
  beforeEach(() => {
    vi.mocked(fetchGitRemotes).mockResolvedValue(singleRemote);
  });

  const openDetail = async () => {
    vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce([
      { number: 1, title: "First Issue", body: "Body 1", html_url: "https://github.com/dustinbyrne/kb/issues/1", labels: [], state: "open" },
    ]);
    render(<GitHubImportModal isOpen={true} onClose={onClose} onImport={onImport} tasks={[]} />);
    await waitFor(() => expect(screen.getByText("First Issue")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Select issue #1/i }));
    return screen.findByTestId("github-import-preview-card");
  };

  it("renders Import and Close issue AFTER the preview content, not above it", async () => {
    await openDetail();

    const bar = await screen.findByTestId("github-import-detail-actions");
    const content = document.querySelector(".github-import-pane-content");
    expect(content).toBeTruthy();

    /*
    The operator's ask: commit actions belong below the content they act on. jsdom has no layout, so
    assert DOM ORDER — the bar must follow the content — which is what the CSS then pins to the
    bottom of the flex panel. Geometry itself was verified in a real browser at 412px.
    */
    expect(content!.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(bar).getByRole("button", { name: /^Import$/i })).toBeTruthy();
    expect(within(bar).getByTestId("github-import-issue-close")).toBeTruthy();
  });

  it("leaves no action buttons stranded in the preview header", async () => {
    await openDetail();
    await screen.findByTestId("github-import-detail-actions");

    /*
    Guard against the FN-6115-style empty shell: the DETAIL header must be a heading now, nothing
    else. Scope to `.github-import-detail-panel` — `.github-import-pane-header` is shared with the
    LIST pane, so an unscoped query silently asserts against the wrong header.
    */
    const header = document.querySelector(".github-import-detail-panel .github-import-pane-header");
    expect(header).toBeTruthy();
    expect(header!.textContent).toContain("Preview");
    expect(header!.querySelectorAll("button").length).toBe(0);
  });

  it("keeps Close issue off the Pull Requests tab", async () => {
    await openDetail();
    await screen.findByTestId("github-import-detail-actions");
    expect(screen.getByTestId("github-import-issue-close")).toBeTruthy();

    vi.mocked(apiFetchGitHubPulls).mockResolvedValueOnce([]);
    fireEvent.click(screen.getByRole("tab", { name: /Pull Requests/i }));

    // Moving the buttons must not change WHEN close-issue is offered.
    await waitFor(() => {
      expect(screen.queryByTestId("github-import-issue-close")).toBeNull();
    });
  });
});
});
