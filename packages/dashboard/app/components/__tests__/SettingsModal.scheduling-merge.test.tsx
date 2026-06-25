import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditorView } from "@codemirror/view";
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
  defaultSettings,
  renderModal,
  waitForSettingsModalReady,
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

  describe("Scheduling overlap ignore paths", () => {
    it("defaults hidden overlap path filtering checked when settings omit the key", async () => {
      const { ignoreHiddenOverlapPaths: _omitted, ...settingsWithoutHiddenDefault } = defaultSettings;
      mockFetchSettings.mockResolvedValue(settingsWithoutHiddenDefault);
      mockFetchSettingsByScope.mockResolvedValue({ global: settingsWithoutHiddenDefault, project: {} });

      renderModal();
      await waitFor(() => expect(mockFetchSettings).toHaveBeenCalled());

      fireEvent.click(screen.getByText("Scheduling & Capacity"));

      expect(screen.getByLabelText(/ignore hidden dot paths in overlap checks/i)).toBeChecked();
    });

    it("renders saved false for hidden overlap path filtering", async () => {
      mockFetchSettings.mockResolvedValue({
        ...defaultSettings,
        ignoreHiddenOverlapPaths: false,
      });
      mockFetchSettingsByScope.mockResolvedValue({ global: defaultSettings, project: { ignoreHiddenOverlapPaths: false } });

      renderModal();
      await waitFor(() => expect(mockFetchSettings).toHaveBeenCalled());

      fireEvent.click(screen.getByText("Scheduling & Capacity"));

      expect(screen.getByLabelText(/ignore hidden dot paths in overlap checks/i)).not.toBeChecked();
    });

    it("sends hidden overlap filtering false without disrupting explicit ignore paths", async () => {
      renderModal();
      await waitFor(() => expect(mockFetchSettings).toHaveBeenCalled());

      fireEvent.click(screen.getByText("Scheduling & Capacity"));

      await userEvent.click(screen.getByLabelText(/ignore hidden dot paths in overlap checks/i));
      await userEvent.type(screen.getByPlaceholderText("docs/"), "generated/*");
      await userEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalledTimes(1);
      });

      const payload = mockUpdateSettings.mock.calls[0][0];
      expect(payload.ignoreHiddenOverlapPaths).toBe(false);
      expect(payload.overlapIgnorePaths).toEqual(["generated/*"]);
    });

    it("sends hidden overlap filtering true after toggling saved false", async () => {
      mockFetchSettings.mockResolvedValue({
        ...defaultSettings,
        ignoreHiddenOverlapPaths: false,
      });
      mockFetchSettingsByScope.mockResolvedValue({ global: defaultSettings, project: { ignoreHiddenOverlapPaths: false } });

      renderModal();
      await waitFor(() => expect(mockFetchSettings).toHaveBeenCalled());

      fireEvent.click(screen.getByText("Scheduling & Capacity"));

      await userEvent.click(screen.getByLabelText(/ignore hidden dot paths in overlap checks/i));
      await userEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalledTimes(1);
      });
      expect(mockUpdateSettings.mock.calls[0][0].ignoreHiddenOverlapPaths).toBe(true);
    });

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
      await waitFor(() => expect(input).not.toBeDisabled());

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
      await waitFor(() => expect(input).not.toBeDisabled());

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

    it("adds, browses, de-duplicates, and saves worktree copy files", async () => {
      mockFetchSettings.mockResolvedValue({
        ...defaultSettings,
        worktreeCopyFiles: [".env"],
      });
      mockFetchSettingsByScope.mockResolvedValue({
        global: defaultSettings,
        project: { worktreeCopyFiles: [".env"] },
      });

      renderModal({ initialSection: "worktrees" });
      await waitForSettingsModalReady();

      expect(screen.getByDisplayValue(".env")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Add file" }));
      const inputs = screen.getAllByLabelText("File to copy into new worktrees") as HTMLInputElement[];
      await userEvent.type(inputs[1], "  .env  ");
      await userEvent.click(screen.getAllByRole("button", { name: "Browse file to copy into new worktrees" })[1]);
      expect(await screen.findByRole("dialog", { name: "Browse file to copy into new worktrees" })).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Select README.md" }));

      await userEvent.click(screen.getByRole("button", { name: "Add file" }));
      const updatedInputs = screen.getAllByLabelText("File to copy into new worktrees") as HTMLInputElement[];
      await userEvent.type(updatedInputs[2], " README.md ");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => expect(mockUpdateSettings).toHaveBeenCalled());
      const payload = mockUpdateSettings.mock.calls[0][0] as Record<string, unknown>;
      expect(payload.worktreeCopyFiles).toEqual([".env", "README.md"]);
    });

    it("clears worktree copy files to an empty persisted list", async () => {
      mockFetchSettings.mockResolvedValue({
        ...defaultSettings,
        worktreeCopyFiles: [".env"],
      });
      mockFetchSettingsByScope.mockResolvedValue({
        global: defaultSettings,
        project: { worktreeCopyFiles: [".env"] },
      });

      renderModal({ initialSection: "worktrees" });
      await waitForSettingsModalReady();

      await userEvent.click(screen.getByRole("button", { name: "Remove copied worktree file" }));
      await userEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => expect(mockUpdateSettings).toHaveBeenCalled());
      const payload = mockUpdateSettings.mock.calls[0][0] as Record<string, unknown>;
      expect(payload.worktreeCopyFiles).toEqual([]);
    });

    it("exposes worktree copy file controls via the mobile Settings Section picker", async () => {
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
      mockFetchSettings.mockResolvedValue({
        ...defaultSettings,
        worktreeCopyFiles: [".env.local"],
      });
      mockFetchSettingsByScope.mockResolvedValue({
        global: defaultSettings,
        project: { worktreeCopyFiles: [".env.local"] },
      });

      renderModal();
      await waitForSettingsModalReady();

      const sectionPicker = screen.getByLabelText("Settings Section") as HTMLSelectElement;
      expect(sectionPicker).toBeInTheDocument();
      expect(sectionPicker.querySelector('option[value="worktrees"]')).toHaveTextContent("Worktrees");

      await userEvent.selectOptions(sectionPicker, "worktrees");

      expect(screen.getByText("Files to copy into new worktrees")).toBeInTheDocument();
      expect(screen.getByDisplayValue(".env.local")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Browse file to copy into new worktrees" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Add file" })).toBeInTheDocument();
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

      // Known features that remain experimental are shown even with no custom features configured.
      expect(screen.queryByText("Insights")).not.toBeInTheDocument();
      // FNXC:SettingsExperimental 2026-06-22-18:50: Roadmaps was removed from Experimental and must not render as a known or stale toggle.
      expect(screen.queryByText("Roadmaps")).not.toBeInTheDocument();

      for (const featureLabel of [
        "Research View",
        "Evals View",
        "Subtask Breakdown",
        "Sandbox (command isolation)",
        "Planning-style Agent Onboarding",
      ]) {
        expect(screen.getByLabelText(featureLabel)).toBeInTheDocument();
      }

      expect(screen.queryByLabelText("Right Dock Panel")).not.toBeInTheDocument();

      // Dev Server has a single canonical toggle (no legacy duplicate).
      expect(screen.getAllByLabelText("Dev Server")).toHaveLength(1);
    });

    it("shows the Subtask Breakdown toggle as off when the setting is missing", async () => {
      mockFetchSettings.mockResolvedValue({
        ...defaultSettings,
        experimentalFeatures: {},
      });

      renderModal();
      await openExperimentalFeaturesSection();

      expect(screen.getByLabelText("Subtask Breakdown")).not.toBeChecked();
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
        experimentalFeatures: { "my-feature": false },
      });

      renderModal();

      await openExperimentalFeaturesSection();
      await userEvent.click(screen.getByLabelText("my-feature"));

      await userEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdateGlobalSettings).toHaveBeenCalledTimes(1);
      });

      const payload = mockUpdateGlobalSettings.mock.calls[0][0];
      expect(payload.experimentalFeatures).toEqual({ "my-feature": true });
      expect(payload.experimentalFeatures.devServer).toBeUndefined();
    });

    it("hides graduated workflow flags while preserving stale persisted values on save", async () => {
      mockFetchSettings.mockResolvedValue({
        ...defaultSettings,
        experimentalFeatures: {
          workflowColumns: false,
          workflowGraphExecutor: false,
          workflowInterpreterDualObserve: true,
          insights: true,
          "my-feature": false,
        },
      });

      renderModal();

      await openExperimentalFeaturesSection();

      expect(screen.queryByText("workflowColumns")).not.toBeInTheDocument();
      expect(screen.queryByText("workflowGraphExecutor")).not.toBeInTheDocument();
      expect(screen.queryByText(/dual-observe parity/i)).not.toBeInTheDocument();
      expect(screen.queryByText("Insights")).not.toBeInTheDocument();

      await userEvent.click(screen.getByLabelText("my-feature"));

      await userEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdateGlobalSettings).toHaveBeenCalledTimes(1);
      });

      /*
      FNXC:SettingsExperimental 2026-06-23-21:20:
      Workflow runtime flags are hidden because the graph engine and workflow columns are default runtime paths. Saving unrelated Settings changes must preserve stale persisted keys instead of rewriting or resurrecting them as UI-controlled toggles; runtime helpers ignore those stale values.
      */
      expect(mockUpdateGlobalSettings.mock.calls[0][0].experimentalFeatures).toEqual({
        workflowColumns: false,
        workflowGraphExecutor: false,
        workflowInterpreterDualObserve: true,
        insights: true,
        "my-feature": true,
      });
    });

    it("checks Left Sidebar Navigation by default when its flag is unset", async () => {
      mockFetchSettings.mockResolvedValue({
        ...defaultSettings,
        experimentalFeatures: {},
      });

      renderModal();

      await openExperimentalFeaturesSection();

      expect(screen.getByLabelText("Left Sidebar Navigation")).toBeChecked();
    });

    it("persists an explicit leftSidebarNav=false opt-out when disabling the default-on toggle", async () => {
      mockFetchSettings.mockResolvedValue({
        ...defaultSettings,
        experimentalFeatures: {},
      });

      renderModal();

      await openExperimentalFeaturesSection();

      const leftSidebarToggle = screen.getByLabelText("Left Sidebar Navigation") as HTMLInputElement;
      expect(leftSidebarToggle).toBeChecked();

      await userEvent.click(leftSidebarToggle);
      expect(leftSidebarToggle).not.toBeChecked();

      await userEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdateGlobalSettings).toHaveBeenCalledTimes(1);
      });

      const payload = mockUpdateGlobalSettings.mock.calls[0][0];
      expect(payload.experimentalFeatures).toEqual({ leftSidebarNav: false });
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

      // Known features that remain experimental should always be shown regardless of settings.
      expect(screen.getByText("Dev Server")).toBeInTheDocument();
      expect(screen.queryByText("Insights")).not.toBeInTheDocument();
      expect(screen.queryByText("Roadmaps")).not.toBeInTheDocument();
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
});

