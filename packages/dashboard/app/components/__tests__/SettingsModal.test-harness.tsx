import { vi, beforeEach, afterEach, expect } from "vitest";
import type { ComponentProps } from "react";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import fs from "fs";
import path from "path";
import { SettingsModal } from "../SettingsModal";
import { __test_clearCache as clearPluginUiSlotsCache } from "../../hooks/usePluginUiSlots";

/*
FNXC:DashboardTests 2026-06-25-10:05:
Shared harness for the SettingsModal suite. The 231-test file was split into 4 sibling
files (general / models-auth / scheduling-merge / remote-notifications) so the dashboard
component shard parallelizes them across workers instead of running one ~61s sequential
file (FN-5048 feedback-loop velocity). vi.mock factories stay in each test file (they only
apply per test module) and delegate to the mock fns + env setup exported here.

FNXC:DashboardTests 2026-06-26-19:05:
SettingsModal's split files still pay full render and sidebar-navigation cost per case.
Use section-targeted harness rendering for tests that do not exercise navigation, preserving
all assertions while avoiding inactive-section setup and real-timer polling in the hot path.
*/

export const settingsModalCss = fs.readFileSync(path.resolve(__dirname, "../SettingsModal.css"), "utf8");

export const mockFetchSettings = vi.fn();
export const mockFetchSettingsByScope = vi.fn();
export const mockExportSettings = vi.fn();
export const mockUpdateSettings = vi.fn();
export const mockUpdateGlobalSettings = vi.fn();
export const mockFetchAuthStatus = vi.fn();
export const mockLoginProvider = vi.fn();
export const mockLogoutProvider = vi.fn();
export const mockCancelProviderLogin = vi.fn();
export const mockSaveApiKey = vi.fn();
export const mockClearApiKey = vi.fn();
export const mockSubmitProviderManualCode = vi.fn();
export const mockFetchModels = vi.fn();
export const mockFetchWorkflow = vi.fn();
export const mockFetchWorkflowSettingValues = vi.fn();
export const mockUpdateWorkflowSettingValues = vi.fn();
export const mockFetchCustomProviders = vi.fn();
export const mockCreateCustomProvider = vi.fn();
export const mockUpdateCustomProvider = vi.fn();
export const mockDeleteCustomProvider = vi.fn();
export const mockTestNtfyNotification = vi.fn();
export const mockTestNotification = vi.fn();
export const mockFetchBackups = vi.fn();
export const mockCreateBackup = vi.fn();
export const mockImportSettings = vi.fn();
export const mockFetchMemoryFiles = vi.fn();
export const mockFetchMemoryFile = vi.fn();
export const mockSaveMemoryFile = vi.fn();
export const mockCompactMemory = vi.fn();
export const mockFetchGlobalConcurrency = vi.fn();
export const mockUpdateGlobalConcurrency = vi.fn();
export const mockFetchMemoryBackendStatus = vi.fn();
export const mockTestMemoryRetrieval = vi.fn();
export const mockInstallQmd = vi.fn();
export const mockFetchGitRemotes = vi.fn();
export const mockFetchGitRemotesDetailed = vi.fn();
export const mockFetchProjects = vi.fn();
export const mockFetchDashboardHealth = vi.fn();
export const mockCheckForUpdates = vi.fn();
export const mockInstallUpdate = vi.fn();
export const mockFetchRemoteSettings = vi.fn();
export const mockUpdateRemoteSettings = vi.fn();
export const mockFetchRemoteStatus = vi.fn();
export const mockInstallCloudflared = vi.fn();
export const mockStartRemoteTunnel = vi.fn();
export const mockStopRemoteTunnel = vi.fn();
export const mockKillExternalTunnel = vi.fn();
export const mockRegenerateRemotePersistentToken = vi.fn();
export const mockGenerateShortLivedRemoteToken = vi.fn();
export const mockFetchRemoteQr = vi.fn();
export const mockFetchRemoteUrl = vi.fn();
export const mockTriggerMemoryDreams = vi.fn();
export const mockFetchPluginUiSlots = vi.fn();
export const mockFetchDroidCliStatus = vi.fn();
export const mockSetDroidCliEnabled = vi.fn();
export const mockFetchCursorCliStatus = vi.fn();
export const mockSetCursorCliEnabled = vi.fn();
export const mockSetCursorCliBinaryPath = vi.fn();
export const mockUseWorkspaceFileBrowser = vi.fn();
export const mockConfirm = vi.fn();
export const mockUseWorktrunkInstallStatus = vi.fn();
export const mockUseMemoryBackendStatus = vi.fn();
export const mockUseMobileKeyboard = vi.fn();

export const noop = () => {};

export const defaultSettings = {
  maxConcurrent: 2,
  maxWorktrees: 4,
  pollIntervalMs: 15000,
  groupOverlappingFiles: true,
  ignoreHiddenOverlapPaths: true,
  overlapIgnorePaths: [],
  autoMerge: true,
  planApprovalMode: "workflow",
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
  worktreeCopyFiles: [],
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
  githubLinkImportedIssuesToTracking: false,
};

export function renderModal(props: Partial<ComponentProps<typeof SettingsModal>> = {}) {
  return render(
    <SettingsModal
      onClose={noop}
      addToast={noop}
      initialSection="authentication"
      {...props}
    />
  );
}

export async function waitForSettingsModalReady() {
  await waitFor(() => expect(mockFetchSettings).toHaveBeenCalled());
  expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
}

export async function renderModalSection(
  initialSection: ComponentProps<typeof SettingsModal>["initialSection"],
  headingName: string | RegExp,
  props: Partial<ComponentProps<typeof SettingsModal>> = {},
) {
  const result = renderModal({ initialSection, ...props });
  await waitForSettingsModalReady();
  expect(screen.getByRole("heading", { name: headingName })).toBeInTheDocument();
  return result;
}

/*
FNXC:SettingsModalTests 2026-06-25-06:45:
The split SettingsModal files remain the dashboard's slowest feedback-loop tests when they use default user-event delays. Keep one no-delay user instance per test and skip repeated pointer-events tree walks so interaction coverage stays intact without artificial timer overhead.
*/
export let settingsModalUser: ReturnType<typeof userEvent.setup>;

export const MODEL_FIXTURE = [
  { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true, contextWindow: 200000 },
  { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
];

export type PersistSettingInput = {
  section: string;
  label: string;
  kind: "checkbox" | "text" | "number" | "select";
  value: boolean | string | number;
  scope: "project" | "global";
  expectedKey: string;
};

export async function expectSettingPersists({ section, label, kind, value, scope, expectedKey }: PersistSettingInput) {
  renderModal();
  await waitForSettingsModalReady();
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${section}$`, "i") }));

  const control = await screen.findByLabelText(label);
  if (kind === "checkbox") {
    const shouldBeChecked = Boolean(value);
    if ((control as HTMLInputElement).checked !== shouldBeChecked) {
      fireEvent.click(control);
    }
  } else if (kind === "select") {
    fireEvent.change(control, { target: { value: String(value) } });
  } else {
    fireEvent.change(control, { target: { value: "" } });
    fireEvent.change(control, { target: { value: String(value) } });
  }

  fireEvent.click(screen.getByRole("button", { name: /^Save$/i }));

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

export async function assertProjectModelSavePayload(provider: string, modelId: string, expectedKeys: string[]) {
  renderModal({ initialSection: "project-models" });
  await waitForSettingsModalReady();

  fireEvent.change(screen.getByLabelText("Default Provider"), { target: { value: provider } });
  fireEvent.change(screen.getByLabelText("Default Model"), { target: { value: modelId } });
  fireEvent.click(screen.getByRole("button", { name: /^Save$/i }));

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

export function forEachProvider<T>(providers: T[], fn: (provider: T) => void) {
  providers.forEach(fn);
}

export function installSettingsModalEnv() {
  beforeEach(() => {
    vi.useRealTimers();
    settingsModalUser = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
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
    mockClearApiKey.mockResolvedValue({ success: true });
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
      refresh: vi.fn().mockResolvedValue({ status: "missing" }),
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
      binaryPath: undefined,
      extension: null,
      ready: false,
    });
    mockSetCursorCliEnabled.mockResolvedValue({ enabled: true, restartRequired: false });
    mockSetCursorCliBinaryPath.mockResolvedValue({ enabled: false, restartRequired: false });
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
}

