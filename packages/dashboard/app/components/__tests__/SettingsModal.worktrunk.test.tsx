import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsModal } from "../SettingsModal";

const mockFetchSettings = vi.fn();
const mockFetchSettingsByScope = vi.fn();
const mockFetchAuthStatus = vi.fn();
const mockFetchModels = vi.fn();
const mockFetchCustomProviders = vi.fn();
const mockFetchMemoryFiles = vi.fn();
const mockFetchGlobalConcurrency = vi.fn();
const mockFetchDashboardHealth = vi.fn();
const mockUseWorktrunkInstallStatus = vi.fn();

vi.mock("../../api", async (importOriginal) => {
  const { createDashboardApiMock } = await import("../../test/mockApi");
  return createDashboardApiMock(() => importOriginal<typeof import("../../api")>(), {
    fetchSettings: (...args: unknown[]) => mockFetchSettings(...args),
    fetchSettingsByScope: (...args: unknown[]) => mockFetchSettingsByScope(...args),
    fetchAuthStatus: (...args: unknown[]) => mockFetchAuthStatus(...args),
    fetchModels: (...args: unknown[]) => mockFetchModels(...args),
    fetchCustomProviders: (...args: unknown[]) => mockFetchCustomProviders(...args),
    fetchMemoryFiles: (...args: unknown[]) => mockFetchMemoryFiles(...args),
    fetchGlobalConcurrency: (...args: unknown[]) => mockFetchGlobalConcurrency(...args),
    fetchDashboardHealth: (...args: unknown[]) => mockFetchDashboardHealth(...args),
  });
});

vi.mock("../../hooks/useWorktrunkInstallStatus", () => ({
  useWorktrunkInstallStatus: (...args: unknown[]) => mockUseWorktrunkInstallStatus(...args),
}));

vi.mock("../../hooks/useViewportMode", () => ({
  MOBILE_MEDIA_QUERY: "(max-width: 768px), (max-height: 480px)",
  useViewportMode: () => "desktop",
  getViewportMode: () => "desktop",
  isMobileViewport: () => false,
}));
vi.mock("../../hooks/useMobileKeyboard", () => ({
  useMobileKeyboard: () => ({ keyboardOpen: false, keyboardOverlap: 0, viewportHeight: null, viewportOffsetTop: 0 }),
}));
vi.mock("../../hooks/useConfirm", () => ({ useConfirm: () => ({ confirm: vi.fn().mockResolvedValue(true) }) }));

const defaultSettings = {
  maxConcurrent: 2,
  maxWorktrees: 4,
  pollIntervalMs: 15000,
  autoMerge: true,
  worktrunk: { enabled: false, binaryPath: "", onFailure: "fail" },
};

function renderModal(onOpenApprovals = vi.fn()) {
  return render(<SettingsModal onClose={() => {}} addToast={() => {}} initialSection="worktrees" onOpenApprovals={onOpenApprovals} />);
}

describe("SettingsModal worktrunk install affordance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchSettings.mockResolvedValue(defaultSettings);
    mockFetchSettingsByScope.mockResolvedValue({ global: defaultSettings, project: {} });
    mockFetchAuthStatus.mockResolvedValue({ providers: [] });
    mockFetchModels.mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] });
    mockFetchCustomProviders.mockResolvedValue({ providers: [] });
    mockFetchMemoryFiles.mockResolvedValue({ files: [] });
    mockFetchGlobalConcurrency.mockResolvedValue({ maxConcurrentRuns: 4 });
    mockFetchDashboardHealth.mockResolvedValue({});
  });

  it.each([
    { status: "missing", button: "Install worktrunk binary", action: "request" },
    { status: "pending-approval", button: "Open Approvals", action: "open" },
    { status: "denied", button: "Try again", action: "request" },
    { status: "installed", text: /installed at/i },
  ])("renders state %#", async (scenario) => {
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

    renderModal(onOpenApprovals);
    await waitFor(() => expect(mockFetchSettings).toHaveBeenCalled());

    if (scenario.text) {
      expect(screen.getByText(scenario.text)).toBeInTheDocument();
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
});
