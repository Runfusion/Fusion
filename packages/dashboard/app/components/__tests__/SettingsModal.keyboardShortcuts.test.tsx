import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsModal } from "../SettingsModal";

/*
FNXC:DashboardShortcuts 2026-07-04-00:00:
FN-7553 relocates the shortcut-save/validation coverage that used to live in
SettingsModal.general.test.tsx (initialSection="global-general") to the new
dedicated "keyboard-shortcuts" section. Mirrors SettingsModal.testMode.test.tsx's
minimal standalone harness rather than the large shared general-test-harness.
*/
const mockFetchSettings = vi.fn();
const mockFetchSettingsByScope = vi.fn();
const mockUpdateSettings = vi.fn();
const mockUpdateGlobalSettings = vi.fn();

vi.mock("../../api", async (importOriginal) => {
  const { createDashboardApiMock } = await import("../../test/mockApi");
  return createDashboardApiMock(() => importOriginal<typeof import("../../api")>(), {
    fetchSettings: (...args: unknown[]) => mockFetchSettings(...args),
    fetchSettingsByScope: (...args: unknown[]) => mockFetchSettingsByScope(...args),
    updateSettings: (...args: unknown[]) => mockUpdateSettings(...args),
    updateGlobalSettings: (...args: unknown[]) => mockUpdateGlobalSettings(...args),
  });
});

vi.mock("../../hooks/useMemoryBackendStatus", () => ({
  useMemoryBackendStatus: () => ({ status: null, capabilities: null, loading: false, error: null, refresh: vi.fn() }),
}));
vi.mock("../../hooks/useViewportMode", () => ({
  MOBILE_MEDIA_QUERY: "(max-width: 768px), (max-height: 480px)",
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
    testMode: false,
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
    dashboardKeyboardShortcuts: {
      quickChat: "Space",
      terminal: "Ctrl+`",
      openFiles: "Ctrl+E",
      openSettings: "Ctrl+,",
      openCommandCenter: "Ctrl+K",
      newTask: "Ctrl+Shift+N",
    },
  };
}

describe("SettingsModal Keyboard Shortcuts section", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchSettings.mockResolvedValue(buildSettings());
    mockFetchSettingsByScope.mockResolvedValue({ global: buildSettings(), project: {} });
  });

  it("renders all six actions with their documented defaults, grouped by category", async () => {
    render(<SettingsModal onClose={() => {}} addToast={() => {}} initialSection="keyboard-shortcuts" />);

    expect(await screen.findByRole("textbox", { name: "Quick Chat" })).toHaveValue("Space");
    expect(screen.getByRole("textbox", { name: "Terminal" })).toHaveValue("Ctrl+`");
    expect(screen.getByRole("textbox", { name: "Open Files" })).toHaveValue("Ctrl+E");
    expect(screen.getByRole("textbox", { name: "Open Settings" })).toHaveValue("Ctrl+,");
    expect(screen.getByRole("textbox", { name: "Open Command Center" })).toHaveValue("Ctrl+K");
    expect(screen.getByRole("textbox", { name: "New Task" })).toHaveValue("Ctrl+Shift+N");

    expect(screen.getByText("Communication")).toBeInTheDocument();
    expect(screen.getByText("Workspace")).toBeInTheDocument();
    expect(screen.getByText("Navigation")).toBeInTheDocument();
    expect(screen.getByText("Tasks")).toBeInTheDocument();
  });

  it("saves normalized manual edits for the new actions to global settings only", async () => {
    const user = userEvent.setup();
    render(<SettingsModal onClose={() => {}} addToast={() => {}} initialSection="keyboard-shortcuts" />);

    const openFilesInput = await screen.findByRole("textbox", { name: "Open Files" });
    await user.clear(openFilesInput);
    await user.type(openFilesInput, "alt+e");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockUpdateGlobalSettings).toHaveBeenCalled());
    const globalPayload = mockUpdateGlobalSettings.mock.calls[0]?.[0] as Record<string, unknown>;
    expect((globalPayload.dashboardKeyboardShortcuts as Record<string, string>).openFiles).toBe("Alt+E");
    if (mockUpdateSettings.mock.calls.length > 0) {
      const projectPayload = mockUpdateSettings.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(projectPayload.dashboardKeyboardShortcuts).toBeUndefined();
    }
  });

  it("detects a duplicate conflict across the base and a new action and blocks save", async () => {
    const addToast = vi.fn();
    const user = userEvent.setup();
    render(<SettingsModal onClose={() => {}} addToast={addToast} initialSection="keyboard-shortcuts" />);

    const openFilesInput = await screen.findByRole("textbox", { name: "Open Files" });
    await user.clear(openFilesInput);
    await user.type(openFilesInput, "Ctrl+K");

    expect(screen.getByRole("alert")).toHaveTextContent("both use Ctrl+K");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(addToast).toHaveBeenCalledWith(expect.stringContaining("both use Ctrl+K"), "error");
    expect(mockUpdateGlobalSettings).not.toHaveBeenCalled();
  });

  it("allows disabling a new action with a blank value", async () => {
    const user = userEvent.setup();
    render(<SettingsModal onClose={() => {}} addToast={() => {}} initialSection="keyboard-shortcuts" />);

    const newTaskInput = await screen.findByRole("textbox", { name: "New Task" });
    await user.clear(newTaskInput);
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockUpdateGlobalSettings).toHaveBeenCalled());
    const globalPayload = mockUpdateGlobalSettings.mock.calls[0]?.[0] as Record<string, unknown>;
    expect((globalPayload.dashboardKeyboardShortcuts as Record<string, string>).newTask).toBe("");
  });
});
