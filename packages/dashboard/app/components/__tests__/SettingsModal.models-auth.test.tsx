import { describe, it, expect, vi } from "vitest";
import type { ComponentProps } from "react";
import { render, screen, fireEvent, waitFor, within, act, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import path from "path";
import { SettingsModal } from "../SettingsModal";
import type { SettingsExportData, UpdateCheckResponse } from "../../api";
import { ApiRequestError } from "../../api";
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
  noop,
  defaultSettings,
  MODEL_FIXTURE,
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
});

