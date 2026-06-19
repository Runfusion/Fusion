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
}));

vi.mock("../../../api", () => ({
  fetchSystemStats: () => Promise.resolve(systemStatsFixture()),
  fetchGlobalSettings: () => Promise.resolve({ vitestAutoKillEnabled: true, vitestKillThresholdPct: 90 }),
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

function emptyGithubFixture() {
  return { filed: 0, fixed: 0, net: 0, daily: [], byRepo: [] };
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
    if (path.startsWith("/command-center/github")) return Promise.resolve(emptyGithubFixture());
    if (path.startsWith("/command-center/team")) return Promise.resolve(emptyTeamFixture());
    if (path.startsWith("/command-center/signals")) return Promise.resolve({ totalSignals: 0, open: 0, resolved: 0, mttr: { value: null, unavailable: true }, bySource: [], bySeverity: [] });
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
    assertScrollOwnerContract(overviewPanel);

    fireEvent.click(screen.getByTestId("command-center-tab-tokens"));
    const tokensPanel = screen.getByTestId("command-center-panel-tokens");
    expect(tokensPanel).toBe(screen.getByRole("tabpanel"));
    assertScrollOwnerContract(tokensPanel);

    fireEvent.click(screen.getByTestId("command-center-tab-team"));
    const teamPanel = screen.getByTestId("command-center-panel-team");
    expect(teamPanel).toBe(screen.getByRole("tabpanel"));
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
    expect(screen.getByTestId("command-center-live-tasks-in-progress")).toBeTruthy();
    assertScrollOwnerContract(screen.getByTestId("command-center-panel-overview"));
  });

  it("keeps the same flex-fill scroll-owner contract outside the mobile breakpoint", () => {
    mockMobileMatchMedia(false);
    render(<CommandCenter />);

    assertScrollOwnerContract(screen.getByTestId("command-center-panel-overview"));
  });
});
