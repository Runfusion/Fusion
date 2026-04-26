import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsModal } from "../SettingsModal";
import type { SettingsExportData } from "../../api";

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
const mockFetchRemoteSettings = vi.fn();
const mockUpdateRemoteSettings = vi.fn();
const mockFetchRemoteStatus = vi.fn();
const mockActivateRemoteProvider = vi.fn();
const mockStartRemoteTunnel = vi.fn();
const mockStopRemoteTunnel = vi.fn();
const mockRegenerateRemotePersistentToken = vi.fn();
const mockGenerateShortLivedRemoteToken = vi.fn();
const mockFetchRemoteQr = vi.fn();
const mockFetchRemoteUrl = vi.fn();
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
  fetchRemoteSettings: (...args: unknown[]) => mockFetchRemoteSettings(...args),
  updateRemoteSettings: (...args: unknown[]) => mockUpdateRemoteSettings(...args),
  fetchRemoteStatus: (...args: unknown[]) => mockFetchRemoteStatus(...args),
  activateRemoteProvider: (...args: unknown[]) => mockActivateRemoteProvider(...args),
  startRemoteTunnel: (...args: unknown[]) => mockStartRemoteTunnel(...args),
  stopRemoteTunnel: (...args: unknown[]) => mockStopRemoteTunnel(...args),
  regenerateRemotePersistentToken: (...args: unknown[]) => mockRegenerateRemotePersistentToken(...args),
  generateShortLivedRemoteToken: (...args: unknown[]) => mockGenerateShortLivedRemoteToken(...args),
  fetchRemoteQr: (...args: unknown[]) => mockFetchRemoteQr(...args),
  fetchRemoteUrl: (...args: unknown[]) => mockFetchRemoteUrl(...args),
}));

// Mock the hook
const mockUseMemoryBackendStatus = vi.fn();
vi.mock("../../hooks/useMemoryBackendStatus", () => ({
  useMemoryBackendStatus: (...args: unknown[]) => mockUseMemoryBackendStatus(...args),
}));

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

describe("SettingsModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchSettings.mockResolvedValue(defaultSettings);
    mockFetchSettingsByScope.mockResolvedValue({ global: defaultSettings, project: {} });
    mockFetchAuthStatus.mockResolvedValue({ providers: [] });
    mockFetchModels.mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] });
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
    mockFetchRemoteSettings.mockResolvedValue({
      settings: {
        remoteEnabled: false,
        remoteActiveProvider: null,
        remoteTailscaleEnabled: false,
        remoteTailscaleHostname: "",
        remoteTailscaleTargetPort: 4040,
        remoteTailscaleAcceptRoutes: false,
        remoteCloudflareEnabled: false,
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
        remoteEnabled: false,
        remoteActiveProvider: null,
        remoteTailscaleEnabled: false,
        remoteTailscaleHostname: "",
        remoteTailscaleTargetPort: 4040,
        remoteTailscaleAcceptRoutes: false,
        remoteCloudflareEnabled: false,
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
    mockActivateRemoteProvider.mockResolvedValue({ activeProvider: "tailscale" });
    mockStartRemoteTunnel.mockResolvedValue({ state: "starting", provider: "tailscale" });
    mockStopRemoteTunnel.mockResolvedValue({ state: "stopped", provider: null });
    mockRegenerateRemotePersistentToken.mockResolvedValue({ token: "token", maskedToken: "****" });
    mockGenerateShortLivedRemoteToken.mockResolvedValue({ token: "short", expiresAt: new Date(Date.now() + 60000).toISOString(), ttlMs: 60000 });
    mockFetchRemoteQr.mockResolvedValue({ url: "https://remote.example.com", expiresAt: null, format: "image/svg", data: "<svg></svg>" });
    mockFetchRemoteUrl.mockResolvedValue({ url: "https://remote.example.com", tokenType: "persistent", expiresAt: null });
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

      expect(screen.getByText("Memory")).toBeDefined();
    });

    it("shows the memory toggle with default enabled", async () => {
      renderModal();

      await waitFor(() => {
        expect(mockFetchSettings).toHaveBeenCalled();
      });

      // Click the Memory section in the sidebar
      await userEvent.click(screen.getByText("Memory"));

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
      await userEvent.click(screen.getByText("Memory"));

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
      await userEvent.click(screen.getByText("Memory"));

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
      await userEvent.click(screen.getByText("Memory"));

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
      await userEvent.click(screen.getByText("Memory"));

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
      await userEvent.click(screen.getByText("Memory"));

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

      await userEvent.click(screen.getByText("Memory"));

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

      await userEvent.click(screen.getByText("Memory"));

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

      await userEvent.click(screen.getByText("Memory"));

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

      await userEvent.click(screen.getByText("Memory"));

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

      await userEvent.click(screen.getByText("Memory"));

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

      await userEvent.click(screen.getByText("Memory"));

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

    it("normalizes legacy devServer flag to canonical devServerView on save", async () => {
      mockFetchSettings.mockResolvedValue({
        ...defaultSettings,
        experimentalFeatures: { devServer: true },
      });

      renderModal();

      await openExperimentalFeaturesSection();

      const devServerToggle = screen.getByLabelText("Dev Server") as HTMLInputElement;
      expect(devServerToggle).toBeChecked();

      await userEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalledTimes(1);
      });

      const payload = mockUpdateSettings.mock.calls[0][0];
      expect(payload.experimentalFeatures).toEqual({ devServerView: true });
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

    it("renders remote access section and tunnel controls", async () => {
      renderModal();
      await waitForSettingsModalReady();

      await userEvent.click(screen.getByRole("button", { name: /Remote Access/ }));

      expect(screen.getByRole("heading", { name: "Remote Access" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Start tunnel" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Generate QR" })).toBeInTheDocument();
      expect(screen.getByLabelText("Hostname label")).toBeInTheDocument();
      expect(screen.getByLabelText("Target port")).toBeInTheDocument();
      expect(screen.getByLabelText("Tunnel name")).toBeInTheDocument();
      expect(screen.getByLabelText("Tunnel token")).toBeInTheDocument();
      expect(screen.getByLabelText("Ingress URL")).toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: "Show URL" }));
      await waitFor(() => {
        expect(mockFetchRemoteUrl).toHaveBeenCalled();
      });

      await userEvent.click(screen.getByRole("button", { name: "Generate QR" }));
      expect(await screen.findByRole("img", { name: "Remote access QR code" })).toBeInTheDocument();
      expect(screen.getByText("Scan this QR code on your phone")).toBeInTheDocument();
    });
  });
});
