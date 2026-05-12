import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsModal } from "../SettingsModal";
import { __test_clearCache as clearPluginUiSlotsCache } from "../../hooks/usePluginUiSlots";
import type { PluginUiContributionEntry, SettingsExportData, UpdateCheckResponse } from "../../api";

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
const mockFetchGitRemotesDetailed = vi.fn();
const mockFetchDashboardHealth = vi.fn();
const mockCheckForUpdates = vi.fn();
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
    fetchGitRemotesDetailed: (...args: unknown[]) => mockFetchGitRemotesDetailed(...args),
    fetchDashboardHealth: (...args: unknown[]) => mockFetchDashboardHealth(...args),
    checkForUpdates: (...args: unknown[]) => mockCheckForUpdates(...args),
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
  pushAfterMerge: false,
  pushRemote: "origin",
  verificationFixRetries: 2,
  workflowRevisionForkOnScopeMismatch: true,
  recycleWorktrees: false,
  worktreeNaming: "random",
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

function renderModal(props = {}) {
  return render(
    <SettingsModal
      onClose={noop}
      addToast={noop}
      {...props}
    />
  );
}

async function waitForSettingsModalReady() {
  await waitFor(() => {
    expect(mockFetchSettings).toHaveBeenCalled();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });
}

const MODEL_FIXTURE = [
  { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true, contextWindow: 200000 },
  { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
];

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

  it("renders section headings with the shared settings-section-heading class", async () => {
    const { container } = renderModal();
    await waitForSettingsModalReady();

    const authenticationHeading = screen.getByRole("heading", { name: "Authentication" });
    expect(authenticationHeading).toHaveClass("settings-section-heading");

    await userEvent.click(screen.getAllByRole("button", { name: /^General$/ })[0]);

    const generalHeading = screen.getByRole("heading", { name: "General" });
    expect(generalHeading).toHaveClass("settings-section-heading");
    expect(container.querySelectorAll(".settings-section-heading").length).toBeGreaterThan(0);
  });

  beforeEach(() => {
    vi.clearAllMocks();
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
    mockFetchGitRemotesDetailed.mockResolvedValue([]);
    mockFetchDashboardHealth.mockResolvedValue({ status: "ok", version: "1.2.3", uptime: 123 });
    mockCheckForUpdates.mockResolvedValue(undefined);
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
    it("defaults persistAgentToolOutput checkbox to checked", async () => {
      renderModal({ initialSection: "global-general" });
      await waitForSettingsModalReady();

      expect(screen.getByRole("checkbox", { name: "Save tool output in agent logs" })).toBeChecked();
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

    it("defaults persistAgentThinkingLog checkbox to unchecked", async () => {
      renderModal({ initialSection: "global-general" });
      await waitForSettingsModalReady();

      expect(screen.getByRole("checkbox", { name: "Save AI thinking/reasoning in agent logs" })).not.toBeChecked();
    });

    it("reflects persisted checked thinking-log value from global settings", async () => {
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

      expect(screen.getByRole("checkbox", { name: "Save AI thinking/reasoning in agent logs" })).toBeChecked();
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

    it("saves persistAgentThinkingLog only via global settings payload", async () => {
      renderModal({ initialSection: "global-general" });
      await waitForSettingsModalReady();

      await userEvent.click(screen.getByRole("checkbox", { name: "Save AI thinking/reasoning in agent logs" }));
      await userEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(mockUpdateGlobalSettings).toHaveBeenCalled();
      });

      const globalPayload = mockUpdateGlobalSettings.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(globalPayload.persistAgentThinkingLog).toBe(true);
      if (mockUpdateSettings.mock.calls.length > 0) {
        const projectPayload = mockUpdateSettings.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(projectPayload.persistAgentThinkingLog).toBeUndefined();
      }
    });

    it("renders global default tracking repo control", async () => {
      renderModal({ initialSection: "global-general" });
      await waitForSettingsModalReady();

      const input = screen.getByLabelText("Global default tracking repo") as HTMLInputElement;
      expect(input.value).toBe("");
      expect(screen.getByText(/Projects inherit this value when they do not set a project default tracking repo/i)).toBeInTheDocument();
    });

    it("saves global default tracking repo via global settings payload only", async () => {
      renderModal({ initialSection: "global-general" });
      await waitForSettingsModalReady();

      await userEvent.type(screen.getByLabelText("Global default tracking repo"), "octo/global-default");
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

    it("saves completion documentation mode through project settings", async () => {
      renderModal({ initialSection: "general" });
      await waitForSettingsModalReady();

      await userEvent.selectOptions(
        screen.getByLabelText("Completion Documentation Automation"),
        "changeset",
      );
      await userEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalled();
      });

      const projectPayload = mockUpdateSettings.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(projectPayload.completionDocumentationMode).toBe("changeset");

      if (mockUpdateGlobalSettings.mock.calls.length > 0) {
        const globalPayload = mockUpdateGlobalSettings.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(globalPayload.completionDocumentationMode).toBeUndefined();
      }
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

      renderModal();
      await waitForSettingsModalReady();

      await userEvent.click(screen.getByRole("button", { name: "Models" }));
      const checkbox = await screen.findByLabelText("Sync opencode-go model list at startup");
      expect(checkbox).toBeChecked();

      await userEvent.click(checkbox);
      await userEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(mockUpdateGlobalSettings).toHaveBeenCalled();
      });

      expect(mockUpdateGlobalSettings).toHaveBeenCalledWith(
        expect.objectContaining({ opencodeGoModelSync: false }),
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
  });

  describe("settings header actions", () => {
    it("renders Help and GitHub star controls with shared header sizing contract class hooks", async () => {
      renderModal();
      await waitForSettingsModalReady();

      const headerActions = document.querySelector(".settings-header-actions");
      expect(headerActions).toBeInTheDocument();

      const starLink = within(headerActions as HTMLElement).getByRole("link", { name: "Star Fusion on GitHub" });
      const helpLink = within(headerActions as HTMLElement).getByRole("link", { name: "Help and discussions" });

      expect(starLink).toHaveClass("settings-github-star-btn");
      expect(helpLink).toHaveClass("settings-header-help-btn");
      expect(helpLink).toHaveClass("btn", "btn-sm");
    });
  });

  describe("settings version display", () => {
    it("renders the app version from the health endpoint", async () => {
      renderModal();
      await waitForSettingsModalReady();

      expect(await screen.findByText("Version 1.2.3")).toBeInTheDocument();
      expect(mockFetchDashboardHealth).toHaveBeenCalledTimes(1);
    });

    it("keeps settings interactive when version lookup fails", async () => {
      const addToast = vi.fn();
      mockFetchDashboardHealth.mockRejectedValueOnce(new Error("health unavailable"));
      render(<SettingsModal onClose={noop} addToast={addToast} />);

      await waitForSettingsModalReady();

      expect(screen.queryByText(/^Version\s+/)).not.toBeInTheDocument();
      await userEvent.click(screen.getByText("Scheduling"));
      expect(await screen.findByLabelText("Max Concurrent Tasks")).toBeInTheDocument();
      expect(addToast).not.toHaveBeenCalled();
    });

    it("renders check for updates button in header", async () => {
      renderModal();
      await waitForSettingsModalReady();

      expect(screen.getByRole("button", { name: "Check for updates" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Check Now" })).not.toBeInTheDocument();
      expect(screen.queryByText("Manually check for the latest version right now.")).not.toBeInTheDocument();
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

      // Assert the filename uses fusion-settings- prefix
      expect(createdElements.length).toBeGreaterThanOrEqual(1);
      const anchorElement = createdElements[0];
      expect(anchorElement.download).toMatch(/^fusion-settings-/);
      expect(anchorElement.download).toMatch(/^fusion-settings-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.json$/);
    });

    it("does not use kb-settings- prefix for exported filename", async () => {
      const mockExportData: SettingsExportData = {
        version: 1,
        exportedAt: "2026-04-04T12:00:00.000Z",
        global: undefined,
        project: { maxConcurrent: 2 },
      };
      mockExportSettings.mockResolvedValue(mockExportData);

      // Capture filenames set on dynamically-created anchor elements
      const capturedFilenames: string[] = [];
      const originalCreateElement = document.createElement.bind(document);
      vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
        const el = originalCreateElement(tagName);
        if (tagName.toLowerCase() === "a") {
          const origDownloadDescriptor = Object.getOwnPropertyDescriptor(
            HTMLAnchorElement.prototype,
            "download"
          );
          Object.defineProperty(el, "download", {
            set(v: string) {
              capturedFilenames.push(v);
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

      vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:http://localhost/mock");
      vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

      renderModal();

      await waitFor(() => {
        expect(mockFetchSettings).toHaveBeenCalled();
      });

      fireEvent.click(screen.getByTitle("Export settings to JSON file"));

      await waitFor(() => {
        expect(mockExportSettings).toHaveBeenCalled();
      });

      // Negative assertion: filename must NOT use the old kb- prefix
      expect(capturedFilenames.length).toBeGreaterThanOrEqual(1);
      for (const filename of capturedFilenames) {
        expect(filename).not.toMatch(/^kb-settings-/);
      }
    });
  });

  describe("Authentication provider icon wrappers", () => {
    it("renders stable auth-provider-icon wrappers with branded and fallback SVG behavior", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "openrouter", name: "OpenRouter", authenticated: true, type: "api_key" },
          { id: "unknown-provider", name: "Unknown Provider", authenticated: false, type: "api_key" },
        ],
      });

      renderModal();
      await waitForSettingsModalReady();

      const openRouterIconWrapper = await screen.findByTestId("auth-provider-icon-openrouter");
      expect(within(openRouterIconWrapper).getByTestId("openrouter-icon")).toBeInTheDocument();

      const unknownIconWrapper = screen.getByTestId("auth-provider-icon-unknown-provider");
      const fallbackSvg = unknownIconWrapper.querySelector("svg");
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
          matches: query === "(max-width: 768px)" || query === "(pointer: coarse)",
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

      await waitFor(() => {
        expect(screen.getByTestId("pi-extensions-manager")).toBeInTheDocument();
      });
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

      fireEvent.click(screen.getByText("Scheduling"));

      expect(screen.getByDisplayValue("docs/")).toBeInTheDocument();
      expect(screen.getByDisplayValue("generated/*")).toBeInTheDocument();
    });

    it("supports selecting ignore paths through the browse picker", async () => {
      renderModal();
      await waitFor(() => expect(mockFetchSettings).toHaveBeenCalled());

      fireEvent.click(screen.getByText("Scheduling"));

      await userEvent.click(screen.getByRole("button", { name: /browse path for ignored overlap entry 1/i }));

      expect(await screen.findByRole("dialog", { name: /browse workspace path/i })).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Select README.md" }));

      expect(screen.getByDisplayValue("README.md")).toBeInTheDocument();
    });

    it("includes overlapIgnorePaths in save payload", async () => {
      renderModal();
      await waitFor(() => expect(mockFetchSettings).toHaveBeenCalled());

      fireEvent.click(screen.getByText("Scheduling"));

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
  });

  describe("Number input clearing", () => {
    it("allows clearing maxConcurrent without leaving a stuck zero", async () => {
      renderModal();
      await waitFor(() => expect(mockFetchSettings).toHaveBeenCalled());

      // Open Scheduling section
      fireEvent.click(screen.getByText("Scheduling"));

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
      fireEvent.click(screen.getByText("Scheduling"));

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
      fireEvent.click(screen.getByText("Scheduling"));

      const input = screen.getByLabelText("Poll Interval (ms)") as HTMLInputElement;
      expect(input).toBeDefined();

      // Clear the input - the input should be empty, not show "0"
      await userEvent.clear(input);
      expect(input.value).toBe("");
    });

    it("allows configuring stale high fan-out escalation threshold in hours", async () => {
      renderModal();
      await waitFor(() => expect(mockFetchSettings).toHaveBeenCalled());

      fireEvent.click(screen.getByText("Scheduling"));

      const input = screen.getByLabelText("Stale High Fan-out Escalation (hours)") as HTMLInputElement;
      expect(input).toBeDefined();
      await userEvent.clear(input);
      await userEvent.type(input, "3");
      expect(input.value).toBe("3");
    });

    it("allows clearing maxWorktrees without leaving a stuck zero", async () => {
      renderModal();
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

  describe("Memory section", () => {
    it("renders the Memory section in the sidebar", async () => {
      renderModal();

      await waitFor(() => {
        expect(mockFetchSettings).toHaveBeenCalled();
      });

      expect(await screen.findByText("Memory")).toBeDefined();
    });

    it("shows the memory toggle with default enabled", async () => {
      renderModal();

      await waitFor(() => {
        expect(mockFetchSettings).toHaveBeenCalled();
      });

      // Click the Memory section in the sidebar
      await userEvent.click(await screen.findByText("Memory"));

      const checkbox = screen.getByRole("checkbox", { name: /enable memory tools/i });
      expect(checkbox).toBeDefined();
      // Default is enabled, so checkbox should be checked
      expect(checkbox).toBeChecked();
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

    it("toggles the memory setting when checkbox is clicked", async () => {
      renderModal();

      await waitFor(() => {
        expect(mockFetchSettings).toHaveBeenCalled();
      });

      // Click the Memory section in the sidebar
      await userEvent.click(await screen.findByText("Memory"));

      const checkbox = screen.getByRole("checkbox", { name: /enable memory tools/i });
      expect(checkbox).toBeChecked();

      // Uncheck it
      await userEvent.click(checkbox);
      expect(checkbox).not.toBeChecked();

      // Check it again
      await userEvent.click(checkbox);
      expect(checkbox).toBeChecked();
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

    it("loads and shows memory editor content when navigating to Memory", async () => {
      renderModal();

      await waitFor(() => {
        expect(mockFetchSettings).toHaveBeenCalled();
      });

      expect(mockFetchMemoryFiles).not.toHaveBeenCalled();

      await userEvent.click(await screen.findByText("Memory"));

      await waitFor(() => {
        expect(mockFetchMemoryFiles).toHaveBeenCalledWith(undefined);
        expect(mockFetchMemoryFile).toHaveBeenCalledWith(".fusion/memory/DREAMS.md", undefined);
      });

      const editor = await screen.findByLabelText("Editor for .fusion/memory/DREAMS.md") as HTMLTextAreaElement;
      expect(editor.value).toContain("Existing dreams");
    });

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

      await waitFor(() => {
        expect(screen.getByLabelText("Editor for .fusion/memory/DREAMS.md")).toBeDefined();
      });
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

      const editor = await screen.findByLabelText("Editor for .fusion/memory/MEMORY.md");
      fireEvent.change(editor, { target: { value: "# Updated memory\n- Reusable learning" } });

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

      const editor = await screen.findByLabelText("Editor for .fusion/memory/DREAMS.md") as HTMLTextAreaElement;
      expect(editor.value).toContain("Compacted Memory");
      expect(addToast).toHaveBeenCalledWith("Memory file compacted", "success");
    });

    it("handles empty memory content from API", async () => {
      mockFetchMemoryFile.mockResolvedValueOnce({ path: ".fusion/memory/DREAMS.md", content: "" });
      renderModal();

      await waitFor(() => {
        expect(mockFetchSettings).toHaveBeenCalled();
      });

      await userEvent.click(await screen.findByText("Memory"));

      const editor = await screen.findByLabelText("Editor for .fusion/memory/DREAMS.md") as HTMLTextAreaElement;
      expect(editor.value).toBe("");
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

      const editor = await screen.findByLabelText("Editor for .fusion/memory/DREAMS.md") as HTMLTextAreaElement;
      expect(editor.value).toContain("Dreams");
    });
  });

  describe("Merge section", () => {
    it("shows push-after-merge toggle and keeps Push Remote hidden by default", async () => {
      renderModal();

      await waitFor(() => {
        expect(mockFetchSettings).toHaveBeenCalled();
      });

      await userEvent.click(screen.getAllByText("Merge")[0]);

      const pushAfterMergeToggle = screen.getByRole("checkbox", {
        name: /push to remote after merge/i,
      });
      expect(pushAfterMergeToggle).not.toBeChecked();
      expect(screen.queryByLabelText("Push Remote")).not.toBeInTheDocument();
    });

    it("merge option descriptions are hidden behind disclosure by default", async () => {
      renderModal();

      await waitForSettingsModalReady();
      await userEvent.click(screen.getAllByText("Merge")[0]);

      const autoMergeDescription = screen.getByText(/When enabled, tasks that pass review are automatically merged/i);
      const disclosure = autoMergeDescription.closest("details");

      expect(disclosure).not.toBeNull();
      expect(disclosure).not.toHaveAttribute("open");
      expect(autoMergeDescription).not.toBeVisible();
    });

    it("merge option descriptions are revealed when clicking More details", async () => {
      renderModal();

      await waitForSettingsModalReady();
      await userEvent.click(screen.getAllByText("Merge")[0]);

      const moreDetailsSummaries = screen.getAllByText("More details");
      await userEvent.click(moreDetailsSummaries[0]);

      expect(screen.getByText(/When enabled, tasks that pass review are automatically merged/i)).toBeVisible();
    });

    it("loads workflow revision fork checkbox from project settings", async () => {
      renderModal({ initialSection: "merge" });
      await waitForSettingsModalReady();

      const checkbox = screen.getByRole("checkbox", {
        name: /fork scope-mismatched workflow revisions into follow-up tasks/i,
      });
      expect(checkbox).toBeChecked();
    });

    it("saves workflow revision fork checkbox changes", async () => {
      renderModal({ initialSection: "merge" });
      await waitForSettingsModalReady();

      const checkbox = screen.getByRole("checkbox", {
        name: /fork scope-mismatched workflow revisions into follow-up tasks/i,
      });
      await userEvent.click(checkbox);
      await userEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalledTimes(1);
      });

      const payload = mockUpdateSettings.mock.calls[0][0] as Record<string, unknown>;
      expect(payload.workflowRevisionForkOnScopeMismatch).toBe(false);
    });

    it("shows Push Remote input when push-after-merge is enabled", async () => {
      renderModal();

      await waitFor(() => {
        expect(mockFetchSettings).toHaveBeenCalled();
      });

      await userEvent.click(screen.getAllByText("Merge")[0]);
      await userEvent.click(
        screen.getByRole("checkbox", { name: /push to remote after merge/i }),
      );

      expect(screen.getByLabelText("Push Remote")).toBeInTheDocument();
      expect(screen.getByPlaceholderText("origin")).toBeInTheDocument();
    });

    it("includes pushAfterMerge and pushRemote in the save payload", async () => {
      renderModal();

      await waitFor(() => {
        expect(mockFetchSettings).toHaveBeenCalled();
      });

      await userEvent.click(screen.getAllByText("Merge")[0]);
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

    describe("verificationFixRetries", () => {
      it("shows default value 3 when verificationFixRetries is not set", async () => {
        mockFetchSettings.mockResolvedValueOnce({
          ...defaultSettings,
          verificationFixRetries: undefined,
        });

        renderModal({ initialSection: "merge" });
        await waitForSettingsModalReady();

        const retriesInput = screen.getByLabelText("Verification auto-fix retries") as HTMLInputElement;
        expect(retriesInput.value).toBe("3");
      });

      it.each([0, 1, 2, 3])("persists valid value %i", async (value) => {
        renderModal({ initialSection: "merge" });
        await waitForSettingsModalReady();

        const retriesInput = screen.getByLabelText("Verification auto-fix retries") as HTMLInputElement;
        fireEvent.change(retriesInput, { target: { value: String(value) } });
        await userEvent.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => {
          expect(mockUpdateSettings).toHaveBeenCalledTimes(1);
        });

        const payload = mockUpdateSettings.mock.calls[0][0] as Record<string, unknown>;
        expect(payload.verificationFixRetries).toBe(value);
      });

      it("clamps out-of-range values", async () => {
        renderModal({ initialSection: "merge" });
        await waitForSettingsModalReady();

        const retriesInput = screen.getByLabelText("Verification auto-fix retries") as HTMLInputElement;

        fireEvent.change(retriesInput, { target: { value: "5" } });
        expect(retriesInput.value).toBe("3");

        fireEvent.change(retriesInput, { target: { value: "-1" } });
        expect(retriesInput.value).toBe("0");
      });

      it("saving after clearing input persists undefined and falls back to visible default 3", async () => {
        renderModal({ initialSection: "merge" });
        await waitForSettingsModalReady();

        const retriesInput = screen.getByLabelText("Verification auto-fix retries") as HTMLInputElement;
        await userEvent.clear(retriesInput);
        await userEvent.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => {
          expect(mockUpdateSettings).toHaveBeenCalledTimes(1);
        });

        const payload = mockUpdateSettings.mock.calls[0][0] as Record<string, unknown>;
        expect(payload.verificationFixRetries).toBeUndefined();
        expect(retriesInput.value).toBe("3");
      });
    });

    it("renders and saves github issue tracking controls", async () => {
      renderModal({ initialSection: "merge" });
      await waitForSettingsModalReady();

      expect(screen.getByRole("heading", { name: "GitHub Issue Tracking" })).toBeInTheDocument();
      expect(screen.getByRole("checkbox", { name: "Default GitHub tracking ON for new tasks" })).not.toBeChecked();
      expect(screen.getByLabelText("Project default tracking repo")).toBeInTheDocument();

      const authModeSelect = screen.getByLabelText("GitHub auth mode") as HTMLSelectElement;
      expect(authModeSelect.value).toBe("gh-cli");
      expect(screen.queryByLabelText("GitHub personal access token")).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole("checkbox", { name: "Default GitHub tracking ON for new tasks" }));
      await userEvent.type(screen.getByLabelText("Project default tracking repo"), "octo/repo");
      await userEvent.selectOptions(authModeSelect, "token");
      await userEvent.type(screen.getByLabelText("GitHub personal access token"), "ghp_test_token");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalled();
      });

      const payload = mockUpdateSettings.mock.calls[0][0] as Record<string, unknown>;
      expect(payload.githubTrackingEnabledByDefault).toBe(true);
      expect(payload.githubTrackingDefaultRepo).toBe("octo/repo");
      expect(payload.githubAuthMode).toBe("token");
      expect(payload.githubAuthToken).toBe("ghp_test_token");

      if (mockUpdateGlobalSettings.mock.calls.length > 0) {
        const globalPayload = mockUpdateGlobalSettings.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(globalPayload.githubTrackingDefaultRepo).toBeUndefined();
      }
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

    it("shows known experimental features (Insights, Roadmaps) even when no custom features are configured", async () => {
      renderModal();

      await openExperimentalFeaturesSection();

      // Known features should always be shown
      expect(screen.getByText("Insights")).toBeInTheDocument();
      expect(screen.getByText("Roadmaps")).toBeInTheDocument();
    });

    it("shows researchView in the Experimental Features list", async () => {
      renderModal();

      await openExperimentalFeaturesSection();

      expect(screen.getByLabelText("Research View")).toBeInTheDocument();
    });

    it("shows evalsView in the Experimental Features list", async () => {
      renderModal();

      await openExperimentalFeaturesSection();

      expect(screen.getByLabelText("Evals View")).toBeInTheDocument();
    });

    it("shows chatRooms in the Experimental Features list", async () => {
      renderModal();

      await openExperimentalFeaturesSection();

      expect(screen.getByLabelText("Chat Rooms")).toBeInTheDocument();
    });

    it("shows agentOnboarding in the Experimental Features list", async () => {
      renderModal();

      await openExperimentalFeaturesSection();

      expect(screen.getByLabelText("Planning-style Agent Onboarding")).toBeInTheDocument();
    });

    it("shows a single canonical Dev Server toggle", async () => {
      renderModal();

      await openExperimentalFeaturesSection();

      const devServerToggles = screen.getAllByLabelText("Dev Server");
      expect(devServerToggles).toHaveLength(1);
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
        expect(screen.getByRole("heading", { name: "Authentication" })).toBeInTheDocument();
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
        expect(screen.getByRole("heading", { name: "Authentication" })).toBeInTheDocument();
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
        expect(screen.getByRole("heading", { name: "Authentication" })).toBeInTheDocument();
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
    beforeEach(() => {
      mockFetchSettings.mockResolvedValue({
        ...defaultSettings,
        experimentalFeatures: { remoteAccess: true },
      });
    });

    const openRemoteSection = async () => {
      const [remoteSectionButton] = await screen.findAllByRole("button", { name: /Remote Access/i });
      await userEvent.click(remoteSectionButton);
      await screen.findByRole("heading", { name: "Remote Access" });
    };

    const openAdvancedSettings = async () => {
      const summary = screen.getByText("Advanced Settings");
      await userEvent.click(summary);
    };

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

    it("shows provider-specific settings when provider selected and auto-saves on Start Tunnel", async () => {
      renderModal();
      await waitForSettingsModalReady();
      await openRemoteSection();

      await userEvent.click(screen.getByLabelText("Tailscale"));
      expect(screen.queryByLabelText("Hostname label")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Target port")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Accept routes")).toBeInTheDocument();
      expect(screen.queryByLabelText("Tunnel name")).not.toBeInTheDocument();

      await userEvent.click(screen.getByLabelText("Cloudflare"));
      expect(screen.queryByLabelText("Accept routes")).not.toBeInTheDocument();

      if (!screen.queryByLabelText("Tunnel name")) {
        const advancedDetails = screen.getByText(/Advanced \(Named Tunnel\)/i, { selector: "summary" }).closest("details") as HTMLDetailsElement;
        advancedDetails.open = true;
        fireEvent(advancedDetails, new Event("toggle"));
        await waitFor(() => {
          expect(screen.getByLabelText("Tunnel name")).toBeInTheDocument();
        });
      }
      await userEvent.clear(screen.getByLabelText("Tunnel name"));
      await userEvent.type(screen.getByLabelText("Tunnel name"), "cf-team");
      await userEvent.clear(screen.getByLabelText("Tunnel token"));
      await userEvent.type(screen.getByLabelText("Tunnel token"), "cf_token");
      await userEvent.clear(screen.getByLabelText("Ingress URL"));
      await userEvent.type(screen.getByLabelText("Ingress URL"), "https://remote.example.com");

      await userEvent.click(screen.getByRole("button", { name: "Start Tunnel" }));

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
      renderModal();
      await waitForSettingsModalReady();
      await openRemoteSection();

      await userEvent.click(screen.getByLabelText("Cloudflare"));
      const namedTunnelSummary = screen.getByText(/Advanced \(Named Tunnel\)/i, { selector: "summary" });

      if (!screen.queryByLabelText("Tunnel name")) {
        await userEvent.click(namedTunnelSummary);
      }
      await waitFor(() => {
        expect(screen.getByLabelText("Tunnel name")).toBeInTheDocument();
      });

      await userEvent.click(screen.getByRole("button", { name: "Start Tunnel" }));
      await waitFor(() => {
        expect(mockUpdateRemoteSettings).toHaveBeenCalledWith(expect.objectContaining({ remoteCloudflareQuickTunnel: false }), undefined);
      });

      // Closing <details> is not consistently simulated in jsdom; verify default quick-tunnel state via a fresh render below.
    });

    it("updates provider selection via radio and shows provider status", async () => {
      mockFetchRemoteStatus
        .mockResolvedValueOnce({ provider: null, state: "stopped", url: null, lastError: null })
        .mockResolvedValueOnce({ provider: "tailscale", state: "running", url: "https://tail.example", lastError: null });

      renderModal();
      await waitForSettingsModalReady();
      await openRemoteSection();

      await userEvent.click(screen.getByLabelText("Tailscale"));
      expect(screen.getByLabelText("Tailscale")).toBeChecked();

      await userEvent.click(screen.getByRole("button", { name: "Start Tunnel" }));
      await waitFor(() => {
        expect(screen.getByText("https://tail.example", { selector: ".remote-status-url" })).toBeInTheDocument();
      });
    });

    it("shows cloudflared available indicator when Cloudflare is selected and cloudflared is installed", async () => {
      mockFetchRemoteStatus.mockResolvedValue({ provider: "cloudflare", state: "stopped", url: null, lastError: null, cloudflaredAvailable: true });

      renderModal();
      await waitForSettingsModalReady();
      await openRemoteSection();
      await userEvent.click(screen.getByLabelText("Cloudflare"));

      expect(await screen.findByText("cloudflared is installed")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Install cloudflared" })).not.toBeInTheDocument();
    });

    it("renders branded Cloudflare icon in Remote provider selector", async () => {
      renderModal();
      await waitForSettingsModalReady();
      await openRemoteSection();

      const cloudflareSlot = screen.getByTestId("remote-provider-icon-cloudflare");
      expect(within(cloudflareSlot).getByTestId("remote-cloudflare-option-icon")).toBeInTheDocument();
    });

    it("shows install button when Cloudflare is selected and cloudflared is not available", async () => {
      mockFetchRemoteStatus.mockResolvedValue({ provider: "cloudflare", state: "stopped", url: null, lastError: null, cloudflaredAvailable: false });

      renderModal();
      await waitForSettingsModalReady();
      await openRemoteSection();
      await userEvent.click(screen.getByLabelText("Cloudflare"));

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
      await userEvent.click(screen.getByLabelText("Cloudflare"));

      const installButton = await screen.findByRole("button", { name: "Install cloudflared" });
      await userEvent.click(installButton);

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
      await userEvent.click(screen.getByLabelText("Cloudflare"));

      await userEvent.click(await screen.findByRole("button", { name: "Install cloudflared" }));

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

      await userEvent.click(screen.getByLabelText("Tailscale"));
      expect(screen.getByRole("button", { name: "Start Tunnel" })).toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: "Start Tunnel" }));
      await waitFor(() => {
        expect(mockUpdateRemoteSettings).toHaveBeenCalled();
        expect(mockStartRemoteTunnel).toHaveBeenCalledTimes(1);
      });
      await waitFor(() => {
        expect(screen.getByText("starting")).toBeInTheDocument();
      });

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Stop Tunnel" })).toBeInTheDocument();
      });

      await userEvent.click(screen.getByRole("button", { name: "Stop Tunnel" }));
      await waitFor(() => {
        expect(mockStopRemoteTunnel).toHaveBeenCalledTimes(1);
      });
      await userEvent.click(screen.getByRole("button", { name: "Stop Tunnel" }));
      await waitFor(() => {
        expect(mockStopRemoteTunnel).toHaveBeenCalledTimes(2);
      });
      await waitFor(() => {
        expect(screen.getByText("Tunnel crashed")).toBeInTheDocument();
      });
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
      await userEvent.click(screen.getByLabelText("Tailscale"));

      await userEvent.click(await screen.findByRole("button", { name: "Start Fresh" }));

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
      await userEvent.click(screen.getByLabelText("Tailscale"));
      await openAdvancedSettings();

      await userEvent.click(screen.getByRole("button", { name: "Regenerate persistent token" }));

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
      await userEvent.click(screen.getByLabelText("Tailscale"));
      await openAdvancedSettings();

      await userEvent.selectOptions(screen.getByLabelText("Auth link token type"), "short-lived");
      const ttlInput = screen.getByLabelText("Short-lived TTL (ms)") as HTMLInputElement;
      fireEvent.change(ttlInput, { target: { value: "120000" } });

      await userEvent.click(screen.getByRole("button", { name: "Generate short-lived token" }));
      await waitFor(() => {
        expect(mockGenerateShortLivedRemoteToken).toHaveBeenCalledWith(120000, undefined);
      });

      fireEvent.change(ttlInput, { target: { value: "120000" } });
      await userEvent.click(screen.getByRole("button", { name: "Show URL" }));
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
      await userEvent.click(screen.getByLabelText("Tailscale"));
      await openAdvancedSettings();

      await userEvent.click(screen.getByRole("button", { name: "Generate QR" }));
      await waitFor(() => {
        expect(mockFetchRemoteQr).toHaveBeenNthCalledWith(1, "image/svg", expect.objectContaining({ tokenType: "persistent" }));
      });
      expect(await screen.findByRole("img", { name: "Remote access QR code" })).toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: "Generate QR" }));
      await waitFor(() => {
        expect(screen.queryByRole("img", { name: "Remote access QR code" })).not.toBeInTheDocument();
      });
      expect(screen.getByText("https://remote.example.com/qr-text")).toBeInTheDocument();
    });

    it("Start Tunnel button is disabled when no provider is selected", async () => {
      renderModal();
      await waitForSettingsModalReady();
      await openRemoteSection();

      const startButton = screen.getByRole("button", { name: "Start Tunnel" });
      expect(startButton).toBeDisabled();
      await userEvent.click(screen.getByLabelText("Tailscale"));
      expect(startButton).not.toBeDisabled();
    });

    it("no separate Activate Provider or Save Remote Settings buttons exist", async () => {
      renderModal();
      await waitForSettingsModalReady();
      await openRemoteSection();

      expect(screen.queryByRole("button", { name: /Activate Provider/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Save Remote Settings/i })).not.toBeInTheDocument();
    });

    it("only the selected provider's settings are rendered", async () => {
      renderModal();
      await waitForSettingsModalReady();
      await openRemoteSection();

      await userEvent.click(screen.getByLabelText("Tailscale"));
      expect(screen.getByLabelText("Accept routes")).toBeInTheDocument();
      expect(screen.queryByText(/Advanced \(Named Tunnel\)/i)).not.toBeInTheDocument();

      await userEvent.click(screen.getByLabelText("Cloudflare"));
      expect(screen.getByText(/Advanced \(Named Tunnel\)/i)).toBeInTheDocument();
      expect(screen.queryByLabelText("Accept routes")).not.toBeInTheDocument();
    });

    it("sets quick tunnel false when opening Cloudflare advanced details", async () => {
      renderModal();
      await waitForSettingsModalReady();
      await openRemoteSection();
      await userEvent.click(screen.getByLabelText("Cloudflare"));

      const namedTunnelSummary = screen.getByText(/Advanced \(Named Tunnel\)/i, { selector: "summary" });
      if (!screen.queryByLabelText("Tunnel name")) {
        await userEvent.click(namedTunnelSummary);
      }
      await userEvent.click(screen.getByRole("button", { name: "Start Tunnel" }));
      await waitFor(() => {
        expect(mockUpdateRemoteSettings).toHaveBeenCalledWith(expect.objectContaining({ remoteCloudflareQuickTunnel: false }), undefined);
      });

    });

    it("Start Tunnel auto-saves with enabled=true on selected provider before starting", async () => {
      renderModal();
      await waitForSettingsModalReady();
      await openRemoteSection();

      await userEvent.click(screen.getByLabelText("Tailscale"));
      await userEvent.click(screen.getByRole("button", { name: "Start Tunnel" }));

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


  describe("Notifications provider cards", () => {
    const openNotificationsSection = async () => {
      await userEvent.click(await screen.findByRole("button", { name: /Notifications/ }));
    };

    it("shows ntfy and webhook provider cards in notifications section", async () => {
      renderModal();
      await waitForSettingsModalReady();
      await openNotificationsSection();

      expect(screen.getByText("ntfy")).toBeInTheDocument();
      expect(screen.getByText("Webhook")).toBeInTheDocument();
    });

    it("shows ntfy fields when ntfy provider is enabled", async () => {
      mockFetchSettings.mockResolvedValueOnce({ ...defaultSettings, ntfyEnabled: true, ntfyTopic: "test-topic" });
      renderModal();
      await waitForSettingsModalReady();
      await openNotificationsSection();

      expect(screen.getByLabelText("ntfy Topic")).toBeInTheDocument();
      expect(screen.getByLabelText("Dashboard Hostname")).toBeInTheDocument();
      expect(screen.getByText("Notify on events")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Test notification/ })).toBeInTheDocument();

      await userEvent.click(screen.getByText("Advanced"));
      expect(screen.getByLabelText("Access token (optional)")).toBeInTheDocument();
    });

    it("shows fallback, dreams, and mailbox/room message events for both providers", async () => {
      mockFetchSettings.mockResolvedValueOnce({ ...defaultSettings, ntfyEnabled: true, ntfyTopic: "test-topic" });
      renderModal();
      await waitForSettingsModalReady();
      await openNotificationsSection();

      expect(screen.getByLabelText("Fallback model used (recovered)")).toBeInTheDocument();
      expect(screen.getByLabelText("DREAMS.md entry added")).toBeInTheDocument();
      const agentToUserNtfy = screen.getByLabelText("Agent → user message") as HTMLInputElement;
      const agentToAgentNtfy = screen.getByLabelText("Agent → agent message") as HTMLInputElement;
      const roomMessageNtfy = screen.getByLabelText("Agent message in room") as HTMLInputElement;
      expect(agentToUserNtfy.checked).toBe(true);
      expect(agentToAgentNtfy.checked).toBe(true);
      expect(roomMessageNtfy.checked).toBe(true);

      await userEvent.click(screen.getByLabelText("Webhook notifications"));
      expect(screen.getAllByLabelText("Fallback model used (recovered)").length).toBeGreaterThan(0);
      expect(screen.getAllByLabelText("DREAMS.md entry added").length).toBeGreaterThan(0);
      const [agentToUserWebhook] = screen.getAllByLabelText("Agent → user message") as HTMLInputElement[];
      const [agentToAgentWebhook] = screen.getAllByLabelText("Agent → agent message") as HTMLInputElement[];
      const [roomMessageWebhook] = screen.getAllByLabelText("Agent message in room") as HTMLInputElement[];
      expect(agentToUserWebhook.checked).toBe(true);
      expect(agentToAgentWebhook.checked).toBe(true);
      expect(roomMessageWebhook.checked).toBe(true);
    });

    it("shows webhook fields when webhook provider is enabled", async () => {
      renderModal();
      await waitForSettingsModalReady();
      await openNotificationsSection();
      await userEvent.click(screen.getByLabelText("Webhook notifications"));

      expect(screen.getByLabelText("Webhook URL")).toBeInTheDocument();
      expect(screen.getByLabelText("Format")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Test notification/ })).toBeInTheDocument();
    });

    it("hides ntfy body when ntfy is disabled", async () => {
      renderModal();
      await waitForSettingsModalReady();
      await openNotificationsSection();
      expect(screen.queryByLabelText("ntfy Topic")).not.toBeInTheDocument();
    });

    it("hides webhook body when webhook is disabled", async () => {
      renderModal();
      await waitForSettingsModalReady();
      await openNotificationsSection();
      expect(screen.queryByLabelText("Webhook URL")).not.toBeInTheDocument();
    });

    it("calls testNotification with ntfy provider ID when ntfy test button clicked", async () => {
      mockFetchSettings.mockResolvedValueOnce({ ...defaultSettings, ntfyEnabled: true, ntfyTopic: "test-topic" });
      renderModal();
      await waitForSettingsModalReady();
      await openNotificationsSection();
      await userEvent.click(screen.getByText("Advanced"));
      await userEvent.type(screen.getByLabelText("Access token (optional)"), "secret-token");

      await userEvent.click(screen.getByRole("button", { name: /Test notification/ }));

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
      await userEvent.click(screen.getByText("Advanced"));
      const tokenInput = screen.getByLabelText("Access token (optional)");
      await userEvent.clear(tokenInput);
      await userEvent.click(screen.getByRole("button", { name: "Save" }));

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

      await userEvent.click(screen.getByRole("button", { name: /Test message notification/ }));

      await waitFor(() => {
        expect(mockTestNotification).toHaveBeenCalledWith(
          "ntfy",
          { messageEventType: "message:agent-to-user" },
          undefined,
        );
      });
      expect(addToast).toHaveBeenCalledWith(
        "Test notification sent — check your ntfy app inbox!",
        "success",
      );
      expect(screen.getByText("Test notification sent — check your ntfy app inbox!")).toBeInTheDocument();
      expect(screen.getAllByText("Test notification sent — check your ntfy app inbox!")[0].closest(".notification-test-feedback")).toHaveAttribute("aria-live", "polite");
    });

    it("calls testNotification with ntfy room-event config when room test button clicked", async () => {
      const addToast = vi.fn();
      mockFetchSettings.mockResolvedValueOnce({ ...defaultSettings, ntfyEnabled: true, ntfyTopic: "test-topic" });
      renderModal({ addToast });
      await waitForSettingsModalReady();
      await openNotificationsSection();

      await userEvent.click(screen.getByRole("button", { name: /Send test room notification/ }));

      await waitFor(() => {
        expect(mockTestNotification).toHaveBeenCalledWith(
          "ntfy",
          { messageEventType: "message:room" },
          undefined,
        );
      });
      expect(addToast).toHaveBeenCalledWith(
        "Test notification sent — check your ntfy app inbox!",
        "success",
      );
    });

    it("calls testNotification with webhook provider ID when webhook test button clicked", async () => {
      renderModal();
      await waitForSettingsModalReady();
      await openNotificationsSection();
      await userEvent.click(screen.getByLabelText("Webhook notifications"));
      await userEvent.type(screen.getByLabelText("Webhook URL"), "https://hooks.example.com/test");

      const webhookCard = screen.getByText("Webhook").closest(".notification-provider-card") as HTMLElement;
      await userEvent.click(within(webhookCard).getByRole("button", { name: /Test notification/ }));

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

    it("saves global research defaults through updateGlobalSettings only", async () => {
      renderModal();
      await waitForSettingsModalReady();
      await openResearchGlobalSection();

      await userEvent.click(screen.getByText(/Advanced — external search providers/i));
      const providerSelect = await screen.findByLabelText("Search Provider");
      fireEvent.change(providerSelect, { target: { value: "tavily" } });
      await userEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdateGlobalSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            researchGlobalDefaults: expect.objectContaining({ searchProvider: "tavily" }),
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

      const webSearch = await screen.findByLabelText("Web Search");
      expect(webSearch).toBeChecked();
      expect(webSearch).toBeDisabled();
      expect(screen.getByText(/Always on\./i)).toBeInTheDocument();
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
      expect(await screen.findByRole("heading", { name: "Authentication" })).toBeInTheDocument();
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
