import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { CommandCenter } from "../CommandCenter";
import { BUG_URL_MAX_ENCODED } from "../areas/SystemControlsArea";

const apiMock = vi.fn();
const mockFetchSystemInfo = vi.fn();
const mockFetchCurrentSystemRebuild = vi.fn();
const mockFetchSystemStats = vi.fn();
const mockFetchSystemLogs = vi.fn();
const mockFetchNodeSystemStats = vi.fn();
const mockFetchGlobalSettings = vi.fn();
const mockFetchNodes = vi.fn();

vi.mock("../../../api/legacy", () => ({
  fetchCodebaseMetrics: vi.fn().mockResolvedValue({ tokenEstimate: 0, sourceFileCount: 0, sourceByteCount: 0, diskBytes: 0, diskFileCount: 0, method: "local", truncated: false }),
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
  fetchSystemLogs: (...args: unknown[]) => mockFetchSystemLogs(...args),
  reloadAllSystemPlugins: vi.fn().mockResolvedValue({ ok: true }),
  requestSystemRestart: vi.fn().mockResolvedValue({ ok: true }),
  restartAllSystemAgents: vi.fn().mockResolvedValue({ ok: true }),
  restartSystemEngines: vi.fn().mockResolvedValue({ ok: true }),
  startSystemRebuild: vi.fn().mockResolvedValue({ id: "job-1", status: "running", kind: "rebuild", scope: "app", lines: [] }),
  startFnBinaryLinkLocal: vi.fn().mockResolvedValue({
    id: "job-fn-local",
    status: "running",
    kind: "fn-binary",
    scope: "link-local",
    lines: [],
  }),
  startFnBinaryUseGlobal: vi.fn().mockResolvedValue({
    id: "job-fn-global",
    status: "running",
    kind: "fn-binary",
    scope: "use-global",
    lines: [],
  }),
  refreshUpdateCheck: vi.fn().mockResolvedValue({
    currentVersion: "0.60.0",
    latestVersion: "0.60.0",
    updateAvailable: false,
  }),
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

function systemInfoFixture(overrides: Record<string, unknown> = {}) {
  return {
    pid: 12345,
    nodeVersion: "v22.0.0",
    platform: "darwin",
    arch: "arm64",
    sourceCheckout: true,
    supervised: true,
    restartSupported: true,
    rebuildSupported: true,
    fnBinaryLinkLocalSupported: true,
    fnBinaryUseGlobalSupported: true,
    engineAvailable: true,
    engineRestartSupported: true,
    agentRestartSupported: true,
    pluginReloadSupported: true,
    logsSupported: true,
    activeRebuild: null,
    ...overrides,
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
  const originalClipboard = navigator.clipboard;
  const originalExecCommand = document.execCommand;

  function mockClipboard(value: unknown) {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value,
    });
  }

  function mockExecCommand(result: boolean) {
    const execCommand = vi.fn().mockReturnValue(result);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });
    return execCommand;
  }

  async function renderSystemTab(addToast = vi.fn()) {
    render(<CommandCenter projectId="proj-1" addToast={addToast} />);
    fireEvent.click(screen.getByTestId("command-center-tab-system"));
    const diagnosticsCard = await screen.findByTestId("cc-syscontrol-diagnostics");
    return { addToast, diagnosticsCard };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.mockImplementation((path: string) => Promise.resolve(emptyOverviewResponse(path)));
    mockFetchSystemInfo.mockResolvedValue(systemInfoFixture());
    mockFetchSystemLogs.mockResolvedValue({
      entries: [{ timestamp: "2026-07-12T00:00:00.000Z", level: "info", message: "ready" }],
    });
    mockFetchCurrentSystemRebuild.mockResolvedValue({ job: null });
    mockFetchSystemStats.mockResolvedValue(systemStatsFixture());
    mockFetchNodeSystemStats.mockResolvedValue(systemStatsFixture());
    mockFetchGlobalSettings.mockResolvedValue({ vitestAutoKillEnabled: true, vitestKillThresholdPct: 90 });
    mockFetchNodes.mockResolvedValue([]);
  });

  afterEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: originalClipboard,
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: originalExecCommand,
    });
    document.body.innerHTML = "";
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

  it("copies diagnostics through the execCommand fallback when Clipboard API is unavailable", async () => {
    mockClipboard(undefined);
    const execCommand = mockExecCommand(true);
    const { addToast, diagnosticsCard } = await renderSystemTab();

    fireEvent.click(within(diagnosticsCard).getByRole("button", { name: "Copy" }));

    await waitFor(() => expect(execCommand).toHaveBeenCalledWith("copy"));
    expect(addToast).toHaveBeenCalledWith("Diagnostics copied to clipboard", "success");
    expect(addToast).not.toHaveBeenCalledWith(expect.stringContaining("writeText"), "error");
  });

  it("copies diagnostics through navigator.clipboard.writeText in secure contexts", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    mockClipboard({ writeText });
    const { addToast, diagnosticsCard } = await renderSystemTab();

    fireEvent.click(within(diagnosticsCard).getByRole("button", { name: "Copy" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]?.[0]).toContain('"recentLogs"');
    expect(addToast).toHaveBeenCalledWith("Diagnostics copied to clipboard", "success");
    expect(addToast).not.toHaveBeenCalledWith(expect.stringContaining("writeText"), "error");
  });

  it("shows a failure toast when diagnostics cannot be copied by either clipboard path", async () => {
    mockFetchSystemInfo.mockResolvedValue({ ...systemInfoFixture(), logsSupported: false });
    mockClipboard(undefined);
    const execCommand = mockExecCommand(false);
    const { addToast, diagnosticsCard } = await renderSystemTab();

    fireEvent.click(within(diagnosticsCard).getByRole("button", { name: "Copy" }));

    await waitFor(() => expect(execCommand).toHaveBeenCalledWith("copy"));
    expect(addToast).toHaveBeenCalledWith("Could not copy diagnostics to clipboard", "error");
    expect(addToast).not.toHaveBeenCalledWith("Diagnostics copied to clipboard", "success");
    expect(addToast).not.toHaveBeenCalledWith(expect.stringContaining("writeText"), "error");
  });

  it("embeds the full diagnostics bundle in the bug report body when the operator confirms", async () => {
    mockFetchSystemLogs.mockResolvedValue({
      entries: [{ timestamp: "2026-07-12T00:00:00.000Z", level: "error", message: "boom" }],
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    await renderSystemTab();

    const reportCard = await screen.findByTestId("cc-syscontrol-report-bug");
    fireEvent.click(within(reportCard).getByRole("button", { name: "Report" }));

    await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    const url = openSpy.mock.calls[0]?.[0] as string;
    const body = decodeURIComponent(url.split("?body=")[1] ?? "");
    expect(url).toContain("github.com");
    expect(url).toContain("/issues/new");
    expect(body).toContain("### What happened");
    expect(body).toContain("### Environment");
    expect(body).toContain("### Diagnostics");
    expect(body).toContain("<details><summary>Diagnostics</summary>");
    expect(body).toContain('"recentLogs"');
    expect(body).toContain("boom");
    expect(body).not.toContain("\u2026(truncated)");
    expect(url.length).toBeLessThanOrEqual(BUG_URL_MAX_ENCODED);

    confirmSpy.mockRestore();
    openSpy.mockRestore();
  });

  it("omits the diagnostics block from the bug report body when the operator declines", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    await renderSystemTab();

    const reportCard = await screen.findByTestId("cc-syscontrol-report-bug");
    fireEvent.click(within(reportCard).getByRole("button", { name: "Report" }));

    await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1));
    const url = openSpy.mock.calls[0]?.[0] as string;
    const body = decodeURIComponent(url.split("?body=")[1] ?? "");
    expect(body).toContain("### What happened");
    expect(body).toContain("### Environment");
    expect(body).not.toContain("### Diagnostics");

    confirmSpy.mockRestore();
    openSpy.mockRestore();
  });

  it("neutralizes embedded code fences in log messages so they cannot break out of the diagnostics fence", async () => {
    mockFetchSystemLogs.mockResolvedValue({
      entries: [{ timestamp: "2026-07-12T00:00:00.000Z", level: "error", message: "```oops``` breakout" }],
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    await renderSystemTab();

    const reportCard = await screen.findByTestId("cc-syscontrol-report-bug");
    fireEvent.click(within(reportCard).getByRole("button", { name: "Report" }));

    await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1));
    const url = openSpy.mock.calls[0]?.[0] as string;
    const body = decodeURIComponent(url.split("?body=")[1] ?? "");
    // The fenced JSON block should contain no raw ``` other than the fence delimiters themselves.
    const jsonBlockMatch = body.match(/```json\n([\s\S]*?)\n```/);
    expect(jsonBlockMatch).not.toBeNull();
    expect(jsonBlockMatch?.[1]).not.toContain("```");
    expect(jsonBlockMatch?.[1]).toContain("'''oops''' breakout");

    confirmSpy.mockRestore();
    openSpy.mockRestore();
  });

  it("truncates an oversized diagnostics bundle against the encoded GitHub URL ceiling", async () => {
    mockFetchSystemLogs.mockResolvedValue({
      entries: Array.from({ length: 100 }, (_, i) => ({
        timestamp: "2026-07-12T00:00:00.000Z",
        level: "error" as const,
        message: `error-line-${i}-{\"quoted\":\"${"x".repeat(100)}\",\"nested\":{\"value\":\"${"y".repeat(100)}\"}}`,
      })),
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    await renderSystemTab();

    const reportCard = await screen.findByTestId("cc-syscontrol-report-bug");
    fireEvent.click(within(reportCard).getByRole("button", { name: "Report" }));

    await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1));
    const url = openSpy.mock.calls[0]?.[0] as string;
    const body = decodeURIComponent(url.split("?body=")[1] ?? "");
    expect(url.length).toBeLessThanOrEqual(BUG_URL_MAX_ENCODED);
    expect(body).toContain("\u2026(truncated)");

    confirmSpy.mockRestore();
    openSpy.mockRestore();
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

  /*
  FNXC:SystemPanelFnBinary 2026-07-15-09:54:
  Source/dev hosts expose build-and-link-local; packaged hosts hide it. Use-global
  and check-for-updates stay available, and starting a build job surfaces the
  shared log viewer.
  */
  it("shows fn binary and update controls for a source checkout and scrolls job output into view", async () => {
    const scrollIntoView = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;

    render(<CommandCenter projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("command-center-tab-system"));

    const linkLocal = await screen.findByTestId("cc-syscontrol-fn-link-local");
    const useGlobal = screen.getByTestId("cc-syscontrol-fn-use-global");
    const checkUpdates = screen.getByTestId("cc-syscontrol-check-updates");
    expect(linkLocal).toBeInTheDocument();
    expect(useGlobal).toBeInTheDocument();
    expect(checkUpdates).toBeInTheDocument();

    fireEvent.click(within(linkLocal).getByRole("button", { name: "Build & link" }));

    await waitFor(() => {
      expect(screen.getByTestId("cc-system-rebuild-output")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalled();
    });

    Element.prototype.scrollIntoView = original;
  });

  it("hides build-and-link-local when the host is not a source checkout", async () => {
    mockFetchSystemInfo.mockResolvedValue(
      systemInfoFixture({
        rebuildSupported: false,
        fnBinaryLinkLocalSupported: false,
        sourceWorkspaceRoot: undefined,
      }),
    );

    render(<CommandCenter projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("command-center-tab-system"));

    await screen.findByTestId("cc-system-controls");
    expect(screen.queryByTestId("cc-syscontrol-fn-link-local")).not.toBeInTheDocument();
    expect(screen.getByTestId("cc-syscontrol-fn-use-global")).toBeInTheDocument();
    expect(screen.getByTestId("cc-syscontrol-check-updates")).toBeInTheDocument();
  });
});
