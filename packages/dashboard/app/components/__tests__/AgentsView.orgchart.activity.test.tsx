import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgentsView } from "../AgentsView";
import * as apiModule from "../../api";
import { __resetAgentActivityStoreForTests } from "../../hooks/agentActivityStore";
import { __resetSseBus, __sseBusChannelCount } from "../../sse-bus";

const mockViewportMode = vi.fn<() => "desktop" | "mobile">(() => "desktop");
vi.mock("../../hooks/useViewportMode", () => ({
  useViewportMode: () => mockViewportMode(),
  isMobileViewport: () => mockViewportMode() === "mobile",
  isTabletTouchViewport: () => false,
  isFullScreenSheetViewport: () => false,
  isShortViewport: () => false,
}));
vi.mock("../../hooks/useConfirm", () => ({ useConfirm: () => ({ confirm: vi.fn().mockResolvedValue(true) }) }));
const activitySse = vi.hoisted(() => ({ getAgentActivity: vi.fn() }));
vi.mock("../AgentDetailView", () => ({ AgentDetailView: ({ agentId }: { agentId: string }) => <output data-testid="selected-agent">{agentId}</output>, relativeTime: () => "now" }));
vi.mock("../../api", async (importOriginal) => {
  const { createDashboardApiMock } = await import("../../test/mockApi");
  return createDashboardApiMock(() => importOriginal<typeof import("../../api")>(), {
    fetchAgents: vi.fn().mockResolvedValue([]),
    fetchAgentStats: vi.fn().mockResolvedValue({ total: 0, byState: {}, byRole: {} }),
    fetchOrgTree: vi.fn(),
    fetchSettings: vi.fn().mockResolvedValue({ heartbeatMultiplier: 1 }),
    updateSettings: vi.fn().mockResolvedValue({}),
    getAgentActivity: activitySse.getAgentActivity,
  });
});

const mockFetchOrgTree = vi.mocked((apiModule as any).fetchOrgTree);
const taskBoundRoot = [{
  agent: {
    id: "agent-task", name: "Task agent", role: "executor", state: "running", taskId: "FN-42",
    createdAt: "2026-08-09T10:00:00.000Z", updatedAt: "2026-08-09T10:00:00.000Z", metadata: {},
  },
  children: [],
}];

class ActivityEventSource {
  static readonly instances: ActivityEventSource[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  readyState = ActivityEventSource.OPEN;
  private listeners = new Map<string, Set<(event: Event) => void>>();

  constructor(_url: string) { ActivityEventSource.instances.push(this); }
  addEventListener(type: string, listener: (event: Event) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: (event: Event) => void) { this.listeners.get(type)?.delete(listener); }
  close() { this.readyState = ActivityEventSource.CLOSED; }
  emit(type: string, data: unknown) {
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }
}

function pushActivity(event: Record<string, unknown>) {
  ActivityEventSource.instances.at(-1)?.emit("agent:activity", event);
}

beforeEach(() => {
  activitySse.getAgentActivity.mockResolvedValue({ events: [], nextCursor: null });
  ActivityEventSource.instances.length = 0;
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("EventSource", ActivityEventSource);
});

afterEach(() => {
  __resetAgentActivityStoreForTests();
  __resetSseBus();
  vi.useRealTimers();
  vi.clearAllMocks();
  mockViewportMode.mockReturnValue("desktop");
});

describe("AgentsView org-chart activity navigation", () => {
  it.each([
    ["unknown", "idle", undefined],
    ["idle", "idle", { eventId: "terminal", type: "task:completed", occurredAt: new Date().toISOString() }],
    ["active", "running", undefined],
    ["error", "error", undefined],
  ] as const)("renders %s activity state without an orphaned no-data indicator", async (expected, state, activity) => {
    const agent = { ...taskBoundRoot[0].agent, state, taskId: undefined };
    mockFetchOrgTree.mockResolvedValue([{ agent, children: [] }]);
    activitySse.getAgentActivity.mockResolvedValue({
      events: activity ? [{ ...activity, projectId: "project", agentId: agent.id, eventId: activity.eventId, seq: activity.eventId, agentAttribution: "agent", taskId: null, fromAgentId: null, toAgentId: null, summary: "activity", metadata: null }] : [],
      nextCursor: null,
    });
    render(<AgentsView addToast={vi.fn()} projectId="project" />);
    fireEvent.click(await screen.findByLabelText("Org Chart view"));
    const card = (await screen.findByText("Task agent")).closest(".org-chart-node-card")!;
    if (expected === "unknown") expect(card).not.toHaveAttribute("data-activity-state");
    else await waitFor(() => expect(card).toHaveAttribute("data-activity-state", expected));
  });

  it.each(["desktop", "mobile"] as const)("renders the existing org chart at %s viewport mode", async (mode) => {
    mockViewportMode.mockReturnValue(mode);
    mockFetchOrgTree.mockResolvedValue(taskBoundRoot);
    render(<AgentsView addToast={vi.fn()} />);
    fireEvent.click(await screen.findByLabelText("Org Chart view"));
    expect(await screen.findByTestId("agent-org-chart")).toBeInTheDocument();
  });
  it("uses the real shared store for a co-mounted overview and animated deep-tree flow", async () => {
    const deepTree = [{
      agent: { ...taskBoundRoot[0].agent, id: "manager", name: "Manager", taskId: undefined, state: "active" },
      children: [{
        agent: { ...taskBoundRoot[0].agent, id: "worker", name: "Worker", taskId: undefined, state: "idle" },
        children: [{ agent: { ...taskBoundRoot[0].agent, id: "reviewer", name: "Reviewer", taskId: undefined, state: "idle" }, children: [] }],
      }],
    }];
    mockFetchOrgTree.mockResolvedValue(deepTree);
    vi.mocked((apiModule as any).fetchAgents).mockResolvedValue(deepTree.flatMap((node: any) => [node.agent, node.children[0].agent, node.children[0].children[0].agent]));
    activitySse.getAgentActivity.mockResolvedValue({
      events: [{
        eventId: "handoff", seq: "1", projectId: "project", agentId: "manager", agentAttribution: "agent", taskId: null,
        type: "task:handed-off", fromAgentId: "manager", toAgentId: "worker", summary: "Delegated work", occurredAt: new Date().toISOString(), metadata: null,
      }],
      nextCursor: null,
    });
    render(<AgentsView addToast={vi.fn()} projectId="project" />);
    await screen.findByText("Manager");
    fireEvent.click(screen.getByRole("button", { name: /overview/i }));
    fireEvent.click(await screen.findByLabelText("Org Chart view"));
    await waitFor(() => expect(activitySse.getAgentActivity).toHaveBeenCalledTimes(1));
    expect(__sseBusChannelCount()).toBe(1);
    await waitFor(() => expect(document.querySelector('[data-flow-direction="down"]')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("Vertical layout"));
    await waitFor(() => expect(document.querySelector('[data-flow-direction="down"]')).toBeInTheDocument());
  });

  it("keeps an empty production org tree free of chart and activity shells", async () => {
    mockFetchOrgTree.mockResolvedValue([]);
    render(<AgentsView addToast={vi.fn()} projectId="project" />);
    fireEvent.click(await screen.findByLabelText("Org Chart view"));
    expect(screen.getByTestId("agent-org-chart")).toBeInTheDocument();
    expect(document.querySelector(".org-chart-node-card[data-activity-state]")).toBeNull();
    expect(document.querySelector("[data-flow-direction]")).toBeNull();
  });

  it.each([
    ["desktop", "Horizontal layout"],
    ["mobile", "Vertical layout"],
  ] as const)("receives newest pushed up-flow activity through the real store at %s", async (viewport, layoutControl) => {
    mockViewportMode.mockReturnValue(viewport);
    const deepTree = [{
      agent: { ...taskBoundRoot[0].agent, id: "manager", name: "Manager", taskId: undefined, state: "idle" },
      children: [{
        agent: { ...taskBoundRoot[0].agent, id: "worker", name: "Worker", taskId: undefined, state: "idle" },
        children: [{ agent: { ...taskBoundRoot[0].agent, id: "reviewer", name: "Reviewer", taskId: undefined, state: "idle" }, children: [] }],
      }],
    }];
    mockFetchOrgTree.mockResolvedValue(deepTree);
    vi.mocked((apiModule as any).fetchAgents).mockResolvedValue([deepTree[0].agent, deepTree[0].children[0].agent, deepTree[0].children[0].children[0].agent]);
    render(<AgentsView addToast={vi.fn()} projectId="project" />);
    fireEvent.click(await screen.findByLabelText("Org Chart view"));
    await waitFor(() => expect(activitySse.getAgentActivity).toHaveBeenCalledTimes(1));

    const newerAt = new Date(Date.now()).toISOString();
    act(() => pushActivity({
      eventId: "report-new", seq: "2", projectId: "project", agentId: "worker", agentAttribution: "agent", taskId: null,
      type: "task:handed-off", fromAgentId: "worker", toAgentId: "manager", summary: "Reported upward", occurredAt: newerAt, metadata: null,
    }));
    // A delayed lower-order frame cannot replace the latest event or reverse the edge.
    act(() => pushActivity({
      eventId: "handoff-old", seq: "1", projectId: "project", agentId: "manager", agentAttribution: "agent", taskId: null,
      type: "task:handed-off", fromAgentId: "manager", toAgentId: "worker", summary: "Old handoff", occurredAt: new Date(Date.now() - 1_000).toISOString(), metadata: null,
    }));

    await waitFor(() => expect(document.querySelector('[data-flow-direction="up"]')).toBeInTheDocument());
    expect(screen.getByText("Worker").closest(".org-chart-node-card")).not.toHaveAttribute("data-activity-state", "active");
    fireEvent.click(screen.getByLabelText(layoutControl));
    await waitFor(() => expect(document.querySelector('[data-flow-direction="up"]')).toBeInTheDocument());
  });

  it("removes a production connector flow after its expiry clock advances", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-08-09T10:00:00.000Z");
    vi.setSystemTime(now);
    const tree = [{ agent: { ...taskBoundRoot[0].agent, id: "parent", name: "Parent", taskId: undefined, state: "idle" }, children: [
      { agent: { ...taskBoundRoot[0].agent, id: "child", name: "Child", taskId: undefined, state: "idle" }, children: [] },
    ] }];
    mockFetchOrgTree.mockResolvedValue(tree);
    activitySse.getAgentActivity.mockResolvedValue({ events: [{
      eventId: "seed-flow", seq: "1", projectId: "project", agentId: "parent", agentAttribution: "agent", taskId: null,
      type: "task:handed-off", fromAgentId: "parent", toAgentId: "child", summary: "Delegated", occurredAt: now.toISOString(), metadata: null,
    }], nextCursor: null });
    render(<AgentsView addToast={vi.fn()} projectId="project" />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByLabelText("Org Chart view"));
    await act(async () => { await Promise.resolve(); });
    expect(document.querySelector('[data-flow-direction="down"]')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_001); });
    expect(document.querySelector('[data-flow-direction]')).toBeNull();
  });

  it("renders a static flow rather than an animation when reduced motion is preferred", async () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true, addEventListener() {}, removeEventListener() {} }));
    const tree = [{ agent: { ...taskBoundRoot[0].agent, id: "parent", name: "Parent", taskId: undefined, state: "idle" }, children: [
      { agent: { ...taskBoundRoot[0].agent, id: "child", name: "Child", taskId: undefined, state: "idle" }, children: [] },
    ] }];
    mockFetchOrgTree.mockResolvedValue(tree);
    activitySse.getAgentActivity.mockResolvedValue({ events: [{
      eventId: "handoff", seq: "1", projectId: "project", agentId: "parent", agentAttribution: "agent", taskId: null,
      type: "task:handed-off", fromAgentId: "parent", toAgentId: "child", summary: "Delegated work", occurredAt: new Date().toISOString(), metadata: null,
    }], nextCursor: null });
    render(<AgentsView addToast={vi.fn()} projectId="project" />);
    fireEvent.click(await screen.findByLabelText("Org Chart view"));
    await waitFor(() => expect(document.querySelector(".agent-org-chart-connectors__flow--static.down")).toBeInTheDocument());
    expect(document.querySelector(".agent-org-chart-connectors__flow--down")).toBeNull();
  });

  it.each(["desktop", "mobile"] as const)("opens the task chat from a %s org-chart node", async (mode) => {
    mockViewportMode.mockReturnValue(mode);
    mockFetchOrgTree.mockResolvedValue(taskBoundRoot);
    for (const activate of [
      (card: HTMLElement) => fireEvent.click(card),
      (card: HTMLElement) => fireEvent.keyDown(card, { key: "Enter" }),
      (card: HTMLElement) => fireEvent.keyDown(card, { key: " " }),
    ]) {
      const onOpenTaskLogs = vi.fn();
      const view = render(<AgentsView addToast={vi.fn()} onOpenTaskLogs={onOpenTaskLogs} />);
      fireEvent.click(await screen.findByLabelText("Org Chart view"));
      const node = await screen.findByText("Task agent");
      activate(node.closest(".org-chart-node-card") as HTMLElement);
      expect(onOpenTaskLogs).toHaveBeenCalledWith("FN-42");
      await waitFor(() => expect(screen.getAllByTestId("selected-agent").at(-1)).toHaveTextContent("agent-task"));
      view.unmount();
    }
  });
});
