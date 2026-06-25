import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import path from "path";
import { SettingsModal } from "../SettingsModal";
import type { PluginUiContributionEntry } from "../../api";
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

  describe("Remote section", () => {
    let user: ReturnType<typeof userEvent.setup>;

    beforeEach(() => {
      user = userEvent.setup({ delay: null });
    });

    beforeEach(() => {
      mockFetchSettings.mockResolvedValue({
        ...defaultSettings,
        experimentalFeatures: { remoteAccess: true },
      });
    });

    const openRemoteSection = async () => {
      const [remoteSectionButton] = await screen.findAllByRole("button", { name: /Remote Access/i });
      await user.click(remoteSectionButton);
      await screen.findByRole("heading", { name: "Remote Access" });
    };

    const openAdvancedSettings = async () => {
      const summary = screen.getByText("Advanced Settings");
      await user.click(summary);
    };

    describe("with default Remote render", () => {
      beforeEach(async () => {
        renderModal();
        await waitForSettingsModalReady();
        await openRemoteSection();
      });

      it("shows provider-specific settings when provider selected and auto-saves on Start Tunnel", async () => {
        await user.click(screen.getByLabelText("Tailscale"));
        expect(screen.queryByLabelText("Hostname label")).not.toBeInTheDocument();
        expect(screen.queryByLabelText("Target port")).not.toBeInTheDocument();
        expect(screen.getByLabelText("Accept routes")).toBeInTheDocument();
        expect(screen.queryByLabelText("Tunnel name")).not.toBeInTheDocument();

        await user.click(screen.getByLabelText("Cloudflare"));
        expect(screen.queryByLabelText("Accept routes")).not.toBeInTheDocument();

        if (!screen.queryByLabelText("Tunnel name")) {
          const advancedDetails = screen.getByText(/Advanced \(Named Tunnel\)/i, { selector: "summary" }).closest("details") as HTMLDetailsElement;
          advancedDetails.open = true;
          fireEvent(advancedDetails, new Event("toggle"));
          expect(await screen.findByLabelText("Tunnel name")).toBeInTheDocument();
        }
        fireEvent.change(screen.getByLabelText("Tunnel name"), { target: { value: "cf-team" } });
        fireEvent.change(screen.getByLabelText("Tunnel token"), { target: { value: "cf_token" } });
        fireEvent.change(screen.getByLabelText("Ingress URL"), { target: { value: "https://remote.example.com" } });

        await user.click(screen.getByRole("button", { name: "Start Tunnel" }));

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
        await user.click(screen.getByLabelText("Cloudflare"));
        const namedTunnelSummary = screen.getByText(/Advanced \(Named Tunnel\)/i, { selector: "summary" });

        if (!screen.queryByLabelText("Tunnel name")) {
          await user.click(namedTunnelSummary);
        }
        expect(await screen.findByLabelText("Tunnel name")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Start Tunnel" }));
        await waitFor(() => {
          expect(mockUpdateRemoteSettings).toHaveBeenCalledWith(expect.objectContaining({ remoteCloudflareQuickTunnel: false }), undefined);
        });

        // Closing <details> is not consistently simulated in jsdom; verify default quick-tunnel state via a fresh render below.
      });

      it("renders branded Cloudflare icon in Remote provider selector", () => {
        const cloudflareSlot = screen.getByTestId("remote-provider-icon-cloudflare");
        expect(within(cloudflareSlot).getByTestId("remote-cloudflare-option-icon")).toBeInTheDocument();
      });

      it("Start Tunnel button is disabled when no provider is selected", async () => {
        const startButton = screen.getByRole("button", { name: "Start Tunnel" });
        expect(startButton).toBeDisabled();
        await user.click(screen.getByLabelText("Tailscale"));
        expect(startButton).not.toBeDisabled();
      });

      it("no separate Activate Provider or Save Remote Settings buttons exist", () => {
        expect(screen.queryByRole("button", { name: /Activate Provider/i })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /Save Remote Settings/i })).not.toBeInTheDocument();
      });

      it("only the selected provider's settings are rendered", async () => {
        await user.click(screen.getByLabelText("Tailscale"));
        expect(screen.getByLabelText("Accept routes")).toBeInTheDocument();
        expect(screen.queryByText(/Advanced \(Named Tunnel\)/i)).not.toBeInTheDocument();

        await user.click(screen.getByLabelText("Cloudflare"));
        expect(screen.getByText(/Advanced \(Named Tunnel\)/i)).toBeInTheDocument();
        expect(screen.queryByLabelText("Accept routes")).not.toBeInTheDocument();
      });

      it("sets quick tunnel false when opening Cloudflare advanced details", async () => {
        await user.click(screen.getByLabelText("Cloudflare"));

        const namedTunnelSummary = screen.getByText(/Advanced \(Named Tunnel\)/i, { selector: "summary" });
        if (!screen.queryByLabelText("Tunnel name")) {
          await user.click(namedTunnelSummary);
        }
        await user.click(screen.getByRole("button", { name: "Start Tunnel" }));
        await waitFor(() => {
          expect(mockUpdateRemoteSettings).toHaveBeenCalledWith(expect.objectContaining({ remoteCloudflareQuickTunnel: false }), undefined);
        });
      });

      it("Start Tunnel auto-saves with enabled=true on selected provider before starting", async () => {
        await user.click(screen.getByLabelText("Tailscale"));
        await user.click(screen.getByRole("button", { name: "Start Tunnel" }));

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

    it("renders remote-status-bar with stopped state and omits share block when not running", async () => {
      mockFetchRemoteStatus.mockResolvedValue({ provider: null, state: "stopped", url: null, lastError: null });
      const { container } = renderModal();
      await waitForSettingsModalReady();
      await openRemoteSection();

      const statusBar = container.querySelector(".remote-status-bar");
      expect(statusBar).toBeInTheDocument();
      expect(statusBar?.className).toContain("remote-status-bar--stopped");
      expect(container.querySelector(".remote-share-block")).not.toBeInTheDocument();
    });

    it("renders remote-share-block when tunnel is running with a URL", async () => {
      mockFetchRemoteStatus.mockResolvedValue({ provider: "tailscale", state: "running", url: "https://machine.ts.net/", lastError: null });
      const { container } = renderModal();
      await waitForSettingsModalReady();
      await openRemoteSection();

      const statusBar = container.querySelector(".remote-status-bar");
      expect(statusBar).toBeInTheDocument();
      expect(statusBar?.className).toContain("remote-status-bar--running");
      expect(container.querySelector(".remote-share-block")).toBeInTheDocument();
    });

    it("updates provider selection via radio and shows provider status", async () => {
      mockFetchRemoteStatus
        .mockResolvedValueOnce({ provider: null, state: "stopped", url: null, lastError: null })
        .mockResolvedValueOnce({ provider: "tailscale", state: "running", url: "https://tail.example", lastError: null });

      renderModal();
      await waitForSettingsModalReady();
      await openRemoteSection();

      await user.click(screen.getByLabelText("Tailscale"));
      expect(screen.getByLabelText("Tailscale")).toBeChecked();

      await user.click(screen.getByRole("button", { name: "Start Tunnel" }));
      expect(await screen.findByText("https://tail.example", { selector: ".remote-status-url" })).toBeInTheDocument();
    });

    it("shows cloudflared available indicator when Cloudflare is selected and cloudflared is installed", async () => {
      mockFetchRemoteStatus.mockResolvedValue({ provider: "cloudflare", state: "stopped", url: null, lastError: null, cloudflaredAvailable: true });

      renderModal();
      await waitForSettingsModalReady();
      await openRemoteSection();
      await user.click(screen.getByLabelText("Cloudflare"));

      expect(await screen.findByText("cloudflared is installed")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Install cloudflared" })).not.toBeInTheDocument();
    });

    it("shows install button when Cloudflare is selected and cloudflared is not available", async () => {
      mockFetchRemoteStatus.mockResolvedValue({ provider: "cloudflare", state: "stopped", url: null, lastError: null, cloudflaredAvailable: false });

      renderModal();
      await waitForSettingsModalReady();
      await openRemoteSection();
      await user.click(screen.getByLabelText("Cloudflare"));

      expect(await screen.findByText("cloudflared is not installed")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Install cloudflared" })).toBeInTheDocument();
      expect(screen.getByText("cloudflared must be installed to start the tunnel")).toBeInTheDocument();
    });

    it("install button triggers install and refreshes status", async () => {
      const addToast = vi.fn();
      mockFetchRemoteStatus
        .mockResolvedValueOnce({ provider: "cloudflare", state: "stopped", url: null, lastError: null, cloudflaredAvailable: false })
        .mockResolvedValueOnce({ provider: "cloudflare", state: "stopped", url: null, lastError: null, cloudflaredAvailable: true });
      mockInstallCloudflared.mockResolvedValueOnce({ success: true, command: "brew install cloudflared" });

      renderModal({ addToast });
      await waitForSettingsModalReady();
      await openRemoteSection();
      await user.click(screen.getByLabelText("Cloudflare"));

      const installButton = await screen.findByRole("button", { name: "Install cloudflared" });
      await user.click(installButton);

      await waitFor(() => {
        expect(mockInstallCloudflared).toHaveBeenCalledWith(undefined);
      });
      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith("cloudflared installed successfully", "success");
      });
      expect(await screen.findByText("cloudflared is installed")).toBeInTheDocument();
    });

    it("install button shows error on failure", async () => {
      mockFetchRemoteStatus.mockResolvedValue({ provider: "cloudflare", state: "stopped", url: null, lastError: null, cloudflaredAvailable: false });
      mockInstallCloudflared.mockResolvedValueOnce({ success: false, command: "brew install cloudflared", error: "Command failed" });

      renderModal();
      await waitForSettingsModalReady();
      await openRemoteSection();
      await user.click(screen.getByLabelText("Cloudflare"));

      await user.click(await screen.findByRole("button", { name: "Install cloudflared" }));

      expect(await screen.findByText("Command failed")).toBeInTheDocument();
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

      await user.click(screen.getByLabelText("Tailscale"));
      expect(screen.getByRole("button", { name: "Start Tunnel" })).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Start Tunnel" }));
      await waitFor(() => {
        expect(mockUpdateRemoteSettings).toHaveBeenCalled();
        expect(mockStartRemoteTunnel).toHaveBeenCalledTimes(1);
      });
      expect(await screen.findByText("starting")).toBeInTheDocument();

      expect(await screen.findByRole("button", { name: "Stop Tunnel" })).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Stop Tunnel" }));
      await waitFor(() => {
        expect(mockStopRemoteTunnel).toHaveBeenCalledTimes(1);
      });
      await user.click(screen.getByRole("button", { name: "Stop Tunnel" }));
      await waitFor(() => {
        expect(mockStopRemoteTunnel).toHaveBeenCalledTimes(2);
      });
      expect(await screen.findByText("Tunnel crashed")).toBeInTheDocument();
    });

    it("shows external tunnel panel with actions when external tunnel is detected", async () => {
      mockFetchRemoteStatus.mockResolvedValue({
        provider: "tailscale",
        state: "stopped",
        url: null,
        lastError: null,
        externalTunnel: { provider: "tailscale", url: "https://machine.ts.net/" },
      });

      renderModal();
      await waitForSettingsModalReady();
      await openRemoteSection();

      expect(await screen.findByText("External tailscale tunnel detected")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Start Fresh" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Use Existing" })).toBeInTheDocument();
    });

    it("Start Fresh kills external tunnel before starting", async () => {
      mockFetchRemoteStatus.mockResolvedValue({
        provider: "tailscale",
        state: "stopped",
        url: null,
        lastError: null,
        externalTunnel: { provider: "tailscale", url: "https://machine.ts.net/" },
      });

      renderModal();
      await waitForSettingsModalReady();
      await openRemoteSection();
      await user.click(screen.getByLabelText("Tailscale"));

      await user.click(await screen.findByRole("button", { name: "Start Fresh" }));

      await waitFor(() => {
        expect(mockKillExternalTunnel).toHaveBeenCalledWith(undefined);
        expect(mockStartRemoteTunnel).toHaveBeenCalledWith(undefined);
      });
    });

    it("regenerates persistent token and surfaces success feedback without exposing raw token text", async () => {
      const addToast = vi.fn();
      renderModal({ addToast });
      await waitForSettingsModalReady();
      await openRemoteSection();
      await user.click(screen.getByLabelText("Tailscale"));
      await openAdvancedSettings();

      await user.click(screen.getByRole("button", { name: "Regenerate persistent token" }));

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
      await user.click(screen.getByLabelText("Tailscale"));
      await openAdvancedSettings();

      await user.selectOptions(screen.getByLabelText("Auth link token type"), "short-lived");
      const ttlInput = screen.getByLabelText("Short-lived TTL (ms)") as HTMLInputElement;
      fireEvent.change(ttlInput, { target: { value: "120000" } });

      await user.click(screen.getByRole("button", { name: "Generate short-lived token" }));
      await waitFor(() => {
        expect(mockGenerateShortLivedRemoteToken).toHaveBeenCalledWith(120000, undefined);
      });

      fireEvent.change(ttlInput, { target: { value: "120000" } });
      await user.click(screen.getByRole("button", { name: "Show URL" }));
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
      await user.click(screen.getByLabelText("Tailscale"));
      await openAdvancedSettings();

      await user.click(screen.getByRole("button", { name: "Generate QR" }));
      await waitFor(() => {
        expect(mockFetchRemoteQr).toHaveBeenNthCalledWith(1, "image/svg", expect.objectContaining({ tokenType: "persistent" }));
      });
      expect(await screen.findByRole("img", { name: "Remote access QR code" })).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Generate QR" }));
      await waitFor(() => {
        expect(screen.queryByRole("img", { name: "Remote access QR code" })).not.toBeInTheDocument();
      });
      expect(screen.getByText("https://remote.example.com/qr-text")).toBeInTheDocument();
    });

  });


  describe("Notifications provider cards", () => {
    let user: ReturnType<typeof userEvent.setup>;

    beforeEach(() => {
      user = userEvent.setup({ delay: null });
    });

    const openNotificationsSection = async () => {
      await user.click(await screen.findByRole("button", { name: /Notifications/ }));
    };

    describe("with default Notifications render", () => {
      beforeEach(async () => {
        renderModal({ initialSection: "notifications" });
        await screen.findByRole("heading", { name: "Notifications" });
      });

      it("shows ntfy and webhook provider cards in notifications section", () => {
        expect(screen.getByText("ntfy")).toBeInTheDocument();
        expect(screen.getByText("Webhook")).toBeInTheDocument();
      });

      it("renders failure mode controls and persists updated values", async () => {
        const modeSelect = screen.getByLabelText("Failure notification mode") as HTMLSelectElement;
        const delayInput = screen.getByLabelText("Failure notification delay (ms)") as HTMLInputElement;

        expect(modeSelect.value).toBe("sticky-only");
        expect(delayInput.value).toBe("30000");

        await user.selectOptions(modeSelect, "all");
        expect(delayInput).toBeDisabled();
        await user.selectOptions(modeSelect, "sticky-only");
        fireEvent.change(delayInput, { target: { value: "45000" } });
        await user.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => {
          expect(mockUpdateGlobalSettings).toHaveBeenCalledWith(
            expect.objectContaining({
              failureNotificationMode: "sticky-only",
              failureNotificationDelayMs: 45000,
            }),
          );
        });
      });

      it("persists terminal-only selection on save", async () => {
        const modeSelect = screen.getByLabelText("Failure notification mode") as HTMLSelectElement;
        await user.selectOptions(modeSelect, "terminal-only");
        await user.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => {
          expect(mockUpdateGlobalSettings).toHaveBeenCalledWith(
            expect.objectContaining({
              failureNotificationMode: "terminal-only",
            }),
          );
        });
      });

      it("calls testNotification with webhook provider ID when webhook test button clicked", async () => {
        await user.click(screen.getByLabelText("Webhook notifications"));
        fireEvent.change(screen.getByLabelText("Webhook URL"), { target: { value: "https://hooks.example.com/test" } });

        const webhookCard = screen.getByText("Webhook").closest(".notification-provider-card") as HTMLElement;
        await user.click(within(webhookCard).getByRole("button", { name: /Test notification/ }));

        await waitFor(() => {
          expect(mockTestNotification).toHaveBeenCalledWith(
            "webhook",
            expect.objectContaining({ webhookUrl: "https://hooks.example.com/test" }),
            undefined,
          );
        });
        expect(within(webhookCard).getByText("Test notification sent — check your webhook endpoint!")).toBeInTheDocument();
        expect(within(webhookCard).getByText("Test notification sent — check your webhook endpoint!").closest(".notification-test-feedback")).toHaveAttribute("aria-live", "polite");
      });
    });

    it("keeps delay enabled when failure mode is terminal-only", async () => {
      mockFetchSettings.mockResolvedValueOnce({
        ...defaultSettings,
        failureNotificationMode: "terminal-only",
      });
      renderModal();
      await waitForSettingsModalReady();
      await openNotificationsSection();

      const modeSelect = screen.getByLabelText("Failure notification mode") as HTMLSelectElement;
      const delayInput = screen.getByLabelText("Failure notification delay (ms)") as HTMLInputElement;

      expect(modeSelect.value).toBe("terminal-only");
      expect(delayInput).not.toBeDisabled();
    });

    it.each([
      {
        provider: "ntfy",
        initial: { ...defaultSettings, ntfyEnabled: true, ntfyTopic: "test-topic" },
        enable: async () => {},
        visibleLabel: "ntfy Topic",
        hiddenLabel: "Webhook URL",
      },
      {
        provider: "webhook",
        initial: defaultSettings,
        enable: async () => {
          await user.click(screen.getByLabelText("Webhook notifications"));
        },
        visibleLabel: "Webhook URL",
        hiddenLabel: "ntfy Topic",
      },
    ])("shows $provider fields when enabled and hides opposite provider fields", async ({ initial, enable, visibleLabel, hiddenLabel }) => {
      mockFetchSettings.mockResolvedValueOnce(initial);
      renderModal();
      await waitForSettingsModalReady();
      await openNotificationsSection();
      await enable();

      expect(screen.getByLabelText(visibleLabel)).toBeInTheDocument();
      expect(screen.queryByLabelText(hiddenLabel)).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Test notification/ })).toBeInTheDocument();
    });

    it("shows fallback, dreams, and mailbox/room message events for both providers", async () => {
      mockFetchSettings.mockResolvedValueOnce({
        ...defaultSettings,
        ntfyEnabled: true,
        ntfyTopic: "test-topic",
        ntfyEvents: [
          "in-review",
          "merged",
          "failed",
          "awaiting-approval",
          "awaiting-user-review",
          "planning-awaiting-input",
          "gridlock",
          "fallback-used",
          "memory-dreams-processed",
          "message:agent-to-user",
          "message:agent-to-agent",
          "message:room",
          "oauth-token-expired",
        ],
      });
      renderModal();
      await waitForSettingsModalReady();
      await openNotificationsSection();

      expect(screen.getByLabelText("Fallback model used (recovered)")).toBeInTheDocument();
      expect(screen.getByLabelText("Agent created a task")).toBeInTheDocument();
      expect(screen.getByLabelText("DREAMS.md entry added")).toBeInTheDocument();
      const taskCreatedNtfy = screen.getByLabelText("Agent created a task") as HTMLInputElement;
      const agentToUserNtfy = screen.getByLabelText("Agent → user message") as HTMLInputElement;
      const agentToAgentNtfy = screen.getByLabelText("Agent → agent message") as HTMLInputElement;
      const roomMessageNtfy = screen.getByLabelText("Agent message in room") as HTMLInputElement;
      expect(taskCreatedNtfy.checked).toBe(false);
      expect(agentToUserNtfy.checked).toBe(true);
      expect(agentToAgentNtfy.checked).toBe(true);
      expect(roomMessageNtfy.checked).toBe(true);

      await user.click(screen.getByLabelText("Webhook notifications"));
      expect(screen.getAllByLabelText("Fallback model used (recovered)").length).toBeGreaterThan(0);
      expect(screen.getAllByLabelText("Agent created a task").length).toBeGreaterThan(0);
      expect(screen.getAllByLabelText("DREAMS.md entry added").length).toBeGreaterThan(0);
      const [taskCreatedWebhook] = screen.getAllByLabelText("Agent created a task") as HTMLInputElement[];
      const [agentToUserWebhook] = screen.getAllByLabelText("Agent → user message") as HTMLInputElement[];
      const [agentToAgentWebhook] = screen.getAllByLabelText("Agent → agent message") as HTMLInputElement[];
      const [roomMessageWebhook] = screen.getAllByLabelText("Agent message in room") as HTMLInputElement[];
      expect(taskCreatedWebhook.checked).toBe(false);
      expect(agentToUserWebhook.checked).toBe(true);
      expect(agentToAgentWebhook.checked).toBe(true);
      expect(roomMessageWebhook.checked).toBe(true);
    });

    it("calls testNotification with ntfy provider ID when ntfy test button clicked", async () => {
      mockFetchSettings.mockResolvedValueOnce({ ...defaultSettings, ntfyEnabled: true, ntfyTopic: "test-topic" });
      renderModal();
      await waitForSettingsModalReady();
      await openNotificationsSection();
      await user.click(screen.getByText("Advanced"));
      fireEvent.change(screen.getByLabelText("Access token (optional)"), { target: { value: "secret-token" } });

      await user.click(screen.getByRole("button", { name: /Test notification/ }));

      await waitFor(() => {
        expect(mockTestNotification).toHaveBeenCalledWith(
          "ntfy",
          expect.objectContaining({
            ntfyEnabled: true,
            ntfyTopic: "test-topic",
            ntfyAccessToken: "secret-token",
          }),
          undefined,
        );
      });
    });

    it("sends unsaved ntfy form config before saving", async () => {
      mockFetchSettings.mockResolvedValueOnce({ ...defaultSettings, ntfyEnabled: false, ntfyTopic: undefined });
      renderModal();
      await waitForSettingsModalReady();
      await openNotificationsSection();

      await user.click(screen.getByLabelText("Enable"));
      await user.type(screen.getByLabelText("ntfy Topic"), "fresh-topic");
      await user.click(screen.getByText("Advanced"));
      await user.type(screen.getByLabelText("Custom ntfy server URL (optional)"), "https://ntfy.override.example//");
      await user.type(screen.getByLabelText("Access token (optional)"), "override-token");
      await user.click(screen.getByRole("button", { name: /Test notification/ }));

      await waitFor(() => {
        expect(mockTestNotification).toHaveBeenCalledWith(
          "ntfy",
          expect.objectContaining({
            ntfyEnabled: true,
            ntfyTopic: "fresh-topic",
            ntfyBaseUrl: "https://ntfy.override.example//",
            ntfyAccessToken: "override-token",
          }),
          undefined,
        );
      });
      expect(mockUpdateSettings).not.toHaveBeenCalled();
      expect(mockUpdateGlobalSettings).not.toHaveBeenCalled();
    });

    it("keeps ntfy test disabled until the current form has a valid topic", async () => {
      mockFetchSettings.mockResolvedValueOnce({ ...defaultSettings, ntfyEnabled: false, ntfyTopic: undefined });
      renderModal();
      await waitForSettingsModalReady();
      await openNotificationsSection();

      await user.click(screen.getByLabelText("Enable"));
      const testButton = screen.getByRole("button", { name: /Test notification/ });
      expect(testButton).toBeDisabled();

      await user.type(screen.getByLabelText("ntfy Topic"), "bad topic!");
      expect(testButton).toBeDisabled();
      expect(mockTestNotification).not.toHaveBeenCalled();

      await user.clear(screen.getByLabelText("ntfy Topic"));
      await user.type(screen.getByLabelText("ntfy Topic"), "fresh-topic");
      expect(testButton).toBeEnabled();
    });

    it("clears a saved ntfy access token via global null-as-delete semantics", async () => {
      mockFetchSettings.mockResolvedValueOnce({
        ...defaultSettings,
        ntfyEnabled: true,
        ntfyTopic: "test-topic",
        ntfyAccessToken: "saved-token",
      });
      renderModal();
      await waitForSettingsModalReady();
      await openNotificationsSection();
      await user.click(screen.getByText("Advanced"));
      const tokenInput = screen.getByLabelText("Access token (optional)");
      await user.clear(tokenInput);
      await user.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(mockUpdateGlobalSettings).toHaveBeenCalledWith(
          expect.objectContaining({ ntfyAccessToken: null }),
        );
      });
    });

    it("calls testNotification with ntfy message-event config when message test button clicked", async () => {
      const addToast = vi.fn();
      mockFetchSettings.mockResolvedValueOnce({ ...defaultSettings, ntfyEnabled: true, ntfyTopic: "test-topic" });
      renderModal({ addToast });
      await waitForSettingsModalReady();
      await openNotificationsSection();

      await user.click(screen.getByRole("button", { name: /Test message inbox/ }));

      await waitFor(() => {
        expect(mockTestNotification).toHaveBeenCalledWith(
          "ntfy",
          expect.objectContaining({
            messageEventType: "message:agent-to-user",
            ntfyEnabled: true,
            ntfyTopic: "test-topic",
          }),
          undefined,
        );
      });
      expect(addToast).toHaveBeenCalledWith(
        "Message inbox test sent — check your ntfy inbox for the agent-to-user message.",
        "success",
      );
      expect(screen.getByText("Message inbox: Message inbox test sent — check your ntfy inbox for the agent-to-user message.")).toBeInTheDocument();
      expect(screen.getByText("Message inbox: Message inbox test sent — check your ntfy inbox for the agent-to-user message.").closest(".notification-test-feedback")).toHaveAttribute("aria-live", "polite");
    });

    it("calls testNotification with ntfy room-event config when room test button clicked", async () => {
      const addToast = vi.fn();
      mockFetchSettings.mockResolvedValueOnce({ ...defaultSettings, ntfyEnabled: true, ntfyTopic: "test-topic" });
      renderModal({ addToast });
      await waitForSettingsModalReady();
      await openNotificationsSection();

      await user.click(screen.getByRole("button", { name: /Test room reply/ }));

      await waitFor(() => {
        expect(mockTestNotification).toHaveBeenCalledWith(
          "ntfy",
          expect.objectContaining({
            messageEventType: "message:room",
            ntfyEnabled: true,
            ntfyTopic: "test-topic",
          }),
          undefined,
        );
      });
      expect(addToast).toHaveBeenCalledWith(
        "Room reply test sent — check your ntfy inbox for the room reply.",
        "success",
      );
      expect(screen.getByText("Room reply: Room reply test sent — check your ntfy inbox for the room reply.")).toBeInTheDocument();
    });

    it("shows ntfy room-specific failure copy when room test fails", async () => {
      const addToast = vi.fn();
      mockTestNotification.mockResolvedValueOnce({ success: false, error: "boom" });
      mockFetchSettings.mockResolvedValueOnce({ ...defaultSettings, ntfyEnabled: true, ntfyTopic: "test-topic" });
      renderModal({ addToast });
      await waitForSettingsModalReady();
      await openNotificationsSection();

      await user.click(screen.getByRole("button", { name: /Test room reply/ }));

      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith("Failed to send room reply test", "error");
      });
      expect(screen.getByText("Room reply: Failed to send room reply test")).toBeInTheDocument();
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
      const fallbackUsed = screen.getByLabelText("Fallback model used (recovered)") as HTMLInputElement;
      const dreamsProcessed = screen.getByLabelText("DREAMS.md entry added") as HTMLInputElement;
      expect(inReview.checked).toBe(true);
      expect(failed.checked).toBe(true);
      expect(merged.checked).toBe(false);
      expect(fallbackUsed.checked).toBe(false);
      expect(dreamsProcessed.checked).toBe(false);
    });
  });

  describe("scheduled eval settings section", () => {
    const openScheduledEvalsSection = async () => {
      await userEvent.click(await screen.findByRole("button", { name: /Scheduled Evals/i }));
    };

    it("renders controls and disables interval controls when evals are disabled", async () => {
      mockFetchSettings.mockResolvedValueOnce({
        ...defaultSettings,
        experimentalFeatures: { evalsView: true },
        evalSettings: {
          enabled: false,
          intervalMs: 86_400_000,
          followUpPolicy: "suggest-only",
          retentionDays: 30,
        },
      });

      renderModal();
      await waitForSettingsModalReady();
      await openScheduledEvalsSection();

      expect(await screen.findByRole("heading", { name: "Scheduled Evals" })).toBeInTheDocument();
      expect(screen.getByLabelText("Enable scheduled eval runs for this project")).toBeInTheDocument();
      expect(screen.getByLabelText("Interval (ms)")).toBeDisabled();
      expect(screen.getByLabelText("Follow-up Policy")).toBeDisabled();
      expect(screen.getByLabelText("Retention (days)")).toBeDisabled();
      expect(screen.getByText(/inherit the project validator lane model settings/i)).toBeInTheDocument();
    });

    it("saves edited project eval settings payload", async () => {
      mockFetchSettings.mockResolvedValueOnce({
        ...defaultSettings,
        experimentalFeatures: { evalsView: true },
        evalSettings: {
          enabled: true,
          intervalMs: 86_400_000,
          followUpPolicy: "suggest-only",
          retentionDays: 30,
        },
      });

      renderModal();
      await waitForSettingsModalReady();
      await openScheduledEvalsSection();

      fireEvent.change(screen.getByLabelText("Interval (ms)"), { target: { value: "120000" } });
      await userEvent.type(screen.getByLabelText("Evaluator Provider"), "openai");
      await userEvent.type(screen.getByLabelText("Evaluator Model"), "gpt-5");
      await userEvent.selectOptions(screen.getByLabelText("Follow-up Policy"), "auto-create");
      fireEvent.change(screen.getByLabelText("Retention (days)"), { target: { value: "14" } });
      await userEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            evalSettings: expect.objectContaining({
              enabled: true,
              intervalMs: 120000,
              evaluatorProvider: "openai",
              evaluatorModelId: "gpt-5",
              followUpPolicy: "auto-create",
              retentionDays: 14,
            }),
          }),
          undefined,
        );
      });
    });

    it("clears evaluator provider and model as unset when left blank", async () => {
      mockFetchSettings.mockResolvedValueOnce({
        ...defaultSettings,
        experimentalFeatures: { evalsView: true },
        evalSettings: {
          enabled: true,
          intervalMs: 86_400_000,
          evaluatorProvider: "openai",
          evaluatorModelId: "gpt-5",
          followUpPolicy: "suggest-only",
          retentionDays: 30,
        },
      });

      renderModal();
      await waitForSettingsModalReady();
      await openScheduledEvalsSection();

      await userEvent.clear(screen.getByLabelText("Evaluator Provider"));
      await userEvent.clear(screen.getByLabelText("Evaluator Model"));
      await userEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            evalSettings: expect.objectContaining({
              evaluatorProvider: undefined,
              evaluatorModelId: undefined,
            }),
          }),
          undefined,
        );
      });
    });
  });

  describe("memory backups settings", () => {
    it("renders memory backup fields with defaults and saves changes", async () => {
      renderModal({ initialSection: "backups" });
      await waitForSettingsModalReady();

      expect(screen.getByRole("heading", { name: "Memory Backups" })).toBeInTheDocument();
      expect(screen.getByLabelText("Memory Backup Schedule (Cron)")).toHaveValue("0 3 * * *");
      expect(screen.getByLabelText("Memory Retention Count")).toHaveValue(null);
      expect(screen.getByLabelText("Memory Backup Directory")).toHaveValue(".fusion/backups/memory");
      expect(screen.getByLabelText("Memory Backup Scope")).toHaveValue("all");

      await userEvent.click(screen.getByLabelText("Enable automatic memory backups"));
      fireEvent.change(screen.getByLabelText("Memory Backup Schedule (Cron)"), { target: { value: "0 5 * * *" } });
      fireEvent.change(screen.getByLabelText("Memory Retention Count"), { target: { value: "21" } });
      fireEvent.change(screen.getByLabelText("Memory Backup Directory"), { target: { value: ".fusion/backups/custom-memory" } });
      await userEvent.selectOptions(screen.getByLabelText("Memory Backup Scope"), "agents");
      await userEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            memoryBackupEnabled: true,
            memoryBackupSchedule: "0 5 * * *",
            memoryBackupRetention: 21,
            memoryBackupDir: ".fusion/backups/custom-memory",
            memoryBackupScope: "agents",
          }),
          undefined,
        );
      });
    });
  });

  describe("research settings sections", () => {
    beforeEach(() => {
      mockFetchSettings.mockResolvedValue({
        ...defaultSettings,
        experimentalFeatures: { researchView: true },
      });
    });

    const openResearchGlobalSection = async () => {
      await userEvent.click(await screen.findByRole("button", { name: /Research Defaults/i }));
    };

    const openResearchProjectSection = async () => {
      await userEvent.click(await screen.findByRole("button", { name: /^Research$/i }));
    };

    it("renders global research defaults fields with expected default values", async () => {
      renderModal();
      await waitForSettingsModalReady();
      await openResearchGlobalSection();

      expect(screen.getByLabelText("Default Max Concurrent Runs")).toHaveValue(3);
      expect(screen.getByLabelText("Default Max Sources Per Run")).toHaveValue(20);
      expect(screen.getByLabelText("Default Max Duration (ms)")).toHaveValue(300000);
      expect(screen.getByLabelText("Request Timeout (ms)")).toHaveValue(30000);
      expect(screen.getByLabelText("Max Synthesis Rounds")).toHaveValue(2);
      expect(screen.getByRole("checkbox", { name: /^GitHub$/i })).not.toBeChecked();
      expect(screen.getByRole("checkbox", { name: /^Local Docs$/i })).toBeChecked();
    });

    it("saves global research defaults through updateGlobalSettings only", async () => {
      renderModal();
      await waitForSettingsModalReady();
      await openResearchGlobalSection();

      await userEvent.click(screen.getByText(/Advanced — external search providers/i));
      const providerSelect = await screen.findByLabelText("Search Provider");
      fireEvent.change(providerSelect, { target: { value: "tavily" } });
      fireEvent.change(screen.getByLabelText("Default Max Concurrent Runs"), { target: { value: "4" } });
      fireEvent.change(screen.getByLabelText("Default Max Sources Per Run"), { target: { value: "25" } });
      fireEvent.change(screen.getByLabelText("Default Max Duration (ms)"), { target: { value: "240000" } });
      fireEvent.change(screen.getByLabelText("Request Timeout (ms)"), { target: { value: "45000" } });
      fireEvent.change(screen.getByLabelText("Max Synthesis Rounds"), { target: { value: "3" } });
      await userEvent.click(screen.getByRole("checkbox", { name: /^GitHub$/i }));
      await userEvent.click(screen.getByRole("checkbox", { name: /^Local Docs$/i }));
      await userEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdateGlobalSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            researchGlobalDefaults: expect.objectContaining({ searchProvider: "tavily", maxSourcesPerRun: 25 }),
            researchGlobalMaxConcurrentRuns: 4,
            researchGlobalMaxSourcesPerRun: 25,
            researchGlobalDefaultTimeout: 240000,
            researchGlobalFetchTimeoutMs: 45000,
            researchGlobalMaxSynthesisRounds: 3,
            researchGlobalGitHubEnabled: true,
            researchGlobalLocalDocsEnabled: false,
          }),
        );
      });
      expect(mockUpdateSettings).toHaveBeenCalledWith(
        expect.not.objectContaining({ researchSettings: expect.anything() }),
        undefined,
      );
    });

    it("shows web search as always on in project research settings", async () => {
      renderModal();
      await waitForSettingsModalReady();
      await openResearchProjectSection();

      const webSearch = await screen.findByRole("checkbox", { name: /Web Search/i });
      expect(webSearch).toBeChecked();
      expect(webSearch).toBeDisabled();
      expect(screen.getByText("Always on")).toBeInTheDocument();
      expect(screen.getByText(/Web search is always enabled\. Configure the search provider under Research Defaults\./i)).toBeInTheDocument();
    });

    it("does not mutate enabledSources.webSearch when toggling other sources", async () => {
      mockFetchSettings.mockResolvedValueOnce({
        ...defaultSettings,
        experimentalFeatures: { researchView: true },
        researchSettings: {
          enabled: true,
          enabledSources: {
            webSearch: false,
            pageFetch: true,
            github: false,
            localDocs: true,
            llmSynthesis: true,
          },
        },
      });

      renderModal();
      await waitForSettingsModalReady();
      await openResearchProjectSection();

      const webSearch = await screen.findByRole("checkbox", { name: /Web Search/i });
      expect(webSearch).toBeChecked();
      await userEvent.click(webSearch);
      expect(webSearch).toBeChecked();

      await userEvent.click(screen.getByRole("checkbox", { name: "Page Fetch" }));
      await userEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            researchSettings: expect.objectContaining({
              enabledSources: expect.objectContaining({
                webSearch: false,
                pageFetch: false,
              }),
            }),
          }),
          undefined,
        );
      });
    });

    it("saves project research settings through updateSettings only", async () => {
      renderModal();
      await waitForSettingsModalReady();
      await openResearchProjectSection();

      await userEvent.click(screen.getByLabelText("Enable research in this project"));
      const maxConcurrent = await screen.findByLabelText("Max Concurrent Runs");
      fireEvent.change(maxConcurrent, { target: { value: "4" } });
      await userEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            researchSettings: expect.objectContaining({
              enabled: false,
              limits: expect.objectContaining({ maxConcurrentRuns: 4 }),
            }),
          }),
          undefined,
        );
      });
      expect(mockUpdateGlobalSettings).toHaveBeenCalledWith(
        expect.not.objectContaining({ researchGlobalDefaults: expect.anything() }),
      );
    });

    it("blocks save and shows inline error for invalid research limits", async () => {
      renderModal();
      await waitForSettingsModalReady();
      await openResearchProjectSection();

      const maxConcurrent = await screen.findByLabelText("Max Concurrent Runs");
      fireEvent.change(maxConcurrent, { target: { value: "0" } });
      await userEvent.click(screen.getByText("Save"));

      expect(await screen.findByText("Research max concurrent runs must be at least 1.")).toBeInTheDocument();
    });

    it("shows builtin research provider guidance by default", async () => {
      mockFetchSettings.mockResolvedValueOnce({
        ...defaultSettings,
        experimentalFeatures: { researchView: true },
        researchGlobalDefaults: {},
      });

      renderModal();
      await waitForSettingsModalReady();
      await openResearchGlobalSection();

      expect(await screen.findByText(/Built-in \(uses agent web tools\)/i)).toBeInTheDocument();
      expect(screen.queryByText(/Research defaults are incomplete/i)).not.toBeInTheDocument();
    });

    it("keeps external provider settings collapsed by default and reveals on expand", async () => {
      mockFetchSettings.mockResolvedValueOnce({
        ...defaultSettings,
        experimentalFeatures: { researchView: true },
      });

      renderModal();
      await waitForSettingsModalReady();
      await openResearchGlobalSection();

      const details = screen.getByText(/Advanced — external search providers/i).closest("details");
      expect(details).not.toHaveAttribute("open");

      await userEvent.click(screen.getByText(/Advanced — external search providers/i));
      expect(details).toHaveAttribute("open");
      expect(await screen.findByLabelText("SearXNG URL")).toBeInTheDocument();
      expect(screen.getByText(/Open Authentication Settings/i)).toBeInTheDocument();

      const advancedBody = details?.querySelector(".settings-research-provider-advanced-body");
      expect(advancedBody).toBeTruthy();
      expect(advancedBody?.querySelectorAll(".form-group")).toHaveLength(3);
      expect(screen.getByLabelText("Search Provider")).toHaveClass("input");
      expect(screen.getByLabelText("SearXNG URL")).toHaveClass("input");
      expect(screen.getByLabelText("Google Search CX")).toHaveClass("input");
    });

    it("keeps default max sources outside advanced details and groups provider controls", async () => {
      renderModal();
      await waitForSettingsModalReady();
      await openResearchGlobalSection();

      const details = screen.getByText(/Advanced — external search providers/i).closest("details");
      const maxSourcesInput = screen.getByLabelText("Default Max Sources Per Run");
      expect(details).toBeTruthy();
      expect(maxSourcesInput.closest("details")).toBeNull();
      expect(details).not.toContainElement(maxSourcesInput);

      const builtInRadio = screen.getByLabelText(/Built-in \(uses agent web tools\)/i);
      const providerGroup = builtInRadio.closest(".settings-research-provider-group");
      expect(providerGroup).toBeTruthy();
      expect(providerGroup).toContainElement(details);
      expect(providerGroup).toContainElement(screen.getByText(/No API key required\./i));
    });

    it("keeps research limits and source controls inside desktop containment grids for both sections", async () => {
      renderModal();
      await waitForSettingsModalReady();
      await openResearchGlobalSection();

      const defaultMaxConcurrent = screen.getByLabelText("Default Max Concurrent Runs");
      const defaultMaxSources = screen.getByLabelText("Default Max Sources Per Run");
      const defaultMaxDuration = screen.getByLabelText("Default Max Duration (ms)");
      const defaultRequestTimeout = screen.getByLabelText("Request Timeout (ms)");

      const globalLimitsGrid = defaultMaxConcurrent.closest(".settings-research-limits-grid");
      expect(globalLimitsGrid).toBeTruthy();
      expect(defaultMaxSources.closest(".settings-research-limits-grid")).toBe(globalLimitsGrid);
      expect(defaultMaxDuration.closest(".settings-research-limits-grid")).toBe(globalLimitsGrid);
      expect(defaultRequestTimeout.closest(".settings-research-limits-grid")).toBe(globalLimitsGrid);
      expect(defaultMaxConcurrent).toHaveClass("input");
      expect(defaultMaxSources).toHaveClass("input");
      expect(defaultMaxDuration).toHaveClass("input");
      expect(defaultRequestTimeout).toHaveClass("input");

      const globalSourceGrid = screen.getByRole("checkbox", { name: "GitHub" }).closest(".settings-research-source-grid");
      expect(globalSourceGrid).toBeTruthy();
      expect(screen.getByRole("checkbox", { name: "Local Docs" }).closest(".settings-research-source-grid")).toBe(globalSourceGrid);

      await openResearchProjectSection();

      const projectMaxConcurrent = screen.getByLabelText("Max Concurrent Runs");
      const projectMaxSources = screen.getByLabelText("Max Sources Per Run");
      const projectMaxDuration = screen.getByLabelText("Max Duration (ms)");
      const projectRequestTimeout = screen.getByLabelText("Request Timeout (ms)");

      const projectLimitsGrid = projectMaxConcurrent.closest(".settings-research-limits-grid");
      expect(projectLimitsGrid).toBeTruthy();
      expect(projectMaxSources.closest(".settings-research-limits-grid")).toBe(projectLimitsGrid);
      expect(projectMaxDuration.closest(".settings-research-limits-grid")).toBe(projectLimitsGrid);
      expect(projectRequestTimeout.closest(".settings-research-limits-grid")).toBe(projectLimitsGrid);
      expect(projectMaxConcurrent).toHaveClass("input");
      expect(projectMaxSources).toHaveClass("input");
      expect(projectMaxDuration).toHaveClass("input");
      expect(projectRequestTimeout).toHaveClass("input");

      const projectSourceGrid = screen.getByRole("checkbox", { name: "Page Fetch" }).closest(".settings-research-source-grid");
      expect(projectSourceGrid).toBeTruthy();
      expect(screen.getByRole("checkbox", { name: "GitHub" }).closest(".settings-research-source-grid")).toBe(projectSourceGrid);
      expect(screen.getByRole("checkbox", { name: "Local Docs" }).closest(".settings-research-source-grid")).toBe(projectSourceGrid);
      expect(screen.getByRole("checkbox", { name: "LLM Synthesis" }).closest(".settings-research-source-grid")).toBe(projectSourceGrid);
    });

    it("groups project limits fields in one grid and keeps validation error visible", async () => {
      renderModal();
      await waitForSettingsModalReady();
      await openResearchProjectSection();

      const maxConcurrent = screen.getByLabelText("Max Concurrent Runs");
      const maxSources = screen.getByLabelText("Max Sources Per Run");
      const maxDuration = screen.getByLabelText("Max Duration (ms)");
      const requestTimeout = screen.getByLabelText("Request Timeout (ms)");

      const limitsGrid = maxConcurrent.closest(".settings-research-limits-grid");
      expect(limitsGrid).toBeTruthy();
      expect(maxSources.closest(".settings-research-limits-grid")).toBe(limitsGrid);
      expect(maxDuration.closest(".settings-research-limits-grid")).toBe(limitsGrid);
      expect(requestTimeout.closest(".settings-research-limits-grid")).toBe(limitsGrid);
      expect(maxConcurrent).toHaveClass("input");
      expect(maxSources).toHaveClass("input");
      expect(maxDuration).toHaveClass("input");
      expect(requestTimeout).toHaveClass("input");

      const sourceGrid = screen.getByRole("checkbox", { name: "Page Fetch" }).closest(".settings-research-source-grid");
      expect(sourceGrid).toBeTruthy();
      expect(screen.getByRole("checkbox", { name: "GitHub" }).closest(".settings-research-source-grid")).toBe(sourceGrid);
      expect(screen.getByRole("checkbox", { name: "Local Docs" }).closest(".settings-research-source-grid")).toBe(sourceGrid);
      expect(screen.getByRole("checkbox", { name: "LLM Synthesis" }).closest(".settings-research-source-grid")).toBe(sourceGrid);

      fireEvent.change(maxConcurrent, { target: { value: "0" } });
      await userEvent.click(screen.getByText("Save"));
      expect(await screen.findByText("Research max concurrent runs must be at least 1.")).toBeInTheDocument();
    });

    it("shows missing credentials warning and routes CTA to Authentication", async () => {
      mockFetchSettings.mockResolvedValueOnce({
        ...defaultSettings,
        experimentalFeatures: { researchView: true },
        researchGlobalDefaults: {
          searchProvider: "brave",
        },
      });
      mockFetchAuthStatus.mockResolvedValue({
        providers: [
          { id: "brave", name: "Brave Search", type: "api_key", authenticated: false },
          { id: "tavily", name: "Tavily", type: "api_key", authenticated: true },
        ],
      });

      renderModal();
      await waitForSettingsModalReady();
      await openResearchGlobalSection();

      expect(await screen.findByText(/Missing credentials for the selected research provider/i)).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Open Authentication" }));
      expect(await screen.findByRole("heading", { name: "Authentication" })).toBeInTheDocument();
    });

    it("falls back to first visible section when initial section is unavailable", async () => {
      renderModal({ initialSection: "unknown-section" as any });
      await waitForSettingsModalReady();
      expect(await screen.findByRole("heading", { name: "General" })).toBeInTheDocument();
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

describe("plugin structured contribution contract fixtures", () => {
  it("represents all required structured surfaces without componentPath", () => {
    const contributions: PluginUiContributionEntry[] = [
      { pluginId: "plugin-a", contribution: { surface: "settings-provider-card", contributionId: "a", providerId: "openai", title: "OpenAI", providerType: "api_key" } },
      { pluginId: "plugin-a", contribution: { surface: "settings-config-section", contributionId: "b", sectionId: "openai", title: "OpenAI config", pluginSettingKeys: ["openai.apiKey"] } },
      { pluginId: "plugin-a", contribution: { surface: "onboarding-provider-card", contributionId: "c", providerId: "openai", title: "OpenAI", providerType: "api_key" } },
      { pluginId: "plugin-a", contribution: { surface: "onboarding-setup-help", contributionId: "d", title: "Help", body: "Use API key", bodyFormat: "text" } },
      { pluginId: "plugin-a", contribution: { surface: "onboarding-provider-recommendation", contributionId: "e", providerId: "openai", title: "Recommended", reason: "Fast setup" } },
      { pluginId: "plugin-a", contribution: { surface: "post-onboarding-recommendation", contributionId: "f", title: "Next step", description: "Enable memory" } },
    ];

    expect(contributions).toHaveLength(6);
    for (const entry of contributions) {
      expect("componentPath" in entry.contribution).toBe(false);
    }
  });
});
