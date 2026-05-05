import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Header } from "../Header";
import { ResearchView } from "../ResearchView";

const mockUseResearch = vi.fn();

vi.mock("../../hooks/useResearch", () => ({
  useResearch: (...args: unknown[]) => mockUseResearch(...args),
}));

const configuredResearchSettings = {
  researchSettings: { enabled: true },
  researchGlobalDefaults: {
    searchProvider: "openrouter",
    synthesisProvider: "openrouter",
    synthesisModelId: "gpt-5",
    maxSourcesPerRun: 20,
  },
};

const mockFetchSettings = vi.fn().mockResolvedValue(configuredResearchSettings);
const mockFetchAuthStatus = vi.fn().mockResolvedValue({ providers: [{ id: "openrouter", type: "api_key", authenticated: false }] });
const mockFetchTasks = vi.fn().mockResolvedValue([{ id: "FN-1", title: "Existing task", column: "todo" }]);

vi.mock("../../api", () => ({
  fetchScripts: vi.fn().mockResolvedValue({}),
  fetchSettings: (...args: unknown[]) => mockFetchSettings(...args),
  fetchAuthStatus: (...args: unknown[]) => mockFetchAuthStatus(...args),
  fetchTasks: (...args: unknown[]) => mockFetchTasks(...args),
}));

vi.mock("lucide-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("lucide-react")>();
  return {
    ...actual,
    Search: () => null,
    Loader2: ({ className }: { className?: string }) => <span data-testid="loader-icon" className={className}>Loader</span>,
  };
});

function mockMatchMediaDesktop() {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe("Research navigation", () => {
  it("shows research in header overflow and activates view change", async () => {
    mockMatchMediaDesktop();
    const onChangeView = vi.fn();

    render(
      <Header
        onOpenSettings={vi.fn()}
        onOpenGitHubImport={vi.fn()}
        globalPaused={false}
        enginePaused={false}
        onToggleGlobalPause={vi.fn()}
        onToggleEnginePause={vi.fn()}
        view="board"
        onChangeView={onChangeView}
        experimentalFeatures={{ researchView: true }}
      />,
    );

    fireEvent.click(screen.getByTestId("view-toggle-overflow-trigger"));
    await waitFor(() => expect(screen.getByTestId("view-overflow-research")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("view-overflow-research"));
    expect(onChangeView).toHaveBeenCalledWith("research");
  });
});

describe("ResearchView", () => {
  const baseHookValue = {
    runs: [],
    selectedRun: null,
    selectedRunId: null,
    setSelectedRunId: vi.fn(),
    availability: { available: true, supportedProviders: ["web-search"], supportedExportFormats: ["markdown", "json", "html"] },
    loading: false,
    error: null,
    searchQuery: "",
    setSearchQuery: vi.fn(),
    createRun: vi.fn(),
    cancelRun: vi.fn().mockResolvedValue({}),
    retryRun: vi.fn().mockResolvedValue({}),
    exportRun: vi.fn().mockResolvedValue({ filename: "run.md", content: "# test", format: "markdown" }),
    createTaskFromRun: vi.fn().mockResolvedValue({}),
    attachRunToTask: vi.fn().mockResolvedValue({}),
    uiError: null,
    runActionState: { cancelable: true, retryable: true, isTransitioning: false, blockingReason: undefined },
    statusCounts: { queued: 0, running: 0, cancelling: 0, retry_waiting: 0, completed: 0, failed: 0, cancelled: 0, timed_out: 0, retry_exhausted: 0 },
    refresh: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchSettings.mockResolvedValue(configuredResearchSettings);
    mockFetchAuthStatus.mockResolvedValue({ providers: [{ id: "openrouter", type: "api_key", authenticated: false }] });
    mockUseResearch.mockReturnValue(baseHookValue);
  });

  it("shows authentication setup state when required credentials are missing", async () => {
    mockFetchSettings.mockResolvedValue(configuredResearchSettings);
    render(<ResearchView projectId="p1" />);
    expect(await screen.findByText(/Missing API key for openrouter/i)).toBeInTheDocument();
  });

  it("renders empty state when required credentials are configured", async () => {
    mockFetchSettings.mockResolvedValue(configuredResearchSettings);
    mockFetchAuthStatus.mockResolvedValue({ providers: [{ id: "openrouter", type: "api_key", authenticated: true }] });
    render(<ResearchView projectId="p1" />);
    expect(await screen.findByTestId("research-state-empty")).toBeInTheDocument();
  });

  it("renders selected run details, citations, and history", async () => {
    mockUseResearch.mockReturnValue({
      ...baseHookValue,
      runs: [{ id: "RR-1", title: "t", query: "q", status: "running" }],
      selectedRun: {
        id: "RR-1",
        title: "t",
        query: "q",
        status: "running",
        events: [{ id: "evt-1", message: "Started" }],
        results: { summary: "Summary", findings: [], citations: ["https://example.com"] },
      },
      selectedRunId: "RR-1",
      statusCounts: { queued: 0, running: 1, cancelling: 0, retry_waiting: 0, completed: 0, failed: 0, cancelled: 0, timed_out: 0, retry_exhausted: 0 },
    });
    mockFetchAuthStatus.mockResolvedValue({ providers: [{ id: "openrouter", type: "api_key", authenticated: true }] });

    render(<ResearchView projectId="p1" />);
    expect(await screen.findByTestId("research-state-results")).toHaveTextContent("Summary");
    expect(screen.getByRole("link", { name: "https://example.com" })).toHaveAttribute("href", "https://example.com");
    fireEvent.click(screen.getByText("Run history"));
    expect(screen.getByText("Started")).toBeInTheDocument();
  });

  it("disables cancel/retry when lifecycle state blocks transitions", async () => {
    mockUseResearch.mockReturnValue({
      ...baseHookValue,
      runs: [{ id: "RR-1", title: "t", query: "q", status: "completed" }],
      selectedRun: {
        id: "RR-1",
        title: "t",
        query: "q",
        status: "completed",
        events: [{ id: "E-1", message: "completed" }],
        results: { summary: "Summary", findings: [], citations: [] },
      },
      selectedRunId: "RR-1",
      runActionState: { cancelable: false, retryable: false, isTransitioning: false, blockingReason: "Completed runs cannot be cancelled" },
    });
    mockFetchAuthStatus.mockResolvedValue({ providers: [{ id: "openrouter", type: "api_key", authenticated: true }] });

    render(<ResearchView projectId="p1" />);
    expect(await screen.findByText("Cancel")).toBeDisabled();
    expect(screen.getByText("Retry")).toBeDisabled();
    expect(screen.getByText("Completed runs cannot be cancelled")).toBeInTheDocument();
  });

  it("shows actionable uiError guidance", async () => {
    mockUseResearch.mockReturnValue({
      ...baseHookValue,
      runs: [{ id: "RR-1", title: "t", query: "q", status: "failed" }],
      selectedRun: {
        id: "RR-1",
        title: "t",
        query: "q",
        status: "failed",
        events: [],
        results: { summary: "Summary", findings: [], citations: [] },
      },
      selectedRunId: "RR-1",
      uiError: { message: "Missing credentials", code: "MISSING_CREDENTIALS", setupHint: "Configure provider key" },
    });
    mockFetchAuthStatus.mockResolvedValue({ providers: [{ id: "openrouter", type: "api_key", authenticated: true }] });
    const onOpenSettings = vi.fn();

    render(<ResearchView projectId="p1" onOpenSettings={onOpenSettings} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Missing credentials");
    fireEvent.click(screen.getByRole("button", { name: "Open Authentication Settings" }));
    expect(onOpenSettings).toHaveBeenCalledWith("authentication");
  });

  it("triggers lifecycle/task/export actions", async () => {
    const cancelRun = vi.fn().mockResolvedValue({});
    const createTaskFromRun = vi.fn().mockResolvedValue({});
    const attachRunToTask = vi.fn().mockResolvedValue({});
    const exportRun = vi.fn().mockResolvedValue({ filename: "run.md", content: "# test", format: "markdown" });

    mockUseResearch.mockReturnValue({
      ...baseHookValue,
      runs: [{ id: "RR-1", title: "t", query: "q", status: "queued" }],
      selectedRun: {
        id: "RR-1",
        title: "t",
        query: "q",
        status: "queued",
        events: [{ id: "E-1", message: "queued" }],
        results: { summary: "Summary", findings: [{ id: "finding-1", heading: "Finding", content: "Impact." }], citations: [] },
      },
      selectedRunId: "RR-1",
      cancelRun,
      createTaskFromRun,
      attachRunToTask,
      exportRun,
    });
    mockFetchAuthStatus.mockResolvedValue({ providers: [{ id: "openrouter", type: "api_key", authenticated: true }] });

    render(<ResearchView projectId="p1" />);
    await screen.findByText("Cancel");

    fireEvent.click(screen.getByText("Cancel"));
    fireEvent.click(screen.getByText("Export MD"));

    fireEvent.click(screen.getAllByText("Create Task")[0]);
    const createDialog = await screen.findByRole("dialog");
    fireEvent.click(within(createDialog).getByRole("button", { name: "Create Task" }));

    await waitFor(() => {
      expect(cancelRun).toHaveBeenCalled();
      expect(createTaskFromRun).toHaveBeenCalled();
      expect(exportRun).toHaveBeenCalled();
    });
  });

  it("triggers enrich-task action from finding modal", async () => {
    const attachRunToTask = vi.fn().mockResolvedValue({});
    mockUseResearch.mockReturnValue({
      ...baseHookValue,
      runs: [{ id: "RR-1", title: "t", query: "q", status: "queued" }],
      selectedRun: {
        id: "RR-1",
        title: "t",
        query: "q",
        status: "queued",
        events: [],
        results: { summary: "Summary", findings: [{ id: "finding-1", heading: "Finding", content: "Impact." }], citations: [] },
      },
      selectedRunId: "RR-1",
      attachRunToTask,
    });
    mockFetchAuthStatus.mockResolvedValue({ providers: [{ id: "openrouter", type: "api_key", authenticated: true }] });

    render(<ResearchView projectId="p1" />);
    fireEvent.click((await screen.findAllByText("Enrich Task"))[0]);

    const enrichDialog = await screen.findByRole("dialog");
    const targetInput = within(enrichDialog).getByRole("combobox", { name: "Target task" });
    fireEvent.change(targetInput, { target: { value: "FN-1" } });
    fireEvent.click(within(enrichDialog).getByRole("button", { name: "Enrich Task" }));

    await waitFor(() => {
      expect(attachRunToTask).toHaveBeenCalledWith("RR-1", "FN-1", "finding-1", false);
    });
  });

  it("disables create-run button while submitting", async () => {
    let resolveCreate: ((value: unknown) => void) | undefined;
    const createRun = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );
    mockFetchAuthStatus.mockResolvedValue({ providers: [{ id: "openrouter", type: "api_key", authenticated: true }] });
    mockUseResearch.mockReturnValue({ ...baseHookValue, createRun });

    render(<ResearchView projectId="p1" />);
    fireEvent.change(await screen.findByLabelText("Query"), { target: { value: "async query" } });
    const createButton = screen.getByRole("button", { name: /Create Run/i });

    fireEvent.click(createButton);
    await waitFor(() => expect(createButton).toBeDisabled());

    resolveCreate?.({ run: { id: "RR-2" } });
    await waitFor(() => expect(createRun).toHaveBeenCalledWith({ query: "async query", providers: ["web-search"] }));
  });

  it("wires search field and run selection interactions", async () => {
    const setSearchQuery = vi.fn();
    const setSelectedRunId = vi.fn();
    mockFetchAuthStatus.mockResolvedValue({ providers: [{ id: "openrouter", type: "api_key", authenticated: true }] });
    mockUseResearch.mockReturnValue({
      ...baseHookValue,
      searchQuery: "",
      setSearchQuery,
      setSelectedRunId,
      runs: [
        { id: "RR-1", title: "Alpha", query: "alpha", status: "queued" },
        { id: "RR-2", title: "Beta", query: "beta", status: "completed" },
      ],
    });

    render(<ResearchView projectId="p1" />);
    fireEvent.change(await screen.findByPlaceholderText("Search runs"), { target: { value: "beta" } });
    expect(setSearchQuery).toHaveBeenCalledWith("beta");

    fireEvent.click(screen.getByRole("button", { name: /RR-2/i }));
    expect(setSelectedRunId).toHaveBeenCalledWith("RR-2");
  });

  it("renders unavailable state without interactive workflow controls", async () => {
    mockUseResearch.mockReturnValue({ ...baseHookValue, availability: { available: false, reason: "disabled" } });
    render(<ResearchView projectId="p1" />);
    expect(await screen.findByTestId("research-state-unavailable")).toBeInTheDocument();
    expect(screen.queryByLabelText("Query")).not.toBeInTheDocument();
    expect(screen.queryByText("Create Run")).not.toBeInTheDocument();
  });

  it("shows setup card when project research is disabled", async () => {
    mockFetchSettings.mockResolvedValue({
      ...configuredResearchSettings,
      researchSettings: { enabled: false },
    });
    const onOpenSettings = vi.fn();
    render(<ResearchView projectId="p1" onOpenSettings={onOpenSettings} />);
    expect(await screen.findByText("Research is disabled for this project.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    expect(onOpenSettings).toHaveBeenCalledWith("research-project");
  });

  it("shows incomplete defaults setup CTA routed to global research settings", async () => {
    mockFetchSettings.mockResolvedValue({
      researchSettings: { enabled: true },
      researchGlobalDefaults: {
        searchProvider: "tavily",
        synthesisProvider: undefined,
        synthesisModelId: undefined,
        maxSourcesPerRun: 20,
      },
    });
    mockFetchAuthStatus.mockResolvedValue({ providers: [{ id: "tavily", type: "api_key", authenticated: true }] });

    const onOpenSettings = vi.fn();
    render(<ResearchView projectId="p1" onOpenSettings={onOpenSettings} />);
    expect(await screen.findByText(/Research defaults are incomplete/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    expect(onOpenSettings).toHaveBeenCalledWith("research-global");
  });

  it("shows authentication CTA when provider credentials are missing", async () => {
    mockFetchSettings.mockResolvedValue({
      researchSettings: { enabled: true },
      researchGlobalDefaults: {
        searchProvider: "tavily",
        synthesisProvider: "openrouter",
        synthesisModelId: "gpt-5",
        maxSourcesPerRun: 20,
      },
    });
    mockFetchAuthStatus.mockResolvedValue({
      providers: [
        { id: "tavily", type: "api_key", authenticated: false },
        { id: "openrouter", type: "api_key", authenticated: true },
      ],
    });
    const onOpenSettings = vi.fn();
    render(<ResearchView projectId="p1" onOpenSettings={onOpenSettings} />);
    expect(await screen.findByText(/Missing API key for tavily/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    expect(onOpenSettings).toHaveBeenCalledWith("authentication");
  });

  it("renders human-readable provider labels", async () => {
    mockUseResearch.mockReturnValue({
      ...baseHookValue,
      availability: { available: true, supportedProviders: ["web-search", "page-fetch", "llm-synthesis"] },
    });
    mockFetchAuthStatus.mockResolvedValue({ providers: [{ id: "openrouter", type: "api_key", authenticated: true }] });
    render(<ResearchView projectId="p1" />);
    expect(await screen.findByText("Web Search")).toBeInTheDocument();
    expect(screen.getByText("Page Fetch")).toBeInTheDocument();
    expect(screen.getByText("LLM Synthesis")).toBeInTheDocument();
  });

  it("disables provider checkboxes when sources are disabled in settings", async () => {
    mockFetchSettings.mockResolvedValue({
      ...configuredResearchSettings,
      researchGlobalDefaults: {
        ...configuredResearchSettings.researchGlobalDefaults,
        enabledSources: {
          webSearch: false,
          pageFetch: true,
          github: false,
          localDocs: true,
          llmSynthesis: true,
        },
      },
    });
    mockFetchAuthStatus.mockResolvedValue({ providers: [{ id: "openrouter", type: "api_key", authenticated: true }] });

    mockUseResearch.mockReturnValue({
      ...baseHookValue,
      availability: { available: true, supportedProviders: ["web-search", "page-fetch", "llm-synthesis"] },
    });

    render(<ResearchView projectId="p1" />);

    const webSearch = (await screen.findByLabelText("Web Search")) as HTMLInputElement;
    const pageFetch = screen.getByLabelText("Page Fetch") as HTMLInputElement;
    expect(webSearch.disabled).toBe(true);
    expect(pageFetch.disabled).toBe(false);
  });

  it("submits only enabled providers", async () => {
    const createRun = vi.fn().mockResolvedValue({ run: { id: "RR-2" } });
    mockFetchSettings.mockResolvedValue({
      ...configuredResearchSettings,
      researchGlobalDefaults: {
        ...configuredResearchSettings.researchGlobalDefaults,
        enabledSources: {
          webSearch: false,
          pageFetch: true,
          github: false,
          localDocs: false,
          llmSynthesis: true,
        },
      },
    });
    mockFetchAuthStatus.mockResolvedValue({ providers: [{ id: "openrouter", type: "api_key", authenticated: true }] });
    mockUseResearch.mockReturnValue({
      ...baseHookValue,
      createRun,
      availability: { available: true, supportedProviders: ["web-search", "page-fetch", "llm-synthesis"] },
    });

    render(<ResearchView projectId="p1" />);
    fireEvent.change(await screen.findByLabelText("Query"), { target: { value: "hello" } });
    fireEvent.click(screen.getByText("Create Run"));

    await waitFor(() => {
      expect(createRun).toHaveBeenCalledWith(expect.objectContaining({ providers: ["page-fetch", "llm-synthesis"] }));
    });
  });

  it("refreshes readiness state when readinessVersion changes", async () => {
    const onOpenSettings = vi.fn();
    mockFetchSettings.mockResolvedValueOnce(configuredResearchSettings);
    mockFetchAuthStatus.mockResolvedValueOnce({ providers: [{ id: "openrouter", type: "api_key", authenticated: false }] });

    const { rerender } = render(<ResearchView projectId="p1" onOpenSettings={onOpenSettings} readinessVersion={0} />);
    expect(await screen.findByText(/Missing API key for openrouter/i)).toBeInTheDocument();

    mockFetchSettings.mockResolvedValueOnce(configuredResearchSettings);
    mockFetchAuthStatus.mockResolvedValueOnce({ providers: [{ id: "openrouter", type: "api_key", authenticated: true }] });
    rerender(<ResearchView projectId="p1" onOpenSettings={onOpenSettings} readinessVersion={1} />);

    expect(await screen.findByTestId("research-state-empty")).toBeInTheDocument();
  });

  it("wires create-task modal payload with trimmed fields and attachment toggle", async () => {
    const createTaskFromRun = vi.fn().mockResolvedValue({});
    mockUseResearch.mockReturnValue({
      ...baseHookValue,
      createTaskFromRun,
      runs: [{ id: "RR-1", title: "t", query: "q", status: "completed" }],
      selectedRun: {
        id: "RR-1",
        title: "t",
        query: "q",
        status: "completed",
        events: [],
        results: { summary: "Summary", findings: [{ id: "finding-1", heading: "Finding", content: "Impact." }], citations: [] },
      },
      selectedRunId: "RR-1",
    });
    mockFetchAuthStatus.mockResolvedValue({ providers: [{ id: "openrouter", type: "api_key", authenticated: true }] });

    render(<ResearchView projectId="p1" />);
    fireEvent.click((await screen.findAllByText("Create Task"))[0]);

    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "  Follow up task  " } });
    fireEvent.change(within(dialog).getByLabelText("Description"), { target: { value: "  Take action now.  " } });
    fireEvent.click(within(dialog).getByLabelText("Attach markdown export artifact"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Create Task" }));

    await waitFor(() => {
      expect(createTaskFromRun).toHaveBeenCalledWith("RR-1", "Follow up task", "finding-1", "Take action now.", "normal", true);
    });
  });

  it("keeps enrich action disabled until a task id is provided", async () => {
    mockUseResearch.mockReturnValue({
      ...baseHookValue,
      runs: [{ id: "RR-1", title: "t", query: "q", status: "completed" }],
      selectedRun: {
        id: "RR-1",
        title: "t",
        query: "q",
        status: "completed",
        events: [],
        results: { summary: "Summary", findings: [{ id: "finding-1", heading: "Finding", content: "Impact." }], citations: [] },
      },
      selectedRunId: "RR-1",
    });
    mockFetchAuthStatus.mockResolvedValue({ providers: [{ id: "openrouter", type: "api_key", authenticated: true }] });

    render(<ResearchView projectId="p1" />);
    fireEvent.click((await screen.findAllByText("Enrich Task"))[0]);

    const dialog = await screen.findByRole("dialog");
    const enrichButton = within(dialog).getByRole("button", { name: "Enrich Task" });
    expect(enrichButton).toBeDisabled();

    const targetInput = within(dialog).getByRole("combobox", { name: "Target task" });
    fireEvent.change(targetInput, { target: { value: "FN-1" } });
    await waitFor(() => expect(enrichButton).not.toBeDisabled());
  });

  it("includes mobile layout media rule", async () => {
    const css = await import("../ResearchView.css?inline");
    expect(css.default).toContain("@media (max-width: 768px)");
    expect(css.default).toContain(".research-view__layout");
  });
});
