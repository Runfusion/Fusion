import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

  it("honors an explicit initialSection override", async () => {
    renderModal({ initialSection: "authentication" });
    await waitForSettingsModalReady();

    expect(screen.getByRole("button", { name: /^Authentication$/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Authentication" })).toBeInTheDocument();
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

    it("disables concurrency inputs until their actual values load", async () => {
      mockFetchGlobalConcurrency.mockReturnValue(new Promise(() => {}));
      renderModal();
      await waitForSettingsModalReady();

      await userEvent.click(screen.getByRole("button", { name: /Scheduling/ }));

      expect(screen.getByLabelText("Global Max Concurrent")).toBeDisabled();
      expect(screen.getByLabelText("Max Concurrent Tasks")).toBeDisabled();
      expect(screen.getByLabelText("Max Triage Concurrent")).toBeDisabled();
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

      // persistAgentToolOutput defaults to unchecked; Star-on-GitHub control absent.
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

    it("saves persistAgentToolOutput only via global settings payload", async () => {
      renderModal({ initialSection: "global-general" });
      await waitForSettingsModalReady();

      await userEvent.click(screen.getByRole("checkbox", { name: "Save tool output in agent logs" }));
      await userEvent.click(screen.getByRole("button", { name: "Save" }));

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

    it("reports Quick Chat launcher changes immediately before save", async () => {
      const onQuickChatButtonModeChange = vi.fn();
      renderModal({ initialSection: "general", onQuickChatButtonModeChange });
      await waitForSettingsModalReady();

      await userEvent.selectOptions(screen.getByLabelText("Quick Chat launcher"), "footer");

      expect(onQuickChatButtonModeChange).toHaveBeenCalledWith("footer");
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
});

