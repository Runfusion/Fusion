import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { CommandCenter } from "../CommandCenter";

const apiMock = vi.fn();
const mockFetchSystemInfo = vi.fn();
const mockFetchCurrentSystemRebuild = vi.fn();
const mockFetchSystemStats = vi.fn();
const mockFetchNodeSystemStats = vi.fn();
const mockFetchGlobalSettings = vi.fn();
const mockFetchNodes = vi.fn();

vi.mock("../../../api/legacy", () => ({
  api: (path: string, opts?: RequestInit) => apiMock(path, opts),
  withProjectId: (path: string, projectId?: string) =>
    projectId ? `${path}${path.includes("?") ? "&" : "?"}projectId=${encodeURIComponent(projectId)}` : path,
  fetchOrgTree: vi.fn().mockResolvedValue([]),
  fetchExecutorStats: vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false, maxConcurrent: 2 }),
  fetchSettings: vi.fn().mockResolvedValue({ maxConcurrent: 2, maxTriageConcurrent: 1, maxWorktrees: 5 }),
  fetchConfig: vi.fn().mockResolvedValue({ maxConcurrent: 2, rootDir: "/" }),
  updateSettings: vi.fn().mockResolvedValue({}),
  createBackup: vi.fn().mockResolvedValue({ ok: true }),
  fetchDashboardHealth: vi.fn().mockResolvedValue({ ok: true }),
  fetchCurrentSystemRebuild: (...args: unknown[]) => mockFetchCurrentSystemRebuild(...args),
  fetchSystemInfo: (...args: unknown[]) => mockFetchSystemInfo(...args),
  fetchSystemLogs: vi.fn().mockResolvedValue({ entries: [] }),
  reloadAllSystemPlugins: vi.fn().mockResolvedValue({ ok: true }),
  requestSystemRestart: vi.fn().mockResolvedValue({ ok: true }),
  restartAllSystemAgents: vi.fn().mockResolvedValue({ ok: true }),
  restartSystemEngines: vi.fn().mockResolvedValue({ ok: true }),
  startSystemRebuild: vi.fn().mockResolvedValue({ id: "job-1", status: "running", lines: [] }),
}));

vi.mock("../../../api", () => ({
  fetchSystemStats: (...args: unknown[]) => mockFetchSystemStats(...args),
  fetchNodeSystemStats: (...args: unknown[]) => mockFetchNodeSystemStats(...args),
  fetchGlobalSettings: (...args: unknown[]) => mockFetchGlobalSettings(...args),
  fetchNodes: (...args: unknown[]) => mockFetchNodes(...args),
  killVitestProcesses: vi.fn().mockResolvedValue({ killed: 0, pids: [] }),
  updateGlobalSettings: vi.fn().mockResolvedValue({}),
}));

vi.mock("../../../sse-bus", () => ({
  subscribeSse: vi.fn(() => () => undefined),
}));

vi.mock("../../../hooks/useAppSettings", () => ({
  useAppSettings: () => ({
    globalPaused: false,
    enginePaused: false,
    toggleGlobalPause: vi.fn(),
    toggleEnginePause: vi.fn(),
    refresh: vi.fn().mockResolvedValue(undefined),
  }),
}));

function emptyOverviewResponse(path: string) {
  if (path.includes("/command-center/tokens")) {
    return { totals: { totalTokens: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, nTasks: 0 }, cost: { usd: null, unavailable: true, stale: false }, groups: [] };
  }
  if (path.includes("/command-center/tools")) return { totals: { calls: 0, errors: 0 }, groups: [] };
  if (path.includes("/command-center/activity")) return { totals: { agentRuns: 0, tasksDone: 0 }, daily: [] };
  if (path.includes("/command-center/signals")) return { totals: { open: 0, closed: 0 }, groups: [] };
  if (path.includes("/command-center/live")) return { activeTasks: 0, activeAgents: 0, openSignals: 0, tokensPerMinute: 0, tasksByColumn: [] };
  return {};
}

function systemInfoFixture() {
  return {
    pid: 12345,
    nodeVersion: "v22.0.0",
    platform: "darwin",
    arch: "arm64",
    sourceCheckout: true,
    supervised: true,
    engineRestartSupported: true,
    agentRestartSupported: true,
    pluginReloadSupported: true,
    logsSupported: true,
    activeRebuild: null,
  };
}

function systemStatsFixture() {
  return {
    systemStats: {
      rss: 1024,
      heapUsed: 512,
      heapTotal: 1024,
      heapLimit: 2048,
      external: 0,
      arrayBuffers: 0,
      cpuPercent: 10,
      loadAvg: [0.1, 0.2, 0.3] as [number, number, number],
      cpuCount: 8,
      systemTotalMem: 4096,
      systemFreeMem: 2048,
      pid: 12345,
      nodeVersion: "v22.0.0",
      platform: "darwin/arm64",
    },
    taskStats: {
      total: 0,
      byColumn: {},
      active: 0,
      agents: { idle: 0, active: 0, running: 0, error: 0 },
    },
    vitestProcessCount: 0,
    vitestLastAutoKillAt: null,
  };
}

describe("SystemControlsArea layout integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.mockImplementation((path: string) => Promise.resolve(emptyOverviewResponse(path)));
    mockFetchSystemInfo.mockResolvedValue(systemInfoFixture());
    mockFetchCurrentSystemRebuild.mockResolvedValue({ job: null });
    mockFetchSystemStats.mockResolvedValue(systemStatsFixture());
    mockFetchNodeSystemStats.mockResolvedValue(systemStatsFixture());
    mockFetchGlobalSettings.mockResolvedValue({ vitestAutoKillEnabled: true, vitestKillThresholdPct: 90 });
    mockFetchNodes.mockResolvedValue([]);
  });

  it("wraps System controls, Server logs, and Live system health in the shared gap owner", async () => {
    render(<CommandCenter projectId="proj-1" />);

    fireEvent.click(screen.getByTestId("command-center-tab-system"));

    const systemTab = await screen.findByTestId("cc-system-tab");
    const controls = await screen.findByTestId("cc-system-controls");
    const logs = await screen.findByTestId("cc-system-logs");
    const stats = await screen.findByTestId("cc-area-system");

    expect(systemTab).toHaveClass("cc-system-tab");
    expect(systemTab).toContainElement(controls);
    expect(systemTab).toContainElement(logs);
    expect(systemTab).toContainElement(stats);
    expect(controls.parentElement).toBe(systemTab);
    expect(logs.parentElement).toBe(systemTab);
    expect(stats.parentElement).toBe(systemTab);
    expect(screen.getByTestId("cc-system-logs-toggle")).toBeInTheDocument();
    await waitFor(() => expect(mockFetchSystemInfo).toHaveBeenCalled());
  });

  it("keeps the System controls refresh button in the scoped inline header", async () => {
    render(<CommandCenter projectId="proj-1" />);

    fireEvent.click(screen.getByTestId("command-center-tab-system"));

    const controls = await screen.findByTestId("cc-system-controls");
    const header = controls.querySelector<HTMLElement>(".cc-system-controls-header");
    const title = screen.getByRole("heading", { name: "System controls" });
    const refresh = screen.getByTestId("cc-system-refresh");

    expect(header).toBeInTheDocument();
    expect(header).toHaveClass("cc-area-section-header", "cc-system-controls-header");
    expect(title.parentElement).toBe(header);
    expect(refresh.parentElement).toBe(header);
  });

  it("keeps the System controls header row override active on mobile", () => {
    const css = readFileSync(join(process.cwd(), "app/components/command-center/areas/SystemControlsArea.css"), "utf8");

    expect(css).toMatch(/\.cc-area-section-header\.cc-system-controls-header\s*{[^}]*flex-direction:\s*row;[^}]*justify-content:\s*space-between;/s);
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)\s*{[\s\S]*\.cc-area-section-header\.cc-system-controls-header\s*{[^}]*flex-direction:\s*row;[^}]*justify-content:\s*space-between;/);
  });

  it("keeps the System tab gap and mobile scroll-owner CSS contracts tokenized", () => {
    const css = readFileSync(join(process.cwd(), "app/components/command-center/CommandCenter.css"), "utf8");

    expect(css).toMatch(/\.cc-system-tab\s*{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*gap:\s*var\(--space-lg\);/s);
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)\s*{[\s\S]*\.cc-tabpanel\s*{[^}]*padding-bottom:\s*calc\(var\(--space-lg\) \+ env\(safe-area-inset-bottom, 0\) \+ var\(--standalone-bottom-gap\)\);/);
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)\s*{[\s\S]*\.cc-system-tab\s*{[^}]*gap:\s*var\(--space-lg\);/);
    expect(css).not.toMatch(/\.cc-system-tab\s*{[^}]*overflow-y:\s*auto;/s);
  });
});
