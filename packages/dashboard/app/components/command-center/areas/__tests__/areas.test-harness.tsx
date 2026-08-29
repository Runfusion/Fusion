/*
FNXC:CommandCenter 2026-06-25-00:00:
FN-7044 extracted shared Command Center area test fixtures into this harness so focused sibling suites can stay under the 2000-line hard cap without duplicating fixture logic or moving Vitest hoisted mocks.
*/
import { expect, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import type { OrgTreeNode } from "@fusion/core";
import type { DateRange } from "../../DateRangePicker";

export const range7d: DateRange = { from: "2026-06-08", to: null, preset: "7d" };
export const customRange = (from: string, to: string): DateRange => ({ from, to, preset: "custom" });

export function providerIconIn(element: HTMLElement, provider: string): Element | null {
  return element.querySelector(`.provider-icon[data-provider="${provider}"]`);
}

export function tokenFixture(totalTokens = 1500) {
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

export function githubFixture() {
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
    resolved: [],
  };
}

export function productivityFixture() {
  return {
    from: "2026-06-08",
    to: null,
    modifiedFiles: 7,
    commits: 4,
    pullRequests: 2,
    byLanguage: [{ language: "TypeScript", count: 7 }],
    loc: { value: null, unavailable: true },
    hoursSaved: { value: null, unavailable: true },
    taskDuration: {
      completedTasks: 3,
      averageMs: 90 * 60 * 1000,
      medianMs: 60 * 60 * 1000,
      p90Ms: 2 * 60 * 60 * 1000,
      totalMs: 270 * 60 * 1000,
      unavailable: false,
    },
    taskDurationTrend: [
      {
        bucket: "2026-06-08",
        completedTasks: 1,
        averageMs: 60 * 60 * 1000,
        medianMs: 60 * 60 * 1000,
        unavailable: false,
      },
      {
        bucket: "2026-06-09",
        completedTasks: 2,
        averageMs: 105 * 60 * 1000,
        medianMs: 105 * 60 * 1000,
        unavailable: false,
      },
    ],
  };
}

export function installElementClientWidth(width: number) {
  return vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(width);
}

export function agentNode(id: string, name: string, children: OrgTreeNode[] = [], title = "Team Lead"): OrgTreeNode {
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

export function emptyTeamFixture() {
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

export function populatedTeamFixture(totalTokens = 1500) {
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

export function activityFixture() {
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

export function expectRechartsWrapperWithin(testId: string, label: string): void {
  const section = screen.getByTestId(testId);
  const chart = within(section).getByRole("img", { name: label });
  expect(chart.classList.contains("cc-recharts-chart") || chart.classList.contains("cc-recharts-empty")).toBe(true);
  expect(chart.outerHTML).not.toMatch(/NaN|Infinity/);
}

export function expectBarFillsFinite(testId: string): void {
  const section = screen.getByTestId(testId);
  for (const fill of Array.from(section.querySelectorAll<HTMLElement>(".cc-bar-fill"))) {
    expect(fill.style.width).toMatch(/^\d+(?:\.\d+)?%$/);
    expect(fill.style.width).not.toMatch(/NaN|Infinity/);
  }
}

export function expectSparklineHeightsFinite(testId: string): void {
  const section = screen.getByTestId(testId);
  for (const bar of Array.from(section.querySelectorAll<HTMLElement>(".cc-sparkline-bar"))) {
    expect(bar.style.height).toMatch(/^\d+(?:\.\d+)?%$/);
    expect(bar.style.height).not.toMatch(/NaN|Infinity/);
  }
}

export function viewBoxNumbers(chart: Element): [number, number, number, number] {
  return (chart.getAttribute("viewBox") ?? "")
    .split(/\s+/)
    .map(Number) as [number, number, number, number];
}

export function expectSvgLinePointsInsideViewBox(testId: string, label: string): void {
  const section = screen.getByTestId(testId);
  const chart = within(section).getByRole("img", { name: label });
  const [, , viewBoxWidth, viewBoxHeight] = viewBoxNumbers(chart);
  for (const point of Array.from(chart.querySelectorAll(".cc-line-chart-point"))) {
    const cx = Number(point.getAttribute("cx"));
    const cy = Number(point.getAttribute("cy"));
    const r = Number(point.getAttribute("r"));
    expect(cx).toBeGreaterThanOrEqual(r);
    expect(cx).toBeLessThanOrEqual(viewBoxWidth - r);
    expect(cy).toBeGreaterThanOrEqual(r);
    expect(cy).toBeLessThanOrEqual(viewBoxHeight - r);
  }
}

export function expectSvgLineFillsBoxAndKeepsRoundMarkers(testId: string, label: string): void {
  const section = screen.getByTestId(testId);
  const chart = within(section).getByRole("img", { name: label });
  const [, , viewBoxWidth, viewBoxHeight] = viewBoxNumbers(chart);
  const line = chart.querySelector(".cc-line-chart-path");
  const pointPairs = (line?.getAttribute("points") ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((pair) => pair.split(",").map(Number) as [number, number]);
  expect(viewBoxWidth).toBeGreaterThan(viewBoxHeight);
  expect(chart.getAttribute("preserveAspectRatio")).toBe("none");
  expect(chart.getAttribute("viewBox")).not.toBe("0 0 100 100");
  expect(chart.querySelectorAll(".cc-line-chart-point").length).toBeGreaterThan(0);
  expect(pointPairs[0]?.[0]).toBe(3);
  expect(pointPairs.at(-1)?.[0]).toBe(viewBoxWidth - 3);
}

export function pluginActivationFixture(overrides: Partial<{ activations: number; unavailable: boolean }> = {}) {
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
