/*
FNXC:CommandCenter 2026-06-16-09:42:
Command Center area component tests (PR #1683). Pin loading/error/unavailable-vs-zero rendering for each analytics area against mocked fixtures so the "—" sentinel and cost-unavailable contracts can't regress.

FNXC:CommandCenter 2026-06-25-00:00:
FN-7044 split shared fixtures into areas.test-harness.tsx so this suite can be partitioned into focused sibling files under the 2000-line hard cap without losing coverage.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, act, renderHook } from "@testing-library/react";

// Mock the api() helper so the areas fetch deterministic fixtures.
const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  backfillGithubSourceIssueClosedAt: vi.fn(),
  backfillCommitAssociationDiffStats: vi.fn(),
  fetchOrgTree: vi.fn(),
  fetchExecutorStats: vi.fn(),
  fetchSettings: vi.fn(),
  updateSettings: vi.fn(),
  toggleEnginePause: vi.fn(),
  appSettings: { globalPaused: false, enginePaused: false },
}));
const apiMock = mocks.api;
const backfillGithubSourceIssueClosedAtMock = mocks.backfillGithubSourceIssueClosedAt;
const backfillCommitAssociationDiffStatsMock = mocks.backfillCommitAssociationDiffStats;
const fetchOrgTreeMock = mocks.fetchOrgTree;
const fetchExecutorStatsMock = mocks.fetchExecutorStats;
const toggleEnginePauseMock = mocks.toggleEnginePause;
const appSettingsMock = mocks.appSettings;
vi.mock("../../../../api/legacy", () => ({
  api: (path: string, opts?: RequestInit) => mocks.api(path, opts),
  withProjectId: (path: string, projectId?: string) =>
    projectId ? `${path}${path.includes("?") ? "&" : "?"}projectId=${encodeURIComponent(projectId)}` : path,
  apiBackfillGithubSourceIssueClosedAt: (options?: { offset?: number; limit?: number }, projectId?: string) =>
    mocks.backfillGithubSourceIssueClosedAt(options, projectId),
  backfillCommitAssociationDiffStats: (options?: { dryRun?: boolean }, projectId?: string) =>
    mocks.backfillCommitAssociationDiffStats(options, projectId),
  fetchOrgTree: mocks.fetchOrgTree,
  fetchExecutorStats: mocks.fetchExecutorStats,
  fetchSettings: mocks.fetchSettings,
  updateSettings: mocks.updateSettings,
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
import { TeamArea } from "../TeamArea";
import { ActivityArea } from "../ActivityArea";
import { EcosystemArea } from "../EcosystemArea";
import { useAnalyticsArea } from "../useAnalyticsArea";
import { ConfirmDialogProvider } from "../../../../hooks/useConfirm";
import { formatCost, rangeQuery } from "../areaShared";
import { defaultPresets, rangeFromPreset } from "../../DateRangePicker";
import {
  activityFixture,
  agentNode,
  customRange,
  emptyTeamFixture,
  expectBarFillsFinite,
  expectRechartsWrapperWithin,
  expectSparklineHeightsFinite,
  expectSvgLineFillsBoxAndKeepsRoundMarkers,
  expectSvgLinePointsInsideViewBox,
  installElementClientWidth,
  pluginActivationFixture,
  populatedTeamFixture,
  productivityFixture,
  providerIconIn,
  range7d,
  tokenFixture,
} from "./areas.test-harness";

describe("Command Center cost formatting", () => {
  it("shows priced subtotals when only part of the usage has known pricing", () => {
    expect(formatCost(911.39004125, true)).toBe("$911.39+");
    expect(formatCost(12.5, false)).toBe("$12.50");
    expect(formatCost(0, false)).toBe("$0.00");
    expect(formatCost(0, true)).toBe("—");
    expect(formatCost(null, true)).toBe("—");
  });
});

beforeEach(() => {
  apiMock.mockReset();
  backfillGithubSourceIssueClosedAtMock.mockReset();
  backfillCommitAssociationDiffStatsMock.mockReset();
  fetchOrgTreeMock.mockReset();
  fetchOrgTreeMock.mockResolvedValue([]);
  fetchExecutorStatsMock.mockReset();
  fetchExecutorStatsMock.mockResolvedValue({
    globalPause: false,
    enginePaused: false,
    maxConcurrent: 2,
    lastActivityAt: "2026-06-19T12:00:00.000Z",
  });
  mocks.fetchSettings.mockReset();
  mocks.fetchSettings.mockResolvedValue({ heartbeatMultiplier: 1 });
  mocks.updateSettings.mockReset();
  mocks.updateSettings.mockResolvedValue({});
  toggleEnginePauseMock.mockReset();
  appSettingsMock.globalPaused = false;
  appSettingsMock.enginePaused = false;
});

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
  window.dispatchEvent(new Event("resize"));
});


describe("rangeQuery / rangeFromPreset", () => {
  it("serializes every default preset into a distinct server-resolvable query", () => {
    vi.useFakeTimers({ now: new Date("2026-06-15T12:00:00.000Z") });
    const presets = defaultPresets((_key, fallback) => fallback);
    const queries = Object.fromEntries(presets.map((preset) => [preset.id, rangeQuery(rangeFromPreset(preset))]));

    expect(queries).toEqual({
      "24h": "?from=2026-06-14",
      "7d": "?from=2026-06-08",
      "30d": "?from=2026-05-16",
      all: "?to=2026-06-15T12%3A00%3A00.000Z",
    });
    expect(new Set(Object.values(queries)).size).toBe(presets.length);
  });

  it("preserves custom and open-ended custom ranges without collapsing them", () => {
    expect(rangeQuery(customRange("2026-06-01", "2026-06-10"))).toBe("?from=2026-06-01&to=2026-06-10");
    expect(rangeQuery({ from: "2026-06-01", to: null, preset: "custom" })).toBe("?from=2026-06-01");
    expect(rangeQuery({ from: null, to: "2026-06-10", preset: "custom" })).toBe("?to=2026-06-10");
  });
});

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

  it("appends projectId to the request path when supplied, and omits it when not", async () => {
    apiMock.mockResolvedValue({ ok: true });

    const { rerender } = renderHook(
      ({ projectId }: { projectId?: string }) =>
        useAnalyticsArea<{ ok: boolean }>("/command-center/tokens", range7d, { projectId }),
      { initialProps: { projectId: undefined as string | undefined } },
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(apiMock.mock.calls.at(-1)?.[0]).toBe("/command-center/tokens?from=2026-06-08");

    rerender({ projectId: "proj-123" });
    await act(async () => {
      await Promise.resolve();
    });
    expect(apiMock.mock.calls.at(-1)?.[0]).toBe("/command-center/tokens?from=2026-06-08&projectId=proj-123");
  });

  it("refetches with distinct request keys for each default preset", async () => {
    vi.useFakeTimers({ now: new Date("2026-06-15T12:00:00.000Z") });
    apiMock.mockResolvedValue({ ok: true });
    const presets = defaultPresets((_key, fallback) => fallback);
    const ranges = presets.map(rangeFromPreset);

    const { rerender } = renderHook(
      ({ range }) => useAnalyticsArea<{ ok: boolean }>("/command-center/tokens", range),
      { initialProps: { range: ranges[0] as DateRange } },
    );

    await act(async () => {
      await Promise.resolve();
    });
    for (const range of ranges.slice(1)) {
      rerender({ range });
      await act(async () => {
        await Promise.resolve();
      });
    }

    expect(apiMock.mock.calls.map(([path]) => path)).toEqual([
      "/command-center/tokens?from=2026-06-14",
      "/command-center/tokens?from=2026-06-08",
      "/command-center/tokens?from=2026-05-16",
      "/command-center/tokens?to=2026-06-15T12%3A00%3A00.000Z",
    ]);
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

  it("treats poll refreshes as background revalidation after data has loaded", async () => {
    vi.useFakeTimers();
    let resolvePoll: ((value: { ok: boolean; total: number }) => void) | null = null;
    apiMock
      .mockResolvedValueOnce({ ok: true, total: 1 })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolvePoll = resolve;
          }),
      );

    const { result } = renderHook(() =>
      useAnalyticsArea<{ ok: boolean; total: number }>("/command-center/tokens", range7d, { pollMs: 1_000 }),
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.data?.total).toBe(1);
    expect(result.current.isLoading).toBe(false);

    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    });
    expect(apiMock).toHaveBeenCalledTimes(2);
    expect(resolvePoll).not.toBeNull();
    expect(result.current.data?.total).toBe(1);
    expect(result.current.isLoading).toBe(false);

    await act(async () => {
      resolvePoll?.({ ok: true, total: 2 });
      await Promise.resolve();
    });
    expect(result.current.data?.total).toBe(2);
  });

  it("cleans up polling when a valid range becomes invalid and restarts after it becomes valid", async () => {
    vi.useFakeTimers();
    apiMock.mockResolvedValue({ ok: true });

    const { rerender } = renderHook(
      ({ range }) => useAnalyticsArea<{ ok: boolean }>("/command-center/tokens", range, { pollMs: 1_000 }),
      { initialProps: { range: range7d } },
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(apiMock).toHaveBeenCalledTimes(1);

    rerender({ range: customRange("2026-06-10", "2026-06-01") });
    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await Promise.resolve();
    });
    expect(apiMock).toHaveBeenCalledTimes(1);

    rerender({ range: customRange("2026-06-01", "2026-06-10") });
    await act(async () => {
      await Promise.resolve();
    });
    expect(apiMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    });
    expect(apiMock).toHaveBeenCalledTimes(3);
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
    expectSvgLineFillsBoxAndKeepsRoundMarkers("cc-activity-line-messages", "Messages / day");
    expectSvgLinePointsInsideViewBox("cc-activity-line-agents", "Active agents / day");
    expectSvgLineFillsBoxAndKeepsRoundMarkers("cc-activity-line-agents", "Active agents / day");
    expectSvgLinePointsInsideViewBox("cc-activity-line-nodes", "Active nodes / day");
    expectSvgLineFillsBoxAndKeepsRoundMarkers("cc-activity-line-nodes", "Active nodes / day");
    expectSvgLinePointsInsideViewBox("cc-activity-line-throughput", "Throughput / day");
    expectSvgLineFillsBoxAndKeepsRoundMarkers("cc-activity-line-throughput", "Throughput / day");
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
    const tokensBar = screen.getByRole("list", { name: "Tokens by model" }) as HTMLElement;
    expect(providerIconIn(tokensBar, "openai")).toBeTruthy();
    expect(providerIconIn(tokensBar, "anthropic")).toBeTruthy();
    expect(screen.getByRole("img", { name: "openai gpt-4o: 900" })).toBeTruthy();
    expect(providerIconIn(screen.getByTestId("cc-tokens-pie"), "openai")).toBeNull();
    expect(providerIconIn(screen.getByTestId("cc-tokens-pie"), "anthropic")).toBeNull();
    expect(providerIconIn(screen.getByTestId("cc-tokens-row-gpt-4o"), "openai")).toBeTruthy();
    expect(providerIconIn(screen.getByTestId("cc-tokens-row-claude-sonnet"), "anthropic")).toBeTruthy();
  });

  it("renders providerless and unknown model rows correctly", async () => {
    apiMock.mockResolvedValue({
      ...tokenFixture(),
      totals: { ...tokenFixture().totals, totalTokens: 75, nTasks: 2 },
      groups: [
        { ...tokenFixture().groups[0], key: "legacy-model", totalTokens: 50, nTasks: 1 },
        { ...tokenFixture().groups[1], key: null, totalTokens: 25, nTasks: 1 },
      ],
    });
    render(<TokensArea range={range7d} />);

    await screen.findByTestId("cc-area-tokens");
    expect(screen.getByRole("img", { name: "legacy-model: 50" })).toBeTruthy();

    const legacyRow = screen.getByTestId("cc-tokens-row-legacy-model");
    const unknownRow = screen.getByTestId("cc-tokens-row-unknown");
    expect(legacyRow.textContent).toContain("legacy-model");
    expect(unknownRow.textContent).toContain("(unknown)");
    expect(providerIconIn(legacyRow, "legacy-model")).toBeTruthy();
    expect(providerIconIn(unknownRow, "")).toBeTruthy();
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
    let resolvePoll: ((value: ReturnType<typeof tokenFixture>) => void) | null = null;
    apiMock
      .mockResolvedValueOnce(tokenFixture())
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolvePoll = resolve;
          }),
      );

    render(<TokensArea range={range7d} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("cc-tokens-total").textContent).toContain("1,500");
    expect(screen.getByLabelText("2026-06-09: 900")).toBeTruthy();
    expect(screen.getByTestId("cc-tokens-row-gpt-4o").textContent).toContain("900");

    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
    });
    expect(resolvePoll).not.toBeNull();
    expect(screen.queryByTestId("cc-area-tokens-loading")).toBeNull();
    expect(screen.getByTestId("cc-tokens-total").textContent).toContain("1,500");
    expect(screen.getByTestId("cc-token-series-chart")).toBeTruthy();

    const updated = {
      ...tokenFixture(1_900),
      series: [
        tokenFixture().series[0],
        { ...tokenFixture().series[1], totalTokens: 1_300, inputTokens: 900, outputTokens: 400 },
      ],
      groups: [
        { ...tokenFixture().groups[0], totalTokens: 1_100, inputTokens: 700, outputTokens: 300 },
        { ...tokenFixture().groups[1], totalTokens: 800, inputTokens: 500, outputTokens: 200 },
      ],
    };
    await act(async () => {
      resolvePoll?.(updated);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("cc-tokens-total").textContent).toContain("1,900");
    expect(screen.getByLabelText("2026-06-09: 1,300")).toBeTruthy();
    expect(screen.getByTestId("cc-tokens-row-gpt-4o").textContent).toContain("1,100");
    expect(screen.getByTestId("cc-tokens-line")).toBeTruthy();
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
  function renderProductivityWithConfirm() {
    return render(
      <ConfirmDialogProvider>
        <ProductivityArea range={range7d} />
      </ConfirmDialogProvider>,
    );
  }

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
      taskDurationTrend: [
        {
          bucket: "2026-06-08",
          completedTasks: 1,
          averageMs: 3_600_000,
          medianMs: 3_600_000,
          unavailable: false,
        },
        {
          bucket: "2026-06-09",
          completedTasks: 2,
          averageMs: 6_300_000,
          medianMs: 6_300_000,
          unavailable: false,
        },
      ],
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
    const durationTrend = screen.getByRole("img", { name: "Task duration over time" });
    expect(durationTrend).toBeTruthy();
    expect(durationTrend.getAttribute("data-responsive-width")).toBe("100%");
    expect(screen.getByTestId("cc-productivity-duration-trend").textContent).toContain("Average");
    expect(screen.getByTestId("cc-productivity-duration-trend").textContent).toContain("Median");
    expect(screen.getByTestId("cc-productivity-duration-trend").textContent).not.toContain("NaN");
    expect(screen.getByTestId("cc-productivity-duration-trend").textContent).not.toContain("Infinity");
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
      taskDurationTrend: [],
    });
    const { unmount } = render(<ProductivityArea range={range7d} />);
    await screen.findByTestId("cc-area-productivity-empty");
    expect(screen.queryByRole("list", { name: "Files by language" })).toBeNull();
    expect(screen.queryByTestId("cc-productivity-pie")).toBeNull();
    expect(screen.queryByTestId("cc-productivity-duration-avg")).toBeNull();
    expect(screen.queryByTestId("cc-productivity-duration-trend")).toBeNull();
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
    expect(screen.queryByTestId("cc-productivity-duration-trend")).toBeNull();
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
      taskDurationTrend: [
        {
          bucket: "2026-06-08",
          completedTasks: 0,
          averageMs: null,
          medianMs: null,
          unavailable: true,
        },
        {
          bucket: "2026-06-09",
          completedTasks: 1,
          averageMs: Number.NaN,
          medianMs: Number.POSITIVE_INFINITY,
          unavailable: false,
        },
      ],
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
    expect(screen.queryByTestId("cc-productivity-duration-trend")).toBeNull();
    expect(screen.getByTestId("cc-area-productivity").textContent).not.toContain("NaN");
    expect(screen.getByTestId("cc-area-productivity").textContent).not.toContain("Infinity");
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
    expect(screen.queryByTestId("cc-productivity-duration-trend")).toBeNull();
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

  it("previews LOC backfill with dry-run counts and preserves the LOC sentinel", async () => {
    apiMock.mockResolvedValue(productivityFixture());
    backfillCommitAssociationDiffStatsMock.mockResolvedValueOnce({
      scannedRows: 6,
      distinctCommits: 4,
      updatedRows: 3,
      skippedUnavailableCommits: 2,
      skippedInvalidShas: 1,
      dryRun: true,
    });

    renderProductivityWithConfirm();
    await screen.findByTestId("cc-area-productivity");
    expect(screen.queryByTestId("cc-productivity-backfill-apply-button")).toBeNull();
    expect(screen.getByTestId("cc-productivity-loc-unavailable").textContent).toBe("—");

    fireEvent.click(screen.getByTestId("cc-productivity-backfill-button"));

    await waitFor(() => expect(backfillCommitAssociationDiffStatsMock).toHaveBeenCalledWith({ dryRun: true }, undefined));
    const result = await screen.findByTestId("cc-productivity-backfill-result");
    expect(result.textContent).toContain("Dry-run preview");
    expect(result.textContent).toContain("Scanned rows: 6");
    expect(result.textContent).toContain("Distinct commits: 4");
    expect(result.textContent).toContain("Updated rows: 3");
    expect(result.textContent).toContain("Skipped unavailable commits: 2");
    expect(result.textContent).toContain("Skipped invalid SHAs: 1");
    expect(screen.getByTestId("cc-productivity-backfill-apply-button")).toBeTruthy();
    expect(screen.getByTestId("cc-productivity-loc-unavailable").textContent).toBe("—");
  });

  it("requires confirmation before applying the LOC backfill and aborts cleanly on cancel", async () => {
    apiMock.mockResolvedValue(productivityFixture());
    backfillCommitAssociationDiffStatsMock.mockResolvedValueOnce({
      scannedRows: 2,
      distinctCommits: 2,
      updatedRows: 2,
      skippedUnavailableCommits: 0,
      skippedInvalidShas: 0,
      dryRun: true,
    });

    renderProductivityWithConfirm();
    await screen.findByTestId("cc-area-productivity");
    fireEvent.click(screen.getByTestId("cc-productivity-backfill-button"));
    await screen.findByTestId("cc-productivity-backfill-apply-button");

    fireEvent.click(screen.getByTestId("cc-productivity-backfill-apply-button"));
    const dialog = await screen.findByRole("dialog", { name: "Apply LOC backfill?" });
    expect(dialog.textContent).toContain("task_commit_associations");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Apply LOC backfill?" })).toBeNull());
    expect(backfillCommitAssociationDiffStatsMock).toHaveBeenCalledTimes(1);
  });

  it("applies the LOC backfill only after the danger confirmation resolves", async () => {
    apiMock.mockResolvedValue(productivityFixture());
    backfillCommitAssociationDiffStatsMock
      .mockResolvedValueOnce({
        scannedRows: 5,
        distinctCommits: 4,
        updatedRows: 3,
        skippedUnavailableCommits: 1,
        skippedInvalidShas: 0,
        dryRun: true,
      })
      .mockResolvedValueOnce({
        scannedRows: 5,
        distinctCommits: 4,
        updatedRows: 3,
        skippedUnavailableCommits: 1,
        skippedInvalidShas: 0,
        dryRun: false,
      });

    renderProductivityWithConfirm();
    await screen.findByTestId("cc-area-productivity");
    fireEvent.click(screen.getByTestId("cc-productivity-backfill-button"));
    await screen.findByText("Dry-run preview");

    fireEvent.click(screen.getByTestId("cc-productivity-backfill-apply-button"));
    const dialog = await screen.findByRole("dialog", { name: "Apply LOC backfill?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply backfill" }));

    await waitFor(() => expect(backfillCommitAssociationDiffStatsMock).toHaveBeenNthCalledWith(2, { dryRun: false }, undefined));
    const result = await screen.findByTestId("cc-productivity-backfill-result");
    expect(result.textContent).toContain("Applied");
    expect(result.textContent).toContain("Updated rows: 3");
  });

  it("disables the preview button and shows pending status while LOC backfill is in flight", async () => {
    apiMock.mockResolvedValue(productivityFixture());
    let resolveBackfill: ((value: { scannedRows: number; distinctCommits: number; updatedRows: number; skippedUnavailableCommits: number; skippedInvalidShas: number; dryRun: boolean }) => void) | null = null;
    backfillCommitAssociationDiffStatsMock.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveBackfill = resolve;
      }),
    );

    renderProductivityWithConfirm();
    await screen.findByTestId("cc-area-productivity");
    const button = screen.getByTestId("cc-productivity-backfill-button") as HTMLButtonElement;
    fireEvent.click(button);

    await waitFor(() => expect(button.disabled).toBe(true));
    expect(screen.getByTestId("cc-productivity-backfill-result").textContent).toContain("LOC backfill check is running.");
    expect(screen.getByTestId("cc-productivity-backfill-result").className).toContain("cc-productivity-backfill-status--warning");
    fireEvent.click(button);
    expect(backfillCommitAssociationDiffStatsMock).toHaveBeenCalledTimes(1);

    resolveBackfill?.({
      scannedRows: 1,
      distinctCommits: 1,
      updatedRows: 1,
      skippedUnavailableCommits: 0,
      skippedInvalidShas: 0,
      dryRun: true,
    });
    await screen.findByText("Dry-run preview");
  });

  it("renders endpoint errors with the tokenized error status", async () => {
    apiMock.mockResolvedValue(productivityFixture());
    backfillCommitAssociationDiffStatsMock.mockRejectedValueOnce(new Error("loc endpoint failed"));

    renderProductivityWithConfirm();
    await screen.findByTestId("cc-area-productivity");
    fireEvent.click(screen.getByTestId("cc-productivity-backfill-button"));

    const result = await screen.findByTestId("cc-productivity-backfill-result");
    expect(result.textContent).toContain("loc endpoint failed");
    expect(result.className).toContain("cc-productivity-backfill-status--error");
  });

  it("renders an all-zero LOC backfill report truthfully", async () => {
    apiMock.mockResolvedValue(productivityFixture());
    backfillCommitAssociationDiffStatsMock.mockResolvedValueOnce({
      scannedRows: 0,
      distinctCommits: 0,
      updatedRows: 0,
      skippedUnavailableCommits: 0,
      skippedInvalidShas: 0,
      dryRun: true,
    });

    renderProductivityWithConfirm();
    await screen.findByTestId("cc-area-productivity");
    fireEvent.click(screen.getByTestId("cc-productivity-backfill-button"));

    const result = await screen.findByTestId("cc-productivity-backfill-result");
    expect(result.textContent).toContain("Scanned rows: 0");
    expect(result.textContent).toContain("Distinct commits: 0");
    expect(result.textContent).toContain("Updated rows: 0");
    expect(result.textContent).toContain("Skipped unavailable commits: 0");
    expect(result.textContent).toContain("Skipped invalid SHAs: 0");
  });

  it("keeps LOC backfill mobile actions stacked and full width in CSS", () => {
    const css = readFileSync(join(process.cwd(), "app/components/command-center/CommandCenter.css"), "utf8");
    expect(css).toMatch(/@media \(max-width: 768px\)[\s\S]*\.cc-productivity-backfill-actions[\s\S]*flex-direction: column;/);
    expect(css).toMatch(/@media \(max-width: 768px\)[\s\S]*\.cc-productivity-backfill-actions \.btn[\s\S]*inline-size: 100%;/);
  });
});

describe("TeamArea", () => {
  it("applies horizontal org-chart layout when the measured container is wide enough", async () => {
    const widthSpy = installElementClientWidth(1_400);
    apiMock.mockResolvedValueOnce(emptyTeamFixture());
    fetchOrgTreeMock.mockResolvedValueOnce([
      agentNode("agent-root-a", "Root A", [
        agentNode("agent-child-a", "Child A", [agentNode("agent-grandchild-a", "Grandchild A")]),
        agentNode("agent-child-b", "Child B"),
      ]),
      agentNode("agent-root-b", "Root B"),
    ]);

    render(<TeamArea range={range7d} projectId="project-a" />);

    const orgSection = await screen.findByTestId("cc-team-org-chart");
    const orgScroll = orgSection.querySelector(".cc-team-org-scroll");
    await waitFor(() => expect(orgScroll).toHaveAttribute("data-layout", "horizontal"));
    expect(orgSection.querySelectorAll(".cc-team-org-card")).toHaveLength(5);
    for (const name of ["Root A", "Child A", "Grandchild A", "Child B", "Root B"]) {
      expect(within(orgSection).getByText(name)).toBeTruthy();
    }
    widthSpy.mockRestore();
  });

  it("keeps multi-root org charts vertical for narrow and zero-width containers", async () => {
    for (const [width, projectId] of [[320, "project-narrow"], [0, "project-zero"]] as const) {
      const widthSpy = installElementClientWidth(width);
      apiMock.mockResolvedValueOnce(emptyTeamFixture());
      fetchOrgTreeMock.mockResolvedValueOnce([
        agentNode(`${projectId}-root-a`, `${projectId} Root A`, [agentNode(`${projectId}-child`, `${projectId} Child`)]),
        agentNode(`${projectId}-root-b`, `${projectId} Root B`),
      ]);

      const { unmount } = render(<TeamArea range={range7d} projectId={projectId} />);
      const orgSection = await screen.findByTestId("cc-team-org-chart");
      const orgScroll = orgSection.querySelector(".cc-team-org-scroll");
      await waitFor(() => expect(orgScroll).toHaveAttribute("data-layout", "vertical"));
      expect(orgSection.querySelectorAll(".cc-team-org-card")).toHaveLength(3);
      unmount();
      widthSpy.mockRestore();
    }
  });

  it("keeps loading, error, empty, and single-root org-chart states stable while measuring width", async () => {
    const widthSpy = installElementClientWidth(0);
    apiMock.mockResolvedValueOnce(emptyTeamFixture());
    fetchOrgTreeMock.mockImplementationOnce(() => new Promise(() => undefined));
    const loading = render(<TeamArea range={range7d} projectId="project-loading" />);
    const loadingOrg = await screen.findByTestId("cc-team-org-chart");
    expect(within(loadingOrg).getByText("Loading org chart…")).toBeTruthy();
    expect(loadingOrg.querySelector(".cc-team-org-scroll")).toHaveAttribute("data-layout", "vertical");
    loading.unmount();

    apiMock.mockResolvedValueOnce(emptyTeamFixture());
    fetchOrgTreeMock.mockRejectedValueOnce(new Error("org failed"));
    const error = render(<TeamArea range={range7d} projectId="project-error" />);
    expect(await within(await screen.findByTestId("cc-team-org-chart")).findByRole("alert")).toHaveTextContent("org failed");
    error.unmount();

    apiMock.mockResolvedValueOnce(emptyTeamFixture());
    fetchOrgTreeMock.mockResolvedValueOnce([]);
    const empty = render(<TeamArea range={range7d} projectId="project-empty" />);
    expect(await within(await screen.findByTestId("cc-team-org-chart")).findByText("No agents are reporting in yet.")).toBeTruthy();
    empty.unmount();

    apiMock.mockResolvedValueOnce(emptyTeamFixture());
    fetchOrgTreeMock.mockResolvedValueOnce([agentNode("agent-single", "Single Root")]);
    render(<TeamArea range={range7d} projectId="project-single" />);
    const singleOrg = await screen.findByTestId("cc-team-org-chart");
    await waitFor(() => expect(singleOrg.querySelector(".cc-team-org-scroll")).toHaveAttribute("data-layout", "horizontal"));
    expect(singleOrg.querySelectorAll(".cc-team-org-card")).toHaveLength(1);
    widthSpy.mockRestore();
  });

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
    const fixture = populatedTeamFixture(1_234_567_890);
    apiMock.mockResolvedValue({
      ...fixture,
      totals: { ...fixture.totals, cost: { usd: 4.25, unavailable: true, stale: false } },
    });
    render(<TeamArea range={range7d} />);

    await screen.findByTestId("cc-area-team");
    expect(screen.getByTestId("cc-team-total-tokens").textContent).toContain("1,234,567,890");
    expect(screen.getByTestId("cc-team-total-cost")).toHaveTextContent("$4.25+");
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
    const ecosystemBar = screen.getByRole("list", { name: "Tasks per model" }) as HTMLElement;
    expect(providerIconIn(ecosystemBar, "openai")).toBeTruthy();
    expect(providerIconIn(ecosystemBar, "anthropic")).toBeTruthy();
    expect(providerIconIn(screen.getByTestId("cc-ecosystem-pie"), "openai")).toBeNull();
    expect(providerIconIn(screen.getByTestId("cc-ecosystem-pie"), "anthropic")).toBeNull();
    expect(screen.getByRole("img", { name: "openai gpt-4o: 3" })).toBeTruthy();
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

/*
FNXC:CommandCenter 2026-07-08-00:00:
FUX-037 regression: every Command Center area must thread a supplied projectId prop
through to its underlying api() request path (fixing the always-queries-wrong-project
bug), and must omit the param entirely when projectId is not supplied (no regression
for legacy/no-project contexts).
*/
describe("FUX-037: projectId scoping across Command Center areas", () => {
  it("TokensArea appends projectId to its tokens request", async () => {
    apiMock.mockResolvedValue(tokenFixture());
    render(<TokensArea range={range7d} projectId="proj-1" />);
    await waitFor(() => expect(apiMock).toHaveBeenCalled());
    expect(apiMock.mock.calls.some(([path]) => typeof path === "string" && path.includes("projectId=proj-1"))).toBe(true);

    apiMock.mockClear();
    apiMock.mockResolvedValue(tokenFixture());
    render(<TokensArea range={range7d} />);
    await waitFor(() => expect(apiMock).toHaveBeenCalled());
    expect(apiMock.mock.calls.every(([path]) => typeof path === "string" && !path.includes("projectId"))).toBe(true);
  });

  it("ToolsArea appends projectId to its tools request", async () => {
    apiMock.mockResolvedValue({
      toolCalls: 0,
      autonomyRatio: 0,
      fullyAutonomous: false,
      byCategory: [],
      interventions: { approvals: 0, userSteers: 0, total: 0 },
    });
    render(<ToolsArea range={range7d} projectId="proj-2" />);
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/command-center/tools?from=2026-06-08&projectId=proj-2", undefined),
    );
  });

  it("ActivityArea appends projectId to its activity request", async () => {
    apiMock.mockResolvedValue(activityFixture());
    render(<ActivityArea range={range7d} projectId="proj-3" />);
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/command-center/activity?from=2026-06-08&projectId=proj-3", undefined),
    );
  });

  it("ProductivityArea appends projectId to its productivity request", async () => {
    apiMock.mockResolvedValue(productivityFixture());
    render(<ProductivityArea range={range7d} projectId="proj-4" />);
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/command-center/productivity?from=2026-06-08&projectId=proj-4", undefined),
    );
  });

  it("EcosystemArea appends projectId to both its requests", async () => {
    apiMock.mockResolvedValue(tokenFixture());
    render(<EcosystemArea range={range7d} projectId="proj-5" />);
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2));
    expect(apiMock.mock.calls.every(([path]) => typeof path === "string" && path.includes("projectId=proj-5"))).toBe(true);
  });

  it("TeamArea appends projectId to its team analytics request (already-received prop, previously missed)", async () => {
    apiMock.mockResolvedValue(emptyTeamFixture());
    render(
      <ConfirmDialogProvider>
        <TeamArea range={range7d} projectId="proj-6" />
      </ConfirmDialogProvider>,
    );
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/command-center/team?from=2026-06-08&projectId=proj-6", undefined),
    );
  });

  it("renders distinct fixture data for two different projects without cross-project leakage", async () => {
    const fixtureA = tokenFixture(1_000);
    const fixtureB = tokenFixture(9_000);
    apiMock.mockImplementation((path: string) => {
      if (path.includes("projectId=proj-a")) return Promise.resolve(fixtureA);
      if (path.includes("projectId=proj-b")) return Promise.resolve(fixtureB);
      return Promise.reject(new Error(`unexpected path in two-project test: ${path}`));
    });

    const { rerender } = render(<TokensArea range={range7d} projectId="proj-a" />);
    await screen.findByTestId("cc-area-tokens");
    expect(screen.getByTestId("cc-area-tokens").textContent).toContain("1");

    rerender(<TokensArea range={range7d} projectId="proj-b" />);
    await waitFor(() => expect(apiMock.mock.calls.some(([path]) => typeof path === "string" && path.includes("projectId=proj-b"))).toBe(true));
  });
});
