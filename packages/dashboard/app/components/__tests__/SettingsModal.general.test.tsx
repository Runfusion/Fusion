import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { act, render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react";
import path from "path";
import { SettingsModal } from "../SettingsModal";
import { __test_resetSystemRestartRecovery, systemRestartRecovery } from "../../hooks/useSystemRestartRecovery";
import { __test_resetPendingUpdateInstall } from "../../hooks/usePendingUpdateInstall";
import { ModalDismissPreferenceProvider } from "../../hooks/useOverlayDismiss";
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
  mockFetchSystemInfo,
  mockRequestSystemRestart,
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
  mockFetchPlugins,
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
  flushSettingsAutoSave,
} from "./SettingsModal.test-harness";

const mockListDiscussionCategories = vi.fn(async () => ({ categories: [] }));
let pluginLifecycleListener: ((event: MessageEvent) => void) | undefined;
const mockSubscribeSse = vi.fn((_url: string, options: { events?: Record<string, (event: MessageEvent) => void> }) => {
  pluginLifecycleListener = options.events?.["plugin:lifecycle"];
  return () => {};
});

vi.mock("../../sse-bus", () => ({
  subscribeSse: (...args: unknown[]) => mockSubscribeSse(...args),
}));

vi.mock("../../api", async (importOriginal) => {
  const { createDashboardApiMock } = await import("../../test/mockApi");
  return createDashboardApiMock(() => importOriginal<typeof import("../../api")>(), {
    fetchSettings: (...args: unknown[]) => mockFetchSettings(...args),
    listDiscussionCategories: (...args: unknown[]) => mockListDiscussionCategories(...args),
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
    checkForUpdate: vi.fn(() => Promise.resolve({ currentVersion: "1.0.0", latestVersion: null, updateAvailable: false })),
    installUpdate: (...args: unknown[]) => mockInstallUpdate(...args),
    fetchSystemInfo: (...args: unknown[]) => mockFetchSystemInfo(...args),
    requestSystemRestart: (...args: unknown[]) => mockRequestSystemRestart(...args),
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
    fetchPlugins: (...args: unknown[]) => mockFetchPlugins(...args),
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

let viewportMode: "mobile" | "desktop" = "mobile";

vi.mock("../../hooks/useViewportMode", () => ({
  MOBILE_MEDIA_QUERY: "(max-width: 768px), (max-height: 480px)",
  isFullScreenSheetViewport: () => false,
  isShortViewport: () => false,
  getViewportMode: () => viewportMode,
  isMobileViewport: () => viewportMode === "mobile",
  isTabletTouchViewport: (mode?: string) => mode === "tablet",
  useViewportMode: () => viewportMode,
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
  it("renders and persists the project-scoped conversation layout without a global write", async () => {
    const onChatMessageLayoutChange = vi.fn();
    mockFetchSettingsByScope.mockResolvedValueOnce({
      global: defaultSettings,
      project: {
        ...defaultSettings,
        allowAbsoluteFileBrowserPaths: false,
        directMergeCommitStrategy: "auto",
        maxAutoMergeRetries: 3,
        executorToolFailureRetryCount: 2,
        executorToolFailureRetryBackoffMs: 2000,
        executorToolFailureThreshold: 1,
        executorModelEscalationEnabled: false,
        executorEscalationProvider: undefined,
        executorEscalationModelId: undefined,
        executorEscalationNodeId: undefined,
        chatMessageLayout: "bubbles",
        gitlabAuthTokenType: "personal",
        mergeAdvanceAutoSync: "stash-and-ff",
        pushRemote: undefined,
        showCostBadgeOnCards: false,
        taskDetailChatFirst: false,
        worktreeInitCommand: undefined,
        worktreesDir: undefined,
        worktrunk: { enabled: false, binaryPath: undefined, onFailure: "fail" },
      },
    } as never);
    renderModal({ initialSection: "appearance", onChatMessageLayoutChange });
    await waitForSettingsModalReady();

    const selector = screen.getByLabelText("Conversation layout") as HTMLSelectElement;
    expect(selector.value).toBe("bubbles");
    vi.useFakeTimers();
    fireEvent.change(selector, { target: { value: "full-width" } });
    expect(onChatMessageLayoutChange).toHaveBeenCalledWith("full-width");
    await flushSettingsAutoSave();
    vi.useRealTimers();

    expect(mockUpdateSettings).toHaveBeenCalledWith({ chatMessageLayout: "full-width" }, undefined);
    expect(mockUpdateGlobalSettings).not.toHaveBeenCalled();
  });

  it("mirrors mounted Appearance controls through the modal while keeping one persistence path", async () => {
    const callbacks = {
      onOpenTasksInRightSidebarChange: vi.fn(),
      onOpenMobileTasksInPopupChange: vi.fn(),
      onTaskPopupsBoardListOnlyChange: vi.fn(),
      onShowCostBadgeOnCardsChange: vi.fn(),
      onTaskDetailChatFirstChange: vi.fn(),
    };
    renderModal({ initialSection: "appearance", ...callbacks });
    await waitForSettingsModalReady();

    fireEvent.click(screen.getByLabelText("Open tasks in the right sidebar"));
    fireEvent.click(screen.getByLabelText("Open tasks as popups"));
    fireEvent.click(screen.getByLabelText("Keep task popups on the view where they were opened"));
    fireEvent.click(screen.getByLabelText("Show cost badges on task cards"));
    fireEvent.click(screen.getByLabelText("Open task details with Chat first"));

    expect(callbacks.onOpenTasksInRightSidebarChange).toHaveBeenCalledWith(true);
    expect(callbacks.onOpenMobileTasksInPopupChange).toHaveBeenCalledWith(true);
    expect(callbacks.onTaskPopupsBoardListOnlyChange).toHaveBeenCalledWith(true);
    expect(callbacks.onShowCostBadgeOnCardsChange).toHaveBeenCalledWith(true);
    expect(callbacks.onTaskDetailChatFirstChange).toHaveBeenCalledWith(true);

    vi.useFakeTimers();
    await flushSettingsAutoSave();
    vi.useRealTimers();
    expect(mockUpdateGlobalSettings).not.toHaveBeenCalled();
  });

  it("renders recommendation mailbox notices enabled by default and persists disabling it", async () => {
    renderModal({ initialSection: "general" });
    await waitForSettingsModalReady();
    const toggle = screen.getByLabelText("Recommendation mailbox notices");
    expect(toggle).toBeChecked();
    // FNXC:SettingsModalTests 2026-08-16-03:46: flush the 500ms auto-save debounce on the fake clock instead of a real-timer waitFor (FN-2707); assertions unchanged.
    vi.useFakeTimers();
    fireEvent.click(toggle);
    await flushSettingsAutoSave();
    vi.useRealTimers();
    expect(mockUpdateSettings).toHaveBeenCalled();
    expect(mockUpdateSettings.mock.calls.at(-1)?.[0]).toMatchObject({ recommendationMailboxNoticeEnabled: false });
  });

  it.each(["mobile", "desktop"] as const)("shows exactly one default-off required recommendation toggle on %s", async (mode) => {
    viewportMode = mode;
    renderModal({ initialSection: "general" });
    await waitForSettingsModalReady();

    const toggle = screen.getByRole("checkbox", { name: "Require automatic task recommendations" });
    expect(screen.getAllByRole("checkbox", { name: "Require automatic task recommendations" })).toHaveLength(1);
    expect(toggle).not.toBeChecked();
    expect(screen.getByText(/cap 0 disables capture regardless/i)).toBeInTheDocument();

    vi.useFakeTimers();
    fireEvent.click(toggle);
    await flushSettingsAutoSave();
    vi.useRealTimers();
    expect(mockUpdateSettings.mock.calls.at(-1)?.[0]).toMatchObject({ requireTaskRecommendations: true });
  });

  it("renders enabled required recommendations and preserves one usable control when capture is disabled", async () => {
    mockFetchSettings.mockResolvedValueOnce({
      ...defaultSettings,
      requireTaskRecommendations: true,
      maxRecommendationsPerTask: 0,
    });
    mockFetchSettingsByScope.mockResolvedValueOnce({
      global: defaultSettings,
      project: { requireTaskRecommendations: true, maxRecommendationsPerTask: 0 },
    });
    renderModal({ initialSection: "general" });
    await waitForSettingsModalReady();

    expect(screen.getByRole("checkbox", { name: "Require automatic task recommendations" })).toBeChecked();
    expect(screen.getAllByRole("checkbox", { name: "Require automatic task recommendations" })).toHaveLength(1);
    expect(screen.getByText(/cap 0 disables capture regardless/i)).toBeInTheDocument();
  });
  // Keep Advanced off by default so disclosure default/persist tests stay truthful.
  installSettingsModalEnv({ advancedSettings: false });

  it("shows only installed runtime pages and keeps disabled installations navigable", async () => {
    mockFetchPlugins.mockResolvedValue([
      { id: "fusion-plugin-openclaw-runtime", enabled: false },
      { id: "fusion-plugin-openclaw-runtime", enabled: false },
    ]);
    renderModal({ initialSection: "openclaw-runtime" });
    await waitForSettingsModalReady();
    await waitFor(() => expect(screen.getByRole("button", { name: /OpenClaw/ })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /Hermes/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Paperclip/ })).not.toBeInTheDocument();
  });

  it("refreshes active runtime navigation after an external lifecycle uninstall", async () => {
    mockFetchPlugins.mockResolvedValue([{ id: "fusion-plugin-openclaw-runtime", enabled: true }]);
    renderModal({ initialSection: "openclaw-runtime", projectId: "project-a" });
    await waitForSettingsModalReady();
    await waitFor(() => expect(screen.getByRole("button", { name: /OpenClaw/ })).toBeInTheDocument());
    expect(pluginLifecycleListener).toBeTypeOf("function");

    mockFetchPlugins.mockResolvedValueOnce([]);
    await act(async () => {
      pluginLifecycleListener?.(new MessageEvent("plugin:lifecycle", {
        data: JSON.stringify({ scope: "project", projectId: "project-a", transition: "uninstalled" }),
      }));
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: /OpenClaw/ })).not.toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument();

    mockFetchPlugins.mockResolvedValueOnce([{ id: "fusion-plugin-openclaw-runtime", enabled: true }]);
    await act(async () => {
      pluginLifecycleListener?.(new MessageEvent("plugin:lifecycle", {
        data: JSON.stringify({ scope: "project", projectId: "project-a", transition: "installed" }),
      }));
    });
    await waitFor(() => expect(screen.getByRole("button", { name: /OpenClaw/ })).toBeInTheDocument());
  });

  it("fails closed and falls back from an uninstalled initial runtime section", async () => {
    mockFetchPlugins.mockResolvedValue([]);
    renderModal({ initialSection: "openclaw-runtime" });
    await waitForSettingsModalReady();
    await waitFor(() => expect(mockFetchPlugins).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /OpenClaw/ })).not.toBeInTheDocument();
    expect(screen.queryByText("OpenClaw Runtime")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument();
  });

  afterEach(() => {
    viewportMode = "mobile";
    mockListDiscussionCategories.mockReset();
    mockListDiscussionCategories.mockResolvedValue({ categories: [] });
  });

  const availableUpdate = {
    currentVersion: "1.2.3",
    latestVersion: "2.0.0",
    updateAvailable: true,
  };

  it("renders externally managed guidance without an update-now control on desktop", async () => {
    viewportMode = "desktop";
    mockCheckForUpdates.mockResolvedValue({
      currentVersion: "1.2.3",
      latestVersion: null,
      updateAvailable: false,
      disabled: true,
      externallyManaged: true,
      message: "Managed deployment updates must be installed through its release pipeline.",
    });
    renderModal();
    await waitForSettingsModalReady();

    await settingsModalUser.click(screen.getByRole("button", { name: "Check for updates" }));

    expect(await screen.findByText(/Managed deployment updates/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Update now" })).not.toBeInTheDocument();
    expect(document.querySelector(".settings-update-now-btn")).toBeNull();
  });

  async function renderUpdatedSettings() {
    mockCheckForUpdates.mockResolvedValue(availableUpdate);
    renderModal();
    await waitForSettingsModalReady();
    await settingsModalUser.click(screen.getByRole("button", { name: "Check for updates" }));
    await screen.findByRole("button", { name: "Update now" });
    await settingsModalUser.click(screen.getByRole("button", { name: "Update now" }));
    return screen.findByRole("button", { name: "Restart Fusion" });
  }

  describe("update restart affordance", () => {
    beforeEach(() => {
      __test_resetPendingUpdateInstall();
    });
    it("renders an enabled restart button after a successful update on desktop", async () => {
      viewportMode = "desktop";

      const restartButton = await renderUpdatedSettings();

      expect(restartButton).toBeEnabled();
      expect(restartButton).toHaveAccessibleName("Restart Fusion");
    });

    it("renders a wrapping, enabled restart control after a successful update on mobile", async () => {
      const restartButton = await renderUpdatedSettings();

      expect(restartButton).toBeEnabled();
      expect(restartButton).toHaveAccessibleName("Restart Fusion");
      expect(restartButton.closest(".settings-update-install-succeeded")).toBeInTheDocument();
      expect(settingsModalCss).toMatch(/\.settings-modal \.settings-update-check\s*\{[^}]*flex-wrap: wrap;/s);
    });

    it("ignores old, unavailable, and holding hosts before Settings recovery reloads the installed beta", async () => {
      __test_resetSystemRestartRecovery();
      const reload = vi.fn();
      vi.stubGlobal("location", { reload });
      mockCheckForUpdates.mockResolvedValue({ currentVersion: "0.77.0-beta.2", latestVersion: "0.77.0-beta.4", updateAvailable: true });
      mockInstallUpdate.mockResolvedValue({ currentVersion: "0.77.0-beta.2", latestVersion: "0.77.0-beta.4", updated: true, outcome: "installed" });
      mockFetchSystemInfo
        .mockResolvedValueOnce({ supervised: true, restartSupported: true, pid: 10 })
        .mockResolvedValueOnce({ pid: 10 })
        .mockResolvedValueOnce({ pid: 11 })
        .mockResolvedValueOnce({ pid: 12 })
        .mockResolvedValueOnce({ pid: 13 });
      mockFetchDashboardHealth
        .mockResolvedValueOnce({ version: "0.77.0-beta.2", status: "ok" })
        .mockRejectedValueOnce(new Error("host is restarting"))
        .mockResolvedValueOnce({ version: "0.77.0-beta.4", status: "migrating", holding: true })
        .mockResolvedValueOnce({ version: "0.77.0-beta.4", status: "degraded", holding: false });

      renderModal();
      await waitForSettingsModalReady();
      await settingsModalUser.click(screen.getByRole("button", { name: "Check for updates" }));
      await settingsModalUser.click(await screen.findByRole("button", { name: "Update now" }));
      await screen.findByRole("button", { name: "Restart Fusion" });
      vi.useFakeTimers();
      fireEvent.click(screen.getByRole("button", { name: "Restart Fusion" }));
      await act(async () => { await Promise.resolve(); });

      expect(screen.getByText("Restarting… Your connection will close shortly.")).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
      await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
      await act(async () => { await vi.advanceTimersByTimeAsync(1500); });

      expect(screen.getByText("Fusion v0.77.0-beta.4 is back online — reloading…")).toBeInTheDocument();
      expect(reload).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it("requests the supervised restart with the Settings update reason", async () => {
      const restartButton = await renderUpdatedSettings();

      await settingsModalUser.click(restartButton);

      expect(mockRequestSystemRestart).toHaveBeenCalledTimes(1);
      expect(mockRequestSystemRestart).toHaveBeenCalledWith("settings-update");
      expect(await screen.findByText(/Restarting… Your connection will close shortly/)).toBeInTheDocument();
    });

    /*
    FNXC:SettingsUpdate 2026-07-25-10:05:
    Capability is advisory, not a hard block. An unsupported host shows the manual
    guidance but the button still reaches the server, so the operator gets the real
    refusal instead of a control that silently does nothing when clicked.
    */
    it("shows manual guidance but still surfaces the server refusal when unsupported", async () => {
      mockFetchSystemInfo.mockResolvedValue({ supervised: false, restartSupported: false });
      mockRequestSystemRestart.mockRejectedValue(new Error("Restart is not available: no supervising parent."));

      const restartButton = await renderUpdatedSettings();

      await waitFor(() => expect(screen.getByText(/Needs a supervising parent/)).toBeInTheDocument());
      expect(restartButton).toBeEnabled();

      await settingsModalUser.click(restartButton);

      expect(mockRequestSystemRestart).toHaveBeenCalledWith("settings-update");
      expect(await screen.findByText(/Restart is not available: no supervising parent\./)).toBeInTheDocument();
    });

    it("still allows a restart attempt while system information is loading", async () => {
      mockFetchSystemInfo.mockReturnValue(new Promise(() => {}));

      const restartButton = await renderUpdatedSettings();

      expect(restartButton).toBeEnabled();
      expect(screen.queryByText(/Needs a supervising parent/)).not.toBeInTheDocument();
    });

    it("shows manual guidance when system information cannot load", async () => {
      mockFetchSystemInfo.mockRejectedValue(new Error("unavailable"));

      const restartButton = await renderUpdatedSettings();

      await waitFor(() => expect(screen.getByText(/Needs a supervising parent/)).toBeInTheDocument());
      expect(restartButton).toBeEnabled();
    });

    it("disables the restart button and shows a spinner while scheduling", async () => {
      mockRequestSystemRestart.mockReturnValue(new Promise(() => {}));
      const restartButton = await renderUpdatedSettings();

      await settingsModalUser.click(restartButton);

      expect(restartButton).toBeDisabled();
      expect(within(restartButton).getByTestId("icon-refresh")).toHaveClass("spinning");
    });

    it("shows an inline error and allows retry when restart scheduling rejects", async () => {
      mockRequestSystemRestart.mockRejectedValue(new Error("Restart unavailable"));
      const restartButton = await renderUpdatedSettings();

      await settingsModalUser.click(restartButton);

      expect(await screen.findByText("Restart unavailable")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Restart Fusion" })).toBeEnabled();
    });

    it("shows an inline error and allows retry when restart scheduling returns false", async () => {
      mockRequestSystemRestart.mockResolvedValue({ scheduled: false });
      const restartButton = await renderUpdatedSettings();

      await settingsModalUser.click(restartButton);

      expect(await screen.findByText(/Restart could not be scheduled/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Restart Fusion" })).toBeEnabled();
    });

    /*
    FNXC:SettingsUpdate 2026-07-25-10:05:
    Regression: restart capability is a property of the HOST, not of a particular
    update check. Clicking "Check for updates" repeatedly (same updateAvailable
    result each time) used to strand restartSupported at `undefined` — the probe
    was keyed on updateAvailable flipping — so the post-install "Restart Fusion"
    button was disabled with "Needs a supervising parent" on a supervised host.
    The invariant asserted here is: on a supervised host the restart button is
    enabled after an install regardless of how many checks preceded it.
    */
    it("keeps the restart button enabled after repeated update checks", async () => {
      mockCheckForUpdates.mockResolvedValue(availableUpdate);
      renderModal();
      await waitForSettingsModalReady();

      const checkButton = screen.getByRole("button", { name: "Check for updates" });
      await settingsModalUser.click(checkButton);
      await screen.findByRole("button", { name: "Update now" });
      await settingsModalUser.click(checkButton);
      await screen.findByRole("button", { name: "Update now" });

      await settingsModalUser.click(screen.getByRole("button", { name: "Update now" }));

      const restartButton = await screen.findByRole("button", { name: "Restart Fusion" });
      await waitFor(() => expect(restartButton).toBeEnabled());
      expect(screen.queryByText(/Needs a supervising parent/)).not.toBeInTheDocument();
    });

    it.each([
      ["installed", { currentVersion: "1.2.3", latestVersion: "2.0.0", updated: true, outcome: "installed" }, /Updated to v2\.0\.0/, true],
      ["no-update-available", { currentVersion: "1.2.3", latestVersion: "2.0.0", updated: false, outcome: "no-update-available", message: "Fusion is already up to date." }, /already up to date/i, false],
      ["check-failed", { currentVersion: "1.2.3", latestVersion: null, updated: false, outcome: "check-failed", error: "registry unavailable", message: "Could not check for updates: registry unavailable" }, /Update failed: Could not check for updates: registry unavailable/, false],
      ["unsupported-install-method", { currentVersion: "1.2.3", latestVersion: "2.0.0", updated: false, outcome: "unsupported-install-method", message: "Use pull and rebuild for this source checkout." }, /pull and rebuild/i, false],
      ["failed", { currentVersion: "1.2.3", latestVersion: "2.0.0", updated: false, outcome: "failed", error: "npm failed", message: "npm failed" }, /Update failed: npm failed/, false],
    ])("renders the %s install outcome in the Settings live status", async (_outcome, response, expected, restarts) => {
      mockCheckForUpdates.mockResolvedValue(availableUpdate);
      mockInstallUpdate.mockResolvedValue(response);
      renderModal();
      await waitForSettingsModalReady();
      await settingsModalUser.click(screen.getByRole("button", { name: "Check for updates" }));
      await settingsModalUser.click(await screen.findByRole("button", { name: "Update now" }));

      const status = await screen.findByText(expected);
      expect(status).toHaveAttribute("aria-live", "polite");
      if (_outcome === "check-failed") expect(status).not.toHaveTextContent(/up to date/i);
      expect(screen.queryByRole("button", { name: "Restart Fusion" })).toBe(restarts ? screen.getByRole("button", { name: "Restart Fusion" }) : null);
    });

    it("clears stale unsupported guidance by re-probing after a successful install", async () => {
      // Mount probe fails (fails closed to "unsupported"); the post-install re-probe
      // proves the host is supervised after all.
      mockFetchSystemInfo.mockRejectedValueOnce(new Error("unavailable"));

      const restartButton = await renderUpdatedSettings();

      await waitFor(() => expect(screen.queryByText(/Needs a supervising parent/)).not.toBeInTheDocument());
      expect(restartButton).toBeEnabled();
    });

    it("keeps the retry path and hides restart when update installation fails", async () => {
      mockInstallUpdate.mockResolvedValue({
        currentVersion: "1.2.3",
        latestVersion: "2.0.0",
        updated: false,
        error: "Install failed",
      });
      mockCheckForUpdates.mockResolvedValue(availableUpdate);
      renderModal();
      await waitForSettingsModalReady();
      await settingsModalUser.click(screen.getByRole("button", { name: "Check for updates" }));
      await screen.findByRole("button", { name: "Update now" });
      await settingsModalUser.click(screen.getByRole("button", { name: "Update now" }));

      expect(await screen.findByText(/Update failed: Install failed/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Update now" })).toBeEnabled();
      expect(screen.queryByRole("button", { name: "Restart Fusion" })).not.toBeInTheDocument();
    });
  });

  const deepwikiServer = {
    name: "deepwiki",
    transport: "stdio" as const,
    command: "npx",
    args: ["-y", "mcp-remote", "https://mcp.deepwiki.com/sse"],
  };

  it("binds Global MCP controls to raw global settings instead of the merged project value", async () => {
    mockFetchSettings.mockResolvedValue({
      ...defaultSettings,
      mcpServers: { enabled: true, servers: [deepwikiServer] },
    });
    mockFetchSettingsByScope.mockResolvedValue({
      global: { ...defaultSettings, mcpServers: { enabled: false, servers: [] } },
      project: { mcpServers: { enabled: true, servers: [deepwikiServer] } },
    });

    renderModal({ initialSection: "global-mcp", projectId: "proj-1" });
    await waitForSettingsModalReady();

    expect(screen.getByRole("checkbox", { name: /Enable MCP servers for this scope/i })).not.toBeChecked();
    expect(screen.queryByTestId("mcp-server-row-deepwiki")).not.toBeInTheDocument();
  });

  it("binds Project MCP controls to raw project settings", async () => {
    mockFetchSettings.mockResolvedValue({
      ...defaultSettings,
      mcpServers: { enabled: true, servers: [deepwikiServer] },
    });
    mockFetchSettingsByScope.mockResolvedValue({
      global: { ...defaultSettings, mcpServers: { enabled: false, servers: [] } },
      project: { mcpServers: { enabled: true, servers: [deepwikiServer] } },
    });

    renderModal({ initialSection: "mcp", projectId: "proj-1" });
    await waitForSettingsModalReady();

    expect(screen.getByRole("checkbox", { name: /Enable MCP servers for this scope/i })).toBeChecked();
    expect(await screen.findByTestId("mcp-server-row-deepwiki")).toHaveTextContent("project local");
  });

  it("persists a scoped MCP edit after navigating to another section before saving", async () => {
    mockFetchSettings.mockResolvedValue({
      ...defaultSettings,
      mcpServers: { enabled: true, servers: [deepwikiServer] },
    });
    mockFetchSettingsByScope.mockResolvedValue({
      global: { ...defaultSettings, mcpServers: { enabled: false, servers: [] } },
      project: { mcpServers: { enabled: true, servers: [deepwikiServer] } },
    });

    renderModal({ initialSection: "mcp", projectId: "proj-1" });
    await waitForSettingsModalReady();

    await settingsModalUser.click(screen.getByRole("checkbox", { name: /Enable MCP servers for this scope/i }));
    await settingsModalUser.click(screen.getByRole("button", { name: /^General · Global$/ }));

    await waitFor(() => {
      expect(mockUpdateSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          mcpServers: { enabled: false, servers: [deepwikiServer] },
        }),
        "proj-1",
      );
    });
  });

  it("applies keyboard CSS variables when mobile keyboard is open", async () => {
    mockUseMobileKeyboard.mockReturnValue({
      keyboardOpen: true,
      keyboardOverlap: 250,
      viewportHeight: 400,
      viewportOffsetTop: 50,
    });

    renderModal();
    await waitForSettingsModalReady();
    /*
    FNXC:SettingsModalTests 2026-07-28-17:00:
    FN-8606 migrated the modal branch to the shared FloatingWindow, which portals the
    `.settings-modal` panel to document.body. Container-scoped queries no longer see it, so
    resolve the keyboard-styled panel from the document root.
    */
    const modal = document.querySelector(".settings-modal");

    expect(mockUseMobileKeyboard).toHaveBeenCalledWith({ enabled: true });
    expect(modal?.getAttribute("style")).toContain("--keyboard-overlap: 250px");
    expect(modal?.getAttribute("style")).toContain("--vv-height: 400px");
  });

  /*
  FNXC:SettingsNavigation 2026-07-16-01:10:
  Authentication was the previous default; FN-8130 requires Settings to open on Appearance, the global Preferences section, when no explicit initialSection is supplied.

  FNXC:SettingsNavigation 2026-07-16-13:40:
  Appearance is not behind the Advanced switch, so the landing section can never be one the operator has hidden; that is asserted here rather than left implicit.
  */
  it("defaults to the Appearance section when no initialSection is provided", async () => {
    render(
      <SettingsModal
        onClose={noop}
        addToast={noop}
      />,
    );
    await waitForSettingsModalReady();

    expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument();
    /*
    FNXC:SettingsNavigation 2026-07-16-01:30:
    The test asserts a reachable concrete landing surface rather than nav position. Appearance is in the Preferences group, and its placement may change, but the section Settings opens on must never be one the Advanced switch hides.
    */
    expect(screen.getByRole("checkbox", { name: "Advanced settings" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: /^Appearance$/ })).toBeInTheDocument();
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
    expect(document.querySelector(".settings-content")).toHaveAttribute("data-show-advanced", "false");
    expect(screen.queryByRole("button", { name: /^Node Sync$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Experimental Features$/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Appearance$/ })).toBeInTheDocument();

    await settingsModalUser.click(toggle);
    expect(document.querySelector(".settings-content")).toHaveAttribute("data-show-advanced", "true");
    expect(localStorage.getItem("fusion:settings:show-advanced")).toBe("true");
    expect(screen.getByRole("button", { name: /^Node Sync$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Experimental Features$/ })).toBeInTheDocument();

    firstRender.unmount();
    renderModal({ initialSection: "authentication" });
    await waitForSettingsModalReady();
    expect(screen.getByRole("checkbox", { name: "Advanced settings" })).toBeChecked();
  });

  it("keeps Remote Access reachable in Basic-mode desktop navigation, search, and initial routing", async () => {
    viewportMode = "desktop";
    localStorage.removeItem("fusion:settings:show-advanced");
    renderModal({ initialSection: "remote" });
    await waitForSettingsModalReady();

    expect(screen.getByRole("checkbox", { name: "Advanced settings" })).not.toBeChecked();
    expect(localStorage.getItem("fusion:settings:show-advanced")).toBeNull();
    expect(screen.getAllByRole("button", { name: /^Remote Access$/ })).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Remote Access" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Node Sync$/ })).not.toBeInTheDocument();

    await settingsModalUser.click(screen.getByRole("button", { name: /^Remote Access$/ }));
    expect(screen.getByRole("heading", { name: "Remote Access" })).toBeInTheDocument();

    await settingsModalUser.type(screen.getByTestId("settings-search-input"), "cloudflared");
    expect(screen.getAllByRole("button", { name: /^Remote Access$/ })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /^Node Sync$/ })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Remote Access" })).toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: /^General · Global$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^General · Project$/ })).toBeInTheDocument();

    await settingsModalUser.type(search, "   ");
    expect(screen.getByRole("button", { name: /^General · Global$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^General · Project$/ })).toBeInTheDocument();

    await settingsModalUser.clear(search);
    await settingsModalUser.type(search, "completion documentation");

    expect(screen.queryByRole("button", { name: /^General · Global$/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^General · Project$/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "General" })).toBeInTheDocument();
    expect(screen.getByText("1 matching section")).toBeInTheDocument();

    await settingsModalUser.clear(search);
    await settingsModalUser.type(search, "Autonomy mode");

    expect(screen.queryByRole("button", { name: /^General · Project$/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^CLI Agents$/ })).toBeInTheDocument();
    expect(screen.getByTestId("cli-agents-settings")).toBeInTheDocument();

    await settingsModalUser.clear(search);
    await settingsModalUser.type(search, "research providers");

    expect(screen.queryByRole("button", { name: /^Research · Global$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Research$/ })).not.toBeInTheDocument();
    expect(screen.getAllByText(/No settings sections match/).length).toBeGreaterThan(0);
  });

  /*
   * FNXC:SettingsSearch 2026-08-19-14:19:
   * The migrated index must make the existing conversation-layout row discoverable
   * through every Settings presentation: desktop search is open, mobile search is
   * expanded explicitly, and embedded Settings uses the same production modal.
   * Clicking each result verifies the real row anchor rather than a test-only stub.
   */
  it.each([
    {
      name: "desktop modal by label",
      viewport: "desktop" as const,
      presentation: undefined,
      query: "conversation layout",
      expandSearch: false,
    },
    {
      name: "mobile modal by help text",
      viewport: "mobile" as const,
      presentation: undefined,
      query: "full width",
      expandSearch: true,
    },
    {
      name: "embedded Settings by field key",
      viewport: "mobile" as const,
      presentation: "embedded" as const,
      query: "chatMessageLayout",
      expandSearch: true,
    },
  ])("discovers chat message layout in the $name", async ({ viewport, presentation, query, expandSearch }) => {
    viewportMode = viewport;
    renderModal({ presentation });
    await waitForSettingsModalReady();

    if (expandSearch) {
      await settingsModalUser.click(screen.getByLabelText("Show search"));
    }
    const search = screen.getByTestId("settings-search-input");
    await settingsModalUser.type(search, query);

    expect(screen.getAllByTestId("settings-search-hit-chatMessageLayout")).toHaveLength(1);
    // FNXC:SettingsSearch 2026-08-19-14:19: jsdom lacks the browser scroll API used by the production row-jump effect.
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    await settingsModalUser.click(screen.getByTestId("settings-search-hit-chatMessageLayout"));
    expect(screen.getAllByTestId("settings-search-hit-chatMessageLayout")).toHaveLength(1);
    expect(document.querySelectorAll('[data-settings-key="chatMessageLayout"]')).toHaveLength(1);
  });

  it("keeps duplicate global and project labels searchable while preserving no-results clearing", async () => {
    renderModal();
    await waitForSettingsModalReady();
    await settingsModalUser.click(screen.getByRole("checkbox", { name: "Advanced settings" }));

    // FN-7713: search row is collapsed by default under the "mobile" viewport mock — expand it first.
    await settingsModalUser.click(screen.getByLabelText("Show search"));
    const search = screen.getByTestId("settings-search-input");
    await settingsModalUser.type(search, "mcp");

    /*
    FNXC:SettingsNavigation 2026-07-15-17:35:
    Both MCP sections must be individually identifiable. This previously asserted TWO buttons named exactly "MCP Servers" — it pinned the duplicate-label bug as expected behavior, and the only thing telling the entries apart was the scope icon.
    The nav is grouped by topic now, so the pair sits adjacent under Integrations and each label states its own scope.
    */
    const mcpMatches = screen.getAllByRole("button", { name: /^MCP Servers · (Global|Project)$/ });
    expect(mcpMatches).toHaveLength(2);
    expect(screen.getByRole("button", { name: "MCP Servers · Global" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "MCP Servers · Project" })).toBeInTheDocument();
    expect(screen.getByText("2 matching sections")).toBeInTheDocument();

    await settingsModalUser.clear(search);
    await settingsModalUser.type(search, "definitely not a setting");

    expect(screen.queryByRole("button", { name: /^MCP Servers · / })).not.toBeInTheDocument();
    await settingsModalUser.click(screen.getAllByRole("button", { name: "Clear settings search" })[0]);
    expect(screen.getByRole("button", { name: /^General · Global$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^General · Project$/ })).toBeInTheDocument();
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
      expect(screen.getByRole("button", { name: /^Models · Global$/ })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^General · Project$/ })).not.toBeInTheDocument();

      fireEvent.keyDown(search, { key: "Escape" });
      expect(onClose).not.toHaveBeenCalled();
      expect(search).toHaveValue("");
      expect(screen.getByRole("button", { name: /^General · Project$/ })).toBeInTheDocument();
    });

    it("keeps the overlay and Escape-to-close in modal mode", async () => {
      const onClose = vi.fn();
      renderModal({ onClose });
      await waitForSettingsModalReady();

      /*
      FNXC:SettingsModalTests 2026-07-28-17:00:
      FN-8606 migrated the modal branch to the shared FloatingWindow: the dialog overlay is now
      `.floating-window-overlay` portaled to document.body (not the legacy `.settings-modal-overlay`).
      Escape-to-close is still owned by SettingsModal's own keydown handler, so the dismissal
      contract is unchanged.
      */
      expect(document.querySelector(".floating-window-overlay")).not.toBeNull();
      expect(document.querySelector(".settings-modal--embedded")).toBeNull();
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

    // FNXC:SettingsModalTests 2026-08-11-00:19: set both selects under fake timers so the 500ms auto-save debounce still coalesces them into one write, without the real-timer wait.
    vi.useFakeTimers();
    fireEvent.change(screen.getByLabelText("AI merge"), { target: { value: "deterministic" } });
    fireEvent.change(screen.getByLabelText("Integration worktree"), { target: { value: "cwd-main" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(mockUpdateSettings).toHaveBeenCalledTimes(1);
    vi.useRealTimers();

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
    await settingsModalUser.click(screen.getByRole("checkbox", { name: "Advanced settings" }));

    await settingsModalUser.click(screen.getByRole("button", { name: /^Worktrees$/ }));

    const checkbox = screen.getByRole("checkbox", { name: "Allow silent sibling branch rename during executor conflicts" });
    expect(checkbox).not.toBeChecked();

    // FNXC:SettingsModalTests 2026-08-11-00:19: navigate with userEvent under real timers, then flush the 500ms auto-save debounce with fake timers instead of a real-timer waitFor.
    vi.useFakeTimers();
    fireEvent.click(checkbox);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(mockUpdateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ executorAllowSiblingBranchRename: true }),
      undefined,
    );
    vi.useRealTimers();
    expect(screen.getByText(/restores the legacy behavior/i)).toBeInTheDocument();
  });

  describe("deferred settings fetches", () => {
    /*
    FNXC:SettingsConcurrency 2026-07-15-18:52:
    FNXC:CapacityModel 2026-07-29-03:10 (drop the cross-project cap — settings half):
    DELETED. This asserted that opening a Scheduling section triggers the
    global-concurrency fetch. SettingsModal no longer performs that fetch at all —
    the machine-wide cap it loaded is gone (capacity is two numbers PER PROJECT) and
    the modal has no global-concurrency state left to defer.

    The deferral REQUIREMENT it encoded — do not hit an endpoint until its section is
    opened — is still covered for the surfaces that still fetch (e.g. the memory
    backend-status hook test below).
    */

    /*
    FNXC:SettingsConcurrency 2026-07-15-18:52:
    The invariant is unchanged — a concurrency input stays disabled until its live value arrives, so an operator cannot overwrite a resolved limit with a blank fallback.

    FNXC:CapacityModel 2026-07-29-03:10 (drop the cross-project cap — settings half):
    The global half of this case is gone with the cap and its section; capacity is two
    numbers PER PROJECT and both live in the settings form. The gate that enforces the
    invariant also moved: it read the GLOBAL-concurrency fetch, which was never the
    right source for project inputs, and now reads the form's own load.
    */
    it("does not render concurrency inputs until their actual values load", async () => {
      /*
      FNXC:CapacityModel 2026-07-29-03:25 (drop the cross-project cap — settings half):
      The invariant is unchanged — an operator must never be able to edit a
      concurrency input showing a blank fallback and overwrite a resolved limit. HOW
      it holds changed, and the assertion follows the mechanism rather than pinning a
      `disabled` attribute that can no longer be observed.

      Previously the inputs rendered immediately and were DISABLED while the separate
      global-concurrency fetch was in flight. Both remaining numbers (maxConcurrent,
      maxWorktrees) now come from the settings form itself, and the modal renders
      "Loading…" instead of any section until that form resolves — so the input does
      not EXIST until its value does. Structural, and strictly stronger than
      disabled: there is nothing to focus, type into, or re-enable via devtools.

      Measured while fixing this: repointing `concurrencyLoading` at the form's own
      `loading` makes it unobservable for exactly this reason. Keeping the old
      `toBeDisabled()` assertion would have required the input to render during load,
      which is the weaker behaviour.
      */
      mockFetchSettings.mockReturnValue(new Promise(() => {}));
      renderModal({ initialSection: "scheduling" });
      await waitFor(() => expect(mockFetchSettings).toHaveBeenCalled());
      expect(screen.queryByLabelText("Max Concurrent Tasks")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Max Worktrees")).not.toBeInTheDocument();

      // ...and once it resolves, the input is present and editable.
      mockFetchSettings.mockResolvedValue({});
      cleanup();
      renderModal({ initialSection: "scheduling" });
      await waitForSettingsModalReady();
      expect(await screen.findByLabelText("Max Concurrent Tasks")).not.toBeDisabled();
      // FNXC:SettingsConcurrency 2026-07-24-03:10: FN-8453 (eef5eb751) removed
      // the duplicate "Max Triage Concurrent" control when concurrency
      // accounting was unified; it must stay gone.
      expect(screen.queryByLabelText("Max Triage Concurrent")).not.toBeInTheDocument();
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

      /*
      FNXC:DashboardTests 2026-07-18-13:35:
      Settings nav also exposes "Memory Backups"; /Memory/ matches both. Use the exact
      Memory section label so the deferred memory-backend status hook test stays scoped.
      */
      await settingsModalUser.click(screen.getByRole("button", { name: "Memory" }));

      await waitFor(() => {
        const enabledCallSeen = mockUseMemoryBackendStatus.mock.calls.some(
          (call) => call[0]?.enabled === true,
        );
        expect(enabledCallSeen).toBe(true);
      });
    });
  });

  describe("Global General", () => {
    beforeEach(() => {
      __test_resetPendingUpdateInstall();
      localStorage.setItem("fusion:settings:show-advanced", "true");
    });

    // Read-only default-render assertions are merged into one rendered
    // instance to avoid re-rendering the full modal per pure-display check.
    it("renders default global logging fields and helper text", async () => {
      const { persistAgentToolOutput: _omittedToolOutput, ...settingsWithoutToolOutput } = defaultSettings;
      mockFetchSettings.mockResolvedValue(settingsWithoutToolOutput);
      mockFetchSettingsByScope.mockResolvedValue({ global: settingsWithoutToolOutput, project: {} });
      renderModal({ initialSection: "global-general" });
      await waitForSettingsModalReady();

      // Global modal outside-dismiss stays unchecked while unset tool-output persistence uses its enabled default.
      expect(screen.getByRole("checkbox", { name: "Dismiss modals by clicking outside" })).not.toBeChecked();
      /*
      FNXC:SettingsHelp 2026-07-15-22:10:
      Migrated rows render help through the shared primitive rather than a bespoke `<small>`. The copy now lives in the help tip's bubble (`.settings-help-bubble`) instead of an inline `.settings-field-row-help` paragraph — deferred visually, but still in the DOM and the accessibility tree, which is why `getByText` still resolves it.
      The assertion's intent is unchanged: this row's help must come from the primitive, not hand-rolled markup.
      */
      expect(screen.getByText(/Default: disabled, to prevent accidental dismissal/i).closest(".settings-help-bubble")).toBeTruthy();
      expect(screen.getByRole("checkbox", { name: "Save tool output in agent logs" })).toBeChecked();
      expect(screen.getByRole("checkbox", { name: "Enable proactive task-chat updates" })).not.toBeChecked();
      expect(screen.queryByRole("checkbox", { name: /Show "Star on GitHub" button in Settings header/i })).toBeNull();

      // thinking-log checkboxes default to unchecked.
      expect(screen.getByRole("checkbox", { name: "Save AI thinking for permanent agents" })).not.toBeChecked();
      expect(screen.getByRole("checkbox", { name: "Save AI thinking for ephemeral / task-worker agents" })).not.toBeChecked();

      /*
      FNXC:SettingsHelp 2026-07-16-12:45:
      All help copy — including the bespoke thinking-log group's shared string, which previously stayed in an inline <small> — now renders behind the shared "?" affordance (operator requirement: no inline description paragraphs in Settings). Both helpers must resolve inside a help bubble.
      */
      expect(document.querySelector(".settings-field-help")).toBeNull();
      const toolOutputHelper = screen.getByText(/When disabled, tool rows are still logged but detailed tool payloads are omitted/i);
      expect(toolOutputHelper.closest(".settings-help-bubble")).toBeTruthy();
      const thinkingHelper = screen.getByText(/Leave both thinking toggles off to keep the original default behavior/i);
      expect(thinkingHelper.closest(".settings-help-bubble")).toBeTruthy();
    });

    /*
    FNXC:SourceControl 2026-07-15-20:30:
    The tracking-repo control and the GitLab disclosure moved to "Source Control · Global". Asserting they are GONE from here (not just present there) is the half that catches a partial move: a section left rendering a second copy of a dual-scope control is exactly the duplicate-`gitlabEnabled` bug this split removed, and it would leave every positive assertion green.
    */
    it("no longer renders the moved source-control controls", async () => {
      renderModal({ initialSection: "global-general" });
      await waitForSettingsModalReady();

      expect(screen.queryByRole("combobox", { name: "Global default tracking repo" })).not.toBeInTheDocument();
      expect(screen.queryByTestId("global-gitlab-configuration-disclosure")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Enable GitLab integration")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Global GitLab instance URL")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Global GitLab access token")).not.toBeInTheDocument();
    });

    it("renders the moved global tracking repo control and its inheritance hint in Source Control · Global", async () => {
      renderModal({ initialSection: "source-control-global" });
      await waitForSettingsModalReady();

      expect(screen.getByRole("combobox", { name: "Global default tracking repo" })).toBeInTheDocument();
      expect(screen.getByText(/Projects inherit this value when they do not set a project default tracking repo/i)).toBeInTheDocument();
    });

    it("uses the enabled effective default when fetched global settings omit the key", async () => {
      const { persistAgentToolOutput: _omittedToolOutput, ...settingsWithoutToolOutput } = defaultSettings;
      mockFetchSettings.mockResolvedValue(settingsWithoutToolOutput);
      mockFetchSettingsByScope.mockResolvedValue({ global: settingsWithoutToolOutput, project: {} });

      renderModal({ initialSection: "global-general" });
      await waitForSettingsModalReady();

      expect(screen.getByRole("checkbox", { name: "Save tool output in agent logs" })).toBeChecked();
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

      /*
      FNXC:SettingsModalTests 2026-08-11-00:19:
      Drive the 500ms auto-save debounce with fake timers instead of a real-timer waitFor.
      Each of these single-edit "saves X via settings payload" tests otherwise burned a real
      ~500ms debounce wall-clock wait, and together they dominated the dashboard's slowest
      feedback-loop suite. Advancing fake timers keeps the payload-routing assertions identical
      while removing the artificial wait (Standing Rule: prefer fake timers over real time waits;
      matches the FN-7506 auto-save conversions already in this file).
      */
      vi.useFakeTimers();
      fireEvent.click(screen.getByRole("checkbox", { name: "Dismiss modals by clicking outside" }));
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      expect(mockUpdateGlobalSettings).toHaveBeenCalled();
      vi.useRealTimers();

      const globalPayload = mockUpdateGlobalSettings.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(globalPayload.dismissModalsOnOutsideClick).toBe(true);
      if (mockUpdateSettings.mock.calls.length > 0) {
        const projectPayload = mockUpdateSettings.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(projectPayload.dismissModalsOnOutsideClick).toBeUndefined();
      }
    });

    it("saves skipConfirmationDialogs only via global settings payload", async () => {
      renderModal({ initialSection: "global-general" });
      await waitForSettingsModalReady();

      vi.useFakeTimers();
      fireEvent.click(screen.getByRole("checkbox", { name: "Skip confirmation dialogs for critical actions" }));
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      expect(mockUpdateGlobalSettings).toHaveBeenCalled();
      vi.useRealTimers();

      const globalPayload = mockUpdateGlobalSettings.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(globalPayload.skipConfirmationDialogs).toBe(true);
      if (mockUpdateSettings.mock.calls.length > 0) {
        const projectPayload = mockUpdateSettings.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(projectPayload.skipConfirmationDialogs).toBeUndefined();
      }
    });

    it("saves quickAddSubmitOnEnter only via global settings payload", async () => {
      renderModal({ initialSection: "global-general" });
      await waitForSettingsModalReady();

      vi.useFakeTimers();
      fireEvent.click(screen.getByRole("checkbox", { name: "Press Enter to save a task in Quick Add" }));
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      expect(mockUpdateGlobalSettings).toHaveBeenCalled();
      vi.useRealTimers();

      const globalPayload = mockUpdateGlobalSettings.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(globalPayload.quickAddSubmitOnEnter).toBe(false);
      if (mockUpdateSettings.mock.calls.length > 0) {
        const projectPayload = mockUpdateSettings.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(projectPayload.quickAddSubmitOnEnter).toBeUndefined();
      }
    });

    it("saves chatSubmitOnEnter only via global settings payload", async () => {
      renderModal({ initialSection: "global-general" });
      await waitForSettingsModalReady();

      vi.useFakeTimers();
      fireEvent.change(screen.getByRole("combobox", { name: "Enter key behavior in conversations" }), {
        target: { value: "never" },
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      expect(mockUpdateGlobalSettings).toHaveBeenCalled();
      vi.useRealTimers();

      const globalPayload = mockUpdateGlobalSettings.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(globalPayload.chatSubmitOnEnter).toBe("never");
      if (mockUpdateSettings.mock.calls.length > 0) {
        const projectPayload = mockUpdateSettings.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(projectPayload.chatSubmitOnEnter).toBeUndefined();
      }
    });

    it("saves persistAgentToolOutput only via global settings payload", async () => {
      renderModal({ initialSection: "global-general" });
      await waitForSettingsModalReady();

      vi.useFakeTimers();
      fireEvent.click(screen.getByRole("checkbox", { name: "Save tool output in agent logs" }));
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      expect(mockUpdateGlobalSettings).toHaveBeenCalled();
      vi.useRealTimers();

      const globalPayload = mockUpdateGlobalSettings.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(globalPayload.persistAgentToolOutput).toBe(false);
      if (mockUpdateSettings.mock.calls.length > 0) {
        const projectPayload = mockUpdateSettings.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(projectPayload.persistAgentToolOutput).toBeUndefined();
      }
    });

    it("saves proactive task-chat updates only via global settings payload", async () => {
      renderModal({ initialSection: "global-general" });
      await waitForSettingsModalReady();

      vi.useFakeTimers();
      fireEvent.click(screen.getByRole("checkbox", { name: "Enable proactive task-chat updates" }));
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      expect(mockUpdateGlobalSettings).toHaveBeenCalled();
      vi.useRealTimers();

      const globalPayload = mockUpdateGlobalSettings.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(globalPayload.proactiveTaskChatEnabled).toBe(true);
      if (mockUpdateSettings.mock.calls.length > 0) {
        const projectPayload = mockUpdateSettings.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(projectPayload.proactiveTaskChatEnabled).toBeUndefined();
      }
    });

    it("saves granular thinking-log flags only via global settings payload", async () => {
      renderModal({ initialSection: "global-general" });
      await waitForSettingsModalReady();

      vi.useFakeTimers();
      fireEvent.click(screen.getByRole("checkbox", { name: "Save AI thinking for permanent agents" }));
      fireEvent.click(screen.getByRole("checkbox", { name: "Save AI thinking for ephemeral / task-worker agents" }));
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      expect(mockUpdateGlobalSettings).toHaveBeenCalled();
      vi.useRealTimers();

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

      renderModal({ initialSection: "source-control-global" });
      await waitForSettingsModalReady();

      await waitFor(() => {
        expect(screen.getByRole("combobox", { name: "Global default tracking repo" })).toHaveValue("__custom__");
      });

      await settingsModalUser.selectOptions(screen.getByRole("combobox", { name: "Global default tracking repo" }), "octo/global-default");

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
      renderModal({ initialSection: "source-control-global" });
      await waitForSettingsModalReady();

      expect(screen.getByLabelText("Global GitLab instance URL")).toHaveAttribute("placeholder", "https://gitlab.com");
      expect(screen.getByText(/Blank defaults to GitLab.com/i)).toBeInTheDocument();

      /*
      FNXC:SettingsModalTests 2026-08-11-00:19:
      Both field edits are set with fireEvent.change under fake timers so the 500ms auto-save
      debounce still coalesces them into a single global payload (the trimming lives in the save
      path, so the raw padded values persist trimmed exactly as before) while removing the
      real-timer wait that made this the single slowest case in the suite.
      */
      vi.useFakeTimers();
      fireEvent.change(screen.getByLabelText("Global GitLab instance URL"), { target: { value: " https://gitlab.company.test/ " } });
      fireEvent.change(screen.getByLabelText("Global GitLab API base URL (optional / advanced)"), { target: { value: " https://gitlab.company.test/api/v4/ " } });
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      expect(mockUpdateGlobalSettings).toHaveBeenCalled();
      vi.useRealTimers();

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

      renderModal({ initialSection: "source-control-global" });
      await waitForSettingsModalReady();

      const enableToggle = screen.getByLabelText("Enable GitLab integration") as HTMLInputElement;
      expect(enableToggle).not.toBeChecked();
      expect(screen.getByLabelText("Global GitLab instance URL")).toBeDisabled();

      expect(mockUpdateGlobalSettings).not.toHaveBeenCalledWith(expect.objectContaining({ gitlabEnabled: true }));
    });

    it("saves an explicit global GitLab enable edit without using the project override", async () => {
      mockFetchSettings.mockResolvedValueOnce({ ...defaultSettings, gitlabEnabled: true });
      mockFetchSettingsByScope.mockResolvedValueOnce({
        global: { ...defaultSettings, gitlabEnabled: false },
        project: { gitlabEnabled: true },
      });

      renderModal({ initialSection: "source-control-global" });
      await waitForSettingsModalReady();

      vi.useFakeTimers();
      fireEvent.click(screen.getByLabelText("Enable GitLab integration"));
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      expect(mockUpdateGlobalSettings).toHaveBeenCalledWith(expect.objectContaining({ gitlabEnabled: true }));
      vi.useRealTimers();
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

      renderModal({ initialSection: "source-control-global" });
      await waitForSettingsModalReady();

      const enableToggle = screen.getByLabelText("Enable GitLab integration") as HTMLInputElement;
      expect(enableToggle).toBeChecked();

      vi.useFakeTimers();
      fireEvent.click(enableToggle);
      expect(enableToggle).not.toBeChecked();
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      expect(mockUpdateGlobalSettings).toHaveBeenCalledWith(expect.objectContaining({ gitlabEnabled: false }));
      vi.useRealTimers();
    });

    it("shows global tracking repo error hint and keeps custom entry when lookups fail", async () => {
      mockFetchProjects.mockRejectedValueOnce(new Error("no projects"));

      renderModal({ initialSection: "source-control-global" });
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

    vi.useFakeTimers();
    fireEvent.change(screen.getByLabelText("Approval mode"), { target: { value: "always" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(mockUpdateSettings).toHaveBeenCalled();
    vi.useRealTimers();

    const payload = mockUpdateSettings.mock.calls[0]?.[0] as {
      agentProvisioning?: { approvalMode?: string };
    };
    expect(payload.agentProvisioning?.approvalMode).toBe("always");
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
      // FNXC:SettingsModalTests 2026-08-11-00:19: flush the 500ms auto-save debounce with fake timers rather than a real-timer waitFor.
      vi.useFakeTimers();
      fireEvent.click(screen.getByRole("button", { name: "Largest" }));
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      expect(mockUpdateGlobalSettings).toHaveBeenCalled();
      vi.useRealTimers();

      const payload = mockUpdateGlobalSettings.mock.calls[0][0];
      expect(payload).toEqual(expect.objectContaining({ dashboardFontScalePct: 120 }));
    });
  });

  describe("auto-save", () => {
    const changeProjectToggle = () => fireEvent.click(screen.getByLabelText("Show capacity risk banner"));

    it("removes the Save button in both modal and embedded presentations", async () => {
      const { unmount } = renderModal({ initialSection: "general" });
      await waitForSettingsModalReady();
      expect(screen.queryByRole("button", { name: /^Save$/i })).not.toBeInTheDocument();
      unmount();

      renderModal({ initialSection: "general", presentation: "embedded" });
      await waitForSettingsModalReady();
      expect(screen.queryByRole("button", { name: /^Save$/i })).not.toBeInTheDocument();
    });

    /*
    FNXC:SettingsModalTests 2026-07-27-17:20:
    Target the footer/mobile Close affordances by their scoped selectors (`.modal-actions-right button`,
    `.settings-embedded-mobile-close`) rather than `*ByRole("button", { name: "Close" })`. The role+name
    query recomputes the accessible name for every button in the large Settings tree, which added ~700ms
    per dismissal test in the dashboard's slowest feedback-loop suite. The scoped selectors mirror the
    already-fast header/Escape/backdrop siblings while keeping the flush-on-close assertions identical
    (Standing Rule: do not add slow tests / prefer narrow seams over whole-tree walks).
    */
    it.each([
      ["footer Close", async (container: HTMLElement) => settingsModalUser.click(container.querySelector(".modal-actions-right button") as HTMLButtonElement)],
      ["header close", async (container: HTMLElement) => settingsModalUser.click(container.querySelector(".modal-close") as HTMLButtonElement)],
      ["Escape", async () => { fireEvent.keyDown(document, { key: "Escape" }); }],
      /*
      FNXC:SettingsModalTests 2026-07-28-17:00:
      FN-8606's FloatingWindow migration replaced the click-through backdrop element with an
      opt-in outside-pointerdown dismissal (see FloatingWindow `closeOnOutsidePointerDown`). Dismiss
      by firing a document-level pointerdown outside the panel instead of clicking a `.settings-modal-overlay`.
      */
      ["backdrop", async () => {
        fireEvent.pointerDown(document.body);
      }],
    ])("flushes the latest edit through %s without a leave warning", async (path, dismiss) => {
      const onClose = vi.fn();
      const result = path === "backdrop"
        ? render(<ModalDismissPreferenceProvider enabled><SettingsModal initialSection="general" onClose={onClose} addToast={noop} /></ModalDismissPreferenceProvider>)
        : renderModal({ initialSection: "general", onClose });
      await waitForSettingsModalReady();
      changeProjectToggle();
      await dismiss(result.container);

      await waitFor(() => expect(mockUpdateSettings).toHaveBeenCalledWith(
        expect.objectContaining({ capacityRiskBannerEnabled: true }),
        undefined,
      ));
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("dialog", { name: /unsaved/i })).not.toBeInTheDocument();
    });

    it("flushes the latest edit through the embedded mobile close affordance", async () => {
      const onClose = vi.fn();
      const { container } = renderModal({ initialSection: "general", presentation: "embedded", onClose });
      await waitForSettingsModalReady();
      changeProjectToggle();
      // FNXC:SettingsModalTests 2026-07-27-17:20: scoped selector avoids the whole-tree accessible-name walk of getByRole({ name: "Close" }).
      await settingsModalUser.click(container.querySelector(".settings-embedded-mobile-close") as HTMLButtonElement);

      await waitFor(() => expect(mockUpdateSettings).toHaveBeenCalledWith(
        expect.objectContaining({ capacityRiskBannerEnabled: true }),
        undefined,
      ));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("coalesces rapid edits into one debounced write", async () => {
      renderModal({ initialSection: "general" });
      await waitForSettingsModalReady();
      vi.useFakeTimers();

      const toggle = screen.getByLabelText("Show capacity risk banner");
      fireEvent.click(toggle);
      fireEvent.click(toggle);
      fireEvent.click(toggle);
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      expect(mockUpdateSettings).toHaveBeenCalledTimes(1);
      expect(mockUpdateSettings).toHaveBeenLastCalledWith(expect.objectContaining({ capacityRiskBannerEnabled: true }), undefined);
      vi.useRealTimers();
    });

    /*
    FNXC:CapacityModel 2026-07-29-03:10 (drop the cross-project cap — settings half):
    The global-concurrency half of this auto-save case is deleted with the control it
    edited; `updateGlobalConcurrency` no longer exists. The scoped-MCP half is the
    part that still exercises save-without-Save, so it is kept and the case renamed
    to what it now covers.
    */
    it("persists scoped MCP edits without Save", async () => {
      renderModal({ initialSection: "mcp" });
      await waitForSettingsModalReady();
      const mcpToggle = await screen.findByLabelText("Enable MCP servers for this scope");
      vi.useFakeTimers();
      fireEvent.click(mcpToggle);
      await flushSettingsAutoSave();
      vi.useRealTimers();
      expect(mockUpdateSettings).toHaveBeenLastCalledWith(
        expect.objectContaining({ mcpServers: expect.objectContaining({ enabled: true }) }),
        undefined,
      );
    });

    it("keeps Settings open after a persist failure and retries on the next edit", async () => {
      const addToast = vi.fn();
      mockUpdateSettings.mockRejectedValueOnce(new Error("offline"));
      renderModal({ initialSection: "general", addToast });
      await waitForSettingsModalReady();
      /*
      FNXC:SettingsModalTests 2026-07-25-18:20:
      Drive the 500ms auto-save debounce deterministically with fake timers instead of a real-timer waitFor.
      Waiting the debounce out on the wall clock (two cycles) added ~1s of dead time to the dashboard's
      slowest feedback-loop suite for no added coverage; advancing fake timers keeps the retry semantics
      identical while removing the artificial wait (Standing Rule: prefer fake timers over real time waits).
      */
      vi.useFakeTimers();

      changeProjectToggle();
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      expect(mockUpdateSettings).toHaveBeenCalledTimes(1);
      expect(addToast).toHaveBeenCalledWith("offline", "error");
      expect(screen.getByRole("dialog")).toBeInTheDocument();

      changeProjectToggle();
      changeProjectToggle();
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      expect(mockUpdateSettings).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("button", { name: /^Save$/i })).not.toBeInTheDocument();
      vi.useRealTimers();
    });

    it("trails an in-flight snapshot so an older response cannot overwrite the final edit", async () => {
      let finishFirstSave: (() => void) | undefined;
      mockUpdateSettings.mockImplementationOnce(() => new Promise<void>((resolve) => { finishFirstSave = resolve; }));
      renderModal({ initialSection: "general" });
      await waitForSettingsModalReady();
      // FNXC:SettingsModalTests 2026-07-25-18:20: fake timers flush the 500ms auto-save debounce without a real-timer wait; the trailing-snapshot persist still fires when the in-flight save resolves.
      vi.useFakeTimers();

      changeProjectToggle();
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      expect(mockUpdateSettings).toHaveBeenCalledTimes(1);
      changeProjectToggle();
      await act(async () => { finishFirstSave?.(); });

      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      expect(mockUpdateSettings).toHaveBeenCalledTimes(2);
      expect(mockUpdateSettings.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ capacityRiskBannerEnabled: true }));
      expect(mockUpdateSettings.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ capacityRiskBannerEnabled: false }));
      vi.useRealTimers();
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
      /*
      FNXC:SourceControl 2026-07-15-20:30:
      Merge's reset no longer touches ANY forge key — they all moved to "source-control". This used to assert only that `gitlabEnabled` stayed out while `gitlabAuthToken` was reset from here, which was the registry arbitrating a key two sections rendered.
      */
      expect(payload).not.toHaveProperty("gitlabAuthToken");
      expect(payload).not.toHaveProperty("gitlabAuthTokenType");
      expect(payload).not.toHaveProperty("githubAuthMode");
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
      expect(payload.maxRecommendationsPerTask).toBeNull();
      expect(payload.requireTaskRecommendations).toBeNull();
      expect(payload.recommendationMailboxNoticeEnabled).toBeNull();
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
