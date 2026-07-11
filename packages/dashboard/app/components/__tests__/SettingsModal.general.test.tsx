import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react";
import path from "path";
import { SettingsModal } from "../SettingsModal";
import {
  mockFetchSettings,
  mockFetchSettingsByScope,
  mockExportSettings,
  mockUpdateSettings,
  mockUpdateGlobalSettings,
  mockFetchAuthStatus,
  mockLoginProvider,
  mockLogoutProvider,
  mockCancelProviderLogin,
  mockSaveApiKey,
  mockSubmitProviderManualCode,
  mockFetchModels,
  mockFetchWorkflow,
  mockFetchWorkflowSettingValues,
  mockUpdateWorkflowSettingValues,
  mockFetchCustomProviders,
  mockCreateCustomProvider,
  mockUpdateCustomProvider,
  mockDeleteCustomProvider,
  mockTestNtfyNotification,
  mockTestNotification,
  mockFetchBackups,
  mockCreateBackup,
  mockImportSettings,
  mockFetchMemoryFiles,
  mockFetchMemoryFile,
  mockSaveMemoryFile,
  mockCompactMemory,
  mockFetchGlobalConcurrency,
  mockUpdateGlobalConcurrency,
  mockFetchMemoryBackendStatus,
  mockTestMemoryRetrieval,
  mockInstallQmd,
  mockFetchGitRemotes,
  mockFetchGitRemotesDetailed,
  mockFetchProjects,
  mockFetchDashboardHealth,
  mockCheckForUpdates,
  mockInstallUpdate,
  mockFetchRemoteSettings,
  mockUpdateRemoteSettings,
  mockFetchRemoteStatus,
  mockInstallCloudflared,
  mockStartRemoteTunnel,
  mockStopRemoteTunnel,
  mockKillExternalTunnel,
  mockRegenerateRemotePersistentToken,
  mockGenerateShortLivedRemoteToken,
  mockFetchRemoteQr,
  mockFetchRemoteUrl,
  mockTriggerMemoryDreams,
  mockFetchPluginUiSlots,
  mockFetchDroidCliStatus,
  mockSetDroidCliEnabled,
  mockFetchCursorCliStatus,
  mockSetCursorCliEnabled,
  mockSetCursorCliBinaryPath,
  mockUseWorkspaceFileBrowser,
  mockConfirm,
  mockUseWorktrunkInstallStatus,
  mockUseMemoryBackendStatus,
  mockUseMobileKeyboard,
  settingsModalCss,
  noop,
  defaultSettings,
  renderModal,
  waitForSettingsModalReady,
  settingsModalUser,
  expectSettingPersists,
  installSettingsModalEnv,
} from "./SettingsModal.test-harness";

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
    setCursorCliBinaryPath: (...args: unknown[]) => mockSetCursorCliBinaryPath(...args),
  });
});

// Mock the hook
vi.mock("../../hooks/useMemoryBackendStatus", () => ({
  useMemoryBackendStatus: (...args: unknown[]) => mockUseMemoryBackendStatus(...args),
}));

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

describe("SettingsModal", () => {
  installSettingsModalEnv();

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

  /*
  FNXC:SettingsSimplification 2026-07-10-23:24:
  Advanced settings must default off for a new browser, hide specialist sections from every navigation surface, and restore the browser-local preference without mutating Fusion settings.
  */
  it("hides advanced sections by default and persists the disclosure preference in local storage", async () => {
    const firstRender = renderModal({ initialSection: "authentication" });
    await waitForSettingsModalReady();

    const toggle = screen.getByRole("checkbox", { name: "Advanced settings" });
    expect(toggle).not.toBeChecked();
    expect(screen.queryByRole("button", { name: /^Node Sync$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Experimental Features$/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Appearance$/ })).toBeInTheDocument();

    await settingsModalUser.click(toggle);
    expect(localStorage.getItem("fusion:settings:show-advanced")).toBe("true");
    expect(screen.getByRole("button", { name: /^Node Sync$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Experimental Features$/ })).toBeInTheDocument();

    firstRender.unmount();
    renderModal({ initialSection: "authentication" });
    await waitForSettingsModalReady();
    expect(screen.getByRole("checkbox", { name: "Advanced settings" })).toBeChecked();
  });

  it("honors an explicit initialSection override", async () => {
    renderModal({ initialSection: "authentication" });
    await waitForSettingsModalReady();

    expect(screen.getByRole("button", { name: /^Authentication$/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Authentication" })).toBeInTheDocument();
  });

  it("filters settings navigation by section and setting-level keywords without exposing hidden sections", async () => {
    renderModal();
    await waitForSettingsModalReady();
    await settingsModalUser.click(screen.getByRole("checkbox", { name: "Advanced settings" }));

    // FN-7713: this file mocks useViewportMode to "mobile", so the search row starts collapsed
    // behind the toggle — expand it before interacting with the search input.
    await settingsModalUser.click(screen.getByLabelText("Show search"));
    const search = screen.getByTestId("settings-search-input");
    expect(screen.getByRole("button", { name: /^General$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Project General$/ })).toBeInTheDocument();

    await settingsModalUser.type(search, "   ");
    expect(screen.getByRole("button", { name: /^General$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Project General$/ })).toBeInTheDocument();

    await settingsModalUser.clear(search);
    await settingsModalUser.type(search, "completion documentation");

    expect(screen.queryByRole("button", { name: /^General$/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Project General$/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "General" })).toBeInTheDocument();
    expect(screen.getByText("1 matching sections")).toBeInTheDocument();

    await settingsModalUser.clear(search);
    await settingsModalUser.type(search, "Autonomy mode");

    expect(screen.queryByRole("button", { name: /^Project General$/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^CLI Agents$/ })).toBeInTheDocument();
    expect(screen.getByTestId("cli-agents-settings")).toBeInTheDocument();

    await settingsModalUser.clear(search);
    await settingsModalUser.type(search, "research providers");

    expect(screen.queryByRole("button", { name: /^Research Defaults$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Research$/ })).not.toBeInTheDocument();
    expect(screen.getAllByText(/No settings sections match/).length).toBeGreaterThan(0);
  });

  it("keeps duplicate global and project labels searchable while preserving no-results clearing", async () => {
    renderModal();
    await waitForSettingsModalReady();
    await settingsModalUser.click(screen.getByRole("checkbox", { name: "Advanced settings" }));

    // FN-7713: search row is collapsed by default under the "mobile" viewport mock — expand it first.
    await settingsModalUser.click(screen.getByLabelText("Show search"));
    const search = screen.getByTestId("settings-search-input");
    await settingsModalUser.type(search, "mcp");

    const matches = screen.getAllByRole("button", { name: /^MCP Servers$/ });
    expect(matches).toHaveLength(2);
    expect(screen.getByText("2 matching sections")).toBeInTheDocument();

    await settingsModalUser.clear(search);
    await settingsModalUser.type(search, "definitely not a setting");

    expect(screen.queryByRole("button", { name: /^MCP Servers$/ })).not.toBeInTheDocument();
    await settingsModalUser.click(screen.getAllByRole("button", { name: "Clear settings search" })[0]);
    expect(screen.getByRole("button", { name: /^General$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Project General$/ })).toBeInTheDocument();
  });

  it("keeps settings file pickers workspace-confined even when absolute browsing exists", async () => {
    renderModal({ initialSection: "worktrees" });
    await waitForSettingsModalReady();

    expect(mockUseWorkspaceFileBrowser).toHaveBeenCalledWith(
      "project",
      expect.any(Boolean),
      undefined,
      { allowAbsolutePaths: false },
    );
    expect(mockUseWorkspaceFileBrowser.mock.calls.filter((call) => call[0] === "project")).toEqual(
      expect.arrayContaining([
        ["project", false, undefined, { allowAbsolutePaths: false }],
      ]),
    );
  });

  // FNXC:EmbeddedPresentation 2026-06-22-12:00:
  // presentation="embedded" (SettingsView) was a zero-coverage branch. Assert the embedded contract via
  // useEmbeddedPresentation: embedded root class present, region role (not dialog), no fixed .modal-overlay
  // backdrop / modal close button, and Escape does NOT dismiss (navigated away via the left sidebar instead).
  describe("embedded presentation", () => {
    it("renders the embedded root class with region role and no modal overlay or close button", async () => {
      const { container } = renderModal({ presentation: "embedded" });
      await waitForSettingsModalReady();

      expect(container.querySelector(".settings-embedded")).not.toBeNull();
      expect(container.querySelector(".settings-modal--embedded")).not.toBeNull();
      expect(screen.getByRole("region", { name: "Settings" })).toBeInTheDocument();
      // No fixed full-screen overlay backdrop and no dialog role in embedded mode.
      expect(container.querySelector(".settings-modal-overlay")).toBeNull();
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("removes the embedded page outer inset and keeps content padding inside each settings screen", () => {
      expect(settingsModalCss).toMatch(/\.settings-embedded\.right-dock-embedded-view\s*\{[^}]*padding:\s*0;/);
      expect(settingsModalCss).toMatch(/\.settings-content\s*\{[^}]*padding:\s*var\(--space-md\) var\(--space-xl\) var\(--space-lg\);/);
      expect(settingsModalCss).toMatch(/\.settings-section-heading\s*\{[^}]*padding:\s*var\(--space-lg\) 0 var\(--space-md\);/);
    });

    it("does not dismiss on Escape in embedded mode", async () => {
      const onClose = vi.fn();
      renderModal({ presentation: "embedded", onClose });
      await waitForSettingsModalReady();

      fireEvent.keyDown(document, { key: "Escape" });
      expect(onClose).not.toHaveBeenCalled();
    });

    it("renders settings search and clears Escape without closing embedded Settings", async () => {
      const onClose = vi.fn();
      renderModal({ presentation: "embedded", onClose });
      await waitForSettingsModalReady();

      // FN-7713: embedded mobile-mocked viewport starts the search row collapsed — expand it first.
      await settingsModalUser.click(screen.getByLabelText("Show search"));
      const search = screen.getByTestId("settings-search-input");
      await settingsModalUser.type(search, "model pricing");
      expect(screen.getByRole("button", { name: /^Models$/ })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^Project General$/ })).not.toBeInTheDocument();

      fireEvent.keyDown(search, { key: "Escape" });
      expect(onClose).not.toHaveBeenCalled();
      expect(search).toHaveValue("");
      expect(screen.getByRole("button", { name: /^Project General$/ })).toBeInTheDocument();
    });

    it("keeps the overlay and Escape-to-close in modal mode", async () => {
      const onClose = vi.fn();
      const { container } = renderModal({ onClose });
      await waitForSettingsModalReady();

      expect(container.querySelector(".settings-modal-overlay")).not.toBeNull();
      expect(container.querySelector(".settings-modal--embedded")).toBeNull();
      fireEvent.keyDown(document, { key: "Escape" });
      expect(onClose).toHaveBeenCalled();
    });
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
    await settingsModalUser.click(screen.getByRole("checkbox", { name: "Advanced settings" }));

    expect(screen.getByRole("button", { name: "Secrets" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Manage secrets" })).not.toBeInTheDocument();
  });

  it("renders the SecretsView when the Secrets section is selected", async () => {
    renderModal();
    await waitForSettingsModalReady();
    await settingsModalUser.click(screen.getByRole("checkbox", { name: "Advanced settings" }));

    await settingsModalUser.click(screen.getByRole("button", { name: "Secrets" }));

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

    await settingsModalUser.click(screen.getByRole("button", { name: /^Merge$/ }));
    await settingsModalUser.selectOptions(screen.getByLabelText("AI merge"), "deterministic");
    expect(screen.getByLabelText("Direct merge commit routing")).toHaveValue("auto");

    await settingsModalUser.selectOptions(screen.getByLabelText("Auto-completion mode"), "pull-request");
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

    await settingsModalUser.selectOptions(screen.getByLabelText("AI merge"), "deterministic");
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

    await settingsModalUser.selectOptions(screen.getByLabelText("AI merge"), "deterministic");
    await settingsModalUser.selectOptions(screen.getByLabelText("Integration worktree"), "cwd-main");
    await settingsModalUser.click(screen.getByRole("button", { name: "Save" }));

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

    await settingsModalUser.selectOptions(screen.getByLabelText("AI merge"), "deterministic");
    await settingsModalUser.selectOptions(screen.getByLabelText("Integration worktree"), "cwd-main");

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

    await settingsModalUser.selectOptions(screen.getByLabelText("AI merge"), "deterministic");
    expect(screen.getByTestId("merge-integration-worktree-warning")).toBeInTheDocument();

    await settingsModalUser.selectOptions(screen.getByLabelText("Integration worktree"), "reuse-task-worktree");

    expect(screen.queryByTestId("merge-integration-worktree-warning")).toBeNull();
  });

  it("persists the legacy sibling branch rename escape hatch in worktree settings", async () => {
    renderModal();
    await waitForSettingsModalReady();

    await settingsModalUser.click(screen.getByRole("button", { name: /^Worktrees$/ }));

    const checkbox = screen.getByRole("checkbox", { name: "Allow silent sibling branch rename during executor conflicts" });
    expect(checkbox).not.toBeChecked();

    await settingsModalUser.click(checkbox);
    await settingsModalUser.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mockUpdateSettings).toHaveBeenCalledWith(
        expect.objectContaining({ executorAllowSiblingBranchRename: true }),
        undefined,
      );
    });
    expect(screen.getByText(/restores the legacy behavior/i)).toBeInTheDocument();
  });

  describe("deferred settings fetches", () => {
    it("does not fetch global concurrency until Scheduling is selected", async () => {
      renderModal();
      await waitForSettingsModalReady();

      expect(mockFetchGlobalConcurrency).not.toHaveBeenCalled();

      await settingsModalUser.click(screen.getByRole("button", { name: /Scheduling/ }));

      await waitFor(() => {
        expect(mockFetchGlobalConcurrency).toHaveBeenCalledTimes(1);
      });
    });

    it("disables concurrency inputs until their actual values load", async () => {
      mockFetchGlobalConcurrency.mockReturnValue(new Promise(() => {}));
      renderModal();
      await waitForSettingsModalReady();

      await settingsModalUser.click(screen.getByRole("button", { name: /Scheduling/ }));

      expect(screen.getByLabelText("Global Max Concurrent")).toBeDisabled();
      expect(screen.getByLabelText("Max Concurrent Tasks")).toBeDisabled();
      expect(screen.getByLabelText("Max Triage Concurrent")).toBeDisabled();
    });

    it("enables memory backend status hook only when Memory section is active", async () => {
      renderModal();
      await waitForSettingsModalReady();
      await settingsModalUser.click(screen.getByRole("checkbox", { name: "Advanced settings" }));

      expect(mockUseMemoryBackendStatus).toHaveBeenCalled();
      const initialCallHasDisabled = mockUseMemoryBackendStatus.mock.calls.some(
        (call) => call[0]?.enabled === false,
      );
      expect(initialCallHasDisabled).toBe(true);

      await settingsModalUser.click(screen.getByRole("button", { name: /Memory/ }));

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

      // Global modal outside-dismiss and persistAgentToolOutput default to unchecked; Star-on-GitHub control absent.
      expect(screen.getByRole("checkbox", { name: "Dismiss modals by clicking outside" })).not.toBeChecked();
      expect(screen.getByText(/Default: disabled, to prevent accidental dismissal/i).closest("small")).toBeTruthy();
      expect(screen.getByRole("checkbox", { name: "Save tool output in agent logs" })).not.toBeChecked();
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

    it("reflects persisted checked value from global settings", async () => {
      mockFetchSettings.mockResolvedValue({
        ...defaultSettings,
        persistAgentToolOutput: true,
      });
      mockFetchSettingsByScope.mockResolvedValue({
        global: { ...defaultSettings, persistAgentToolOutput: true },
        project: {},
      });

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

    it("saves modal outside-dismiss only via global settings payload", async () => {
      renderModal({ initialSection: "global-general" });
      await waitForSettingsModalReady();

      await settingsModalUser.click(screen.getByRole("checkbox", { name: "Dismiss modals by clicking outside" }));
      await settingsModalUser.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(mockUpdateGlobalSettings).toHaveBeenCalled();
      });

      const globalPayload = mockUpdateGlobalSettings.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(globalPayload.dismissModalsOnOutsideClick).toBe(true);
      if (mockUpdateSettings.mock.calls.length > 0) {
        const projectPayload = mockUpdateSettings.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(projectPayload.dismissModalsOnOutsideClick).toBeUndefined();
      }
    });

    it("saves persistAgentToolOutput only via global settings payload", async () => {
      renderModal({ initialSection: "global-general" });
      await waitForSettingsModalReady();

      await settingsModalUser.click(screen.getByRole("checkbox", { name: "Save tool output in agent logs" }));
      await settingsModalUser.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(mockUpdateGlobalSettings).toHaveBeenCalled();
      });

      const globalPayload = mockUpdateGlobalSettings.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(globalPayload.persistAgentToolOutput).toBe(true);
      if (mockUpdateSettings.mock.calls.length > 0) {
        const projectPayload = mockUpdateSettings.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(projectPayload.persistAgentToolOutput).toBeUndefined();
      }
    });

    it("saves granular thinking-log flags only via global settings payload", async () => {
      renderModal({ initialSection: "global-general" });
      await waitForSettingsModalReady();

      await settingsModalUser.click(screen.getByRole("checkbox", { name: "Save AI thinking for permanent agents" }));
      await settingsModalUser.click(screen.getByRole("checkbox", { name: "Save AI thinking for ephemeral / task-worker agents" }));
      await settingsModalUser.click(screen.getByRole("button", { name: "Save" }));

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

      await settingsModalUser.selectOptions(screen.getByRole("combobox", { name: "Global default tracking repo" }), "octo/global-default");
      await settingsModalUser.click(screen.getByRole("button", { name: "Save" }));

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

    it("saves GitLab URL configuration via global settings payload only", async () => {
      renderModal({ initialSection: "global-general" });
      await waitForSettingsModalReady();

      expect(screen.getByLabelText("Global GitLab instance URL")).toHaveAttribute("placeholder", "https://gitlab.com");
      expect(screen.getByText(/Blank defaults to GitLab.com/i)).toBeInTheDocument();

      await settingsModalUser.type(screen.getByLabelText("Global GitLab instance URL"), " https://gitlab.company.test/ ");
      await settingsModalUser.type(screen.getByLabelText("Global GitLab API base URL (optional / advanced)"), " https://gitlab.company.test/api/v4/ ");
      await settingsModalUser.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(mockUpdateGlobalSettings).toHaveBeenCalled();
      });

      const globalPayload = mockUpdateGlobalSettings.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(globalPayload.gitlabInstanceUrl).toBe("https://gitlab.company.test/");
      expect(globalPayload.gitlabApiBaseUrl).toBe("https://gitlab.company.test/api/v4/");
      if (mockUpdateSettings.mock.calls.length > 0) {
        const projectPayload = mockUpdateSettings.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(projectPayload.gitlabInstanceUrl).toBeUndefined();
        expect(projectPayload.gitlabApiBaseUrl).toBeUndefined();
      }
    });

    it("renders and saves global GitLab enabled from scoped global values when project overrides differ", async () => {
      mockFetchSettings.mockResolvedValueOnce({ ...defaultSettings, gitlabEnabled: true });
      mockFetchSettingsByScope.mockResolvedValueOnce({
        global: { ...defaultSettings, gitlabEnabled: false, gitlabInstanceUrl: "https://global.gitlab.test" },
        project: { gitlabEnabled: true },
      });

      renderModal({ initialSection: "global-general" });
      await waitForSettingsModalReady();

      const enableToggle = screen.getByLabelText("Enable GitLab integration") as HTMLInputElement;
      expect(enableToggle).not.toBeChecked();
      expect(screen.getByLabelText("Global GitLab instance URL")).toBeDisabled();

      await settingsModalUser.click(screen.getByRole("button", { name: "Save" }));

      expect(mockUpdateGlobalSettings).not.toHaveBeenCalledWith(expect.objectContaining({ gitlabEnabled: true }));
    });

    it("saves an explicit global GitLab enable edit without using the project override", async () => {
      mockFetchSettings.mockResolvedValueOnce({ ...defaultSettings, gitlabEnabled: true });
      mockFetchSettingsByScope.mockResolvedValueOnce({
        global: { ...defaultSettings, gitlabEnabled: false },
        project: { gitlabEnabled: true },
      });

      renderModal({ initialSection: "global-general" });
      await waitForSettingsModalReady();

      await settingsModalUser.click(screen.getByLabelText("Enable GitLab integration"));
      await settingsModalUser.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(mockUpdateGlobalSettings).toHaveBeenCalledWith(expect.objectContaining({ gitlabEnabled: true }));
      });
      if (mockUpdateSettings.mock.calls.length > 0) {
        expect(mockUpdateSettings.mock.calls[0]?.[0]).not.toHaveProperty("gitlabEnabled");
      }
    });

    /*
    FNXC:GitLabEnablement 2026-07-04-00:00:
    FN-7535 regression repro: the scoped `global` settings omit `gitlabEnabled`
    entirely (the operator has never saved a global GitLab value before), while
    the merged/project-effective `fetchSettings` value already happens to equal
    the value the operator is about to set. Before the fix, `splitSettingsSave`
    fell back to the merged `initialValues` for the changed-only comparison
    when the scoped global object lacked the key, so this explicit global edit
    was misclassified as "unchanged" and silently dropped from the global patch.
    */
    it("saves an explicit global GitLab disable edit when scoped global omits the key but merged settings already match", async () => {
      // Scoped global omits `gitlabEnabled` entirely (unset renders as checked/
      // enabled per the disclosure's documented "unset behaves as enabled" default).
      // The merged/project-effective `fetchSettings` value already happens to be
      // `false` — the same value the operator is about to explicitly set.
      mockFetchSettings.mockResolvedValueOnce({ ...defaultSettings, gitlabEnabled: false });
      mockFetchSettingsByScope.mockResolvedValueOnce({
        global: { ...defaultSettings }, // no gitlabEnabled key at all
        project: {},
      });

      renderModal({ initialSection: "global-general" });
      await waitForSettingsModalReady();

      const enableToggle = screen.getByLabelText("Enable GitLab integration") as HTMLInputElement;
      expect(enableToggle).toBeChecked();

      await settingsModalUser.click(enableToggle);
      expect(enableToggle).not.toBeChecked();
      await settingsModalUser.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(mockUpdateGlobalSettings).toHaveBeenCalledWith(expect.objectContaining({ gitlabEnabled: false }));
      });
    });

    it("shows global tracking repo error hint and keeps custom entry when lookups fail", async () => {
      mockFetchProjects.mockRejectedValueOnce(new Error("no projects"));

      renderModal({ initialSection: "global-general" });
      await waitForSettingsModalReady();

      expect(await screen.findByText(/Could not load project list/i)).toBeInTheDocument();
      const control = screen.getByRole("combobox", { name: "Global default tracking repo" });
      expect(screen.getByRole("option", { name: "Custom…" })).toBeInTheDocument();

      await settingsModalUser.selectOptions(control, "__custom__");
      expect(screen.getByPlaceholderText("owner/repo")).toBeInTheDocument();
    });
  });

  it("renders and saves agent provisioning approval settings", async () => {
    renderModal({ initialSection: "agent-permissions" });
    await waitForSettingsModalReady();

    expect(screen.getByRole("heading", { name: "Agent Provisioning Approvals" })).toBeInTheDocument();

    await settingsModalUser.selectOptions(screen.getByLabelText("Approval mode"), "always");
    await settingsModalUser.click(screen.getByRole("button", { name: "Save" }));

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

    it("reports Quick Chat launcher changes immediately before save", async () => {
      const onQuickChatButtonModeChange = vi.fn();
      renderModal({ initialSection: "general", onQuickChatButtonModeChange });
      await waitForSettingsModalReady();

      await settingsModalUser.selectOptions(screen.getByLabelText("Quick Chat launcher"), "footer");

      expect(onQuickChatButtonModeChange).toHaveBeenCalledWith("footer");
    });

    it("defaults task chats common-feed opt-in to unchecked", async () => {
      renderModal({ initialSection: "general" });
      await waitForSettingsModalReady();

      const toggle = screen.getByLabelText("Show task chats in common Chat feed") as HTMLInputElement;
      expect(toggle).toBeInTheDocument();
      expect(toggle.checked).toBe(false);
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
        label: "Close Quick Chat on outside click",
        kind: "checkbox",
        value: false,
        scope: "project",
        expectedKey: "quickChatCloseOnOutsideClick",
      },
      {
        section: "Project General",
        label: "Show task chats in common Chat feed",
        kind: "checkbox",
        value: true,
        scope: "project",
        expectedKey: "showTaskChatsInCommonFeed",
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

      await settingsModalUser.click(ephemeralToggle);
      await settingsModalUser.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalled();
      });

      const payload = mockUpdateSettings.mock.calls[0][0] as Record<string, unknown>;
      expect(payload.ephemeralAgentsEnabled).toBe(false);
    });

    it("exposes the ephemeral agents toggle via the desktop Project General sidebar nav item", async () => {
      renderModal();
      await waitForSettingsModalReady();

      await settingsModalUser.click(screen.getByRole("button", { name: "Project General" }));

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

      await settingsModalUser.selectOptions(sectionPicker, "general");

      const ephemeralToggle = screen.getByLabelText("Use ephemeral task-worker agents") as HTMLInputElement;
      expect(ephemeralToggle).toBeInTheDocument();
      expect(ephemeralToggle.checked).toBe(true);
      expect(screen.getByLabelText("Show task chats in common Chat feed")).toBeInTheDocument();

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

      await settingsModalUser.selectOptions(mailCleanupSelect, "7");
      await settingsModalUser.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalled();
      });

      const payload = mockUpdateSettings.mock.calls[0][0] as Record<string, unknown>;
      expect(payload.mailAutoCleanupDays).toBe(7);

      mockUpdateSettings.mockClear();

      await settingsModalUser.selectOptions(mailCleanupSelect, "0");
      await settingsModalUser.click(screen.getByRole("button", { name: "Save" }));

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

      await settingsModalUser.type(recentInput, "7");
      await settingsModalUser.type(fetchLimitInput, "60");
      await settingsModalUser.type(summaryMaxInput, "900");
      await settingsModalUser.click(screen.getByRole("button", { name: "Save" }));

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

      await settingsModalUser.selectOptions(modeSelect, "new-tasks");
      await settingsModalUser.type(screen.getByPlaceholderText("owner/repo"), "octo/repo");
      await settingsModalUser.click(screen.getByRole("button", { name: "Save" }));

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

    it("renders and saves GitLab URL configuration as project settings", async () => {
      renderModal({ initialSection: "general" });
      await waitForSettingsModalReady();

      const disclosure = screen.getByTestId("project-gitlab-configuration-disclosure");
      expect(disclosure).not.toHaveAttribute("open");
      const enableToggle = screen.getByLabelText("Enable GitLab integration") as HTMLInputElement;
      expect(enableToggle.checked).toBe(true);
      await settingsModalUser.click(within(disclosure).getByText("GitLab Configuration"));
      expect(disclosure).toHaveAttribute("open");

      expect(screen.getByRole("heading", { name: "GitLab Configuration" })).toBeInTheDocument();
      expect(screen.getByText(/Blank uses GitLab.com or the global default/i)).toBeInTheDocument();
      expect(screen.getByText(/Blank derives <instance>\/api\/v4/i)).toBeInTheDocument();

      await settingsModalUser.type(screen.getByLabelText("GitLab instance URL"), " https://gitlab.example.com/gitlab/ ");
      await settingsModalUser.type(screen.getByLabelText("GitLab API base URL (optional / advanced)"), " https://api.example.com/v4/ ");
      await settingsModalUser.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalled();
      });

      const payload = mockUpdateSettings.mock.calls[0][0] as Record<string, unknown>;
      expect(payload.gitlabInstanceUrl).toBe("https://gitlab.example.com/gitlab/");
      expect(payload.gitlabApiBaseUrl).toBe("https://api.example.com/v4/");
      if (mockUpdateGlobalSettings.mock.calls.length > 0) {
        const globalPayload = mockUpdateGlobalSettings.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(globalPayload.gitlabInstanceUrl).toBeUndefined();
        expect(globalPayload.gitlabApiBaseUrl).toBeUndefined();
      }
    });

    it("saves project GitLab disabled state without clearing stored URLs", async () => {
      mockFetchSettings.mockResolvedValueOnce({
        ...defaultSettings,
        gitlabEnabled: true,
        gitlabInstanceUrl: "https://gitlab.example.com/gitlab",
        gitlabApiBaseUrl: "https://gitlab.example.com/gitlab/api/v4",
      });
      mockFetchSettingsByScope.mockResolvedValueOnce({
        global: defaultSettings,
        project: {
          gitlabEnabled: true,
          gitlabInstanceUrl: "https://gitlab.example.com/gitlab",
          gitlabApiBaseUrl: "https://gitlab.example.com/gitlab/api/v4",
        },
      });

      renderModal({ initialSection: "general" });
      await waitForSettingsModalReady();

      await settingsModalUser.click(screen.getByLabelText("Enable GitLab integration"));
      await settingsModalUser.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalled();
      });

      expect(mockUpdateSettings.mock.calls[0][0]).toMatchObject({ gitlabEnabled: false });
      expect(mockUpdateSettings.mock.calls[0][0]).not.toHaveProperty("gitlabInstanceUrl");
      expect(mockUpdateSettings.mock.calls[0][0]).not.toHaveProperty("gitlabApiBaseUrl");
    });

    it("clears GitLab URL project overrides back to defaults", async () => {
      mockFetchSettings.mockResolvedValueOnce({
        ...defaultSettings,
        gitlabInstanceUrl: "https://gitlab.example.com/gitlab",
        gitlabApiBaseUrl: "https://gitlab.example.com/gitlab/api/v4",
      });
      mockFetchSettingsByScope.mockResolvedValueOnce({
        global: defaultSettings,
        project: {
          gitlabInstanceUrl: "https://gitlab.example.com/gitlab",
          gitlabApiBaseUrl: "https://gitlab.example.com/gitlab/api/v4",
        },
      });

      renderModal({ initialSection: "general" });
      await waitForSettingsModalReady();

      await settingsModalUser.clear(screen.getByLabelText("GitLab instance URL"));
      await settingsModalUser.clear(screen.getByLabelText("GitLab API base URL (optional / advanced)"));
      await settingsModalUser.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalled();
      });

      expect(mockUpdateSettings.mock.calls[0][0]).toMatchObject({
        gitlabInstanceUrl: null,
        gitlabApiBaseUrl: null,
      });
    });

    it("renders and saves imported GitHub issue tracking linking as a project setting", async () => {
      renderModal({ initialSection: "general" });
      await waitForSettingsModalReady();

      const importLinkToggle = screen.getByLabelText(
        "Always link imported GitHub issues to GitHub tracking",
      ) as HTMLInputElement;
      expect(importLinkToggle.id).toBe("githubLinkImportedIssuesToTracking");
      expect(importLinkToggle.checked).toBe(false);
      expect(screen.getByText(/does not turn GitHub tracking on for ordinary new tasks/i)).toBeInTheDocument();

      await settingsModalUser.click(importLinkToggle);
      await settingsModalUser.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalled();
      });

      const payload = mockUpdateSettings.mock.calls[0][0] as Record<string, unknown>;
      expect(payload.githubLinkImportedIssuesToTracking).toBe(true);
      if (mockUpdateGlobalSettings.mock.calls.length > 0) {
        const globalPayload = mockUpdateGlobalSettings.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(globalPayload.githubLinkImportedIssuesToTracking).toBeUndefined();
      }
    });

    it("saves imported GitHub issue tracking linking as disabled", async () => {
      mockFetchSettings.mockResolvedValueOnce({
        ...defaultSettings,
        githubLinkImportedIssuesToTracking: true,
      });
      mockFetchSettingsByScope.mockResolvedValueOnce({
        global: defaultSettings,
        project: { githubLinkImportedIssuesToTracking: true },
      });

      renderModal({ initialSection: "general" });
      await waitForSettingsModalReady();

      const importLinkToggle = screen.getByLabelText(
        "Always link imported GitHub issues to GitHub tracking",
      ) as HTMLInputElement;
      expect(importLinkToggle.checked).toBe(true);

      await settingsModalUser.click(importLinkToggle);
      await settingsModalUser.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalled();
      });

      const payload = mockUpdateSettings.mock.calls[0][0] as Record<string, unknown>;
      expect(payload.githubLinkImportedIssuesToTracking).toBe(false);
      if (mockUpdateGlobalSettings.mock.calls.length > 0) {
        const globalPayload = mockUpdateGlobalSettings.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(globalPayload.githubLinkImportedIssuesToTracking).toBeUndefined();
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

      await settingsModalUser.selectOptions(modeSelect, "off");
      await settingsModalUser.clear(screen.getByPlaceholderText("owner/repo"));
      await settingsModalUser.click(screen.getByRole("button", { name: "Save" }));

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

      await settingsModalUser.click(dedupToggle);
      await settingsModalUser.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalled();
      });

      const firstPayload = mockUpdateSettings.mock.calls[0][0] as Record<string, unknown>;
      expect(firstPayload.githubTrackingDedupEnabled).toBe(false);

      mockUpdateSettings.mockClear();

      await settingsModalUser.click(dedupToggle);
      await settingsModalUser.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalled();
      });

      const secondPayload = mockUpdateSettings.mock.calls[0][0] as Record<string, unknown>;
      expect(secondPayload.githubTrackingDedupEnabled).toBe(true);
    });

    it("hides summarization model picker when summarization and default tracking are disabled", async () => {
      renderModal({ initialSection: "models" });
      await waitForSettingsModalReady();

      await settingsModalUser.click(screen.getByRole("button", { name: "Project Models" }));

      expect(screen.queryByText("Title, commit message, and GitHub tracking issue summarization model")).not.toBeInTheDocument();
    });

    it("does not show a moved-to-workflow note for the summarizer model when GitHub tracking defaults are on", async () => {
      mockFetchSettings.mockResolvedValueOnce({
        ...defaultSettings,
        githubTrackingEnabledByDefault: true,
      });

      renderModal({ initialSection: "models" });
      await waitForSettingsModalReady();

      await settingsModalUser.click(screen.getByRole("button", { name: "Project Models" }));

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

      await settingsModalUser.selectOptions(repoSelect, "octo/repo");
      await settingsModalUser.click(screen.getByRole("button", { name: "Save" }));

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
      await settingsModalUser.selectOptions(control, "__custom__");
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

      await settingsModalUser.click(screen.getByRole("button", { name: /Appearance/ }));

      const largeButton = screen.getByRole("button", { name: "Large" });
      expect(largeButton).toHaveAttribute("aria-pressed", "true");

      await settingsModalUser.click(screen.getByRole("button", { name: "Small" }));
      expect(onDashboardFontScaleChange).toHaveBeenCalledWith(90);
    });

    it("saves dashboard font scale to global settings", async () => {
      renderModal({ dashboardFontScalePct: 100 });
      await waitForSettingsModalReady();

      await settingsModalUser.click(screen.getByRole("button", { name: /Appearance/ }));
      await settingsModalUser.click(screen.getByRole("button", { name: "Largest" }));
      await settingsModalUser.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(mockUpdateGlobalSettings).toHaveBeenCalled();
      });

      const payload = mockUpdateGlobalSettings.mock.calls[0][0];
      expect(payload).toEqual(expect.objectContaining({ dashboardFontScalePct: 120 }));
    });
  });

  /*
  FNXC:SettingsReset 2026-07-04-00:50:
  FN-7506 Reset Settings coverage: dialog open/close (button, Cancel, overlay, Escape) without
  mutating settings; both destructive actions present and correctly labeled; per-menu reset
  disabled with a reason for an excluded/non-key section; SCOPE PRECISION for a project section
  (merge), a global section (appearance), and "reset all project settings" (project keys only,
  never global); and the form refetches/re-renders after a reset.
  */
  describe("Reset Settings", () => {
    it("renders the Reset Settings button in both modal and embedded presentations", async () => {
      const { unmount } = renderModal();
      await waitForSettingsModalReady();
      expect(screen.getByTestId("settings-reset")).toBeInTheDocument();
      unmount();

      renderModal({ presentation: "embedded" });
      await waitForSettingsModalReady();
      expect(screen.getByTestId("settings-reset")).toBeInTheDocument();
    });

    it("opens a dialog with both destructive actions and Cancel, without mutating settings", async () => {
      renderModal({ initialSection: "general" });
      await waitForSettingsModalReady();

      await settingsModalUser.click(screen.getByTestId("settings-reset"));

      const dialog = screen.getByTestId("settings-reset-dialog");
      expect(dialog).toHaveAttribute("role", "dialog");
      expect(dialog).toHaveAttribute("aria-modal", "true");
      expect(dialog).toHaveAttribute("aria-label");
      expect(screen.getByTestId("settings-reset-menu")).toHaveTextContent(/Reset this menu/i);
      expect(screen.getByTestId("settings-reset-all-project")).toHaveTextContent(/Reset all project settings/i);

      expect(mockUpdateSettings).not.toHaveBeenCalled();
      expect(mockUpdateGlobalSettings).not.toHaveBeenCalled();
    });

    it("Cancel closes the dialog without mutating settings", async () => {
      renderModal({ initialSection: "general" });
      await waitForSettingsModalReady();
      await settingsModalUser.click(screen.getByTestId("settings-reset"));
      const dialog = screen.getByTestId("settings-reset-dialog");
      expect(dialog).toBeInTheDocument();

      await settingsModalUser.click(within(dialog).getByRole("button", { name: /^Cancel$/ }));
      expect(screen.queryByTestId("settings-reset-dialog")).not.toBeInTheDocument();
      expect(mockUpdateSettings).not.toHaveBeenCalled();
      expect(mockUpdateGlobalSettings).not.toHaveBeenCalled();
    });

    it("overlay click closes the dialog without mutating settings", async () => {
      renderModal({ initialSection: "general" });
      await waitForSettingsModalReady();
      await settingsModalUser.click(screen.getByTestId("settings-reset"));

      fireEvent.click(screen.getByTestId("settings-reset-dialog"));
      expect(screen.queryByTestId("settings-reset-dialog")).not.toBeInTheDocument();
      expect(mockUpdateSettings).not.toHaveBeenCalled();
    });

    it("Escape closes only the reset dialog, not the whole Settings modal", async () => {
      const onClose = vi.fn();
      renderModal({ initialSection: "general", onClose });
      await waitForSettingsModalReady();
      await settingsModalUser.click(screen.getByTestId("settings-reset"));

      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.queryByTestId("settings-reset-dialog")).not.toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
    });

    it("disables per-menu reset with a documented reason for an excluded/non-key section (Secrets)", async () => {
      renderModal({ initialSection: "secrets" });
      await waitFor(() => expect(mockFetchSettings).toHaveBeenCalled());
      await settingsModalUser.click(await screen.findByTestId("settings-reset"));

      const menuBtn = screen.getByTestId("settings-reset-menu");
      expect(menuBtn).toBeDisabled();
      expect(menuBtn).toHaveAttribute("title");
      expect(menuBtn.getAttribute("title")).toBeTruthy();
    });

    it("SCOPE PRECISION: per-menu reset of a project section (Merge) writes only its keys via updateSettings, never updateGlobalSettings", async () => {
      renderModal({ initialSection: "merge" });
      await waitForSettingsModalReady();
      await settingsModalUser.click(screen.getByTestId("settings-reset"));
      await settingsModalUser.click(screen.getByTestId("settings-reset-menu"));

      await waitFor(() => expect(mockUpdateSettings).toHaveBeenCalled());
      const payload = mockUpdateSettings.mock.calls[0][0] as Record<string, unknown>;
      expect(payload.autoMerge).toBeNull();
      expect(payload.mergeStrategy).toBeNull();
      expect(payload.gitlabAuthToken).toBeNull();
      // Not part of "merge" — owned by "general" instead; must not leak in.
      expect(payload).not.toHaveProperty("gitlabEnabled");
      expect(payload).not.toHaveProperty("taskPrefix");
      expect(mockUpdateGlobalSettings).not.toHaveBeenCalled();
    });

    it("SCOPE PRECISION: per-menu reset of a global section (Appearance) writes only its keys via updateGlobalSettings, never updateSettings", async () => {
      renderModal({ initialSection: "appearance" });
      await waitForSettingsModalReady();
      await settingsModalUser.click(screen.getByTestId("settings-reset"));
      await settingsModalUser.click(screen.getByTestId("settings-reset-menu"));

      await waitFor(() => expect(mockUpdateGlobalSettings).toHaveBeenCalled());
      const payload = mockUpdateGlobalSettings.mock.calls[0][0] as Record<string, unknown>;
      expect(payload).toEqual(
        expect.objectContaining({
          themeMode: "system",
          colorTheme: "shadcn-ember",
        }),
      );
      expect(mockUpdateSettings).not.toHaveBeenCalled();
    });

    it("reset all project settings writes only project keys via updateSettings and never touches updateGlobalSettings", async () => {
      renderModal({ initialSection: "general" });
      await waitForSettingsModalReady();
      await settingsModalUser.click(screen.getByTestId("settings-reset"));
      await settingsModalUser.click(screen.getByTestId("settings-reset-all-project"));

      await waitFor(() => expect(mockUpdateSettings).toHaveBeenCalled());
      const payload = mockUpdateSettings.mock.calls[0][0] as Record<string, unknown>;
      expect(payload.taskPrefix).toBeNull();
      expect(payload.autoMerge).toBeNull();
      expect(payload.maxConcurrent).toBeNull();
      // Global-only key must never appear in a project-scope reset payload.
      expect(payload).not.toHaveProperty("themeMode");
      expect(mockUpdateGlobalSettings).not.toHaveBeenCalled();
    });

    it("refreshes the form after a successful reset (refetches settings) and closes the dialog", async () => {
      renderModal({ initialSection: "merge" });
      await waitForSettingsModalReady();
      const fetchCallsBefore = mockFetchSettings.mock.calls.length;

      await settingsModalUser.click(screen.getByTestId("settings-reset"));
      await settingsModalUser.click(screen.getByTestId("settings-reset-menu"));

      await waitFor(() => expect(mockFetchSettings.mock.calls.length).toBeGreaterThan(fetchCallsBefore));
      await waitFor(() => expect(screen.queryByTestId("settings-reset-dialog")).not.toBeInTheDocument());
    });
  });
});
