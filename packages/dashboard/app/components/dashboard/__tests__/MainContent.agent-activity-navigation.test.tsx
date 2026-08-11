import { lazy } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MainContentProps } from "../types";

const { fetchTaskDetail } = vi.hoisted(() => ({ fetchTaskDetail: vi.fn() }));
vi.mock("../../../api", async (importOriginal) => {
  const { createDashboardApiMock } = await import("../../../test/mockApi");
  return createDashboardApiMock(() => importOriginal<typeof import("../../../api")>(), {
    fetchTaskDetail,
    fetchMission: vi.fn(),
    fetchMissions: vi.fn().mockResolvedValue([]),
    fetchInsights: vi.fn().mockResolvedValue({ insights: [], count: 0 }),
    listEvals: vi.fn().mockResolvedValue({ results: [], count: 0 }),
  });
});

import { MainContent, nextAgentAnchorRequestId } from "../MainContent";

const CommandCenterProbe = lazy(async () => ({
  default: ({ onOpenAgent, onOpenTask }: { onOpenAgent?: (agentId: string) => void; onOpenTask?: (taskId: string) => void }) => (
    <>
      <button type="button" onClick={() => onOpenAgent?.("agent-7")}>Open activity agent</button>
      <button type="button" onClick={() => onOpenTask?.("FN-7")}>Open activity task</button>
    </>
  ),
}));

function props(overrides: Partial<MainContentProps> = {}): MainContentProps {
  return {
    showBackendConnectionErrorPage: false,
    projectsError: null,
    t: ((key: string, fallback?: string) => fallback ?? key) as MainContentProps["t"],
    retryingProjects: false,
    handleRetryProjects: vi.fn(),
    shellApi: null,
    taskView: "command-center",
    pluginDashboardViews: [],
    modalManager: { openPlanningWithSession: vi.fn() } as unknown as MainContentProps["modalManager"],
    handleChangeTaskView: vi.fn(),
    refreshAppSettings: vi.fn(async () => undefined),
    addToast: vi.fn(),
    currentProject: { id: "project-1", name: "Project 1" } as MainContentProps["currentProject"],
    themeMode: "system",
    setThemeMode: vi.fn(),
    colorTheme: "default",
    setColorTheme: vi.fn(),
    dashboardFontScalePct: 100,
    setDashboardFontScalePct: vi.fn(),
    shadcnCustomColors: {},
    setShadcnCustomColors: vi.fn(),
    resolvedThemeMode: "light",
    viewMode: "project",
    tasks: [],
    workflowSteps: [],
    openDetailTask: vi.fn(),
    popOutTaskDetail: vi.fn(),
    setMailboxUnreadCount: vi.fn(),
    settingsLoaded: true,
    skillsEnabled: true,
    insightsEnabled: true,
    researchEnabled: true,
    evalsEnabled: true,
    memoryEnabled: true,
    goalsEnabled: true,
    todosEnabled: true,
    nodesEnabled: true,
    capacityRiskBannerEnabled: false,
    capacityRiskDismissed: false,
    capacityRiskSignal: { level: "low", reasons: [] } as unknown as MainContentProps["capacityRiskSignal"],
    CommandCenter: CommandCenterProbe as MainContentProps["CommandCenter"],
    ...overrides,
  } as unknown as MainContentProps;
}

describe("MainContent agent activity navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchTaskDetail.mockResolvedValue({ id: "FN-7", title: "Activity task" });
  });

  it("routes repeated agent targets through unique anchors even with a frozen clock", async () => {
    const setAgentAnchor = vi.fn();
    const handleChangeTaskView = vi.fn();
    render(<MainContent {...props({ setAgentAnchor, handleChangeTaskView })} />);

    await screen.findByRole("button", { name: "Open activity agent" });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T00:00:00.000Z"));
    act(() => {
      screen.getByRole("button", { name: "Open activity agent" }).click();
      screen.getByRole("button", { name: "Open activity agent" }).click();
    });

    expect(handleChangeTaskView).toHaveBeenNthCalledWith(1, "agents");
    expect(handleChangeTaskView).toHaveBeenNthCalledWith(2, "agents");
    const anchors = setAgentAnchor.mock.calls.map(([anchor]) => anchor);
    expect(anchors).toHaveLength(2);
    expect(anchors.every((anchor) => anchor.agentId === "agent-7")).toBe(true);
    expect(anchors[1].requestId).toBeGreaterThan(anchors[0].requestId);
    vi.useRealTimers();
  });

  it("opens the originating task detail and reports fetch failures as a toast", async () => {
    const openDetailTask = vi.fn();
    const addToast = vi.fn();
    render(<MainContent {...props({ openDetailTask, addToast })} />);
    await screen.findByRole("button", { name: "Open activity task" });
    screen.getByRole("button", { name: "Open activity task" }).click();
    await waitFor(() => expect(fetchTaskDetail).toHaveBeenCalledWith("FN-7", "project-1"));
    expect(openDetailTask).toHaveBeenCalledWith(expect.objectContaining({ id: "FN-7" }));

    fetchTaskDetail.mockRejectedValueOnce(new Error("gone"));
    screen.getByRole("button", { name: "Open activity task" }).click();
    await waitFor(() => expect(addToast).toHaveBeenCalledWith("Failed to open task", "error"));
  });

  it("keeps the exported nonce strictly increasing without relying on time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T00:00:00.000Z"));
    const first = nextAgentAnchorRequestId();
    const second = nextAgentAnchorRequestId();
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
    vi.useRealTimers();
  });
});
