import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { OrgTreeNode } from "@fusion/core";
import { TeamArea } from "../TeamArea";
import type { DateRange } from "../DateRangePicker";

const mocks = vi.hoisted(() => ({
  fetchOrgTree: vi.fn(),
  fetchExecutorStats: vi.fn(),
  fetchSettings: vi.fn(),
  updateSettings: vi.fn(),
  toggleEnginePause: vi.fn(),
  useAnalyticsArea: vi.fn(),
  resolveOrgChartLayoutMode: vi.fn(),
}));

vi.mock("../../../../api/legacy", () => ({
  fetchCodebaseMetrics: vi.fn().mockResolvedValue({ tokenEstimate: 0, sourceFileCount: 0, sourceByteCount: 0, diskBytes: 0, diskFileCount: 0, method: "local", truncated: false }),
  fetchOrgTree: mocks.fetchOrgTree,
  fetchExecutorStats: mocks.fetchExecutorStats,
  fetchSettings: mocks.fetchSettings,
  updateSettings: mocks.updateSettings,
}));

vi.mock("../../../../hooks/useAppSettings", () => ({
  useAppSettings: () => ({
    globalPaused: false,
    enginePaused: false,
    toggleEnginePause: mocks.toggleEnginePause,
  }),
}));

vi.mock("../useAnalyticsArea", () => ({
  useAnalyticsArea: mocks.useAnalyticsArea,
}));

vi.mock("../../../agentsOrgChartLayout", () => ({
  resolveOrgChartLayoutMode: mocks.resolveOrgChartLayoutMode,
}));

const range: DateRange = { from: "2026-06-08", to: null, preset: "7d" };

function agentNode(id: string, name: string, children: OrgTreeNode[] = []): OrgTreeNode {
  return {
    agent: {
      id,
      name,
      role: "executor",
      state: "idle",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:00.000Z",
      metadata: {},
    },
    children,
  };
}

const orgTree: OrgTreeNode[] = [
  agentNode("root", "Root Agent", [
    agentNode("left", "Left Agent", [agentNode("left-child", "Left Child")]),
    agentNode("right", "Right Agent", [agentNode("right-child", "Right Child")]),
  ]),
];

function teamAnalyticsFixture() {
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

function renderTeamArea(layout: "horizontal" | "vertical") {
  mocks.resolveOrgChartLayoutMode.mockReturnValue(layout);
  render(<TeamArea range={range} />);
}

async function findOrgViewport() {
  await screen.findByText("Root Agent");
  const viewport = document.querySelector(".cc-team-org-scroll") as HTMLDivElement | null;
  expect(viewport).toBeInTheDocument();
  return viewport!;
}

function makeScrollable(viewport: HTMLDivElement, scroll: { left?: number; top?: number } = {}) {
  Object.defineProperties(viewport, {
    clientWidth: { configurable: true, value: 320 },
    scrollWidth: { configurable: true, value: 960 },
    clientHeight: { configurable: true, value: 180 },
    scrollHeight: { configurable: true, value: 720 },
  });
  viewport.scrollLeft = scroll.left ?? 0;
  viewport.scrollTop = scroll.top ?? 0;
}

describe("TeamArea org chart drag panning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      disconnect() {}
    });
    mocks.fetchOrgTree.mockResolvedValue(orgTree);
    mocks.fetchExecutorStats.mockResolvedValue({ globalPause: false, enginePaused: false, maxConcurrent: 2 });
    mocks.fetchSettings.mockResolvedValue({ heartbeatMultiplier: 1 });
    mocks.updateSettings.mockResolvedValue({});
    mocks.useAnalyticsArea.mockReturnValue({ data: teamAnalyticsFixture(), isLoading: false, error: null });
  });

  it("pans horizontal layout by mutating native scrollLeft during a mouse drag", async () => {
    renderTeamArea("horizontal");
    const viewport = await findOrgViewport();
    makeScrollable(viewport, { left: 100, top: 40 });

    fireEvent.pointerDown(viewport, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 100, clientY: 40 });
    fireEvent.pointerMove(viewport, { pointerId: 1, pointerType: "mouse", clientX: 60, clientY: 40 });
    fireEvent.pointerUp(viewport, { pointerId: 1, pointerType: "mouse", clientX: 60, clientY: 40 });

    expect(viewport).toHaveAttribute("data-layout", "horizontal");
    expect(viewport.scrollLeft).toBe(140);
    expect(viewport.scrollTop).toBe(40);
  });

  it("pans vertical layout by mutating native scrollTop during a mouse drag", async () => {
    renderTeamArea("vertical");
    const viewport = await findOrgViewport();
    makeScrollable(viewport, { left: 30, top: 80 });

    fireEvent.pointerDown(viewport, { pointerId: 2, pointerType: "mouse", button: 0, clientX: 50, clientY: 100 });
    fireEvent.pointerMove(viewport, { pointerId: 2, pointerType: "mouse", clientX: 50, clientY: 50 });
    fireEvent.pointerUp(viewport, { pointerId: 2, pointerType: "mouse", clientX: 50, clientY: 50 });

    expect(viewport).toHaveAttribute("data-layout", "vertical");
    expect(viewport.scrollLeft).toBe(30);
    expect(viewport.scrollTop).toBe(130);
  });

  it("leaves touch pointer sequences on the native scrolling path", async () => {
    renderTeamArea("horizontal");
    const viewport = await findOrgViewport();
    makeScrollable(viewport, { left: 100, top: 20 });

    fireEvent.pointerDown(viewport, { pointerId: 3, pointerType: "touch", button: 0, clientX: 100, clientY: 40 });
    fireEvent.pointerMove(viewport, { pointerId: 3, pointerType: "touch", clientX: 20, clientY: 40 });
    fireEvent.pointerUp(viewport, { pointerId: 3, pointerType: "touch", clientX: 20, clientY: 40 });

    expect(viewport.scrollLeft).toBe(100);
    expect(viewport.scrollTop).toBe(20);
    expect(viewport).not.toHaveClass("is-dragging");
  });

  it("does not treat a pure node click as a pan or swallow the node click", async () => {
    renderTeamArea("horizontal");
    const viewport = await findOrgViewport();
    makeScrollable(viewport, { left: 55, top: 25 });
    const card = screen.getByText("Root Agent").closest(".cc-team-org-card") as HTMLDivElement | null;
    expect(card).toBeInTheDocument();
    const clickHandler = vi.fn();
    card!.addEventListener("click", clickHandler);

    fireEvent.pointerDown(card!, { pointerId: 4, pointerType: "mouse", button: 0, clientX: 120, clientY: 60 });
    fireEvent.pointerUp(viewport, { pointerId: 4, pointerType: "mouse", clientX: 120, clientY: 60 });
    fireEvent.click(card!);

    expect(viewport.scrollLeft).toBe(55);
    expect(viewport.scrollTop).toBe(25);
    expect(clickHandler).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(viewport).not.toHaveClass("is-dragging"));
  });
});
