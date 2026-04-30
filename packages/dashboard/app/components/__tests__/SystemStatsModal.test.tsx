import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SystemStatsModal } from "../SystemStatsModal";

vi.mock("lucide-react", () => ({
  Monitor: (props: { className?: string }) => <span data-testid="icon-monitor" {...props} />,
  RefreshCw: (props: { className?: string }) => <span data-testid="icon-refresh" {...props} />,
  ShieldAlert: (props: { className?: string }) => <span data-testid="icon-shield-alert" {...props} />,
  Skull: (props: { className?: string }) => <span data-testid="icon-skull" {...props} />,
  X: (props: { className?: string }) => <span data-testid="icon-x" {...props} />,
}));

const mockFetchSystemStats = vi.fn();
const mockFetchGlobalSettings = vi.fn();
const mockKillVitestProcesses = vi.fn();
const mockUpdateGlobalSettings = vi.fn();

vi.mock("../../api", () => ({
  fetchSystemStats: (...args: unknown[]) => mockFetchSystemStats(...args),
  fetchGlobalSettings: (...args: unknown[]) => mockFetchGlobalSettings(...args),
  killVitestProcesses: (...args: unknown[]) => mockKillVitestProcesses(...args),
  updateGlobalSettings: (...args: unknown[]) => mockUpdateGlobalSettings(...args),
}));

const sampleStats = {
  systemStats: {
    rss: 5 * 1024 * 1024 * 1024,
    heapUsed: 900 * 1024 * 1024,
    heapTotal: 1200 * 1024 * 1024,
    heapLimit: 1000 * 1024 * 1024,
    external: 50 * 1024 * 1024,
    arrayBuffers: 20 * 1024 * 1024,
    cpuPercent: null,
    loadAvg: [1.2, 0.8, 0.5] as [number, number, number],
    cpuCount: 8,
    systemTotalMem: 10 * 1024 * 1024 * 1024,
    systemFreeMem: 1024 * 1024 * 1024,
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
      archived: 0,
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

describe("SystemStatsModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchSystemStats.mockResolvedValue(sampleStats);
    mockFetchGlobalSettings.mockResolvedValue({
      vitestAutoKillEnabled: true,
      vitestKillThresholdPct: 90,
    });
    mockKillVitestProcesses.mockResolvedValue({ killed: 2, pids: [111, 222] });
    mockUpdateGlobalSettings.mockResolvedValue({});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows loading state while initial stats are fetched", async () => {
    mockFetchSystemStats.mockReturnValue(new Promise(() => undefined));

    render(<SystemStatsModal isOpen={true} onClose={vi.fn()} />);

    expect(await screen.findByText("Loading system stats…")).toBeDefined();
  });

  it("renders fetched metrics across all sections", async () => {
    render(<SystemStatsModal isOpen={true} onClose={vi.fn()} projectId="proj-1" />);

    await waitFor(() => {
      expect(mockFetchSystemStats).toHaveBeenCalledWith("proj-1");
      expect(mockFetchGlobalSettings).toHaveBeenCalledTimes(1);
    });

    expect(screen.getByText("System Stats")).toBeDefined();
    expect(await screen.findByText("Process")).toBeDefined();
    expect(screen.getByText("CPU & Load")).toBeDefined();
    expect(screen.getByText("System")).toBeDefined();
    expect(screen.getByText("Tasks")).toBeDefined();
    expect(screen.getByText("Agents")).toBeDefined();
    expect(screen.getByText("Vitest Controls")).toBeDefined();

    expect(screen.getByText("5.00 GB")).toBeDefined();
    expect(screen.getByText("900 MB")).toBeDefined();
    expect(screen.getByText("9.00 GB")).toBeDefined();
    expect(screen.getByText("90.0% of 10.00 GB")).toBeDefined();

    const memoryUsageProgress = screen.getByRole("progressbar", {
      name: "System memory used: 90.0% (9.00 GB of 10.00 GB)",
    });
    expect(memoryUsageProgress).toHaveAttribute("aria-valuenow", "90");
    expect(memoryUsageProgress).toHaveAttribute("aria-valuemin", "0");
    expect(memoryUsageProgress).toHaveAttribute("aria-valuemax", "100");
    expect(memoryUsageProgress.className).toContain("system-stats-modal__memory-progress-track--critical");
    const criticalFill = memoryUsageProgress.querySelector(".system-stats-modal__memory-progress-fill");
    expect(criticalFill?.className).toContain("system-stats-modal__memory-progress-fill--critical");

    expect(screen.getByText("1.20 0.80 0.50")).toBeDefined();
    expect(screen.getByText("Vitest Processes")).toBeDefined();
    expect(screen.getByText(/Last auto-kill:/)).toBeDefined();

    const criticalValues = document.querySelectorAll(".system-stats-modal__value--critical");
    expect(criticalValues.length).toBeGreaterThan(0);
  });

  it("keeps memory value and bar severity aligned for warning thresholds", async () => {
    mockFetchSystemStats.mockResolvedValue({
      ...sampleStats,
      systemStats: {
        ...sampleStats.systemStats,
        systemFreeMem: 2 * 1024 * 1024 * 1024,
      },
    });

    render(<SystemStatsModal isOpen={true} onClose={vi.fn()} />);

    const memoryUsageProgress = await screen.findByRole("progressbar", {
      name: "System memory used: 80.0% (8.00 GB of 10.00 GB)",
    });
    expect(memoryUsageProgress.className).toContain("system-stats-modal__memory-progress-track--warning");
    const warningFill = memoryUsageProgress.querySelector(".system-stats-modal__memory-progress-fill");
    expect(warningFill?.className).toContain("system-stats-modal__memory-progress-fill--warning");

    const memoryValue = screen.getByText("8.00 GB");
    expect(memoryValue.className).toContain("system-stats-modal__value--warning");
  });

  it("shows refresh button icon when the modal is open", async () => {
    render(<SystemStatsModal isOpen={true} onClose={vi.fn()} />);

    const refreshButton = await screen.findByRole("button", { name: "Refresh system stats" });
    const refreshIcon = screen.getByTestId("icon-refresh");

    expect(refreshButton).toBeDefined();
    expect(refreshIcon).toBeDefined();
    expect(refreshButton.contains(refreshIcon)).toBe(true);
  });

  it("shows auto-refresh indicator when stats are loaded", async () => {
    render(<SystemStatsModal isOpen={true} onClose={vi.fn()} />);

    expect(await screen.findByText("Auto-refresh · 5s")).toBeDefined();
    expect(screen.getByText(/Updated|Waiting for first update/)).toBeDefined();
  });

  it("applies spinning class to refresh icon during background refresh", async () => {
    vi.useFakeTimers();

    let callCount = 0;
    let resolveBackgroundRefresh: (() => void) | undefined;
    const backgroundRefreshPromise = new Promise<typeof sampleStats>((resolve) => {
      resolveBackgroundRefresh = () => resolve(sampleStats);
    });

    mockFetchSystemStats.mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.resolve(sampleStats);
      }
      return backgroundRefreshPromise;
    });

    render(<SystemStatsModal isOpen={true} onClose={vi.fn()} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("Auto-refresh · 5s")).toBeDefined();

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByTestId("icon-refresh").className).toContain("system-stats-modal__refresh--spinning");

    resolveBackgroundRefresh?.();
    await act(async () => {
      await Promise.resolve();
    });
  });

  it("shows error state when initial fetch fails", async () => {
    mockFetchSystemStats.mockRejectedValue(new Error("stats unavailable"));

    render(<SystemStatsModal isOpen={true} onClose={vi.fn()} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("stats unavailable");
  });

  it("requires a confirmation click before killing vitest processes", async () => {
    render(<SystemStatsModal isOpen={true} onClose={vi.fn()} projectId="proj-1" />);

    const killButton = await screen.findByRole("button", { name: /Kill Vitest Processes/i });

    fireEvent.click(killButton);
    expect(mockKillVitestProcesses).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Confirm Kill\?/i })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /Confirm Kill\?/i }));

    await waitFor(() => {
      expect(mockKillVitestProcesses).toHaveBeenCalledWith("proj-1");
      expect(screen.getByText("Killed 2 processes")).toBeDefined();
    });
  });

  it("persists auto-kill toggle changes", async () => {
    render(<SystemStatsModal isOpen={true} onClose={vi.fn()} />);

    const toggle = (await screen.findByLabelText("Auto-kill vitest on memory pressure")) as HTMLInputElement;
    expect(toggle.checked).toBe(true);

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(mockUpdateGlobalSettings).toHaveBeenCalledWith({ vitestAutoKillEnabled: false });
    });
  });

  it("clamps threshold input to allowed range", async () => {
    render(<SystemStatsModal isOpen={true} onClose={vi.fn()} />);

    const thresholdInput = (await screen.findByLabelText("Kill threshold (%)")) as HTMLInputElement;

    fireEvent.change(thresholdInput, { target: { value: "20" } });
    await waitFor(() => {
      expect(mockUpdateGlobalSettings).toHaveBeenCalledWith({ vitestKillThresholdPct: 50 });
    });

    fireEvent.change(thresholdInput, { target: { value: "120" } });
    await waitFor(() => {
      expect(mockUpdateGlobalSettings).toHaveBeenCalledWith({ vitestKillThresholdPct: 99 });
    });
  });

  it("persists threshold changes from the slider control", async () => {
    render(<SystemStatsModal isOpen={true} onClose={vi.fn()} />);

    const thresholdSlider = (await screen.findByLabelText("Kill threshold slider (%)")) as HTMLInputElement;
    fireEvent.change(thresholdSlider, { target: { value: "95" } });

    await waitFor(() => {
      expect(mockUpdateGlobalSettings).toHaveBeenCalledWith({ vitestKillThresholdPct: 95 });
    });
  });

  it("shows fallback text when last auto-kill timestamp is unavailable", async () => {
    mockFetchSystemStats.mockResolvedValue({
      ...sampleStats,
      vitestLastAutoKillAt: null,
    });

    render(<SystemStatsModal isOpen={true} onClose={vi.fn()} />);

    expect(await screen.findByText("Last auto-kill: Not yet")).toBeDefined();
  });

  it("refreshes every 5 seconds while open and stops when closed", async () => {
    vi.useFakeTimers();

    const { rerender } = render(<SystemStatsModal isOpen={true} onClose={vi.fn()} />);

    await act(async () => {
      await Promise.resolve();
    });
    expect(mockFetchSystemStats).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(mockFetchSystemStats).toHaveBeenCalledTimes(2);

    rerender(<SystemStatsModal isOpen={false} onClose={vi.fn()} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(mockFetchSystemStats).toHaveBeenCalledTimes(2);
  });
});
