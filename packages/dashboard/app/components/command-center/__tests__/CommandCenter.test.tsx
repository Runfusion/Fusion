/*
FNXC:CommandCenter 2026-06-17-00:00:
Command Center Overview must consume the same analytics endpoints as the detail tabs. These tests reproduce the prior always-empty landing page, then pin loading-before-empty, range re-derivation, and best-effort Signals behavior so Overview cannot regress into shell placeholders again.
*/
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within, waitFor, act } from "@testing-library/react";
import { CommandCenter } from "../CommandCenter";

const apiMock = vi.fn();
vi.mock("../../../api/legacy", () => ({
  api: (path: string, opts?: RequestInit) => apiMock(path, opts),
  fetchCodebaseMetrics: vi.fn().mockResolvedValue({ tokenEstimate: 42_000, sourceFileCount: 10, sourceByteCount: 100, diskBytes: 1024, diskFileCount: 12, method: "local", truncated: false }),
  withProjectId: (path: string, projectId?: string) =>
    projectId ? `${path}${path.includes("?") ? "&" : "?"}projectId=${encodeURIComponent(projectId)}` : path,
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
  killVitestProcesses: () => Promise.resolve({ killed: 0, pids: [] }),
  updateGlobalSettings: () => Promise.resolve({}),
}));

vi.mock("../../NodesView", () => ({
  NodesView: ({ addToast }: { addToast: (message: string, type?: "success" | "error") => void }) => (
    <section data-testid="nodes-view">
      <button type="button" data-testid="nodes-view-toast-probe" onClick={() => addToast("Nodes tab toast", "success")}>
        Nodes toast probe
      </button>
    </section>
  ),
}));

function providerIconIn(element: HTMLElement, provider: string): Element | null {
  return element.querySelector(`.provider-icon[data-provider="${provider}"]`);
}

function makeTokenGroup(key: string | null, totalTokens: number) {
  const inputTokens = Math.round(totalTokens * 0.6);
  const outputTokens = Math.round(totalTokens * 0.3);
  const cachedTokens = totalTokens - inputTokens - outputTokens;
  return {
    key,
    inputTokens,
    outputTokens,
    cachedTokens,
    cacheWriteTokens: 0,
    totalTokens,
    nTasks: 1,
    cost: { usd: key === null ? null : totalTokens / 1_000, unavailable: key === null, stale: false },
  };
}

function tokenFixture(totalTokens = 1_500) {
  return {
    from: "2026-06-08",
    to: null,
    groupBy: "model",
    totals: {
      inputTokens: Math.round(totalTokens * 0.6),
      outputTokens: Math.round(totalTokens * 0.3),
      cachedTokens: Math.round(totalTokens * 0.1),
      cacheWriteTokens: 0,
      totalTokens,
      nTasks: totalTokens > 0 ? 5 : 0,
    },
    cost: totalTokens > 0 ? { usd: 12.5, unavailable: false, stale: false } : { usd: null, unavailable: true, stale: false },
    groups:
      totalTokens > 0
        ? [
            {
              key: "gpt-4o",
              inputTokens: 600,
              outputTokens: 300,
              cachedTokens: 100,
              cacheWriteTokens: 0,
              totalTokens: 900,
              nTasks: 3,
              cost: { usd: 9.0, unavailable: false, stale: false },
            },
            {
              key: "claude-sonnet",
              inputTokens: 400,
              outputTokens: 200,
              cachedTokens: 100,
              cacheWriteTokens: 0,
              totalTokens: 600,
              nTasks: 2,
              cost: { usd: 3.5, unavailable: false, stale: false },
            },
          ]
        : [],
  };
}

function glmOverviewTokenFixture() {
  const groups = [
    makeTokenGroup("glm-5.1", 1_400),
    makeTokenGroup("gpt-4o", 1_200),
    makeTokenGroup("claude-sonnet", 1_000),
  ];
  const totals = groups.reduce(
    (acc, group) => ({
      inputTokens: acc.inputTokens + group.inputTokens,
      outputTokens: acc.outputTokens + group.outputTokens,
      cachedTokens: acc.cachedTokens + group.cachedTokens,
      cacheWriteTokens: acc.cacheWriteTokens + group.cacheWriteTokens,
      totalTokens: acc.totalTokens + group.totalTokens,
      nTasks: acc.nTasks + group.nTasks,
    }),
    { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, totalTokens: 0, nTasks: 0 },
  );

  return {
    ...tokenFixture(totals.totalTokens),
    totals,
    groups,
  };
}

function manyModelTokenFixture() {
  const groups = [
    makeTokenGroup("model-01", 2_000),
    makeTokenGroup("model-02", 1_900),
    makeTokenGroup("model-03", 1_800),
    makeTokenGroup("model-04", 1_700),
    makeTokenGroup("model-05", 1_600),
    makeTokenGroup("model-06", 1_500),
    makeTokenGroup("model-07", 1_400),
    makeTokenGroup("model-08", 1_300),
    makeTokenGroup("model-09", 1_200),
    makeTokenGroup(null, 1_100),
    makeTokenGroup("(unknown)", 1_000),
  ];
  const totals = groups.reduce(
    (acc, group) => ({
      inputTokens: acc.inputTokens + group.inputTokens,
      outputTokens: acc.outputTokens + group.outputTokens,
      cachedTokens: acc.cachedTokens + group.cachedTokens,
      cacheWriteTokens: acc.cacheWriteTokens + group.cacheWriteTokens,
      totalTokens: acc.totalTokens + group.totalTokens,
      nTasks: acc.nTasks + group.nTasks,
    }),
    { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, totalTokens: 0, nTasks: 0 },
  );

  return {
    ...tokenFixture(totals.totalTokens),
    totals,
    cost: { usd: null, unavailable: true, stale: false },
    groups,
  };
}

function toolsFixture(toolCalls = 30) {
  return {
    from: "2026-06-08",
    to: null,
    toolCalls,
    byCategory: toolCalls > 0 ? [{ category: "read", count: toolCalls }] : [],
    sessions: toolCalls > 0 ? 3 : 0,
    interventions: { approvals: toolCalls > 0 ? 2 : 0, userSteers: toolCalls > 0 ? 1 : 0, total: toolCalls > 0 ? 3 : 0 },
    autonomyRatio: toolCalls > 0 ? 10 : 0,
    fullyAutonomous: toolCalls === 0,
  };
}

function activityFixture(
  overrides: Partial<Record<"sessions" | "messages" | "activeNodes" | "activeAgents" | "agentRuns" | "doneInRange" | "inProgress", number>> = {},
) {
  const sessions = overrides.sessions ?? 4;
  const messages = overrides.messages ?? 18;
  const activeNodes = overrides.activeNodes ?? 3;
  const activeAgents = overrides.activeAgents ?? 2;
  const agentRuns = overrides.agentRuns ?? 8;
  const doneInRange = overrides.doneInRange ?? 7;
  const inProgress = overrides.inProgress ?? 3;
  return {
    from: "2026-06-08",
    to: null,
    sessions,
    messages,
    activeNodes,
    activeAgents,
    agentRuns: { total: agentRuns, active: agentRuns > 0 ? 1 : 0, completed: Math.max(0, agentRuns - 2), failed: agentRuns > 1 ? 1 : 0 },
    daily: messages > 0 || agentRuns > 0 ? [{ day: "2026-06-08", activeNodes, activeAgents, messages, agentRuns }] : [],
    stickiness: activeAgents > 0 ? 0.5 : 0,
    mttr: { value: null, unavailable: true },
    monitor: { mttr: { value: null, unavailable: true }, incidents: 0, deployments: 0 },
    funnel: {
      stages: [
        { stage: "triage", entered: doneInRange, current: 0 },
        { stage: "in-progress", entered: inProgress, current: inProgress },
        { stage: "done", entered: doneInRange, current: doneInRange },
      ],
      enteredInRange: doneInRange,
      doneInRange,
      completionRate: doneInRange > 0 ? 1 : 0,
      throughputPerDay: doneInRange > 0 ? 1 : 0,
      rangeDays: 7,
    },
  };
}

const emptyActivityFixture = () =>
  activityFixture({ sessions: 0, messages: 0, activeNodes: 0, activeAgents: 0, agentRuns: 0, doneInRange: 0 });

function githubFixture(filed = 0, fixed = 0) {
  return {
    from: "2026-06-08",
    to: null,
    filed,
    fixed,
    net: filed - fixed,
    daily: filed || fixed ? [{ date: "2026-06-08", filed, fixed }] : [],
    byRepo: filed || fixed ? [{ repo: "acme/alpha", filed, fixed }] : [],
    resolved: [],
  };
}

function teamFixture(agents: unknown[] = [
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
  {
    agentId: "agent-beta",
    agentName: "Beta Agent",
    role: "reviewer",
    state: "idle",
    tokens: { inputTokens: 100, outputTokens: 50, cachedTokens: 0, cacheWriteTokens: 0, totalTokens: 150, nTasks: 1 },
    cost: { usd: null, unavailable: true, stale: false },
    filesChanged: 2,
    tasksCompleted: 1,
    tasksInProgress: 0,
    tasksInReview: 1,
  },
]) {
  return {
    from: "2026-06-08",
    to: null,
    totals: {
      tokens: { inputTokens: 1000, outputTokens: 500, cachedTokens: 150, cacheWriteTokens: 0, totalTokens: 1650, nTasks: 3 },
      cost: { usd: 4.25, unavailable: true, stale: false },
      filesChanged: 9,
      tasksCompleted: 4,
      tasksInProgress: 1,
      tasksInReview: 1,
    },
    agents,
  };
}

function workflowFixture(workflows: unknown[] = [
  {
    workflowId: "builtin:coding",
    workflowName: "Coding",
    isBuiltin: true,
    tokens: { inputTokens: 900, outputTokens: 450, cachedTokens: 150, cacheWriteTokens: 0, totalTokens: 1500, nTasks: 2 },
    cost: { usd: 4.25, unavailable: false, stale: false },
    filesChanged: 7,
    tasksCompleted: 3,
    tasksInProgress: 1,
    tasksInReview: 0,
  },
]) {
  return {
    from: "2026-06-08",
    to: null,
    totals: {
      tokens: { inputTokens: 900, outputTokens: 450, cachedTokens: 150, cacheWriteTokens: 0, totalTokens: 1500, nTasks: 2 },
      cost: { usd: 4.25, unavailable: false, stale: false },
      filesChanged: 7,
      tasksCompleted: 3,
      tasksInProgress: 1,
      tasksInReview: 0,
    },
    workflows,
  };
}

function signalsFixture(open = 2) {
  return {
    totalSignals: open,
    open,
    resolved: 0,
    mttr: { value: null, unavailable: true },
    bySource: [],
    bySeverity: [],
  };
}

function liveFixture(columns: Array<{ column: string; count: number }> = [{ column: "in-progress", count: 3 }]) {
  return {
    capturedAt: "2026-06-18T00:00:00.000Z",
    activeSessions: 0,
    activeRuns: 0,
    activeNodes: 0,
    sessions: [],
    runs: [],
    columns,
  };
}

function reliabilityFixture() {
  return {
    windowDays: 7,
    generatedAt: "2026-06-19T00:00:00.000Z",
    resetAt: null,
    headline: { inReviewFailureRate7d: 0.25 },
    perDay: [
      {
        date: "2026-06-19",
        tasksEnteredInReview: 4,
        tasksBouncedToInProgress: 1,
        postMergeAuditFailures: { block: 0, warn: 0, off: 0 },
        fileScopeInvariantFailures: 0,
        recoverAlreadyMergedReviewTasksRecoveries: 0,
        hasSamples: true,
      },
    ],
    duration: { p50Ms: 60_000, p95Ms: 120_000, sampleCount: 2 },
    mergeAttempts: { mean: 1.5, max: 2, histogram: { "1": 1, "2": 1 } },
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

function mockOverviewApi({
  tokens = tokenFixture(),
  tools = toolsFixture(),
  activity = activityFixture(),
  github = githubFixture(),
  team = teamFixture([]),
  workflows = workflowFixture([]),
  signals = signalsFixture(),
  live = liveFixture(),
}: {
  tokens?: unknown;
  tools?: unknown;
  activity?: unknown;
  github?: unknown;
  team?: unknown;
  workflows?: unknown;
  signals?: unknown;
  live?: unknown;
} = {}) {
  apiMock.mockImplementation((path: string) => {
    if (path.startsWith("/command-center/tokens")) return Promise.resolve(tokens);
    if (path.startsWith("/command-center/tools")) return Promise.resolve(tools);
    if (path.startsWith("/command-center/activity")) return Promise.resolve(activity);
    if (path.startsWith("/command-center/github")) return Promise.resolve(github);
    if (path.startsWith("/command-center/team")) return team instanceof Error ? Promise.reject(team) : Promise.resolve(team);
    if (path.startsWith("/command-center/workflows")) {
      return workflows instanceof Error ? Promise.reject(workflows) : Promise.resolve(workflows);
    }
    if (path.startsWith("/command-center/signals")) {
      return signals instanceof Error ? Promise.reject(signals) : Promise.resolve(signals);
    }
    if (path === "/command-center/live") {
      return live instanceof Error ? Promise.reject(live) : Promise.resolve(live);
    }
    if (path === "/system-stats") return Promise.resolve(systemStatsFixture());
    if (path === "/settings/global") return Promise.resolve({ vitestAutoKillEnabled: true, vitestKillThresholdPct: 90 });
    return Promise.reject(new Error(`Unhandled api path: ${path}`));
  });
}

function mockEmptyOverviewApi() {
  mockOverviewApi({ tokens: tokenFixture(0), tools: toolsFixture(0), activity: emptyActivityFixture(), signals: signalsFixture(0), live: liveFixture([{ column: "in-progress", count: 0 }]) });
}

function expectProjectMetricCards() {
  expect(screen.getByTestId("cc-overview-codebase-tokens")).toBeInTheDocument();
  expect(screen.getByTestId("cc-overview-disk-size")).toBeInTheDocument();
}

function statValue(testId: string) {
  return within(screen.getByTestId(testId)).getByText((content, element) =>
    element?.classList.contains("cc-stat-value") === true && content.length > 0,
  ).textContent;
}

function liveMetricValue(testId = "command-center-live-tasks-in-progress") {
  return screen.getByTestId(testId).querySelector(".cc-live-metric-value")?.textContent ?? null;
}

function expectThroughputLastAfter(...precedingTestIds: string[]) {
  const throughput = screen.getByTestId("command-center-throughput");
  expect(throughput.parentElement?.classList.contains("cc-overview")).toBe(true);
  expect(throughput.parentElement?.lastElementChild).toBe(throughput);

  for (const testId of precedingTestIds) {
    const precedingNode = screen.getByTestId(testId);
    expect(Boolean(precedingNode.compareDocumentPosition(throughput) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  }
}

function expectDailyActivityLineBeforeTrend() {
  const lineCard = screen.getByTestId("cc-overview-line");
  const trendCard = screen.getByTestId("command-center-overview-chart-activity");
  expect(Boolean(lineCard.compareDocumentPosition(trendCard) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
}

beforeEach(() => {
  apiMock.mockReset();
  mockEmptyOverviewApi();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("CommandCenter shell", () => {
  it("renders with the Overview tab active by default", () => {
    render(
      <CommandCenter
        projectId="project-a"
        colorTheme="default"
        themeMode="dark"
        onColorThemeChange={vi.fn()}
        onThemeModeChange={vi.fn()}
      />,
    );
    const overviewTab = screen.getByTestId("command-center-tab-overview");
    expect(overviewTab.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("command-center-panel-overview")).toBeTruthy();
    expect(screen.getByTestId("command-center-controls")).toBeTruthy();
    expect(screen.queryByTestId("cc-controls-org-chart")).toBeNull();
    expect(screen.queryByTestId("cc-controls-heartbeat")).toBeNull();
  });

  it("renders throughput last while the Overview branch is loading", () => {
    mockEmptyOverviewApi();
    render(<CommandCenter />);
    expect(screen.getByTestId("command-center-overview-loading")).toBeTruthy();
    expectProjectMetricCards();
    expect(screen.getByTestId("cc-overview-codebase-tokens")).toHaveTextContent("—");
    expectThroughputLastAfter("command-center-overview-loading");
  });

  it("renders the documented empty state when there is no data (no crash)", async () => {
    mockEmptyOverviewApi();
    render(<CommandCenter />);
    expect(screen.queryByTestId("command-center-empty")).toBeNull();
    expect(screen.getByTestId("command-center-overview-loading")).toBeTruthy();
    expect(screen.queryByTestId("command-center-overview-charts")).toBeNull();
    expect(screen.queryByTestId("cc-overview-pie")).toBeNull();
    expect(screen.queryByTestId("cc-overview-line")).toBeNull();
    expect(screen.queryByTestId("command-center-overview-chart-activity")).toBeNull();
    await screen.findByTestId("command-center-empty");
    expectProjectMetricCards();
    expectThroughputLastAfter("command-center-empty");
    // FNXC:CommandCenter 2026-06-23-01:30: Sessions/Active-nodes cards were removed — neither renders in the empty-data branch (the empty state has no stat grid at all).
    expect(screen.queryByTestId("command-center-stat-sessions")).toBeNull();
    expect(screen.queryByTestId("command-center-stat-nodes")).toBeNull();
    expect(screen.queryByTestId("command-center-overview-charts")).toBeNull();
    expect(screen.queryByTestId("cc-overview-pie")).toBeNull();
    expect(screen.queryByTestId("cc-overview-line")).toBeNull();
    expect(screen.queryByTestId("command-center-overview-chart-activity")).toBeNull();
  });

  /*
  FNXC:CommandCenter 2026-06-22-18:00:
  The "AI Engine" panel (with "View Board"/"View Agents" shortcuts) lives in controlsSection and must render in every Overview branch — including the empty-data state — and its buttons must call onChangeView. Previously the shortcuts rendered only inside the populated return, so loading/empty/error states had no navigation.
  */
  it("renders the AI Engine panel with working shortcuts even in the empty-data state", async () => {
    mockEmptyOverviewApi();
    const onChangeView = vi.fn();
    render(<CommandCenter onChangeView={onChangeView} />);

    // Panel + buttons present immediately (controlsSection renders in the loading branch).
    expect(screen.getByTestId("command-center-engine-panel")).toBeTruthy();
    const board = screen.getByRole("button", { name: "View Board" });
    const agents = screen.getByRole("button", { name: "View Agents" });

    // Still present after the empty-data branch resolves.
    await screen.findByTestId("command-center-empty");
    expect(screen.getByTestId("command-center-engine-panel")).toBeTruthy();

    fireEvent.click(board);
    expect(onChangeView).toHaveBeenCalledWith("board");
    fireEvent.click(agents);
    expect(onChangeView).toHaveBeenCalledWith("agents");
  });

  it("renders run-only task-worker activity in Overview agent stats and charts", async () => {
    mockOverviewApi({
      tokens: tokenFixture(0),
      tools: toolsFixture(0),
      activity: activityFixture({ sessions: 0, messages: 0, activeNodes: 0, activeAgents: 1, agentRuns: 5, doneInRange: 0 }),
      signals: signalsFixture(0),
      live: liveFixture([{ column: "in-progress", count: 0 }]),
    });
    render(<CommandCenter />);

    await waitFor(() => expect(screen.queryByTestId("command-center-empty")).toBeNull());
    expect(statValue("command-center-stat-agentRuns")).toBe("5");
    expect(screen.getByTestId("command-center-live-agents-working").textContent).toContain("1");
    expect(screen.getByTestId("cc-overview-line")).toBeTruthy();
    expect(screen.getByTestId("command-center-overview-chart-activity")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Daily activity line" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Daily activity trend" })).toBeTruthy();
  });

  /*
  FNXC:CommandCenter 2026-06-23-01:30:
  The "Active nodes" and "Sessions" Overview stat cards were removed. These cases preserve the prior session-data-state coverage (sessions present / other activity keeps Overview populated / sessions omitted) but now assert the Sessions (and Active nodes) cards are absent across those states, while Overview stays populated and other cards still render.
  */
  it("omits the Sessions and Active nodes cards even when sessions exist", async () => {
    mockOverviewApi({
      tokens: tokenFixture(0),
      tools: toolsFixture(0),
      activity: activityFixture({ sessions: 3, messages: 0, activeNodes: 2, activeAgents: 0, agentRuns: 1, doneInRange: 0 }),
      signals: signalsFixture(0),
      live: liveFixture([{ column: "in-progress", count: 0 }]),
    });
    render(<CommandCenter />);

    await screen.findByTestId("command-center-stat-agentRuns");
    expect(screen.queryByTestId("command-center-stat-sessions")).toBeNull();
    expect(screen.queryByTestId("command-center-stat-nodes")).toBeNull();
    expect(screen.queryByTestId("command-center-empty")).toBeNull();
  });

  it("omits the Sessions and Active nodes cards when other activity keeps Overview populated", async () => {
    mockOverviewApi({
      tokens: tokenFixture(0),
      tools: toolsFixture(0),
      activity: activityFixture({ sessions: 0, messages: 4, activeNodes: 0, activeAgents: 0, agentRuns: 1, doneInRange: 0 }),
      signals: signalsFixture(0),
      live: liveFixture([{ column: "in-progress", count: 0 }]),
    });
    render(<CommandCenter />);

    await screen.findByTestId("command-center-stat-agentRuns");
    expect(screen.queryByTestId("command-center-stat-sessions")).toBeNull();
    expect(screen.queryByTestId("command-center-stat-nodes")).toBeNull();
    expect(screen.queryByTestId("command-center-empty")).toBeNull();
  });

  it("omits the Sessions card when activity payload omits sessions", async () => {
    const { sessions: _omitted, ...activityWithoutSessions } = activityFixture({
      messages: 5,
      activeNodes: 0,
      activeAgents: 0,
      agentRuns: 0,
      doneInRange: 0,
    });
    mockOverviewApi({
      tokens: tokenFixture(0),
      tools: toolsFixture(0),
      activity: activityWithoutSessions,
      signals: signalsFixture(0),
      live: liveFixture([{ column: "in-progress", count: 0 }]),
    });
    render(<CommandCenter />);

    await screen.findByTestId("command-center-stat-tokens");
    expect(screen.queryByTestId("command-center-stat-sessions")).toBeNull();
  });

  it("renders live Overview headline values when analytics data exists", async () => {
    mockOverviewApi();
    render(<CommandCenter />);

    await waitFor(() => expect(screen.queryByTestId("command-center-empty")).toBeNull());
    await screen.findByTestId("command-center-stat-tokens");

    expect(statValue("command-center-stat-tokens")).toBe("1,500");
    expect(screen.getByTestId("command-center-stat-tokens").textContent).toContain("$12.50");
    expect(statValue("command-center-stat-autonomy")).toBe("10.0:1");
    // FNXC:CommandCenter 2026-06-23-01:30: The "Active nodes" and "Sessions" Overview stat cards were removed; assert they no longer render.
    expect(screen.queryByTestId("command-center-stat-nodes")).toBeNull();
    expect(screen.queryByTestId("command-center-stat-sessions")).toBeNull();
    expect(statValue("command-center-stat-agentRuns")).toBe("8");
    expect(statValue("command-center-stat-tasksDone")).toBe("7");
    expect(statValue("command-center-stat-models")).toBe("2");
    expect(statValue("command-center-stat-signals")).toBe("2");
    expect(screen.getByTestId("command-center-live-strip")).toBeTruthy();
    expect(screen.getByTestId("command-center-live-snapshot")).toBeTruthy();
    await waitFor(() => expect(liveMetricValue()).toBe("3"));
    expect(screen.getByTestId("command-center-live-agents-working").textContent).toContain("2");
    expect(screen.getByTestId("command-center-live-tokens").textContent).toContain("1,500");
    expect(screen.getByTestId("command-center-live-open-signals").textContent).toContain("2");
    expect(screen.getByTestId("command-center-throughput-trend")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Recent activity throughput trend" })).toBeTruthy();
    expect(screen.getByTestId("command-center-throughput")).toBeTruthy();

    const charts = screen.getByTestId("command-center-overview-charts");
    expect(within(charts).getByText("Tokens by model")).toBeTruthy();
    const overviewTokenChart = screen.getByTestId("command-center-overview-chart-tokens");
    expect(within(overviewTokenChart).getByText("gpt-4o")).toBeTruthy();
    expect(providerIconIn(overviewTokenChart, "openai")).toBeTruthy();
    expect(providerIconIn(overviewTokenChart, "anthropic")).toBeTruthy();
    expect(screen.getByRole("img", { name: "openai gpt-4o: 900" })).toBeTruthy();
    expect(within(screen.getByTestId("command-center-overview-chart-tools")).getByText("read")).toBeTruthy();
    expect(screen.getByTestId("cc-overview-pie")).toBeTruthy();
    expect(providerIconIn(screen.getByTestId("cc-overview-pie"), "openai")).toBeNull();
    expect(providerIconIn(screen.getByTestId("cc-overview-pie"), "anthropic")).toBeNull();
    expect(screen.getByTestId("cc-overview-line")).toBeTruthy();
    expectDailyActivityLineBeforeTrend();
    expect(screen.getByRole("img", { name: "Token share by model" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Daily activity line" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Daily activity trend" })).toBeTruthy();
    expectThroughputLastAfter("command-center-stat-tokens", "command-center-live-strip", "command-center-overview-charts");
  });

  it("keeps Overview token charts as an accurate top-model summary sourced from the same cap", async () => {
    mockOverviewApi({ tokens: manyModelTokenFixture() });
    render(<CommandCenter />);

    const overviewTokenChart = await screen.findByTestId("command-center-overview-chart-tokens");
    const overviewPie = screen.getByTestId("cc-overview-pie");
    expect(screen.getByTestId("command-center-stat-models")).toHaveTextContent("11");
    expect(within(overviewTokenChart).getByText("Top model token consumers in this range")).toBeTruthy();
    expect(within(overviewPie).getByText("Top model token share in this range")).toBeTruthy();

    // FNXC:CommandCenter 2026-06-27-09:55: Overview intentionally remains top-8; this locks the design decision that the bar and pie summarize the same leading models while the unique-model card still exposes the full analytics count.
    for (const label of ["model-01", "model-02", "model-03", "model-04", "model-05", "model-06", "model-07", "model-08"]) {
      expect(within(overviewTokenChart).getByText(label)).toBeTruthy();
      expect(within(overviewPie).getByText(label)).toBeTruthy();
    }
    for (const label of ["model-09", "(unknown)"]) {
      expect(within(overviewTokenChart).queryByText(label)).toBeNull();
      expect(within(overviewPie).queryByText(label)).toBeNull();
    }
  });

  it("renders standalone GLM model rows with the Z.ai icon in Overview token bars", async () => {
    mockOverviewApi({ tokens: glmOverviewTokenFixture() });
    render(<CommandCenter />);

    const overviewTokenChart = await screen.findByTestId("command-center-overview-chart-tokens");
    const glmBarLabel = within(overviewTokenChart).getByText("glm-5.1").closest(".cc-bar-label");
    expect(glmBarLabel).toBeTruthy();
    expect(providerIconIn(overviewTokenChart, "zai")).toBeTruthy();
    expect(providerIconIn(overviewTokenChart, "openai")).toBeTruthy();
    expect(providerIconIn(overviewTokenChart, "anthropic")).toBeTruthy();
    expect(screen.getByRole("img", { name: "zai glm-5.1: 1,400" })).toBeTruthy();
    expect(providerIconIn(screen.getByTestId("cc-overview-pie"), "zai")).toBeNull();
  });

  it("renders Overview providerless and unknown model icons without touching pie labels", async () => {
    mockOverviewApi({
      tokens: {
        ...tokenFixture(),
        groups: [
          { ...tokenFixture().groups[0], key: "legacy-model", totalTokens: 50, nTasks: 1 },
          { ...tokenFixture().groups[1], key: null, totalTokens: 25, nTasks: 1 },
        ],
      },
    });
    render(<CommandCenter />);

    const overviewTokenChart = await screen.findByTestId("command-center-overview-chart-tokens");
    expect(providerIconIn(overviewTokenChart, "legacy-model")).toBeTruthy();
    expect(providerIconIn(overviewTokenChart, "")).toBeTruthy();
    expect(screen.getByRole("img", { name: "legacy-model: 50" })).toBeTruthy();
    expect(within(overviewTokenChart).getByText("legacy-model").closest(".cc-bar-label")).toBeTruthy();
    expect(within(overviewTokenChart).getByText("(unknown)").closest(".cc-bar-label")).toBeTruthy();
    expect(providerIconIn(screen.getByTestId("cc-overview-pie"), "legacy-model")).toBeNull();
  });

  it("renders large comma-grouped token totals unchanged in Overview stat surfaces", async () => {
    mockOverviewApi({ tokens: tokenFixture(1_234_567_890) });
    render(<CommandCenter />);

    await screen.findByTestId("command-center-stat-tokens");
    expect(statValue("command-center-stat-tokens")).toBe("1,234,567,890");
    expect(liveMetricValue("command-center-live-tokens")).toBe("1,234,567,890");
  });

  it("shows the priced subtotal in Overview when some usage has unknown pricing", async () => {
    mockOverviewApi({
      tokens: {
        ...tokenFixture(1_500),
        cost: { usd: 911.39004125, unavailable: true, stale: false },
      },
    });
    render(<CommandCenter />);

    expect(await screen.findByTestId("command-center-stat-tokens")).toHaveTextContent("$911.39+");
  });

  it("live-polls token totals for the Overview card, live strip, and model charts", async () => {
    vi.useFakeTimers();
    let resolvePoll: ((value: ReturnType<typeof tokenFixture>) => void) | null = null;
    apiMock.mockImplementation((path: string) => {
      if (path.startsWith("/command-center/tokens")) {
        if (apiMock.mock.calls.filter(([calledPath]) => typeof calledPath === "string" && calledPath.startsWith("/command-center/tokens")).length === 1) {
          return Promise.resolve(tokenFixture(1_500));
        }
        return new Promise((resolve) => {
          resolvePoll = resolve;
        });
      }
      if (path.startsWith("/command-center/tools")) return Promise.resolve(toolsFixture());
      if (path.startsWith("/command-center/activity")) return Promise.resolve(activityFixture());
      if (path.startsWith("/command-center/github")) return Promise.resolve(githubFixture());
      if (path.startsWith("/command-center/signals")) return Promise.resolve(signalsFixture(2));
      if (path === "/command-center/live") return Promise.resolve(liveFixture([{ column: "in-progress", count: 3 }]));
      return Promise.reject(new Error(`Unhandled api path: ${path}`));
    });

    render(<CommandCenter />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(statValue("command-center-stat-tokens")).toBe("1,500");
    expect(screen.getByTestId("command-center-live-tokens").textContent).toContain("1,500");
    expect(within(screen.getByTestId("command-center-overview-chart-tokens")).getByText("900")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
    });
    expect(resolvePoll).not.toBeNull();
    expect(screen.queryByTestId("command-center-overview-loading")).toBeNull();
    expect(statValue("command-center-stat-tokens")).toBe("1,500");

    await act(async () => {
      resolvePoll?.({
        ...tokenFixture(1_900),
        groups: [
          { ...tokenFixture().groups[0], totalTokens: 1_100, inputTokens: 700, outputTokens: 300 },
          { ...tokenFixture().groups[1], totalTokens: 800, inputTokens: 500, outputTokens: 200 },
        ],
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(statValue("command-center-stat-tokens")).toBe("1,900");
    expect(screen.getByTestId("command-center-live-tokens").textContent).toContain("1,900");
    expect(within(screen.getByTestId("command-center-overview-chart-tokens")).getByText("1,100")).toBeTruthy();
  });

  it("updates mounted Overview token surfaces from empty token data to populated poll data", async () => {
    vi.useFakeTimers();
    let resolvePoll: ((value: ReturnType<typeof tokenFixture>) => void) | null = null;
    apiMock.mockImplementation((path: string) => {
      if (path.startsWith("/command-center/tokens")) {
        if (apiMock.mock.calls.filter(([calledPath]) => typeof calledPath === "string" && calledPath.startsWith("/command-center/tokens")).length === 1) {
          return Promise.resolve(tokenFixture(0));
        }
        return new Promise((resolve) => {
          resolvePoll = resolve;
        });
      }
      if (path.startsWith("/command-center/tools")) return Promise.resolve(toolsFixture(0));
      if (path.startsWith("/command-center/activity")) return Promise.resolve(emptyActivityFixture());
      if (path.startsWith("/command-center/github")) return Promise.resolve(githubFixture());
      if (path.startsWith("/command-center/signals")) return Promise.resolve(signalsFixture(0));
      if (path === "/command-center/live") return Promise.resolve(liveFixture([{ column: "in-progress", count: 0 }]));
      return Promise.reject(new Error(`Unhandled api path: ${path}`));
    });

    render(<CommandCenter />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("command-center-empty")).toBeTruthy();
    expect(screen.queryByTestId("command-center-stat-tokens")).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
    });
    expect(resolvePoll).not.toBeNull();
    expect(screen.getByTestId("command-center-empty")).toBeTruthy();

    await act(async () => {
      resolvePoll?.(tokenFixture(1_500));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(statValue("command-center-stat-tokens")).toBe("1,500");
    expect(screen.getByTestId("command-center-live-tokens").textContent).toContain("1,500");
    expect(screen.getByTestId("command-center-overview-chart-tokens")).toBeTruthy();
  });

  it("sources live tasks in progress from current column counts instead of funnel entered", async () => {
    mockOverviewApi({
      activity: activityFixture({ inProgress: 12 }),
      live: liveFixture([{ column: "in-progress", count: 2 }]),
    });
    render(<CommandCenter />);

    await screen.findByTestId("command-center-live-tasks-in-progress");
    await waitFor(() => expect(liveMetricValue()).toBe("2"));
    expect(liveMetricValue()).not.toBe("12");
  });

  it("renders zero when the live in-progress column count is zero", async () => {
    mockOverviewApi({ live: liveFixture([{ column: "in-progress", count: 0 }]) });
    render(<CommandCenter />);

    await screen.findByTestId("command-center-live-tasks-in-progress");
    await waitFor(() => expect(liveMetricValue()).toBe("0"));
  });

  it("defaults to zero when the live snapshot omits the in-progress column", async () => {
    mockOverviewApi({ live: liveFixture([{ column: "todo", count: 5 }]) });
    render(<CommandCenter />);

    await screen.findByTestId("command-center-live-tasks-in-progress");
    await waitFor(() => expect(liveMetricValue()).toBe("0"));
  });

  it("renders a deterministic placeholder while the live snapshot is pending", async () => {
    const live = new Promise(() => undefined);
    mockOverviewApi({ live });
    render(<CommandCenter />);

    await screen.findByTestId("command-center-live-tasks-in-progress");
    expect(liveMetricValue()).toBe("—");
  });

  it("falls back without crashing when the live snapshot fetch fails", async () => {
    mockOverviewApi({ live: new Error("live failed") });
    render(<CommandCenter />);

    await screen.findByTestId("command-center-live-tasks-in-progress");
    await waitFor(() => expect(liveMetricValue()).toBe("0"));
    expect(screen.queryByTestId("command-center-overview-error")).toBeNull();
  });

  it("keeps the live in-progress count range-independent while tasks done follows the range", async () => {
    apiMock.mockImplementation((path: string) => {
      const allTime = typeof path === "string" && !path.includes("from=");
      if (path.startsWith("/command-center/tokens")) return Promise.resolve(tokenFixture());
      if (path.startsWith("/command-center/tools")) return Promise.resolve(toolsFixture());
      if (path.startsWith("/command-center/activity")) {
        return Promise.resolve(activityFixture({ doneInRange: allTime ? 21 : 7, inProgress: allTime ? 99 : 12 }));
      }
      if (path.startsWith("/command-center/signals")) return Promise.resolve(signalsFixture(2));
      if (path.startsWith("/command-center/github")) return Promise.resolve(githubFixture());
      if (path === "/command-center/live") return Promise.resolve(liveFixture([{ column: "in-progress", count: 4 }]));
      return Promise.reject(new Error(`Unhandled api path: ${path}`));
    });
    render(<CommandCenter />);

    await screen.findByTestId("command-center-stat-tasksDone");
    await waitFor(() => expect(liveMetricValue()).toBe("4"));
    expect(statValue("command-center-stat-tasksDone")).toBe("7");

    fireEvent.click(screen.getByTestId("cc-date-range-trigger"));
    fireEvent.click(screen.getByTestId("cc-date-range-preset-all"));

    await waitFor(() => expect(statValue("command-center-stat-tasksDone")).toBe("21"));
    expect(liveMetricValue()).toBe("4");
  });

  it("renders cards for partially populated analytics instead of the empty state", async () => {
    mockOverviewApi({ tokens: tokenFixture(0), tools: toolsFixture(0), activity: activityFixture({ sessions: 0, messages: 0, activeNodes: 1, activeAgents: 0, agentRuns: 0, doneInRange: 0 }), signals: signalsFixture(0) });
    render(<CommandCenter />);

    // FNXC:CommandCenter 2026-06-23-01:30: activeNodes>0 still keeps Overview populated (hasActivityData) even though the Active-nodes card was removed; assert via a remaining card and that the removed card is absent.
    await screen.findByTestId("command-center-stat-tokens");
    expect(screen.queryByTestId("command-center-empty")).toBeNull();
    expect(statValue("command-center-stat-tokens")).toBe("0");
    expect(liveMetricValue("command-center-live-tokens")).toBe("0");
    expect(screen.queryByTestId("command-center-stat-nodes")).toBeNull();
    expect(screen.queryByTestId("command-center-overview-charts")).toBeNull();
    expect(screen.queryByTestId("command-center-overview-loading")).toBeNull();
    expect(screen.queryByTestId("command-center-overview-error")).toBeNull();
  });

  it("renders no empty chart shell when some populated sources have no chart rows", async () => {
    mockOverviewApi({ tokens: tokenFixture(), tools: toolsFixture(0), activity: activityFixture(), signals: signalsFixture(0) });
    render(<CommandCenter />);

    await screen.findByTestId("command-center-overview-charts");
    expect(screen.getByTestId("command-center-overview-chart-tokens")).toBeTruthy();
    expect(screen.getByTestId("cc-overview-pie")).toBeTruthy();
    expect(screen.queryByTestId("command-center-overview-chart-tools")).toBeNull();
    expect(screen.getByTestId("command-center-overview-chart-activity")).toBeTruthy();
    expect(screen.getByTestId("cc-overview-line")).toBeTruthy();
  });

  it("handles empty, undefined, single-item, and zero chart data without NaN output", async () => {
    const tokensWithSingleZeroGroup = {
      ...tokenFixture(0),
      groups: [
        {
          key: "idle-model",
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          nTasks: 0,
          cost: { usd: null, unavailable: true, stale: false },
        },
      ],
    };
    const toolsWithoutCategories = { ...toolsFixture(1), byCategory: undefined };
    const activityWithSingleZeroDay = {
      ...activityFixture({ sessions: 0, messages: 0, activeNodes: 1, activeAgents: 0, doneInRange: 0 }),
      daily: [{ day: "2026-06-08", activeNodes: 0, activeAgents: 0, messages: 0 }],
    };
    mockOverviewApi({
      tokens: tokensWithSingleZeroGroup,
      tools: toolsWithoutCategories,
      activity: activityWithSingleZeroDay,
      signals: signalsFixture(0),
    });
    render(<CommandCenter />);

    await screen.findByTestId("command-center-overview-charts");
    expect(screen.getByTestId("command-center-overview-chart-tokens").textContent).toContain("idle-model");
    expect(screen.getByTestId("cc-overview-pie")).toBeTruthy();
    expect(screen.queryByTestId("command-center-overview-chart-tools")).toBeNull();
    expect(screen.getByTestId("command-center-overview-chart-activity")).toBeTruthy();
    expect(screen.getByTestId("cc-overview-line")).toBeTruthy();
    expect(screen.getByTestId("cc-overview-pie").textContent).not.toContain("NaN");
    expect(screen.getByTestId("cc-overview-line").textContent).not.toContain("NaN");
  });

  it("keeps Overview populated when the signals endpoint is missing", async () => {
    mockOverviewApi({ signals: new Error("API returned HTML instead of JSON (404)") });
    render(<CommandCenter />);

    await screen.findByTestId("command-center-stat-signals");
    expect(screen.queryByTestId("command-center-empty")).toBeNull();
    expect(screen.queryByTestId("command-center-overview-error")).toBeNull();
    expect(statValue("command-center-stat-signals")).toBe("—");
  });

  it("surfaces a settled core-source error without staying in loading", async () => {
    apiMock.mockImplementation((path: string) => {
      if (path.startsWith("/command-center/tokens")) return Promise.reject(new Error("tokens failed"));
      if (path.startsWith("/command-center/tools")) return Promise.resolve(toolsFixture(0));
      if (path.startsWith("/command-center/activity")) return Promise.resolve(emptyActivityFixture());
      if (path.startsWith("/command-center/signals")) return Promise.resolve(signalsFixture(0));
      if (path === "/command-center/live") return Promise.resolve(liveFixture([{ column: "in-progress", count: 0 }]));
      return Promise.reject(new Error(`Unhandled api path: ${path}`));
    });
    render(<CommandCenter />);

    await screen.findByTestId("command-center-overview-error");
    expectProjectMetricCards();
    expectThroughputLastAfter("command-center-overview-error");
    expect(screen.getByTestId("command-center-overview-error").textContent).toContain("tokens failed");
    expect(screen.queryByTestId("command-center-overview-loading")).toBeNull();
    expect(screen.queryByTestId("command-center-empty")).toBeNull();
    expect(screen.queryByTestId("command-center-overview-charts")).toBeNull();
    expect(screen.queryByTestId("cc-overview-pie")).toBeNull();
    expect(screen.queryByTestId("cc-overview-line")).toBeNull();
  });

  it("re-fetches and re-derives the Overview empty state when the range changes", async () => {
    apiMock.mockImplementation((path: string) => {
      const populated = path.includes("from=");
      if (path.startsWith("/command-center/tokens")) return Promise.resolve(populated ? tokenFixture() : tokenFixture(0));
      if (path.startsWith("/command-center/tools")) return Promise.resolve(populated ? toolsFixture() : toolsFixture(0));
      if (path.startsWith("/command-center/activity")) return Promise.resolve(populated ? activityFixture() : emptyActivityFixture());
      if (path.startsWith("/command-center/signals")) return Promise.resolve(populated ? signalsFixture() : signalsFixture(0));
      if (path.startsWith("/command-center/github")) return Promise.resolve(githubFixture());
      if (path === "/command-center/live") return Promise.resolve(liveFixture([{ column: "in-progress", count: populated ? 3 : 0 }]));
      return Promise.reject(new Error(`Unhandled api path: ${path}`));
    });
    render(<CommandCenter />);

    await screen.findByTestId("command-center-stat-tokens");
    expect(screen.queryByTestId("command-center-empty")).toBeNull();

    fireEvent.click(screen.getByTestId("cc-date-range-trigger"));
    fireEvent.click(screen.getByTestId("cc-date-range-preset-all"));

    await screen.findByTestId("command-center-empty");
    expect(screen.queryByTestId("command-center-stat-tokens")).toBeNull();
    // FNXC:CommandCenter 2026-06-27-09:55: The All-time preset now serializes an explicit upper bound, so range-change coverage should assert the tools endpoint refetched for the open-lower-bound range rather than requiring the legacy bare path.
    expect(
      apiMock.mock.calls.some(
        ([path]) => typeof path === "string" && path.startsWith("/command-center/tools?to=") && !path.includes("from="),
      ),
    ).toBe(true);
  });

  it("exposes the ARIA tabs pattern (tablist + tabs + tabpanel)", () => {
    render(<CommandCenter />);
    const tablist = screen.getByRole("tablist");
    const tabs = within(tablist).getAllByRole("tab");
    // Overview, Tokens, Tools, Activity, Productivity, Team, Workflows, Ecosystem, GitHub, GitLab, Signals, System, Plugins, Reliability, Mission Control.
    expect(tabs.length).toBe(15);
    expect(screen.queryByTestId("command-center-tab-nodes")).toBeNull();
    // roving tabindex: exactly one tab is focusable.
    const focusable = tabs.filter((tab) => tab.getAttribute("tabindex") === "0");
    expect(focusable.length).toBe(1);
    expect(screen.getByRole("tabpanel")).toBeTruthy();
  });

  it("activates a tab on click and updates aria-selected", () => {
    render(<CommandCenter />);
    fireEvent.click(screen.getByTestId("command-center-tab-tokens"));
    expect(screen.getByTestId("command-center-tab-tokens").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("command-center-tab-overview").getAttribute("aria-selected")).toBe("false");
    expect(screen.getByTestId("command-center-panel-tokens")).toBeTruthy();
  });

  it("renders run-only task-worker activity in the Activity tab graphs", async () => {
    mockOverviewApi({
      tokens: tokenFixture(0),
      tools: toolsFixture(0),
      activity: activityFixture({ sessions: 0, messages: 0, activeNodes: 0, activeAgents: 1, agentRuns: 1, doneInRange: 0 }),
      signals: signalsFixture(0),
      live: liveFixture([{ column: "in-progress", count: 0 }]),
    });
    render(<CommandCenter />);

    fireEvent.click(screen.getByTestId("command-center-tab-activity"));

    await screen.findByTestId("cc-area-activity");
    expect(screen.getByTestId("cc-activity-agents").textContent).toContain("1");
    expect(screen.getByTestId("cc-activity-agent-runs").textContent).toContain("1");
    expect(screen.getByTestId("cc-activity-line")).toBeTruthy();
    expect(screen.getByTestId("cc-activity-line-agents")).toBeTruthy();
    expect(screen.getByTestId("cc-activity-line-throughput")).toBeTruthy();
    expect(screen.getByTestId("cc-activity-agent-runs-sparkline")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Active agents / day" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Throughput / day" })).toBeTruthy();
  });

  it("renders and routes the System tab exactly once", async () => {
    mockOverviewApi();
    render(<CommandCenter />);
    expect(screen.getAllByTestId("command-center-tab-system")).toHaveLength(1);

    fireEvent.click(screen.getByTestId("command-center-tab-system"));
    expect(screen.getByTestId("command-center-tab-system").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("command-center-panel-system")).toBeTruthy();
    await screen.findByTestId("cc-area-system");
    expect(screen.getByTestId("cc-system-cpu-gauge")).toBeTruthy();
  });

  it("renders and routes the Nodes tab when the nodes feature is enabled", () => {
    const addToast = vi.fn();
    render(<CommandCenter addToast={addToast} nodesEnabled={true} />);
    expect(screen.getAllByTestId("command-center-tab-nodes")).toHaveLength(1);

    fireEvent.click(screen.getByTestId("command-center-tab-nodes"));
    expect(screen.getByTestId("command-center-tab-nodes").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("command-center-panel-nodes")).toBeTruthy();
    expect(screen.getByTestId("nodes-view")).toBeTruthy();

    fireEvent.click(screen.getByTestId("nodes-view-toast-probe"));
    expect(addToast).toHaveBeenCalledWith("Nodes tab toast", "success");
  });

  it("omits the Nodes tab when the nodes feature is disabled", () => {
    render(<CommandCenter nodesEnabled={false} />);
    expect(screen.queryByTestId("command-center-tab-nodes")).toBeNull();
  });

  it("renders and routes the GitHub tab exactly once", async () => {
    mockOverviewApi({ github: githubFixture(4, 2) });
    render(<CommandCenter />);
    expect(screen.getAllByTestId("command-center-tab-github")).toHaveLength(1);

    fireEvent.click(screen.getByTestId("command-center-tab-github"));
    expect(screen.getByTestId("command-center-tab-github").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("command-center-panel-github")).toBeTruthy();
    await screen.findByTestId("cc-area-github");
    expect(screen.getByTestId("cc-github-filed").textContent).toContain("4");
    expect(screen.getByTestId("cc-github-fixed").textContent).toContain("2");
  });

  it("renders and routes the Reliability tab exactly once, threading projectId to the shared api() client", async () => {
    apiMock.mockImplementation((path: string) => {
      if (path.startsWith("/health/reliability")) return Promise.resolve(reliabilityFixture());
      if (path === "/command-center/live" || path.startsWith("/command-center/live?")) return Promise.resolve(liveFixture());
      if (path === "/system-stats") return Promise.resolve(systemStatsFixture());
      if (path === "/settings/global") return Promise.resolve({ vitestAutoKillEnabled: true, vitestKillThresholdPct: 90 });
      return Promise.reject(new Error(`Unhandled api path: ${path}`));
    });

    render(<CommandCenter projectId="project-a" />);
    expect(screen.getAllByTestId("command-center-tab-reliability")).toHaveLength(1);

    fireEvent.click(screen.getByTestId("command-center-tab-reliability"));
    expect(screen.getByTestId("command-center-tab-reliability").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("command-center-panel-reliability")).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Reliability" })).toBeTruthy();
    expect(apiMock).toHaveBeenCalledWith("/health/reliability?projectId=project-a", undefined);
  });

  it("renders the Team tab with sortable per-agent stats and charts", async () => {
    mockOverviewApi({ team: teamFixture() });
    render(<CommandCenter />);

    fireEvent.click(screen.getByTestId("command-center-tab-team"));

    await screen.findByTestId("cc-area-team");
    expect(screen.getByTestId("command-center-tab-team").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("cc-team-org-chart")).toBeTruthy();
    expect(screen.getByTestId("cc-team-heartbeat")).toBeTruthy();
    const alphaRow = screen.getByTestId("cc-team-row-agent-alpha");
    expect(alphaRow).toBeTruthy();
    expect(within(alphaRow).getByText("Alpha Agent")).toBeTruthy();
    expect(within(alphaRow).getByText("executor")).toBeTruthy();
    expect(screen.getByTestId("cc-team-table").textContent).toContain("1,500");
    expect(screen.getByTestId("cc-team-table").textContent).toContain("3");
    expect(screen.getByTestId("cc-team-tokens-chart")).toBeTruthy();
    expect(screen.getByRole("list", { name: "Tokens by agent" })).toBeTruthy();
    expect(screen.getByTestId("cc-team-completed-chart")).toBeTruthy();
    expect(screen.getByRole("list", { name: "Tasks done by agent" })).toBeTruthy();

    fireEvent.click(screen.getByTestId("cc-team-sort-agent"));
    const rows = within(screen.getByTestId("cc-team-table")).getAllByRole("row").slice(1);
    expect(rows[0].getAttribute("data-testid")).toBe("cc-team-row-agent-alpha");
  });

  it("renders and routes the Workflows tab exactly once", async () => {
    mockOverviewApi({ workflows: workflowFixture() });
    render(<CommandCenter />);
    expect(screen.getAllByTestId("command-center-tab-workflows")).toHaveLength(1);

    fireEvent.click(screen.getByTestId("command-center-tab-workflows"));

    await screen.findByTestId("cc-area-workflows");
    expect(screen.getByTestId("command-center-tab-workflows").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("command-center-panel-workflows")).toBeTruthy();
    expect(screen.getByTestId("cc-workflows-table").textContent).toContain("Coding");
  });

  it("renders the Team empty state for zero agents without an empty chart shell", async () => {
    mockOverviewApi({ team: teamFixture([]) });
    render(<CommandCenter />);

    fireEvent.click(screen.getByTestId("command-center-tab-team"));

    await screen.findByTestId("cc-area-team-empty");
    expect(screen.queryByTestId("cc-area-team")).toBeNull();
    expect(screen.queryByTestId("cc-team-tokens-chart")).toBeNull();
  });

  it("renders Team loading and error states through AreaShell", async () => {
    let resolveTeam: (value: unknown) => void = () => undefined;
    mockOverviewApi({ team: new Promise((resolve) => { resolveTeam = resolve; }) });
    const { unmount } = render(<CommandCenter />);

    fireEvent.click(screen.getByTestId("command-center-tab-team"));
    expect(screen.getByTestId("cc-area-team-loading")).toBeTruthy();
    await act(async () => {
      resolveTeam(teamFixture([]));
    });
    await screen.findByTestId("cc-area-team-empty");
    unmount();

    mockOverviewApi({ team: new Error("team failed") });
    render(<CommandCenter />);
    fireEvent.click(screen.getByTestId("command-center-tab-team"));
    await screen.findByTestId("cc-area-team-error");
    expect(screen.getByTestId("cc-area-team-error").textContent).toContain("team failed");
  });

  it("keeps Team charts safe for zero-valued agents", async () => {
    mockOverviewApi({
      team: teamFixture([
        {
          agentId: "agent-zero",
          agentName: "Zero Agent",
          role: "executor",
          state: "idle",
          tokens: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, totalTokens: 0, nTasks: 0 },
          cost: { usd: null, unavailable: false, stale: false },
          filesChanged: 0,
          tasksCompleted: 0,
          tasksInProgress: 0,
          tasksInReview: 0,
        },
      ]),
    });
    render(<CommandCenter />);

    fireEvent.click(screen.getByTestId("command-center-tab-team"));

    await screen.findByTestId("cc-area-team");
    expect(screen.getByTestId("cc-team-tokens-chart").textContent).toContain("No non-zero values");
    expect(screen.getByTestId("cc-team-completed-chart").textContent).toContain("No non-zero values");
    expect(screen.getByTestId("cc-area-team").textContent).not.toContain("NaN");
  });

  it("keeps existing Command Center tab test ids after adding Team", () => {
    render(<CommandCenter nodesEnabled={true} />);
    for (const id of [
      "overview",
      "tokens",
      "tools",
      "activity",
      "productivity",
      "workflows",
      "ecosystem",
      "github",
      "signals",
      "system",
      "nodes",
      "reliability",
      "mission-control",
      "team",
    ]) {
      expect(screen.getByTestId(`command-center-tab-${id}`)).toBeTruthy();
    }
  });

  it("supports arrow-key navigation between tabs (roving tabindex)", () => {
    render(<CommandCenter nodesEnabled={true} />);
    const overviewTab = screen.getByTestId("command-center-tab-overview");
    overviewTab.focus();
    fireEvent.keyDown(overviewTab, { key: "ArrowRight" });
    const tokensTab = screen.getByTestId("command-center-tab-tokens");
    expect(tokensTab.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tokensTab);

    // FNXC:SystemPanel 2026-07-12-12:20: Plugins sits between System and Nodes.
    const systemTab = screen.getByTestId("command-center-tab-system");
    systemTab.focus();
    fireEvent.keyDown(systemTab, { key: "ArrowRight" });
    const pluginsTab = screen.getByTestId("command-center-tab-plugins");
    expect(pluginsTab.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(pluginsTab);

    fireEvent.keyDown(pluginsTab, { key: "ArrowRight" });
    const nodesTab = screen.getByTestId("command-center-tab-nodes");
    expect(nodesTab.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(nodesTab);

    fireEvent.keyDown(nodesTab, { key: "ArrowRight" });
    const reliabilityTab = screen.getByTestId("command-center-tab-reliability");
    expect(reliabilityTab.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(reliabilityTab);
  });

  it("wraps with ArrowLeft from the first tab to the last", () => {
    render(<CommandCenter />);
    const overviewTab = screen.getByTestId("command-center-tab-overview");
    overviewTab.focus();
    fireEvent.keyDown(overviewTab, { key: "ArrowLeft" });
    const last = screen.getByTestId("command-center-tab-mission-control");
    expect(last.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(last);
  });

  it("activates with Enter and Space", () => {
    render(<CommandCenter />);
    const toolsTab = screen.getByTestId("command-center-tab-tools");
    fireEvent.keyDown(toolsTab, { key: "Enter" });
    expect(toolsTab.getAttribute("aria-selected")).toBe("true");

    const activityTab = screen.getByTestId("command-center-tab-activity");
    fireEvent.keyDown(activityTab, { key: " " });
    expect(activityTab.getAttribute("aria-selected")).toBe("true");
  });

  it("makes the active tabpanel focusable (Tab moves into the panel)", () => {
    render(<CommandCenter />);
    const panel = screen.getByTestId("command-center-panel-overview");
    expect(panel.getAttribute("tabindex")).toBe("0");
    expect(panel.getAttribute("role")).toBe("tabpanel");
  });

  it("renders a date-range picker that returns focus to its trigger on dismiss", () => {
    render(<CommandCenter />);
    const trigger = screen.getByTestId("cc-date-range-trigger");
    fireEvent.click(trigger);
    expect(screen.getByTestId("cc-date-range-popover")).toBeTruthy();
    // Escape dismisses and returns focus to the trigger.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("cc-date-range-popover")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
