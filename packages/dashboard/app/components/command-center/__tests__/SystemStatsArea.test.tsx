import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { SystemStatsArea } from "../areas/SystemStatsArea";

const mockFetchSystemStats = vi.fn();
const mockFetchGlobalSettings = vi.fn();
const mockKillVitestProcesses = vi.fn();
const mockUpdateGlobalSettings = vi.fn();

vi.mock("../../../api", () => ({
  fetchSystemStats: (...args: unknown[]) => mockFetchSystemStats(...args),
  fetchGlobalSettings: (...args: unknown[]) => mockFetchGlobalSettings(...args),
  killVitestProcesses: (...args: unknown[]) => mockKillVitestProcesses(...args),
  updateGlobalSettings: (...args: unknown[]) => mockUpdateGlobalSettings(...args),
}));

const gb = 1024 * 1024 * 1024;
const mb = 1024 * 1024;

type SystemStatsFixture = ReturnType<typeof baseStats>;
type SystemStatsFixtureOverrides = Partial<Omit<SystemStatsFixture, "systemStats" | "taskStats">> & {
  systemStats?: Partial<SystemStatsFixture["systemStats"]>;
  taskStats?: Partial<Omit<SystemStatsFixture["taskStats"], "agents">> & {
    agents?: Partial<SystemStatsFixture["taskStats"]["agents"]>;
  };
};

function sampleStats(overrides: SystemStatsFixtureOverrides = {}) {
  return {
    ...baseStats(),
    ...overrides,
    systemStats: {
      ...baseStats().systemStats,
      ...overrides.systemStats,
    },
    taskStats: {
      ...baseStats().taskStats,
      ...overrides.taskStats,
      agents: {
        ...baseStats().taskStats.agents,
        ...overrides.taskStats?.agents,
      },
    },
  };
}

function baseStats() {
  return {
    systemStats: {
      rss: 5 * gb,
      heapUsed: 900 * mb,
      heapTotal: 1200 * mb,
      heapLimit: 1000 * mb,
      external: 50 * mb,
      arrayBuffers: 20 * mb,
      cpuPercent: 68.4,
      loadAvg: [1.2, 0.8, 0.5] as [number, number, number],
      cpuCount: 8,
      systemTotalMem: 10 * gb,
      systemFreeMem: 1 * gb,
      pid: 12345,
      nodeVersion: "v22.0.0",
      platform: "darwin/arm64",
    },
    taskStats: {
      total: 6,
      byColumn: {
        triage: 1,
        todo: 2,
        "in-progress": 1,
        "in-review": 1,
        done: 1,
      },
      active: 2,
      agents: {
        idle: 1,
        active: 2,
        running: 0,
        error: 1,
      },
    },
    vitestProcessCount: 2,
    vitestLastAutoKillAt: "2026-04-27T12:00:00.000Z",
  };
}

describe("SystemStatsArea", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchSystemStats.mockResolvedValue(sampleStats());
    mockFetchGlobalSettings.mockResolvedValue({ vitestAutoKillEnabled: true, vitestKillThresholdPct: 90 });
    mockKillVitestProcesses.mockResolvedValue({ killed: 2, pids: [111, 222] });
    mockUpdateGlobalSettings.mockResolvedValue({});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders gauges, trends, bars, details, and Vitest controls for populated stats", async () => {
    render(<SystemStatsArea projectId="proj-1" />);

    await waitFor(() => {
      expect(mockFetchSystemStats).toHaveBeenCalledWith("proj-1");
      expect(mockFetchGlobalSettings).toHaveBeenCalledTimes(1);
    });

    expect(await screen.findByTestId("cc-area-system")).toBeInTheDocument();
    expect(screen.getByTestId("cc-system-cpu-gauge")).toHaveTextContent("68%");
    expect(screen.getByTestId("cc-system-mem-gauge")).toHaveTextContent("90%");
    expect(screen.getByTestId("cc-system-heap-gauge")).toHaveTextContent("90%");
    expect(screen.getByTestId("cc-system-cpu-trend")).toBeInTheDocument();
    expect(screen.getByTestId("cc-system-memory-trend")).toBeInTheDocument();
    expect(screen.getByTestId("cc-system-tasks-bar")).toHaveTextContent("in-progress");
    expect(screen.getByTestId("cc-system-agents-bar")).toHaveTextContent("active");
    expect(screen.getByTestId("cc-system-details-grid")).toHaveTextContent("RSS");
    expect(screen.getByTestId("cc-system-details-grid")).toHaveTextContent("5.00 GB");
    expect(screen.getByTestId("cc-system-vitest-controls")).toHaveTextContent("Vitest Processes");
  });

  it("renders the first-sample CPU state safely without NaN", async () => {
    mockFetchSystemStats.mockResolvedValue(sampleStats({ systemStats: { cpuPercent: null } }));

    render(<SystemStatsArea />);

    await screen.findByTestId("cc-area-system");
    expect(screen.getByTestId("cc-system-cpu-gauge")).toHaveTextContent("—");
    expect(screen.getByTestId("cc-system-cpu-gauge")).toHaveTextContent("Sampling");
    expect(screen.getByTestId("cc-area-system")).not.toHaveTextContent("NaN");
  });

  it("renders zero-value task and agent bars when collections are empty", async () => {
    mockFetchSystemStats.mockResolvedValue(sampleStats({
      taskStats: {
        total: 0,
        byColumn: {},
        active: 0,
        agents: { idle: 0, active: 0, running: 0, error: 0 },
      },
    }));

    render(<SystemStatsArea />);

    await screen.findByTestId("cc-area-system");
    const taskBars = screen.getByTestId("cc-system-tasks-bar");
    const agentBars = screen.getByTestId("cc-system-agents-bar");
    expect(within(taskBars).getByText("triage")).toBeInTheDocument();
    expect(within(agentBars).getByText("idle")).toBeInTheDocument();
    expect(within(taskBars).getAllByText("0").length).toBeGreaterThan(0);
    expect(within(agentBars).getAllByText("0").length).toBeGreaterThan(0);
    expect(screen.getByTestId("cc-area-system")).not.toHaveTextContent("NaN");
  });

  it("keeps the last stats visible when a later poll fails", async () => {
    vi.useFakeTimers();
    mockFetchSystemStats.mockResolvedValueOnce(sampleStats()).mockRejectedValueOnce(new Error("poll failed"));

    render(<SystemStatsArea />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("cc-area-system")).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });

    expect(screen.getByTestId("cc-area-system")).toHaveTextContent("Latest refresh failed: poll failed");
    expect(screen.getByTestId("cc-system-details-grid")).toHaveTextContent("RSS");
  });

  it("shows the initial error state when the first fetch fails", async () => {
    mockFetchSystemStats.mockRejectedValue(new Error("initial failure"));

    render(<SystemStatsArea />);

    expect(await screen.findByTestId("cc-area-system-error")).toHaveTextContent("initial failure");
  });

  it("confirms before killing Vitest and persists settings changes", async () => {
    render(<SystemStatsArea projectId="proj-1" />);
    await screen.findByTestId("cc-area-system");

    const killButton = screen.getByTestId("cc-system-kill-vitest");
    fireEvent.click(killButton);
    expect(killButton).toHaveTextContent("Confirm Kill?");
    fireEvent.click(killButton);

    await waitFor(() => {
      expect(mockKillVitestProcesses).toHaveBeenCalledWith("proj-1");
    });
    expect(await screen.findByText("Killed 2 processes")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Auto-kill vitest on memory pressure"));
    await waitFor(() => {
      expect(mockUpdateGlobalSettings).toHaveBeenCalledWith({ vitestAutoKillEnabled: false });
    });

    fireEvent.change(screen.getByLabelText("Kill threshold (%)"), { target: { value: "120" } });
    await waitFor(() => {
      expect(mockUpdateGlobalSettings).toHaveBeenCalledWith({ vitestKillThresholdPct: 99 });
    });
  });

  it("polls every five seconds and clears the interval on unmount", async () => {
    vi.useFakeTimers();
    const { unmount } = render(<SystemStatsArea />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("cc-area-system")).toBeInTheDocument();
    expect(mockFetchSystemStats).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    expect(mockFetchSystemStats).toHaveBeenCalledTimes(2);

    unmount();
    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    expect(mockFetchSystemStats).toHaveBeenCalledTimes(2);
  });
});
