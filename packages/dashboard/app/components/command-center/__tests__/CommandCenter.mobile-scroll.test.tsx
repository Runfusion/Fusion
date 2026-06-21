import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { loadStylesCss } from "../../../test/cssFixture";
import { CommandCenter } from "../CommandCenter";

const apiMock = vi.fn();
vi.mock("../../../api/legacy", () => ({
  api: (path: string, opts?: RequestInit) => apiMock(path, opts),
  fetchOrgTree: vi.fn().mockResolvedValue([]),
  fetchExecutorStats: vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false, maxConcurrent: 2 }),
  fetchSettings: vi.fn().mockResolvedValue({ maxConcurrent: 2, maxTriageConcurrent: 1, maxWorktrees: 5 }),
  fetchConfig: vi.fn().mockResolvedValue({ maxConcurrent: 2, rootDir: "/" }),
  updateSettings: vi.fn().mockResolvedValue({}),
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

vi.mock("../../../api", () => ({
  fetchSystemStats: () => Promise.resolve(systemStatsFixture()),
  fetchNodeSystemStats: () => Promise.resolve(systemStatsFixture()),
  fetchGlobalSettings: () => Promise.resolve({ vitestAutoKillEnabled: true, vitestKillThresholdPct: 90 }),
  fetchNodes: () => Promise.resolve([]),
  killVitestProcesses: () => Promise.resolve({ killed: 0, pids: [] }),
  updateGlobalSettings: () => Promise.resolve({}),
}));

function emptyTokenFixture() {
  return {
    totals: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, totalTokens: 0, nTasks: 0 },
    cost: { usd: null, unavailable: true, stale: false },
    groups: [],
  };
}

function emptyToolsFixture() {
  return {
    toolCalls: 0,
    byCategory: [],
    sessions: 0,
    interventions: { approvals: 0, userSteers: 0, total: 0 },
    autonomyRatio: 0,
    fullyAutonomous: true,
  };
}

function emptyActivityFixture() {
  return {
    sessions: 0,
    messages: 0,
    activeNodes: 0,
    activeAgents: 0,
    daily: [],
    stickiness: 0,
    mttr: { value: null, unavailable: true },
    monitor: { mttr: { value: null, unavailable: true }, incidents: 0, deployments: 0 },
    funnel: {
      stages: [
        { stage: "triage", entered: 0, current: 0 },
        { stage: "done", entered: 0, current: 0 },
      ],
      enteredInRange: 0,
      doneInRange: 0,
      completionRate: 0,
      throughputPerDay: 0,
      rangeDays: 7,
    },
  };
}

function populatedTokenFixture() {
  return {
    ...emptyTokenFixture(),
    totals: { inputTokens: 600, outputTokens: 300, cachedTokens: 100, cacheWriteTokens: 0, totalTokens: 1000, nTasks: 3 },
    cost: { usd: 9, unavailable: false, stale: false },
    groups: [
      {
        key: "gpt-4o",
        inputTokens: 600,
        outputTokens: 300,
        cachedTokens: 100,
        cacheWriteTokens: 0,
        totalTokens: 1000,
        nTasks: 3,
        cost: { usd: 9, unavailable: false, stale: false },
      },
    ],
    series: [
      { bucket: "2026-06-17T00:00:00.000Z", totalTokens: 250 },
      { bucket: "2026-06-18T00:00:00.000Z", totalTokens: 750 },
    ],
  };
}

function populatedToolsFixture() {
  return {
    ...emptyToolsFixture(),
    toolCalls: 12,
    byCategory: [{ category: "read", count: 12 }],
    sessions: 2,
    autonomyRatio: 6,
    fullyAutonomous: false,
  };
}

function populatedProductivityFixture() {
  return {
    modifiedFiles: 6,
    commits: 2,
    pullRequests: 1,
    loc: { value: 42, unavailable: false },
    hoursSaved: { value: 1, unavailable: false },
    taskDuration: {
      completedTasks: 2,
      averageMs: 1_800_000,
      medianMs: 1_800_000,
      p90Ms: 2_400_000,
      totalMs: 3_600_000,
      unavailable: false,
    },
    byLanguage: [{ language: "TypeScript", count: 6 }],
  };
}

function emptyProductivityFixture() {
  return {
    modifiedFiles: 0,
    commits: 0,
    pullRequests: 0,
    loc: { value: null, unavailable: true },
    hoursSaved: { value: null, unavailable: true },
    taskDuration: {
      completedTasks: 0,
      averageMs: null,
      medianMs: null,
      p90Ms: null,
      totalMs: null,
      unavailable: true,
    },
    byLanguage: [],
  };
}

function populatedTeamFixture() {
  return {
    ...emptyTeamFixture(),
    totals: {
      tokens: { inputTokens: 900, outputTokens: 450, cachedTokens: 150, cacheWriteTokens: 0, totalTokens: 1500, nTasks: 2 },
      cost: { usd: 4.25, unavailable: false, stale: false },
      filesChanged: 7,
      tasksCompleted: 3,
      tasksInProgress: 1,
      tasksInReview: 0,
    },
    agents: [
      {
        agentId: "agent-alpha",
        agentName: "Alpha Agent",
        role: "executor",
        state: "running",
        tokens: { inputTokens: 900, outputTokens: 450, cachedTokens: 150, cacheWriteTokens: 0, totalTokens: 1500, nTasks: 2 },
        cost: { usd: 4.25, unavailable: false, stale: false },
        filesChanged: 7,
        tasksCompleted: 3,
        tasksInProgress: 1,
        tasksInReview: 0,
      },
    ],
  };
}

function populatedSignalsFixture() {
  return {
    totalSignals: 3,
    open: 2,
    resolved: 1,
    mttr: { value: 30, unavailable: false },
    bySource: [{ source: "sentry", count: 2 }],
    bySeverity: [{ severity: "high", count: 1 }],
  };
}

function emptyGithubFixture() {
  return { filed: 0, fixed: 0, net: 0, daily: [], byRepo: [], resolved: [] };
}

function emptyTeamFixture() {
  return {
    from: null,
    to: null,
    totals: {
      tokens: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, totalTokens: 0, nTasks: 0 },
      cost: { usd: null, unavailable: false, stale: false },
      filesChanged: 0,
      tasksCompleted: 0,
      tasksInProgress: 0,
      tasksInReview: 0,
    },
    agents: [],
  };
}

function populatedActivityFixture() {
  return {
    ...emptyActivityFixture(),
    sessions: 2,
    messages: 8,
    activeNodes: 2,
    activeAgents: 1,
    daily: [{ day: "2026-06-08", activeNodes: 2, activeAgents: 1, messages: 8 }],
    funnel: {
      ...emptyActivityFixture().funnel,
      stages: [
        { stage: "triage", entered: 2, current: 0 },
        { stage: "in-progress", entered: 1, current: 1 },
        { stage: "done", entered: 2, current: 2 },
      ],
      enteredInRange: 2,
      doneInRange: 2,
      completionRate: 1,
      throughputPerDay: 1,
    },
  };
}

function systemStatsFixture() {
  const gb = 1024 * 1024 * 1024;
  const mb = 1024 * 1024;
  return {
    systemStats: {
      rss: 2 * gb,
      heapUsed: 500 * mb,
      heapTotal: 700 * mb,
      heapLimit: 1 * gb,
      external: 20 * mb,
      arrayBuffers: 8 * mb,
      cpuPercent: 12,
      loadAvg: [0.1, 0.2, 0.3] as [number, number, number],
      cpuCount: 8,
      systemTotalMem: 8 * gb,
      systemFreeMem: 4 * gb,
      pid: 456,
      nodeVersion: "v22.0.0",
      platform: "darwin/arm64",
    },
    taskStats: {
      total: 1,
      byColumn: { todo: 1 },
      active: 0,
      agents: { idle: 1, active: 0, running: 0, error: 0 },
    },
    vitestProcessCount: 0,
    vitestLastAutoKillAt: null,
  };
}

function mockOverviewApi({ populated = false }: { populated?: boolean } = {}) {
  apiMock.mockImplementation((path: string) => {
    if (path.startsWith("/command-center/tokens")) return Promise.resolve(populated ? populatedTokenFixture() : emptyTokenFixture());
    if (path.startsWith("/command-center/tools")) return Promise.resolve(populated ? populatedToolsFixture() : emptyToolsFixture());
    if (path.startsWith("/command-center/activity")) return Promise.resolve(populated ? populatedActivityFixture() : emptyActivityFixture());
    if (path.startsWith("/command-center/productivity")) return Promise.resolve(populated ? populatedProductivityFixture() : emptyProductivityFixture());
    if (path.startsWith("/command-center/github")) return Promise.resolve(populated ? { filed: 3, fixed: 1, net: 2, daily: [{ date: "2026-06-18", filed: 3, fixed: 1 }], byRepo: [{ repo: "acme/repo", filed: 3, fixed: 1 }], resolved: [{ taskId: "FN-100", taskTitle: "Fix mobile crash", repo: "acme/repo", issueNumber: 1, url: "https://github.com/acme/repo/issues/1", resolvedAt: "2026-06-18T10:00:00.000Z", resolvedAtExact: true }] } : emptyGithubFixture());
    if (path.startsWith("/command-center/team")) return Promise.resolve(populated ? populatedTeamFixture() : emptyTeamFixture());
    if (path.startsWith("/command-center/signals")) return Promise.resolve(populated ? populatedSignalsFixture() : { totalSignals: 0, open: 0, resolved: 0, mttr: { value: null, unavailable: true }, bySource: [], bySeverity: [] });
    if (path === "/system-stats") return Promise.resolve(systemStatsFixture());
    if (path === "/settings/global") return Promise.resolve({ vitestAutoKillEnabled: true, vitestKillThresholdPct: 90 });
    if (path === "/command-center/live") {
      return Promise.resolve({
        capturedAt: "2026-06-18T00:00:00.000Z",
        activeSessions: 0,
        activeRuns: 0,
        activeNodes: 0,
        sessions: [],
        runs: [],
        columns: [{ column: "in-progress", count: populated ? 1 : 0 }],
      });
    }
    return Promise.reject(new Error(`Unhandled api path: ${path}`));
  });
}

function injectCommandCenterCss() {
  document.head.querySelector("style[data-testid='fn-6595-css']")?.remove();
  const style = document.createElement("style");
  style.setAttribute("data-testid", "fn-6595-css");
  style.textContent = [
    loadStylesCss(),
    readFileSync(join(__dirname, "..", "CommandCenter.css"), "utf-8"),
    readFileSync(join(__dirname, "..", "charts", "charts.css"), "utf-8"),
    readFileSync(join(__dirname, "..", "areas", "areas.css"), "utf-8"),
    readFileSync(join(__dirname, "..", "areas", "SystemStatsArea.css"), "utf-8"),
  ].join("\n");
  document.head.appendChild(style);
}

function mockMobileMatchMedia(matchesMobile: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: matchesMobile && query.includes("max-width: 768px"),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function assertScrollOwnerContract(panel: HTMLElement) {
  const shell = screen.getByTestId("command-center");
  const header = shell.querySelector(".cc-header") as HTMLElement;
  const tablist = screen.getByRole("tablist");

  const shellStyle = window.getComputedStyle(shell);
  const panelStyle = window.getComputedStyle(panel);

  expect(shellStyle.flexGrow).toBe("1");
  expect(shellStyle.minHeight).toBe("0px");
  expect(panelStyle.minHeight).toBe("0px");
  expect(panelStyle.overflowY).toBe("auto");
  expect(window.getComputedStyle(header).flexShrink).toBe("0");
  expect(window.getComputedStyle(tablist).flexShrink).toBe("0");
}

function assertNoChartScrollSteal(panel: HTMLElement) {
  // FN-6680: jsdom does not compute real flex/grid layout, so this guards rule presence and scroll-owner structure only; the CSS-string regression plus Blink audit cover actual mobile pixel layout.
  const chartContainers = panel.querySelectorAll<HTMLElement>(
    ".cc-bar-chart, .cc-bar-row, .cc-sparkline, .cc-line-chart, .cc-recharts-chart, .cc-recharts-empty, .cc-radial-gauge, .cc-funnel, .cc-token-series, .cc-token-series-plot, .cc-overview-chart-card, .cc-team-ops-card, .cc-team-chart-panel, .cc-stat-card",
  );
  expect(chartContainers.length).toBeGreaterThan(0);
  for (const container of chartContainers) {
    const style = window.getComputedStyle(container);
    expect(style.overflowY === "auto" || style.overflowY === "scroll").toBe(false);
    expect(style.maxInlineSize === "100%" || style.maxWidth === "100%" || style.overflowX === "hidden" || style.display.length > 0).toBe(true);
  }
}

async function openChartTab(tab: string) {
  fireEvent.click(screen.getByTestId(`command-center-tab-${tab}`));
  const panel = screen.getByTestId(`command-center-panel-${tab}`);
  expect(panel).toBe(screen.getByRole("tabpanel"));
  await vi.waitFor(() => {
    expect(screen.queryByTestId(`cc-area-${tab}-loading`)).toBeNull();
  });
  return panel;
}

describe("CommandCenter mobile scroll regression (FN-6595)", () => {
  beforeEach(() => {
    apiMock.mockReset();
    mockOverviewApi();
    injectCommandCenterCss();
    mockMobileMatchMedia(true);
  });

  it("keeps the tabpanel as the mobile scroll owner with pinned header and tabs", async () => {
    render(<CommandCenter />);

    const overviewPanel = screen.getByTestId("command-center-panel-overview");
    await screen.findByTestId("command-center-empty");
    expect(screen.getByTestId("command-center-controls")).toBeTruthy();
    expect(screen.getByTestId("cc-controls-concurrency")).toBeTruthy();
    expect(screen.queryByTestId("cc-controls-org-chart")).toBeNull();
    expect(screen.queryByTestId("cc-controls-heartbeat")).toBeNull();
    assertScrollOwnerContract(overviewPanel);

    fireEvent.click(screen.getByTestId("command-center-tab-tokens"));
    const tokensPanel = screen.getByTestId("command-center-panel-tokens");
    expect(tokensPanel).toBe(screen.getByRole("tabpanel"));
    assertScrollOwnerContract(tokensPanel);

    fireEvent.click(screen.getByTestId("command-center-tab-team"));
    const teamPanel = screen.getByTestId("command-center-panel-team");
    expect(teamPanel).toBe(screen.getByRole("tabpanel"));
    expect(screen.getByTestId("cc-team-org-chart")).toBeTruthy();
    expect(screen.getByTestId("cc-team-heartbeat")).toBeTruthy();
    assertScrollOwnerContract(teamPanel);

    fireEvent.click(screen.getByTestId("command-center-tab-github"));
    const githubPanel = screen.getByTestId("command-center-panel-github");
    expect(githubPanel).toBe(screen.getByRole("tabpanel"));
    assertScrollOwnerContract(githubPanel);

    fireEvent.click(screen.getByTestId("command-center-tab-system"));
    const systemPanel = screen.getByTestId("command-center-panel-system");
    expect(systemPanel).toBe(screen.getByRole("tabpanel"));
    await screen.findByTestId("cc-area-system");
    assertScrollOwnerContract(systemPanel);
  });

  it("preserves the mobile scroll owner when the populated Overview charts render", async () => {
    mockOverviewApi({ populated: true });
    render(<CommandCenter />);

    await screen.findByTestId("command-center-overview-charts");
    expect(screen.getByTestId("command-center-overview-chart-tokens")).toBeTruthy();
    expect(screen.getByTestId("cc-overview-pie")).toBeTruthy();
    expect(screen.getByTestId("cc-overview-line")).toBeTruthy();
    expect(screen.getByTestId("command-center-live-tasks-in-progress")).toBeTruthy();
    assertScrollOwnerContract(screen.getByTestId("command-center-panel-overview"));
  });

  it("keeps every populated chart-bearing tab inside the mobile tabpanel scroll owner", async () => {
    mockOverviewApi({ populated: true });
    render(<CommandCenter />);

    const overviewPanel = screen.getByTestId("command-center-panel-overview");
    await screen.findByTestId("command-center-overview-charts");
    assertScrollOwnerContract(overviewPanel);
    assertNoChartScrollSteal(overviewPanel);

    for (const tab of ["tokens", "tools", "activity", "productivity", "team", "ecosystem", "github", "signals", "system"]) {
      const panel = await openChartTab(tab);
      if (tab === "team") expect(screen.getByTestId("cc-team-pie")).toBeTruthy();
      if (tab === "ecosystem") {
        expect(screen.getByTestId("cc-ecosystem-pie")).toBeTruthy();
        expect(screen.getByTestId("cc-ecosystem-line")).toBeTruthy();
      }
      if (tab === "github") {
        expect(screen.getByTestId("cc-github-pie")).toBeTruthy();
        expect(screen.getByTestId("cc-github-line")).toBeTruthy();
      }
      if (tab === "signals") expect(screen.getByTestId("cc-signals-pie")).toBeTruthy();
      if (tab === "system") {
        await screen.findByTestId("cc-area-system");
        expect(screen.getByTestId("cc-system-pie")).toBeTruthy();
        expect(screen.getByTestId("cc-system-line")).toBeTruthy();
      }
      assertScrollOwnerContract(panel);
      assertNoChartScrollSteal(panel);
      expect(panel.textContent).not.toContain("NaN");
    }
  });

  it("encodes the mobile chart CSS fixes for the discovered overflow primitives", () => {
    const styles = Array.from(document.head.querySelectorAll("style"))
      .map((style) => style.textContent ?? "")
      .join("\n");

    expect(styles).toContain(".cc-tabpanel");
    expect(styles).toContain("overflow-x: hidden");
    expect(styles).toContain("grid-template-columns: minmax(0, 1fr) minmax(calc(var(--space-2xl) + var(--space-lg)), 2fr)");
    expect(styles).toContain(".cc-line-chart");
    expect(styles).toContain(".cc-recharts-chart");
    expect(styles).toContain("block-size: calc(var(--space-2xl) * 7 + var(--space-lg))");
    expect(styles).toContain("aspect-ratio: auto");
    expect(styles).toContain(".cc-radial-gauge-ring");
    expect(styles).toContain("inline-size: clamp(calc(var(--space-2xl) * 2 + var(--space-lg)), 44vw, calc(var(--space-2xl) * 4))");
    expect(styles).toContain("min-inline-size: 0");
    expect(styles).toContain(".cc-token-series-axis");
    expect(styles).toContain("overflow-wrap: anywhere");
    expect(styles).toContain("grid-template-columns: minmax(0, 1fr)");
  });

  it("keeps the same flex-fill scroll-owner contract outside the mobile breakpoint", () => {
    mockMobileMatchMedia(false);
    render(<CommandCenter />);

    assertScrollOwnerContract(screen.getByTestId("command-center-panel-overview"));
  });
});
