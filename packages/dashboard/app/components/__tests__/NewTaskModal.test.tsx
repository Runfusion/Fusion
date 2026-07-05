import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { readFileSync } from "node:fs";
import { NewTaskModal } from "../NewTaskModal";
import type { Task, Column } from "@fusion/core";
import { apiFetchGitHubIssues, apiFetchGitHubPulls, checkDuplicateTasks, fetchAgents, fetchGitRemotes, type BoardWorkflowsPayload } from "../../api";
import { writeBoardWorkflowsCache } from "../../utils/boardWorkflowsCache";
import { writeLastSelectedWorkflowId } from "../../utils/lastSelectedWorkflow";
import { GITHUB_SETUP_WARNING_DELAY_MS, GITHUB_SETUP_WARNING_MISSING_SINCE_KEY } from "../../hooks/useGithubSetupWarningDelay";
import { __test_clearCache as clearSetupReadinessCache } from "../../hooks/useSetupReadiness";
import { scopedKey } from "../../utils/projectStorage";

const newTaskModalCss = readFileSync("app/components/NewTaskModal.css", "utf8");

// Mock lucide-react
vi.mock("lucide-react", () => ({
  Sparkles: () => null,
  Globe: () => null,
  ChevronUp: () => null,
  ChevronDown: () => null,
  X: () => null,
  Bot: () => null,
  Maximize2: () => null,
  Minimize2: () => null,
  Workflow: () => null,
  Paperclip: () => null,
  Flag: () => null,
  Zap: () => null,
  Brain: () => null,
  Server: () => null,
  Cpu: () => null,
}));

vi.mock("../ProviderIcon", () => ({
  ProviderIcon: ({ provider }: { provider: string }) => <span data-testid={`provider-icon-${provider}`} />,
}));

// Mock the api module
vi.mock("../../api", () => ({
  uploadAttachment: vi.fn().mockResolvedValue({}),
  checkDuplicateTasks: vi.fn().mockResolvedValue([]),
  fetchGitRemotes: vi.fn().mockResolvedValue([]),
  apiFetchGitHubIssues: vi.fn().mockResolvedValue([]),
  apiFetchGitHubPulls: vi.fn().mockResolvedValue([]),
  fetchModels: vi.fn().mockResolvedValue({ models: [
    { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true, contextWindow: 200000 },
    { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
  ], favoriteProviders: [] }),
  fetchSettings: vi.fn().mockResolvedValue({
    modelPresets: [],
    autoSelectModelPreset: false,
    defaultPresetBySize: {},
  }),
  // U6/R3: TaskForm's picker fetches whole workflows; the per-step
  // fetchWorkflowSteps + post-create selectTaskWorkflow flow is gone.
  fetchWorkflows: vi.fn().mockResolvedValue([]),
  fetchWorkflowOptionalSteps: vi.fn().mockResolvedValue([]),
  fetchGlobalSettings: vi.fn().mockResolvedValue({}),
  fetchGitBranches: vi.fn().mockResolvedValue([]),
  fetchAgents: vi.fn().mockResolvedValue([]),
  fetchAuthStatus: vi.fn().mockResolvedValue({ providers: [] }),
  refineText: vi.fn(),
  getRefineErrorMessage: vi.fn((err) => err?.message || "Failed to refine text. Please try again."),
  updateGlobalSettings: vi.fn().mockResolvedValue({}),
}));

const mockConfirm = vi.fn();

vi.mock("../../hooks/useConfirm", () => ({
  useConfirm: () => ({ confirm: mockConfirm }),
}));

const mockUseMobileKeyboard = vi.fn();
vi.mock("../../hooks/useMobileKeyboard", () => ({
  useMobileKeyboard: (...args: unknown[]) => mockUseMobileKeyboard(...args),
}));

// FNXC:NewTask 2026-06-22-20:30: viewport mode is switchable so we can exercise both the mobile sheet (default) and the desktop floating window. Defaults to mobile to preserve the existing suite's layout assumptions.
let mockViewportMode: "mobile" | "desktop" = "mobile";
vi.mock("../../hooks/useViewportMode", () => ({
  MOBILE_MEDIA_QUERY: "(max-width: 768px), (max-height: 480px)",
  getViewportMode: () => mockViewportMode,
  isMobileViewport: () => mockViewportMode === "mobile",
  useViewportMode: () => mockViewportMode,
}));

function makeTask(id: string): Task {
  return {
    id,
    title: `Task ${id}`,
    description: `Description for ${id}`,
    column: "todo" as Column,
    status: undefined as any,
    steps: [],
    currentStep: 0,
    dependencies: [],
    log: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}


async function chooseWorkflowOption(value: string) {
  const trigger = await screen.findByTestId("task-workflow-dropdown-trigger");
  fireEvent.click(trigger);
  const optionTestId = value === "__none__" ? "task-workflow-option-none" : `task-workflow-option-${value}`;
  fireEvent.click(await screen.findByTestId(optionTestId));
}

async function openWorkflowDropdown() {
  const trigger = await screen.findByTestId("task-workflow-dropdown-trigger");
  fireEvent.click(trigger);
  return screen.findByTestId("task-workflow-dropdown-menu");
}

function renderNewTaskModal(props: Partial<ComponentProps<typeof NewTaskModal>> = {}) {
  const defaultProps: ComponentProps<typeof NewTaskModal> = {
    isOpen: true,
    onClose: vi.fn(),
    tasks: [] as Task[],
    onCreateTask: vi.fn().mockResolvedValue(makeTask("FN-001")),
    addToast: vi.fn(),
  };
  const mergedProps = { ...defaultProps, ...props };
  const result = render(<NewTaskModal {...mergedProps} />);
  return { ...result, props: mergedProps };
}

describe("NewTaskModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSetupReadinessCache();
    mockViewportMode = "mobile";
    mockConfirm.mockReset();
    mockConfirm.mockResolvedValue(true);
    vi.mocked(checkDuplicateTasks).mockResolvedValue([]);
    vi.mocked(fetchGitRemotes).mockResolvedValue([]);
    vi.mocked(apiFetchGitHubIssues).mockResolvedValue([]);
    vi.mocked(apiFetchGitHubPulls).mockResolvedValue([]);
    window.localStorage.clear();
    mockUseMobileKeyboard.mockReturnValue({
      keyboardOpen: false,
      keyboardOverlap: 0,
      viewportHeight: null,
      viewportOffsetTop: 0,
    });
  });

  it("applies keyboard CSS variables when mobile keyboard is open", () => {
    mockUseMobileKeyboard.mockReturnValue({
      keyboardOpen: true,
      keyboardOverlap: 250,
      viewportHeight: 400,
      viewportOffsetTop: 50,
    });

    renderNewTaskModal();
    // FNXC: NewTaskModal portals to document.body, so query the modal from document (not the render container).
    const modal = document.querySelector(".new-task-modal");

    expect(mockUseMobileKeyboard).toHaveBeenCalledWith({ enabled: true });
    expect(modal?.getAttribute("style")).toContain("--keyboard-overlap: 250px");
    expect(modal?.getAttribute("style")).toContain("--vv-height: 400px");
    expect(modal?.getAttribute("style")).toContain("--vv-offset-top: 50px");
  });

  it("does not apply keyboard CSS variables when keyboard is closed", () => {
    const { container } = renderNewTaskModal();
    const modal = container.querySelector(".new-task-modal");

    expect(mockUseMobileKeyboard).toHaveBeenCalledWith({ enabled: true });
    expect(modal?.getAttribute("style") ?? "").not.toContain("--keyboard-overlap");
  });

  it("renders all form fields when open", async () => {
    renderNewTaskModal();

    expect(screen.getByText("New Task")).toBeTruthy();
    expect(screen.getByPlaceholderText("What needs to be done?")).toBeTruthy();
    // Without AI-handoff callbacks there is no Plan/Subtask button…
    expect(screen.queryByTestId("task-form-plan-button")).toBeNull();
    expect(screen.queryByTestId("task-form-subtask-button")).toBeNull();
    // …but FNXC:NewTask 2026-06-23-00:10: the inline quick-add action row still renders in create mode to host Attach/Fast/Priority.
    expect(screen.getByTestId("task-form-description-actions")).toBeInTheDocument();

    // Dependencies and agent are in quick-fields — visible by default (no toggle needed)
    expect(screen.getByTestId("dep-trigger")).toBeInTheDocument();
    expect(screen.getByTestId("new-task-agent-button")).toBeInTheDocument();

    // FNXC:NewTaskDialogAffordances 2026-06-23-21:47: The regular New Task dialog exposes the screenshot quick-add buttons immediately; detailed selects stay in Advanced.
    expect(screen.getByTestId("task-form-inline-create")).toBeVisible();
    expect(screen.getByTestId("task-form-inline-attach")).toBeVisible();
    expect(screen.getByTestId("task-form-inline-fast")).toBeVisible();
    expect(screen.getByTestId("task-form-inline-github")).toBeVisible();
    expect(screen.getByTestId("task-form-inline-workflow")).toBeVisible();
    expect(screen.getByTestId("task-form-inline-models")).toBeVisible();
    expect(screen.getByTestId("task-form-inline-node")).toBeVisible();
    expect(screen.getByTestId("task-form-inline-priority")).toBeVisible();

    // FNXC:NewTask 2026-06-23-00:10: The DEEP/advanced options now sit behind the collapsed "Advanced" disclosure. Model Configuration / Attachments are NOT shown until the toggle is expanded.
    const advancedToggle = screen.getByTestId("task-form-more-options-toggle");
    expect(advancedToggle).toHaveTextContent(/Advanced/i);
    expect(screen.getByTestId("task-form-more-options")).toHaveAttribute("hidden");

    fireEvent.click(advancedToggle);
    await waitFor(() => {
      expect(screen.getByText(/Model Configuration/i)).toBeTruthy();
      expect(screen.getByText(/Attachments/i)).toBeTruthy();
    });
    expect(screen.getByRole("button", { name: "Create Task" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  describe("GitHub reference picker", () => {
    const originRemote = { name: "origin", owner: "runfusion", repo: "fusion", url: "https://github.com/runfusion/fusion.git" };
    const upstreamRemote = { name: "upstream", owner: "octo", repo: "project", url: "https://github.com/octo/project.git" };
    const issue = {
      number: 12,
      title: "Crash on startup",
      body: null,
      html_url: "https://github.com/runfusion/fusion/issues/12",
      labels: [],
    };
    const pull = {
      number: 34,
      title: "Fix login",
      body: null,
      html_url: "https://github.com/runfusion/fusion/pull/34",
      headBranch: "fix-login",
      baseBranch: "main",
    };

    async function renderPickerWithData({ remotes = [originRemote], issues = [issue], pulls = [pull], viewport = "mobile" as "mobile" | "desktop" } = {}) {
      mockViewportMode = viewport;
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce(remotes);
      vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce(issues);
      vi.mocked(apiFetchGitHubPulls).mockResolvedValueOnce(pulls);
      renderNewTaskModal({ projectId: "project-1" });
      await waitFor(() => expect(fetchGitRemotes).toHaveBeenCalledWith("project-1"));
      if (remotes.length === 1 || remotes.some((remote) => remote.name === "origin")) {
        await waitFor(() => expect(apiFetchGitHubIssues).toHaveBeenCalled());
      }
    }

    it("loads origin remote references and seeds the issue prompt", async () => {
      await renderPickerWithData();

      await waitFor(() => expect(screen.getByTestId("new-task-github-reference-select")).toBeInTheDocument());
      expect(screen.getByText("Issue #12 — Crash on startup")).toBeInTheDocument();
      expect(screen.getByText("PR #34 — Fix login")).toBeInTheDocument();

      fireEvent.change(screen.getByTestId("new-task-github-reference-select"), { target: { value: "issue:12" } });

      await waitFor(() => {
        const textarea = screen.getByPlaceholderText("What needs to be done?") as HTMLTextAreaElement;
        expect(textarea.value).toContain("Fetch and read this GitHub issue");
        expect(textarea.value).toContain("Source: https://github.com/runfusion/fusion/issues/12");
      });
      expect(mockConfirm).not.toHaveBeenCalled();
    });

    it("seeds the PR prompt with review-comment resolution instructions", async () => {
      await renderPickerWithData();

      await waitFor(() => expect(screen.getByTestId("new-task-github-reference-select")).toBeInTheDocument());
      fireEvent.change(screen.getByTestId("new-task-github-reference-select"), { target: { value: "pull:34" } });

      await waitFor(() => {
        const textarea = screen.getByPlaceholderText("What needs to be done?") as HTMLTextAreaElement;
        expect(textarea.value).toContain("Fetch and read this GitHub pull request");
        expect(textarea.value).toContain("resolve or address all actionable PR review comments");
        expect(textarea.value).toContain("PR: https://github.com/runfusion/fusion/pull/34");
      });
    });

    it("protects typed descriptions before replacing them with a GitHub prompt", async () => {
      await renderPickerWithData();
      await waitFor(() => expect(screen.getByTestId("new-task-github-reference-select")).toBeInTheDocument());
      fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Keep my draft" } });

      mockConfirm.mockResolvedValueOnce(false);
      fireEvent.change(screen.getByTestId("new-task-github-reference-select"), { target: { value: "issue:12" } });

      await waitFor(() => expect(mockConfirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Replace description?" })));
      expect(screen.getByPlaceholderText("What needs to be done?")).toHaveValue("Keep my draft");
      expect(screen.getByTestId("new-task-github-reference-select")).toHaveValue("");

      mockConfirm.mockResolvedValueOnce(true);
      fireEvent.change(screen.getByTestId("new-task-github-reference-select"), { target: { value: "issue:12" } });

      await waitFor(() => {
        const textarea = screen.getByPlaceholderText("What needs to be done?") as HTMLTextAreaElement;
        expect(textarea.value).toContain("Source: https://github.com/runfusion/fusion/issues/12");
      });
    });

    it.each([
      { label: "issues only", issues: [issue], pulls: [], expected: "Issue #12 — Crash on startup", absent: "PR #34 — Fix login" },
      { label: "PRs only", issues: [], pulls: [pull], expected: "PR #34 — Fix login", absent: "Issue #12 — Crash on startup" },
    ])("renders $label references without an empty dropdown shell", async ({ issues, pulls, expected, absent }) => {
      await renderPickerWithData({ issues, pulls });

      await waitFor(() => expect(screen.getByTestId("new-task-github-reference-select")).toBeInTheDocument());
      expect(screen.getByText(expected)).toBeInTheDocument();
      expect(screen.queryByText(absent)).toBeNull();
    });

    it("keeps duplicate issue and PR numbers distinct", async () => {
      await renderPickerWithData({
        issues: [{ ...issue, number: 7, html_url: "https://github.com/runfusion/fusion/issues/7" }],
        pulls: [{ ...pull, number: 7, html_url: "https://github.com/runfusion/fusion/pull/7" }],
      });

      await waitFor(() => expect(screen.getByTestId("new-task-github-reference-select")).toBeInTheDocument());
      expect(screen.getByText("Issue #7 — Crash on startup")).toBeInTheDocument();
      expect(screen.getByText("PR #7 — Fix login")).toBeInTheDocument();

      fireEvent.change(screen.getByTestId("new-task-github-reference-select"), { target: { value: "pull:7" } });
      await waitFor(() => {
        const textarea = screen.getByPlaceholderText("What needs to be done?") as HTMLTextAreaElement;
        expect(textarea.value).toContain("PR: https://github.com/runfusion/fusion/pull/7");
      });

      fireEvent.change(screen.getByTestId("new-task-github-reference-select"), { target: { value: "issue:7" } });
      await waitFor(() => {
        const textarea = screen.getByPlaceholderText("What needs to be done?") as HTMLTextAreaElement;
        expect(textarea.value).toContain("Source: https://github.com/runfusion/fusion/issues/7");
      });
    });

    it("shows unavailable states without an empty reference dropdown shell", async () => {
      vi.mocked(fetchGitRemotes).mockResolvedValueOnce([]);
      const noRemoteRender = renderNewTaskModal({ projectId: "project-1" });
      await waitFor(() => expect(screen.getByTestId("new-task-github-reference-status")).toHaveTextContent("No GitHub remotes were detected"));
      expect(screen.queryByTestId("new-task-github-reference-select")).toBeNull();
      noRemoteRender.unmount();

      vi.mocked(fetchGitRemotes).mockResolvedValueOnce([upstreamRemote, { ...originRemote, name: "fork" }]);
      const { unmount } = renderNewTaskModal({ projectId: "project-1" });
      await waitFor(() => expect(screen.getByText("Choose a GitHub remote before selecting an issue or pull request.")).toBeInTheDocument());
      expect(screen.getByTestId("new-task-github-remote-select")).toBeInTheDocument();
      expect(screen.queryByTestId("new-task-github-reference-select")).toBeNull();
      unmount();

      vi.mocked(fetchGitRemotes).mockResolvedValueOnce([originRemote]);
      vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce([]);
      vi.mocked(apiFetchGitHubPulls).mockResolvedValueOnce([]);
      const emptyRender = renderNewTaskModal({ projectId: "project-1" });
      await waitFor(() => expect(screen.getByTestId("new-task-github-reference-status")).toHaveTextContent("No open issues or pull requests"));
      expect(screen.queryByTestId("new-task-github-reference-select")).toBeNull();
      emptyRender.unmount();

      vi.mocked(fetchGitRemotes).mockResolvedValueOnce([originRemote]);
      vi.mocked(apiFetchGitHubIssues).mockRejectedValueOnce(new Error("GitHub auth required"));
      vi.mocked(apiFetchGitHubPulls).mockResolvedValueOnce([]);
      const authErrorRender = renderNewTaskModal({ projectId: "project-1" });
      await waitFor(() => expect(screen.getByTestId("new-task-github-reference-status")).toHaveTextContent("GitHub auth required"));
      expect(screen.queryByTestId("new-task-github-reference-select")).toBeNull();
      authErrorRender.unmount();

      vi.mocked(fetchGitRemotes).mockRejectedValueOnce(new Error("Remote network failure"));
      renderNewTaskModal({ projectId: "project-1" });
      await waitFor(() => expect(screen.getByTestId("new-task-github-reference-status")).toHaveTextContent("Remote network failure"));
      expect(screen.queryByTestId("new-task-github-reference-select")).toBeNull();
    });

    it.each(["desktop", "mobile"] as const)("renders the picker in %s New Task mode", async (viewport) => {
      await renderPickerWithData({ viewport });
      await waitFor(() => expect(screen.getByTestId("new-task-github-reference-picker")).toBeInTheDocument());
      await waitFor(() => expect(screen.getByTestId("new-task-github-reference-select")).toBeEnabled());
    });

    it("ignores stale remote responses after the project changes", async () => {
      let resolveOldRemotes: (remotes: Array<typeof originRemote>) => void = () => {};
      vi.mocked(fetchGitRemotes)
        .mockReturnValueOnce(new Promise((resolve) => { resolveOldRemotes = resolve; }))
        .mockResolvedValueOnce([originRemote]);
      vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce([issue]);
      vi.mocked(apiFetchGitHubPulls).mockResolvedValueOnce([]);

      const { props, rerender } = renderNewTaskModal({ projectId: "old-project" });
      rerender(<NewTaskModal {...props} projectId="new-project" />);
      resolveOldRemotes([{ ...upstreamRemote, name: "stale" }]);

      await waitFor(() => expect(fetchGitRemotes).toHaveBeenCalledWith("new-project"));
      await waitFor(() => expect(screen.getByTestId("new-task-github-reference-remote")).toHaveTextContent("origin: runfusion/fusion"));
      expect(screen.queryByText(/stale:/)).toBeNull();
    });

    it("renders the picker in the mobile keyboard-open layout", async () => {
      mockUseMobileKeyboard.mockReturnValue({
        keyboardOpen: true,
        keyboardOverlap: 250,
        viewportHeight: 400,
        viewportOffsetTop: 50,
      });
      await renderPickerWithData({ viewport: "mobile" });

      await waitFor(() => expect(screen.getByTestId("new-task-github-reference-picker")).toBeInTheDocument());
      expect(screen.getByTestId("new-task-github-reference-select")).toBeEnabled();
      expect(document.querySelector(".new-task-modal")?.getAttribute("style")).toContain("--keyboard-overlap: 250px");
    });

    it("keeps the mobile sheet hit-testable when the transparent overlay passes through clicks", async () => {
      await renderPickerWithData({ viewport: "mobile" });
      await waitFor(() => expect(screen.getByTestId("new-task-github-reference-picker")).toBeInTheDocument());

      expect(document.querySelector(".new-task-modal--floating")).toBeNull();
      expect(newTaskModalCss).toContain("FNXC:NewTaskMobileAffordances 2026-06-25");
      expect(newTaskModalCss).toMatch(/\.new-task-modal\s*\{[^}]*pointer-events:\s*auto;/s);
    });

    it("keeps GitHub, dependency, and agent popups reachable in the mobile keyboard sheet", async () => {
      mockUseMobileKeyboard.mockReturnValue({
        keyboardOpen: true,
        keyboardOverlap: 250,
        viewportHeight: 400,
        viewportOffsetTop: 50,
      });
      vi.mocked(fetchAgents).mockResolvedValueOnce([
        { id: "agent-exec", name: "Executor Bot", role: "executor", state: "idle" } as any,
      ]);

      await renderPickerWithData({ viewport: "mobile" });

      await waitFor(() => expect(screen.getByTestId("new-task-github-reference-select")).toBeEnabled());
      expect(screen.getByTestId("new-task-github-reference-picker")).toBeVisible();
      expect(screen.getByText("Issue #12 — Crash on startup")).toBeInTheDocument();
      expect(screen.getByText("PR #34 — Fix login")).toBeInTheDocument();
      expect(screen.getByTestId("task-form-inline-github")).toBeVisible();
      expect(screen.getByTestId("task-form-inline-models")).toBeVisible();
      expect(screen.getByTestId("task-form-inline-node")).toBeVisible();
      expect(screen.getByTestId("task-form-inline-priority")).toBeVisible();
      expect(screen.getByRole("button", { name: "Create Task" })).toBeVisible();

      fireEvent.click(screen.getByTestId("dep-trigger"));
      expect(screen.getByPlaceholderText("Search tasks…")).toBeVisible();
      expect(screen.getByText("No available tasks")).toBeVisible();
      const depDropdown = document.querySelector(".new-task-quick-fields .dep-dropdown");
      expect(depDropdown).not.toBeNull();
      expect(depDropdown?.closest(".new-task-modal")).toBeTruthy();

      fireEvent.click(screen.getByTestId("new-task-agent-button"));
      await waitFor(() => expect(screen.getByTestId("agent-option-agent-exec")).toBeVisible());
      const agentDropdown = document.querySelector(".new-task-quick-fields .agent-picker-dropdown");
      expect(agentDropdown).not.toBeNull();
      expect(agentDropdown?.closest(".new-task-modal")).toBeTruthy();
      expect(document.querySelector(".new-task-modal")?.getAttribute("style")).toContain("--keyboard-overlap: 250px");
    });

    it("renders mobile GitHub data states without clipping or absent picker controls", async () => {
      vi.mocked(fetchGitRemotes).mockImplementationOnce(() => new Promise(() => undefined));
      const loadingRender = renderNewTaskModal({ projectId: "project-1" });
      await waitFor(() => expect(screen.getByTestId("new-task-github-reference-status")).toHaveTextContent("Loading GitHub remotes"));
      expect(screen.getByTestId("new-task-github-reference-picker")).toBeVisible();
      loadingRender.unmount();

      vi.mocked(fetchGitRemotes).mockResolvedValueOnce([upstreamRemote, { ...originRemote, name: "fork" }]);
      const multipleRemoteRender = renderNewTaskModal({ projectId: "project-1" });
      await waitFor(() => expect(screen.getByTestId("new-task-github-remote-select")).toBeVisible());
      expect(screen.getByText("Choose a GitHub remote before selecting an issue or pull request.")).toBeVisible();
      multipleRemoteRender.unmount();

      vi.mocked(fetchGitRemotes).mockResolvedValueOnce([originRemote]);
      vi.mocked(apiFetchGitHubIssues).mockImplementationOnce(() => new Promise(() => undefined));
      vi.mocked(apiFetchGitHubPulls).mockResolvedValueOnce([]);
      const referenceLoadingRender = renderNewTaskModal({ projectId: "project-1" });
      await waitFor(() => expect(screen.getByTestId("new-task-github-reference-status")).toHaveTextContent("Loading open issues and pull requests"));
      expect(screen.getByTestId("new-task-github-reference-picker")).toBeVisible();
      referenceLoadingRender.unmount();

      vi.mocked(fetchGitRemotes).mockResolvedValueOnce([originRemote]);
      vi.mocked(apiFetchGitHubIssues).mockRejectedValueOnce(new Error("GitHub auth required"));
      vi.mocked(apiFetchGitHubPulls).mockResolvedValueOnce([]);
      const authErrorRender = renderNewTaskModal({ projectId: "project-1" });
      await waitFor(() => expect(screen.getByTestId("new-task-github-reference-status")).toHaveTextContent("GitHub auth required"));
      expect(screen.getByTestId("new-task-github-reference-picker")).toBeVisible();
      authErrorRender.unmount();

      vi.mocked(fetchGitRemotes).mockResolvedValueOnce([originRemote]);
      vi.mocked(apiFetchGitHubIssues).mockResolvedValueOnce([{ ...issue, number: 7 }]);
      vi.mocked(apiFetchGitHubPulls).mockResolvedValueOnce([{ ...pull, number: 7 }]);
      renderNewTaskModal({ projectId: "project-1" });
      await waitFor(() => expect(screen.getByText("Issue #7 — Crash on startup")).toBeVisible());
      expect(screen.getByText("PR #7 — Fix login")).toBeVisible();
      expect(screen.getByTestId("new-task-github-reference-select")).toBeVisible();
    });
  });

  it("exposes New Task dialog quick-add affordance parity when AI handoff callbacks are supplied", () => {
    renderNewTaskModal({
      onPlanningMode: vi.fn(),
      onSubtaskBreakdown: vi.fn(),
    });

    const advancedSection = screen.getByTestId("task-form-more-options");
    expect(advancedSection).toHaveAttribute("hidden");

    // Empty description state: description-gated actions are disabled/absent, while configuration chips stay immediately usable.
    expect(screen.getByTestId("task-form-inline-create")).toBeDisabled();
    expect(screen.getByTestId("task-form-plan-button")).toBeDisabled();
    expect(screen.queryByTestId("refine-button")).toBeNull();
    expect(screen.getByTestId("task-form-inline-fast")).toBeVisible();
    expect(screen.getByTestId("task-form-inline-github")).toBeVisible();
    expect(screen.getByTestId("task-form-inline-workflow")).toBeVisible();
    expect(screen.getByTestId("task-form-inline-models")).toBeVisible();
    expect(screen.getByTestId("task-form-inline-node")).toBeVisible();
    expect(screen.getByTestId("dep-trigger")).toBeVisible();
    expect(screen.getByTestId("task-form-inline-attach")).toBeVisible();
    expect(screen.getByTestId("new-task-agent-button")).toBeVisible();

    fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Create parity coverage" } });

    // Populated description state: the complete screenshot affordance set is visible without opening Advanced.
    expect(screen.getByTestId("task-form-inline-create")).toBeEnabled();
    expect(screen.getAllByTestId("task-form-plan-button")).toHaveLength(1);
    expect(screen.getByTestId("task-form-plan-button")).toBeEnabled();
    expect(screen.getByTestId("refine-button")).toBeVisible();
    expect(screen.getByTestId("dep-trigger")).toBeVisible();
    expect(screen.getByTestId("new-task-agent-button")).toBeVisible();
    expect(screen.getByTestId("task-form-inline-attach")).toBeVisible();
    expect(screen.getByTestId("task-form-inline-fast")).toBeVisible();
    expect(screen.getByTestId("task-form-inline-github")).toBeVisible();
    expect(screen.getByTestId("task-form-inline-workflow")).toBeVisible();
    expect(screen.getByTestId("task-form-inline-models")).toBeVisible();
    expect(screen.getByTestId("task-form-inline-node")).toBeVisible();
    expect(screen.getByTestId("task-form-inline-priority")).toBeVisible();

    // Detailed editors remain present only inside Advanced, not duplicated as visible siblings.
    expect(advancedSection).toContainElement(screen.getByTestId("task-form-execution-mode-select"));
    expect(advancedSection).toContainElement(screen.getByTestId("task-form-github-tracking"));
    expect(advancedSection).toContainElement(screen.getByTestId("task-priority-select"));
    expect(advancedSection).toContainElement(screen.getByTestId("task-node-select"));
    expect(advancedSection).toHaveAttribute("hidden");
  });

  it("keeps the detailed Fast/standard execution-mode select inside Advanced", () => {
    renderNewTaskModal();

    const advancedSection = screen.getByTestId("task-form-more-options");
    const select = screen.getByTestId("task-form-execution-mode-select") as HTMLSelectElement;
    expect(advancedSection).toContainElement(select);
    expect(advancedSection).toHaveAttribute("hidden");
    expect(select).toHaveValue("standard");
    expect(Array.from(select.options).map((option) => option.value)).toEqual(["standard", "fast"]);
  });

  it("includes executionMode fast in the create payload when Fast is selected", async () => {
    const { props } = renderNewTaskModal();

    fireEvent.click(screen.getByTestId("task-form-inline-fast"));
    fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Fast parity task" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

    await waitFor(() => {
      expect(props.onCreateTask).toHaveBeenCalledWith(
        expect.objectContaining({ executionMode: "fast" }),
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("task-form-execution-mode-select")).toHaveValue("standard");
    });
  });

  it("promoted GitHub, workflow, model, node, deps, agent, attach, and create controls are functional", async () => {
    const { fetchWorkflows } = await import("../../api");
    vi.mocked(fetchWorkflows).mockResolvedValueOnce([
      {
        id: "WF-quick",
        name: "Quick Lane",
        description: "",
        kind: "workflow",
        ir: { version: "v1", name: "Quick Lane", nodes: [], edges: [] },
        layout: {},
        createdAt: "",
        updatedAt: "",
      } as any,
    ]);
    const clickSpy = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
    const { props } = renderNewTaskModal({ tasks: [makeTask("FN-777")] });

    fireEvent.click(screen.getByTestId("task-form-inline-github"));
    expect(screen.getByTestId("task-form-inline-github")).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByTestId("task-form-inline-fast"));
    expect(screen.getByTestId("task-form-inline-fast")).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByTestId("task-form-inline-attach"));
    expect(clickSpy).toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("dep-trigger"));
    expect(screen.getByPlaceholderText("Search tasks…")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("new-task-agent-button"));
    await waitFor(() => expect(screen.getByText("No agents available")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("task-form-inline-workflow"));
    await waitFor(() => expect(screen.getByTestId("task-form-more-options")).not.toHaveAttribute("hidden"));
    expect(await screen.findByTestId("task-workflow-dropdown-trigger")).toBeInTheDocument();
    expect(screen.getByTestId("task-workflow-dropdown-menu")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("task-form-more-options-toggle"));
    expect(screen.getByTestId("task-form-more-options")).toHaveAttribute("hidden");
    fireEvent.click(screen.getByTestId("task-form-inline-models"));
    await waitFor(() => expect(screen.getByTestId("task-form-more-options")).not.toHaveAttribute("hidden"));
    expect(screen.getByText(/Model Configuration/i)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("task-form-more-options-toggle"));
    expect(screen.getByTestId("task-form-more-options")).toHaveAttribute("hidden");
    fireEvent.click(screen.getByTestId("task-form-inline-node"));
    await waitFor(() => expect(screen.getByTestId("task-form-more-options")).not.toHaveAttribute("hidden"));
    expect(screen.getByTestId("task-node-select")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Promoted controls create task" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

    await waitFor(() => {
      expect(props.onCreateTask).toHaveBeenCalledWith(
        expect.objectContaining({
          executionMode: "fast",
          githubTracking: { enabled: true },
        }),
      );
    });
    clickSpy.mockRestore();
  });

  it("omits executionMode from the create payload when Standard is selected", async () => {
    const { props } = renderNewTaskModal();

    fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Standard parity task" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

    await waitFor(() => {
      expect(props.onCreateTask).toHaveBeenCalledTimes(1);
    });
    const payload = vi.mocked(props.onCreateTask).mock.calls[0][0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("executionMode");
  });

  // FNXC:PlannerOversight 2026-07-04-00:00: leaving the selector on "Inherit from workflow" ("") must omit plannerOversightLevel from the create payload so the task falls back to the workflow's effective value.
  it("omits plannerOversightLevel from the create payload when left on Inherit", async () => {
    const { props } = renderNewTaskModal();

    fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Inherit oversight task" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

    await waitFor(() => {
      expect(props.onCreateTask).toHaveBeenCalledTimes(1);
    });
    const payload = vi.mocked(props.onCreateTask).mock.calls[0][0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("plannerOversightLevel");
  });

  it("includes the selected plannerOversightLevel in the create payload", async () => {
    const { props } = renderNewTaskModal();

    fireEvent.click(screen.getByTestId("task-form-more-options-toggle"));
    const select = await screen.findByTestId("planner-oversight-level-select");
    fireEvent.change(select, { target: { value: "steer" } });

    fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Steer oversight task" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

    await waitFor(() => {
      expect(props.onCreateTask).toHaveBeenCalledWith(
        expect.objectContaining({ plannerOversightLevel: "steer" }),
      );
    });
  });

  it("resets executionMode to standard after canceling and discarding changes", async () => {
    const { props, rerender } = renderNewTaskModal();

    fireEvent.change(screen.getByTestId("task-form-execution-mode-select"), { target: { value: "fast" } });

    await waitFor(() => {
      expect(screen.getByTestId("task-form-execution-mode-select")).toHaveValue("fast");
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(mockConfirm).toHaveBeenCalledWith({
        title: "Discard Changes",
        message: "You have unsaved changes. Discard them?",
        danger: true,
      });
    });

    rerender(<NewTaskModal {...props} isOpen={false} />);
    rerender(<NewTaskModal {...props} isOpen={true} />);

    expect(screen.getByTestId("task-form-execution-mode-select")).toHaveValue("standard");
  });

  it("hands trimmed descriptions to planning and subtask callbacks without discard confirmation", () => {
    const onPlanningMode = vi.fn();
    const onSubtaskBreakdown = vi.fn();
    const { unmount, props } = renderNewTaskModal({
      onPlanningMode,
      onSubtaskBreakdown,
    });

    fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "  Break this down  " } });
    fireEvent.click(screen.getByTestId("task-form-plan-button"));

    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(onPlanningMode).toHaveBeenCalledWith("Break this down");
    expect(onSubtaskBreakdown).not.toHaveBeenCalled();

    unmount();
    renderNewTaskModal({
      onPlanningMode,
      onSubtaskBreakdown,
    });

    fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "  Split into subtasks  " } });
    fireEvent.click(screen.getByTestId("task-form-subtask-button"));

    expect(onSubtaskBreakdown).toHaveBeenCalledWith("Split into subtasks");
    expect(onPlanningMode).toHaveBeenCalledTimes(1);
  });

  it("disables Plan and Subtask handoff buttons until a description is present", () => {
    renderNewTaskModal({
      onPlanningMode: vi.fn(),
      onSubtaskBreakdown: vi.fn(),
    });

    const planButton = screen.getByTestId("task-form-plan-button");
    const subtaskButton = screen.getByTestId("task-form-subtask-button");

    expect(planButton).toBeDisabled();
    expect(subtaskButton).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Ready to plan" } });

    expect(planButton).not.toBeDisabled();
    expect(subtaskButton).not.toBeDisabled();
  });

  // FNXC:NewTask 2026-06-23-00:10: The New Task dialog NO LONGER force-opens TaskForm's advanced controls. The DEEP/advanced options (model selectors, workflow picker, etc.) are collapsed behind a disclosure relabeled "Advanced"; the common quick-add buttons (Attach/Fast/Priority) are surfaced inline next to Plan and are always visible.
  it("keeps deep options behind a collapsed 'Advanced' disclosure while surfacing inline quick-add buttons", () => {
    renderNewTaskModal();

    // The disclosure toggle exists, reads "Advanced", and starts collapsed (section hidden).
    const advancedToggle = screen.getByTestId("task-form-more-options-toggle");
    expect(advancedToggle).toHaveTextContent(/Advanced/i);
    expect(advancedToggle).toHaveAttribute("aria-expanded", "false");
    // Deep options live inside the collapsed (hidden) section, so they are not shown to the user.
    const advancedSection = screen.getByTestId("task-form-more-options");
    expect(advancedSection).toHaveAttribute("hidden");
    expect(advancedSection).toContainElement(screen.getByText(/Model Configuration/i));
    expect(advancedSection).toContainElement(screen.getByText("Workflow"));

    // Inline quick-add buttons (Attach/Fast/Priority) ARE visible without expanding (outside the hidden section).
    expect(screen.getByTestId("task-form-inline-attach")).toBeInTheDocument();
    expect(screen.getByTestId("task-form-inline-fast")).toBeInTheDocument();
    expect(screen.getByTestId("task-form-inline-priority")).toBeInTheDocument();
    expect(screen.getByTestId("dep-trigger")).toBeInTheDocument();

    // Expanding the disclosure reveals the deep options.
    fireEvent.click(advancedToggle);
    expect(advancedToggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("task-form-more-options")).not.toHaveAttribute("hidden");
    expect(screen.getByText(/Model Configuration/i)).toBeTruthy();
    expect(screen.getByText("Workflow")).toBeTruthy();
  });

  it("shows dependencies and agent picker by default", () => {
    renderNewTaskModal();

    // Both dep-trigger and agent button should be visible by default (quick-fields).
    expect(screen.getByTestId("dep-trigger")).toBeInTheDocument();
    expect(screen.getByTestId("new-task-agent-button")).toBeInTheDocument();
    // The "Advanced" disclosure is collapsed by default.
    expect(screen.getByTestId("task-form-more-options-toggle")).toHaveTextContent(/Advanced/i);
    expect(screen.getByTestId("task-form-more-options")).toHaveAttribute("hidden");
  });

  it("renders dependencies before attachments in form order (quick-fields before Advanced)", () => {
    renderNewTaskModal();

    const dependenciesLabel = screen.getByText("Dependencies");
    // Expand the Advanced disclosure so the Attachments group renders.
    fireEvent.click(screen.getByTestId("task-form-more-options-toggle"));
    const attachmentsLabel = screen.getByText("Attachments");

    // Dependencies (in quick-fields) appears before Attachments (in the Advanced section).
    expect(
      dependenciesLabel.compareDocumentPosition(attachmentsLabel) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("focuses description textarea when modal opens", async () => {
    renderNewTaskModal();
    
    const textarea = screen.getByPlaceholderText("What needs to be done?");
    await waitFor(() => {
      expect(document.activeElement).toBe(textarea);
    });
  });

  it("seeds the description when opened with an initial description", () => {
    renderNewTaskModal({ initialDescription: "File: README.md\n\nComment:\nFollow up" });

    expect(screen.getByPlaceholderText("What needs to be done?")).toHaveValue("File: README.md\n\nComment:\nFollow up");
    expect(screen.getByRole("button", { name: "Create Task" })).not.toBeDisabled();
  });

  it("does not clobber user edits when initialDescription changes while open", () => {
    const { rerender, props } = renderNewTaskModal({ initialDescription: "Seeded description" });
    const descTextarea = screen.getByPlaceholderText("What needs to be done?");

    fireEvent.change(descTextarea, { target: { value: "User edited text" } });
    rerender(<NewTaskModal {...props} initialDescription="Different seed" />);

    expect(screen.getByPlaceholderText("What needs to be done?")).toHaveValue("User edited text");
  });

  it("creates task with description when submitted", async () => {
    const { props } = renderNewTaskModal();
    
    const descTextarea = screen.getByPlaceholderText("What needs to be done?");
    fireEvent.change(descTextarea, { target: { value: "Test description" } });
    
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
    
    await waitFor(() => {
      expect(props.onCreateTask).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "Test description",
        }),
      );
    });
  });

  describe("optional workflow steps (U4)", () => {
    const WF = {
      id: "wf-x",
      name: "Custom",
      kind: "workflow" as const,
      description: "",
      ir: { version: "v1" as const, name: "Custom", nodes: [], edges: [] },
      layout: {},
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const STEP = {
      templateId: "browser-verification",
      name: "Browser Verification",
      description: "Verify web application functionality using browser automation",
      icon: "globe",
      phase: "pre-merge" as const,
      defaultOn: false,
    };

    it("includes a toggled-on optional step in the create payload", async () => {
      const { fetchWorkflows, fetchWorkflowOptionalSteps } = await import("../../api");
      vi.mocked(fetchWorkflows).mockResolvedValue([WF]);
      vi.mocked(fetchWorkflowOptionalSteps).mockResolvedValue([STEP]);

      const { props } = renderNewTaskModal();
      fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), {
        target: { value: "Verify the login page" },
      });
      await chooseWorkflowOption("wf-x");

      const trigger = await screen.findByTestId("task-form-inline-optional-steps");
      expect(trigger).toHaveTextContent("Steps: none");
      fireEvent.click(trigger);
      fireEvent.click(await screen.findByTestId("wf-optional-steps-dropdown-option-browser-verification"));

      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
      await waitFor(() => {
        expect(props.onCreateTask).toHaveBeenCalledWith(
          expect.objectContaining({ enabledWorkflowSteps: ["browser-verification"] }),
        );
      });
    });

    it("keeps exactly one inline optional-steps trigger when Advanced is expanded", async () => {
      const { fetchWorkflows, fetchWorkflowOptionalSteps } = await import("../../api");
      vi.mocked(fetchWorkflows).mockResolvedValue([WF]);
      vi.mocked(fetchWorkflowOptionalSteps).mockResolvedValue([STEP]);

      renderNewTaskModal();
      await chooseWorkflowOption("wf-x");

      await screen.findByTestId("task-form-inline-optional-steps");
      fireEvent.click(screen.getByTestId("task-form-more-options-toggle"));

      expect(screen.getAllByTestId("task-form-inline-optional-steps")).toHaveLength(1);
      expect(screen.queryByTestId("task-form-optional-steps")).toBeNull();
    });

    it("seeds defaultOn steps as pre-enabled and submits them without toggling", async () => {
      const { fetchWorkflows, fetchWorkflowOptionalSteps } = await import("../../api");
      vi.mocked(fetchWorkflows).mockResolvedValue([WF]);
      vi.mocked(fetchWorkflowOptionalSteps).mockResolvedValue([{ ...STEP, defaultOn: true }]);

      const { props } = renderNewTaskModal();
      fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "task" } });
      await chooseWorkflowOption("wf-x");

      const trigger = await screen.findByTestId("task-form-inline-optional-steps");
      await waitFor(() => expect(trigger).toHaveTextContent("Steps: 1 selected"));

      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
      await waitFor(() => {
        expect(props.onCreateTask).toHaveBeenCalledWith(
          expect.objectContaining({ enabledWorkflowSteps: ["browser-verification"] }),
        );
      });
    });

    it("submits explicit empty optional steps when Fast is created before optional-step metadata loads", async () => {
      const { fetchWorkflows, fetchWorkflowOptionalSteps } = await import("../../api");
      vi.mocked(fetchWorkflows).mockResolvedValue([WF]);
      vi.mocked(fetchWorkflowOptionalSteps).mockReturnValue(new Promise(() => undefined) as any);

      const { props } = renderNewTaskModal();
      fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "fast before metadata" } });
      await chooseWorkflowOption("wf-x");
      await waitFor(() => expect(fetchWorkflowOptionalSteps).toHaveBeenCalledWith("wf-x", undefined));

      fireEvent.click(screen.getByTestId("task-form-inline-fast"));
      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

      await waitFor(() => {
        expect(props.onCreateTask).toHaveBeenCalledWith(
          expect.objectContaining({ executionMode: "fast", enabledWorkflowSteps: [] }),
        );
      });
    });

    it("persists explicit empty optional steps after Fast clears defaults and allows manual reselection", async () => {
      const { fetchWorkflows, fetchWorkflowOptionalSteps } = await import("../../api");
      vi.mocked(fetchWorkflows).mockResolvedValue([WF]);
      vi.mocked(fetchWorkflowOptionalSteps).mockResolvedValue([{ ...STEP, defaultOn: true }]);

      const { props } = renderNewTaskModal();
      fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "fast task" } });
      await chooseWorkflowOption("wf-x");
      const trigger = await screen.findByTestId("task-form-inline-optional-steps");
      await waitFor(() => expect(trigger).toHaveTextContent("Steps: 1 selected"));

      fireEvent.click(screen.getByTestId("task-form-inline-fast"));
      await waitFor(() => expect(trigger).toHaveTextContent("Steps: none"));
      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

      await waitFor(() => {
        expect(props.onCreateTask).toHaveBeenCalledWith(
          expect.objectContaining({ executionMode: "fast", enabledWorkflowSteps: [] }),
        );
      });

      vi.mocked(props.onCreateTask).mockClear();
      vi.mocked(props.onCreateTask).mockResolvedValue(makeTask("FN-002"));
      fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "fast task with browser" } });
      await chooseWorkflowOption("wf-x");
      const nextTrigger = await screen.findByTestId("task-form-inline-optional-steps");
      fireEvent.click(screen.getByTestId("task-form-inline-fast"));
      fireEvent.click(nextTrigger);
      fireEvent.click(await screen.findByTestId("wf-optional-steps-dropdown-option-browser-verification"));
      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

      await waitFor(() => {
        expect(props.onCreateTask).toHaveBeenCalledWith(
          expect.objectContaining({ executionMode: "fast", enabledWorkflowSteps: ["browser-verification"] }),
        );
      });
    });

    it("renders no dropdown and omits enabledWorkflowSteps for 'No workflow'", async () => {
      const { fetchWorkflows, fetchWorkflowOptionalSteps } = await import("../../api");
      vi.mocked(fetchWorkflows).mockResolvedValue([WF]);
      vi.mocked(fetchWorkflowOptionalSteps).mockResolvedValue([STEP]);

      const { props } = renderNewTaskModal();
      fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "task" } });
      // "No workflow" → null selection → no optional-steps fetch, no dropdown.
      await chooseWorkflowOption("__none__");

      expect(screen.queryByTestId("task-form-inline-optional-steps")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
      await waitFor(() => {
        const call = vi.mocked(props.onCreateTask).mock.calls.at(-1)?.[0];
        expect(call).not.toHaveProperty("enabledWorkflowSteps");
      });
    });
  });

  it("submits project-default branch selection by default", async () => {
    const { props } = renderNewTaskModal();

    fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Task without branches" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

    await waitFor(() => {
      expect(props.onCreateTask).toHaveBeenCalledWith(
        expect.objectContaining({
          branchSelection: { mode: "project-default" },
        }),
      );
    });
  });

  it("submits existing branch selection with trimmed names", async () => {
    const { props } = renderNewTaskModal();

    fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Task with branches" } });
    fireEvent.change(screen.getByLabelText("Branch strategy"), { target: { value: "existing" } });
    fireEvent.change(screen.getByLabelText("Branch name"), { target: { value: " feature/fn-3422 " } });
    fireEvent.change(screen.getByLabelText("Merge target / base branch"), { target: { value: " main " } });

    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

    await waitFor(() => {
      expect(props.onCreateTask).toHaveBeenCalledWith(
        expect.objectContaining({
          branchSelection: {
            mode: "existing",
            branchName: "feature/fn-3422",
            baseBranch: "main",
          },
        }),
      );
    });
  });

  it("submits auto-new branch selection", async () => {
    const { props } = renderNewTaskModal();

    fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Task with auto new" } });
    fireEvent.change(screen.getByLabelText("Branch strategy"), { target: { value: "auto-new" } });
    fireEvent.change(screen.getByLabelText("Merge target / base branch"), { target: { value: " main " } });
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

    await waitFor(() => {
      expect(props.onCreateTask).toHaveBeenCalledWith(
        expect.objectContaining({
          branchSelection: {
            mode: "auto-new",
            baseBranch: "main",
          },
        }),
      );
    });
  });

  it("requires branch name for custom-new mode", async () => {
    const { props } = renderNewTaskModal();

    fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Task with branches" } });
    fireEvent.change(screen.getByLabelText("Branch strategy"), { target: { value: "custom-new" } });

    expect(screen.getByRole("button", { name: "Create Task" })).toBeDisabled();
    expect(screen.getByText("Branch name is required for this branch strategy.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
    expect(props.onCreateTask).not.toHaveBeenCalled();
  });

  it("submits custom-new branch selection when branch name exists", async () => {
    const { props } = renderNewTaskModal();

    fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Task with custom new" } });
    fireEvent.change(screen.getByLabelText("Branch strategy"), { target: { value: "custom-new" } });
    fireEvent.change(screen.getByLabelText("Branch name"), { target: { value: " feature/custom " } });
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

    await waitFor(() => {
      expect(props.onCreateTask).toHaveBeenCalledWith(
        expect.objectContaining({
          branchSelection: {
            mode: "custom-new",
            branchName: "feature/custom",
          },
        }),
      );
    });
  });

  it("requires branch name for shared-group mode", async () => {
    const { props } = renderNewTaskModal();

    fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Task with shared group" } });
    fireEvent.change(screen.getByLabelText("Branch strategy"), { target: { value: "shared-group" } });

    expect(screen.getByRole("button", { name: "Create Task" })).toBeDisabled();
    expect(screen.getByText("Branch name is required for this branch strategy.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
    expect(props.onCreateTask).not.toHaveBeenCalled();
  });

  it("submits shared-group branch selection when shared branch exists", async () => {
    const { props } = renderNewTaskModal();

    fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Task with shared group" } });
    fireEvent.change(screen.getByLabelText("Branch strategy"), { target: { value: "shared-group" } });
    fireEvent.change(screen.getByLabelText("Shared feature branch"), { target: { value: " feature/shared " } });
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

    await waitFor(() => {
      expect(props.onCreateTask).toHaveBeenCalledWith(
        expect.objectContaining({
          branchSelection: {
            mode: "shared-group",
            branchName: "feature/shared",
          },
        }),
      );
    });
  });

  it("still submits when setup warnings are shown", async () => {
    const { fetchAuthStatus } = await import("../../api");
    vi.mocked(fetchAuthStatus).mockResolvedValueOnce({
      providers: [{ id: "github", name: "GitHub", authenticated: false, type: "oauth" }],
    });

    const { props } = renderNewTaskModal();

    await waitFor(() => {
      expect(screen.getByText("No AI provider connected")).toBeTruthy();
      expect(screen.queryByText("GitHub not connected")).toBeNull();
    });

    const descTextarea = screen.getByPlaceholderText("What needs to be done?");
    fireEvent.change(descTextarea, { target: { value: "Submit despite warning" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

    await waitFor(() => {
      expect(props.onCreateTask).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "Submit despite warning",
        }),
      );
    });
  });

  it("hides GitHub-only setup warning before the project grace period expires", async () => {
    const { fetchAuthStatus } = await import("../../api");
    vi.mocked(fetchAuthStatus).mockResolvedValueOnce({
      providers: [
        { id: "anthropic", name: "Anthropic", authenticated: true, type: "oauth" },
        { id: "github", name: "GitHub", authenticated: false, type: "oauth" },
      ],
    });

    renderNewTaskModal({ projectId: "proj-grace" });

    await waitFor(() => {
      expect(screen.queryByText("No AI provider connected")).toBeNull();
      expect(screen.queryByText("GitHub not connected")).toBeNull();
    });
  });

  it("suppresses the modal GitHub setup warning after grace because no settings opener is available", async () => {
    const { fetchAuthStatus } = await import("../../api");
    vi.mocked(fetchAuthStatus).mockResolvedValueOnce({
      providers: [
        { id: "anthropic", name: "Anthropic", authenticated: true, type: "oauth" },
        { id: "github", name: "GitHub", authenticated: false, type: "oauth" },
      ],
    });
    window.localStorage.setItem(
      scopedKey(GITHUB_SETUP_WARNING_MISSING_SINCE_KEY, "proj-expired"),
      String(Date.now() - GITHUB_SETUP_WARNING_DELAY_MS),
    );

    renderNewTaskModal({ projectId: "proj-expired" });

    await waitFor(() => {
      expect(screen.queryByText("No AI provider connected")).toBeNull();
      expect(screen.queryByText("GitHub not connected")).toBeNull();
    });
    expect(screen.queryByRole("button", { name: "Connect GitHub" })).toBeNull();
  });

  it("closes modal after successful creation", async () => {
    const { props } = renderNewTaskModal();
    
    const descTextarea = screen.getByPlaceholderText("What needs to be done?");
    fireEvent.change(descTextarea, { target: { value: "Test" } });
    
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
    
    await waitFor(() => {
      expect(props.onClose).toHaveBeenCalled();
    });
  });


  it("shows success toast after creation", async () => {
    const { props } = renderNewTaskModal({
      onCreateTask: vi.fn().mockResolvedValue({ id: "FN-042" }),
    });
    
    const descTextarea = screen.getByPlaceholderText("What needs to be done?");
    fireEvent.change(descTextarea, { target: { value: "Test description" } });
    
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
    
    await waitFor(() => {
      expect(props.addToast).toHaveBeenCalledWith("Created FN-042", "success");
    });
  });

  it("confirms before closing with dirty state", async () => {
    const { props } = renderNewTaskModal();

    const descTextarea = screen.getByPlaceholderText("What needs to be done?");
    fireEvent.change(descTextarea, { target: { value: "Test description" } });

    mockConfirm.mockResolvedValueOnce(false);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(mockConfirm).toHaveBeenCalledWith({
        title: "Discard Changes",
        message: "You have unsaved changes. Discard them?",
        danger: true,
      });
    });
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("closes without confirm when state is not dirty", () => {
    const { props } = renderNewTaskModal();
    
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.onClose).toHaveBeenCalled();
  });

  it("creates task with title undefined by default", async () => {
    const { props } = renderNewTaskModal();
    
    const descTextarea = screen.getByPlaceholderText("What needs to be done?");
    fireEvent.change(descTextarea, { target: { value: "Only description" } });
    
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
    
    await waitFor(() => {
      expect(props.onCreateTask).toHaveBeenCalledWith(
        expect.objectContaining({
          title: undefined,
          description: "Only description",
        }),
      );
    });
  });

  it("calls onCreateTask when form is submitted", async () => {
    const { props } = renderNewTaskModal();

    const descTextarea = screen.getByPlaceholderText("What needs to be done?");
    fireEvent.change(descTextarea, { target: { value: "Normal task" } });

    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

    await waitFor(() => {
      expect(props.onCreateTask).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "Normal task",
        }),
      );
    });
  });

  it("checks for duplicates and creates directly when none are found", async () => {
    const { props } = renderNewTaskModal({ projectId: "project-alpha" });

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Unique task description" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

    await waitFor(() => {
      expect(checkDuplicateTasks).toHaveBeenCalledWith({ description: "Unique task description" }, "project-alpha");
      expect(props.onCreateTask).toHaveBeenCalledWith(
        expect.objectContaining({ description: "Unique task description" }),
      );
    });
    expect(screen.queryByText("Possible duplicates")).not.toBeInTheDocument();
  });

  it("shows duplicate warning and does not create when matches are found", async () => {
    vi.mocked(checkDuplicateTasks).mockResolvedValueOnce([
      { id: "FN-301", title: "Title should not display", description: "Existing similar full-dialog task", column: "todo", score: 0.88 },
    ]);
    const { props } = renderNewTaskModal();

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "New full-dialog task" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

    expect(await screen.findByText("Possible duplicates")).toBeInTheDocument();
    expect(screen.getByText("Existing similar full-dialog task")).toBeInTheDocument();
    expect(screen.queryByText("Title should not display")).not.toBeInTheDocument();
    expect(props.onCreateTask).not.toHaveBeenCalled();
  });

  it("creates with acknowledged duplicate ids after Create anyway", async () => {
    vi.mocked(checkDuplicateTasks).mockResolvedValueOnce([
      { id: "FN-401", title: "Existing title", description: "Existing duplicate description", column: "todo", score: 0.93 },
      { id: "FN-402", title: "Second title", description: "Second duplicate description", column: "in-progress", score: 0.82 },
    ]);
    const { props } = renderNewTaskModal();

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Create anyway duplicate" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
    fireEvent.click(await screen.findByRole("button", { name: "Create anyway" }));

    await waitFor(() => {
      expect(props.onCreateTask).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "Create anyway duplicate",
          acknowledgedDuplicates: ["FN-401", "FN-402"],
        }),
      );
    });
  });

  it("dismisses duplicate warning on Cancel without creating", async () => {
    vi.mocked(checkDuplicateTasks).mockResolvedValueOnce([
      { id: "FN-501", title: "Existing title", description: "Cancel duplicate description", column: "todo", score: 0.9 },
    ]);
    const { props } = renderNewTaskModal();

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Cancel duplicate" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
    await screen.findByText("Possible duplicates");
    fireEvent.click(screen.getAllByRole("button", { name: "Cancel" }).at(-1)!);

    await waitFor(() => {
      expect(screen.queryByText("Possible duplicates")).not.toBeInTheDocument();
    });
    expect(props.onCreateTask).not.toHaveBeenCalled();
  });

  it("opens the selected duplicate task and closes the dialog", async () => {
    vi.mocked(checkDuplicateTasks).mockResolvedValueOnce([
      { id: "FN-601", title: "Existing title", description: "Open duplicate description", column: "todo", score: 0.9 },
    ]);
    const { props } = renderNewTaskModal();

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Open duplicate" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
    fireEvent.click((await screen.findAllByRole("button", { name: "Open" }))[0]);

    await waitFor(() => {
      expect(window.location.hash).toBe("#/tasks/FN-601");
      expect(props.onClose).toHaveBeenCalled();
    });
    expect(props.onCreateTask).not.toHaveBeenCalled();
  });

  it("fails open and creates when duplicate check throws", async () => {
    vi.mocked(checkDuplicateTasks).mockRejectedValueOnce(new Error("duplicate check unavailable"));
    const { props } = renderNewTaskModal();

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Fail open duplicate check" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

    await waitFor(() => {
      expect(props.addToast).toHaveBeenCalledWith("Duplicate check failed; creating task anyway.", "error");
      expect(props.onCreateTask).toHaveBeenCalledWith(
        expect.objectContaining({ description: "Fail open duplicate check" }),
      );
    });
  });

  it("disables Create Task when description is empty", () => {
    renderNewTaskModal();
    
    const createButton = screen.getByRole("button", { name: "Create Task" });
    expect(createButton).toBeDisabled();
  });

  it("enables Create Task when description has content", () => {
    renderNewTaskModal();
    
    const descTextarea = screen.getByPlaceholderText("What needs to be done?");
    fireEvent.change(descTextarea, { target: { value: "Some text" } });
    
    const createButton = screen.getByRole("button", { name: "Create Task" });
    expect(createButton).not.toBeDisabled();
  });

  // Preset selection tests (FN-819)
  describe("model preset selection payload", () => {
    it("omits modelPresetId from payload when in default mode", async () => {
      const { props } = renderNewTaskModal();

      const descTextarea = screen.getByPlaceholderText("What needs to be done?");
      fireEvent.change(descTextarea, { target: { value: "Default mode task" } });

      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

      await waitFor(() => {
        expect(props.onCreateTask).toHaveBeenCalledWith(
          expect.objectContaining({
            modelPresetId: undefined,
          }),
        );
      });
    });

    it("includes modelPresetId and model overrides in payload when preset is selected", async () => {
      const { fetchSettings } = await import("../../api");
      vi.mocked(fetchSettings).mockResolvedValue({
        modelPresets: [
          { id: "fast", name: "Fast", executorProvider: "anthropic", executorModelId: "claude-sonnet-4-5", validatorProvider: "openai", validatorModelId: "gpt-4o" },
        ],
        autoSelectModelPreset: false,
        defaultPresetBySize: {},
      } as any);

      const { props } = renderNewTaskModal();

      // Wait for settings to load and preset dropdown to populate
      await waitFor(() => {
        const select = document.getElementById("model-preset") as HTMLSelectElement;
        expect(select).toBeTruthy();
        expect(Array.from(select.options).some((o) => o.value === "fast")).toBe(true);
      });

      // Type a description
      fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Preset task" } });

      // Select the preset
      const select = document.getElementById("model-preset") as HTMLSelectElement;
      fireEvent.change(select, { target: { value: "fast" } });

      // Submit
      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

      await waitFor(() => {
        expect(props.onCreateTask).toHaveBeenCalledWith(
          expect.objectContaining({
            modelPresetId: "fast",
            modelProvider: "anthropic",
            modelId: "claude-sonnet-4-5",
            validatorModelProvider: "openai",
            validatorModelId: "gpt-4o",
          }),
        );
      });
    });

    it("omits modelPresetId from payload when switching from preset to custom", async () => {
      const { fetchSettings } = await import("../../api");
      vi.mocked(fetchSettings).mockResolvedValue({
        modelPresets: [
          { id: "fast", name: "Fast", executorProvider: "anthropic", executorModelId: "claude-sonnet-4-5" },
        ],
        autoSelectModelPreset: false,
        defaultPresetBySize: {},
      } as any);

      const { props } = renderNewTaskModal();

      // Wait for settings to load
      await waitFor(() => {
        const select = document.getElementById("model-preset") as HTMLSelectElement;
        expect(Array.from(select.options).some((o) => o.value === "fast")).toBe(true);
      });

      // Type a description
      fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Custom task" } });

      // Select a preset first
      const select = document.getElementById("model-preset") as HTMLSelectElement;
      fireEvent.change(select, { target: { value: "fast" } });

      // Now switch to custom
      fireEvent.change(select, { target: { value: "custom" } });

      // Submit
      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

      await waitFor(() => {
        expect(props.onCreateTask).toHaveBeenCalledWith(
          expect.objectContaining({
            modelPresetId: undefined,
          }),
        );
      });
    });
  });

  // Workflow step ordering tests (FN-836)
  describe("workflow selection (U6/R3)", () => {
    function mockWorkflows(defs: Array<{ id: string; name: string; kind?: "workflow" | "fragment" }>) {
      return import("../../api").then(({ fetchWorkflows }) => {
        vi.mocked(fetchWorkflows).mockResolvedValueOnce(
          defs.map((d) => ({
            id: d.id,
            name: d.name,
            description: "",
            kind: d.kind ?? "workflow",
            ir: { version: "v1", name: d.name, nodes: [], edges: [] },
            layout: {},
            createdAt: "",
            updatedAt: "",
          })) as any,
        );
      });
    }

    it("omits workflowId from the payload when the picker is untouched (inherit default)", async () => {
      await mockWorkflows([{ id: "WF-1", name: "QA" }]);
      const { props } = renderNewTaskModal();

      await waitFor(() => {
        expect(screen.getByTestId("task-workflow-dropdown-trigger")).toBeTruthy();
      });

      fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Inherit default" } });
      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

      await waitFor(() => {
        expect(props.onCreateTask).toHaveBeenCalled();
      });
      const payload = vi.mocked(props.onCreateTask).mock.calls[0][0] as Record<string, unknown>;
      expect("workflowId" in payload).toBe(false);
    });

    it("sends the chosen workflowId in the create payload", async () => {
      await mockWorkflows([{ id: "WF-1", name: "QA" }]);
      const { props } = renderNewTaskModal();

      await waitFor(() => {
        expect(screen.getByTestId("task-workflow-dropdown-trigger")).toBeTruthy();
      });

      await chooseWorkflowOption("WF-1");
      fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Pick a workflow" } });
      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

      await waitFor(() => {
        expect(props.onCreateTask).toHaveBeenCalledWith(
          expect.objectContaining({ workflowId: "WF-1" }),
        );
      });
    });

    it("sends workflowId: null when 'No workflow' is chosen", async () => {
      await mockWorkflows([{ id: "WF-1", name: "QA" }]);
      const { props } = renderNewTaskModal();

      await waitFor(() => {
        expect(screen.getByTestId("task-workflow-dropdown-trigger")).toBeTruthy();
      });

      // Pick a workflow, then switch to "No workflow" to register an explicit null.
      await chooseWorkflowOption("WF-1");
      await chooseWorkflowOption("__none__");
      fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "No workflow task" } });
      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

      await waitFor(() => {
        expect(props.onCreateTask).toHaveBeenCalledWith(
          expect.objectContaining({ workflowId: null }),
        );
      });
    });

    it("does not render the legacy per-step checkbox UI", async () => {
      await mockWorkflows([{ id: "WF-1", name: "QA" }]);
      renderNewTaskModal();

      await waitFor(() => {
        expect(screen.getByTestId("task-workflow-dropdown-trigger")).toBeTruthy();
      });
      expect(screen.queryByTestId("workflow-step-order")).toBeNull();
      expect(document.querySelector('[data-testid^="workflow-step-checkbox-"]')).toBeNull();
    });
  });

  // Review level tests (FN-2241)
  describe("review level selection payload", () => {
    it("omits reviewLevel from payload when not selected", async () => {
      const { props } = renderNewTaskModal();

      const descTextarea = screen.getByPlaceholderText("What needs to be done?");
      fireEvent.change(descTextarea, { target: { value: "Task without review level" } });

      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

      await waitFor(() => {
        expect(props.onCreateTask).toHaveBeenCalledWith(
          expect.objectContaining({
            reviewLevel: undefined,
          }),
        );
      });
    });

    it("includes reviewLevel in payload when selected", async () => {
      const { props } = renderNewTaskModal();

      // Open more options to access the review level selector

      await waitFor(() => {
        expect(screen.getByLabelText("Review")).toBeTruthy();
      });

      // Select review level 2 (Plan and Code)
      const select = document.getElementById("review-level") as HTMLSelectElement;
      fireEvent.change(select, { target: { value: "2" } });

      const descTextarea = screen.getByPlaceholderText("What needs to be done?");
      fireEvent.change(descTextarea, { target: { value: "Task with review level" } });

      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

      await waitFor(() => {
        expect(props.onCreateTask).toHaveBeenCalledWith(
          expect.objectContaining({
            reviewLevel: 2,
          }),
        );
      });
    });

    it("includes reviewLevel 3 in payload when Full review is selected", async () => {
      const { props } = renderNewTaskModal();

      // Open more options to access the review level selector

      await waitFor(() => {
        expect(screen.getByLabelText("Review")).toBeTruthy();
      });

      // Select review level 3 (Full)
      const select = document.getElementById("review-level") as HTMLSelectElement;
      fireEvent.change(select, { target: { value: "3" } });

      const descTextarea = screen.getByPlaceholderText("What needs to be done?");
      fireEvent.change(descTextarea, { target: { value: "Task with full review" } });

      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

      await waitFor(() => {
        expect(props.onCreateTask).toHaveBeenCalledWith(
          expect.objectContaining({
            reviewLevel: 3,
          }),
        );
      });
    });
  });

  describe("auto-merge selection payload", () => {
    it("omits autoMerge from payload when default is selected", async () => {
      const { props } = renderNewTaskModal();

      fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Task default auto-merge" } });
      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

      await waitFor(() => {
        expect(props.onCreateTask).toHaveBeenCalledWith(
          expect.not.objectContaining({ autoMerge: expect.anything() }),
        );
      });
    });

    it("includes autoMerge true when Enabled is selected", async () => {
      const { props } = renderNewTaskModal();

      await waitFor(() => {
        expect(screen.getByTestId("task-automerge-select")).toBeTruthy();
      });
      fireEvent.change(screen.getByTestId("task-automerge-select"), { target: { value: "on" } });
      fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Task auto-merge on" } });
      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

      await waitFor(() => {
        expect(props.onCreateTask).toHaveBeenCalledWith(
          expect.objectContaining({ autoMerge: true }),
        );
      });
    });

    it("includes autoMerge false when Disabled is selected", async () => {
      const { props } = renderNewTaskModal();

      await waitFor(() => {
        expect(screen.getByTestId("task-automerge-select")).toBeTruthy();
      });
      fireEvent.change(screen.getByTestId("task-automerge-select"), { target: { value: "off" } });
      fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Task auto-merge off" } });
      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

      await waitFor(() => {
        expect(props.onCreateTask).toHaveBeenCalledWith(
          expect.objectContaining({ autoMerge: false }),
        );
      });
    });
  });

  describe("priority selection payload", () => {
    it("includes default normal priority in create payload", async () => {
      const { props } = renderNewTaskModal();

      fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Task with default priority" } });
      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

      await waitFor(() => {
        expect(props.onCreateTask).toHaveBeenCalledWith(
          expect.objectContaining({
            priority: "normal",
          }),
        );
      });
    });

    it("includes selected priority and resets back to normal after submit", async () => {
      const { props } = renderNewTaskModal();

      fireEvent.change(screen.getByTestId("task-priority-select"), { target: { value: "urgent" } });
      fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Task with urgent priority" } });
      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

      await waitFor(() => {
        expect(props.onCreateTask).toHaveBeenCalledWith(
          expect.objectContaining({
            priority: "urgent",
          }),
        );
      });

      await waitFor(() => {
        expect(screen.getByTestId("task-priority-select")).toHaveValue("normal");
      });
    });

    it("treats non-default priority as dirty state on cancel", async () => {
      renderNewTaskModal();

      fireEvent.change(screen.getByTestId("task-priority-select"), { target: { value: "high" } });
      mockConfirm.mockResolvedValueOnce(false);

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      await waitFor(() => {
        expect(mockConfirm).toHaveBeenCalledWith({
          title: "Discard Changes",
          message: "You have unsaved changes. Discard them?",
          danger: true,
        });
      });
    });
  });

  // Agent assignment tests (FN-1483)
  describe("agent assignment", () => {
    it("renders agent picker button", () => {
      renderNewTaskModal();
      expect(screen.getByTestId("new-task-agent-button")).toBeTruthy();
      expect(screen.getByText("Assign agent")).toBeTruthy();
    });

    it("shows dropdown when agent button is clicked", async () => {
      const { fetchAgents } = await import("../../api");
      vi.mocked(fetchAgents).mockResolvedValueOnce([
        { id: "agent-1", name: "Executor Bot", role: "executor", state: "active" as const, metadata: {}, createdAt: "", updatedAt: "" },
      ]);

      renderNewTaskModal();

      fireEvent.click(screen.getByTestId("new-task-agent-button"));

      await waitFor(() => {
        expect(screen.getByText("Select agent")).toBeTruthy();
        expect(screen.getByText("Executor Bot")).toBeTruthy();
      });
    });

    it("shows selected agent name in button", async () => {
      const { fetchAgents } = await import("../../api");
      vi.mocked(fetchAgents).mockResolvedValueOnce([
        { id: "agent-1", name: "Executor Bot", role: "executor", state: "active" as const, metadata: {}, createdAt: "", updatedAt: "" },
      ]);

      renderNewTaskModal();

      fireEvent.click(screen.getByTestId("new-task-agent-button"));

      await waitFor(() => {
        expect(screen.getByText("Select agent")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Executor Bot"));

      await waitFor(() => {
        expect(screen.getByTestId("new-task-agent-button")).toHaveTextContent("Executor Bot");
      });
    });

    it("includes assignedAgentId in payload when agent is selected", async () => {
      const { fetchAgents } = await import("../../api");
      vi.mocked(fetchAgents).mockResolvedValueOnce([
        { id: "agent-1", name: "Executor Bot", role: "executor", state: "active" as const, metadata: {}, createdAt: "", updatedAt: "" },
      ]);

      const { props } = renderNewTaskModal();

      // Type description
      fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Task with agent" } });

      // Open agent picker and select agent
      fireEvent.click(screen.getByTestId("new-task-agent-button"));

      await waitFor(() => {
        expect(screen.getByText("Executor Bot")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Executor Bot"));

      // Submit
      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

      await waitFor(() => {
        expect(props.onCreateTask).toHaveBeenCalledWith(
          expect.objectContaining({
            assignedAgentId: "agent-1",
          }),
        );
      });
    });

    it("omits assignedAgentId from payload when no agent is selected", async () => {
      const { props } = renderNewTaskModal();

      fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Task without agent" } });

      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

      await waitFor(() => {
        expect(props.onCreateTask).toHaveBeenCalledWith(
          expect.not.objectContaining({
            assignedAgentId: expect.anything(),
          }),
        );
      });
    });

    it("omits assignedAgentId from payload after clearing selection", async () => {
      const { fetchAgents } = await import("../../api");
      vi.mocked(fetchAgents).mockResolvedValueOnce([
        { id: "agent-1", name: "Executor Bot", role: "executor", state: "active" as const, metadata: {}, createdAt: "", updatedAt: "" },
      ]);

      const { props } = renderNewTaskModal();

      // Type description
      fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Task with agent" } });

      // Open agent picker and select agent
      fireEvent.click(screen.getByTestId("new-task-agent-button"));

      await waitFor(() => {
        expect(screen.getByText("Executor Bot")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Executor Bot"));

      // Open picker again and clear selection
      fireEvent.click(screen.getByTestId("new-task-agent-button"));

      await waitFor(() => {
        expect(screen.getByText("Clear selection")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Clear selection"));

      // Submit
      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

      await waitFor(() => {
        expect(props.onCreateTask).toHaveBeenCalledWith(
          expect.not.objectContaining({
            assignedAgentId: expect.anything(),
          }),
        );
      });
    });

    it("triggers dirty state when agent is selected", async () => {
      const { fetchAgents } = await import("../../api");
      vi.mocked(fetchAgents).mockResolvedValueOnce([
        { id: "agent-1", name: "Executor Bot", role: "executor", state: "active" as const, metadata: {}, createdAt: "", updatedAt: "" },
      ]);

      renderNewTaskModal();

      // Open agent picker and select agent
      fireEvent.click(screen.getByTestId("new-task-agent-button"));

      await waitFor(() => {
        expect(screen.getByText("Executor Bot")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Executor Bot"));

      // Try to close - should show confirm
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      await waitFor(() => {
        expect(mockConfirm).toHaveBeenCalledWith({
          title: "Discard Changes",
          message: "You have unsaved changes. Discard them?",
          danger: true,
        });
      });
    });

    it("resets agent selection after successful task creation", async () => {
      const { fetchAgents } = await import("../../api");
      vi.mocked(fetchAgents).mockResolvedValueOnce([
        { id: "agent-1", name: "Executor Bot", role: "executor", state: "active" as const, metadata: {}, createdAt: "", updatedAt: "" },
      ]);

      renderNewTaskModal();

      // Type description
      fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Task with agent" } });

      // Open agent picker and select agent
      fireEvent.click(screen.getByTestId("new-task-agent-button"));

      await waitFor(() => {
        expect(screen.getByText("Executor Bot")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Executor Bot"));

      // Submit
      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

      await waitFor(() => {
        expect(screen.getByTestId("new-task-agent-button")).toHaveTextContent("Assign agent");
      });
    });
  });

  describe("GitHub tracking", () => {
    it("renders GitHub tracking after the Workflow picker in more options", async () => {
      renderNewTaskModal();


      const workflowLabel = await screen.findByText("Workflow");
      const githubTrackingSection = screen.getByTestId("task-form-github-tracking");

      expect(
        workflowLabel.compareDocumentPosition(githubTrackingSection) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    });

    it("seeds tracking toggle from project settings and submits githubTracking payload", async () => {
      const { fetchSettings } = await import("../../api");
      vi.mocked(fetchSettings).mockResolvedValueOnce({
        modelPresets: [],
        autoSelectModelPreset: false,
        defaultPresetBySize: {},
        githubTrackingEnabledByDefault: true,
      });

      const { props } = renderNewTaskModal();
      fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Task with tracking" } });

      const toggle = await screen.findByLabelText("Enable GitHub issue tracking for this task");
      fireEvent.click(toggle);

      fireEvent.change(screen.getByLabelText("Repository (owner/repo)"), { target: { value: "acme/repo" } });
      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

      await waitFor(() => {
        expect(props.onCreateTask).toHaveBeenCalledTimes(1);
      });
    });
  });

  /*
  FNXC:NewTask 2026-06-22-20:30:
  On desktop the New Task dialog is a floating, draggable, resizable, NON-BLOCKING window: the overlay is `pointer-events: none` and aria-modal="false" so behind-clicks pass through and never close the dialog (only the header X / Cancel / Escape dismiss). It carries a draggable header handle and resize handles.
  */
  describe("workflow dropdown styling", () => {
    it("uses tokenized bounded dropdown styles without legacy native-select assumptions", () => {
      const workflowRules = Array.from(newTaskModalCss.matchAll(/\.task-workflow[^,{\s]*(?:[^{}]*)\{([^}]*)\}/g))
        .map((match) => match[0])
        .join("\n");

      expect(newTaskModalCss).toContain("FNXC:NewTaskWorkflowDropdown 2026-06-30");
      expect(workflowRules).toContain("var(--space-");
      expect(workflowRules).toContain("max-width: 100%");
      expect(workflowRules).toContain("overflow-y: auto");
      expect(workflowRules).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(/);
      expect(newTaskModalCss).toMatch(/@media \(max-width: 768px\)[\s\S]*\.task-form \.dep-dropdown/);
      expect(newTaskModalCss).not.toMatch(/task-workflow-select\s*\{/);
    });
  });

  describe("desktop floating window", () => {
    beforeEach(() => {
      mockViewportMode = "desktop";
    });

    it("renders a non-blocking (pointer-events: none, aria-modal=false) overlay that does not dismiss on click", () => {
      const onClose = vi.fn();
      renderNewTaskModal({ onClose });

      const overlay = screen.getByTestId("new-task-modal-overlay");
      // Non-blocking: click-through overlay, not a modal.
      expect(overlay).toHaveClass("new-task-modal-overlay");
      expect(overlay).toHaveAttribute("aria-modal", "false");

      // A behind-click on the overlay must NOT close the dialog (no overlay click-to-dismiss).
      fireEvent.click(overlay);
      expect(onClose).not.toHaveBeenCalled();
    });

    it("exposes a draggable header handle and resize handles", () => {
      renderNewTaskModal();

      expect(screen.getByTestId("new-task-drag-handle")).toHaveClass("new-task-modal__header--draggable");
      // All eight corner/edge resize handles are present.
      for (const dir of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
        expect(screen.getByTestId(`new-task-resize-${dir}`)).toBeInTheDocument();
      }
      // The floating panel is the fixed-positioned window.
      const panel = document.querySelector(".new-task-modal--floating");
      expect(panel).not.toBeNull();
    });

    it("keeps the floating window touch-draggable with theme-controlled shadow", () => {
      const panelRule = newTaskModalCss.match(/\.new-task-modal--floating\s*\{([^}]*)\}/)?.[1] ?? "";
      const headerRule = newTaskModalCss.match(/\.new-task-modal__header--draggable\s*\{([^}]*)\}/)?.[1] ?? "";

      expect(panelRule).toContain("box-shadow: var(--floating-window-shadow, var(--shadow-lg));");
      expect(headerRule).toContain("touch-action: none;");
      expect(headerRule).toContain("min-height: 48px;");
      expect(newTaskModalCss).not.toContain("var(--shadow-xl)");
    });

    it("still closes via the header close button (X)", async () => {
      const onClose = vi.fn();
      renderNewTaskModal({ onClose });

      fireEvent.click(screen.getByLabelText("Close"));
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    });
  });
});
