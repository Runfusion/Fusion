import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
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
  renderModal,
  waitForSettingsModalReady,
  installSettingsModalEnv,
} from "./SettingsModal.test-harness";

const viewportMock = vi.hoisted(() => ({ mode: "desktop" as "desktop" | "mobile" }));

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
  isFullScreenSheetViewport: () => false,
  isShortViewport: () => false,
  getViewportMode: () => viewportMock.mode,
  isMobileViewport: () => viewportMock.mode === "mobile",
  useViewportMode: () => viewportMock.mode,
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

vi.mock("../PluginManager", () => ({
  PluginManager: () => <div data-testid="plugin-manager">Plugin manager content</div>,
}));

vi.mock("../PiExtensionsManager", () => ({
  PiExtensionsManager: () => <div data-testid="pi-extensions-manager">Pi extensions content</div>,
}));

function setMatchMediaMatches(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function getCssBlock(css: string, selector: string) {
  const match = css.match(new RegExp(`${selector.replace(/\./g, "\\.")}\\s*\\{([^}]*)\\}`));
  expect(match?.[1]).toBeDefined();
  return match![1];
}

function getSettingsNavigation() {
  const navigation = document.querySelector<HTMLElement>(".settings-navigation");
  expect(navigation).not.toBeNull();
  return navigation!;
}

describe("SettingsModal navigation rail resize", () => {
  installSettingsModalEnv();

  beforeEach(() => {
    viewportMock.mode = "desktop";
  });

  it("asserts the non-wrapping nav contract and persists desktop resize drags", async () => {
    // Symptom verification: jsdom has no layout engine, so pixel-accurate visual wrapping and divider absence remain manual-visual checks. This automated test asserts the shipped mechanism: nowrap CSS contract, desktop separator affordance, drag persistence, and restore on remount.
    const navItemBlock = getCssBlock(settingsModalCss, ".settings-nav-item");
    expect(navItemBlock).toContain("white-space: nowrap;");
    expect(navItemBlock).toContain("overflow: hidden;");
    expect(navItemBlock).toContain("text-overflow: ellipsis;");
    expect(getCssBlock(settingsModalCss, ".settings-navigation")).not.toContain("border-right:");
    expect(getCssBlock(settingsModalCss, ".settings-sidebar")).not.toContain("border-right:");

    const firstRender = renderModal({ initialSection: "keyboard-shortcuts" });
    await waitForSettingsModalReady();

    const separator = screen.getByRole("separator", { name: "Resize settings navigation" });
    expect(separator).toHaveAttribute("aria-orientation", "vertical");
    expect(separator).toHaveAttribute("aria-valuemin", "200");
    expect(separator).toHaveAttribute("aria-valuemax", "420");
    expect(separator).toHaveAttribute("aria-valuenow", "248");
    expect(getSettingsNavigation().style.getPropertyValue("--settings-nav-width")).toBe("248px");

    fireEvent.pointerDown(separator, { pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(document, { pointerId: 1, clientX: 160 });
    fireEvent.pointerUp(document, { pointerId: 1, clientX: 160 });

    await waitFor(() => expect(localStorage.getItem("fusion:settings-nav-width")).toBe("308"));
    expect(getSettingsNavigation().style.getPropertyValue("--settings-nav-width")).toBe("308px");

    firstRender.unmount();
    renderModal({ initialSection: "keyboard-shortcuts" });
    await waitForSettingsModalReady();

    expect(getSettingsNavigation().style.getPropertyValue("--settings-nav-width")).toBe("308px");
    expect(screen.getByRole("separator", { name: "Resize settings navigation" })).toHaveAttribute("aria-valuenow", "308");
  });

  it("does not render the resize handle when the viewport hook reports mobile", async () => {
    viewportMock.mode = "mobile";

    renderModal();
    await waitForSettingsModalReady();

    expect(screen.queryByRole("separator", { name: "Resize settings navigation" })).not.toBeInTheDocument();
    expect(getSettingsNavigation().style.getPropertyValue("--settings-nav-width")).toBe("");
  });

  it("does not render the resize handle when the Settings media query matches mobile", async () => {
    setMatchMediaMatches(true);

    renderModal();
    await waitForSettingsModalReady();

    expect(screen.queryByRole("separator", { name: "Resize settings navigation" })).not.toBeInTheDocument();
    expect(getSettingsNavigation().style.getPropertyValue("--settings-nav-width")).toBe("");
  });
});
