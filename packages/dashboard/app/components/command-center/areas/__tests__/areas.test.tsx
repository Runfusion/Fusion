/*
FNXC:CommandCenter 2026-06-16-09:42:
Command Center area component tests (PR #1683). Pin loading/error/unavailable-vs-zero rendering for each analytics area against mocked fixtures so the "—" sentinel and cost-unavailable contracts can't regress.
*/
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, act, renderHook } from "@testing-library/react";
import type { OrgTreeNode } from "@fusion/core";

// Mock the api() helper so the areas fetch deterministic fixtures.
const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  backfillGithubSourceIssueClosedAt: vi.fn(),
  fetchOrgTree: vi.fn(),
  fetchExecutorStats: vi.fn(),
  toggleEnginePause: vi.fn(),
  appSettings: { globalPaused: false, enginePaused: false },
}));
const apiMock = mocks.api;
const backfillGithubSourceIssueClosedAtMock = mocks.backfillGithubSourceIssueClosedAt;
const fetchOrgTreeMock = mocks.fetchOrgTree;
const fetchExecutorStatsMock = mocks.fetchExecutorStats;
const toggleEnginePauseMock = mocks.toggleEnginePause;
const appSettingsMock = mocks.appSettings;
vi.mock("../../../../api/legacy", () => ({
  api: (path: string, opts?: RequestInit) => mocks.api(path, opts),
  apiBackfillGithubSourceIssueClosedAt: (options?: { offset?: number; limit?: number }, projectId?: string) =>
    mocks.backfillGithubSourceIssueClosedAt(options, projectId),
  fetchOrgTree: mocks.fetchOrgTree,
  fetchExecutorStats: mocks.fetchExecutorStats,
}));

vi.mock("../../../../hooks/useAppSettings", () => ({
  useAppSettings: () => ({
    globalPaused: mocks.appSettings.globalPaused,
    enginePaused: mocks.appSettings.enginePaused,
    toggleEnginePause: mocks.toggleEnginePause,
  }),
}));

import { TokensArea } from "../TokensArea";
import { ToolsArea } from "../ToolsArea";
import { ProductivityArea } from "../ProductivityArea";
import { GithubArea } from "../GithubArea";
import { SignalsArea } from "../SignalsArea";
import { TeamArea } from "../TeamArea";
import { ActivityArea } from "../ActivityArea";
import { EcosystemArea } from "../EcosystemArea";
import { useAnalyticsArea } from "../useAnalyticsArea";
import type { DateRange } from "../DateRangePicker";

const range7d: DateRange = { from: "2026-06-08", to: null, preset: "7d" };
const customRange = (from: string, to: string): DateRange => ({ from, to, preset: "custom" });

function tokenFixture(totalTokens = 1500) {
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
    cost: { usd: 12.5, unavailable: false, stale: false },
    series: [
      {
        bucket: "2026-06-08",
        inputTokens: 400,
        outputTokens: 200,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 600,
        nTasks: 2,
        cost: { usd: 4.5, unavailable: false, stale: false },
      },
      {
        bucket: "2026-06-09",
        inputTokens: 600,
        outputTokens: 300,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 900,
        nTasks: 3,
        cost: { usd: 8, unavailable: false, stale: false },
      },
    ],
    groups: [
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
    ],
  };
}

function githubFixture() {
  return {
    from: "2026-06-08",
    to: null,
    filed: 5,
    fixed: 3,
    net: 2,
    daily: [
      { date: "2026-06-08", filed: 2, fixed: 1 },
      { date: "2026-06-09", filed: 3, fixed: 2 },
    ],
    byRepo: [
      { repo: "acme/alpha", filed: 4, fixed: 1 },
      { repo: "acme/beta", filed: 1, fixed: 2 },
    ],
  };
}

function agentNode(id: string, name: string, children: OrgTreeNode[] = [], title = "Team Lead"): OrgTreeNode {
  return {
    agent: {
      id,
      name,
      title,
      role: "executor",
      state: "idle",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:00.000Z",
      metadata: {},
    },
    children,
  };
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

function populatedTeamFixture(totalTokens = 1500) {
  return {
    ...emptyTeamFixture(),
    totals: {
      tokens: {
        inputTokens: Math.round(totalTokens * 0.6),
        outputTokens: Math.round(totalTokens * 0.3),
        cachedTokens: Math.round(totalTokens * 0.1),
        cacheWriteTokens: 0,
        totalTokens,
        nTasks: 2,
      },
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
        tokens: {
          inputTokens: Math.round(totalTokens * 0.6),
          outputTokens: Math.round(totalTokens * 0.3),
          cachedTokens: Math.round(totalTokens * 0.1),
          cacheWriteTokens: 0,
          totalTokens,
          nTasks: 2,
        },
        cost: { usd: 4.25, unavailable: false, stale: false },
        filesChanged: 7,
        tasksCompleted: 3,
        tasksInProgress: 1,
        tasksInReview: 0,
      },
    ],
  };
}

function activityFixture() {
  return {
    from: "2026-06-08",
    to: null,
    sessions: 4,
    messages: 12,
    activeNodes: 3,
    activeAgents: 2,
    agentRuns: { total: 8, active: 1, completed: 6, failed: 1 },
    daily: [
      { day: "2026-06-08", messages: 2, activeNodes: 1, activeAgents: 1, agentRuns: 2 },
      { day: "2026-06-09", messages: 4, activeNodes: 2, activeAgents: 1, agentRuns: 3 },
      { day: "2026-06-10", messages: 6, activeNodes: 3, activeAgents: 2, agentRuns: 3 },
    ],
    stickiness: 0.5,
    mttr: { value: null, unavailable: true, sampleCount: 0 },
    monitor: {
      mttr: { value: null, unavailable: true, sampleCount: 0 },
      incidentsOpened: 0,
      incidentsResolved: 0,
      openIncidents: 0,
      deployments: 0,
    },
    funnel: {
      stages: [],
      enteredInRange: 0,
      doneInRange: 0,
      completionRate: null,
      throughputPerDay: 0,
      rangeDays: 7,
    },
  };
}

beforeEach(() => {
  apiMock.mockReset();
  backfillGithubSourceIssueClosedAtMock.mockReset();
  fetchOrgTreeMock.mockReset();
  fetchOrgTreeMock.mockResolvedValue([]);
  fetchExecutorStatsMock.mockReset();
  fetchExecutorStatsMock.mockResolvedValue({
    globalPause: false,
    enginePaused: false,
    maxConcurrent: 2,
    lastActivityAt: "2026-06-19T12:00:00.000Z",
  });
  toggleEnginePauseMock.mockReset();
  appSettingsMock.globalPaused = false;
  appSettingsMock.enginePaused = false;
});

afterEach(() => {
  vi.useRealTimers();
});

function expectRechartsWrapperWithin(testId: string, label: string): void {
  const section = screen.getByTestId(testId);
  const chart = within(section).getByRole("img", { name: label });
  expect(chart.classList.contains("cc-recharts-chart") || chart.classList.contains("cc-recharts-empty")).toBe(true);
  expect(chart.outerHTML).not.toMatch(/NaN|Infinity/);
}

function expectBarFillsFinite(testId: string): void {
  const section = screen.getByTestId(testId);
  for (const fill of Array.from(section.querySelectorAll<HTMLElement>(".cc-bar-fill"))) {
    expect(fill.style.width).toMatch(/^\d+(?:\.\d+)?%$/);
    expect(fill.style.width).not.toMatch(/NaN|Infinity/);
  }
}

function expectSparklineHeightsFinite(testId: string): void {
  const section = screen.getByTestId(testId);
  for (const bar of Array.from(section.querySelectorAll<HTMLElement>(".cc-sparkline-bar"))) {
    expect(bar.style.height).toMatch(/^\d+(?:\.\d+)?%$/);
    expect(bar.style.height).not.toMatch(/NaN|Infinity/);
  }
}

function expectSvgLinePointsInsideViewBox(testId: string, label: string): void {
  const section = screen.getByTestId(testId);
  const chart = within(section).getByRole("img", { name: label });
  for (const point of Array.from(chart.querySelectorAll(".cc-line-chart-point"))) {
    const cx = Number(point.getAttribute("cx"));
    const cy = Number(point.getAttribute("cy"));
    const r = Number(point.getAttribute("r"));
    expect(cx).toBeGreaterThanOrEqual(r);
    expect(cx).toBeLessThanOrEqual(100 - r);
    expect(cy).toBeGreaterThanOrEqual(r);
    expect(cy).toBeLessThanOrEqual(100 - r);
  }
}

function expectSvgLineMarkersUndistorted(testId: string, label: string): void {
  const section = screen.getByTestId(testId);
  const chart = within(section).getByRole("img", { name: label });
  expect(chart.getAttribute("preserveAspectRatio")).toBe("xMidYMid meet");
  expect(chart.getAttribute("preserveAspectRatio")).not.toBe("none");
  expect(chart.querySelectorAll(".cc-line-chart-point").length).toBeGreaterThan(0);
}

describe("useAnalyticsArea", () => {
  it("polls only when pollMs is provided and clears the interval on unmount", async () => {
    vi.useFakeTimers();
    apiMock.mockResolvedValue({ ok: true });

    const { unmount } = renderHook(() =>
      useAnalyticsArea<{ ok: boolean }>("/command-center/tokens", range7d, { pollMs: 1_000 }),
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(apiMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    });
    expect(apiMock).toHaveBeenCalledTimes(2);

    unmount();
    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    });
    expect(apiMock).toHaveBeenCalledTimes(2);
  });

  it("does not poll by default", async () => {
    vi.useFakeTimers();
    apiMock.mockResolvedValue({ ok: true });

    renderHook(() => useAnalyticsArea<{ ok: boolean }>("/command-center/tools", range7d));

    await act(async () => {
      await Promise.resolve();
    });
    expect(apiMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    expect(apiMock).toHaveBeenCalledTimes(1);
  });

  it("does not fetch or schedule polling for inverted custom ranges", async () => {
    vi.useFakeTimers();

    renderHook(() =>
      useAnalyticsArea<{ ok: boolean }>(
        "/command-center/tokens",
        customRange("2026-06-10", "2026-06-01"),
        { pollMs: 1_000 },
      ),
    );

    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await Promise.resolve();
    });
    expect(apiMock).not.toHaveBeenCalled();
  });
});

describe("ActivityArea", () => {
  it("renders summary stats and the live line chart sections for populated daily activity", async () => {
    apiMock.mockResolvedValue(activityFixture());
    render(<ActivityArea range={range7d} />);

    await screen.findByTestId("cc-area-activity");
    expect(screen.getByTestId("cc-activity-sessions").textContent).toContain("4");
    expect(screen.getByTestId("cc-activity-messages").textContent).toContain("12");
    expect(screen.getByTestId("cc-activity-nodes").textContent).toContain("3");
    expect(screen.getByTestId("cc-activity-agents").textContent).toContain("2");
    expect(screen.getByTestId("cc-activity-agent-runs").textContent).toContain("8");
    expect(screen.getByTestId("cc-activity-agent-runs-active").textContent).toContain("1");
    expect(screen.getByTestId("cc-activity-agent-runs-completed").textContent).toContain("6");
    expect(screen.getByTestId("cc-activity-agent-runs-failed").textContent).toContain("1");
    expect(screen.getByTestId("cc-activity-stickiness").textContent).toContain("50%");
    expect(screen.getByTestId("cc-activity-line")).toBeTruthy();
    expect(screen.getByTestId("cc-activity-pie")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Activity trend" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Agent run outcome share" })).toBeTruthy();
    expect(screen.getByTestId("cc-activity-line-messages")).toBeTruthy();
    expect(screen.getByTestId("cc-activity-line-agents")).toBeTruthy();
    expect(screen.getByTestId("cc-activity-line-nodes")).toBeTruthy();
    expect(screen.getByTestId("cc-activity-agent-runs-sparkline")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Agent runs / day" })).toBeTruthy();
    expect(screen.getByTestId("cc-activity-line-throughput")).toBeTruthy();
    expectRechartsWrapperWithin("cc-activity-line", "Activity trend");
    expect(screen.getByRole("img", { name: "Activity trend" })).toHaveAttribute("data-scale-mode", "series");
    expectRechartsWrapperWithin("cc-activity-pie", "Agent run outcome share");
    expectSvgLinePointsInsideViewBox("cc-activity-line-messages", "Messages / day");
    expectSvgLineMarkersUndistorted("cc-activity-line-messages", "Messages / day");
    expectSvgLinePointsInsideViewBox("cc-activity-line-agents", "Active agents / day");
    expectSvgLineMarkersUndistorted("cc-activity-line-agents", "Active agents / day");
    expectSvgLinePointsInsideViewBox("cc-activity-line-nodes", "Active nodes / day");
    expectSvgLineMarkersUndistorted("cc-activity-line-nodes", "Active nodes / day");
    expectSvgLinePointsInsideViewBox("cc-activity-line-throughput", "Throughput / day");
    expectSvgLineMarkersUndistorted("cc-activity-line-throughput", "Throughput / day");
    expect(within(screen.getByTestId("cc-activity-agent-runs-sparkline")).getByRole("img", { name: "Agent runs / day" }).classList).toContain("cc-sparkline");
    expectSparklineHeightsFinite("cc-activity-agent-runs-sparkline");
  });

  it("opts only the mixed-unit activity trend into per-series scaling", async () => {
    apiMock.mockResolvedValue({
      ...activityFixture(),
      messages: 3_300,
      activeAgents: 2,
      agentRuns: { total: 9, active: 1, completed: 7, failed: 1 },
      daily: [
        { day: "2026-06-08", messages: 1_000, activeNodes: 20, activeAgents: 1, agentRuns: 2 },
        { day: "2026-06-09", messages: 1_200, activeNodes: 22, activeAgents: 2, agentRuns: 4 },
        { day: "2026-06-10", messages: 1_100, activeNodes: 21, activeAgents: 1, agentRuns: 3 },
      ],
    });
    render(<ActivityArea range={range7d} />);

    await screen.findByTestId("cc-area-activity");
    expect(screen.getByRole("img", { name: "Activity trend" })).toHaveAttribute("data-scale-mode", "series");
    expectSvgLinePointsInsideViewBox("cc-activity-line-agents", "Active agents / day");
    expectSvgLinePointsInsideViewBox("cc-activity-line-throughput", "Throughput / day");
    expectSparklineHeightsFinite("cc-activity-agent-runs-sparkline");
  });

  it("renders zero agent-run cards when counts are zero and other activity exists", async () => {
    apiMock.mockResolvedValue({
      ...activityFixture(),
      agentRuns: { total: 0, active: 0, completed: 0, failed: 0 },
      daily: [{ day: "2026-06-08", messages: 1, activeNodes: 1, activeAgents: 1, agentRuns: 0 }],
    });
    render(<ActivityArea range={range7d} />);

    await screen.findByTestId("cc-area-activity");
    expect(screen.queryByTestId("cc-area-activity-empty")).toBeNull();
    expect(screen.getByTestId("cc-activity-agent-runs").textContent).toContain("0");
    expect(screen.getByTestId("cc-activity-agent-runs-active").textContent).toContain("0");
    expect(screen.getByTestId("cc-activity-agent-runs-completed").textContent).toContain("0");
    expect(screen.getByTestId("cc-activity-agent-runs-failed").textContent).toContain("0");
  });

  it("renders agent-run cards instead of the empty state when only run data exists", async () => {
    apiMock.mockResolvedValue({
      ...activityFixture(),
      sessions: 0,
      messages: 0,
      activeNodes: 0,
      activeAgents: 0,
      agentRuns: { total: 2, active: 1, completed: 1, failed: 0 },
      daily: [{ day: "2026-06-08", messages: 0, activeNodes: 0, activeAgents: 0, agentRuns: 2 }],
      stickiness: 0,
    });
    render(<ActivityArea range={range7d} />);

    await screen.findByTestId("cc-area-activity");
    expect(screen.queryByTestId("cc-area-activity-empty")).toBeNull();
    expect(screen.getByTestId("cc-activity-agent-runs").textContent).toContain("2");
    expect(screen.getByTestId("cc-activity-agent-runs-sparkline")).toBeTruthy();
    expect(screen.getByTestId("cc-activity-line")).toBeTruthy();
    expect(screen.getByTestId("cc-activity-pie")).toBeTruthy();
  });

  it("keeps activity recharts safe for single-item and non-finite data", async () => {
    apiMock.mockResolvedValue({
      ...activityFixture(),
      sessions: 1,
      messages: 1,
      activeNodes: 1,
      activeAgents: 1,
      agentRuns: { total: 1, active: 0, completed: 1, failed: 0 },
      daily: [{ day: "2026-06-08", messages: Number.NaN, activeNodes: 1, activeAgents: Number.POSITIVE_INFINITY, agentRuns: -1 }],
    });
    render(<ActivityArea range={range7d} />);

    await screen.findByTestId("cc-area-activity");
    expect(screen.getByTestId("cc-activity-line")).toBeTruthy();
    expect(screen.getByTestId("cc-activity-pie")).toBeTruthy();
    expect(screen.getByTestId("cc-activity-line").textContent).not.toContain("NaN");
    expect(screen.getByTestId("cc-activity-line").textContent).not.toContain("Infinity");
    expect(screen.getByTestId("cc-activity-pie").textContent).not.toContain("NaN");
  });

  it("renders empty, loading, and error states without activity recharts shells", async () => {
    apiMock.mockResolvedValueOnce({
      ...activityFixture(),
      sessions: 0,
      messages: 0,
      activeNodes: 0,
      activeAgents: 0,
      agentRuns: { total: 0, active: 0, completed: 0, failed: 0 },
      daily: [],
      stickiness: 0,
    });
    const empty = render(<ActivityArea range={range7d} />);

    await screen.findByTestId("cc-area-activity-empty");
    expect(screen.queryByTestId("cc-activity-line")).toBeNull();
    expect(screen.queryByTestId("cc-activity-pie")).toBeNull();
    expect(screen.queryByTestId("cc-activity-line-messages")).toBeNull();
    expect(screen.queryByTestId("cc-activity-line-agents")).toBeNull();
    expect(screen.queryByTestId("cc-activity-line-nodes")).toBeNull();
    expect(screen.queryByTestId("cc-activity-agent-runs-sparkline")).toBeNull();
    expect(screen.queryByTestId("cc-activity-line-throughput")).toBeNull();
    empty.unmount();

    apiMock.mockImplementationOnce(() => new Promise(() => undefined));
    const pending = render(<ActivityArea range={range7d} />);
    expect(screen.getByTestId("cc-area-activity-loading")).toBeTruthy();
    expect(screen.queryByTestId("cc-activity-line")).toBeNull();
    expect(screen.queryByTestId("cc-activity-pie")).toBeNull();
    pending.unmount();

    apiMock.mockRejectedValueOnce(new Error("activity failed"));
    render(<ActivityArea range={range7d} />);
    await screen.findByTestId("cc-area-activity-error");
    expect(screen.queryByTestId("cc-activity-line")).toBeNull();
    expect(screen.queryByTestId("cc-activity-pie")).toBeNull();
  });

  it("polls activity while mounted, keeps content during refresh, and clears the interval on unmount", async () => {
    vi.useFakeTimers();
    apiMock.mockResolvedValue(activityFixture());
    const { unmount } = render(<ActivityArea range={range7d} />);

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("cc-area-activity")).toBeTruthy();
    expect(apiMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
    });
    expect(apiMock).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("cc-area-activity")).toBeTruthy();
    expect(screen.queryByTestId("cc-area-activity-loading")).toBeNull();

    unmount();
    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
    });
    expect(apiMock).toHaveBeenCalledTimes(2);
  });

  it("does not poll or fetch for an inverted custom activity range", async () => {
    vi.useFakeTimers();
    render(<ActivityArea range={customRange("2026-06-10", "2026-06-01")} />);

    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });
    expect(apiMock).not.toHaveBeenCalled();
  });
});

describe("TokensArea", () => {
  it("shows per-model totals + cost and renders rows", async () => {
    apiMock.mockResolvedValue(tokenFixture());
    render(<TokensArea range={range7d} />);

    await screen.findByTestId("cc-area-tokens");
    expect(screen.getByTestId("cc-tokens-total").textContent).toContain("1,500");
    expect(screen.getByTestId("cc-tokens-cost").textContent).toContain("$12.50");
    expect(screen.getByTestId("cc-token-series-chart")).toBeTruthy();
    expect(screen.getByTestId("cc-tokens-line")).toBeTruthy();
    expect(screen.getByTestId("cc-tokens-pie")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Tokens trend" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Token share by model" })).toBeTruthy();
    expect(screen.getByLabelText("2026-06-09: 900")).toBeTruthy();
    expect(screen.getByTestId("cc-tokens-row-gpt-4o")).toBeTruthy();
    expect(screen.getByTestId("cc-tokens-row-claude-sonnet")).toBeTruthy();
  });

  it("renders a large comma-grouped total unchanged in the total tokens card", async () => {
    apiMock.mockResolvedValue(tokenFixture(1_234_567_890));
    render(<TokensArea range={range7d} />);

    await screen.findByTestId("cc-area-tokens");
    expect(screen.getByTestId("cc-tokens-total").textContent).toContain("1,234,567,890");
  });

  it("changes the requested endpoint when granularity changes", async () => {
    apiMock.mockResolvedValue(tokenFixture());
    render(<TokensArea range={range7d} />);
    await screen.findByTestId("cc-area-tokens");
    expect(apiMock.mock.calls.at(-1)?.[0]).toContain("granularity=day");

    fireEvent.click(screen.getByTestId("cc-token-granularity-hour"));
    await waitFor(() => expect(apiMock.mock.calls.at(-1)?.[0]).toContain("granularity=hour"));
  });

  it("polls the live token value while preserving rendered content", async () => {
    vi.useFakeTimers();
    apiMock
      .mockResolvedValueOnce(tokenFixture())
      .mockResolvedValueOnce({
        ...tokenFixture(),
        totals: { ...tokenFixture().totals, totalTokens: 1700 },
      });

    render(<TokensArea range={range7d} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("cc-tokens-total").textContent).toContain("1,500");

    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("cc-tokens-total").textContent).toContain("1,700");
    expect(screen.getByTestId("cc-token-series-chart")).toBeTruthy();
  });

  it("refetches when the date range changes", async () => {
    apiMock.mockResolvedValue(tokenFixture());
    const { rerender } = render(<TokensArea range={range7d} />);
    await screen.findByTestId("cc-area-tokens");
    expect(apiMock).toHaveBeenCalledTimes(1);

    rerender(<TokensArea range={{ from: "2026-05-01", to: null, preset: "30d" }} />);
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2));
    const lastCall = apiMock.mock.calls.at(-1)?.[0] as string;
    expect(lastCall).toContain("from=2026-05-01");
  });

  it("renders empty, loading, and error states without token recharts shells", async () => {
    apiMock.mockResolvedValueOnce({
      from: null,
      to: null,
      groupBy: "model",
      totals: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, totalTokens: 0, nTasks: 0 },
      cost: { usd: null, unavailable: true, stale: false },
      groups: [],
      series: [],
    });
    const empty = render(<TokensArea range={range7d} />);
    await screen.findByTestId("cc-area-tokens-empty");
    expect(screen.queryByTestId("cc-tokens-line")).toBeNull();
    expect(screen.queryByTestId("cc-tokens-pie")).toBeNull();
    empty.unmount();

    apiMock.mockImplementationOnce(() => new Promise(() => undefined));
    const pending = render(<TokensArea range={range7d} />);
    expect(screen.getByTestId("cc-area-tokens-loading")).toBeTruthy();
    expect(screen.queryByTestId("cc-tokens-line")).toBeNull();
    expect(screen.queryByTestId("cc-tokens-pie")).toBeNull();
    pending.unmount();

    apiMock.mockRejectedValueOnce(new Error("tokens failed"));
    render(<TokensArea range={range7d} />);
    await screen.findByTestId("cc-area-tokens-error");
    expect(screen.queryByTestId("cc-tokens-line")).toBeNull();
    expect(screen.queryByTestId("cc-tokens-pie")).toBeNull();
  });

  it("renders token recharts with a single valid item", async () => {
    apiMock.mockResolvedValue({
      ...tokenFixture(),
      groups: [tokenFixture().groups[0]],
      series: [tokenFixture().series[0]],
    });
    render(<TokensArea range={range7d} />);

    await screen.findByTestId("cc-area-tokens");
    expect(screen.getByTestId("cc-tokens-line")).toBeTruthy();
    expect(screen.getByTestId("cc-tokens-pie")).toBeTruthy();
    expect(screen.getByTestId("cc-tokens-line").textContent).not.toContain("NaN");
    expect(screen.getByTestId("cc-tokens-pie").textContent).not.toContain("NaN");
  });

  it("keeps token recharts safe for non-finite data", async () => {
    apiMock.mockResolvedValue({
      ...tokenFixture(),
      totals: { ...tokenFixture().totals, totalTokens: 1 },
      groups: [{ ...tokenFixture().groups[0], key: "broken-model", totalTokens: Number.NaN }],
      series: [{ ...tokenFixture().series[0], inputTokens: Number.NaN, outputTokens: Number.POSITIVE_INFINITY, cachedTokens: -1, totalTokens: Number.NaN }],
    });
    render(<TokensArea range={range7d} />);

    await screen.findByTestId("cc-area-tokens");
    expect(screen.getByTestId("cc-tokens-line")).toBeTruthy();
    expect(screen.getByTestId("cc-tokens-pie")).toBeTruthy();
    expect(screen.getByTestId("cc-tokens-line").textContent).not.toContain("NaN");
    expect(screen.getByTestId("cc-tokens-line").textContent).not.toContain("Infinity");
    expect(screen.getByTestId("cc-tokens-pie").textContent).not.toContain("NaN");
  });

  // The critical SWR-identity regression: a revalidation that returns
  // content-identical rows with a NEW object identity must NOT reset the user's
  // chosen column sort.
  it("preserves the user's sort across an SWR revalidation with new array identity", async () => {
    const original = tokenFixture();
    // Defer the second resolution so we can interact before it lands.
    let resolveSecond: ((v: unknown) => void) | null = null;
    apiMock
      .mockResolvedValueOnce(original)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );

    const { rerender } = render(<TokensArea range={range7d} />);
    await screen.findByTestId("cc-area-tokens");

    // Default sort is total desc. Switch to sorting by model name ascending.
    fireEvent.click(screen.getByTestId("cc-tokens-sort-key"));
    const rowsAfterSort = screen.getAllByTestId(/cc-tokens-row-/).map((r) => r.getAttribute("data-testid"));
    // claude-sonnet sorts before gpt-4o alphabetically.
    expect(rowsAfterSort[0]).toBe("cc-tokens-row-claude-sonnet");

    // Trigger a refetch (range value change → refetch) and resolve it with a
    // DEEP COPY of the SAME content (new object identity, identical model set).
    rerender(<TokensArea range={{ from: "2026-06-07", to: null, preset: "custom" }} />);
    await waitFor(() => expect(resolveSecond).not.toBeNull());
    await act(async () => {
      resolveSecond?.(JSON.parse(JSON.stringify(original)));
    });

    // Sort must survive: claude-sonnet still first.
    await waitFor(() => {
      const rows = screen.getAllByTestId(/cc-tokens-row-/).map((r) => r.getAttribute("data-testid"));
      expect(rows[0]).toBe("cc-tokens-row-claude-sonnet");
    });
  });

  it("rejects an inverted custom range client-side without fetching", async () => {
    render(<TokensArea range={customRange("2026-06-10", "2026-06-01")} />);
    // No request should be issued for from > to.
    await waitFor(() => expect(apiMock).not.toHaveBeenCalled());
  });
});

describe("ToolsArea", () => {
  it("shows autonomy ratio and sorted tool categories", async () => {
    apiMock.mockResolvedValue({
      from: "2026-06-08",
      to: null,
      toolCalls: 30,
      byCategory: [
        { category: "edit", count: 5 },
        { category: "read", count: 20 },
        { category: "shell", count: 5 },
      ],
      sessions: 3,
      interventions: { approvals: 2, userSteers: 1, total: 3 },
      autonomyRatio: 10,
      fullyAutonomous: false,
    });
    render(<ToolsArea range={range7d} />);
    await screen.findByTestId("cc-area-tools");
    expect(screen.getByTestId("cc-tools-autonomy").textContent).toContain("10.0:1");
    expect(screen.getByTestId("cc-tools-pie")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Tool category share" })).toBeTruthy();

    // Sorted descending by count: read (20) first.
    const chart = screen.getByRole("list", { name: "Tool categories" });
    const labels = within(chart).getAllByRole("img").map((el) => el.getAttribute("aria-label"));
    expect(labels[0]).toBe("read: 20");
  });

  it("renders empty, loading, and error states without tools pie shells", async () => {
    apiMock.mockResolvedValueOnce({
      from: null,
      to: null,
      toolCalls: 0,
      byCategory: [],
      sessions: 0,
      interventions: { approvals: 0, userSteers: 0, total: 0 },
      autonomyRatio: 0,
      fullyAutonomous: true,
    });
    const empty = render(<ToolsArea range={range7d} />);
    await screen.findByTestId("cc-area-tools-empty");
    expect(screen.queryByTestId("cc-tools-pie")).toBeNull();
    empty.unmount();

    apiMock.mockImplementationOnce(() => new Promise(() => undefined));
    const pending = render(<ToolsArea range={range7d} />);
    expect(screen.getByTestId("cc-area-tools-loading")).toBeTruthy();
    expect(screen.queryByTestId("cc-tools-pie")).toBeNull();
    pending.unmount();

    apiMock.mockRejectedValueOnce(new Error("tools failed"));
    render(<ToolsArea range={range7d} />);
    await screen.findByTestId("cc-area-tools-error");
    expect(screen.queryByTestId("cc-tools-pie")).toBeNull();
  });

  it("renders the tools pie with a single valid category", async () => {
    apiMock.mockResolvedValue({
      from: "2026-06-08",
      to: null,
      toolCalls: 1,
      byCategory: [{ category: "edit", count: 1 }],
      sessions: 1,
      interventions: { approvals: 0, userSteers: 0, total: 0 },
      autonomyRatio: 1,
      fullyAutonomous: true,
    });
    render(<ToolsArea range={range7d} />);

    await screen.findByTestId("cc-area-tools");
    expect(screen.getByTestId("cc-tools-pie")).toBeTruthy();
    expect(screen.getByTestId("cc-tools-pie").textContent).not.toContain("NaN");
  });

  it("keeps the tools pie safe for non-finite category data", async () => {
    apiMock.mockResolvedValue({
      from: "2026-06-08",
      to: null,
      toolCalls: 1,
      byCategory: [{ category: "broken", count: Number.NaN }],
      sessions: 1,
      interventions: { approvals: 0, userSteers: 0, total: 0 },
      autonomyRatio: 1,
      fullyAutonomous: true,
    });
    render(<ToolsArea range={range7d} />);

    await screen.findByTestId("cc-area-tools");
    expect(screen.getByTestId("cc-tools-pie")).toBeTruthy();
    expect(screen.getByTestId("cc-tools-pie").textContent).not.toContain("NaN");
    expect(screen.getByTestId("cc-tools-pie").textContent).not.toContain("Infinity");
  });
});

describe("ProductivityArea", () => {
  it("renders unavailable LOC and hours saved as dash sentinels, duration stats, and finite chart geometry", async () => {
    apiMock.mockResolvedValue({
      from: "2026-06-08",
      to: null,
      modifiedFiles: 12,
      byLanguage: [{ language: "ts", count: 12 }],
      commits: 4,
      pullRequests: 2,
      loc: { value: null, unavailable: true },
      hoursSaved: { value: null, unavailable: true },
      taskDuration: {
        completedTasks: 3,
        averageMs: 5_400_000,
        medianMs: 3_600_000,
        p90Ms: 7_200_000,
        totalMs: 16_200_000,
        unavailable: false,
      },
    });
    render(<ProductivityArea range={range7d} />);
    await screen.findByTestId("cc-area-productivity");
    const loc = screen.getByTestId("cc-productivity-loc-unavailable");
    expect(loc.textContent).toBe("—");
    expect(loc.getAttribute("title")).toBeTruthy();
    const hoursSaved = screen.getByTestId("cc-productivity-hours-saved-unavailable");
    expect(hoursSaved.textContent).toBe("—");
    expect(hoursSaved.getAttribute("title")).toBeTruthy();
    expect(screen.getByTestId("cc-productivity-hours-saved").textContent).not.toContain("0");
    // The commits outcome counter still shows a real number.
    expect(screen.getByTestId("cc-productivity-commits").textContent).toContain("4");
    expect(screen.getByTestId("cc-productivity-duration-completed").textContent).toContain("3");
    expect(screen.getByTestId("cc-productivity-duration-avg").textContent).toContain("1h 30m");
    expect(screen.getByTestId("cc-productivity-duration-median").textContent).toContain("1h");
    expect(screen.getByTestId("cc-productivity-duration-p90").textContent).toContain("2h");
    expect(screen.getByTestId("cc-productivity-duration-total").textContent).toContain("4h 30m");
    expect(screen.getByRole("list", { name: "Files by language" })).toBeTruthy();
    expect(screen.getByTestId("cc-productivity-pie")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Language share" })).toBeTruthy();
    expect(screen.getByTestId("cc-area-productivity").textContent).not.toContain("NaN");
  });

  it("renders empty, loading, and error states without empty chart shells", async () => {
    apiMock.mockResolvedValueOnce({
      from: null,
      to: null,
      modifiedFiles: 0,
      byLanguage: [],
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
    });
    const { unmount } = render(<ProductivityArea range={range7d} />);
    await screen.findByTestId("cc-area-productivity-empty");
    expect(screen.queryByRole("list", { name: "Files by language" })).toBeNull();
    expect(screen.queryByTestId("cc-productivity-pie")).toBeNull();
    expect(screen.queryByTestId("cc-productivity-duration-avg")).toBeNull();
    unmount();

    apiMock.mockImplementationOnce(() => new Promise(() => undefined));
    const pending = render(<ProductivityArea range={range7d} />);
    expect(screen.getByTestId("cc-area-productivity-loading")).toBeTruthy();
    pending.unmount();

    apiMock.mockRejectedValueOnce(new Error("productivity failed"));
    render(<ProductivityArea range={range7d} />);
    await screen.findByTestId("cc-area-productivity-error");
    expect(screen.getByTestId("cc-area-productivity-error").textContent).toContain("productivity failed");
    expect(screen.queryByTestId("cc-productivity-pie")).toBeNull();
    expect(screen.queryByTestId("cc-productivity-duration-avg")).toBeNull();
  });

  it("renders unavailable task duration as dash sentinels, never zero", async () => {
    apiMock.mockResolvedValue({
      from: "2026-06-08",
      to: null,
      modifiedFiles: 1,
      byLanguage: [{ language: "ts", count: 1 }],
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
    });

    render(<ProductivityArea range={range7d} />);
    await screen.findByTestId("cc-area-productivity");

    const avg = screen.getByTestId("cc-productivity-duration-avg-unavailable");
    expect(avg.textContent).toBe("—");
    expect(avg.getAttribute("title")).toBeTruthy();
    expect(screen.getByTestId("cc-productivity-duration-median-unavailable").textContent).toBe("—");
    expect(screen.getByTestId("cc-productivity-duration-p90-unavailable").textContent).toBe("—");
    expect(screen.getByTestId("cc-productivity-duration-total-unavailable").textContent).toBe("—");
    expect(screen.getByTestId("cc-productivity-duration-avg").textContent).not.toContain("0");
  });

  it("renders dash sentinels for contract-incomplete productivity payloads", async () => {
    apiMock.mockResolvedValue({
      from: "2026-06-08",
      to: null,
      modifiedFiles: 1,
      byLanguage: [],
      commits: 1,
      pullRequests: 0,
    });

    render(<ProductivityArea range={range7d} />);

    const area = await screen.findByTestId("cc-area-productivity");
    expect(screen.getByTestId("cc-productivity-loc-unavailable").textContent).toBe("—");
    expect(screen.getByTestId("cc-productivity-hours-saved-unavailable").textContent).toBe("—");
    expect(screen.getByTestId("cc-productivity-duration-avg-unavailable").textContent).toBe("—");
    expect(screen.getByTestId("cc-productivity-duration-median-unavailable").textContent).toBe("—");
    expect(screen.getByTestId("cc-productivity-duration-p90-unavailable").textContent).toBe("—");
    expect(screen.getByTestId("cc-productivity-duration-total-unavailable").textContent).toBe("—");
    expect(area.textContent).not.toContain("NaN");
    expect(area.textContent?.trim()).not.toBe("");
  });

  it("keeps the productivity pie safe for single-item and non-finite language data", async () => {
    apiMock.mockResolvedValue({
      from: "2026-06-08",
      to: null,
      modifiedFiles: 1,
      byLanguage: [{ language: "broken", count: Number.NaN }],
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
    });
    render(<ProductivityArea range={range7d} />);

    await screen.findByTestId("cc-area-productivity");
    expect(screen.getByTestId("cc-productivity-pie")).toBeTruthy();
    expect(screen.getByTestId("cc-productivity-pie").textContent).not.toContain("NaN");
    expect(screen.getByTestId("cc-productivity-pie").textContent).not.toContain("Infinity");
  });
});

describe("TeamArea", () => {
  it("renders relocated org chart and heartbeat outside analytics gating", async () => {
    apiMock.mockResolvedValueOnce(emptyTeamFixture());
    fetchOrgTreeMock.mockResolvedValueOnce([
      agentNode("agent-lead", "Lead Agent", [agentNode("agent-child", "Child Agent", [], "Child Title")]),
    ]);

    render(<TeamArea range={range7d} projectId="project-a" />);

    const orgSection = await screen.findByTestId("cc-team-org-chart");
    const heartbeatSection = screen.getByTestId("cc-team-heartbeat");
    expect(screen.getByTestId("cc-area-team-empty")).toBeTruthy();
    expect(within(orgSection).getByText("Lead Agent")).toBeTruthy();
    expect(within(orgSection).getByText("Child Agent")).toBeTruthy();
    expect(within(orgSection).queryByText("executor · Team Lead")).toBeNull();
    expect(within(orgSection).queryByText("executor · Child Title")).toBeNull();
    expect(orgSection.querySelector(".cc-team-org-card")).toBeTruthy();
    expect(orgSection.querySelector(".org-chart-node-card")).toBeNull();
    expect(within(heartbeatSection).getByRole("button", { name: /pause heartbeat/i })).toBeEnabled();
    expect(fetchOrgTreeMock).toHaveBeenCalledWith("project-a");
    expect(fetchExecutorStatsMock).toHaveBeenCalledWith("project-a");
  });

  it("keeps relocated team controls visible for loading, empty, error, and undefined-project states", async () => {
    apiMock.mockImplementationOnce(() => new Promise(() => undefined));
    fetchOrgTreeMock.mockResolvedValueOnce([]);
    const loading = render(<TeamArea range={range7d} />);
    expect(await screen.findByTestId("cc-team-org-chart")).toBeTruthy();
    expect(screen.getByTestId("cc-team-heartbeat")).toBeTruthy();
    expect(screen.getByText("No agents are reporting in yet.")).toBeTruthy();
    expect(fetchOrgTreeMock).toHaveBeenCalledWith(undefined);
    expect(fetchExecutorStatsMock).toHaveBeenCalledWith(undefined);
    loading.unmount();

    apiMock.mockResolvedValueOnce(emptyTeamFixture());
    fetchOrgTreeMock.mockRejectedValueOnce(new Error("org failed"));
    const empty = render(<TeamArea range={range7d} />);
    expect(await screen.findByTestId("cc-area-team-empty")).toBeTruthy();
    expect(within(screen.getByTestId("cc-team-org-chart")).getByRole("alert")).toHaveTextContent("org failed");
    empty.unmount();

    apiMock.mockRejectedValueOnce(new Error("team failed"));
    fetchOrgTreeMock.mockResolvedValueOnce([agentNode("agent-one", "One Agent")]);
    render(<TeamArea range={range7d} />);
    expect(await screen.findByTestId("cc-area-team-error")).toBeTruthy();
    expect(screen.getByTestId("cc-team-org-chart")).toBeTruthy();
    expect(screen.getByTestId("cc-team-heartbeat")).toBeTruthy();
  });

  it("toggles heartbeat and disables it when the AI engine is stopped", async () => {
    apiMock.mockResolvedValueOnce(emptyTeamFixture());
    fetchExecutorStatsMock.mockResolvedValueOnce({ globalPause: false, enginePaused: false, maxConcurrent: 3 });
    const running = render(<TeamArea range={range7d} projectId="project-a" />);
    fireEvent.click(await screen.findByRole("button", { name: /pause heartbeat/i }));
    expect(toggleEnginePauseMock).toHaveBeenCalledTimes(1);
    running.unmount();

    apiMock.mockResolvedValueOnce(emptyTeamFixture());
    fetchExecutorStatsMock.mockResolvedValueOnce({ globalPause: true, enginePaused: true, maxConcurrent: 3 });
    render(<TeamArea range={range7d} projectId="project-a" />);
    const resume = await screen.findByRole("button", { name: /resume heartbeat/i });
    expect(resume).toBeDisabled();
    expect(screen.getByText("Start the AI engine before resuming the heartbeat.")).toBeTruthy();
  });

  it("renders the per-agent pie for populated team analytics", async () => {
    apiMock.mockResolvedValue({
      ...populatedTeamFixture(),
      agents: [
        ...populatedTeamFixture().agents,
        {
          ...populatedTeamFixture().agents[0],
          agentId: "agent-beta",
          agentName: "Beta Agent",
          tokens: { ...populatedTeamFixture().agents[0].tokens, totalTokens: 500 },
          tasksCompleted: 1,
        },
      ],
    });
    render(<TeamArea range={range7d} />);

    await screen.findByTestId("cc-area-team");
    expect(screen.getByTestId("cc-team-pie")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Token share by agent" })).toBeTruthy();
    expect(screen.getByTestId("cc-team-tokens-chart")).toBeTruthy();
    expect(screen.getByTestId("cc-team-completed-chart")).toBeTruthy();
    expect(screen.getByTestId("cc-team-pie").textContent).not.toContain("NaN");
    expectRechartsWrapperWithin("cc-team-pie", "Token share by agent");
    expect(within(screen.getByTestId("cc-team-tokens-chart")).getByRole("list", { name: "Tokens by agent" }).classList).toContain("cc-bar-chart");
    expect(within(screen.getByTestId("cc-team-completed-chart")).getByRole("list", { name: "Tasks done by agent" }).classList).toContain("cc-bar-chart");
    expect(within(screen.getByTestId("cc-team-spread-chart")).getByRole("img", { name: "Team spread" }).classList).toContain("cc-sparkline");
    expectBarFillsFinite("cc-team-tokens-chart");
    expectBarFillsFinite("cc-team-completed-chart");
    expectSparklineHeightsFinite("cc-team-spread-chart");
  });

  it("renders a large comma-grouped total unchanged in the team total tokens stat", async () => {
    apiMock.mockResolvedValue(populatedTeamFixture(1_234_567_890));
    render(<TeamArea range={range7d} />);

    await screen.findByTestId("cc-area-team");
    expect(screen.getByTestId("cc-team-total-tokens").textContent).toContain("1,234,567,890");
  });

  it("keeps the team pie safe for single-item and non-finite data", async () => {
    apiMock.mockResolvedValue({
      ...populatedTeamFixture(),
      agents: [{ ...populatedTeamFixture().agents[0], tokens: { ...populatedTeamFixture().agents[0].tokens, totalTokens: Number.NaN } }],
    });
    render(<TeamArea range={range7d} />);

    await screen.findByTestId("cc-area-team");
    expect(screen.queryByTestId("cc-area-team-empty")).toBeNull();
    expect(screen.queryByTestId("cc-team-pie")).toBeNull();
    expect(screen.getByTestId("cc-area-team").textContent).not.toContain("NaN");
  });

  it("renders empty, loading, and error states without a team pie shell", async () => {
    apiMock.mockResolvedValueOnce(emptyTeamFixture());
    const empty = render(<TeamArea range={range7d} />);
    await screen.findByTestId("cc-area-team-empty");
    expect(screen.queryByTestId("cc-team-pie")).toBeNull();
    empty.unmount();

    apiMock.mockImplementationOnce(() => new Promise(() => undefined));
    const pending = render(<TeamArea range={range7d} />);
    expect(screen.getByTestId("cc-area-team-loading")).toBeTruthy();
    expect(screen.queryByTestId("cc-team-pie")).toBeNull();
    pending.unmount();

    apiMock.mockRejectedValueOnce(new Error("team failed"));
    render(<TeamArea range={range7d} />);
    await screen.findByTestId("cc-area-team-error");
    expect(screen.queryByTestId("cc-team-pie")).toBeNull();
  });
});

function pluginActivationFixture(overrides: Partial<{ activations: number; unavailable: boolean }> = {}) {
  const activations = overrides.activations ?? 0;
  const unavailable = overrides.unavailable ?? true;
  return {
    from: "2026-06-08",
    to: null,
    activations,
    byPlugin: unavailable ? [] : [{ pluginId: "fusion-plugin-example", count: activations }],
    unavailable,
  };
}

function mockEcosystemResponses(tokens: unknown, activations: unknown): void {
  apiMock.mockImplementation((path: string) => {
    if (path.startsWith("/command-center/plugin-activations")) return Promise.resolve(activations);
    return Promise.resolve(tokens);
  });
}

describe("EcosystemArea", () => {
  it("renders populated model pie and trend line without NaN", async () => {
    mockEcosystemResponses(tokenFixture(), pluginActivationFixture());
    render(<EcosystemArea range={range7d} />);

    await screen.findByTestId("cc-area-ecosystem");
    expect(screen.getByRole("list", { name: "Tasks per model" })).toBeTruthy();
    expect(screen.getByTestId("cc-ecosystem-pie")).toBeTruthy();
    expect(screen.getByTestId("cc-ecosystem-line")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Task share by model" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Ecosystem trend" })).toBeTruthy();
    expect(screen.getByTestId("cc-ecosystem-plugins-unavailable").textContent).toBe("—");
    expect(screen.getByTestId("cc-area-ecosystem").textContent).not.toContain("NaN");
  });

  it("renders the real plugin activation count only when activation data exists", async () => {
    mockEcosystemResponses(tokenFixture(), pluginActivationFixture({ activations: 12, unavailable: false }));
    render(<EcosystemArea range={range7d} />);

    await screen.findByTestId("cc-area-ecosystem");
    expect(screen.getByTestId("cc-ecosystem-plugins-value").textContent).toBe("12");
    expect(screen.queryByTestId("cc-ecosystem-plugins-unavailable")).toBeNull();
  });

  it("keeps the plugin sentinel for unavailable activation data and never renders 0", async () => {
    mockEcosystemResponses(tokenFixture(), pluginActivationFixture({ activations: 0, unavailable: true }));
    render(<EcosystemArea range={range7d} />);

    await screen.findByTestId("cc-area-ecosystem");
    expect(screen.getByTestId("cc-ecosystem-plugins-unavailable").textContent).toBe("—");
    expect(screen.queryByTestId("cc-ecosystem-plugins-value")).toBeNull();
  });

  it("does not show the empty state when activation data exists without model data", async () => {
    mockEcosystemResponses(
      { ...tokenFixture(), groups: [], series: [], totals: { ...tokenFixture().totals, totalTokens: 0, nTasks: 0 } },
      pluginActivationFixture({ activations: 1, unavailable: false }),
    );
    render(<EcosystemArea range={range7d} />);

    await screen.findByTestId("cc-area-ecosystem");
    expect(screen.queryByTestId("cc-area-ecosystem-empty")).toBeNull();
    expect(screen.getByTestId("cc-ecosystem-plugins-value").textContent).toBe("1");
  });

  it("renders empty, loading, and error states without ecosystem chart shells", async () => {
    apiMock.mockResolvedValueOnce({ ...tokenFixture(), groups: [], series: [], totals: { ...tokenFixture().totals, totalTokens: 0, nTasks: 0 } });
    const empty = render(<EcosystemArea range={range7d} />);
    await screen.findByTestId("cc-area-ecosystem-empty");
    expect(screen.queryByRole("list", { name: "Tasks per model" })).toBeNull();
    expect(screen.queryByTestId("cc-ecosystem-pie")).toBeNull();
    expect(screen.queryByTestId("cc-ecosystem-line")).toBeNull();
    empty.unmount();

    apiMock.mockImplementationOnce(() => new Promise(() => undefined));
    const pending = render(<EcosystemArea range={range7d} />);
    expect(screen.getByTestId("cc-area-ecosystem-loading")).toBeTruthy();
    expect(screen.queryByTestId("cc-ecosystem-pie")).toBeNull();
    expect(screen.queryByTestId("cc-ecosystem-line")).toBeNull();
    pending.unmount();

    apiMock.mockRejectedValueOnce(new Error("ecosystem failed"));
    render(<EcosystemArea range={range7d} />);
    await screen.findByTestId("cc-area-ecosystem-error");
    expect(screen.queryByTestId("cc-ecosystem-pie")).toBeNull();
    expect(screen.queryByTestId("cc-ecosystem-line")).toBeNull();
  });

  it("keeps ecosystem recharts safe for single-item and non-finite data", async () => {
    apiMock.mockResolvedValue({
      ...tokenFixture(),
      groups: [{ ...tokenFixture().groups[0], nTasks: Number.NaN }],
      series: [{ ...tokenFixture().series[0], totalTokens: Number.POSITIVE_INFINITY, nTasks: -1 }],
    });
    render(<EcosystemArea range={range7d} />);

    await screen.findByTestId("cc-area-ecosystem");
    expect(screen.queryByTestId("cc-ecosystem-pie")).toBeNull();
    expect(screen.getByTestId("cc-ecosystem-line")).toBeTruthy();
    expect(screen.getByTestId("cc-area-ecosystem").textContent).not.toContain("NaN");
    expect(screen.getByTestId("cc-area-ecosystem").textContent).not.toContain("Infinity");
  });
});

describe("GithubArea", () => {
  it("renders filed/fixed/net stats, daily trend, and by-repo bars", async () => {
    apiMock.mockResolvedValue(githubFixture());
    render(<GithubArea range={range7d} />);

    await screen.findByTestId("cc-area-github");
    expect(screen.getByTestId("cc-github-filed").textContent).toContain("5");
    expect(screen.getByTestId("cc-github-fixed").textContent).toContain("3");
    expect(screen.getByTestId("cc-github-net").textContent).toContain("2");
    expect(screen.getByTestId("cc-github-pie")).toBeTruthy();
    expect(screen.getByTestId("cc-github-line")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Filed vs fixed share" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Filed vs fixed line" })).toBeTruthy();
    expect(screen.getByTestId("cc-github-daily-trend")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Filed" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Fixed" })).toBeTruthy();
    const repoChart = screen.getByRole("list", { name: "By repository" });
    expect(within(repoChart).getByText("acme/alpha")).toBeTruthy();
    expect(within(repoChart).getByLabelText("acme/alpha: 4 filed / 1 fixed")).toBeTruthy();
  });

  it("renders the empty state without empty chart shells", async () => {
    apiMock.mockResolvedValue({ ...githubFixture(), filed: 0, fixed: 0, net: 0, daily: [], byRepo: [] });
    render(<GithubArea range={range7d} />);

    await screen.findByTestId("cc-area-github");
    expect(screen.getByTestId("cc-area-github").textContent).toContain("No GitHub issue activity");
    expect(screen.getByTestId("cc-github-backfill-button")).toBeTruthy();
    expect(screen.queryByTestId("cc-github-pie")).toBeNull();
    expect(screen.queryByTestId("cc-github-line")).toBeNull();
    expect(screen.queryByTestId("cc-github-daily-trend")).toBeNull();
    expect(screen.queryByTestId("cc-github-by-repo")).toBeNull();
  });

  it("renders loading and error states", async () => {
    apiMock.mockImplementationOnce(() => new Promise(() => undefined));
    const { unmount } = render(<GithubArea range={range7d} />);
    expect(screen.getByTestId("cc-area-github-loading")).toBeTruthy();
    expect(screen.queryByTestId("cc-github-pie")).toBeNull();
    expect(screen.queryByTestId("cc-github-line")).toBeNull();
    unmount();

    apiMock.mockRejectedValueOnce(new Error("github failed"));
    render(<GithubArea range={range7d} />);
    await screen.findByTestId("cc-area-github-error");
    expect(screen.getByTestId("cc-area-github-error").textContent).toContain("github failed");
    expect(screen.queryByTestId("cc-github-pie")).toBeNull();
    expect(screen.queryByTestId("cc-github-line")).toBeNull();
  });

  it("handles undefined chart arrays and zero values without NaN output", async () => {
    apiMock.mockResolvedValue({ ...githubFixture(), filed: 1, fixed: 0, net: 1, daily: undefined, byRepo: undefined });
    render(<GithubArea range={range7d} />);

    await screen.findByTestId("cc-area-github");
    expect(screen.getByTestId("cc-github-pie")).toBeTruthy();
    expect(screen.queryByTestId("cc-github-line")).toBeNull();
    expect(screen.queryByTestId("cc-github-daily-trend")).toBeNull();
    expect(screen.queryByTestId("cc-github-by-repo")).toBeNull();
    expect(screen.getByTestId("cc-area-github").textContent).not.toContain("NaN");
  });

  it("keeps GitHub recharts safe for single-item and non-finite daily data", async () => {
    apiMock.mockResolvedValue({
      ...githubFixture(),
      filed: 1,
      fixed: 1,
      net: 0,
      daily: [{ date: "2026-06-08", filed: Number.NaN, fixed: Number.POSITIVE_INFINITY }],
      byRepo: [{ repo: "acme/broken", filed: Number.NaN, fixed: -1 }],
    });
    render(<GithubArea range={range7d} />);

    await screen.findByTestId("cc-area-github");
    expect(screen.getByTestId("cc-github-pie")).toBeTruthy();
    expect(screen.getByTestId("cc-github-line")).toBeTruthy();
    expect(screen.getByTestId("cc-area-github").textContent).not.toContain("NaN");
    expect(screen.getByTestId("cc-area-github").textContent).not.toContain("Infinity");
  });

  it("rejects an inverted custom range client-side without fetching", async () => {
    render(<GithubArea range={customRange("2026-06-10", "2026-06-01")} />);
    await waitFor(() => expect(apiMock).not.toHaveBeenCalled());
  });

  it("runs a single backfill batch and renders accumulated result counts", async () => {
    apiMock.mockResolvedValue(githubFixture());
    backfillGithubSourceIssueClosedAtMock.mockResolvedValueOnce({
      scanned: 4,
      filled: 2,
      skipped: 1,
      errors: 0,
      hasMore: false,
    });

    render(<GithubArea range={range7d} />);
    await screen.findByTestId("cc-area-github");

    fireEvent.click(screen.getByTestId("cc-github-backfill-button"));

    await screen.findByText(/Backfill complete/i);
    expect(backfillGithubSourceIssueClosedAtMock).toHaveBeenCalledWith({ offset: 0, limit: 100 }, undefined);
    const result = screen.getByTestId("cc-github-backfill-result");
    expect(result.textContent).toContain("Scanned 4, filled 2, skipped 1, errors 0");
  });

  it("paginates multi-batch backfills with advancing offsets and summed counts", async () => {
    apiMock.mockResolvedValue(githubFixture());
    backfillGithubSourceIssueClosedAtMock
      .mockResolvedValueOnce({ scanned: 100, filled: 4, skipped: 90, errors: 1, hasMore: true })
      .mockResolvedValueOnce({ scanned: 25, filled: 3, skipped: 22, errors: 0, hasMore: false });

    render(<GithubArea range={range7d} />);
    await screen.findByTestId("cc-area-github");
    fireEvent.click(screen.getByTestId("cc-github-backfill-button"));

    await waitFor(() => expect(backfillGithubSourceIssueClosedAtMock).toHaveBeenCalledTimes(2));
    expect(backfillGithubSourceIssueClosedAtMock).toHaveBeenNthCalledWith(1, { offset: 0, limit: 100 }, undefined);
    expect(backfillGithubSourceIssueClosedAtMock).toHaveBeenNthCalledWith(2, { offset: 100, limit: 100 }, undefined);
    const result = await screen.findByTestId("cc-github-backfill-result");
    expect(result.textContent).toContain("Scanned 125, filled 7, skipped 112, errors 1");
    expect(result.className).toContain("cc-github-backfill-status--error");
  });

  it("shows the all-zero backfill as nothing to backfill instead of an error", async () => {
    apiMock.mockResolvedValue(githubFixture());
    backfillGithubSourceIssueClosedAtMock.mockResolvedValueOnce({
      scanned: 0,
      filled: 0,
      skipped: 0,
      errors: 0,
      hasMore: false,
    });

    render(<GithubArea range={range7d} />);
    await screen.findByTestId("cc-area-github");
    fireEvent.click(screen.getByTestId("cc-github-backfill-button"));

    const result = await screen.findByTestId("cc-github-backfill-result");
    expect(result.textContent).toContain("Nothing to backfill");
    expect(result.className).not.toContain("cc-github-backfill-status--error");
  });

  it("surfaces nonzero backfill error counts without throwing", async () => {
    apiMock.mockResolvedValue(githubFixture());
    backfillGithubSourceIssueClosedAtMock.mockResolvedValueOnce({
      scanned: 8,
      filled: 1,
      skipped: 5,
      errors: 2,
      hasMore: false,
    });

    render(<GithubArea range={range7d} />);
    await screen.findByTestId("cc-area-github");
    fireEvent.click(screen.getByTestId("cc-github-backfill-button"));

    const result = await screen.findByTestId("cc-github-backfill-result");
    expect(result.textContent).toContain("errors 2");
    expect(result.className).toContain("cc-github-backfill-status--error");
  });

  it("captures endpoint failures in local error UI", async () => {
    apiMock.mockResolvedValue(githubFixture());
    backfillGithubSourceIssueClosedAtMock.mockRejectedValueOnce(new Error("endpoint failed"));

    render(<GithubArea range={range7d} />);
    await screen.findByTestId("cc-area-github");
    fireEvent.click(screen.getByTestId("cc-github-backfill-button"));

    const result = await screen.findByTestId("cc-github-backfill-result");
    expect(result.textContent).toContain("endpoint failed");
    expect(result.className).toContain("cc-github-backfill-status--error");
  });

  it("disables and guards the button while a backfill is in flight", async () => {
    apiMock.mockResolvedValue(githubFixture());
    let resolveBackfill: ((value: { scanned: number; filled: number; skipped: number; errors: number; hasMore: boolean }) => void) | null = null;
    backfillGithubSourceIssueClosedAtMock.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveBackfill = resolve;
      }),
    );

    render(<GithubArea range={range7d} />);
    await screen.findByTestId("cc-area-github");
    const button = screen.getByTestId("cc-github-backfill-button") as HTMLButtonElement;
    fireEvent.click(button);

    await waitFor(() => expect(button.disabled).toBe(true));
    fireEvent.click(button);
    expect(backfillGithubSourceIssueClosedAtMock).toHaveBeenCalledTimes(1);

    resolveBackfill?.({ scanned: 1, filled: 1, skipped: 0, errors: 0, hasMore: false });
    await screen.findByText(/Backfill complete/i);
  });

  it("stops a pathological always-has-more response at the max iteration guard", async () => {
    apiMock.mockResolvedValue(githubFixture());
    backfillGithubSourceIssueClosedAtMock.mockResolvedValue({
      scanned: 1,
      filled: 0,
      skipped: 1,
      errors: 0,
      hasMore: true,
    });

    render(<GithubArea range={range7d} />);
    await screen.findByTestId("cc-area-github");
    fireEvent.click(screen.getByTestId("cc-github-backfill-button"));

    const result = await screen.findByText(/safety limit/i);
    expect(result.textContent).toContain("safety limit");
    expect(backfillGithubSourceIssueClosedAtMock).toHaveBeenCalledTimes(1000);
    expect(screen.getByTestId("cc-github-backfill-result").textContent).toContain("Scanned 1000");
  });
});

// FN-6684 Mission Control decision: no extra pie/line test here because MissionControlPanel already renders the live SDLC Funnel for its only quantitative distribution; adding a pie would duplicate that affordance.
describe("SignalsArea", () => {
  it("renders the empty state (not an error) when the signals endpoint is missing", async () => {
    apiMock.mockRejectedValue(new Error("API returned HTML instead of JSON (404)"));
    render(<SignalsArea range={range7d} />);
    await screen.findByTestId("cc-area-signals-empty");
    // Must not surface the error UI.
    expect(screen.queryByTestId("cc-area-signals-error")).toBeNull();
    expect(screen.queryByTestId("cc-signals-pie")).toBeNull();
  });

  it("renders signal metrics and status pie when data is present", async () => {
    apiMock.mockResolvedValue({
      totalSignals: 8,
      open: 3,
      resolved: 5,
      mttr: { value: 42, unavailable: false },
      bySource: [{ source: "sentry", count: 8 }],
      bySeverity: [{ severity: "error", count: 8 }],
    });
    render(<SignalsArea range={range7d} />);
    await screen.findByTestId("cc-area-signals");
    expect(screen.getByTestId("cc-signals-total").textContent).toContain("8");
    expect(screen.getByTestId("cc-signals-mttr").textContent).toContain("42");
    expect(screen.getByTestId("cc-signals-pie")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Signal status share" })).toBeTruthy();
  });

  it("keeps signals pie safe for single-item and non-finite source/severity data", async () => {
    apiMock.mockResolvedValue({
      totalSignals: 1,
      open: 1,
      resolved: 0,
      mttr: { value: null, unavailable: true },
      bySource: [{ source: "broken", count: Number.NaN }],
      bySeverity: [{ severity: "broken", count: Number.POSITIVE_INFINITY }],
    });
    render(<SignalsArea range={range7d} />);
    await screen.findByTestId("cc-area-signals");
    expect(screen.getByTestId("cc-signals-pie")).toBeTruthy();
    expect(screen.getByTestId("cc-area-signals").textContent).not.toContain("NaN");
    expect(screen.getByTestId("cc-area-signals").textContent).not.toContain("Infinity");
  });

  it("renders settled zero signals without a pie shell", async () => {
    apiMock.mockResolvedValue({
      totalSignals: 0,
      open: 0,
      resolved: 0,
      mttr: { value: null, unavailable: true },
      bySource: [],
      bySeverity: [],
    });
    render(<SignalsArea range={range7d} />);
    await screen.findByTestId("cc-area-signals-empty");
    expect(screen.queryByTestId("cc-signals-pie")).toBeNull();
  });
});
