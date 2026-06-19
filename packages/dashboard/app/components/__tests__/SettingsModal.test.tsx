import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ComponentProps } from "react";
import { render, screen, fireEvent, waitFor, within, act, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditorView } from "@codemirror/view";
import { SettingsModal } from "../SettingsModal";
import { __test_clearCache as clearPluginUiSlotsCache } from "../../hooks/usePluginUiSlots";
import type { PluginUiContributionEntry, SettingsExportData, UpdateCheckResponse } from "../../api";
import { ApiRequestError } from "../../api";

// --- API mocks ---
const mockFetchSettings = vi.fn();
const mockFetchSettingsByScope = vi.fn();
const mockExportSettings = vi.fn();
const mockUpdateSettings = vi.fn();
const mockUpdateGlobalSettings = vi.fn();
const mockFetchAuthStatus = vi.fn();
const mockLoginProvider = vi.fn();
const mockLogoutProvider = vi.fn();
const mockCancelProviderLogin = vi.fn();
const mockSaveApiKey = vi.fn();
const mockSubmitProviderManualCode = vi.fn();
const mockFetchModels = vi.fn();
const mockFetchWorkflow = vi.fn();
const mockFetchWorkflowSettingValues = vi.fn();
const mockUpdateWorkflowSettingValues = vi.fn();
const mockFetchCustomProviders = vi.fn();
const mockCreateCustomProvider = vi.fn();
const mockUpdateCustomProvider = vi.fn();
const mockDeleteCustomProvider = vi.fn();
const mockTestNtfyNotification = vi.fn();
const mockTestNotification = vi.fn();
const mockFetchBackups = vi.fn();
const mockCreateBackup = vi.fn();
const mockImportSettings = vi.fn();
const mockFetchMemoryFiles = vi.fn();
const mockFetchMemoryFile = vi.fn();
const mockSaveMemoryFile = vi.fn();
const mockCompactMemory = vi.fn();
const mockFetchGlobalConcurrency = vi.fn();
const mockUpdateGlobalConcurrency = vi.fn();
const mockFetchMemoryBackendStatus = vi.fn();
const mockTestMemoryRetrieval = vi.fn();
const mockInstallQmd = vi.fn();
const mockFetchGitRemotes = vi.fn();
const mockFetchGitRemotesDetailed = vi.fn();
const mockFetchProjects = vi.fn();
const mockFetchDashboardHealth = vi.fn();
const mockCheckForUpdates = vi.fn();
const mockInstallUpdate = vi.fn();
const mockFetchRemoteSettings = vi.fn();
const mockUpdateRemoteSettings = vi.fn();
const mockFetchRemoteStatus = vi.fn();
const mockInstallCloudflared = vi.fn();
const mockStartRemoteTunnel = vi.fn();
const mockStopRemoteTunnel = vi.fn();
const mockKillExternalTunnel = vi.fn();
const mockRegenerateRemotePersistentToken = vi.fn();
const mockGenerateShortLivedRemoteToken = vi.fn();
const mockFetchRemoteQr = vi.fn();
const mockFetchRemoteUrl = vi.fn();
const mockTriggerMemoryDreams = vi.fn();
const mockFetchPluginUiSlots = vi.fn();
const mockFetchDroidCliStatus = vi.fn();
const mockSetDroidCliEnabled = vi.fn();
const mockFetchCursorCliStatus = vi.fn();
const mockSetCursorCliEnabled = vi.fn();
const mockUseWorkspaceFileBrowser = vi.fn();
const mockConfirm = vi.fn();
const mockUseWorktrunkInstallStatus = vi.fn();

vi.mock("../../api", async (importOriginal) => {
  const { createDashboardApiMock } = await import("../../test/mockApi");
  return createDashboardApiMock(() => importOriginal<typeof import("../../api")>(), {
    fetchSettings: (...args: unknown[]) => mockFetchSettings(...args),
    fetchSettingsByScope: (...args: unknown[]) => mockFetchSettingsByScope(...args),
    updateSettings: (...args: unknown[]) => mockUpdateSettings(...args),
    updateGlobalSettings: (...args: unknown[]) => mockUpdateGlobalSettings(...args),
    exportSettings: (...args: unknown[]) => mockExportSettings(...args),
    importSettings: (...args: unknown[]) => mockImportSettings(...args),
    fetchAuthStatus: (...args: unknown[]) => mockFetchAuthStatus(...args),
    loginProvider: (...args: unknown[]) => mockLoginProvider(...args),
    logoutProvider: (...args: unknown[]) => mockLogoutProvider(...args),
    cancelProviderLogin: (...args: unknown[]) => mockCancelProviderLogin(...args),
    saveApiKey: (...args: unknown[]) => mockSaveApiKey(...args),
    submitProviderManualCode: (...args: unknown[]) => mockSubmitProviderManualCode(...args),
    fetchModels: (...args: unknown[]) => mockFetchModels(...args),
    fetchWorkflow: (...args: unknown[]) => mockFetchWorkflow(...args),
    fetchWorkflowSettingValues: (...args: unknown[]) => mockFetchWorkflowSettingValues(...args),
    updateWorkflowSettingValues: (...args: unknown[]) => mockUpdateWorkflowSettingValues(...args),
    fetchCustomProviders: (...args: unknown[]) => mockFetchCustomProviders(...args),
    createCustomProvider: (...args: unknown[]) => mockCreateCustomProvider(...args),
    updateCustomProvider: (...args: unknown[]) => mockUpdateCustomProvider(...args),
    deleteCustomProvider: (...args: unknown[]) => mockDeleteCustomProvider(...args),
    testNtfyNotification: (...args: unknown[]) => mockTestNtfyNotification(...args),
    testNotification: (...args: unknown[]) => mockTestNotification(...args),
    fetchBackups: (...args: unknown[]) => mockFetchBackups(...args),
    createBackup: (...args: unknown[]) => mockCreateBackup(...args),
    fetchMemoryFiles: (...args: unknown[]) => mockFetchMemoryFiles(...args),
    fetchMemoryFile: (...args: unknown[]) => mockFetchMemoryFile(...args),
    saveMemoryFile: (...args: unknown[]) => mockSaveMemoryFile(...args),
    compactMemory: (...args: unknown[]) => mockCompactMemory(...args),
    fetchGlobalConcurrency: (...args: unknown[]) => mockFetchGlobalConcurrency(...args),
    updateGlobalConcurrency: (...args: unknown[]) => mockUpdateGlobalConcurrency(...args),
    fetchMemoryBackendStatus: (...args: unknown[]) => mockFetchMemoryBackendStatus(...args),
    testMemoryRetrieval: (...args: unknown[]) => mockTestMemoryRetrieval(...args),
    installQmd: (...args: unknown[]) => mockInstallQmd(...args),
    fetchGitRemotes: (...args: unknown[]) => mockFetchGitRemotes(...args),
    fetchGitRemotesDetailed: (...args: unknown[]) => mockFetchGitRemotesDetailed(...args),
    fetchProjects: (...args: unknown[]) => mockFetchProjects(...args),
    fetchDashboardHealth: (...args: unknown[]) => mockFetchDashboardHealth(...args),
    checkForUpdates: (...args: unknown[]) => mockCheckForUpdates(...args),
    installUpdate: (...args: unknown[]) => mockInstallUpdate(...args),
    fetchRemoteSettings: (...args: unknown[]) => mockFetchRemoteSettings(...args),
    updateRemoteSettings: (...args: unknown[]) => mockUpdateRemoteSettings(...args),
    fetchRemoteStatus: (...args: unknown[]) => mockFetchRemoteStatus(...args),
    installCloudflared: (...args: unknown[]) => mockInstallCloudflared(...args),
    startRemoteTunnel: (...args: unknown[]) => mockStartRemoteTunnel(...args),
    stopRemoteTunnel: (...args: unknown[]) => mockStopRemoteTunnel(...args),
    killExternalTunnel: (...args: unknown[]) => mockKillExternalTunnel(...args),
    regenerateRemotePersistentToken: (...args: unknown[]) => mockRegenerateRemotePersistentToken(...args),
    generateShortLivedRemoteToken: (...args: unknown[]) => mockGenerateShortLivedRemoteToken(...args),
    fetchRemoteQr: (...args: unknown[]) => mockFetchRemoteQr(...args),
    fetchRemoteUrl: (...args: unknown[]) => mockFetchRemoteUrl(...args),
    triggerMemoryDreams: (...args: unknown[]) => mockTriggerMemoryDreams(...args),
    fetchPluginUiSlots: (...args: unknown[]) => mockFetchPluginUiSlots(...args),
    fetchDroidCliStatus: (...args: unknown[]) => mockFetchDroidCliStatus(...args),
    setDroidCliEnabled: (...args: unknown[]) => mockSetDroidCliEnabled(...args),
    fetchCursorCliStatus: (...args: unknown[]) => mockFetchCursorCliStatus(...args),
    setCursorCliEnabled: (...args: unknown[]) => mockSetCursorCliEnabled(...args),
  });
});

// Mock the hook
const mockUseMemoryBackendStatus = vi.fn();
vi.mock("../../hooks/useMemoryBackendStatus", () => ({
  useMemoryBackendStatus: (...args: unknown[]) => mockUseMemoryBackendStatus(...args),
}));

const mockUseMobileKeyboard = vi.fn();
vi.mock("../../hooks/useMobileKeyboard", () => ({
  useMobileKeyboard: (...args: unknown[]) => mockUseMobileKeyboard(...args),
}));

vi.mock("../../hooks/useConfirm", () => ({
  useConfirm: () => ({ confirm: (...args: unknown[]) => mockConfirm(...args) }),
}));

vi.mock("../../hooks/useViewportMode", () => ({
  MOBILE_MEDIA_QUERY: "(max-width: 768px), (max-height: 480px)",
  getViewportMode: () => "mobile",
  isMobileViewport: () => true,
  useViewportMode: () => "mobile",
}));
vi.mock("lucide-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("lucide-react")>();
  return {
    ...actual,
    Globe: () => <span data-testid="icon-globe" />,
    Folder: () => <span data-testid="icon-folder" />,
    RefreshCw: ({ className }: { className?: string }) => <span data-testid="icon-refresh" className={className} />,
    Star: ({ size }: { size?: number }) => <span data-testid="icon-star" style={{ width: size, height: size }} />,
    HelpCircle: ({ size }: { size?: number }) => <span data-testid="icon-help-circle" style={{ width: size, height: size }} />,
    Loader2: ({ className }: { className?: string }) => <span data-testid="icon-loader2" className={className} />,
  };
});

vi.mock("../PluginManager", () => ({
  PluginManager: () => <div data-testid="plugin-manager">Plugin manager content</div>,
}));

vi.mock("../PiExtensionsManager", () => ({
  PiExtensionsManager: () => <div data-testid="pi-extensions-manager">Pi extensions content</div>,
}));


vi.mock("../../hooks/useWorkspaceFileBrowser", () => ({
  useWorkspaceFileBrowser: (...args: unknown[]) => mockUseWorkspaceFileBrowser(...args),
}));

vi.mock("../../hooks/useWorktrunkInstallStatus", () => ({
  useWorktrunkInstallStatus: (...args: unknown[]) => mockUseWorktrunkInstallStatus(...args),
}));

vi.mock("../FileBrowser", () => ({
  FileBrowser: ({ onSelectFile }: { onSelectFile: (path: string) => void }) => (
    <div data-testid="mock-overlap-file-browser">
      <button type="button" onClick={() => onSelectFile("README.md")}>Select README.md</button>
    </div>
  ),
}));

const noop = () => {};

const defaultSettings = {
  maxConcurrent: 2,
  maxWorktrees: 4,
  pollIntervalMs: 15000,
  groupOverlappingFiles: true,
  overlapIgnorePaths: [],
  autoMerge: true,
  mergeStrategy: "direct",
  merger: { mode: "deterministic" },
  directMergeCommitStrategy: "auto",
  mergeIntegrationWorktree: "reuse-task-worktree",
  pushAfterMerge: false,
  pushRemote: "origin",
  verificationFixRetries: 2,
  workflowRevisionForkOnScopeMismatch: true,
  recycleWorktrees: false,
  ephemeralAgentsEnabled: true,
  executorAllowSiblingBranchRename: false,
  worktreeNaming: "random",
  worktreesDir: "",
  worktrunk: {
    enabled: false,
    onFailure: "fail",
  },
  includeTaskIdInCommit: true,
  worktreeInitCommand: "",
  ntfyEnabled: false,
  ntfyTopic: undefined,
  ntfyAccessToken: undefined,
  webhookEnabled: false,
  webhookUrl: undefined,
  webhookFormat: undefined,
  webhookEvents: undefined,
};

function renderModal(props: Partial<ComponentProps<typeof SettingsModal>> = {}) {
  return render(
    <SettingsModal
      onClose={noop}
      addToast={noop}
      initialSection="authentication"
      {...props}
    />
  );
}

async function waitForSettingsModalReady() {
  await screen.findByRole("button", { name: /^Save$/i });
  expect(mockFetchSettings).toHaveBeenCalled();
  expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
}

const MODEL_FIXTURE = [
  { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true, contextWindow: 200000 },
  { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
];

type PersistSettingInput = {
  section: string;
  label: string;
  kind: "checkbox" | "text" | "number" | "select";
  value: boolean | string | number;
  scope: "project" | "global";
  expectedKey: string;
};

async function expectSettingPersists({ section, label, kind, value, scope, expectedKey }: PersistSettingInput) {
  const user = userEvent.setup({ delay: null });
  renderModal();
  await waitForSettingsModalReady();
  await user.click(screen.getByRole("button", { name: new RegExp(`^${section}$`, "i") }));

  const control = await screen.findByLabelText(label);
  if (kind === "checkbox") {
    const shouldBeChecked = Boolean(value);
    if ((control as HTMLInputElement).checked !== shouldBeChecked) {
      await user.click(control);
    }
  } else if (kind === "select") {
    await user.selectOptions(control, String(value));
  } else {
    await user.clear(control);
    await user.type(control, String(value));
  }

  await user.click(screen.getByRole("button", { name: /^Save$/i }));

  if (scope === "global") {
    await waitFor(() => expect(mockUpdateGlobalSettings).toHaveBeenCalled());
    expect(mockUpdateGlobalSettings.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ [expectedKey]: value }),
    );
    return;
  }

  await waitFor(() => expect(mockUpdateSettings).toHaveBeenCalled());
  expect(mockUpdateSettings.mock.calls[0]?.[0]).toEqual(
    expect.objectContaining({ [expectedKey]: value }),
  );
}

async function assertProjectModelSavePayload(provider: string, modelId: string, expectedKeys: string[]) {
  const user = userEvent.setup({ delay: null });
  renderModal({ initialSection: "project-models" });
  await waitForSettingsModalReady();

  await user.selectOptions(screen.getByLabelText("Default Provider"), provider);
  await user.selectOptions(screen.getByLabelText("Default Model"), modelId);
  await user.click(screen.getByRole("button", { name: /^Save$/i }));

  await waitFor(() => {
    expect(mockUpdateSettings).toHaveBeenCalledWith(
      expect.objectContaining(
        expectedKeys.reduce<Record<string, string>>((acc, key) => {
          acc[key] = key.includes("Provider") ? provider : modelId;
          return acc;
        }, {}),
      ),
    );
  });
}

function forEachProvider<T>(providers: T[], fn: (provider: T) => void) {
  providers.forEach(fn);
}

describe("SettingsModal", () => {
  it("applies keyboard CSS variables when mobile keyboard is open", async () => {
    mockUseMobileKeyboard.mockReturnValue({
      keyboardOpen: true,
      keyboardOverlap: 250,
      viewportHeight: 400,
      viewportOffsetTop: 50,
    });

    const { container } = renderModal();
    await waitForSettingsModalReady();
    const modal = container.querySelector(".settings-modal");

    expect(mockUseMobileKeyboard).toHaveBeenCalledWith({ enabled: true });
    expect(modal?.getAttribute("style")).toContain("--keyboard-overlap: 250px");
    expect(modal?.getAttribute("style")).toContain("--vv-height: 400px");
  });

  it("defaults to the global General section when no initialSection is provided", async () => {
    render(
      <SettingsModal
        onClose={noop}
        addToast={noop}
      />,
    );
    await waitForSettingsModalReady();

    expect(screen.getByRole("button", { name: /^General$/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "General" })).toBeInTheDocument();
  });

  it("honors an explicit initialSection override", async () => {
    renderModal({ initialSection: "authentication" });
    await waitForSettingsModalReady();

    expect(screen.getByRole("button", { name: /^Authentication$/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Authentication" })).toBeInTheDocument();
  });

  it("maps the legacy pi-extensions initialSection alias to Plugins", async () => {
    renderModal({ initialSection: "pi-extensions" });
    await waitForSettingsModalReady();

    expect(screen.getByRole("button", { name: /^Plugins$/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Plugins" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Pi Extensions" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByTestId("pi-extensions-manager")).toBeInTheDocument();
  });

  it("shows a Secrets entry in the settings nav", async () => {
    renderModal();
    await waitForSettingsModalReady();

    expect(screen.getByRole("button", { name: "Secrets" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Manage secrets" })).not.toBeInTheDocument();
  });

  it("renders the SecretsView when the Secrets section is selected", async () => {
    renderModal();
    await waitForSettingsModalReady();

    await userEvent.click(screen.getByRole("button", { name: "Secrets" }));

    expect(await screen.findByRole("button", { name: "Add Secret" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Manage secrets" })).not.toBeInTheDocument();
  });

  it("shows direct merge commit routing only for direct merges", async () => {
    mockFetchProjects.mockResolvedValueOnce([{ id: "p-1", name: "Alpha" }]);
    mockFetchSettings.mockResolvedValueOnce({ ...defaultSettings, merger: { mode: "legacy" } });
    mockFetchSettingsByScope.mockResolvedValueOnce({
      global: { ...defaultSettings, merger: { mode: "legacy" } },
      project: {},
    });
    renderModal();
    await waitForSettingsModalReady();

    await userEvent.click(screen.getByRole("button", { name: /^Merge$/ }));
    await userEvent.selectOptions(screen.getByLabelText("AI merge"), "deterministic");
    expect(screen.getByLabelText("Direct merge commit routing")).toHaveValue("auto");

    await userEvent.selectOptions(screen.getByLabelText("Auto-completion mode"), "pull-request");
    expect(screen.queryByLabelText("Direct merge commit routing")).not.toBeInTheDocument();
  });

  it("defaults the integration worktree select to reuse-task-worktree when the server omits it", async () => {
    mockFetchProjects.mockResolvedValueOnce([{ id: "p-1", name: "Alpha" }]);
    mockFetchSettings.mockResolvedValueOnce({
      ...defaultSettings,
      merger: { mode: "legacy" },
      mergeIntegrationWorktree: undefined,
    });
    mockFetchSettingsByScope.mockResolvedValueOnce({
      global: { ...defaultSettings, merger: { mode: "legacy" } },
      project: {},
    });

    renderModal({ initialSection: "merge" });
    await waitForSettingsModalReady();

    await userEvent.selectOptions(screen.getByLabelText("AI merge"), "deterministic");
    expect(screen.getByLabelText("Integration worktree")).toHaveValue("reuse-task-worktree");
  });

  it("persists cwd-main through the save payload", async () => {
    mockFetchProjects.mockResolvedValueOnce([{ id: "p-1", name: "Alpha" }]);
    mockFetchSettings.mockResolvedValueOnce({ ...defaultSettings, merger: { mode: "legacy" } });
    mockFetchSettingsByScope.mockResolvedValueOnce({
      global: { ...defaultSettings, merger: { mode: "legacy" } },
      project: {},
    });
    renderModal({ initialSection: "merge" });
    await waitForSettingsModalReady();

    await userEvent.selectOptions(screen.getByLabelText("AI merge"), "deterministic");
    await userEvent.selectOptions(screen.getByLabelText("Integration worktree"), "cwd-main");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mockUpdateSettings).toHaveBeenCalledTimes(1);
    });

    const payload = mockUpdateSettings.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.mergeIntegrationWorktree).toBe("cwd-main");
  });

  it("does NOT render the warning banner when the integration worktree is reuse-task-worktree (default)", async () => {
    mockFetchProjects.mockResolvedValueOnce([{ id: "p-1", name: "Alpha" }]);
    mockFetchSettings.mockResolvedValueOnce({ ...defaultSettings, merger: { mode: "legacy" } });
    mockFetchSettingsByScope.mockResolvedValueOnce({
      global: { ...defaultSettings, merger: { mode: "legacy" } },
      project: {},
    });
    renderModal({ initialSection: "merge" });
    await waitForSettingsModalReady();

    expect(screen.queryByTestId("merge-integration-worktree-warning")).toBeNull();
  });

  it("renders the warning banner when the legacy cwd-main mode is selected", async () => {
    mockFetchProjects.mockResolvedValueOnce([{ id: "p-1", name: "Alpha" }]);
    mockFetchSettings.mockResolvedValueOnce({ ...defaultSettings, merger: { mode: "legacy" } });
    mockFetchSettingsByScope.mockResolvedValueOnce({
      global: { ...defaultSettings, merger: { mode: "legacy" } },
      project: {},
    });
    renderModal({ initialSection: "merge" });
    await waitForSettingsModalReady();

    await userEvent.selectOptions(screen.getByLabelText("AI merge"), "deterministic");
    await userEvent.selectOptions(screen.getByLabelText("Integration worktree"), "cwd-main");

    const warning = screen.getByTestId("merge-integration-worktree-warning");
    expect(warning).toBeInTheDocument();
    expect(warning).toHaveAttribute("role", "alert");
    expect(warning).toHaveTextContent("Legacy");
    expect(warning).toHaveTextContent("FN-5348");
  });

  it("removes the warning banner when switching back to reuse-task-worktree", async () => {
    mockFetchProjects.mockResolvedValueOnce([{ id: "p-1", name: "Alpha" }]);
    mockFetchSettings.mockResolvedValueOnce({
      ...defaultSettings,
      mergeIntegrationWorktree: "cwd-main",
      merger: { mode: "deterministic" },
    });
    mockFetchSettingsByScope.mockResolvedValueOnce({
      global: { ...defaultSettings, mergeIntegrationWorktree: "cwd-main", merger: { mode: "deterministic" } },
      project: {},
    });

    renderModal({ initialSection: "merge" });
    await waitForSettingsModalReady();

    await userEvent.selectOptions(screen.getByLabelText("AI merge"), "deterministic");
    expect(screen.getByTestId("merge-integration-worktree-warning")).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText("Integration worktree"), "reuse-task-worktree");

    expect(screen.queryByTestId("merge-integration-worktree-warning")).toBeNull();
  });

  it("persists the legacy sibling branch rename escape hatch in worktree settings", async () => {
    renderModal();
    await waitForSettingsModalReady();

    await userEvent.click(screen.getByRole("button", { name: /^Worktrees$/ }));

    const checkbox = screen.getByRole("checkbox", { name: "Allow silent sibling branch rename during executor conflicts" });
    expect(checkbox).not.toBeChecked();

    await userEvent.click(checkbox);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mockUpdateSettings).toHaveBeenCalledWith(
        expect.objectContaining({ executorAllowSiblingBranchRename: true }),
        undefined,
      );
    });
    expect(screen.getByText(/restores the legacy behavior/i)).toBeInTheDocument();
  });


  beforeEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    clearPluginUiSlotsCache();
    mockUseMobileKeyboard.mockReturnValue({
      keyboardOpen: false,
      keyboardOverlap: 0,
      viewportHeight: null,
      viewportOffsetTop: 0,
    });
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    mockFetchSettings.mockResolvedValue(defaultSettings);
    mockFetchSettingsByScope.mockResolvedValue({ global: defaultSettings, project: {} });
    mockFetchAuthStatus.mockResolvedValue({ providers: [] });
    mockConfirm.mockResolvedValue(true);
    mockFetchModels.mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] });
    mockFetchWorkflow.mockResolvedValue({
      id: "workflow-custom",
      name: "Workflow Custom",
      description: "",
      kind: "workflow",
      ir: { version: "v2", name: "Workflow Custom", columns: [], nodes: [], edges: [], settings: [] },
      layout: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    mockFetchWorkflowSettingValues.mockResolvedValue({ stored: {}, effective: {}, orphaned: [] });
    mockUpdateWorkflowSettingValues.mockResolvedValue({ stored: {}, effective: {}, orphaned: [] });
    mockFetchCustomProviders.mockResolvedValue({ providers: [] });
    mockCreateCustomProvider.mockResolvedValue({ provider: {} });
    mockUpdateCustomProvider.mockResolvedValue({ provider: {} });
    mockDeleteCustomProvider.mockResolvedValue(undefined);
    mockCancelProviderLogin.mockResolvedValue({ success: true, cancelled: true });
    mockSaveApiKey.mockResolvedValue(undefined);
    mockSubmitProviderManualCode.mockResolvedValue({ success: true, submitted: true });
    mockTestNotification.mockResolvedValue({ success: true });
    mockFetchBackups.mockResolvedValue({ backups: [], totalSize: 0 });
    mockFetchMemoryFiles.mockResolvedValue({
      files: [
        {
          path: ".fusion/memory/MEMORY.md",
          label: "Long-term memory",
          layer: "long-term",
          size: 42,
          updatedAt: "2026-04-17T12:00:00.000Z",
        },
        {
          path: ".fusion/memory/DREAMS.md",
          label: "Dreams",
          layer: "dreams",
          size: 21,
          updatedAt: "2026-04-17T12:00:00.000Z",
        },
      ],
    });
    mockFetchMemoryFile.mockImplementation((path: string) =>
      Promise.resolve({
        path,
        content: path.endsWith("DREAMS.md")
          ? "## Existing dreams\n- Pattern from daily notes"
          : "## Existing memory\n- Learned pattern",
      }),
    );
    mockSaveMemoryFile.mockResolvedValue({ success: true });
    mockCompactMemory.mockResolvedValue({
      path: ".fusion/memory/DREAMS.md",
      content: "# Compacted Memory\n\nImportant content.",
    });
    mockTestMemoryRetrieval.mockResolvedValue({
      query: "pattern",
      qmdAvailable: true,
      usedFallback: false,
      qmdInstallCommand: "bun install -g @tobilu/qmd",
      results: [],
    });
    mockInstallQmd.mockResolvedValue({
      success: true,
      qmdAvailable: true,
      qmdInstallCommand: "bun install -g @tobilu/qmd",
    });
    mockFetchGitRemotes.mockResolvedValue([]);
    mockFetchGitRemotesDetailed.mockResolvedValue([]);
    mockFetchProjects.mockResolvedValue([]);
    mockUseWorktrunkInstallStatus.mockReturnValue({
      status: "missing",
      requestInstall: vi.fn(),
      requesting: false,
      version: undefined,
      installPath: undefined,
      pendingApprovalId: undefined,
      error: undefined,
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/secrets")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ secrets: [] }),
        };
      }
      if (url.endsWith("/api/secrets/sync-passphrase")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ configured: false }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ stargazers_count: 0 }),
      };
    }));
    mockFetchDashboardHealth.mockResolvedValue({ status: "ok", version: "1.2.3", uptime: 123 });
    mockCheckForUpdates.mockResolvedValue(undefined);
    mockInstallUpdate.mockResolvedValue({ currentVersion: "1.2.3", latestVersion: "2.0.0", updated: true });
    mockFetchRemoteSettings.mockResolvedValue({
      settings: {
        remoteActiveProvider: null,
        remoteTailscaleEnabled: false,
        remoteTailscaleHostname: "",
        remoteTailscaleTargetPort: 4040,
        remoteTailscaleAcceptRoutes: false,
        remoteCloudflareEnabled: false,
        remoteCloudflareQuickTunnel: false,
        remoteCloudflareTunnelName: "",
        remoteCloudflareTunnelToken: null,
        remoteCloudflareIngressUrl: "",
        remotePersistentToken: null,
        remoteShortLivedEnabled: false,
        remoteShortLivedTtlMs: 900000,
        remoteShortLivedMaxTtlMs: 86400000,
        remoteRememberLastRunning: false,
        remoteWasRunningOnShutdown: false,
        remoteLastStartedProvider: null,
      },
    });
    mockUpdateRemoteSettings.mockResolvedValue({
      settings: {
        remoteActiveProvider: null,
        remoteTailscaleEnabled: false,
        remoteTailscaleHostname: "",
        remoteTailscaleTargetPort: 4040,
        remoteTailscaleAcceptRoutes: false,
        remoteCloudflareEnabled: false,
        remoteCloudflareQuickTunnel: false,
        remoteCloudflareTunnelName: "",
        remoteCloudflareTunnelToken: null,
        remoteCloudflareIngressUrl: "",
        remotePersistentToken: null,
        remoteShortLivedEnabled: false,
        remoteShortLivedTtlMs: 900000,
        remoteShortLivedMaxTtlMs: 86400000,
        remoteRememberLastRunning: false,
        remoteWasRunningOnShutdown: false,
        remoteLastStartedProvider: null,
      },
    });
    mockFetchRemoteStatus.mockResolvedValue({ provider: null, state: "stopped", url: null, lastError: null });
    mockInstallCloudflared.mockResolvedValue({ success: true, command: "brew install cloudflared" });
    mockStartRemoteTunnel.mockResolvedValue({ state: "starting", provider: "tailscale" });
    mockStopRemoteTunnel.mockResolvedValue({ state: "stopped", provider: null });
    mockKillExternalTunnel.mockResolvedValue({ ok: true });
    mockRegenerateRemotePersistentToken.mockResolvedValue({ token: "token", maskedToken: "****" });
    mockGenerateShortLivedRemoteToken.mockResolvedValue({ token: "short", expiresAt: new Date(Date.now() + 60000).toISOString(), ttlMs: 60000 });
    mockFetchRemoteQr.mockResolvedValue({ url: "https://remote.example.com", tokenType: "persistent", expiresAt: null, format: "image/svg", data: "<svg></svg>" });
    mockFetchRemoteUrl.mockResolvedValue({ url: "https://remote.example.com", tokenType: "persistent", expiresAt: null });
    mockTriggerMemoryDreams.mockResolvedValue({ success: true, summary: "done" });
    mockFetchPluginUiSlots.mockResolvedValue([]);
    mockFetchDroidCliStatus.mockResolvedValue({
      binary: { available: true, version: "1.2.3", binaryPath: "/usr/local/bin/droid", probeDurationMs: 9 },
      enabled: false,
      extension: { status: "ok" },
      ready: false,
    });
    mockSetDroidCliEnabled.mockResolvedValue({ enabled: true, restartRequired: true });
    mockFetchCursorCliStatus.mockResolvedValue({
      binary: { available: true, version: "0.1.0", binaryPath: "/usr/local/bin/cursor-agent", probeDurationMs: 8 },
      enabled: false,
      extension: null,
      ready: false,
    });
    mockSetCursorCliEnabled.mockResolvedValue({ enabled: true, restartRequired: false });
    mockUseWorkspaceFileBrowser.mockReturnValue({
      entries: [],
      currentPath: ".",
      setPath: vi.fn(),
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    mockImportSettings.mockResolvedValue({ success: true, globalCount: 0, projectCount: 0 });
    mockFetchGlobalConcurrency.mockResolvedValue({ globalMaxConcurrent: 4, currentlyActive: 0, queuedCount: 0, projectsActive: {} });
    mockUpdateGlobalConcurrency.mockResolvedValue({ globalMaxConcurrent: 4, currentlyActive: 0, queuedCount: 0, projectsActive: {} });
    mockFetchMemoryBackendStatus.mockResolvedValue({
      currentBackend: "file",
      capabilities: {
        readable: true,
        writable: true,
        supportsAtomicWrite: true,
        hasConflictResolution: false,
        persistent: true,
      },
      availableBackends: ["file", "readonly", "qmd"],
      qmdAvailable: true,
      qmdInstallCommand: "bun install -g @tobilu/qmd",
    });
    mockUseMemoryBackendStatus.mockReturnValue({
      status: {
        currentBackend: "qmd",
        capabilities: {
          readable: true,
          writable: true,
          supportsAtomicWrite: false,
          hasConflictResolution: false,
          persistent: true,
        },
        availableBackends: ["file", "readonly", "qmd"],
        qmdAvailable: true,
        qmdInstallCommand: "bun install -g @tobilu/qmd",
      },
      currentBackend: "file",
      capabilities: {
        readable: true,
        writable: true,
        supportsAtomicWrite: true,
        hasConflictResolution: false,
        persistent: true,
      },
      availableBackends: ["file", "readonly", "qmd"],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    // jsdom doesn't provide URL.createObjectURL — polyfill it
    if (!URL.createObjectURL) {
      URL.createObjectURL = vi.fn(() => "blob:http://localhost/mock") as any;
    }
    if (!URL.revokeObjectURL) {
      URL.revokeObjectURL = vi.fn() as any;
    }
  });

  afterEach(() => {
    cleanup();
    clearPluginUiSlotsCache();
    localStorage.clear();
    sessionStorage.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("deferred settings fetches", () => {
    it("does not fetch global concurrency until Scheduling is selected", async () => {
      renderModal();
      await waitForSettingsModalReady();

      expect(mockFetchGlobalConcurrency).not.toHaveBeenCalled();

      await userEvent.click(screen.getByRole("button", { name: /Scheduling/ }));

      await waitFor(() => {
        expect(mockFetchGlobalConcurrency).toHaveBeenCalledTimes(1);
      });
    });

    it("enables memory backend status hook only when Memory section is active", async () => {
      renderModal();
      await waitForSettingsModalReady();

      expect(mockUseMemoryBackendStatus).toHaveBeenCalled();
      const initialCallHasDisabled = mockUseMemoryBackendStatus.mock.calls.some(
        (call) => call[0]?.enabled === false,
      );
      expect(initialCallHasDisabled).toBe(true);

      await userEvent.click(screen.getByRole("button", { name: /Memory/ }));

      await waitFor(() => {
        const enabledCallSeen = mockUseMemoryBackendStatus.mock.calls.some(
          (call) => call[0]?.enabled === true,
        );
        expect(enabledCallSeen).toBe(true);
      });
    });
  });

  describe("Global General", () => {
    // Read-only default-render assertions are merged into one rendered
    // instance to avoid re-rendering the full modal per pure-display check.
    it("renders default global logging fields, helper text, and tracking repo control", async () => {
      renderModal({ initialSection: "global-general" });
      await waitForSettingsModalReady();

      // persistAgentToolOutput defaults to checked; Star-on-GitHub control absent.
      expect(screen.getByRole("checkbox", { name: "Save tool output in agent logs" })).toBeChecked();
      expect(screen.queryByRole("checkbox", { name: /Show "Star on GitHub" button in Settings header/i })).toBeNull();

      // thinking-log checkboxes default to unchecked.
      expect(screen.getByRole("checkbox", { name: "Save AI thinking for permanent agents" })).not.toBeChecked();
      expect(screen.getByRole("checkbox", { name: "Save AI thinking for ephemeral / task-worker agents" })).not.toBeChecked();

      // Helper descriptions render as small text (not .settings-field-help).
      expect(document.querySelector(".settings-field-help")).toBeNull();
      const toolOutputHelper = screen.getByText(/When disabled, tool rows are still logged but detailed tool payloads are omitted/i);
      expect(toolOutputHelper.closest("small")).toBeTruthy();
      const thinkingHelper = screen.getByText(/Leave both thinking toggles off to keep the original default behavior/i);
      expect(thinkingHelper.closest("small")).toBeTruthy();

      // Global default tracking repo control + inheritance hint render.
      expect(screen.getByRole("combobox", { name: "Global default tracking repo" })).toBeInTheDocument();
      expect(screen.getByText(/Projects inherit this value when they do not set a project default tracking repo/i)).toBeInTheDocument();
    });

    it("reflects persisted unchecked value from global settings", async () => {
      mockFetchSettings.mockResolvedValue({
        ...defaultSettings,
        persistAgentToolOutput: false,
      });
      mockFetchSettingsByScope.mockResolvedValue({
        global: { ...defaultSettings, persistAgentToolOutput: false },
        project: {},
      });

      renderModal({ initialSection: "global-general" });
      await waitForSettingsModalReady();

      expect(screen.getByRole("checkbox", { name: "Save tool output in agent logs" })).not.toBeChecked();
    });

    it("falls back to legacy thinking-log flag when granular fields are unset", async () => {
      mockFetchSettings.mockResolvedValue({
        ...defaultSettings,
        persistAgentThinkingLog: true,
      });
      mockFetchSettingsByScope.mockResolvedValue({
        global: { ...defaultSettings, persistAgentThinkingLog: true },
        project: {},
      });

      renderModal({ initialSection: "global-general" });
      await waitForSettingsModalReady();

      expect(screen.getByRole("checkbox", { name: "Save AI thinking for permanent agents" })).toBeChecked();
      expect(screen.getByRole("checkbox", { name: "Save AI thinking for ephemeral / task-worker agents" })).toBeChecked();
    });

    it("saves persistAgentToolOutput only via global settings payload", async () => {
      renderModal({ initialSection: "global-general" });
      await waitForSettingsModalReady();

      await userEvent.click(screen.getByRole("checkbox", { name: "Save tool output in agent logs" }));
      await userEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(mockUpdateGlobalSettings).toHaveBeenCalled();
      });

      const globalPayload = mockUpdateGlobalSettings.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(globalPayload.persistAgentToolOutput).toBe(false);
      if (mockUpdateSettings.mock.calls.length > 0) {
        const projectPayload = mockUpdateSettings.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(projectPayload.persistAgentToolOutput).toBeUndefined();
      }
    });

    it("saves granular thinking-log flags only via global settings payload", async () => {
      renderModal({ initialSection: "global-general" });
      await waitForSettingsModalReady();

      await userEvent.click(screen.getByRole("checkbox", { name: "Save AI thinking for permanent agents" }));
      await userEvent.click(screen.getByRole("checkbox", { name: "Save AI thinking for ephemeral / task-worker agents" }));
      await userEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(mockUpdateGlobalSettings).toHaveBeenCalled();
      });

      const globalPayload = mockUpdateGlobalSettings.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(globalPayload.persistAgentThinkingLogPermanent).toBe(true);
      expect(globalPayload.persistAgentThinkingLogEphemeral).toBe(true);
      expect(globalPayload.persistAgentThinkingLog).toBeUndefined();
      if (mockUpdateSettings.mock.calls.length > 0) {
        const projectPayload = mockUpdateSettings.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(projectPayload.persistAgentThinkingLogPermanent).toBeUndefined();
        expect(projectPayload.persistAgentThinkingLogEphemeral).toBeUndefined();
        expect(projectPayload.persistAgentThinkingLog).toBeUndefined();
      }
    });

    it("saves global default tracking repo via global settings payload only", async () => {
      mockFetchProjects.mockResolvedValueOnce([{ id: "p-1", name: "Alpha" }]);
      mockFetchGitRemotes.mockResolvedValueOnce([{ name: "origin", owner: "octo", repo: "global-default", url: "https://github.com/octo/global-default.git" }]);

      renderModal({ initialSection: "global-general" });
      await waitForSettingsModalReady();

      await waitFor(() => {
        expect(screen.getByRole("combobox", { name: "Global default tracking repo" })).toHaveValue("__custom__");
      });

      await userEvent.selectOptions(screen.getByRole("combobox", { name: "Global default tracking repo" }), "octo/global-default");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(mockUpdateGlobalSettings).toHaveBeenCalled();
      });

      const globalPayload = mockUpdateGlobalSettings.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(globalPayload.githubTrackingDefaultRepo).toBe("octo/global-default");

      if (mockUpdateSettings.mock.calls.length > 0) {
        const projectPayload = mockUpdateSettings.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(projectPayload.githubTrackingDefaultRepo).toBeUndefined();
      }
    });

    it("shows global tracking repo error hint and keeps custom entry when lookups fail", async () => {
      mockFetchProjects.mockRejectedValueOnce(new Error("no projects"));

      renderModal({ initialSection: "global-general" });
      await waitForSettingsModalReady();

      expect(await screen.findByText(/Could not load project list/i)).toBeInTheDocument();
      const control = screen.getByRole("combobox", { name: "Global default tracking repo" });
      expect(screen.getByRole("option", { name: "Custom…" })).toBeInTheDocument();

      await userEvent.selectOptions(control, "__custom__");
      expect(screen.getByPlaceholderText("owner/repo")).toBeInTheDocument();
    });
  });

  it("renders and saves agent provisioning approval settings", async () => {
    renderModal({ initialSection: "agent-permissions" });
    await waitForSettingsModalReady();

    expect(screen.getByRole("heading", { name: "Agent Provisioning Approvals" })).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText("Approval mode"), "always");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mockUpdateSettings).toHaveBeenCalled();
    });

    const payload = mockUpdateSettings.mock.calls[0]?.[0] as {
      agentProvisioning?: { approvalMode?: string };
    };
    expect(payload.agentProvisioning?.approvalMode).toBe("always");
  });

  describe("Project General", () => {
    it("renders completion documentation automation control", async () => {
      renderModal({ initialSection: "general" });
      await waitForSettingsModalReady();

      const select = screen.getByLabelText("Completion Documentation Automation") as HTMLSelectElement;
      expect(select).toBeInTheDocument();
      expect(select.value).toBe("off");
      expect(screen.getByRole("option", { name: "Require changeset (.changeset/*.md)" })).toBeInTheDocument();
      expect(screen.getByRole("option", { name: "Require changelog update (existing changelog)" })).toBeInTheDocument();
    });

    it.each<PersistSettingInput>([
      {
        section: "Project General",
        label: "Completion Documentation Automation",
        kind: "select",
        value: "changeset",
        scope: "project",
        expectedKey: "completionDocumentationMode",
      },
      {
        section: "Project General",
        label: "Auto-cleanup old chats",
        kind: "select",
        value: 14,
        scope: "project",
        expectedKey: "chatAutoCleanupDays",
      },
      {
        section: "Project General",
        label: "Operational log retention",
        kind: "select",
        value: 7,
        scope: "project",
        expectedKey: "operationalLogRetentionDays",
      },
    ])("persists $expectedKey through the expected settings scope", async (input) => {
      await expectSettingPersists(input);
    });

    it("saves ephemeral agent toggle in project settings payload", async () => {
      renderModal({ initialSection: "general" });
      await waitForSettingsModalReady();

      const ephemeralToggle = screen.getByLabelText("Use ephemeral task-worker agents") as HTMLInputElement;
      expect(ephemeralToggle.checked).toBe(true);

      await userEvent.click(ephemeralToggle);
      await userEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalled();
      });

      const payload = mockUpdateSettings.mock.calls[0][0] as Record<string, unknown>;
      expect(payload.ephemeralAgentsEnabled).toBe(false);
    });

    it("exposes the ephemeral agents toggle via the desktop Project General sidebar nav item", async () => {
      renderModal();
      await waitForSettingsModalReady();

      await userEvent.click(screen.getByRole("button", { name: "Project General" }));

      const ephemeralToggle = screen.getByLabelText("Use ephemeral task-worker agents") as HTMLInputElement;
      expect(ephemeralToggle).toBeInTheDocument();
      expect(ephemeralToggle.checked).toBe(true);
    });

    it("exposes the ephemeral agents toggle via the mobile Settings Section picker", async () => {
      Object.defineProperty(window, "matchMedia", {
        writable: true,
        value: vi.fn().mockImplementation((query: string) => ({
          matches: query === "(max-width: 768px)" || query === "(max-width: 768px), (max-height: 480px)",
          media: query,
          onchange: null,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          addListener: vi.fn(),
          removeListener: vi.fn(),
          dispatchEvent: vi.fn(),
        })),
      });

      renderModal();
      await waitForSettingsModalReady();

      const sectionPicker = screen.getByLabelText("Settings Section") as HTMLSelectElement;
      expect(sectionPicker).toBeInTheDocument();
      const projectGeneralOption = sectionPicker.querySelector('option[value="general"]');
      expect(projectGeneralOption).toBeInTheDocument();
      expect(projectGeneralOption).toHaveTextContent("Project General");

      await userEvent.selectOptions(sectionPicker, "general");

      const ephemeralToggle = screen.getByLabelText("Use ephemeral task-worker agents") as HTMLInputElement;
      expect(ephemeralToggle).toBeInTheDocument();
      expect(ephemeralToggle.checked).toBe(true);

      Object.defineProperty(window, "matchMedia", {
        writable: true,
        value: vi.fn().mockImplementation((query: string) => ({
          matches: false,
          media: query,
          onchange: null,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          addListener: vi.fn(),
          removeListener: vi.fn(),
          dispatchEvent: vi.fn(),
        })),
      });
    });

    it("keeps ephemeral agent toggle checked when upgrading settings omit the key", async () => {
      const { ephemeralAgentsEnabled: _omitted, ...upgradeSettings } = defaultSettings;
      mockFetchSettings.mockResolvedValueOnce(upgradeSettings);
      mockFetchSettingsByScope.mockResolvedValueOnce({ global: defaultSettings, project: {} });

      renderModal({ initialSection: "general" });
      await waitForSettingsModalReady();

      const ephemeralToggle = screen.getByLabelText("Use ephemeral task-worker agents") as HTMLInputElement;
      expect(ephemeralToggle.checked).toBe(true);
    });

    it("renders chat auto-cleanup retention with the default off value", async () => {
      renderModal({ initialSection: "general" });
      await waitForSettingsModalReady();

      const cleanupSelect = screen.getByLabelText("Auto-cleanup old chats") as HTMLSelectElement;
      expect(cleanupSelect.value).toBe("0");
    });

    it("renders and saves mail auto-prune retention", async () => {
      renderModal({ initialSection: "general" });
      await waitForSettingsModalReady();

      const mailCleanupSelect = screen.getByLabelText("Auto-prune old mail") as HTMLSelectElement;
      expect(mailCleanupSelect.value).toBe("0");

      await userEvent.selectOptions(mailCleanupSelect, "7");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalled();
      });

      const payload = mockUpdateSettings.mock.calls[0][0] as Record<string, unknown>;
      expect(payload.mailAutoCleanupDays).toBe(7);

      mockUpdateSettings.mockClear();

      await userEvent.selectOptions(mailCleanupSelect, "0");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalled();
      });

      const offPayload = mockUpdateSettings.mock.calls[0][0] as Record<string, unknown>;
      expect(offPayload.mailAutoCleanupDays).toBe(0);
    });

    it("renders and saves chat room compaction controls", async () => {
      renderModal({ initialSection: "general" });
      await waitForSettingsModalReady();

      expect(screen.getByRole("heading", { name: "Chat Rooms" })).toBeInTheDocument();

      const recentInput = screen.getByLabelText("Recent verbatim room messages") as HTMLInputElement;
      const fetchLimitInput = screen.getByLabelText("Room compaction fetch limit") as HTMLInputElement;
      const summaryMaxInput = screen.getByLabelText("Room summary max characters") as HTMLInputElement;

      expect(recentInput.placeholder).toBe("25");
      expect(fetchLimitInput.placeholder).toBe("200");
      expect(summaryMaxInput.placeholder).toBe("3000");

      await userEvent.type(recentInput, "7");
      await userEvent.type(fetchLimitInput, "60");
      await userEvent.type(summaryMaxInput, "900");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalled();
      });

      const payload = mockUpdateSettings.mock.calls[0][0] as Record<string, unknown>;
      expect(payload.chatRoomRecentVerbatimMessages).toBe(7);
      expect(payload.chatRoomCompactionFetchLimit).toBe(60);
      expect(payload.chatRoomSummaryMaxChars).toBe(900);
    });

    it("renders and saves GitHub tracking controls in the General section", async () => {
      renderModal({ initialSection: "general" });
      await waitForSettingsModalReady();

      expect(screen.getByRole("heading", { name: "GitHub Tracking" })).toBeInTheDocument();

      const modeSelect = screen.getByLabelText("Default tracking mode for new tasks") as HTMLSelectElement;
      const repoSelect = screen.getByRole("combobox", { name: "Project default tracking repo" }) as HTMLSelectElement;
      expect(modeSelect.value).toBe("off");
      expect(repoSelect.value).toBe("__custom__");

      await userEvent.selectOptions(modeSelect, "new-tasks");
      await userEvent.type(screen.getByPlaceholderText("owner/repo"), "octo/repo");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalled();
      });

      const payload = mockUpdateSettings.mock.calls[0][0] as Record<string, unknown>;
      expect(payload.githubTrackingEnabledByDefault).toBe(true);
      expect(payload.githubTrackingDefaultRepo).toBe("octo/repo");

      if (mockUpdateGlobalSettings.mock.calls.length > 0) {
        const globalPayload = mockUpdateGlobalSettings.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(globalPayload.githubTrackingDefaultRepo).toBeUndefined();
      }
    });

    it("saves GitHub tracking defaults as disabled and clears the repo when emptied", async () => {
      mockFetchSettings.mockResolvedValueOnce({
        ...defaultSettings,
        githubTrackingEnabledByDefault: true,
        githubTrackingDefaultRepo: "octo/existing",
      });

      renderModal({ initialSection: "general" });
      await waitForSettingsModalReady();

      const modeSelect = screen.getByLabelText("Default tracking mode for new tasks") as HTMLSelectElement;
      const repoSelect = screen.getByRole("combobox", { name: "Project default tracking repo" }) as HTMLSelectElement;

      expect(modeSelect.value).toBe("new-tasks");
      expect(repoSelect.value).toBe("__custom__");

      await userEvent.selectOptions(modeSelect, "off");
      await userEvent.clear(screen.getByPlaceholderText("owner/repo"));
      await userEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalled();
      });

      const payload = mockUpdateSettings.mock.calls[0][0] as Record<string, unknown>;
      expect(payload.githubTrackingEnabledByDefault).toBe(false);
      expect(payload.githubTrackingDefaultRepo).toBeUndefined();
    });

    it("renders github dedup toggle as checked when project value is unset", async () => {
      renderModal({ initialSection: "general" });
      await waitForSettingsModalReady();

      const dedupToggle = screen.getByLabelText(
        "Search the tracking repo for likely duplicates before opening a new issue",
      ) as HTMLInputElement;
      expect(dedupToggle.checked).toBe(true);
    });

    it("renders github dedup toggle as unchecked when explicitly disabled", async () => {
      mockFetchSettings.mockResolvedValueOnce({
        ...defaultSettings,
        githubTrackingDedupEnabled: false,
      });

      renderModal({ initialSection: "general" });
      await waitForSettingsModalReady();

      const dedupToggle = screen.getByLabelText(
        "Search the tracking repo for likely duplicates before opening a new issue",
      ) as HTMLInputElement;
      expect(dedupToggle.checked).toBe(false);
    });

    it("saves github dedup toggle changes", async () => {
      renderModal({ initialSection: "general" });
      await waitForSettingsModalReady();

      const dedupToggle = screen.getByLabelText(
        "Search the tracking repo for likely duplicates before opening a new issue",
      ) as HTMLInputElement;

      await userEvent.click(dedupToggle);
      await userEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalled();
      });

      const firstPayload = mockUpdateSettings.mock.calls[0][0] as Record<string, unknown>;
      expect(firstPayload.githubTrackingDedupEnabled).toBe(false);

      mockUpdateSettings.mockClear();

      await userEvent.click(dedupToggle);
      await userEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalled();
      });

      const secondPayload = mockUpdateSettings.mock.calls[0][0] as Record<string, unknown>;
      expect(secondPayload.githubTrackingDedupEnabled).toBe(true);
    });

    it("hides summarization model picker when summarization and default tracking are disabled", async () => {
      renderModal({ initialSection: "models" });
      await waitForSettingsModalReady();

      await userEvent.click(screen.getByRole("button", { name: "Project Models" }));

      expect(screen.queryByText("Title, commit message, and GitHub tracking issue summarization model")).not.toBeInTheDocument();
    });

    it("does not show a moved-to-workflow note for the summarizer model when GitHub tracking defaults are on", async () => {
      mockFetchSettings.mockResolvedValueOnce({
        ...defaultSettings,
        githubTrackingEnabledByDefault: true,
      });

      renderModal({ initialSection: "models" });
      await waitForSettingsModalReady();

      await userEvent.click(screen.getByRole("button", { name: "Project Models" }));

      expect(screen.queryByText(/model used for summarization now lives on the workflow/i)).not.toBeInTheDocument();
      expect(screen.getByText(/per-phase model lanes \(execution, planning, reviewer, and their fallbacks\) now live on the workflow/i)).toBeInTheDocument();
    });

    it("picks a project repo suggestion and preserves label association", async () => {
      mockFetchGitRemotes.mockResolvedValueOnce([
        { name: "origin", owner: "octo", repo: "repo", url: "https://github.com/octo/repo.git" },
      ]);

      renderModal({ initialSection: "general" });
      await waitForSettingsModalReady();

      const repoSelect = screen.getByRole("combobox", { name: "Project default tracking repo" }) as HTMLSelectElement;
      expect(await within(repoSelect).findByRole("option", { name: "octo/repo" })).toBeInTheDocument();

      await userEvent.selectOptions(repoSelect, "octo/repo");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalled();
      });

      const payload = mockUpdateSettings.mock.calls[0][0] as Record<string, unknown>;
      expect(payload.githubTrackingDefaultRepo).toBe("octo/repo");
    });

    it("shows project tracking repo error hint and keeps custom entry when remotes fail", async () => {
      mockFetchGitRemotes.mockRejectedValueOnce(new Error("remotes failed"));

      renderModal({ initialSection: "general" });
      await waitForSettingsModalReady();

      expect(await screen.findByText(/Could not load detected remotes/i)).toBeInTheDocument();
      const control = screen.getByRole("combobox", { name: "Project default tracking repo" });
      await userEvent.selectOptions(control, "__custom__");
      expect(screen.getByPlaceholderText("owner/repo")).toBeInTheDocument();
    });

    it("always shows GitHub tracking summarization helper copy", async () => {
      renderModal({ initialSection: "general" });
      await waitForSettingsModalReady();

      expect(
        screen.getByText(/Tracking issues use this task's title\. If a task has no title yet, Fusion can summarize its description using the title summarization model in Project Models\./),
      ).toBeInTheDocument();
    });
  });

  describe("Appearance", () => {
    it("renders dashboard font size options with saved value", async () => {
      const onDashboardFontScaleChange = vi.fn();
      renderModal({ dashboardFontScalePct: 110, onDashboardFontScaleChange });
      await waitForSettingsModalReady();

      await userEvent.click(screen.getByRole("button", { name: /Appearance/ }));

      const largeButton = screen.getByRole("button", { name: "Large" });
      expect(largeButton).toHaveAttribute("aria-pressed", "true");

      await userEvent.click(screen.getByRole("button", { name: "Small" }));
      expect(onDashboardFontScaleChange).toHaveBeenCalledWith(90);
    });

    it("saves dashboard font scale to global settings", async () => {
      renderModal({ dashboardFontScalePct: 100 });
      await waitForSettingsModalReady();

      await userEvent.click(screen.getByRole("button", { name: /Appearance/ }));
      await userEvent.click(screen.getByRole("button", { name: "Largest" }));
      await userEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(mockUpdateGlobalSettings).toHaveBeenCalled();
      });

      const payload = mockUpdateGlobalSettings.mock.calls[0][0];
      expect(payload).toEqual(expect.objectContaining({ dashboardFontScalePct: 120 }));
    });
  });

  describe("Project Models", () => {
    it("saves opencode-go startup model sync toggle in global settings", async () => {
      mockFetchModels.mockResolvedValue({
        models: MODEL_FIXTURE,
        favoriteProviders: [],
        favoriteModels: [],
      });

      await expectSettingPersists({
        section: "models",
        label: "Sync opencode-go model list at startup",
        kind: "checkbox",
        value: false,
        scope: "global",
        expectedKey: "opencodeGoModelSync",
      });
    });

    it("renders and saves OpenRouter advanced settings", async () => {
      mockFetchModels.mockResolvedValue({
        models: MODEL_FIXTURE,
        favoriteProviders: [],
        favoriteModels: [],
      });

      renderModal();
      await waitForSettingsModalReady();

      await userEvent.click(screen.getByRole("button", { name: "Models" }));
      await userEvent.click(screen.getByText("OpenRouter advanced"));

      expect(screen.getByLabelText("OpenRouter HTTP-Referer")).toBeInTheDocument();
      expect(screen.getByLabelText("OpenRouter X-Title")).toBeInTheDocument();

      await userEvent.type(screen.getByLabelText("OpenRouter HTTP-Referer"), "https://example.app");
      await userEvent.type(screen.getByLabelText("OpenRouter X-Title"), "Example App");
      fireEvent.change(screen.getByLabelText("OpenRouter supported_parameters filter"), {
        target: { value: "tools, structured_outputs" },
      });
      fireEvent.change(screen.getByLabelText("OpenRouter output_modalities filter"), { target: { value: "text" } });
      fireEvent.change(screen.getByLabelText("OpenRouter routing order"), { target: { value: "openai, anthropic" } });
      fireEvent.change(screen.getByLabelText("OpenRouter routing ignore"), { target: { value: "provider-x" } });
      fireEvent.change(screen.getByLabelText("OpenRouter routing only"), { target: { value: "provider-y" } });
      await userEvent.selectOptions(screen.getByLabelText("OpenRouter allow fallbacks"), "deny");
      await userEvent.selectOptions(screen.getByLabelText("OpenRouter routing sort"), "latency");
      await userEvent.click(screen.getByLabelText("Require parameters"));

      await userEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(mockUpdateGlobalSettings).toHaveBeenCalled();
      });

      expect(mockUpdateGlobalSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          openrouterAppAttribution: { referer: "https://example.app", title: "Example App" },
          openrouterModelFilters: {
            supported_parameters: ["tools", "structured_outputs"],
            output_modalities: ["text"],
          },
          openrouterProviderPreferences: {
            order: ["openai", "anthropic"],
            ignore: ["provider-x"],
            only: ["provider-y"],
            allow_fallbacks: false,
            sort: "latency",
            require_parameters: true,
          },
        }),
      );
    });

    it("renders a project-scoped default model lane", async () => {
      mockFetchSettings.mockResolvedValue({
        ...defaultSettings,
        defaultProvider: "anthropic",
        defaultModelId: "claude-sonnet-4-5",
      });
      mockFetchSettingsByScope.mockResolvedValue({
        global: {
          ...defaultSettings,
          defaultProvider: "anthropic",
          defaultModelId: "claude-sonnet-4-5",
        },
        project: {},
      });
      mockFetchModels.mockResolvedValue({
        models: MODEL_FIXTURE,
        favoriteProviders: [],
        favoriteModels: [],
      });

      renderModal();
      await waitForSettingsModalReady();

      await userEvent.click(screen.getByRole("button", { name: "Project Models" }));

      expect(screen.getByText(/The Project Default Model is the fallback for this project/i)).toBeInTheDocument();

      const defaultSection = screen.getByLabelText("Project Default Model").closest(".form-group");
      expect(defaultSection).toBeTruthy();
      expect(within(defaultSection as HTMLElement).getByText("Inherited (Global)")).toBeInTheDocument();
    });

    it("saves the project default model override under project scope keys", async () => {
      mockFetchSettings.mockResolvedValue({
        ...defaultSettings,
        defaultProvider: "anthropic",
        defaultModelId: "claude-sonnet-4-5",
      });
      mockFetchSettingsByScope.mockResolvedValue({
        global: {
          ...defaultSettings,
          defaultProvider: "anthropic",
          defaultModelId: "claude-sonnet-4-5",
        },
        project: {},
      });
      mockFetchModels.mockResolvedValue({
        models: MODEL_FIXTURE,
        favoriteProviders: [],
        favoriteModels: [],
      });

      renderModal();
      await waitForSettingsModalReady();

      await userEvent.click(screen.getByRole("button", { name: "Project Models" }));
      await userEvent.click(screen.getByLabelText("Project Default Model"));
      await userEvent.click(screen.getByText("GPT-4o"));
      await userEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalledTimes(1);
      });

      expect(mockUpdateSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultProviderOverride: "openai",
          defaultModelIdOverride: "gpt-4o",
        }),
        undefined,
      );

      if (mockUpdateGlobalSettings.mock.calls.length > 0) {
        const [globalPayload] = mockUpdateGlobalSettings.mock.calls[0] as [Record<string, unknown>];
        expect(globalPayload).not.toHaveProperty("defaultProviderOverride");
        expect(globalPayload).not.toHaveProperty("defaultModelIdOverride");
      }
    });

    const declaredWorkflowModelSettings = (ids: string[]) => ids.map((id) => ({ id, name: id, type: "string" as const }));
    const primaryWorkflowModelSettingIds = [
      "planningProvider",
      "planningModelId",
      "executionProvider",
      "executionModelId",
      "validatorProvider",
      "validatorModelId",
    ];
    const fallbackWorkflowModelSettingIds = [
      "planningFallbackProvider",
      "planningFallbackModelId",
      "validatorFallbackProvider",
      "validatorFallbackModelId",
      "titleSummarizerFallbackProvider",
      "titleSummarizerFallbackModelId",
    ];

    async function setupWorkflowModelLaneTest({
      stored = {},
      effective = {},
      renderProps = {},
      settingIds = [...primaryWorkflowModelSettingIds, ...fallbackWorkflowModelSettingIds],
      models = MODEL_FIXTURE,
    }: {
      stored?: Record<string, unknown>;
      effective?: Record<string, unknown>;
      renderProps?: Partial<ComponentProps<typeof SettingsModal>>;
      settingIds?: string[];
      models?: typeof MODEL_FIXTURE;
    } = {}) {
      mockFetchSettings.mockResolvedValue({
        ...defaultSettings,
        defaultWorkflowId: "workflow-custom",
      });
      mockFetchSettingsByScope.mockResolvedValue({
        global: defaultSettings,
        project: { defaultWorkflowId: "workflow-custom" },
      });
      mockFetchModels.mockResolvedValue({
        models,
        favoriteProviders: [],
        favoriteModels: [],
      });
      mockFetchWorkflow.mockResolvedValue({
        id: "workflow-custom",
        name: "Workflow Custom",
        description: "",
        kind: "workflow",
        ir: {
          version: "v2",
          name: "Workflow Custom",
          columns: [],
          nodes: [],
          edges: [],
          settings: declaredWorkflowModelSettings(settingIds),
        },
        layout: {},
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      mockFetchWorkflowSettingValues.mockResolvedValue({
        stored,
        effective,
        orphaned: [],
      });

      renderModal({ initialSection: "project-models", projectId: "proj-1", ...renderProps });
      await waitForSettingsModalReady();

      await waitFor(() => {
        expect(mockFetchWorkflow).toHaveBeenCalledWith("workflow-custom", "proj-1");
        expect(mockFetchWorkflowSettingValues).toHaveBeenCalledWith("workflow-custom", "proj-1");
      });
    }

    it("renders only advanced workflow actions inside the default workflow lane section", async () => {
      const onOpenWorkflowSettings = vi.fn();
      await setupWorkflowModelLaneTest({ renderProps: { onOpenWorkflowSettings } });

      const workflowHeading = screen.getByRole("heading", { name: "Default workflow model lanes" });
      const advancedButton = screen.getByRole("button", { name: "Advanced workflow policy" });
      const actionRow = advancedButton.closest(".settings-model-lane-actions");
      const presetsHeading = screen.getByRole("heading", { name: "Model Presets" });

      expect(screen.queryByTestId("save-workflow-model-lanes")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Save workflow models" })).not.toBeInTheDocument();
      expect(actionRow).toBeInTheDocument();
      expect(actionRow).toHaveAttribute("aria-label", "Default workflow model lane actions");
      expect(within(actionRow as HTMLElement).getByRole("button", { name: "Advanced workflow policy" })).toBeInTheDocument();
      expect(workflowHeading.compareDocumentPosition(actionRow as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect((actionRow as HTMLElement).compareDocumentPosition(presetsHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it.each([
      ["Plan/Triage Model", { planningProvider: "openai", planningModelId: "gpt-4o" }],
      ["Executor Model", { executionProvider: "openai", executionModelId: "gpt-4o" }],
      ["Reviewer Model", { validatorProvider: "openai", validatorModelId: "gpt-4o" }],
    ])("persists %s edits through the primary Settings Save", async (laneLabel, expectedPatch) => {
      mockUpdateWorkflowSettingValues.mockResolvedValue({
        stored: expectedPatch,
        effective: expectedPatch,
        orphaned: [],
      });
      const onClose = vi.fn();
      await setupWorkflowModelLaneTest({ renderProps: { onClose } });

      await userEvent.click(screen.getByLabelText(laneLabel));
      await userEvent.click(await screen.findByText("GPT-4o"));
      await userEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(mockUpdateWorkflowSettingValues).toHaveBeenCalledWith(
          "workflow-custom",
          expectedPatch,
          "proj-1",
        );
      });
      expect(onClose).toHaveBeenCalled();
    });

    it("renders fallback workflow model lanes only when the default workflow declares them", async () => {
      await setupWorkflowModelLaneTest();

      expect(screen.getByTestId("workflow-model-lane-planning-fallback")).toBeInTheDocument();
      expect(screen.getByTestId("workflow-model-lane-validator-fallback")).toBeInTheDocument();
      expect(screen.getByTestId("workflow-model-lane-title-summarizer-fallback")).toBeInTheDocument();

      cleanup();
      mockFetchWorkflow.mockClear();
      mockFetchWorkflowSettingValues.mockClear();
      mockUpdateWorkflowSettingValues.mockClear();
      await setupWorkflowModelLaneTest({ settingIds: primaryWorkflowModelSettingIds });

      expect(screen.queryByTestId("workflow-model-lane-planning-fallback")).not.toBeInTheDocument();
      expect(screen.queryByTestId("workflow-model-lane-validator-fallback")).not.toBeInTheDocument();
      expect(screen.queryByTestId("workflow-model-lane-title-summarizer-fallback")).not.toBeInTheDocument();
      expect(screen.queryByText("Planning Fallback Model")).not.toBeInTheDocument();
      expect(screen.queryByText("Reviewer Fallback Model")).not.toBeInTheDocument();
      expect(screen.queryByText("Title Summarizer Fallback Model")).not.toBeInTheDocument();
    });

    it("persists fallback workflow model lane edits through the primary Settings Save", async () => {
      const expectedPatch = { planningFallbackProvider: "openai", planningFallbackModelId: "gpt-4o" };
      mockUpdateWorkflowSettingValues.mockResolvedValue({
        stored: expectedPatch,
        effective: expectedPatch,
        orphaned: [],
      });
      const onClose = vi.fn();
      await setupWorkflowModelLaneTest({ renderProps: { onClose } });

      await userEvent.click(screen.getByLabelText("Planning Fallback Model"));
      await userEvent.click(await screen.findByText("GPT-4o"));
      await userEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(mockUpdateWorkflowSettingValues).toHaveBeenCalledWith(
          "workflow-custom",
          expectedPatch,
          "proj-1",
        );
      });
      expect(onClose).toHaveBeenCalled();
    });

    it("resets fallback workflow model lanes by sending null patches from the primary Settings Save", async () => {
      await setupWorkflowModelLaneTest({
        stored: { validatorFallbackProvider: "anthropic", validatorFallbackModelId: "claude-sonnet-4-5" },
        effective: { validatorFallbackProvider: "anthropic", validatorFallbackModelId: "claude-sonnet-4-5" },
      });

      const lane = screen.getByTestId("workflow-model-lane-validator-fallback");
      expect(within(lane).getByText("Override (Project)")).toBeInTheDocument();
      await userEvent.click(within(lane).getByRole("button", { name: "Reset" }));
      await userEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(mockUpdateWorkflowSettingValues).toHaveBeenCalledWith(
          "workflow-custom",
          { validatorFallbackProvider: null, validatorFallbackModelId: null },
          "proj-1",
        );
      });
    });

    it("shows inherited fallback badges without Reset when no project override is stored", async () => {
      await setupWorkflowModelLaneTest();

      const lane = screen.getByTestId("workflow-model-lane-planning-fallback");
      expect(within(lane).getByText("Inherited (Workflow)")).toBeInTheDocument();
      expect(within(lane).queryByRole("button", { name: "Reset" })).not.toBeInTheDocument();
    });

    it("does not write workflow settings when the primary Save has no pending workflow edits", async () => {
      const onClose = vi.fn();
      await setupWorkflowModelLaneTest({ renderProps: { onClose } });

      await userEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(onClose).toHaveBeenCalled();
      });
      expect(mockUpdateWorkflowSettingValues).not.toHaveBeenCalled();
    });

    it("resets workflow model lanes by sending null patches from the primary Settings Save", async () => {
      await setupWorkflowModelLaneTest({
        stored: { executionProvider: "anthropic", executionModelId: "claude-sonnet-4-5" },
        effective: { executionProvider: "anthropic", executionModelId: "claude-sonnet-4-5" },
      });

      const lane = screen.getByTestId("workflow-model-lane-execution");
      await userEvent.click(within(lane).getByRole("button", { name: "Reset" }));
      await userEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(mockUpdateWorkflowSettingValues).toHaveBeenCalledWith(
          "workflow-custom",
          { executionProvider: null, executionModelId: null },
          "proj-1",
        );
      });
    });

    it("falls back to builtin workflow values when the configured default workflow is stale", async () => {
      mockFetchWorkflowSettingValues
        .mockRejectedValueOnce(new ApiRequestError("not found", 404))
        .mockResolvedValueOnce({ stored: {}, effective: {}, orphaned: [] });
      mockUpdateWorkflowSettingValues.mockResolvedValue({
        stored: { planningProvider: "openai", planningModelId: "gpt-4o" },
        effective: { planningProvider: "openai", planningModelId: "gpt-4o" },
        orphaned: [],
      });
      await setupWorkflowModelLaneTest();

      await waitFor(() => {
        expect(mockFetchWorkflowSettingValues).toHaveBeenLastCalledWith("builtin:coding", "proj-1");
      });

      await userEvent.click(screen.getByLabelText("Plan/Triage Model"));
      await userEvent.click(await screen.findByText("GPT-4o"));
      await userEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(mockUpdateWorkflowSettingValues).toHaveBeenCalledWith(
          "builtin:coding",
          { planningProvider: "openai", planningModelId: "gpt-4o" },
          "proj-1",
        );
      });
    });

    it("shows typed workflow model lane rejections without closing or clearing pending edits", async () => {
      const addToast = vi.fn();
      const onClose = vi.fn();
      mockUpdateWorkflowSettingValues.mockRejectedValueOnce(
        new ApiRequestError("rejected", 400, {
          rejections: [{ code: "unknown-setting", settingId: "planningProvider", message: "planningProvider is not declared" }],
        }),
      );
      await setupWorkflowModelLaneTest({ renderProps: { addToast, onClose } });

      await userEvent.click(screen.getByLabelText("Plan/Triage Model"));
      await userEvent.click(await screen.findByText("GPT-4o"));
      await userEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(screen.getByTestId("workflow-model-lane-error-planning")).toHaveTextContent("planningProvider is not declared");
      });
      expect(onClose).not.toHaveBeenCalled();
      expect(addToast).not.toHaveBeenCalledWith("Settings saved", "success");
      expect(within(screen.getByTestId("workflow-model-lane-planning")).getByText("GPT-4o")).toBeInTheDocument();
    });

    it("shows the existing workflow model-lane empty state when no models are available", async () => {
      await setupWorkflowModelLaneTest({ models: [] });

      expect(screen.getByText(/No models available. Configure authentication before selecting workflow model lanes./i)).toBeInTheDocument();
      expect(screen.queryByTestId("workflow-model-lane-planning-fallback")).not.toBeInTheDocument();
      expect(screen.queryByTestId("workflow-model-lane-validator-fallback")).not.toBeInTheDocument();
    });

    it("does not fetch or write workflow model lanes without an active project", async () => {
      mockFetchModels.mockResolvedValue({
        models: MODEL_FIXTURE,
        favoriteProviders: [],
        favoriteModels: [],
      });

      renderModal({ initialSection: "project-models" });
      await waitForSettingsModalReady();

      expect(screen.getByText(/Open a project to edit workflow model lanes/i)).toBeInTheDocument();
      expect(mockFetchWorkflowSettingValues).not.toHaveBeenCalled();
      expect(screen.queryByTestId("save-workflow-model-lanes")).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(mockUpdateWorkflowSettingValues).not.toHaveBeenCalled();
    });
  });

  describe("settings header actions", () => {
    it("renders Help, Discord (hardened), and GitHub star controls", async () => {
      renderModal();
      await waitForSettingsModalReady();

      const headerActions = document.querySelector(".settings-header-actions");
      expect(headerActions).toBeInTheDocument();

      expect(within(headerActions as HTMLElement).getByRole("link", { name: "Star Fusion on GitHub" })).toBeInTheDocument();
      expect(within(headerActions as HTMLElement).getByRole("link", { name: "Join our Discord" })).toBeInTheDocument();
      expect(within(headerActions as HTMLElement).queryByRole("link", { name: "Help and discussions" })).not.toBeInTheDocument();

      const footerVersion = document.querySelector(".settings-modal-footer-version");
      expect(footerVersion).toBeInTheDocument();

      const helpLink = within(footerVersion as HTMLElement).getByRole("link", { name: "Help and discussions" });
      expect(helpLink).toBeInTheDocument();
      expect(helpLink).toHaveAttribute("href", "https://github.com/Runfusion/Fusion/discussions");
      expect(helpLink).toHaveAttribute("target", "_blank");
      expect(helpLink).toHaveAttribute("rel", expect.stringContaining("noopener"));
      expect(helpLink).toHaveAttribute("rel", expect.stringContaining("noreferrer"));

      // Discord link uses hardened external attributes and branded icon.
      const discordLink = screen.getByRole("link", { name: "Join our Discord" });
      expect(discordLink).toHaveAttribute("href", "https://discord.gg/ksrfuy7WYR");
      expect(discordLink).toHaveAttribute("target", "_blank");
      expect(discordLink).toHaveAttribute("rel", expect.stringContaining("noopener"));
      expect(discordLink).toHaveAttribute("rel", expect.stringContaining("noreferrer"));
      expect(within(discordLink).getByTestId("discord-icon")).toBeInTheDocument();
      expect(within(discordLink).queryByTestId("lucide-message-circle")).not.toBeInTheDocument();
    });
  });

  describe("settings version display", () => {
    it("renders the app version and the check-for-updates button in the header", async () => {
      renderModal();
      await waitForSettingsModalReady();

      expect(await screen.findByText("Version 1.2.3")).toBeInTheDocument();
      expect(mockFetchDashboardHealth).toHaveBeenCalledTimes(1);

      expect(screen.getByRole("button", { name: "Check for updates" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Check Now" })).not.toBeInTheDocument();
      expect(screen.queryByText("Manually check for the latest version right now.")).not.toBeInTheDocument();
    });

    it("keeps settings interactive when version lookup fails", async () => {
      const addToast = vi.fn();
      mockFetchDashboardHealth.mockRejectedValueOnce(new Error("health unavailable"));
      render(<SettingsModal onClose={noop} addToast={addToast} />);

      await waitForSettingsModalReady();

      expect(screen.queryByText(/^Version\s+/)).not.toBeInTheDocument();
      await userEvent.click(screen.getByText("Scheduling & Capacity"));
      expect(await screen.findByLabelText("Max Concurrent Tasks")).toBeInTheDocument();
      expect(addToast).not.toHaveBeenCalled();
    });

    it("clicking check for updates shows up-to-date message", async () => {
      mockCheckForUpdates.mockResolvedValueOnce({
        currentVersion: "1.2.3",
        latestVersion: "1.2.3",
        updateAvailable: false,
      });

      renderModal();
      await waitForSettingsModalReady();

      await userEvent.click(screen.getByRole("button", { name: "Check for updates" }));

      expect(await screen.findByText("You're up to date ✓")).toBeInTheDocument();
    });

    it("clicking check for updates shows update available message with runfusion.ai link", async () => {
      mockCheckForUpdates.mockResolvedValueOnce({
        currentVersion: "1.0.0",
        latestVersion: "2.0.0",
        updateAvailable: true,
      });

      renderModal();
      await waitForSettingsModalReady();

      await userEvent.click(screen.getByRole("button", { name: "Check for updates" }));

      expect(await screen.findByText(/v2.0.0 available/i)).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Learn more" })).toHaveAttribute("href", "https://runfusion.ai");
      expect(screen.getByRole("button", { name: "Update now" })).toBeInTheDocument();
    });

    it("hides update-now when update check is up-to-date or errored", async () => {
      mockCheckForUpdates.mockResolvedValueOnce({
        currentVersion: "1.2.3",
        latestVersion: "1.2.3",
        updateAvailable: false,
      });

      const { unmount } = renderModal();
      await waitForSettingsModalReady();
      await userEvent.click(screen.getByRole("button", { name: "Check for updates" }));
      expect(await screen.findByText("You're up to date ✓")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Update now" })).not.toBeInTheDocument();

      unmount();
      mockCheckForUpdates.mockResolvedValueOnce({
        currentVersion: "1.2.3",
        latestVersion: null,
        updateAvailable: false,
        error: "registry unavailable",
      });

      renderModal();
      await waitForSettingsModalReady();
      await userEvent.click(screen.getByRole("button", { name: "Check for updates" }));
      expect(await screen.findByText("registry unavailable")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Update now" })).not.toBeInTheDocument();
    });

    it("installs update from the footer and renders restart hint", async () => {
      mockCheckForUpdates.mockResolvedValueOnce({
        currentVersion: "1.0.0",
        latestVersion: "2.0.0",
        updateAvailable: true,
      });
      mockInstallUpdate.mockResolvedValueOnce({ currentVersion: "1.0.0", latestVersion: "2.0.0", updated: true });

      renderModal();
      await waitForSettingsModalReady();
      await userEvent.click(screen.getByRole("button", { name: "Check for updates" }));
      await userEvent.click(await screen.findByRole("button", { name: "Update now" }));

      await waitFor(() => expect(mockInstallUpdate).toHaveBeenCalledTimes(1));
      expect(await screen.findByText("Updated to v2.0.0 — restart Fusion to apply")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Update now" })).not.toBeInTheDocument();
    });

    it("disables update-now and shows inline errors while installing", async () => {
      mockCheckForUpdates.mockResolvedValueOnce({
        currentVersion: "1.0.0",
        latestVersion: "2.0.0",
        updateAvailable: true,
      });
      let resolveInstall: ((result: { currentVersion: string; latestVersion: string; updated: boolean; error?: string }) => void) | undefined;
      mockInstallUpdate.mockReturnValueOnce(new Promise((resolve) => {
        resolveInstall = resolve;
      }));

      renderModal();
      await waitForSettingsModalReady();
      await userEvent.click(screen.getByRole("button", { name: "Check for updates" }));

      const updateNow = await screen.findByRole("button", { name: "Update now" });
      fireEvent.click(updateNow);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Updating…" })).toBeDisabled();
      });
      expect(screen.getByRole("button", { name: "Updating…" }).querySelector(".spinning")).not.toBeNull();

      resolveInstall?.({ currentVersion: "1.0.0", latestVersion: "2.0.0", updated: false, error: "install failed" });

      expect(await screen.findByText("Update failed: install failed")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Update now" })).not.toBeDisabled();
    });

    it("disables button while checking", async () => {
      let resolveCheck: ((result: UpdateCheckResponse) => void) | undefined;
      const pendingCheck = new Promise<UpdateCheckResponse>((resolve) => {
        resolveCheck = resolve;
      });
      mockCheckForUpdates.mockReturnValueOnce(pendingCheck);

      renderModal();
      await waitForSettingsModalReady();

      const button = screen.getByRole("button", { name: "Check for updates" });
      expect(button).not.toBeDisabled();

      fireEvent.click(button);
      await waitFor(() => {
        expect(button).toBeDisabled();
      });

      resolveCheck?.({
        currentVersion: "1.2.3",
        latestVersion: "1.2.3",
        updateAvailable: false,
      });

      await waitFor(() => {
        expect(button).not.toBeDisabled();
      });
    });

    it("clicking version text area triggers update check", async () => {
      mockCheckForUpdates.mockResolvedValueOnce({
        currentVersion: "1.2.3",
        latestVersion: "1.2.3",
        updateAvailable: false,
      });

      renderModal();
      await waitForSettingsModalReady();

      const inlineButton = screen.getByRole("button", { name: "Check for updates" });
      expect(within(inlineButton).getByText("Version 1.2.3")).toBeInTheDocument();

      await userEvent.click(within(inlineButton).getByText("Version 1.2.3"));

      await waitFor(() => {
        expect(mockCheckForUpdates).toHaveBeenCalledTimes(1);
      });
    });

    it("refresh icon has spinning class while loading", async () => {
      let resolveCheck: ((result: UpdateCheckResponse) => void) | undefined;
      const pendingCheck = new Promise<UpdateCheckResponse>((resolve) => {
        resolveCheck = resolve;
      });
      mockCheckForUpdates.mockReturnValueOnce(pendingCheck);

      renderModal();
      await waitForSettingsModalReady();

      const button = screen.getByRole("button", { name: "Check for updates" });
      fireEvent.click(button);

      await waitFor(() => {
        const spinningIcon = button.querySelector(".spinning");
        expect(spinningIcon).not.toBeNull();
      });

      resolveCheck?.({
        currentVersion: "1.2.3",
        latestVersion: "1.2.3",
        updateAvailable: false,
      });

      await waitFor(() => {
        expect(button.querySelector(".spinning")).toBeNull();
      });
    });
  });

  describe("settings export filename", () => {
    it("uses fusion-settings- prefix for exported filename", async () => {
      const mockExportData: SettingsExportData = {
        version: 1,
        exportedAt: "2026-04-04T12:00:00.000Z",
        global: undefined,
        project: { maxConcurrent: 2 },
      };
      mockExportSettings.mockResolvedValue(mockExportData);

      // Spy on createElement to capture the download link's filename
      const originalCreateElement = document.createElement.bind(document);
      const createdElements: { tagName: string; download: string; href: string }[] = [];
      vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
        const el = originalCreateElement(tagName);
        if (tagName.toLowerCase() === "a") {
          // Capture the download attribute when set
          const origDownloadDescriptor = Object.getOwnPropertyDescriptor(
            HTMLAnchorElement.prototype,
            "download"
          );
          Object.defineProperty(el, "download", {
            set(v: string) {
              createdElements.push({ tagName, download: v, href: (el as HTMLAnchorElement).href });
              origDownloadDescriptor?.set?.call(el, v);
            },
            get() {
              return origDownloadDescriptor?.get?.call(el) ?? "";
            },
            configurable: true,
          });
        }
        return el;
      });

      // Mock URL.createObjectURL and revokeObjectURL
      vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:http://localhost/mock");
      vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

      renderModal();

      // Wait for settings to load
      await waitFor(() => {
        expect(mockFetchSettings).toHaveBeenCalled();
      });

      // Find and click the Export button
      const exportButton = screen.getByTitle("Export settings to JSON file");
      expect(exportButton).toBeDefined();

      fireEvent.click(exportButton);

      await waitFor(() => {
        expect(mockExportSettings).toHaveBeenCalled();
      });

      // Assert the filename uses fusion-settings- prefix and NOT the legacy kb- prefix.
      expect(createdElements.length).toBeGreaterThanOrEqual(1);
      const anchorElement = createdElements[0];
      expect(anchorElement.download).toMatch(/^fusion-settings-/);
      expect(anchorElement.download).toMatch(/^fusion-settings-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.json$/);
      for (const { download } of createdElements) {
        expect(download).not.toMatch(/^kb-settings-/);
      }
    });
  });

  describe("Authentication provider icon wrappers", () => {
    it.each([
      { id: "openrouter", name: "OpenRouter", authenticated: true, type: "api_key", iconTestId: "openrouter-icon" },
      { id: "unknown-provider", name: "Unknown Provider", authenticated: false, type: "api_key", iconTestId: null },
    ] as const)("renders stable auth-provider-icon wrappers for $id", async ({ id, name, authenticated, type, iconTestId }) => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [{ id, name, authenticated, type }],
      });

      renderModal();
      await waitForSettingsModalReady();

      const iconWrapper = await screen.findByTestId(`auth-provider-icon-${id}`);
      if (iconTestId) {
        expect(within(iconWrapper).getByTestId(iconTestId)).toBeInTheDocument();
        return;
      }

      const fallbackSvg = iconWrapper.querySelector("svg");
      expect(fallbackSvg).toBeInTheDocument();
      expect(fallbackSvg).not.toHaveAttribute("data-testid");
    });

    it("renders icon wrappers for both authenticated and available provider rows", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "github", name: "GitHub", authenticated: true, type: "oauth" },
          { id: "openai", name: "OpenAI", authenticated: false, type: "api_key" },
          { id: "cloudflare", name: "Cloudflare", authenticated: false, type: "api_key" },
        ],
      });

      renderModal();
      await waitForSettingsModalReady();

      expect(screen.getByTestId("auth-provider-icon-github")).toBeInTheDocument();
      expect(screen.getByTestId("auth-provider-icon-openai")).toBeInTheDocument();
      expect(screen.getByTestId("auth-provider-icon-cloudflare")).toBeInTheDocument();
      expect(within(screen.getByTestId("auth-provider-icon-cloudflare")).getByTestId("cloudflare-icon")).toBeInTheDocument();
      expect(screen.getByTestId("auth-status-github")).toHaveTextContent("✓ Active");
      expect(screen.getByTestId("auth-status-openai")).toHaveTextContent("✗ Not connected");
    });

    it("hides deprecated Google CLI and antigravity auth providers", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "google", name: "Google", authenticated: false, type: "api_key" },
          { id: "gemini", name: "Gemini", authenticated: false, type: "api_key" },
          { id: "google-antigravity", name: "Google Antigravity", authenticated: false, type: "oauth" },
          { id: "antigravity", name: "Antigravity", authenticated: false, type: "oauth" },
          { id: "google-gemini-cli", name: "Google Gemini CLI", authenticated: false, type: "cli" },
        ],
      });

      renderModal();
      await waitForSettingsModalReady();

      expect(screen.getByTestId("auth-provider-icon-google")).toBeInTheDocument();
      expect(screen.getByTestId("auth-provider-icon-gemini")).toBeInTheDocument();
      expect(screen.queryByTestId("auth-provider-icon-google-antigravity")).not.toBeInTheDocument();
      expect(screen.queryByTestId("auth-provider-icon-antigravity")).not.toBeInTheDocument();
      expect(screen.queryByText("Google Gemini CLI")).not.toBeInTheDocument();
    });

    it("scrolls settings content to top after OAuth login succeeds", async () => {
      const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
      mockLoginProvider.mockResolvedValue({ url: "https://example.com/auth", instructions: "" });
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [{ id: "github", name: "GitHub", authenticated: false, type: "oauth" }],
      });
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [{ id: "github", name: "GitHub", authenticated: true, type: "oauth" }],
      });

      vi.spyOn(globalThis, "setInterval").mockImplementation((callback: TimerHandler) => {
        void Promise.resolve().then(() => {
          if (typeof callback === "function") callback();
        });
        return 1 as unknown as ReturnType<typeof setInterval>;
      });

      const { container } = renderModal();
      await waitForSettingsModalReady();

      const settingsContent = container.querySelector(".settings-content") as HTMLDivElement;
      expect(settingsContent).toBeInTheDocument();
      const scrollToSpy = vi.fn();
      Object.defineProperty(settingsContent, "scrollTo", {
        value: scrollToSpy,
        writable: true,
      });

      await userEvent.click(screen.getByRole("button", { name: "Login" }));

      await waitFor(() => {
        expect(scrollToSpy).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
      });
      expect(openSpy).toHaveBeenCalled();
    });

    it("warns before starting manual-code oauth login and stops when cancelled", async () => {
      vi.spyOn(window, "open").mockImplementation(() => null);
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [{ id: "anthropic", name: "Anthropic", authenticated: false, type: "oauth", requiresManualCode: true }],
      });
      mockConfirm.mockResolvedValueOnce(false);

      renderModal();
      await waitForSettingsModalReady();

      const anthropicCard = screen.getByTestId("auth-provider-icon-anthropic").closest(".auth-provider-card") as HTMLElement;
      await userEvent.click(within(anthropicCard).getByRole("button", { name: "Login" }));

      await waitFor(() => {
        expect(mockConfirm).toHaveBeenCalledWith({
          title: "Heads up — manual paste-back required",
          message:
            "After you sign in with Anthropic, the browser will try to redirect to a localhost address that this dashboard can't reach. The redirect tab will look like it failed. Before that happens, copy the full URL from the browser address bar — you'll paste it back here to finish login. Continue?",
          confirmLabel: "Continue to login",
          cancelLabel: "Cancel",
        });
      });
      expect(mockLoginProvider).not.toHaveBeenCalled();
    });

    it("continues manual-code oauth login after confirmation", async () => {
      const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [{ id: "anthropic", name: "Anthropic", authenticated: false, type: "oauth", requiresManualCode: true }],
      });
      mockLoginProvider.mockResolvedValueOnce({ url: "https://claude.ai/oauth/authorize" });
      mockConfirm.mockResolvedValueOnce(true);

      renderModal();
      await waitForSettingsModalReady();

      const anthropicCard = screen.getByTestId("auth-provider-icon-anthropic").closest(".auth-provider-card") as HTMLElement;
      await userEvent.click(within(anthropicCard).getByRole("button", { name: "Login" }));

      await waitFor(() => {
        expect(mockConfirm).toHaveBeenCalled();
        expect(mockLoginProvider).toHaveBeenCalledWith("anthropic");
        expect(openSpy).toHaveBeenCalledWith("https://claude.ai/oauth/authorize", "_blank");
      });
    });

    it("skips the warning for oauth providers without manual-code fallback", async () => {
      const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [{ id: "github", name: "GitHub", authenticated: false, type: "oauth" }],
      });
      mockLoginProvider.mockResolvedValueOnce({ url: "https://example.com/auth" });

      renderModal();
      await waitForSettingsModalReady();

      await userEvent.click(screen.getByRole("button", { name: "Login" }));

      await waitFor(() => {
        expect(mockConfirm).not.toHaveBeenCalled();
        expect(mockLoginProvider).toHaveBeenCalledWith("github");
        expect(openSpy).toHaveBeenCalledWith("https://example.com/auth", "_blank");
      });
    });

    it("renders Anthropic pasted-code form when login response includes manualCode", async () => {
      const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [{ id: "anthropic", name: "Anthropic", authenticated: false, type: "oauth" }],
      });
      mockLoginProvider.mockResolvedValueOnce({
        url: "https://claude.ai/oauth/authorize",
        manualCode: {
          prompt: "Paste the final redirect URL or authorization code",
          placeholder: "http://localhost:*/callback?code=...&state=... or just the code",
          helpText: "After Claude sign-in, copy the full browser URL (or just the code) and paste it here to finish login from this dashboard host.",
        },
      });

      renderModal();
      await waitForSettingsModalReady();

      const anthropicCard = screen.getByTestId("auth-provider-icon-anthropic").closest(".auth-provider-card") as HTMLElement;
      await userEvent.click(within(anthropicCard).getByRole("button", { name: "Login" }));

      expect(await within(anthropicCard).findByText("Paste the final redirect URL or authorization code")).toBeInTheDocument();
      await userEvent.type(within(anthropicCard).getByRole("textbox"), "anthropic-code");
      await userEvent.click(within(anthropicCard).getByRole("button", { name: "Submit code" }));

      await waitFor(() => {
        expect(mockSubmitProviderManualCode).toHaveBeenCalledWith("anthropic", "anthropic-code");
      });
      expect(openSpy).toHaveBeenCalled();
    });

    it("scrolls the manual-code input into view on mobile focus", async () => {
      Object.defineProperty(window, "matchMedia", {
        writable: true,
        value: vi.fn().mockImplementation((query: string) => ({
          matches: query === "(max-width: 768px)" || query === "(max-width: 768px), (max-height: 480px)" || query === "(pointer: coarse)",
          media: query,
          onchange: null,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          addListener: vi.fn(),
          removeListener: vi.fn(),
          dispatchEvent: vi.fn(),
        })),
      });

      const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
      vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      });

      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [{ id: "anthropic", name: "Anthropic", authenticated: false, type: "oauth" }],
      });
      mockLoginProvider.mockResolvedValueOnce({
        url: "https://claude.ai/oauth/authorize",
        manualCode: {
          prompt: "Paste the final redirect URL or authorization code",
        },
      });

      renderModal();
      await waitForSettingsModalReady();

      const anthropicCard = screen.getByTestId("auth-provider-icon-anthropic").closest(".auth-provider-card") as HTMLElement;
      await userEvent.click(within(anthropicCard).getByRole("button", { name: "Login" }));

      const textarea = await within(anthropicCard).findByRole("textbox");
      const scrollIntoView = vi.fn();
      Object.defineProperty(textarea, "scrollIntoView", {
        value: scrollIntoView,
        writable: true,
      });

      fireEvent.focus(textarea);

      await waitFor(() => {
        expect(scrollIntoView).toHaveBeenCalled();
      });
      expect(openSpy).toHaveBeenCalled();
    });

    it("shows cancel action for server-reported pending oauth login", async () => {
      mockFetchAuthStatus.mockResolvedValue({
        providers: [{ id: "github-copilot", name: "GitHub Copilot", authenticated: false, type: "oauth", loginInProgress: true }],
      });

      renderModal();
      await waitForSettingsModalReady();

      const copilotCard = screen.getByTestId("auth-provider-icon-github-copilot").closest(".auth-provider-card") as HTMLElement;
      expect(within(copilotCard).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
      await userEvent.click(within(copilotCard).getByRole("button", { name: "Cancel" }));

      await waitFor(() => {
        expect(mockCancelProviderLogin).toHaveBeenCalledWith("github-copilot");
      });
    });

    it("renders github copilot device code panel and handles copy/open actions", async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      const addToast = vi.fn();
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText },
      });

      const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
      mockFetchAuthStatus
        .mockResolvedValueOnce({
          providers: [{ id: "github-copilot", name: "GitHub Copilot", authenticated: false, type: "oauth" }],
        })
        .mockResolvedValueOnce({
          providers: [{ id: "github-copilot", name: "GitHub Copilot", authenticated: false, type: "oauth", loginInProgress: true }],
        })
        .mockResolvedValueOnce({
          providers: [{ id: "github-copilot", name: "GitHub Copilot", authenticated: true, type: "oauth" }],
        });
      mockLoginProvider.mockResolvedValueOnce({
        url: "https://auth.example.com/login",
        instructions: "Enter code: ABCD-1234",
        deviceCode: {
          userCode: "ABCD-1234",
          verificationUri: "https://github.com/login/device",
        },
      });

      render(<SettingsModal onClose={noop} addToast={addToast} />);
      await waitForSettingsModalReady();
      await userEvent.click(screen.getByRole("button", { name: "Authentication" }));

      vi.useFakeTimers();

      try {
        const copilotCard = screen.getByTestId("auth-provider-icon-github-copilot").closest(".auth-provider-card") as HTMLElement;
        fireEvent.click(within(copilotCard).getByRole("button", { name: "Login" }));

        await act(async () => {
          await Promise.resolve();
        });
        expect(within(copilotCard).getByText("ABCD-1234")).toBeInTheDocument();
        expect(within(copilotCard).queryByTestId("auth-login-instructions-github-copilot")).not.toBeInTheDocument();
        expect(openSpy).not.toHaveBeenCalled();
        expect(writeText).toHaveBeenCalledWith("ABCD-1234");
        expect(writeText).toHaveBeenCalledTimes(1);

        fireEvent.click(within(copilotCard).getByRole("button", { name: "Copy code" }));
        await act(async () => {
          await Promise.resolve();
        });
        expect(writeText).toHaveBeenCalledWith("ABCD-1234");
        expect(writeText).toHaveBeenCalledTimes(2);
        expect(addToast).toHaveBeenCalledWith("Copied code to clipboard", "success");

        fireEvent.click(within(copilotCard).getByRole("button", { name: "Open GitHub" }));
        expect(openSpy).toHaveBeenCalledWith("https://github.com/login/device", "_blank");

        await act(async () => {
          await vi.advanceTimersByTimeAsync(2000);
          await vi.advanceTimersByTimeAsync(2000);
        });

        expect(within(copilotCard).queryByText("ABCD-1234")).not.toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it("uses execCommand fallback when clipboard API is unavailable", async () => {
      const addToast = vi.fn();
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: undefined,
      });
      const execSpy = vi.fn().mockReturnValue(true);
      Object.defineProperty(document, "execCommand", {
        configurable: true,
        value: execSpy,
      });
      mockFetchAuthStatus
        .mockResolvedValueOnce({ providers: [{ id: "github-copilot", name: "GitHub Copilot", authenticated: false, type: "oauth" }] })
        .mockResolvedValueOnce({ providers: [{ id: "github-copilot", name: "GitHub Copilot", authenticated: false, type: "oauth", loginInProgress: true }] });
      mockLoginProvider.mockResolvedValueOnce({
        url: "https://auth.example.com/login",
        deviceCode: { userCode: "ABCD-1234", verificationUri: "https://github.com/login/device" },
      });

      render(<SettingsModal onClose={noop} addToast={addToast} />);
      await userEvent.click(await screen.findByRole("button", { name: "Authentication" }));
      const copilotCard = (await screen.findByTestId("auth-provider-icon-github-copilot")).closest(".auth-provider-card") as HTMLElement;
      await userEvent.click(within(copilotCard).getByRole("button", { name: "Login" }));
      await within(copilotCard).findByText("ABCD-1234");

      await userEvent.click(within(copilotCard).getByRole("button", { name: "Copy code" }));
      expect(execSpy).toHaveBeenCalledWith("copy");
      expect(addToast).toHaveBeenCalledWith(expect.stringContaining("Copied"), "success");
    });

    it("shows error toast when clipboard API and fallback both fail", async () => {
      const addToast = vi.fn();
      const writeText = vi.fn().mockRejectedValue(new Error("NotAllowedError"));
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText },
      });
      Object.defineProperty(document, "execCommand", {
        configurable: true,
        value: vi.fn().mockReturnValue(false),
      });
      mockFetchAuthStatus
        .mockResolvedValueOnce({ providers: [{ id: "github-copilot", name: "GitHub Copilot", authenticated: false, type: "oauth" }] })
        .mockResolvedValueOnce({ providers: [{ id: "github-copilot", name: "GitHub Copilot", authenticated: false, type: "oauth", loginInProgress: true }] });
      mockLoginProvider.mockResolvedValueOnce({
        url: "https://auth.example.com/login",
        deviceCode: { userCode: "ABCD-1234", verificationUri: "https://github.com/login/device" },
      });

      render(<SettingsModal onClose={noop} addToast={addToast} />);
      await userEvent.click(await screen.findByRole("button", { name: "Authentication" }));
      const copilotCard = (await screen.findByTestId("auth-provider-icon-github-copilot")).closest(".auth-provider-card") as HTMLElement;
      await userEvent.click(within(copilotCard).getByRole("button", { name: "Login" }));
      await within(copilotCard).findByText("ABCD-1234");

      await userEvent.click(within(copilotCard).getByRole("button", { name: "Copy code" }));
      expect(addToast).toHaveBeenCalledWith(expect.stringContaining("manually"), "error");
    });

    it("scrolls settings content to top after API key save succeeds", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [{ id: "openai", name: "OpenAI", authenticated: false, type: "api_key" }],
      });
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [{ id: "openai", name: "OpenAI", authenticated: true, type: "api_key" }],
      });

      const { container } = renderModal();
      await waitForSettingsModalReady();

      const settingsContent = container.querySelector(".settings-content") as HTMLDivElement;
      expect(settingsContent).toBeInTheDocument();
      const scrollToSpy = vi.fn();
      Object.defineProperty(settingsContent, "scrollTo", {
        value: scrollToSpy,
        writable: true,
      });

      const openAiCard = screen.getByTestId("auth-provider-icon-openai").closest(".auth-provider-card") as HTMLElement;
      await userEvent.type(within(openAiCard).getByPlaceholderText("Enter API key"), "sk-test-key");
      await userEvent.click(within(openAiCard).getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(mockSaveApiKey).toHaveBeenCalledWith("openai", "sk-test-key");
        expect(scrollToSpy).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
      });
    });

    it("shows opencode-go refresh success message after API key save", async () => {
      mockFetchAuthStatus.mockResolvedValue({
        providers: [{ id: "opencode-go", name: "Opencode (Go)", authenticated: false, type: "api_key" }],
      });
      mockSaveApiKey.mockResolvedValueOnce({ success: true, modelsRefreshed: 4 });

      const { container } = renderModal();
      await waitForSettingsModalReady();
      const settingsContent = container.querySelector(".settings-content") as HTMLDivElement;
      Object.defineProperty(settingsContent, "scrollTo", { value: vi.fn(), writable: true });

      const card = screen.getByTestId("auth-provider-icon-opencode-go").closest(".auth-provider-card") as HTMLElement;
      await userEvent.type(within(card).getByPlaceholderText("Enter API key"), "opencode-key");
      await userEvent.click(within(card).getByRole("button", { name: "Save" }));

      expect(await within(card).findByText("Refreshed 4 opencode-go models.")).toBeInTheDocument();
    });

    it("shows opencode-go no-models guidance message", async () => {
      mockFetchAuthStatus.mockResolvedValue({
        providers: [{ id: "opencode-go", name: "Opencode (Go)", authenticated: false, type: "api_key" }],
      });
      mockSaveApiKey.mockResolvedValueOnce({ success: true, modelsRefreshed: 0, refreshReason: "no-models-from-cli" });

      const { container } = renderModal();
      await waitForSettingsModalReady();
      const settingsContent = container.querySelector(".settings-content") as HTMLDivElement;
      Object.defineProperty(settingsContent, "scrollTo", { value: vi.fn(), writable: true });

      const card = screen.getByTestId("auth-provider-icon-opencode-go").closest(".auth-provider-card") as HTMLElement;
      await userEvent.type(within(card).getByPlaceholderText("Enter API key"), "opencode-key");
      await userEvent.click(within(card).getByRole("button", { name: "Save" }));

      expect(await within(card).findByText(/returned no models/i)).toBeInTheDocument();
    });

    it("shows opencode-go refresh error message", async () => {
      mockFetchAuthStatus.mockResolvedValue({
        providers: [{ id: "opencode-go", name: "Opencode (Go)", authenticated: false, type: "api_key" }],
      });
      mockSaveApiKey.mockResolvedValueOnce({ success: true, refreshError: "spawn opencode ENOENT" });

      const { container } = renderModal();
      await waitForSettingsModalReady();
      const settingsContent = container.querySelector(".settings-content") as HTMLDivElement;
      Object.defineProperty(settingsContent, "scrollTo", { value: vi.fn(), writable: true });

      const card = screen.getByTestId("auth-provider-icon-opencode-go").closest(".auth-provider-card") as HTMLElement;
      await userEvent.type(within(card).getByPlaceholderText("Enter API key"), "opencode-key");
      await userEvent.click(within(card).getByRole("button", { name: "Save" }));

      expect(await within(card).findByText(/model refresh failed: spawn opencode ENOENT/i)).toBeInTheDocument();
    });
  });

  describe("Droid plugin Settings integration", () => {
    it.each([
      {
        name: "unavailable/not enabled",
        status: {
          binary: { available: false, reason: "`droid` not found on PATH", probeDurationMs: 9 },
          enabled: false,
          extension: { status: "ok" },
          ready: false,
        },
        expectedText: "not found on PATH",
      },
      {
        name: "enabled but not ready",
        status: {
          binary: { available: true, version: "1.2.3", binaryPath: "/usr/local/bin/droid", probeDurationMs: 9 },
          enabled: true,
          extension: { status: "ok" },
          ready: false,
        },
        expectedText: "Enabled. Validating…",
      },
      {
        name: "connected and ready",
        status: {
          binary: { available: true, version: "1.2.3", binaryPath: "/usr/local/bin/droid", probeDurationMs: 9 },
          enabled: true,
          extension: { status: "ok" },
          ready: true,
        },
        expectedText: "✓ Active",
      },
    ])("renders plugin-driven droid card state: $name", async ({ status }) => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [{ id: "droid-cli", name: "Factory AI (via Droid CLI)", authenticated: false, type: "cli" }],
      });
      mockFetchPluginUiSlots.mockResolvedValueOnce([
        {
          pluginId: "fusion-plugin-droid-runtime",
          slot: {
            slotId: "settings-provider-card",
            label: "Droid CLI Provider",
            componentPath: "./components/settings-provider-card.js",
          },
        },
      ]);
      mockFetchDroidCliStatus.mockResolvedValueOnce(status);

      renderModal();
      await waitForSettingsModalReady();

      expect(screen.getByRole("heading", { name: "Authentication" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
      expect(await screen.findByTestId("droid-cli-provider-card")).toBeInTheDocument();
      expect(screen.getAllByTestId("droid-cli-provider-card")).toHaveLength(1);
    });

    it("renders cursor cli auth card in authentication group", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [{ id: "cursor-cli", name: "Cursor — via Cursor CLI", authenticated: false, type: "cli" }],
      });
      mockFetchPluginUiSlots.mockResolvedValueOnce([]);

      renderModal();
      await waitForSettingsModalReady();

      expect(await screen.findByTestId("cursor-cli-provider-card")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Enable" })).toBeInTheDocument();
    });

    it("disables cursor enable action when binary is unavailable", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [{ id: "cursor-cli", name: "Cursor — via Cursor CLI", authenticated: false, type: "cli" }],
      });
      mockFetchCursorCliStatus.mockResolvedValueOnce({
        binary: { available: false, reason: "cursor-agent not found", probeDurationMs: 8 },
        enabled: false,
        extension: null,
        ready: false,
      });

      renderModal();
      await waitForSettingsModalReady();

      expect(await screen.findByText("cursor-agent not found")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Enable" })).toBeDisabled();
    });

    it("does not render droid auth card when plugin slot is not present", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [{ id: "droid-cli", name: "Factory AI (via Droid CLI)", authenticated: false, type: "cli" }],
      });
      mockFetchPluginUiSlots.mockResolvedValueOnce([]);

      renderModal();
      await waitForSettingsModalReady();

      expect(screen.queryByTestId("droid-cli-provider-card")).not.toBeInTheDocument();
    });
  });

  describe("Plugins section navigation", () => {
    it("does not render a standalone Pi Extensions sidebar item", async () => {
      renderModal();
      await waitForSettingsModalReady();

      const sidebar = document.querySelector(".settings-sidebar");
      expect(sidebar).toBeInTheDocument();
      expect(within(sidebar as HTMLElement).queryByRole("button", { name: /Pi Extensions$/ })).not.toBeInTheDocument();
      expect(within(sidebar as HTMLElement).getByRole("button", { name: /Plugins$/ })).toBeInTheDocument();
    });

    it("renders accessible tab semantics for Plugins subsection controls", async () => {
      renderModal();
      await waitForSettingsModalReady();

      await userEvent.click(await screen.findByRole("button", { name: /Plugins$/ }));

      const tablist = await screen.findByRole("tablist", { name: "Plugin manager type" });
      const fusionTab = within(tablist).getByRole("tab", { name: "Fusion Plugins" });
      const piTab = within(tablist).getByRole("tab", { name: "Pi Extensions" });

      expect(fusionTab).toHaveAttribute("aria-selected", "true");
      expect(fusionTab).toHaveAttribute("aria-controls", "plugins-panel-fusion-plugins");
      expect(piTab).toHaveAttribute("aria-selected", "false");
      expect(piTab).toHaveAttribute("aria-controls", "plugins-panel-pi-extensions");
    });

    it("switches between Fusion Plugins and Pi Extensions managers", async () => {
      renderModal();
      await waitForSettingsModalReady();

      await userEvent.click(await screen.findByRole("button", { name: /Plugins$/ }));

      expect(await screen.findByTestId("plugin-manager")).toBeInTheDocument();
      expect(screen.queryByTestId("pi-extensions-manager")).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole("tab", { name: "Pi Extensions" }));

      expect(await screen.findByTestId("pi-extensions-manager")).toBeInTheDocument();
      expect(screen.queryByTestId("plugin-manager")).not.toBeInTheDocument();
      expect(screen.getByRole("tabpanel", { name: "Pi Extensions" })).toBeVisible();
      expect(document.getElementById("plugins-panel-fusion-plugins")).toHaveAttribute("hidden");
    });
  });

  describe("Scheduling overlap ignore paths", () => {
    it("renders existing overlap ignore paths from settings", async () => {
      mockFetchSettings.mockResolvedValue({
        ...defaultSettings,
        overlapIgnorePaths: ["docs/", "generated/*"],
      });

      renderModal();
      await waitFor(() => expect(mockFetchSettings).toHaveBeenCalled());

      fireEvent.click(screen.getByText("Scheduling & Capacity"));

      expect(screen.getByDisplayValue("docs/")).toBeInTheDocument();
      expect(screen.getByDisplayValue("generated/*")).toBeInTheDocument();
    });

    it("supports selecting ignore paths through the browse picker", async () => {
      renderModal();
      await waitFor(() => expect(mockFetchSettings).toHaveBeenCalled());

      fireEvent.click(screen.getByText("Scheduling & Capacity"));

      await userEvent.click(screen.getByRole("button", { name: /browse path for ignored overlap entry 1/i }));

      expect(await screen.findByRole("dialog", { name: /browse workspace path/i })).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Select README.md" }));

      expect(screen.getByDisplayValue("README.md")).toBeInTheDocument();
    });

    it("includes overlapIgnorePaths in save payload", async () => {
      renderModal();
      await waitFor(() => expect(mockFetchSettings).toHaveBeenCalled());

      fireEvent.click(screen.getByText("Scheduling & Capacity"));

      await userEvent.click(screen.getByRole("button", { name: /browse path for ignored overlap entry 1/i }));
      await userEvent.click(await screen.findByRole("button", { name: "Select README.md" }));

      await userEvent.click(screen.getByRole("button", { name: /add ignored path/i }));
      const inputs = screen.getAllByPlaceholderText("docs/");
      await userEvent.type(inputs[1], "generated/*");

      await userEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalledTimes(1);
      });

      const payload = mockUpdateSettings.mock.calls[0][0];
      expect(payload.overlapIgnorePaths).toEqual(["README.md", "generated/*"]);
    });

    it("renders and saves heartbeat scope discipline", async () => {
      mockFetchSettings.mockResolvedValue({
        ...defaultSettings,
        heartbeatScopeDiscipline: "lite",
      });

      renderModal();
      await waitFor(() => expect(mockFetchSettings).toHaveBeenCalled());

      fireEvent.click(screen.getByText("Scheduling & Capacity"));

      const select = screen.getByLabelText("Heartbeat Scope Discipline") as HTMLSelectElement;
      expect(select.value).toBe("lite");

      await userEvent.selectOptions(select, "off");
      await userEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalledTimes(1);
      });

      const payload = mockUpdateSettings.mock.calls[0][0] as Record<string, unknown>;
      expect(payload.heartbeatScopeDiscipline).toBe("off");
    });

    it.each([
      ["undefined", undefined, false],
      ["false", false, false],
      ["true", true, true],
    ] as const)("renders engineer backlog auto-claim from %s project setting", async (_label, engineerBacklogAutoClaim, expectedChecked) => {
      mockFetchSettings.mockResolvedValue({
        ...defaultSettings,
        ...(engineerBacklogAutoClaim === undefined ? {} : { engineerBacklogAutoClaim }),
      });

      renderModal();
      await waitFor(() => expect(mockFetchSettings).toHaveBeenCalled());

      fireEvent.click(screen.getByText("Scheduling & Capacity"));

      expect((screen.getByLabelText("Let engineer agents auto-claim backlog tasks") as HTMLInputElement).checked).toBe(expectedChecked);
    });

    it("routes enabled engineer backlog auto-claim through the project settings save payload", async () => {
      mockFetchSettings.mockResolvedValue({
        ...defaultSettings,
        engineerBacklogAutoClaim: false,
      });

      renderModal();
      await waitFor(() => expect(mockFetchSettings).toHaveBeenCalled());

      fireEvent.click(screen.getByText("Scheduling & Capacity"));

      const toggle = screen.getByLabelText("Let engineer agents auto-claim backlog tasks") as HTMLInputElement;
      expect(toggle.checked).toBe(false);
      await userEvent.click(toggle);
      await userEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalledTimes(1);
      });

      const payload = mockUpdateSettings.mock.calls[0][0] as Record<string, unknown>;
      expect(payload.engineerBacklogAutoClaim).toBe(true);
    });

    it("routes disabled engineer backlog auto-claim through the project settings save payload", async () => {
      mockFetchSettings.mockResolvedValue({
        ...defaultSettings,
        engineerBacklogAutoClaim: true,
      });

      renderModal();
      await waitFor(() => expect(mockFetchSettings).toHaveBeenCalled());

      fireEvent.click(screen.getByText("Scheduling & Capacity"));

      const toggle = screen.getByLabelText("Let engineer agents auto-claim backlog tasks") as HTMLInputElement;
      expect(toggle.checked).toBe(true);
      await userEvent.click(toggle);
      await userEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalledTimes(1);
      });

      const payload = mockUpdateSettings.mock.calls[0][0] as Record<string, unknown>;
      expect(payload.engineerBacklogAutoClaim).toBe(false);
    });
  });

  describe("Number input clearing", () => {
    it("allows clearing maxConcurrent without leaving a stuck zero", async () => {
      renderModal();
      await waitFor(() => expect(mockFetchSettings).toHaveBeenCalled());

      // Open Scheduling section
      fireEvent.click(screen.getByText("Scheduling & Capacity"));

      const input = screen.getByLabelText("Max Concurrent Tasks") as HTMLInputElement;
      expect(input).toBeDefined();

      // Clear the input - the input should be empty, not show "0"
      await userEvent.clear(input);
      expect(input.value).toBe("");
    });

    it("allows clearing globalMaxConcurrent without leaving a stuck zero", async () => {
      renderModal();
      await waitFor(() => expect(mockFetchSettings).toHaveBeenCalled());

      // Open Scheduling section
      fireEvent.click(screen.getByText("Scheduling & Capacity"));

      const input = screen.getByLabelText("Global Max Concurrent") as HTMLInputElement;
      expect(input).toBeDefined();

      // Clear the input - the input should be empty, not show "0"
      await userEvent.clear(input);
      expect(input.value).toBe("");
    });

    it("allows clearing pollIntervalMs without leaving a stuck zero", async () => {
      renderModal();
      await waitFor(() => expect(mockFetchSettings).toHaveBeenCalled());

      // Open Scheduling section
      fireEvent.click(screen.getByText("Scheduling & Capacity"));

      const input = screen.getByLabelText("Poll Interval (ms)") as HTMLInputElement;
      expect(input).toBeDefined();

      // Clear the input - the input should be empty, not show "0"
      await userEvent.clear(input);
      expect(input.value).toBe("");
    });

    it("allows configuring stale high fan-out escalation threshold in hours", async () => {
      renderModal();
      await waitFor(() => expect(mockFetchSettings).toHaveBeenCalled());

      fireEvent.click(screen.getByText("Scheduling & Capacity"));

      const input = screen.getByLabelText("Stale High Fan-out Escalation (hours)") as HTMLInputElement;
      expect(input).toBeDefined();
      await userEvent.clear(input);
      await userEvent.type(input, "3");
      expect(input.value).toBe("3");
    });

    it("includes worktreesDir in save payload", async () => {
      renderModal();
      await waitFor(() => expect(mockFetchSettings).toHaveBeenCalled());

      fireEvent.click(screen.getByText("Worktrees"));
      const input = screen.getByLabelText("Worktrees Directory") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "~/.fn-worktrees/{repo}" } });

      await userEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => expect(mockUpdateSettings).toHaveBeenCalled());
      const payload = mockUpdateSettings.mock.calls[0][0] as Record<string, unknown>;
      expect(payload.worktreesDir).toBe("~/.fn-worktrees/{repo}");
    });

    it("allows clearing maxWorktrees without leaving a stuck zero", async () => {      renderModal();
      await waitFor(() => expect(mockFetchSettings).toHaveBeenCalled());

      // Open Worktrees section
      fireEvent.click(screen.getByText("Worktrees"));

      const input = screen.getByLabelText("Max Worktrees") as HTMLInputElement;
      expect(input).toBeDefined();

      // Clear the input - the input should be empty, not show "0"
      await userEvent.clear(input);
      expect(input.value).toBe("");
    });
  });

  describe("Worktrunk integration", () => {
    it("renders worktrunk controls in the Worktrees section only", async () => {
      renderModal();
      await waitForSettingsModalReady();

      expect(screen.queryByLabelText("Enable worktrunk integration")).not.toBeInTheDocument();

      await userEvent.click(screen.getByText("Worktrees"));

      expect(screen.getByRole("heading", { name: "Worktrunk integration" })).toBeInTheDocument();
      expect(screen.getByLabelText("Enable worktrunk integration")).toBeInTheDocument();
      expect(screen.getByLabelText("Worktrunk binary path")).toBeInTheDocument();
      expect(screen.getByLabelText("Worktrunk failure behavior")).toBeInTheDocument();
    });

    it("renders install affordance between enable toggle and binary path controls", async () => {
      mockUseWorktrunkInstallStatus.mockReturnValue({
        status: "missing",
        requestInstall: vi.fn(),
        requesting: false,
        version: undefined,
        installPath: undefined,
        pendingApprovalId: undefined,
        error: undefined,
      });

      renderModal({ initialSection: "worktrees" });
      await waitForSettingsModalReady();

      const enabledToggle = screen.getByLabelText("Enable worktrunk integration");
      const installAffordance = screen.getByTestId("worktrunk-install-affordance");
      const binaryPathInput = screen.getByLabelText("Worktrunk binary path");

      const enableGroup = enabledToggle.closest(".form-group");
      const binaryPathGroup = binaryPathInput.closest(".form-group");

      expect(enableGroup).not.toBeNull();
      expect(binaryPathGroup).not.toBeNull();

      expect(enableGroup!.compareDocumentPosition(installAffordance) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(installAffordance.compareDocumentPosition(binaryPathGroup!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("toggles disabled states and shows the worktreesDir precedence hint", async () => {
      mockUseWorktrunkInstallStatus.mockReturnValue({
        status: "installed",
        requestInstall: vi.fn(),
        requesting: false,
        version: "v1.2.3",
        installPath: "~/.fusion/bin/worktrunk",
        pendingApprovalId: undefined,
        error: undefined,
      });

      renderModal();
      await waitForSettingsModalReady();
      await userEvent.click(screen.getByText("Worktrees"));

      const enabledToggle = screen.getByLabelText("Enable worktrunk integration") as HTMLInputElement;
      const binaryPathInput = screen.getByLabelText("Worktrunk binary path") as HTMLInputElement;
      const onFailureSelect = screen.getByLabelText("Worktrunk failure behavior") as HTMLSelectElement;
      const worktreesDirInput = screen.getByLabelText("Worktrees Directory") as HTMLInputElement;
      const browseButton = screen.getByRole("button", { name: "Browse worktrees directory" });

      expect(enabledToggle.checked).toBe(false);
      expect(binaryPathInput).toBeDisabled();
      expect(onFailureSelect).toBeDisabled();
      expect(worktreesDirInput).not.toBeDisabled();
      expect(browseButton).not.toBeDisabled();

      await userEvent.click(enabledToggle);

      expect(binaryPathInput).not.toBeDisabled();
      expect(onFailureSelect).not.toBeDisabled();
      expect(worktreesDirInput).toBeDisabled();
      expect(browseButton).toBeDisabled();
      expect(screen.getByText(/Disabled because Worktrunk integration is enabled/i)).toBeInTheDocument();
    });

    it.each([
      { status: "missing", button: "Install worktrunk binary", action: "request" },
      { status: "pending-approval", button: "Open Approvals", action: "open" },
      { status: "denied", button: "Try again", action: "request" },
      { status: "installed", text: "installed at" },
    ])("renders install affordance state %#", async (scenario) => {
      const requestInstall = vi.fn();
      const onOpenApprovals = vi.fn();
      mockUseWorktrunkInstallStatus.mockReturnValue({
        status: scenario.status,
        requestInstall,
        requesting: false,
        version: "v1.2.3",
        installPath: "~/.fusion/bin/worktrunk",
        pendingApprovalId: "apr-1",
        error: "Denied",
      });

      renderModal({ initialSection: "worktrees", onOpenApprovals });
      await waitForSettingsModalReady();

      if (scenario.text) {
        expect(screen.getByText(/installed at/i)).toBeInTheDocument();
        return;
      }

      const button = screen.getByRole("button", { name: scenario.button });
      await userEvent.click(button);

      if (scenario.action === "request") {
        expect(requestInstall).toHaveBeenCalledTimes(1);
      } else {
        expect(onOpenApprovals).toHaveBeenCalledWith("apr-1");
      }
    });

    it.each(["missing", "installing", "pending-approval", "denied", "failed", "installed"])(
      "gates worktrunk toggle enablement by install status (%s)",
      async (status) => {
        mockUseWorktrunkInstallStatus.mockReturnValue({
          status,
          requestInstall: vi.fn(),
          requesting: false,
          version: undefined,
          installPath: undefined,
          pendingApprovalId: undefined,
          error: status === "denied" || status === "failed" ? "Denied" : undefined,
        });

        renderModal({ initialSection: "worktrees" });
        await waitForSettingsModalReady();

        const enabledToggle = screen.getByLabelText("Enable worktrunk integration") as HTMLInputElement;
        expect(enabledToggle.disabled).toBe(status !== "installed");

        if (status !== "installed") {
          expect(screen.getByText("Install the worktrunk binary below to enable this integration.")).toBeInTheDocument();
        } else {
          expect(screen.queryByText("Install the worktrunk binary below to enable this integration.")).not.toBeInTheDocument();
        }
      },
    );

    it("keeps toggle enabled for recovery when worktrunk is already enabled but install is missing", async () => {
      mockFetchSettings.mockResolvedValue({
        ...defaultSettings,
        worktrunk: {
          enabled: true,
          onFailure: "fail",
        },
      });
      mockFetchSettingsByScope.mockResolvedValue({
        global: {},
        project: {
          worktrunk: {
            enabled: true,
            onFailure: "fail",
          },
        },
      });
      mockUseWorktrunkInstallStatus.mockReturnValue({
        status: "missing",
        requestInstall: vi.fn(),
        requesting: false,
        version: undefined,
        installPath: undefined,
        pendingApprovalId: undefined,
        error: undefined,
      });

      renderModal({ initialSection: "worktrees" });
      await waitForSettingsModalReady();

      const enabledToggle = screen.getByLabelText("Enable worktrunk integration") as HTMLInputElement;
      expect(enabledToggle.disabled).toBe(false);
    });

    it("clamps worktrunk enabled to false on save when install is not verified", async () => {
      mockFetchSettings.mockResolvedValue({
        ...defaultSettings,
        worktrunk: {
          enabled: true,
          onFailure: "fail",
        },
      });
      mockFetchSettingsByScope.mockResolvedValue({
        global: {},
        project: {
          worktrunk: {
            enabled: true,
            onFailure: "fail",
          },
        },
      });
      mockUseWorktrunkInstallStatus.mockReturnValue({
        status: "missing",
        requestInstall: vi.fn(),
        requesting: false,
        version: undefined,
        installPath: undefined,
        pendingApprovalId: undefined,
        error: undefined,
      });

      renderModal({ initialSection: "worktrees" });
      await waitForSettingsModalReady();
      await userEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => expect(mockUpdateSettings).toHaveBeenCalled());
      const payload = mockUpdateSettings.mock.calls[0][0] as {
        worktrunk?: { enabled?: boolean };
      };
      expect(payload.worktrunk?.enabled).toBe(false);
    });

    it.each(["fail", "fallback-native"])("saves worktrunk payload and defaults onFailure on first enable (%s)", async (onFailure) => {
      mockUseWorktrunkInstallStatus.mockReturnValue({
        status: "installed",
        requestInstall: vi.fn(),
        requesting: false,
        version: "v1.2.3",
        installPath: "~/.fusion/bin/worktrunk",
        pendingApprovalId: undefined,
        error: undefined,
      });
      renderModal();
      await waitForSettingsModalReady();
      await userEvent.click(screen.getByText("Worktrees"));

      const enabledToggle = screen.getByLabelText("Enable worktrunk integration");
      await userEvent.click(enabledToggle);

      const onFailureSelect = screen.getByLabelText("Worktrunk failure behavior") as HTMLSelectElement;
      if (onFailure !== "fail") {
        await userEvent.selectOptions(onFailureSelect, onFailure);
      }

      await userEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => expect(mockUpdateSettings).toHaveBeenCalled());
      const payload = mockUpdateSettings.mock.calls[0][0] as {
        worktrunk?: { enabled?: boolean; onFailure?: string; binaryPath?: string };
      };
      expect(payload.worktrunk).toMatchObject({ enabled: true, onFailure });
    });
  });

  describe("Memory section", () => {
    it("renders the Memory section in the sidebar", async () => {
      renderModal();

      await waitFor(() => {
        expect(mockFetchSettings).toHaveBeenCalled();
      });

      expect(await screen.findByText("Memory")).toBeDefined();
    });

    describe("with default Memory render", () => {
      beforeEach(async () => {
        renderModal({ initialSection: "memory" });
        await screen.findByRole("checkbox", { name: /enable memory tools/i });
      });

      it("shows the memory toggle with default enabled", () => {
        const checkbox = screen.getByRole("checkbox", { name: /enable memory tools/i });
        expect(checkbox).toBeDefined();
        expect(checkbox).toBeChecked();
      });

      it("toggles the memory setting when checkbox is clicked", async () => {
        const checkbox = screen.getByRole("checkbox", { name: /enable memory tools/i });
        expect(checkbox).toBeChecked();

        await userEvent.click(checkbox);
        expect(checkbox).not.toBeChecked();

        await userEvent.click(checkbox);
        expect(checkbox).toBeChecked();
      });

      it("loads and shows memory editor content when navigating to Memory", async () => {
        await waitFor(() => {
          expect(mockFetchMemoryFiles).toHaveBeenCalledWith(undefined);
          expect(mockFetchMemoryFile).toHaveBeenCalledWith(".fusion/memory/DREAMS.md", undefined);
        });

        await screen.findByLabelText("Editor for .fusion/memory/DREAMS.md");
        expect(getMemoryEditorView(".fusion/memory/DREAMS.md").state.doc.toString()).toContain("Existing dreams");
      });
    });

    it("shows memory toggle unchecked when memoryEnabled is false", async () => {
      mockFetchSettings.mockResolvedValue({
        ...defaultSettings,
        memoryEnabled: false,
      });

      renderModal();

      await waitFor(() => {
        expect(mockFetchSettings).toHaveBeenCalled();
      });

      // Click the Memory section in the sidebar
      await userEvent.click(await screen.findByText("Memory"));

      const checkbox = screen.getByRole("checkbox", { name: /enable memory tools/i });
      expect(checkbox).toBeDefined();
      expect(checkbox).not.toBeChecked();
    });

    it("truncates long memory file option labels to keep native dropdown width bounded", async () => {
      mockFetchMemoryFiles.mockResolvedValue({
        files: [
          {
            path: ".fusion/memory/very/deep/path/that/keeps/growing/until/the/browser/native/select/dropdown/can-overflow-on-the-right-edge.md",
            label: "Long-term memory",
            layer: "long-term",
            size: 42,
            updatedAt: "2026-04-17T12:00:00.000Z",
          },
        ],
      });

      renderModal();

      await waitFor(() => {
        expect(mockFetchSettings).toHaveBeenCalled();
      });
      await userEvent.click(await screen.findByText("Memory"));

      const option = await screen.findByRole("option", { name: /Long-term memory/ });
      expect(option.textContent).toContain("…");
      expect(option.textContent).not.toContain("dropdown/can-overflow-on-the-right-edge.md");
    });

    it("shows only loading copy while backend status is unresolved", async () => {
      mockUseMemoryBackendStatus.mockReturnValue({
        // Simulate stale negative payload while a refresh is still in-flight.
        status: {
          currentBackend: "readonly",
          capabilities: {
            readable: true,
            writable: false,
            supportsAtomicWrite: false,
            hasConflictResolution: false,
            persistent: true,
          },
          availableBackends: ["file", "readonly", "qmd"],
          qmdAvailable: false,
          qmdInstallCommand: "bun install -g @tobilu/qmd",
        },
        currentBackend: "readonly",
        capabilities: {
          readable: true,
          writable: false,
          supportsAtomicWrite: false,
          hasConflictResolution: false,
          persistent: true,
        },
        availableBackends: ["file", "readonly", "qmd"],
        loading: true,
        error: null,
        refresh: vi.fn(),
      });

      renderModal();

      await waitFor(() => {
        expect(mockFetchSettings).toHaveBeenCalled();
      });
      await userEvent.click(await screen.findByText("Memory"));

      expect(screen.getByText("Checking memory write access...")).toBeInTheDocument();
      expect(screen.queryByText(/qmd is not installed\. Search will use local files\./i)).not.toBeInTheDocument();
      expect(screen.queryByText(/Memory is configured with a read-only backend\./i)).not.toBeInTheDocument();
    });

    it("shows read-only warning after backend resolves as non-writable", async () => {
      mockUseMemoryBackendStatus.mockReturnValue({
        status: {
          currentBackend: "readonly",
          capabilities: {
            readable: true,
            writable: false,
            supportsAtomicWrite: false,
            hasConflictResolution: false,
            persistent: true,
          },
          availableBackends: ["file", "readonly", "qmd"],
          qmdAvailable: true,
          qmdInstallCommand: "bun install -g @tobilu/qmd",
        },
        currentBackend: "readonly",
        capabilities: {
          readable: true,
          writable: false,
          supportsAtomicWrite: false,
          hasConflictResolution: false,
          persistent: true,
        },
        availableBackends: ["file", "readonly", "qmd"],
        loading: false,
        error: null,
        refresh: vi.fn(),
      });

      renderModal();

      await waitFor(() => {
        expect(mockFetchSettings).toHaveBeenCalled();
      });
      await userEvent.click(await screen.findByText("Memory"));

      expect(screen.getByText(/Memory is configured with a read-only backend\./i)).toBeInTheDocument();
    });

    it("installs qmd from the missing qmd prompt", async () => {
      const addToast = vi.fn();
      const refresh = vi.fn(() => Promise.resolve());
      mockUseMemoryBackendStatus.mockReturnValue({
        status: {
          currentBackend: "qmd",
          capabilities: {
            readable: true,
            writable: true,
            supportsAtomicWrite: false,
            hasConflictResolution: false,
            persistent: true,
          },
          availableBackends: ["file", "readonly", "qmd"],
          qmdAvailable: false,
          qmdInstallCommand: "bun install -g @tobilu/qmd",
        },
        currentBackend: "qmd",
        capabilities: {
          readable: true,
          writable: true,
          supportsAtomicWrite: false,
          hasConflictResolution: false,
          persistent: true,
        },
        availableBackends: ["file", "readonly", "qmd"],
        loading: false,
        error: null,
        refresh,
      });

      renderModal({ addToast });

      await waitFor(() => {
        expect(mockFetchSettings).toHaveBeenCalled();
      });
      await userEvent.click(await screen.findByText("Memory"));

      await userEvent.click(await screen.findByRole("button", { name: "Install qmd" }));

      await waitFor(() => {
        expect(mockInstallQmd).toHaveBeenCalledWith(undefined);
      });
      expect(refresh).toHaveBeenCalled();
      expect(addToast).toHaveBeenCalledWith("qmd installed successfully", "success");
    });

    const getMemoryEditorView = (path: string) => {
      const host = screen.getByLabelText(`Editor for ${path}`);
      const root = host.querySelector(".cm-editor") as HTMLElement | null;
      if (!root) throw new Error(`Expected CodeMirror root for ${path}`);
      const view = EditorView.findFromDOM(root);
      if (!view) throw new Error(`Expected EditorView for ${path}`);
      return view;
    };

    it("shows loading state while memory is being fetched", async () => {
      let resolveMemory: ((value: { content: string }) => void) | undefined;
      mockFetchMemoryFile.mockReturnValueOnce(
        new Promise<{ content: string }>((resolve) => {
          resolveMemory = resolve;
        })
      );

      renderModal();

      await waitFor(() => {
        expect(mockFetchSettings).toHaveBeenCalled();
      });

      await userEvent.click(await screen.findByText("Memory"));

      expect(screen.getByText("Loading memory…")).toBeDefined();

      resolveMemory?.({ content: "# Loaded" });

      expect(await screen.findByLabelText("Editor for .fusion/memory/DREAMS.md")).toBeDefined();
    });

    it("supports editing and saving memory content", async () => {
      const addToast = vi.fn();
      renderModal({ addToast });

      await waitFor(() => {
        expect(mockFetchSettings).toHaveBeenCalled();
      });

      await userEvent.click(await screen.findByText("Memory"));

      await waitFor(() => {
        expect(mockFetchMemoryFile).toHaveBeenCalledWith(".fusion/memory/DREAMS.md", undefined);
      });

      const select = await screen.findByLabelText("Memory File");
      await userEvent.selectOptions(select, ".fusion/memory/MEMORY.md");

      await screen.findByLabelText("Editor for .fusion/memory/MEMORY.md");
      const view = getMemoryEditorView(".fusion/memory/MEMORY.md");
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "# Updated memory\n- Reusable learning" } });

      const saveButton = await screen.findByRole("button", { name: "Save Memory" });
      await userEvent.click(saveButton);

      await waitFor(() => {
        expect(mockSaveMemoryFile).toHaveBeenCalledWith(
          ".fusion/memory/MEMORY.md",
          "# Updated memory\n- Reusable learning",
          undefined,
        );
      });
      expect(addToast).toHaveBeenCalledWith("Memory saved", "success");
    });

    it("compacts the selected memory file in the editor", async () => {
      const addToast = vi.fn();
      renderModal({ addToast });

      await waitFor(() => {
        expect(mockFetchSettings).toHaveBeenCalled();
      });

      await userEvent.click(await screen.findByText("Memory"));

      const compactButton = await screen.findByRole("button", { name: "Compact Selected File" });
      await userEvent.click(compactButton);

      await waitFor(() => {
        expect(mockCompactMemory).toHaveBeenCalledWith(".fusion/memory/DREAMS.md", undefined);
      });

      await screen.findByLabelText("Editor for .fusion/memory/DREAMS.md");
      expect(getMemoryEditorView(".fusion/memory/DREAMS.md").state.doc.toString()).toContain("Compacted Memory");
      expect(addToast).toHaveBeenCalledWith("Memory file compacted", "success");
    });

    it("handles empty memory content from API", async () => {
      mockFetchMemoryFile.mockResolvedValueOnce({ path: ".fusion/memory/DREAMS.md", content: "" });
      renderModal();

      await waitFor(() => {
        expect(mockFetchSettings).toHaveBeenCalled();
      });

      await userEvent.click(await screen.findByText("Memory"));

      await screen.findByLabelText("Editor for .fusion/memory/DREAMS.md");
      expect(getMemoryEditorView(".fusion/memory/DREAMS.md").state.doc.toString()).toBe("");
    });

    it("switches between memory files in the editor", async () => {
      mockFetchMemoryFile.mockImplementation((path: string) =>
        Promise.resolve({
          path,
          content: path.endsWith("DREAMS.md") ? "# Dreams\n\n- Pattern" : "# Memory\n\n- Durable",
        }),
      );

      renderModal();

      await waitFor(() => {
        expect(mockFetchSettings).toHaveBeenCalled();
      });

      await userEvent.click(await screen.findByText("Memory"));

      const select = await screen.findByLabelText("Memory File");
      await userEvent.selectOptions(select, ".fusion/memory/DREAMS.md");

      await waitFor(() => {
        expect(mockFetchMemoryFile).toHaveBeenCalledWith(".fusion/memory/DREAMS.md", undefined);
      });

      await screen.findByLabelText("Editor for .fusion/memory/DREAMS.md");
      expect(getMemoryEditorView(".fusion/memory/DREAMS.md").state.doc.toString()).toContain("Dreams");
    });
  });

  describe("Merge section", () => {
    describe("with default Merge render", () => {
      beforeEach(async () => {
        renderModal({ initialSection: "merge" });
        await screen.findByRole("checkbox", { name: /push to remote after merge/i });
      });

      it("shows push-after-merge toggle and keeps Push Remote hidden by default", () => {
        const pushAfterMergeToggle = screen.getByRole("checkbox", {
          name: /push to remote after merge/i,
        });
        expect(pushAfterMergeToggle).not.toBeChecked();
        expect(screen.queryByLabelText("Push Remote")).not.toBeInTheDocument();
      });

      it("merge option descriptions are hidden behind disclosure by default", () => {
        const autoMergeDescription = screen.getByText(/When enabled, tasks that pass review are automatically merged/i);
        const disclosure = autoMergeDescription.closest("details");

        expect(disclosure).not.toBeNull();
        expect(disclosure).not.toHaveAttribute("open");
        expect(autoMergeDescription).not.toBeVisible();
      });

      it("merge option descriptions are revealed when clicking More details", async () => {
        const moreDetailsSummaries = screen.getAllByText("More details");
        await userEvent.click(moreDetailsSummaries[0]);

        expect(screen.getByText(/When enabled, tasks that pass review are automatically merged/i)).toBeVisible();
      });

      it("no longer renders the moved workflow revision fork checkbox", () => {
        // workflowRevisionForkOnScopeMismatch was hard-moved (U4) onto workflow
        // settings; the Merge section must not expose it anymore.
        expect(
          screen.queryByRole("checkbox", {
            name: /fork scope-mismatched workflow revisions into follow-up tasks/i,
          }),
        ).not.toBeInTheDocument();
      });

      it("renders a redirect stub for the moved review/verification settings", () => {
        expect(
          screen.getByText(/Review, verification auto-fix, and scope-enforcement settings now live on the workflow/i),
        ).toBeInTheDocument();
      });

      it("shows Push Remote input when push-after-merge is enabled", async () => {
        await userEvent.click(
          screen.getByRole("checkbox", { name: /push to remote after merge/i }),
        );

        expect(screen.getByLabelText("Push Remote")).toBeInTheDocument();
        expect(screen.getByPlaceholderText("origin")).toBeInTheDocument();
      });

      it("includes pushAfterMerge and pushRemote in the save payload", async () => {
        await userEvent.click(
          screen.getByRole("checkbox", { name: /push to remote after merge/i }),
        );

        const pushRemoteInput = screen.getByLabelText("Push Remote");
        await userEvent.clear(pushRemoteInput);
        await userEvent.type(pushRemoteInput, "upstream main");

        await userEvent.click(screen.getByText("Save"));

        await waitFor(() => {
          expect(mockUpdateSettings).toHaveBeenCalledTimes(1);
        });

        const payload = mockUpdateSettings.mock.calls[0][0];
        expect(payload.pushAfterMerge).toBe(true);
        expect(payload.pushRemote).toBe("upstream main");
      });
    });

    describe("verificationFixRetries (moved to workflow settings)", () => {
      // verificationFixRetries was hard-moved (U4) onto workflow settings. The
      // Merge section must not expose it anymore — neither input nor save path.
      it("no longer renders the verification auto-fix retries input", async () => {
        renderModal({ initialSection: "merge" });
        await waitForSettingsModalReady();

        expect(screen.queryByLabelText("Verification auto-fix retries")).not.toBeInTheDocument();
      });

      it("never sends verificationFixRetries through the save payload", async () => {
        renderModal({ initialSection: "merge" });
        await waitForSettingsModalReady();

        await userEvent.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => {
          expect(mockUpdateSettings).toHaveBeenCalled();
        });

        const payload = mockUpdateSettings.mock.calls[0][0] as Record<string, unknown>;
        expect(payload).not.toHaveProperty("verificationFixRetries");
      });

      it("opens workflow settings from the redirect stub", async () => {
        const onOpenWorkflowSettings = vi.fn();
        renderModal({ initialSection: "merge", onOpenWorkflowSettings });
        await waitForSettingsModalReady();

        const buttons = screen.getAllByRole("button", { name: "Open workflow settings" });
        await userEvent.click(buttons[0]);
        expect(onOpenWorkflowSettings).toHaveBeenCalled();
      });
    });

    it("keeps GitHub tracking controls out of Merge and preserves GitHub authentication controls", async () => {
      renderModal({ initialSection: "merge" });
      await waitForSettingsModalReady();

      expect(screen.queryByLabelText("Default tracking mode for new tasks")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Project default tracking repo")).not.toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "GitHub Authentication" })).toBeInTheDocument();

      const authModeSelect = screen.getByLabelText("GitHub auth mode") as HTMLSelectElement;
      expect(authModeSelect.value).toBe("gh-cli");
      expect(screen.queryByLabelText("GitHub personal access token")).not.toBeInTheDocument();

      await userEvent.selectOptions(authModeSelect, "token");
      await userEvent.type(screen.getByLabelText("GitHub personal access token"), "ghp_test_token");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalled();
      });

      const payload = mockUpdateSettings.mock.calls[0][0] as Record<string, unknown>;
      expect(payload.githubAuthMode).toBe("token");
      expect(payload.githubAuthToken).toBe("ghp_test_token");
    });
  });

  describe("Experimental Features section", () => {
    const openExperimentalFeaturesSection = async () => {
      const sectionLabel = await screen.findByText("Experimental Features");
      await userEvent.click(sectionLabel);
    };

    it("renders the Experimental Features section in the sidebar", async () => {
      renderModal();

      expect(await screen.findByText("Experimental Features")).toBeInTheDocument();
    });

    // Read-only feature-list assertions share one render + section open.
    // All pure label-presence checks are asserted against a single rendered
    // instance to avoid re-rendering the full modal per feature.
    it("shows known features and the full experimental feature list with a single Dev Server toggle", async () => {
      renderModal();
      await openExperimentalFeaturesSection();

      // Known features are always shown even with no custom features configured.
      expect(screen.getByText("Insights")).toBeInTheDocument();
      expect(screen.getByText("Roadmaps")).toBeInTheDocument();

      for (const featureLabel of [
        "Research View",
        "Evals View",
        "Chat Rooms",
        "Sandbox (command isolation)",
        "Planning-style Agent Onboarding",
      ]) {
        expect(screen.getByLabelText(featureLabel)).toBeInTheDocument();
      }

      // Dev Server has a single canonical toggle (no legacy duplicate).
      expect(screen.getAllByLabelText("Dev Server")).toHaveLength(1);
    });

    it("does not render duplicate Dev Server rows when legacy and canonical keys are both present", async () => {
      mockFetchSettings.mockResolvedValue({
        ...defaultSettings,
        experimentalFeatures: { devServer: true, devServerView: true },
      });

      renderModal();

      await openExperimentalFeaturesSection();

      const devServerToggles = screen.getAllByLabelText("Dev Server");
      expect(devServerToggles).toHaveLength(1);
      expect(devServerToggles[0]).toBeChecked();
    });

    describe("section visibility behind experimental flags", () => {
      it("hides Remote Access nav item when experimentalFeatures.remoteAccess is falsy", async () => {
        mockFetchSettings.mockResolvedValue({
          ...defaultSettings,
          experimentalFeatures: {},
        });

        renderModal();
        await waitForSettingsModalReady();

        expect(screen.queryByRole("button", { name: /Remote Access/i })).not.toBeInTheDocument();
      });

      it("shows Remote Access nav item when experimentalFeatures.remoteAccess is true", async () => {
        mockFetchSettings.mockResolvedValue({
          ...defaultSettings,
          experimentalFeatures: { remoteAccess: true },
        });

        renderModal();

        expect(await screen.findByRole("button", { name: /Remote Access/i })).toBeInTheDocument();
      });

      it("shows Remote Access in KNOWN_EXPERIMENTAL_FEATURES toggle list", async () => {
        mockFetchSettings.mockResolvedValue({
          ...defaultSettings,
          experimentalFeatures: {},
        });

        renderModal();

        await openExperimentalFeaturesSection();

        expect(screen.getByLabelText("Remote Access")).toBeInTheDocument();
      });

      it("falls back to the first selectable section when opening remote while remoteAccess is disabled", async () => {
        mockFetchSettings.mockResolvedValue({
          ...defaultSettings,
          experimentalFeatures: {},
        });

        renderModal({ initialSection: "remote" });
        await waitForSettingsModalReady();

        expect(screen.queryByRole("button", { name: /Remote Access/i })).not.toBeInTheDocument();
        expect(screen.getByRole("heading", { name: "General" })).toBeInTheDocument();
      });

      it("hides research settings nav items when experimentalFeatures.researchView is disabled", async () => {
        mockFetchSettings.mockResolvedValue({
          ...defaultSettings,
          experimentalFeatures: {},
        });

        renderModal();
        await waitForSettingsModalReady();

        expect(screen.queryByRole("button", { name: /Research Defaults/i })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /^Research$/i })).not.toBeInTheDocument();
      });

      it("shows research settings nav items when experimentalFeatures.researchView is enabled", async () => {
        mockFetchSettings.mockResolvedValue({
          ...defaultSettings,
          experimentalFeatures: { researchView: true },
        });

        renderModal();
        await waitForSettingsModalReady();

        expect(screen.getByRole("button", { name: /Research Defaults/i })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /^Research$/i })).toBeInTheDocument();
      });

      it("falls back to the first selectable section when opening research settings while researchView is disabled", async () => {
        mockFetchSettings.mockResolvedValue({
          ...defaultSettings,
          experimentalFeatures: {},
        });

        renderModal({ initialSection: "research-global" });
        await waitForSettingsModalReady();

        expect(screen.queryByRole("button", { name: /Research Defaults/i })).not.toBeInTheDocument();
        expect(screen.getByRole("heading", { name: "General" })).toBeInTheDocument();
      });

      it("hides scheduled evals nav item when experimentalFeatures.evalsView is disabled", async () => {
        mockFetchSettings.mockResolvedValue({
          ...defaultSettings,
          experimentalFeatures: {},
        });

        renderModal();
        await waitForSettingsModalReady();

        expect(screen.queryByRole("button", { name: /Scheduled Evals/i })).not.toBeInTheDocument();
      });

      it("shows scheduled evals nav item when experimentalFeatures.evalsView is enabled", async () => {
        mockFetchSettings.mockResolvedValue({
          ...defaultSettings,
          experimentalFeatures: { evalsView: true },
        });

        renderModal();
        await waitForSettingsModalReady();

        expect(screen.getByRole("button", { name: /Scheduled Evals/i })).toBeInTheDocument();
      });

      it("falls back to the first selectable section when opening scheduled evals while evalsView is disabled", async () => {
        mockFetchSettings.mockResolvedValue({
          ...defaultSettings,
          experimentalFeatures: {},
        });

        renderModal({ initialSection: "scheduled-evals" });
        await waitForSettingsModalReady();

        expect(screen.queryByRole("button", { name: /Scheduled Evals/i })).not.toBeInTheDocument();
        expect(screen.getByRole("heading", { name: "General" })).toBeInTheDocument();
      });
    });

    it("sends canonical devServerView=false and devServer=null when disabling legacy dev server flag", async () => {
      mockFetchSettings.mockResolvedValue({
        ...defaultSettings,
        experimentalFeatures: { devServer: true },
      });

      renderModal();

      await openExperimentalFeaturesSection();

      const devServerToggle = screen.getByLabelText("Dev Server") as HTMLInputElement;
      expect(devServerToggle).toBeChecked();

      await userEvent.click(devServerToggle);
      expect(devServerToggle).not.toBeChecked();

      await userEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdateGlobalSettings).toHaveBeenCalledTimes(1);
      });

      const payload = mockUpdateGlobalSettings.mock.calls[0][0];
      expect(payload.experimentalFeatures).toEqual({ devServerView: false, devServer: null });
    });

    it("does not emit legacy alias null deletes when canonical key is absent", async () => {
      mockFetchSettings.mockResolvedValue({
        ...defaultSettings,
        experimentalFeatures: { insights: true },
      });

      renderModal();

      await openExperimentalFeaturesSection();

      await userEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdateGlobalSettings).toHaveBeenCalledTimes(1);
      });

      const payload = mockUpdateGlobalSettings.mock.calls[0][0];
      expect(payload.experimentalFeatures).toEqual({ insights: true });
      expect(payload.experimentalFeatures.devServer).toBeUndefined();
    });

    it("shows feature flags when experimentalFeatures is set", async () => {
      mockFetchSettings.mockResolvedValue({
        ...defaultSettings,
        experimentalFeatures: { "my-feature": true, "another-feature": false },
      });

      renderModal();

      await openExperimentalFeaturesSection();

      expect(screen.getByText("my-feature")).toBeInTheDocument();
      expect(screen.getByText("another-feature")).toBeInTheDocument();
    });

    it("feature flags are unchecked when value is false", async () => {
      mockFetchSettings.mockResolvedValue({
        ...defaultSettings,
        experimentalFeatures: { "my-feature": false },
      });

      renderModal();

      await openExperimentalFeaturesSection();

      const checkbox = screen.getByLabelText("my-feature") as HTMLInputElement;
      expect(checkbox.checked).toBe(false);
    });

    it("feature flags are checked when value is true", async () => {
      mockFetchSettings.mockResolvedValue({
        ...defaultSettings,
        experimentalFeatures: { "my-feature": true },
      });

      renderModal();

      await openExperimentalFeaturesSection();

      const checkbox = screen.getByLabelText("my-feature") as HTMLInputElement;
      expect(checkbox.checked).toBe(true);
    });

    it("toggling a feature flag updates the form state", async () => {
      mockFetchSettings.mockResolvedValue({
        ...defaultSettings,
        experimentalFeatures: { "my-feature": false },
      });

      renderModal();

      await openExperimentalFeaturesSection();

      const checkbox = screen.getByLabelText("my-feature") as HTMLInputElement;
      expect(checkbox.checked).toBe(false);

      // Toggle it
      await userEvent.click(checkbox);
      expect(checkbox.checked).toBe(true);
    });

    it("saving with toggled feature flag includes experimentalFeatures in payload", async () => {
      mockFetchSettings.mockResolvedValue({
        ...defaultSettings,
        experimentalFeatures: { "my-feature": false },
      });

      renderModal();

      await openExperimentalFeaturesSection();

      // Toggle the feature
      const checkbox = screen.getByLabelText("my-feature") as HTMLInputElement;
      await userEvent.click(checkbox);

      // Save
      await userEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdateGlobalSettings).toHaveBeenCalledTimes(1);
      });

      const payload = mockUpdateGlobalSettings.mock.calls[0][0];
      expect(payload.experimentalFeatures).toEqual({ "my-feature": true });
    });

    it("shows global scope banner in Experimental Features section", async () => {
      renderModal();

      await openExperimentalFeaturesSection();

      // Should show global scope indicator
      expect(screen.getByText(/shared across all your fusion projects/i)).toBeInTheDocument();
    });

    it("handles undefined experimentalFeatures (falls back to empty) but still shows known features", async () => {
      mockFetchSettings.mockResolvedValue({
        ...defaultSettings,
        experimentalFeatures: undefined,
      });

      renderModal();

      await openExperimentalFeaturesSection();

      // Known features should always be shown regardless of settings
      expect(screen.getByText("Insights")).toBeInTheDocument();
      expect(screen.getByText("Roadmaps")).toBeInTheDocument();
    });

    it("saves experimentalFeatures with multiple toggled flags", async () => {
      mockFetchSettings.mockResolvedValue({
        ...defaultSettings,
        experimentalFeatures: { "feature-a": true, "feature-b": false },
      });

      renderModal();

      await openExperimentalFeaturesSection();

      // Toggle feature-b to true
      const checkboxB = screen.getByLabelText("feature-b") as HTMLInputElement;
      await userEvent.click(checkboxB);

      // Save
      await userEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdateGlobalSettings).toHaveBeenCalledTimes(1);
      });

      const payload = mockUpdateGlobalSettings.mock.calls[0][0];
      expect(payload.experimentalFeatures).toEqual({ "feature-a": true, "feature-b": true });
    });

  });

  describe("Remote section", () => {
    let user: ReturnType<typeof userEvent.setup>;

    beforeEach(() => {
      user = userEvent.setup({ delay: null });
    });

    beforeEach(() => {
      mockFetchSettings.mockResolvedValue({
        ...defaultSettings,
        experimentalFeatures: { remoteAccess: true },
      });
    });

    const openRemoteSection = async () => {
      const [remoteSectionButton] = await screen.findAllByRole("button", { name: /Remote Access/i });
      await user.click(remoteSectionButton);
      await screen.findByRole("heading", { name: "Remote Access" });
    };

    const openAdvancedSettings = async () => {
      const summary = screen.getByText("Advanced Settings");
      await user.click(summary);
    };

    describe("with default Remote render", () => {
      beforeEach(async () => {
        renderModal();
        await waitForSettingsModalReady();
        await openRemoteSection();
      });

      it("shows provider-specific settings when provider selected and auto-saves on Start Tunnel", async () => {
        await user.click(screen.getByLabelText("Tailscale"));
        expect(screen.queryByLabelText("Hostname label")).not.toBeInTheDocument();
        expect(screen.queryByLabelText("Target port")).not.toBeInTheDocument();
        expect(screen.getByLabelText("Accept routes")).toBeInTheDocument();
        expect(screen.queryByLabelText("Tunnel name")).not.toBeInTheDocument();

        await user.click(screen.getByLabelText("Cloudflare"));
        expect(screen.queryByLabelText("Accept routes")).not.toBeInTheDocument();

        if (!screen.queryByLabelText("Tunnel name")) {
          const advancedDetails = screen.getByText(/Advanced \(Named Tunnel\)/i, { selector: "summary" }).closest("details") as HTMLDetailsElement;
          advancedDetails.open = true;
          fireEvent(advancedDetails, new Event("toggle"));
          expect(await screen.findByLabelText("Tunnel name")).toBeInTheDocument();
        }
        fireEvent.change(screen.getByLabelText("Tunnel name"), { target: { value: "cf-team" } });
        fireEvent.change(screen.getByLabelText("Tunnel token"), { target: { value: "cf_token" } });
        fireEvent.change(screen.getByLabelText("Ingress URL"), { target: { value: "https://remote.example.com" } });

        await user.click(screen.getByRole("button", { name: "Start Tunnel" }));

        await waitFor(() => {
          expect(mockUpdateRemoteSettings).toHaveBeenCalledWith(
            expect.objectContaining({
              remoteActiveProvider: "cloudflare",
              remoteCloudflareEnabled: true,
              remoteCloudflareQuickTunnel: false,
              remoteCloudflareTunnelName: "cf-team",
              remoteCloudflareTunnelToken: "cf_token",
              remoteCloudflareIngressUrl: "https://remote.example.com",
            }),
            undefined,
          );
        });
      });

      it("toggles Cloudflare named tunnel advanced section and persists quick tunnel state", async () => {
        await user.click(screen.getByLabelText("Cloudflare"));
        const namedTunnelSummary = screen.getByText(/Advanced \(Named Tunnel\)/i, { selector: "summary" });

        if (!screen.queryByLabelText("Tunnel name")) {
          await user.click(namedTunnelSummary);
        }
        expect(await screen.findByLabelText("Tunnel name")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Start Tunnel" }));
        await waitFor(() => {
          expect(mockUpdateRemoteSettings).toHaveBeenCalledWith(expect.objectContaining({ remoteCloudflareQuickTunnel: false }), undefined);
        });

        // Closing <details> is not consistently simulated in jsdom; verify default quick-tunnel state via a fresh render below.
      });

      it("renders branded Cloudflare icon in Remote provider selector", () => {
        const cloudflareSlot = screen.getByTestId("remote-provider-icon-cloudflare");
        expect(within(cloudflareSlot).getByTestId("remote-cloudflare-option-icon")).toBeInTheDocument();
      });

      it("Start Tunnel button is disabled when no provider is selected", async () => {
        const startButton = screen.getByRole("button", { name: "Start Tunnel" });
        expect(startButton).toBeDisabled();
        await user.click(screen.getByLabelText("Tailscale"));
        expect(startButton).not.toBeDisabled();
      });

      it("no separate Activate Provider or Save Remote Settings buttons exist", () => {
        expect(screen.queryByRole("button", { name: /Activate Provider/i })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /Save Remote Settings/i })).not.toBeInTheDocument();
      });

      it("only the selected provider's settings are rendered", async () => {
        await user.click(screen.getByLabelText("Tailscale"));
        expect(screen.getByLabelText("Accept routes")).toBeInTheDocument();
        expect(screen.queryByText(/Advanced \(Named Tunnel\)/i)).not.toBeInTheDocument();

        await user.click(screen.getByLabelText("Cloudflare"));
        expect(screen.getByText(/Advanced \(Named Tunnel\)/i)).toBeInTheDocument();
        expect(screen.queryByLabelText("Accept routes")).not.toBeInTheDocument();
      });

      it("sets quick tunnel false when opening Cloudflare advanced details", async () => {
        await user.click(screen.getByLabelText("Cloudflare"));

        const namedTunnelSummary = screen.getByText(/Advanced \(Named Tunnel\)/i, { selector: "summary" });
        if (!screen.queryByLabelText("Tunnel name")) {
          await user.click(namedTunnelSummary);
        }
        await user.click(screen.getByRole("button", { name: "Start Tunnel" }));
        await waitFor(() => {
          expect(mockUpdateRemoteSettings).toHaveBeenCalledWith(expect.objectContaining({ remoteCloudflareQuickTunnel: false }), undefined);
        });
      });

      it("Start Tunnel auto-saves with enabled=true on selected provider before starting", async () => {
        await user.click(screen.getByLabelText("Tailscale"));
        await user.click(screen.getByRole("button", { name: "Start Tunnel" }));

        await waitFor(() => {
          expect(mockUpdateRemoteSettings).toHaveBeenCalledWith(
            expect.objectContaining({
              remoteActiveProvider: "tailscale",
              remoteTailscaleEnabled: true,
            }),
            undefined,
          );
        });
        expect(mockStartRemoteTunnel).toHaveBeenCalled();
      });
    });

    it("renders remote-status-bar with stopped state and omits share block when not running", async () => {
      mockFetchRemoteStatus.mockResolvedValue({ provider: null, state: "stopped", url: null, lastError: null });
      const { container } = renderModal();
      await waitForSettingsModalReady();
      await openRemoteSection();

      const statusBar = container.querySelector(".remote-status-bar");
      expect(statusBar).toBeInTheDocument();
      expect(statusBar?.className).toContain("remote-status-bar--stopped");
      expect(container.querySelector(".remote-share-block")).not.toBeInTheDocument();
    });

    it("renders remote-share-block when tunnel is running with a URL", async () => {
      mockFetchRemoteStatus.mockResolvedValue({ provider: "tailscale", state: "running", url: "https://machine.ts.net/", lastError: null });
      const { container } = renderModal();
      await waitForSettingsModalReady();
      await openRemoteSection();

      const statusBar = container.querySelector(".remote-status-bar");
      expect(statusBar).toBeInTheDocument();
      expect(statusBar?.className).toContain("remote-status-bar--running");
      expect(container.querySelector(".remote-share-block")).toBeInTheDocument();
    });

    it("updates provider selection via radio and shows provider status", async () => {
      mockFetchRemoteStatus
        .mockResolvedValueOnce({ provider: null, state: "stopped", url: null, lastError: null })
        .mockResolvedValueOnce({ provider: "tailscale", state: "running", url: "https://tail.example", lastError: null });

      renderModal();
      await waitForSettingsModalReady();
      await openRemoteSection();

      await user.click(screen.getByLabelText("Tailscale"));
      expect(screen.getByLabelText("Tailscale")).toBeChecked();

      await user.click(screen.getByRole("button", { name: "Start Tunnel" }));
      expect(await screen.findByText("https://tail.example", { selector: ".remote-status-url" })).toBeInTheDocument();
    });

    it("shows cloudflared available indicator when Cloudflare is selected and cloudflared is installed", async () => {
      mockFetchRemoteStatus.mockResolvedValue({ provider: "cloudflare", state: "stopped", url: null, lastError: null, cloudflaredAvailable: true });

      renderModal();
      await waitForSettingsModalReady();
      await openRemoteSection();
      await user.click(screen.getByLabelText("Cloudflare"));

      expect(await screen.findByText("cloudflared is installed")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Install cloudflared" })).not.toBeInTheDocument();
    });

    it("shows install button when Cloudflare is selected and cloudflared is not available", async () => {
      mockFetchRemoteStatus.mockResolvedValue({ provider: "cloudflare", state: "stopped", url: null, lastError: null, cloudflaredAvailable: false });

      renderModal();
      await waitForSettingsModalReady();
      await openRemoteSection();
      await user.click(screen.getByLabelText("Cloudflare"));

      expect(await screen.findByText("cloudflared is not installed")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Install cloudflared" })).toBeInTheDocument();
      expect(screen.getByText("cloudflared must be installed to start the tunnel")).toBeInTheDocument();
    });

    it("install button triggers install and refreshes status", async () => {
      const addToast = vi.fn();
      mockFetchRemoteStatus
        .mockResolvedValueOnce({ provider: "cloudflare", state: "stopped", url: null, lastError: null, cloudflaredAvailable: false })
        .mockResolvedValueOnce({ provider: "cloudflare", state: "stopped", url: null, lastError: null, cloudflaredAvailable: true });
      mockInstallCloudflared.mockResolvedValueOnce({ success: true, command: "brew install cloudflared" });

      renderModal({ addToast });
      await waitForSettingsModalReady();
      await openRemoteSection();
      await user.click(screen.getByLabelText("Cloudflare"));

      const installButton = await screen.findByRole("button", { name: "Install cloudflared" });
      await user.click(installButton);

      await waitFor(() => {
        expect(mockInstallCloudflared).toHaveBeenCalledWith(undefined);
      });
      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith("cloudflared installed successfully", "success");
      });
      expect(await screen.findByText("cloudflared is installed")).toBeInTheDocument();
    });

    it("install button shows error on failure", async () => {
      mockFetchRemoteStatus.mockResolvedValue({ provider: "cloudflare", state: "stopped", url: null, lastError: null, cloudflaredAvailable: false });
      mockInstallCloudflared.mockResolvedValueOnce({ success: false, command: "brew install cloudflared", error: "Command failed" });

      renderModal();
      await waitForSettingsModalReady();
      await openRemoteSection();
      await user.click(screen.getByLabelText("Cloudflare"));

      await user.click(await screen.findByRole("button", { name: "Install cloudflared" }));

      expect(await screen.findByText("Command failed")).toBeInTheDocument();
    });

    it("shows lifecycle state changes for start and stop actions, including error state", async () => {
      mockFetchRemoteStatus
        .mockResolvedValueOnce({ provider: null, state: "stopped", url: null, lastError: null })
        .mockResolvedValueOnce({ provider: "tailscale", state: "starting", url: null, lastError: null })
        .mockResolvedValueOnce({ provider: "tailscale", state: "running", url: "https://tail.example", lastError: null })
        .mockResolvedValueOnce({ provider: "tailscale", state: "error", url: null, lastError: "Tunnel crashed" });

      renderModal();
      await waitForSettingsModalReady();
      await openRemoteSection();

      await user.click(screen.getByLabelText("Tailscale"));
      expect(screen.getByRole("button", { name: "Start Tunnel" })).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Start Tunnel" }));
      await waitFor(() => {
        expect(mockUpdateRemoteSettings).toHaveBeenCalled();
        expect(mockStartRemoteTunnel).toHaveBeenCalledTimes(1);
      });
      expect(await screen.findByText("starting")).toBeInTheDocument();

      expect(await screen.findByRole("button", { name: "Stop Tunnel" })).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Stop Tunnel" }));
      await waitFor(() => {
        expect(mockStopRemoteTunnel).toHaveBeenCalledTimes(1);
      });
      await user.click(screen.getByRole("button", { name: "Stop Tunnel" }));
      await waitFor(() => {
        expect(mockStopRemoteTunnel).toHaveBeenCalledTimes(2);
      });
      expect(await screen.findByText("Tunnel crashed")).toBeInTheDocument();
    });

    it("shows external tunnel panel with actions when external tunnel is detected", async () => {
      mockFetchRemoteStatus.mockResolvedValue({
        provider: "tailscale",
        state: "stopped",
        url: null,
        lastError: null,
        externalTunnel: { provider: "tailscale", url: "https://machine.ts.net/" },
      });

      renderModal();
      await waitForSettingsModalReady();
      await openRemoteSection();

      expect(await screen.findByText("External tailscale tunnel detected")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Start Fresh" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Use Existing" })).toBeInTheDocument();
    });

    it("Start Fresh kills external tunnel before starting", async () => {
      mockFetchRemoteStatus.mockResolvedValue({
        provider: "tailscale",
        state: "stopped",
        url: null,
        lastError: null,
        externalTunnel: { provider: "tailscale", url: "https://machine.ts.net/" },
      });

      renderModal();
      await waitForSettingsModalReady();
      await openRemoteSection();
      await user.click(screen.getByLabelText("Tailscale"));

      await user.click(await screen.findByRole("button", { name: "Start Fresh" }));

      await waitFor(() => {
        expect(mockKillExternalTunnel).toHaveBeenCalledWith(undefined);
        expect(mockStartRemoteTunnel).toHaveBeenCalledWith(undefined);
      });
    });

    it("regenerates persistent token and surfaces success feedback without exposing raw token text", async () => {
      const addToast = vi.fn();
      renderModal({ addToast });
      await waitForSettingsModalReady();
      await openRemoteSection();
      await user.click(screen.getByLabelText("Tailscale"));
      await openAdvancedSettings();

      await user.click(screen.getByRole("button", { name: "Regenerate persistent token" }));

      await waitFor(() => {
        expect(mockRegenerateRemotePersistentToken).toHaveBeenCalledWith(undefined);
      });
      expect(addToast).toHaveBeenCalledWith("Persistent token regenerated", "success");
      expect(addToast.mock.calls.flat().join(" ")).not.toContain("frt_");
    });

    it("generates short-lived token using selected TTL and shows URL expiry affordances", async () => {
      const shortLivedExpiry = "2026-04-26T12:00:00.000Z";
      mockGenerateShortLivedRemoteToken.mockResolvedValueOnce({
        token: "frt_short",
        expiresAt: shortLivedExpiry,
        ttlMs: 120000,
      });
      mockFetchRemoteUrl.mockResolvedValueOnce({
        url: "https://remote.example.com/short",
        tokenType: "short-lived",
        expiresAt: shortLivedExpiry,
      });

      renderModal();
      await waitForSettingsModalReady();
      await openRemoteSection();
      await user.click(screen.getByLabelText("Tailscale"));
      await openAdvancedSettings();

      await user.selectOptions(screen.getByLabelText("Auth link token type"), "short-lived");
      const ttlInput = screen.getByLabelText("Short-lived TTL (ms)") as HTMLInputElement;
      fireEvent.change(ttlInput, { target: { value: "120000" } });

      await user.click(screen.getByRole("button", { name: "Generate short-lived token" }));
      await waitFor(() => {
        expect(mockGenerateShortLivedRemoteToken).toHaveBeenCalledWith(120000, undefined);
      });

      fireEvent.change(ttlInput, { target: { value: "120000" } });
      await user.click(screen.getByRole("button", { name: "Show URL" }));
      await waitFor(() => {
        expect(mockFetchRemoteUrl).toHaveBeenLastCalledWith({
          projectId: undefined,
          tokenType: "short-lived",
          ttlMs: 120000,
        });
      });
      expect(screen.getByText("https://remote.example.com/short")).toBeInTheDocument();
    });

    it("renders QR image when available and falls back to URL-only presentation when SVG data is absent", async () => {
      mockFetchRemoteQr
        .mockResolvedValueOnce({
          url: "https://remote.example.com/qr-image",
          tokenType: "persistent",
          expiresAt: null,
          format: "image/svg",
          data: "<svg></svg>",
        })
        .mockResolvedValueOnce({
          url: "https://remote.example.com/qr-text",
          tokenType: "persistent",
          expiresAt: null,
          format: "text",
        });

      renderModal();
      await waitForSettingsModalReady();
      await openRemoteSection();
      await user.click(screen.getByLabelText("Tailscale"));
      await openAdvancedSettings();

      await user.click(screen.getByRole("button", { name: "Generate QR" }));
      await waitFor(() => {
        expect(mockFetchRemoteQr).toHaveBeenNthCalledWith(1, "image/svg", expect.objectContaining({ tokenType: "persistent" }));
      });
      expect(await screen.findByRole("img", { name: "Remote access QR code" })).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Generate QR" }));
      await waitFor(() => {
        expect(screen.queryByRole("img", { name: "Remote access QR code" })).not.toBeInTheDocument();
      });
      expect(screen.getByText("https://remote.example.com/qr-text")).toBeInTheDocument();
    });

  });


  describe("Notifications provider cards", () => {
    let user: ReturnType<typeof userEvent.setup>;

    beforeEach(() => {
      user = userEvent.setup({ delay: null });
    });

    const openNotificationsSection = async () => {
      await user.click(await screen.findByRole("button", { name: /Notifications/ }));
    };

    describe("with default Notifications render", () => {
      beforeEach(async () => {
        renderModal({ initialSection: "notifications" });
        await screen.findByRole("heading", { name: "Notifications" });
      });

      it("shows ntfy and webhook provider cards in notifications section", () => {
        expect(screen.getByText("ntfy")).toBeInTheDocument();
        expect(screen.getByText("Webhook")).toBeInTheDocument();
      });

      it("renders failure mode controls and persists updated values", async () => {
        const modeSelect = screen.getByLabelText("Failure notification mode") as HTMLSelectElement;
        const delayInput = screen.getByLabelText("Failure notification delay (ms)") as HTMLInputElement;

        expect(modeSelect.value).toBe("sticky-only");
        expect(delayInput.value).toBe("30000");

        await user.selectOptions(modeSelect, "all");
        expect(delayInput).toBeDisabled();
        await user.selectOptions(modeSelect, "sticky-only");
        fireEvent.change(delayInput, { target: { value: "45000" } });
        await user.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => {
          expect(mockUpdateGlobalSettings).toHaveBeenCalledWith(
            expect.objectContaining({
              failureNotificationMode: "sticky-only",
              failureNotificationDelayMs: 45000,
            }),
          );
        });
      });

      it("persists terminal-only selection on save", async () => {
        const modeSelect = screen.getByLabelText("Failure notification mode") as HTMLSelectElement;
        await user.selectOptions(modeSelect, "terminal-only");
        await user.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => {
          expect(mockUpdateGlobalSettings).toHaveBeenCalledWith(
            expect.objectContaining({
              failureNotificationMode: "terminal-only",
            }),
          );
        });
      });

      it("calls testNotification with webhook provider ID when webhook test button clicked", async () => {
        await user.click(screen.getByLabelText("Webhook notifications"));
        fireEvent.change(screen.getByLabelText("Webhook URL"), { target: { value: "https://hooks.example.com/test" } });

        const webhookCard = screen.getByText("Webhook").closest(".notification-provider-card") as HTMLElement;
        await user.click(within(webhookCard).getByRole("button", { name: /Test notification/ }));

        await waitFor(() => {
          expect(mockTestNotification).toHaveBeenCalledWith(
            "webhook",
            expect.objectContaining({ webhookUrl: "https://hooks.example.com/test" }),
            undefined,
          );
        });
        expect(within(webhookCard).getByText("Test notification sent — check your webhook endpoint!")).toBeInTheDocument();
        expect(within(webhookCard).getByText("Test notification sent — check your webhook endpoint!").closest(".notification-test-feedback")).toHaveAttribute("aria-live", "polite");
      });
    });

    it("keeps delay enabled when failure mode is terminal-only", async () => {
      mockFetchSettings.mockResolvedValueOnce({
        ...defaultSettings,
        failureNotificationMode: "terminal-only",
      });
      renderModal();
      await waitForSettingsModalReady();
      await openNotificationsSection();

      const modeSelect = screen.getByLabelText("Failure notification mode") as HTMLSelectElement;
      const delayInput = screen.getByLabelText("Failure notification delay (ms)") as HTMLInputElement;

      expect(modeSelect.value).toBe("terminal-only");
      expect(delayInput).not.toBeDisabled();
    });

    it.each([
      {
        provider: "ntfy",
        initial: { ...defaultSettings, ntfyEnabled: true, ntfyTopic: "test-topic" },
        enable: async () => {},
        visibleLabel: "ntfy Topic",
        hiddenLabel: "Webhook URL",
      },
      {
        provider: "webhook",
        initial: defaultSettings,
        enable: async () => {
          await user.click(screen.getByLabelText("Webhook notifications"));
        },
        visibleLabel: "Webhook URL",
        hiddenLabel: "ntfy Topic",
      },
    ])("shows $provider fields when enabled and hides opposite provider fields", async ({ initial, enable, visibleLabel, hiddenLabel }) => {
      mockFetchSettings.mockResolvedValueOnce(initial);
      renderModal();
      await waitForSettingsModalReady();
      await openNotificationsSection();
      await enable();

      expect(screen.getByLabelText(visibleLabel)).toBeInTheDocument();
      expect(screen.queryByLabelText(hiddenLabel)).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Test notification/ })).toBeInTheDocument();
    });

    it("shows fallback, dreams, and mailbox/room message events for both providers", async () => {
      mockFetchSettings.mockResolvedValueOnce({
        ...defaultSettings,
        ntfyEnabled: true,
        ntfyTopic: "test-topic",
        ntfyEvents: [
          "in-review",
          "merged",
          "failed",
          "awaiting-approval",
          "awaiting-user-review",
          "planning-awaiting-input",
          "gridlock",
          "fallback-used",
          "memory-dreams-processed",
          "message:agent-to-user",
          "message:agent-to-agent",
          "message:room",
          "oauth-token-expired",
        ],
      });
      renderModal();
      await waitForSettingsModalReady();
      await openNotificationsSection();

      expect(screen.getByLabelText("Fallback model used (recovered)")).toBeInTheDocument();
      expect(screen.getByLabelText("Agent created a task")).toBeInTheDocument();
      expect(screen.getByLabelText("DREAMS.md entry added")).toBeInTheDocument();
      const taskCreatedNtfy = screen.getByLabelText("Agent created a task") as HTMLInputElement;
      const agentToUserNtfy = screen.getByLabelText("Agent → user message") as HTMLInputElement;
      const agentToAgentNtfy = screen.getByLabelText("Agent → agent message") as HTMLInputElement;
      const roomMessageNtfy = screen.getByLabelText("Agent message in room") as HTMLInputElement;
      expect(taskCreatedNtfy.checked).toBe(false);
      expect(agentToUserNtfy.checked).toBe(true);
      expect(agentToAgentNtfy.checked).toBe(true);
      expect(roomMessageNtfy.checked).toBe(true);

      await user.click(screen.getByLabelText("Webhook notifications"));
      expect(screen.getAllByLabelText("Fallback model used (recovered)").length).toBeGreaterThan(0);
      expect(screen.getAllByLabelText("Agent created a task").length).toBeGreaterThan(0);
      expect(screen.getAllByLabelText("DREAMS.md entry added").length).toBeGreaterThan(0);
      const [taskCreatedWebhook] = screen.getAllByLabelText("Agent created a task") as HTMLInputElement[];
      const [agentToUserWebhook] = screen.getAllByLabelText("Agent → user message") as HTMLInputElement[];
      const [agentToAgentWebhook] = screen.getAllByLabelText("Agent → agent message") as HTMLInputElement[];
      const [roomMessageWebhook] = screen.getAllByLabelText("Agent message in room") as HTMLInputElement[];
      expect(taskCreatedWebhook.checked).toBe(false);
      expect(agentToUserWebhook.checked).toBe(true);
      expect(agentToAgentWebhook.checked).toBe(true);
      expect(roomMessageWebhook.checked).toBe(true);
    });

    it("calls testNotification with ntfy provider ID when ntfy test button clicked", async () => {
      mockFetchSettings.mockResolvedValueOnce({ ...defaultSettings, ntfyEnabled: true, ntfyTopic: "test-topic" });
      renderModal();
      await waitForSettingsModalReady();
      await openNotificationsSection();
      await user.click(screen.getByText("Advanced"));
      fireEvent.change(screen.getByLabelText("Access token (optional)"), { target: { value: "secret-token" } });

      await user.click(screen.getByRole("button", { name: /Test notification/ }));

      await waitFor(() => {
        expect(mockTestNotification).toHaveBeenCalledWith(
          "ntfy",
          expect.objectContaining({
            ntfyEnabled: true,
            ntfyTopic: "test-topic",
            ntfyAccessToken: "secret-token",
          }),
          undefined,
        );
      });
    });

    it("clears a saved ntfy access token via global null-as-delete semantics", async () => {
      mockFetchSettings.mockResolvedValueOnce({
        ...defaultSettings,
        ntfyEnabled: true,
        ntfyTopic: "test-topic",
        ntfyAccessToken: "saved-token",
      });
      renderModal();
      await waitForSettingsModalReady();
      await openNotificationsSection();
      await user.click(screen.getByText("Advanced"));
      const tokenInput = screen.getByLabelText("Access token (optional)");
      await user.clear(tokenInput);
      await user.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(mockUpdateGlobalSettings).toHaveBeenCalledWith(
          expect.objectContaining({ ntfyAccessToken: null }),
        );
      });
    });

    it("calls testNotification with ntfy message-event config when message test button clicked", async () => {
      const addToast = vi.fn();
      mockFetchSettings.mockResolvedValueOnce({ ...defaultSettings, ntfyEnabled: true, ntfyTopic: "test-topic" });
      renderModal({ addToast });
      await waitForSettingsModalReady();
      await openNotificationsSection();

      await user.click(screen.getByRole("button", { name: /Test message inbox/ }));

      await waitFor(() => {
        expect(mockTestNotification).toHaveBeenCalledWith(
          "ntfy",
          { messageEventType: "message:agent-to-user" },
          undefined,
        );
      });
      expect(addToast).toHaveBeenCalledWith(
        "Message inbox test sent — check your ntfy inbox for the agent-to-user message.",
        "success",
      );
      expect(screen.getByText("Message inbox: Message inbox test sent — check your ntfy inbox for the agent-to-user message.")).toBeInTheDocument();
      expect(screen.getByText("Message inbox: Message inbox test sent — check your ntfy inbox for the agent-to-user message.").closest(".notification-test-feedback")).toHaveAttribute("aria-live", "polite");
    });

    it("calls testNotification with ntfy room-event config when room test button clicked", async () => {
      const addToast = vi.fn();
      mockFetchSettings.mockResolvedValueOnce({ ...defaultSettings, ntfyEnabled: true, ntfyTopic: "test-topic" });
      renderModal({ addToast });
      await waitForSettingsModalReady();
      await openNotificationsSection();

      await user.click(screen.getByRole("button", { name: /Test room reply/ }));

      await waitFor(() => {
        expect(mockTestNotification).toHaveBeenCalledWith(
          "ntfy",
          { messageEventType: "message:room" },
          undefined,
        );
      });
      expect(addToast).toHaveBeenCalledWith(
        "Room reply test sent — check your ntfy inbox for the room reply.",
        "success",
      );
      expect(screen.getByText("Room reply: Room reply test sent — check your ntfy inbox for the room reply.")).toBeInTheDocument();
    });

    it("shows ntfy room-specific failure copy when room test fails", async () => {
      const addToast = vi.fn();
      mockTestNotification.mockResolvedValueOnce({ success: false, error: "boom" });
      mockFetchSettings.mockResolvedValueOnce({ ...defaultSettings, ntfyEnabled: true, ntfyTopic: "test-topic" });
      renderModal({ addToast });
      await waitForSettingsModalReady();
      await openNotificationsSection();

      await user.click(screen.getByRole("button", { name: /Test room reply/ }));

      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith("Failed to send room reply test", "error");
      });
      expect(screen.getByText("Room reply: Failed to send room reply test")).toBeInTheDocument();
    });

    it("preserves existing ntfy settings in backward compat", async () => {
      mockFetchSettings.mockResolvedValueOnce({
        ...defaultSettings,
        ntfyEnabled: true,
        ntfyTopic: "my-existing-topic",
        ntfyEvents: ["in-review", "failed"],
      });

      renderModal();
      await waitForSettingsModalReady();
      await openNotificationsSection();

      expect(screen.getByLabelText("ntfy Topic")).toHaveValue("my-existing-topic");
      const inReview = screen.getByLabelText("Task completed (in-review)") as HTMLInputElement;
      const failed = screen.getByLabelText("Task failed") as HTMLInputElement;
      const merged = screen.getByLabelText("Task merged") as HTMLInputElement;
      const fallbackUsed = screen.getByLabelText("Fallback model used (recovered)") as HTMLInputElement;
      const dreamsProcessed = screen.getByLabelText("DREAMS.md entry added") as HTMLInputElement;
      expect(inReview.checked).toBe(true);
      expect(failed.checked).toBe(true);
      expect(merged.checked).toBe(false);
      expect(fallbackUsed.checked).toBe(false);
      expect(dreamsProcessed.checked).toBe(false);
    });
  });

  describe("scheduled eval settings section", () => {
    const openScheduledEvalsSection = async () => {
      await userEvent.click(await screen.findByRole("button", { name: /Scheduled Evals/i }));
    };

    it("renders controls and disables interval controls when evals are disabled", async () => {
      mockFetchSettings.mockResolvedValueOnce({
        ...defaultSettings,
        experimentalFeatures: { evalsView: true },
        evalSettings: {
          enabled: false,
          intervalMs: 86_400_000,
          followUpPolicy: "suggest-only",
          retentionDays: 30,
        },
      });

      renderModal();
      await waitForSettingsModalReady();
      await openScheduledEvalsSection();

      expect(await screen.findByRole("heading", { name: "Scheduled Evals" })).toBeInTheDocument();
      expect(screen.getByLabelText("Enable scheduled eval runs for this project")).toBeInTheDocument();
      expect(screen.getByLabelText("Interval (ms)")).toBeDisabled();
      expect(screen.getByLabelText("Follow-up Policy")).toBeDisabled();
      expect(screen.getByLabelText("Retention (days)")).toBeDisabled();
      expect(screen.getByText(/inherit the project validator lane model settings/i)).toBeInTheDocument();
    });

    it("saves edited project eval settings payload", async () => {
      mockFetchSettings.mockResolvedValueOnce({
        ...defaultSettings,
        experimentalFeatures: { evalsView: true },
        evalSettings: {
          enabled: true,
          intervalMs: 86_400_000,
          followUpPolicy: "suggest-only",
          retentionDays: 30,
        },
      });

      renderModal();
      await waitForSettingsModalReady();
      await openScheduledEvalsSection();

      fireEvent.change(screen.getByLabelText("Interval (ms)"), { target: { value: "120000" } });
      await userEvent.type(screen.getByLabelText("Evaluator Provider"), "openai");
      await userEvent.type(screen.getByLabelText("Evaluator Model"), "gpt-5");
      await userEvent.selectOptions(screen.getByLabelText("Follow-up Policy"), "auto-create");
      fireEvent.change(screen.getByLabelText("Retention (days)"), { target: { value: "14" } });
      await userEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            evalSettings: expect.objectContaining({
              enabled: true,
              intervalMs: 120000,
              evaluatorProvider: "openai",
              evaluatorModelId: "gpt-5",
              followUpPolicy: "auto-create",
              retentionDays: 14,
            }),
          }),
          undefined,
        );
      });
    });

    it("clears evaluator provider and model as unset when left blank", async () => {
      mockFetchSettings.mockResolvedValueOnce({
        ...defaultSettings,
        experimentalFeatures: { evalsView: true },
        evalSettings: {
          enabled: true,
          intervalMs: 86_400_000,
          evaluatorProvider: "openai",
          evaluatorModelId: "gpt-5",
          followUpPolicy: "suggest-only",
          retentionDays: 30,
        },
      });

      renderModal();
      await waitForSettingsModalReady();
      await openScheduledEvalsSection();

      await userEvent.clear(screen.getByLabelText("Evaluator Provider"));
      await userEvent.clear(screen.getByLabelText("Evaluator Model"));
      await userEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            evalSettings: expect.objectContaining({
              evaluatorProvider: undefined,
              evaluatorModelId: undefined,
            }),
          }),
          undefined,
        );
      });
    });
  });

  describe("memory backups settings", () => {
    it("renders memory backup fields with defaults and saves changes", async () => {
      renderModal({ initialSection: "backups" });
      await waitForSettingsModalReady();

      expect(screen.getByRole("heading", { name: "Memory Backups" })).toBeInTheDocument();
      expect(screen.getByLabelText("Memory Backup Schedule (Cron)")).toHaveValue("0 3 * * *");
      expect(screen.getByLabelText("Memory Retention Count")).toHaveValue(null);
      expect(screen.getByLabelText("Memory Backup Directory")).toHaveValue(".fusion/backups/memory");
      expect(screen.getByLabelText("Memory Backup Scope")).toHaveValue("all");

      await userEvent.click(screen.getByLabelText("Enable automatic memory backups"));
      fireEvent.change(screen.getByLabelText("Memory Backup Schedule (Cron)"), { target: { value: "0 5 * * *" } });
      fireEvent.change(screen.getByLabelText("Memory Retention Count"), { target: { value: "21" } });
      fireEvent.change(screen.getByLabelText("Memory Backup Directory"), { target: { value: ".fusion/backups/custom-memory" } });
      await userEvent.selectOptions(screen.getByLabelText("Memory Backup Scope"), "agents");
      await userEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            memoryBackupEnabled: true,
            memoryBackupSchedule: "0 5 * * *",
            memoryBackupRetention: 21,
            memoryBackupDir: ".fusion/backups/custom-memory",
            memoryBackupScope: "agents",
          }),
          undefined,
        );
      });
    });
  });

  describe("research settings sections", () => {
    beforeEach(() => {
      mockFetchSettings.mockResolvedValue({
        ...defaultSettings,
        experimentalFeatures: { researchView: true },
      });
    });

    const openResearchGlobalSection = async () => {
      await userEvent.click(await screen.findByRole("button", { name: /Research Defaults/i }));
    };

    const openResearchProjectSection = async () => {
      await userEvent.click(await screen.findByRole("button", { name: /^Research$/i }));
    };

    it("renders global research defaults fields with expected default values", async () => {
      renderModal();
      await waitForSettingsModalReady();
      await openResearchGlobalSection();

      expect(screen.getByLabelText("Default Max Concurrent Runs")).toHaveValue(3);
      expect(screen.getByLabelText("Default Max Sources Per Run")).toHaveValue(20);
      expect(screen.getByLabelText("Default Max Duration (ms)")).toHaveValue(300000);
      expect(screen.getByLabelText("Request Timeout (ms)")).toHaveValue(30000);
      expect(screen.getByLabelText("Max Synthesis Rounds")).toHaveValue(2);
      expect(screen.getByRole("checkbox", { name: /^GitHub$/i })).not.toBeChecked();
      expect(screen.getByRole("checkbox", { name: /^Local Docs$/i })).toBeChecked();
    });

    it("saves global research defaults through updateGlobalSettings only", async () => {
      renderModal();
      await waitForSettingsModalReady();
      await openResearchGlobalSection();

      await userEvent.click(screen.getByText(/Advanced — external search providers/i));
      const providerSelect = await screen.findByLabelText("Search Provider");
      fireEvent.change(providerSelect, { target: { value: "tavily" } });
      fireEvent.change(screen.getByLabelText("Default Max Concurrent Runs"), { target: { value: "4" } });
      fireEvent.change(screen.getByLabelText("Default Max Sources Per Run"), { target: { value: "25" } });
      fireEvent.change(screen.getByLabelText("Default Max Duration (ms)"), { target: { value: "240000" } });
      fireEvent.change(screen.getByLabelText("Request Timeout (ms)"), { target: { value: "45000" } });
      fireEvent.change(screen.getByLabelText("Max Synthesis Rounds"), { target: { value: "3" } });
      await userEvent.click(screen.getByRole("checkbox", { name: /^GitHub$/i }));
      await userEvent.click(screen.getByRole("checkbox", { name: /^Local Docs$/i }));
      await userEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdateGlobalSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            researchGlobalDefaults: expect.objectContaining({ searchProvider: "tavily", maxSourcesPerRun: 25 }),
            researchGlobalMaxConcurrentRuns: 4,
            researchGlobalMaxSourcesPerRun: 25,
            researchGlobalDefaultTimeout: 240000,
            researchGlobalFetchTimeoutMs: 45000,
            researchGlobalMaxSynthesisRounds: 3,
            researchGlobalGitHubEnabled: true,
            researchGlobalLocalDocsEnabled: false,
          }),
        );
      });
      expect(mockUpdateSettings).toHaveBeenCalledWith(
        expect.not.objectContaining({ researchSettings: expect.anything() }),
        undefined,
      );
    });

    it("shows web search as always on in project research settings", async () => {
      renderModal();
      await waitForSettingsModalReady();
      await openResearchProjectSection();

      const webSearch = await screen.findByRole("checkbox", { name: /Web Search/i });
      expect(webSearch).toBeChecked();
      expect(webSearch).toBeDisabled();
      expect(screen.getByText("Always on")).toBeInTheDocument();
      expect(screen.getByText(/Web search is always enabled\. Configure the search provider under Research Defaults\./i)).toBeInTheDocument();
    });

    it("does not mutate enabledSources.webSearch when toggling other sources", async () => {
      mockFetchSettings.mockResolvedValueOnce({
        ...defaultSettings,
        experimentalFeatures: { researchView: true },
        researchSettings: {
          enabled: true,
          enabledSources: {
            webSearch: false,
            pageFetch: true,
            github: false,
            localDocs: true,
            llmSynthesis: true,
          },
        },
      });

      renderModal();
      await waitForSettingsModalReady();
      await openResearchProjectSection();

      const webSearch = await screen.findByRole("checkbox", { name: /Web Search/i });
      expect(webSearch).toBeChecked();
      await userEvent.click(webSearch);
      expect(webSearch).toBeChecked();

      await userEvent.click(screen.getByRole("checkbox", { name: "Page Fetch" }));
      await userEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            researchSettings: expect.objectContaining({
              enabledSources: expect.objectContaining({
                webSearch: false,
                pageFetch: false,
              }),
            }),
          }),
          undefined,
        );
      });
    });

    it("saves project research settings through updateSettings only", async () => {
      renderModal();
      await waitForSettingsModalReady();
      await openResearchProjectSection();

      await userEvent.click(screen.getByLabelText("Enable research in this project"));
      const maxConcurrent = await screen.findByLabelText("Max Concurrent Runs");
      fireEvent.change(maxConcurrent, { target: { value: "4" } });
      await userEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            researchSettings: expect.objectContaining({
              enabled: false,
              limits: expect.objectContaining({ maxConcurrentRuns: 4 }),
            }),
          }),
          undefined,
        );
      });
      expect(mockUpdateGlobalSettings).toHaveBeenCalledWith(
        expect.not.objectContaining({ researchGlobalDefaults: expect.anything() }),
      );
    });

    it("blocks save and shows inline error for invalid research limits", async () => {
      renderModal();
      await waitForSettingsModalReady();
      await openResearchProjectSection();

      const maxConcurrent = await screen.findByLabelText("Max Concurrent Runs");
      fireEvent.change(maxConcurrent, { target: { value: "0" } });
      await userEvent.click(screen.getByText("Save"));

      expect(await screen.findByText("Research max concurrent runs must be at least 1.")).toBeInTheDocument();
    });

    it("shows builtin research provider guidance by default", async () => {
      mockFetchSettings.mockResolvedValueOnce({
        ...defaultSettings,
        experimentalFeatures: { researchView: true },
        researchGlobalDefaults: {},
      });

      renderModal();
      await waitForSettingsModalReady();
      await openResearchGlobalSection();

      expect(await screen.findByText(/Built-in \(uses agent web tools\)/i)).toBeInTheDocument();
      expect(screen.queryByText(/Research defaults are incomplete/i)).not.toBeInTheDocument();
    });

    it("keeps external provider settings collapsed by default and reveals on expand", async () => {
      mockFetchSettings.mockResolvedValueOnce({
        ...defaultSettings,
        experimentalFeatures: { researchView: true },
      });

      renderModal();
      await waitForSettingsModalReady();
      await openResearchGlobalSection();

      const details = screen.getByText(/Advanced — external search providers/i).closest("details");
      expect(details).not.toHaveAttribute("open");

      await userEvent.click(screen.getByText(/Advanced — external search providers/i));
      expect(details).toHaveAttribute("open");
      expect(await screen.findByLabelText("SearXNG URL")).toBeInTheDocument();
      expect(screen.getByText(/Open Authentication Settings/i)).toBeInTheDocument();

      const advancedBody = details?.querySelector(".settings-research-provider-advanced-body");
      expect(advancedBody).toBeTruthy();
      expect(advancedBody?.querySelectorAll(".form-group")).toHaveLength(3);
      expect(screen.getByLabelText("Search Provider")).toHaveClass("input");
      expect(screen.getByLabelText("SearXNG URL")).toHaveClass("input");
      expect(screen.getByLabelText("Google Search CX")).toHaveClass("input");
    });

    it("keeps default max sources outside advanced details and groups provider controls", async () => {
      renderModal();
      await waitForSettingsModalReady();
      await openResearchGlobalSection();

      const details = screen.getByText(/Advanced — external search providers/i).closest("details");
      const maxSourcesInput = screen.getByLabelText("Default Max Sources Per Run");
      expect(details).toBeTruthy();
      expect(maxSourcesInput.closest("details")).toBeNull();
      expect(details).not.toContainElement(maxSourcesInput);

      const builtInRadio = screen.getByLabelText(/Built-in \(uses agent web tools\)/i);
      const providerGroup = builtInRadio.closest(".settings-research-provider-group");
      expect(providerGroup).toBeTruthy();
      expect(providerGroup).toContainElement(details);
      expect(providerGroup).toContainElement(screen.getByText(/No API key required\./i));
    });

    it("keeps research limits and source controls inside desktop containment grids for both sections", async () => {
      renderModal();
      await waitForSettingsModalReady();
      await openResearchGlobalSection();

      const defaultMaxConcurrent = screen.getByLabelText("Default Max Concurrent Runs");
      const defaultMaxSources = screen.getByLabelText("Default Max Sources Per Run");
      const defaultMaxDuration = screen.getByLabelText("Default Max Duration (ms)");
      const defaultRequestTimeout = screen.getByLabelText("Request Timeout (ms)");

      const globalLimitsGrid = defaultMaxConcurrent.closest(".settings-research-limits-grid");
      expect(globalLimitsGrid).toBeTruthy();
      expect(defaultMaxSources.closest(".settings-research-limits-grid")).toBe(globalLimitsGrid);
      expect(defaultMaxDuration.closest(".settings-research-limits-grid")).toBe(globalLimitsGrid);
      expect(defaultRequestTimeout.closest(".settings-research-limits-grid")).toBe(globalLimitsGrid);
      expect(defaultMaxConcurrent).toHaveClass("input");
      expect(defaultMaxSources).toHaveClass("input");
      expect(defaultMaxDuration).toHaveClass("input");
      expect(defaultRequestTimeout).toHaveClass("input");

      const globalSourceGrid = screen.getByRole("checkbox", { name: "GitHub" }).closest(".settings-research-source-grid");
      expect(globalSourceGrid).toBeTruthy();
      expect(screen.getByRole("checkbox", { name: "Local Docs" }).closest(".settings-research-source-grid")).toBe(globalSourceGrid);

      await openResearchProjectSection();

      const projectMaxConcurrent = screen.getByLabelText("Max Concurrent Runs");
      const projectMaxSources = screen.getByLabelText("Max Sources Per Run");
      const projectMaxDuration = screen.getByLabelText("Max Duration (ms)");
      const projectRequestTimeout = screen.getByLabelText("Request Timeout (ms)");

      const projectLimitsGrid = projectMaxConcurrent.closest(".settings-research-limits-grid");
      expect(projectLimitsGrid).toBeTruthy();
      expect(projectMaxSources.closest(".settings-research-limits-grid")).toBe(projectLimitsGrid);
      expect(projectMaxDuration.closest(".settings-research-limits-grid")).toBe(projectLimitsGrid);
      expect(projectRequestTimeout.closest(".settings-research-limits-grid")).toBe(projectLimitsGrid);
      expect(projectMaxConcurrent).toHaveClass("input");
      expect(projectMaxSources).toHaveClass("input");
      expect(projectMaxDuration).toHaveClass("input");
      expect(projectRequestTimeout).toHaveClass("input");

      const projectSourceGrid = screen.getByRole("checkbox", { name: "Page Fetch" }).closest(".settings-research-source-grid");
      expect(projectSourceGrid).toBeTruthy();
      expect(screen.getByRole("checkbox", { name: "GitHub" }).closest(".settings-research-source-grid")).toBe(projectSourceGrid);
      expect(screen.getByRole("checkbox", { name: "Local Docs" }).closest(".settings-research-source-grid")).toBe(projectSourceGrid);
      expect(screen.getByRole("checkbox", { name: "LLM Synthesis" }).closest(".settings-research-source-grid")).toBe(projectSourceGrid);
    });

    it("groups project limits fields in one grid and keeps validation error visible", async () => {
      renderModal();
      await waitForSettingsModalReady();
      await openResearchProjectSection();

      const maxConcurrent = screen.getByLabelText("Max Concurrent Runs");
      const maxSources = screen.getByLabelText("Max Sources Per Run");
      const maxDuration = screen.getByLabelText("Max Duration (ms)");
      const requestTimeout = screen.getByLabelText("Request Timeout (ms)");

      const limitsGrid = maxConcurrent.closest(".settings-research-limits-grid");
      expect(limitsGrid).toBeTruthy();
      expect(maxSources.closest(".settings-research-limits-grid")).toBe(limitsGrid);
      expect(maxDuration.closest(".settings-research-limits-grid")).toBe(limitsGrid);
      expect(requestTimeout.closest(".settings-research-limits-grid")).toBe(limitsGrid);
      expect(maxConcurrent).toHaveClass("input");
      expect(maxSources).toHaveClass("input");
      expect(maxDuration).toHaveClass("input");
      expect(requestTimeout).toHaveClass("input");

      const sourceGrid = screen.getByRole("checkbox", { name: "Page Fetch" }).closest(".settings-research-source-grid");
      expect(sourceGrid).toBeTruthy();
      expect(screen.getByRole("checkbox", { name: "GitHub" }).closest(".settings-research-source-grid")).toBe(sourceGrid);
      expect(screen.getByRole("checkbox", { name: "Local Docs" }).closest(".settings-research-source-grid")).toBe(sourceGrid);
      expect(screen.getByRole("checkbox", { name: "LLM Synthesis" }).closest(".settings-research-source-grid")).toBe(sourceGrid);

      fireEvent.change(maxConcurrent, { target: { value: "0" } });
      await userEvent.click(screen.getByText("Save"));
      expect(await screen.findByText("Research max concurrent runs must be at least 1.")).toBeInTheDocument();
    });

    it("shows missing credentials warning and routes CTA to Authentication", async () => {
      mockFetchSettings.mockResolvedValueOnce({
        ...defaultSettings,
        experimentalFeatures: { researchView: true },
        researchGlobalDefaults: {
          searchProvider: "brave",
        },
      });
      mockFetchAuthStatus.mockResolvedValue({
        providers: [
          { id: "brave", name: "Brave Search", type: "api_key", authenticated: false },
          { id: "tavily", name: "Tavily", type: "api_key", authenticated: true },
        ],
      });

      renderModal();
      await waitForSettingsModalReady();
      await openResearchGlobalSection();

      expect(await screen.findByText(/Missing credentials for the selected research provider/i)).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Open Authentication" }));
      expect(await screen.findByRole("heading", { name: "Authentication" })).toBeInTheDocument();
    });

    it("falls back to first visible section when initial section is unavailable", async () => {
      renderModal({ initialSection: "unknown-section" as any });
      await waitForSettingsModalReady();
      expect(await screen.findByRole("heading", { name: "General" })).toBeInTheDocument();
    });
  });

  describe("memory dream trigger", () => {
    const openMemorySection = async () => {
      const [memorySectionButton] = await screen.findAllByRole("button", { name: /^Memory$/i });
      await userEvent.click(memorySectionButton);
    };

    it("shows Dream Now button when dreams are enabled", async () => {
      mockFetchSettings.mockResolvedValueOnce({
        ...defaultSettings,
        memoryEnabled: true,
        memoryDreamsEnabled: true,
        memoryDreamsSchedule: "0 4 * * *",
      });

      renderModal();
      await waitForSettingsModalReady();
      await openMemorySection();

      expect(await screen.findByRole("button", { name: "Dream Now" })).toBeInTheDocument();
    });

    it("triggers dream processing from Dream Now button", async () => {
      const addToast = vi.fn();
      mockFetchSettings.mockResolvedValueOnce({
        ...defaultSettings,
        memoryEnabled: true,
        memoryDreamsEnabled: true,
      });
      mockTriggerMemoryDreams.mockResolvedValueOnce({ success: true, summary: "done" });

      renderModal({ addToast });
      await waitForSettingsModalReady();
      await openMemorySection();

      await userEvent.click(await screen.findByRole("button", { name: "Dream Now" }));

      await waitFor(() => {
        expect(mockTriggerMemoryDreams).toHaveBeenCalledWith(undefined);
      });
      expect(addToast).toHaveBeenCalledWith("Dream processing completed", "success");
    });

    it("hides Dream Now button when dreams are disabled", async () => {
      renderModal();
      await waitForSettingsModalReady();
      await openMemorySection();

      expect(screen.queryByRole("button", { name: "Dream Now" })).not.toBeInTheDocument();
    });
  });
});


describe("plugin structured contribution contract fixtures", () => {
  it("represents all required structured surfaces without componentPath", () => {
    const contributions: PluginUiContributionEntry[] = [
      { pluginId: "plugin-a", contribution: { surface: "settings-provider-card", contributionId: "a", providerId: "openai", title: "OpenAI", providerType: "api_key" } },
      { pluginId: "plugin-a", contribution: { surface: "settings-config-section", contributionId: "b", sectionId: "openai", title: "OpenAI config", pluginSettingKeys: ["openai.apiKey"] } },
      { pluginId: "plugin-a", contribution: { surface: "onboarding-provider-card", contributionId: "c", providerId: "openai", title: "OpenAI", providerType: "api_key" } },
      { pluginId: "plugin-a", contribution: { surface: "onboarding-setup-help", contributionId: "d", title: "Help", body: "Use API key", bodyFormat: "text" } },
      { pluginId: "plugin-a", contribution: { surface: "onboarding-provider-recommendation", contributionId: "e", providerId: "openai", title: "Recommended", reason: "Fast setup" } },
      { pluginId: "plugin-a", contribution: { surface: "post-onboarding-recommendation", contributionId: "f", title: "Next step", description: "Enable memory" } },
    ];

    expect(contributions).toHaveLength(6);
    for (const entry of contributions) {
      expect("componentPath" in entry.contribution).toBe(false);
    }
  });
});
