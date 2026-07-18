import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsModal } from "../SettingsModal";

const mockFetchSettings = vi.fn();
const mockFetchSettingsByScope = vi.fn();

vi.mock("../../api", async (importOriginal) => {
  const { createDashboardApiMock } = await import("../../test/mockApi");
  return createDashboardApiMock(() => importOriginal<typeof import("../../api")>(), {
    fetchSettings: (...args: unknown[]) => mockFetchSettings(...args),
    fetchSettingsByScope: (...args: unknown[]) => mockFetchSettingsByScope(...args),
  });
});

vi.mock("../../api/legacy", () => ({
  fetchCodebaseMetrics: vi.fn().mockResolvedValue({ tokenEstimate: 0, sourceFileCount: 0, sourceByteCount: 0, diskBytes: 0, diskFileCount: 0, method: "local", truncated: false }),
  fetchFnBinaryStatus: vi.fn(() => Promise.resolve({
    binary: { binary: "fn", installed: false, path: null, version: null },
    expectedVersion: "1.2.3",
    state: "missing",
    install: { command: "npm install -g runfusion.ai" },
  })),
  installFnBinary: vi.fn(),
}));

vi.mock("../../hooks/useMemoryBackendStatus", () => ({
  useMemoryBackendStatus: () => ({ status: null, capabilities: null, loading: false, error: null, refresh: vi.fn() }),
}));
vi.mock("../../hooks/useViewportMode", () => ({
  MOBILE_MEDIA_QUERY: "(max-width: 768px), (max-height: 480px)",
  isFullScreenSheetViewport: () => false,
  isShortViewport: () => false,
  useViewportMode: () => "desktop",
  getViewportMode: () => "desktop",
  isMobileViewport: () => false,
}));
vi.mock("../../hooks/useMobileKeyboard", () => ({
  useMobileKeyboard: () => ({ keyboardOverlap: 0, viewportHeight: null, viewportOffsetTop: 0, keyboardOpen: false }),
}));
vi.mock("../../hooks/useMobileScrollLock", () => ({
  useMobileScrollLock: vi.fn(),
  useMobileKeyboardViewportLock: vi.fn(),
  useMobileViewportRestoreReset: vi.fn(),
}));
vi.mock("../../hooks/useConfirm", () => ({ useConfirm: () => ({ confirm: vi.fn() }) }));
vi.mock("../../hooks/useWorkspaceFileBrowser", () => ({
  useWorkspaceFileBrowser: () => ({ entries: [], currentPath: ".", setPath: vi.fn(), loading: false, error: null, refresh: vi.fn() }),
}));
vi.mock("../../hooks/useWorktrunkInstallStatus", () => ({
  useWorktrunkInstallStatus: () => ({ status: "idle", requestInstall: vi.fn() }),
}));

function buildSettings() {
  return {
    autoMerge: true,
    maxConcurrent: 2,
    maxTriageConcurrent: 2,
    maxWorktrees: 4,
    pollIntervalMs: 15000,
    heartbeatMultiplier: 1,
    groupOverlappingFiles: true,
    overlapIgnorePaths: [],
    mergeStrategy: "direct",
    mergeIntegrationWorktree: "reuse-task-worktree",
    recycleWorktrees: false,
    executorAllowSiblingBranchRename: false,
    worktreeNaming: "random",
    worktreesDir: "",
    worktrunk: { enabled: false, binaryPath: "", onFailure: "fail" },
    includeTaskIdInCommit: true,
    ntfyEnabled: false,
    failureNotificationMode: "sticky-only",
    failureNotificationDelayMs: 30000,
    webhookEnabled: false,
    experimentalFeatures: {},
  };
}

async function renderBasicSettings() {
  const view = render(<SettingsModal onClose={vi.fn()} addToast={vi.fn()} />);
  await waitFor(() => expect(mockFetchSettings).toHaveBeenCalled());
  return view;
}

describe("SettingsModal CLI Binary visibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.removeItem("fusion:settings:show-advanced");
    mockFetchSettings.mockResolvedValue(buildSettings());
    mockFetchSettingsByScope.mockResolvedValue({ global: {}, project: {} });
  });

  it("keeps CLI Binary reachable from the Basic-mode desktop nav", async () => {
    const user = userEvent.setup();
    const { container } = await renderBasicSettings();

    expect(screen.getByRole("checkbox", { name: "Advanced settings" })).not.toBeChecked();
    expect(container.querySelector(".settings-mobile-section-picker")).toBeNull();

    await user.click(screen.getByRole("button", { name: /CLI Binary$/ }));
    expect(await screen.findByText(/Installing the global CLI lets you run fn and fusion/)).toBeInTheDocument();
    expect(container.querySelector(".cli-binary-panel")).toBeTruthy();
  });

  it("returns CLI Binary for a Basic-mode search and lets operators open it", async () => {
    const user = userEvent.setup();
    const { container } = await renderBasicSettings();

    expect(container.querySelector(".settings-mobile-section-picker")).toBeNull();
    await user.type(screen.getByTestId("settings-search-input"), "binary check");

    const cliBinaryNav = await screen.findByRole("button", { name: /CLI Binary$/ });
    await user.click(cliBinaryNav);
    expect(await screen.findByText(/Installing the global CLI lets you run fn and fusion/)).toBeInTheDocument();
  });

  it("keeps CLI Binary available after Advanced settings is enabled", async () => {
    const user = userEvent.setup();
    await renderBasicSettings();

    await user.click(screen.getByRole("checkbox", { name: "Advanced settings" }));
    expect(screen.getByRole("checkbox", { name: "Advanced settings" })).toBeChecked();
    expect(screen.getByRole("button", { name: /CLI Binary$/ })).toBeInTheDocument();
  });
});
