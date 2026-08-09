/*
FNXC:DashboardTests 2026-08-09-00:08:
The "General · Project" describe block was extracted out of SettingsModal.general.test.tsx into this
sibling file so the dashboard component shard parallelizes it across workers instead of paying the
whole ~44s render cost in one sequential module (weekly velocity flagged general.test as the slowest
file at ~2m under suite contention). Same FN-5048 feedback-loop rationale as the original 231→4 split
in the harness header: vi.mock factories stay per test module and delegate to the shared harness mock
fns + env setup; assertions are unchanged.
*/
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { act, render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react";
import path from "path";
import { SettingsModal } from "../SettingsModal";
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
  // Keep Advanced off by default so disclosure default/persist tests stay truthful.
  installSettingsModalEnv({ advancedSettings: false });

  afterEach(() => {
    viewportMode = "mobile";
    mockListDiscussionCategories.mockReset();
    mockListDiscussionCategories.mockResolvedValue({ categories: [] });
  });

  describe("General · Project", () => {
    it("renders the recommendation cap with the default and bounded numeric control", async () => {
      renderModal({ initialSection: "general" });
      await waitForSettingsModalReady();

      const input = screen.getByLabelText("Maximum recommendations per task") as HTMLInputElement;
      expect(input.value).toBe("3");
      expect(input).toHaveAttribute("min", "0");
      expect(input).toHaveAttribute("max", "20");
    });

    it("populates the Discussion category selector from the report category route", async () => {
      mockListDiscussionCategories.mockResolvedValue({ categories: [{ id: "DC_ideas", name: "Ideas", slug: "ideas" }] });
      renderModal({ initialSection: "general" });
      await waitForSettingsModalReady();

      const category = await screen.findByLabelText("Discussion category");
      expect(category).toBeEnabled();
      expect(screen.getByRole("option", { name: "Ideas" })).toHaveValue("DC_ideas");
      await settingsModalUser.selectOptions(category, "DC_ideas");
      await waitFor(() => expect(mockUpdateSettings.mock.calls[0]?.[0]).toMatchObject({ reportDiscussionCategory: "DC_ideas" }));
    });

    it("renders completion documentation automation control", async () => {
      renderModal({ initialSection: "general" });
      await waitForSettingsModalReady();

      const select = screen.getByLabelText("Completion Documentation Automation") as HTMLSelectElement;
      expect(select).toBeInTheDocument();
      expect(select.value).toBe("off");
      expect(screen.getByRole("option", { name: "Require changeset (.changeset/*.md)" })).toBeInTheDocument();
      expect(screen.getByRole("option", { name: "Require changelog update (existing changelog)" })).toBeInTheDocument();
    });

    it("omits the retired ephemeral compatibility controls while preserving follow-up policy", async () => {
      renderModal({ initialSection: "general" });
      await waitForSettingsModalReady();

      expect(screen.queryByLabelText("Use ephemeral task-worker agents")).not.toBeInTheDocument();
      expect(screen.queryByTestId("settings-help-ephemeralAgentsEnabled")).not.toBeInTheDocument();
      expect(document.getElementById("ephemeralAgentsEnabled")).toBeNull();

      const policy = screen.getByLabelText("Ephemeral agent follow-up tasks");
      expect(policy).toBeInTheDocument();
      await settingsModalUser.selectOptions(policy, "deny");
      await waitFor(() => expect(mockUpdateSettings.mock.calls[0]?.[0]).toMatchObject({
        ephemeralAgentTaskCreationPolicy: "deny",
      }));
    });

    it("reports Quick Chat launcher changes immediately before save", async () => {
      const onQuickChatButtonModeChange = vi.fn();
      renderModal({ initialSection: "general", onQuickChatButtonModeChange });
      await waitForSettingsModalReady();

      await settingsModalUser.selectOptions(screen.getByLabelText("Quick Chat launcher"), "footer");

      expect(onQuickChatButtonModeChange).toHaveBeenCalledWith("footer");
    });

    it("reorders, adds, and removes mobile quick actions before save", async () => {
      const onMobileNavPrimaryItemsChange = vi.fn();
      renderModal({ initialSection: "general", onMobileNavPrimaryItemsChange });
      await waitForSettingsModalReady();

      fireEvent.click(screen.getAllByRole("button", { name: /later$/i })[0]);
      expect(onMobileNavPrimaryItemsChange).toHaveBeenLastCalledWith(["tasks", "command-center", "agents", "missions", "chat", "mailbox"]);
      const rows = Array.from(screen.getByRole("group", { name: "Mobile footer quick actions" }).querySelectorAll(".settings-field-label-row"));
      expect(rows[0].textContent).toContain("tasks");

      fireEvent.click(screen.getByLabelText("Remove chat"));
      expect(onMobileNavPrimaryItemsChange).toHaveBeenLastCalledWith(["tasks", "command-center", "agents", "missions", "mailbox"]);

      await settingsModalUser.selectOptions(screen.getByLabelText("Add quick action"), "git");
      expect(onMobileNavPrimaryItemsChange).toHaveBeenLastCalledWith(["tasks", "command-center", "agents", "missions", "mailbox", "git"]);

      fireEvent.click(screen.getByLabelText("Remove tasks"));
      expect(onMobileNavPrimaryItemsChange).toHaveBeenLastCalledWith(["command-center", "agents", "missions", "mailbox", "git"]);
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
        section: "General · Project",
        label: "Completion Documentation Automation",
        kind: "select",
        value: "changeset",
        scope: "project",
        expectedKey: "completionDocumentationMode",
      },
      {
        section: "General · Project",
        label: "Review Artifacts",
        kind: "select",
        value: "user-facing",
        scope: "project",
        expectedKey: "reviewArtifacts",
      },
      {
        section: "General · Project",
        label: "Auto-cleanup old chats",
        kind: "select",
        value: 14,
        scope: "project",
        expectedKey: "chatAutoCleanupDays",
      },
      {
        section: "General · Project",
        label: "Close Quick Chat on outside click",
        kind: "checkbox",
        value: false,
        scope: "project",
        expectedKey: "quickChatCloseOnOutsideClick",
      },
      {
        section: "General · Project",
        label: "Show task chats in common Chat feed",
        kind: "checkbox",
        value: true,
        scope: "project",
        expectedKey: "showTaskChatsInCommonFeed",
      },
      {
        section: "General · Project",
        label: "Operational log retention",
        kind: "select",
        value: 7,
        scope: "project",
        expectedKey: "operationalLogRetentionDays",
      },
    ])("persists $expectedKey through the expected settings scope", async (input) => {
      await expectSettingPersists(input);
    });

    it("persists report default and per-action filing mode overrides", async () => {
      renderModal({ initialSection: "general" });
      await waitForSettingsModalReady();

      fireEvent.change(screen.getByLabelText("In-app report mode"), { target: { value: "auto-file" } });
      fireEvent.change(screen.getByLabelText("Bug report override"), { target: { value: "draft-review" } });
      fireEvent.click(screen.getByLabelText("Deduplicate reports against public roadmap"));
      fireEvent.change(screen.getByLabelText("Public roadmap label"), { target: { value: "planned" } });

      await waitFor(() => expect(mockUpdateSettings).toHaveBeenCalled());
      expect(mockUpdateSettings.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
        reportMode: "auto-file",
        reportModeByAction: { bug: "draft-review" },
        reportRoadmapDedupeEnabled: false,
        reportRoadmapLabel: "planned",
      }));
    });

    it("renders report-mode default help across unset, populated, and reset action overrides", async () => {
      renderModal({ initialSection: "general" });
      await waitForSettingsModalReady();

      const reportMode = screen.getByLabelText("In-app report mode") as HTMLSelectElement;
      expect(reportMode).toHaveValue("draft-review");
      expect(screen.getByTestId("settings-help-reportMode")).toBeInTheDocument();
      expect(screen.getByText(/Default: draft-review \(operator reviews a draft before filing\)/i).closest(".settings-help-bubble")).toBeTruthy();

      const actionLabels = ["Bug", "Feedback", "Idea", "Help"];
      const actionSelects = actionLabels.map((action) => screen.getByLabelText(`${action} report override`) as HTMLSelectElement);
      for (const select of actionSelects) expect(select).toHaveValue("");
      for (const action of ["bug", "feedback", "idea", "help"]) {
        expect(screen.getByTestId(`settings-help-reportModeByAction-${action}`)).toBeInTheDocument();
      }
      const overrideHelp = screen.getAllByText(/No default — unset actions inherit reportMode/i);
      expect(overrideHelp).toHaveLength(4);
      for (const help of overrideHelp) expect(help.closest(".settings-help-bubble")).toBeTruthy();

      fireEvent.change(actionSelects[0], { target: { value: "auto-file" } });
      expect(actionSelects[0]).toHaveValue("auto-file");
      expect(screen.getAllByText(/No default — unset actions inherit reportMode/i)).toHaveLength(4);

      fireEvent.change(actionSelects[0], { target: { value: "" } });
      for (const select of actionSelects) expect(select).toHaveValue("");
      expect(screen.getAllByText(/No default — unset actions inherit reportMode/i)).toHaveLength(4);
    });

    it("renders embedded PostgreSQL connection-cap help from the English locale", async () => {
      renderModal({ initialSection: "backups-global" });
      await waitForSettingsModalReady();

      /*
      FNXC:PostgresEmbedded 2026-07-22-23:55:
      Issue #2411: the cap is schema-unset so the server can resolve a platform-aware
      default (win32 150, else 500). The input therefore renders empty ("auto"), not 500.
      */
      expect(screen.getByLabelText("Embedded PostgreSQL connection cap")).toHaveValue(null);
      expect(screen.getByLabelText("Embedded PostgreSQL connection cap")).toHaveAttribute("placeholder", "auto");
      expect(screen.getByTestId("settings-help-embeddedPostgresMaxConnections")).toBeInTheDocument();
      expect(screen.getByText("Maximum server connections for Fusion's embedded PostgreSQL. Applies after restarting Fusion. Range: 32–2,000. Unset by default — Fusion picks 500, or 150 on Windows where each connection is a separate process and higher caps can crash backends. External PostgreSQL uses its provider's connection limit.").closest(".settings-help-bubble")).toBeTruthy();
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

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalled();
      });

      const payload = mockUpdateSettings.mock.calls[0][0] as Record<string, unknown>;
      expect(payload.mailAutoCleanupDays).toBe(7);

      mockUpdateSettings.mockClear();

      await settingsModalUser.selectOptions(mailCleanupSelect, "0");

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

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalled();
      });

      const payload = mockUpdateSettings.mock.calls[0][0] as Record<string, unknown>;
      expect(payload.chatRoomRecentVerbatimMessages).toBe(7);
      expect(payload.chatRoomCompactionFetchLimit).toBe(60);
      expect(payload.chatRoomSummaryMaxChars).toBe(900);
    });

    it("renders and saves GitHub tracking controls in the Source Control section", async () => {
      renderModal({ initialSection: "source-control" });
      await waitForSettingsModalReady();

      expect(screen.getByRole("heading", { name: "GitHub Tracking" })).toBeInTheDocument();

      const modeSelect = screen.getByLabelText("Default tracking mode for new tasks") as HTMLSelectElement;
      const repoSelect = screen.getByRole("combobox", { name: "Project default tracking repo" }) as HTMLSelectElement;
      expect(modeSelect.value).toBe("off");
      expect(repoSelect.value).toBe("__custom__");

      await settingsModalUser.selectOptions(modeSelect, "new-tasks");
      await settingsModalUser.type(screen.getByPlaceholderText("owner/repo"), "octo/repo");

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
      renderModal({ initialSection: "source-control" });
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

      renderModal({ initialSection: "source-control" });
      await waitForSettingsModalReady();

      await settingsModalUser.click(screen.getByLabelText("Enable GitLab integration"));

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

      renderModal({ initialSection: "source-control" });
      await waitForSettingsModalReady();

      await settingsModalUser.clear(screen.getByLabelText("GitLab instance URL"));
      await settingsModalUser.clear(screen.getByLabelText("GitLab API base URL (optional / advanced)"));

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalled();
      });

      expect(mockUpdateSettings.mock.calls[0][0]).toMatchObject({
        gitlabInstanceUrl: null,
        gitlabApiBaseUrl: null,
      });
    });

    it("renders and saves imported GitHub issue tracking linking as a project setting", async () => {
      renderModal({ initialSection: "source-control" });
      await waitForSettingsModalReady();

      const importLinkToggle = screen.getByLabelText(
        "Always link imported GitHub issues to GitHub tracking",
      ) as HTMLInputElement;
      expect(importLinkToggle.id).toBe("githubLinkImportedIssuesToTracking");
      expect(importLinkToggle.checked).toBe(false);
      expect(screen.getByText(/does not turn GitHub tracking on for ordinary new tasks/i)).toBeInTheDocument();

      await settingsModalUser.click(importLinkToggle);

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

      renderModal({ initialSection: "source-control" });
      await waitForSettingsModalReady();

      const importLinkToggle = screen.getByLabelText(
        "Always link imported GitHub issues to GitHub tracking",
      ) as HTMLInputElement;
      expect(importLinkToggle.checked).toBe(true);

      await settingsModalUser.click(importLinkToggle);

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

      renderModal({ initialSection: "source-control" });
      await waitForSettingsModalReady();

      const modeSelect = screen.getByLabelText("Default tracking mode for new tasks") as HTMLSelectElement;
      const repoSelect = screen.getByRole("combobox", { name: "Project default tracking repo" }) as HTMLSelectElement;

      expect(modeSelect.value).toBe("new-tasks");
      expect(repoSelect.value).toBe("__custom__");

      await settingsModalUser.selectOptions(modeSelect, "off");
      await settingsModalUser.clear(screen.getByPlaceholderText("owner/repo"));

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalled();
      });

      const payload = mockUpdateSettings.mock.calls[0][0] as Record<string, unknown>;
      expect(payload.githubTrackingEnabledByDefault).toBe(false);
      expect(payload.githubTrackingDefaultRepo).toBeUndefined();
    });

    it("renders github dedup toggle as checked when project value is unset", async () => {
      renderModal({ initialSection: "source-control" });
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

      renderModal({ initialSection: "source-control" });
      await waitForSettingsModalReady();

      const dedupToggle = screen.getByLabelText(
        "Search the tracking repo for likely duplicates before opening a new issue",
      ) as HTMLInputElement;
      expect(dedupToggle.checked).toBe(false);
    });

    it("saves github dedup toggle changes", async () => {
      renderModal({ initialSection: "source-control" });
      await waitForSettingsModalReady();

      const dedupToggle = screen.getByLabelText(
        "Search the tracking repo for likely duplicates before opening a new issue",
      ) as HTMLInputElement;

      await settingsModalUser.click(dedupToggle);

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalled();
      });

      const firstPayload = mockUpdateSettings.mock.calls[0][0] as Record<string, unknown>;
      expect(firstPayload.githubTrackingDedupEnabled).toBe(false);

      mockUpdateSettings.mockClear();

      await settingsModalUser.click(dedupToggle);

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalled();
      });

      const secondPayload = mockUpdateSettings.mock.calls[0][0] as Record<string, unknown>;
      expect(secondPayload.githubTrackingDedupEnabled).toBe(true);
    });

    it("hides summarization model picker when summarization and default tracking are disabled", async () => {
      renderModal({ initialSection: "models" });
      await waitForSettingsModalReady();

      await settingsModalUser.click(screen.getByRole("button", { name: "Models · Project" }));

      expect(screen.queryByText("Title, commit message, and GitHub tracking issue summarization model")).not.toBeInTheDocument();
    });

    it("does not show a moved-to-workflow note for the summarizer model when GitHub tracking defaults are on", async () => {
      mockFetchSettings.mockResolvedValueOnce({
        ...defaultSettings,
        githubTrackingEnabledByDefault: true,
      });

      renderModal({ initialSection: "models" });
      await waitForSettingsModalReady();

      await settingsModalUser.click(screen.getByRole("button", { name: "Models · Project" }));

      expect(screen.queryByText(/model used for summarization now lives on the workflow/i)).not.toBeInTheDocument();
      // FNXC:ProjectModels 2026-07-24-03:10: #2400 (e514e134d) replaced the
      // per-phase moved-to-workflow NOTE with a real editable "Project workflow
      // model lanes" section; assert the editor heading instead of the old copy.
      expect(screen.getByText("Project workflow model lanes")).toBeInTheDocument();
    });

    it("picks a project repo suggestion and preserves label association", async () => {
      mockFetchGitRemotes.mockResolvedValueOnce([
        { name: "origin", owner: "octo", repo: "repo", url: "https://github.com/octo/repo.git" },
      ]);

      renderModal({ initialSection: "source-control" });
      await waitForSettingsModalReady();

      const repoSelect = screen.getByRole("combobox", { name: "Project default tracking repo" }) as HTMLSelectElement;
      expect(await within(repoSelect).findByRole("option", { name: "octo/repo" })).toBeInTheDocument();

      await settingsModalUser.selectOptions(repoSelect, "octo/repo");

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalled();
      });

      const payload = mockUpdateSettings.mock.calls[0][0] as Record<string, unknown>;
      expect(payload.githubTrackingDefaultRepo).toBe("octo/repo");
    });

    it("shows project tracking repo error hint and keeps custom entry when remotes fail", async () => {
      mockFetchGitRemotes.mockRejectedValueOnce(new Error("remotes failed"));

      renderModal({ initialSection: "source-control" });
      await waitForSettingsModalReady();

      expect(await screen.findByText(/Could not load detected remotes/i)).toBeInTheDocument();
      const control = screen.getByRole("combobox", { name: "Project default tracking repo" });
      await settingsModalUser.selectOptions(control, "__custom__");
      expect(screen.getByPlaceholderText("owner/repo")).toBeInTheDocument();
    });

    it("always shows GitHub tracking summarization helper copy", async () => {
      renderModal({ initialSection: "source-control" });
      await waitForSettingsModalReady();

      expect(
        screen.getByText(/Tracking issues use this task's title\. If a task has no title yet, Fusion can summarize its description using the title summarization model in Project Models\./),
      ).toBeInTheDocument();
    });
  });
});
