import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsModal } from "../SettingsModal";

const mockFetchSettings = vi.fn();
const mockFetchSettingsByScope = vi.fn();
const mockUpdateSettings = vi.fn();
const mockFetchAuthStatus = vi.fn();
const mockFetchModels = vi.fn();
const mockFetchBackups = vi.fn();
const mockFetchMemoryFiles = vi.fn();
const mockFetchMemoryFile = vi.fn();
const mockFetchGlobalConcurrency = vi.fn();
const mockFetchMemoryBackendStatus = vi.fn();
const mockFetchGitRemotesDetailed = vi.fn();
const mockFetchDashboardHealth = vi.fn();
const mockCheckForUpdates = vi.fn();
const mockFetchRemoteSettings = vi.fn();
const mockUseMemoryBackendStatus = vi.fn();

const mockNodes = [
  { id: "node-local", name: "Local Machine", type: "local", status: "online", maxConcurrent: 4, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
  { id: "node-remote-1", name: "Alpha Worker", type: "remote", status: "online", maxConcurrent: 8, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
  { id: "node-remote-2", name: "Beta Node", type: "remote", status: "offline", maxConcurrent: 4, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
];

vi.mock("../../api", () => ({
  fetchSettings: (...args: unknown[]) => mockFetchSettings(...args),
  fetchSettingsByScope: (...args: unknown[]) => mockFetchSettingsByScope(...args),
  updateSettings: (...args: unknown[]) => mockUpdateSettings(...args),
  updateGlobalSettings: vi.fn(),
  fetchAuthStatus: (...args: unknown[]) => mockFetchAuthStatus(...args),
  fetchModels: (...args: unknown[]) => mockFetchModels(...args),
  fetchBackups: (...args: unknown[]) => mockFetchBackups(...args),
  fetchMemoryFiles: (...args: unknown[]) => mockFetchMemoryFiles(...args),
  fetchMemoryFile: (...args: unknown[]) => mockFetchMemoryFile(...args),
  saveMemoryFile: vi.fn(),
  compactMemory: vi.fn(),
  fetchGlobalConcurrency: (...args: unknown[]) => mockFetchGlobalConcurrency(...args),
  updateGlobalConcurrency: vi.fn(),
  fetchMemoryBackendStatus: (...args: unknown[]) => mockFetchMemoryBackendStatus(...args),
  testMemoryRetrieval: vi.fn(),
  installQmd: vi.fn(),
  fetchGitRemotesDetailed: (...args: unknown[]) => mockFetchGitRemotesDetailed(...args),
  fetchDashboardHealth: (...args: unknown[]) => mockFetchDashboardHealth(...args),
  checkForUpdates: (...args: unknown[]) => mockCheckForUpdates(...args),
  fetchRemoteSettings: (...args: unknown[]) => mockFetchRemoteSettings(...args),
  updateRemoteSettings: vi.fn(),
  fetchRemoteStatus: vi.fn(),
  activateRemoteProvider: vi.fn(),
  startRemoteTunnel: vi.fn(),
  stopRemoteTunnel: vi.fn(),
  regenerateRemotePersistentToken: vi.fn(),
  generateShortLivedRemoteToken: vi.fn(),
  fetchRemoteQr: vi.fn(),
  fetchRemoteUrl: vi.fn(),
  triggerMemoryDreams: vi.fn(),
  exportSettings: vi.fn(),
  importSettings: vi.fn(),
  createBackup: vi.fn(),
  testNtfyNotification: vi.fn(),
  loginProvider: vi.fn(),
  logoutProvider: vi.fn(),
}));

vi.mock("../../hooks/useNodes", () => ({
  useNodes: vi.fn(() => ({
    nodes: mockNodes,
    loading: false,
    error: null,
    refresh: vi.fn(),
    register: vi.fn(),
    update: vi.fn(),
    unregister: vi.fn(),
    healthCheck: vi.fn(),
  })),
}));

vi.mock("../../hooks/useMemoryBackendStatus", () => ({
  useMemoryBackendStatus: (...args: unknown[]) => mockUseMemoryBackendStatus(...args),
}));

vi.mock("lucide-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("lucide-react")>();
  return { ...actual, Globe: () => <span />, Folder: () => <span />, RefreshCw: () => <span />, Star: () => <span />, HelpCircle: () => <span />, Loader2: () => <span /> };
});

vi.mock("../PluginManager", () => ({ PluginManager: () => <div /> }));
vi.mock("../PiExtensionsManager", () => ({ PiExtensionsManager: () => <div /> }));
vi.mock("../PluginSlot", () => ({ PluginSlot: () => <div /> }));
vi.mock("../../hooks/useWorkspaceFileBrowser", () => ({ useWorkspaceFileBrowser: () => ({ isOpen: false, open: vi.fn(), close: vi.fn(), entries: [], loading: false, error: null, selectedPath: null, navigateTo: vi.fn(), selectPath: vi.fn() }) }));
vi.mock("../FileBrowser", () => ({ FileBrowser: () => <div /> }));

const baseSettings = {
  maxConcurrent: 2,
  maxWorktrees: 4,
  pollIntervalMs: 15000,
  groupOverlappingFiles: true,
  overlapIgnorePaths: [],
  autoMerge: true,
  mergeStrategy: "direct",
  pushAfterMerge: false,
  pushRemote: "origin",
  recycleWorktrees: false,
  worktreeNaming: "random",
  includeTaskIdInCommit: true,
};

function renderModal() {
  return render(<SettingsModal onClose={() => {}} addToast={() => {}} />);
}

async function ready() {
  await waitFor(() => {
    expect(mockFetchSettings).toHaveBeenCalled();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });
}

async function openNodeRouting() {
  await ready();
  await userEvent.click(screen.getAllByText("Node Routing")[0]);
}

describe("SettingsModal Node Routing section", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchSettings.mockResolvedValue(baseSettings);
    mockFetchSettingsByScope.mockResolvedValue({ global: baseSettings, project: {} });
    mockFetchAuthStatus.mockResolvedValue({ providers: [] });
    mockFetchModels.mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] });
    mockFetchBackups.mockResolvedValue({ backups: [], totalSize: 0 });
    mockFetchMemoryFiles.mockResolvedValue({ files: [] });
    mockFetchMemoryFile.mockResolvedValue({ path: ".fusion/memory/MEMORY.md", content: "" });
    mockFetchGlobalConcurrency.mockResolvedValue({ globalMaxConcurrent: 10 });
    mockFetchMemoryBackendStatus.mockResolvedValue({ currentBackend: "file", capabilities: { readable: true, writable: true, supportsAtomicWrite: true, hasConflictResolution: false, persistent: true }, availableBackends: ["file"], qmdAvailable: false, qmdInstallCommand: null });
    mockUseMemoryBackendStatus.mockReturnValue({ status: null, currentBackend: "file", capabilities: { readable: true, writable: true, supportsAtomicWrite: true, hasConflictResolution: false, persistent: true }, availableBackends: ["file"], loading: false, error: null, refresh: vi.fn() });
    mockFetchGitRemotesDetailed.mockResolvedValue([]);
    mockFetchDashboardHealth.mockResolvedValue({ status: "ok", version: "1.2.3", uptime: 123 });
    mockCheckForUpdates.mockResolvedValue(undefined);
    mockFetchRemoteSettings.mockResolvedValue({ settings: {} });
    mockUpdateSettings.mockResolvedValue({ success: true });
  });

  it("renders section heading and description", async () => {
    renderModal();
    await openNodeRouting();
    expect(screen.getByRole("heading", { name: "Node Routing" })).toBeInTheDocument();
    expect(screen.getByText(/Configure how tasks are routed to execution nodes/)).toBeInTheDocument();
  });

  it("shows project scope banner", async () => {
    renderModal();
    await openNodeRouting();
    expect(screen.getByText(/These settings only affect this project\./i)).toBeInTheDocument();
  });

  it("shows local execution selected when no default node is set", async () => {
    renderModal();
    await openNodeRouting();
    expect(screen.getByLabelText("Default Execution Node")).toHaveValue("");
    expect(screen.getByRole("option", { name: "Local execution (no default node)" })).toBeInTheDocument();
  });

  it("shows current node when defaultNodeId is configured", async () => {
    mockFetchSettings.mockResolvedValue({ ...baseSettings, defaultNodeId: "node-remote-1" });
    renderModal();
    await openNodeRouting();
    expect(screen.getByLabelText("Default Execution Node")).toHaveValue("node-remote-1");
    expect(screen.getByText(/Selected node:/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Node status: Online")).toBeInTheDocument();
  });

  it("lists all available nodes in selector", async () => {
    renderModal();
    await openNodeRouting();
    expect(screen.getByRole("option", { name: /Local Machine \(Online\)/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Alpha Worker \(Online\)/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Beta Node \(Offline\)/ })).toBeInTheDocument();
  });

  it("changing default node updates form", async () => {
    renderModal();
    await openNodeRouting();
    fireEvent.change(screen.getByLabelText("Default Execution Node"), { target: { value: "node-remote-1" } });
    expect(screen.getByLabelText("Default Execution Node")).toHaveValue("node-remote-1");
  });

  it("defaults unavailable node policy to block", async () => {
    renderModal();
    await openNodeRouting();
    expect(screen.getByLabelText("Unavailable Node Policy")).toHaveValue("block");
  });

  it("shows fallback-local when configured", async () => {
    mockFetchSettings.mockResolvedValue({ ...baseSettings, unavailableNodePolicy: "fallback-local" });
    renderModal();
    await openNodeRouting();
    expect(screen.getByLabelText("Unavailable Node Policy")).toHaveValue("fallback-local");
  });

  it("changing policy updates form", async () => {
    renderModal();
    await openNodeRouting();
    fireEvent.change(screen.getByLabelText("Unavailable Node Policy"), { target: { value: "fallback-local" } });
    expect(screen.getByLabelText("Unavailable Node Policy")).toHaveValue("fallback-local");
  });

  it("save persists both defaultNodeId and unavailableNodePolicy", async () => {
    renderModal();
    await openNodeRouting();

    fireEvent.change(screen.getByLabelText("Default Execution Node"), { target: { value: "node-remote-1" } });
    fireEvent.change(screen.getByLabelText("Unavailable Node Policy"), { target: { value: "fallback-local" } });

    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockUpdateSettings).toHaveBeenCalledTimes(1));
    const payload = mockUpdateSettings.mock.calls[0][0];
    expect(payload).toMatchObject({
      defaultNodeId: "node-remote-1",
      unavailableNodePolicy: "fallback-local",
    });
  });

  it.each([
    ["block", "Block execution"],
    ["fallback-local", "Fall back to local"],
  ])("renders policy option %s (%s)", async (_value, label) => {
    renderModal();
    await openNodeRouting();
    expect(screen.getByRole("option", { name: label })).toBeInTheDocument();
  });

  it("removes routing controls from scheduling section", async () => {
    renderModal();
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Scheduling" }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Scheduling" })).toBeInTheDocument();
    });
    expect(screen.queryByLabelText("Default Execution Node")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Unavailable Node Policy")).not.toBeInTheDocument();
  });

  it("shows informational note", async () => {
    renderModal();
    await openNodeRouting();
    expect(screen.getByText(/These settings apply at the project level/)).toBeInTheDocument();
  });
});
