import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsModal } from "../SettingsModal";
import type { SettingsExportData, UpdateCheckResponse } from "../../api";

// --- API mocks ---
const mockFetchSettings = vi.fn();
const mockFetchSettingsByScope = vi.fn();
const mockExportSettings = vi.fn();
const mockUpdateSettings = vi.fn();
const mockUpdateGlobalSettings = vi.fn();
const mockFetchAuthStatus = vi.fn();
const mockLoginProvider = vi.fn();
const mockLogoutProvider = vi.fn();
const mockFetchModels = vi.fn();
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
const mockStartRemoteTunnel = vi.fn();
const mockStopRemoteTunnel = vi.fn();
const mockRegenerateRemotePersistentToken = vi.fn();
const mockGenerateShortLivedRemoteToken = vi.fn();
const mockFetchRemoteQr = vi.fn();
const mockFetchRemoteUrl = vi.fn();
const mockTriggerMemoryDreams = vi.fn();
const mockUseWorkspaceFileBrowser = vi.fn();

vi.mock("../../api", () => ({
  fetchSettings: (...args: unknown[]) => mockFetchSettings(...args),
  fetchSettingsByScope: (...args: unknown[]) => mockFetchSettingsByScope(...args),
  updateSettings: (...args: unknown[]) => mockUpdateSettings(...args),
  updateGlobalSettings: (...args: unknown[]) => mockUpdateGlobalSettings(...args),
  exportSettings: (...args: unknown[]) => mockExportSettings(...args),
  importSettings: (...args: unknown[]) => mockImportSettings(...args),
  fetchAuthStatus: (...args: unknown[]) => mockFetchAuthStatus(...args),
  loginProvider: (...args: unknown[]) => mockLoginProvider(...args),
  logoutProvider: (...args: unknown[]) => mockLogoutProvider(...args),
  fetchModels: (...args: unknown[]) => mockFetchModels(...args),
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
  startRemoteTunnel: (...args: unknown[]) => mockStartRemoteTunnel(...args),
  stopRemoteTunnel: (...args: unknown[]) => mockStopRemoteTunnel(...args),
  regenerateRemotePersistentToken: (...args: unknown[]) => mockRegenerateRemotePersistentToken(...args),
  generateShortLivedRemoteToken: (...args: unknown[]) => mockGenerateShortLivedRemoteToken(...args),
  fetchRemoteQr: (...args: unknown[]) => mockFetchRemoteQr(...args),
  fetchRemoteUrl: (...args: unknown[]) => mockFetchRemoteUrl(...args),
  triggerMemoryDreams: (...args: unknown[]) => mockTriggerMemoryDreams(...args),
}));

// Mock the hook
const mockUseMemoryBackendStatus = vi.fn();
vi.mock("../../hooks/useMemoryBackendStatus", () => ({
  useMemoryBackendStatus: (...args: unknown[]) => mockUseMemoryBackendStatus(...args),
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

vi.mock("../PluginSlot", () => ({
  PluginSlot: () => <div data-testid="plugin-slot">Plugin slot content</div>,
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
  recycleWorktrees: false,
  worktreeNaming: "random",
  includeTaskIdInCommit: true,
  worktreeInitCommand: "",
  ntfyEnabled: false,
  ntfyTopic: undefined,
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
  beforeEach(() => {
    vi.clearAllMocks();
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
    mockFetchModels.mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] });
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
    mockStartRemoteTunnel.mockResolvedValue({ state: "starting", provider: "tailscale" });
    mockStopRemoteTunnel.mockResolvedValue({ state: "stopped", provider: null });
    mockRegenerateRemotePersistentToken.mockResolvedValue({ token: "token", maskedToken: "****" });
    mockGenerateShortLivedRemoteToken.mockResolvedValue({ token: "short", expiresAt: new Date(Date.now() + 60000).toISOString(), ttlMs: 60000 });
    mockFetchRemoteQr.mockResolvedValue({ url: "https://remote.example.com", tokenType: "persistent", expiresAt: null, format: "image/svg", data: "<svg></svg>" });
    mockFetchRemoteUrl.mockResolvedValue({ url: "https://remote.example.com", tokenType: "persistent", expiresAt: null });
    mockTriggerMemoryDreams.mockResolvedValue({ success: true, summary: "done" });
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

  describe("Project Models", () => {
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
        ],
      });

      renderModal();
      await waitForSettingsModalReady();

      expect(screen.getByTestId("auth-provider-icon-github")).toBeInTheDocument();
      expect(screen.getByTestId("auth-provider-icon-openai")).toBeInTheDocument();
      expect(screen.getByTestId("auth-status-github")).toHaveTextContent("✓ Active");
      expect(screen.getByTestId("auth-status-openai")).toHaveTextContent("✗ Not connected");
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
      expect(screen.getByTestId("plugin-slot")).toBeInTheDocument();
      expect(screen.queryByTestId("pi-extensions-manager")).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole("tab", { name: "Pi Extensions" }));

      await waitFor(() => {
        expect(screen.getByTestId("pi-extensions-manager")).toBeInTheDocument();
      });
      expect(screen.queryByTestId("plugin-manager")).not.toBeInTheDocument();
      expect(screen.queryByTestId("plugin-slot")).not.toBeInTheDocument();
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

    describe("Remote Access section visibility", () => {
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
        expect(mockUpdateSettings).toHaveBeenCalledTimes(1);
      });

      const payload = mockUpdateSettings.mock.calls[0][0];
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
        expect(mockUpdateSettings).toHaveBeenCalledTimes(1);
      });

      const payload = mockUpdateSettings.mock.calls[0][0];
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
        expect(mockUpdateSettings).toHaveBeenCalledTimes(1);
      });

      const payload = mockUpdateSettings.mock.calls[0][0];
      expect(payload.experimentalFeatures).toEqual({ "my-feature": true });
    });

    it("shows project scope banner in Experimental Features section", async () => {
      renderModal();

      await openExperimentalFeaturesSection();

      // Should show project scope indicator
      expect(screen.getByText(/only affect this project/i)).toBeInTheDocument();
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
        expect(mockUpdateSettings).toHaveBeenCalledTimes(1);
      });

      const payload = mockUpdateSettings.mock.calls[0][0];
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

    it("shows provider-specific settings when provider selected and auto-saves on Start Tunnel", async () => {
      renderModal();
      await waitForSettingsModalReady();
      await openRemoteSection();

      await userEvent.click(screen.getByLabelText("Tailscale"));
      expect(screen.getByLabelText("Hostname label")).toBeInTheDocument();
      expect(screen.getByLabelText("Target port")).toBeInTheDocument();
      expect(screen.getByLabelText("Accept routes")).toBeInTheDocument();
      expect(screen.queryByLabelText("Tunnel name")).not.toBeInTheDocument();

      await userEvent.clear(screen.getByLabelText("Hostname label"));
      await userEvent.type(screen.getByLabelText("Hostname label"), "tail-new.ts.net");
      fireEvent.change(screen.getByLabelText("Target port"), { target: { value: "4242" } });

      await userEvent.click(screen.getByLabelText("Cloudflare"));
      expect(screen.queryByLabelText("Hostname label")).not.toBeInTheDocument();

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
        expect(screen.getByText("https://tail.example")).toBeInTheDocument();
      });
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
      expect(screen.getByLabelText("Hostname label")).toBeInTheDocument();
      expect(screen.queryByText(/Advanced \(Named Tunnel\)/i)).not.toBeInTheDocument();

      await userEvent.click(screen.getByLabelText("Cloudflare"));
      expect(screen.getByText(/Advanced \(Named Tunnel\)/i)).toBeInTheDocument();
      expect(screen.queryByLabelText("Hostname label")).not.toBeInTheDocument();
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

      await userEvent.click(screen.getByRole("button", { name: /Test notification/ }));

      await waitFor(() => {
        expect(mockTestNotification).toHaveBeenCalledWith(
          "ntfy",
          expect.objectContaining({ ntfyEnabled: true, ntfyTopic: "test-topic" }),
          undefined,
        );
      });
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
      expect(inReview.checked).toBe(true);
      expect(failed.checked).toBe(true);
      expect(merged.checked).toBe(false);
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
