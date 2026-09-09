import React from "react";
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";

const sharedAgentsState = vi.hoisted(() => ({ agentsMap: new Map<string, { name: string }>() }));

vi.mock("../../hooks/useToast", () => ({
  useOptionalToast: () => null,
  useToast: () => ({ addToast: vi.fn(), removeToast: vi.fn(), toasts: [] }),
}));
vi.mock("../../api", () => ({
  fetchTaskDiff: vi.fn(),
  fetchWorkflowSettingValues: vi.fn(async () => ({ stored: {}, effective: {}, orphaned: [] })),
  fetchMission: vi.fn(),
  fetchAgent: vi.fn(),
  fetchAgents: vi.fn().mockResolvedValue([]),
  rebuildTaskSpec: vi.fn(),
}));
vi.mock("../../hooks/useBadgeWebSocket", () => ({
  useBadgeWebSocket: () => ({ badgeUpdates: new Map(), isConnected: false, subscribeToBadge: vi.fn(), unsubscribeFromBadge: vi.fn() }),
}));
vi.mock("../../hooks/useAgentsMapCache", () => ({
  useAgentsMapCache: () => ({ agentsMap: sharedAgentsState.agentsMap, agents: [], loading: false, refresh: vi.fn() }),
}));
vi.mock("../ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("../PluginSlot", () => ({ PluginSlot: () => null }));

import { fetchAgent, fetchMission, fetchTaskDiff } from "../../api";
import { __test_clearDiffStatsCache } from "../../hooks/useTaskDiffStats";
import { __test_clearAgentNameCache, __test_clearMissionTitleCache, TaskCard } from "../TaskCard";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-321",
    title: "Stable metadata",
    description: "",
    column: "done",
    steps: [],
    dependencies: [],
    missionId: "M-001",
    assignedAgentId: "agent-1",
    mergeDetails: { commitSha: "abc", filesChanged: 3, mergeConfirmed: true } as Task["mergeDetails"],
    ...overrides,
  } as Task;
}

function signature(container: HTMLElement): string[] {
  return [".card-footer-row", ".card-session-files", ".card-mission-badge", ".card-agent-row", ".card-agent-badge"]
    .filter((selector) => container.querySelector(selector));
}

describe("TaskCard same-snapshot asynchronous enrichment", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    vi.mocked(fetchTaskDiff).mockReset();
    vi.mocked(fetchMission).mockReset();
    vi.mocked(fetchAgent).mockReset();
    __test_clearDiffStatsCache();
    __test_clearMissionTitleCache();
    __test_clearAgentNameCache();
    sharedAgentsState.agentsMap = new Map();
  });

  it("commits every known region before intersection and preserves node identity after enrichment", async () => {
    const diff = deferred<{ files: never[]; stats: { filesChanged: number; additions: number; deletions: number } }>();
    const mission = deferred<{ title: string }>();
    const agent = deferred<{ name: string }>();
    vi.mocked(fetchTaskDiff).mockReturnValue(diff.promise as ReturnType<typeof fetchTaskDiff>);
    vi.mocked(fetchMission).mockReturnValue(mission.promise as ReturnType<typeof fetchMission>);
    vi.mocked(fetchAgent).mockReturnValue(agent.promise as ReturnType<typeof fetchAgent>);

    let intersect!: IntersectionObserverCallback;
    class Observer {
      constructor(callback: IntersectionObserverCallback) { intersect = callback; }
      observe() {}
      disconnect() {}
      unobserve() {}
      takeRecords() { return []; }
      root = null;
      rootMargin = "0px";
      thresholds = [0];
    }
    vi.stubGlobal("IntersectionObserver", Observer);

    const open = vi.fn();
    const { container } = render(<TaskCard task={makeTask()} onOpenDetail={vi.fn()} addToast={vi.fn()} onOpenDetailWithTab={open} />);
    const initialSignature = signature(container);
    const initialFiles = container.querySelector(".card-session-files");
    const initialMission = container.querySelector(".card-mission-badge");
    const initialAgent = container.querySelector(".card-agent-badge");
    expect(initialSignature).toEqual([".card-footer-row", ".card-session-files", ".card-mission-badge", ".card-agent-row", ".card-agent-badge"]);
    expect(screen.getByRole("button", { name: "3 files changed" })).toBeTruthy();
    expect(initialMission).toHaveTextContent("M-001");
    expect(initialAgent).toHaveTextContent("agent-1");

    await act(async () => {
      intersect([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
      mission.resolve({ title: "Mission Alpha" });
      agent.resolve({ name: "Agent Alpha" });
      diff.resolve({ files: [], stats: { filesChanged: 4, additions: 2, deletions: 1 } });
      await Promise.resolve();
    });

    expect(signature(container)).toEqual(initialSignature);
    expect(container.querySelector(".card-session-files")).toBe(initialFiles);
    expect(container.querySelector(".card-mission-badge")).toBe(initialMission);
    expect(container.querySelector(".card-agent-badge")).toBe(initialAgent);
    expect(initialMission).toHaveAttribute("title", "Mission: Mission Alpha");
    expect(initialAgent).toHaveTextContent("Agent Alpha");
    expect(screen.getByRole("button", { name: "4 files changed" })).toBeTruthy();
  });

  it("scopes delayed mission and agent enrichments across project A → B → A", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const missionA = deferred<{ title: string }>();
    const missionB = deferred<{ title: string }>();
    const agentA = deferred<{ name: string }>();
    const agentB = deferred<{ name: string }>();
    vi.mocked(fetchMission)
      .mockReturnValueOnce(missionA.promise as ReturnType<typeof fetchMission>)
      .mockReturnValueOnce(missionB.promise as ReturnType<typeof fetchMission>);
    vi.mocked(fetchAgent)
      .mockReturnValueOnce(agentA.promise as ReturnType<typeof fetchAgent>)
      .mockReturnValueOnce(agentB.promise as ReturnType<typeof fetchAgent>);

    const props = { task: makeTask(), onOpenDetail: vi.fn(), addToast: vi.fn(), onOpenDetailWithTab: vi.fn() };
    const view = render(<TaskCard {...props} projectId="project-a" />);
    expect(view.container.querySelector(".card-mission-badge")).toHaveTextContent("M-001");
    expect(view.container.querySelector(".card-agent-badge")).toHaveTextContent("agent-1");

    sharedAgentsState.agentsMap = new Map();
    view.rerender(<TaskCard {...props} projectId="project-a" autoMergeEnabled={false} />);
    view.rerender(<TaskCard {...props} projectId="project-b" autoMergeEnabled={false} />);
    sharedAgentsState.agentsMap = new Map();
    view.rerender(<TaskCard {...props} projectId="project-b" autoMergeEnabled />);
    missionA.resolve({ title: "Mission A" });
    agentA.resolve({ name: "Agent A" });
    await act(() => Promise.resolve());
    expect(view.container.querySelector(".card-mission-badge")).toHaveTextContent("M-001");
    expect(view.container.querySelector(".card-agent-badge")).toHaveTextContent("agent-1");

    missionB.resolve({ title: "Mission B" });
    agentB.resolve({ name: "Agent B" });
    await act(() => Promise.resolve());
    expect(screen.getByTitle("Mission: Mission B")).toBeTruthy();
    expect(view.container.querySelector(".card-agent-badge")).toHaveTextContent("Agent B");

    view.rerender(<TaskCard {...props} projectId="project-a" autoMergeEnabled />);
    expect(screen.getByTitle("Mission: Mission A")).toBeTruthy();
    expect(view.container.querySelector(".card-agent-badge")).toHaveTextContent("Agent A");
    expect(fetchMission).toHaveBeenCalledTimes(2);
    expect(fetchAgent).toHaveBeenCalledTimes(2);
  });

  it("ignores the previous project's retained agents map during A → B → A", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    vi.mocked(fetchMission).mockResolvedValue({ title: "Mission" } as Awaited<ReturnType<typeof fetchMission>>);
    const agentB = deferred<{ name: string }>();
    vi.mocked(fetchAgent).mockReturnValue(agentB.promise as ReturnType<typeof fetchAgent>);
    sharedAgentsState.agentsMap = new Map([["agent-1", { name: "Agent A" }]]);

    const props = { task: makeTask({ missionId: undefined }), onOpenDetail: vi.fn(), addToast: vi.fn() };
    const view = render(<TaskCard {...props} projectId="project-a" />);
    expect(view.container.querySelector(".card-agent-badge")).toHaveTextContent("agent-1");
    expect(fetchAgent).not.toHaveBeenCalled();

    sharedAgentsState.agentsMap = new Map([["agent-1", { name: "Agent A" }]]);
    view.rerender(<TaskCard {...props} projectId="project-a" autoMergeEnabled={false} />);
    expect(view.container.querySelector(".card-agent-badge")).toHaveTextContent("Agent A");

    view.rerender(<TaskCard {...props} projectId="project-b" autoMergeEnabled={false} />);
    expect(view.container.querySelector(".card-agent-badge")).toHaveTextContent("agent-1");
    expect(view.container.querySelector(".card-agent-badge")).not.toHaveTextContent("Agent A");
    expect(fetchAgent).not.toHaveBeenCalled();

    sharedAgentsState.agentsMap = new Map();
    view.rerender(<TaskCard {...props} projectId="project-b" autoMergeEnabled />);
    expect(fetchAgent).toHaveBeenCalledWith("agent-1", "project-b");

    await act(async () => {
      agentB.resolve({ name: "Agent B" });
      await Promise.resolve();
    });
    expect(view.container.querySelector(".card-agent-badge")).toHaveTextContent("Agent B");

    sharedAgentsState.agentsMap = new Map([["agent-1", { name: "Agent B" }]]);
    view.rerender(<TaskCard {...props} projectId="project-b" autoMergeEnabled={false} />);
    expect(view.container.querySelector(".card-agent-badge")).toHaveTextContent("Agent B");

    view.rerender(<TaskCard {...props} projectId="project-a" autoMergeEnabled={false} />);
    expect(view.container.querySelector(".card-agent-badge")).toHaveTextContent("Agent A");
    expect(view.container.querySelector(".card-agent-badge")).not.toHaveTextContent("Agent B");
    expect(fetchAgent).toHaveBeenCalledTimes(1);
  });

  it("drops old active diff stats when updatedAt and modifiedFiles identify a new snapshot", async () => {
    const firstDiff = deferred<{ files: never[]; stats: { filesChanged: number; additions: number; deletions: number } }>();
    const secondDiff = deferred<{ files: never[]; stats: { filesChanged: number; additions: number; deletions: number } }>();
    vi.mocked(fetchTaskDiff)
      .mockReturnValueOnce(firstDiff.promise as ReturnType<typeof fetchTaskDiff>)
      .mockReturnValueOnce(secondDiff.promise as ReturnType<typeof fetchTaskDiff>);
    vi.mocked(fetchMission).mockResolvedValue({ title: "Mission" } as Awaited<ReturnType<typeof fetchMission>>);
    vi.mocked(fetchAgent).mockResolvedValue({ name: "Agent" } as Awaited<ReturnType<typeof fetchAgent>>);

    let intersect!: IntersectionObserverCallback;
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: IntersectionObserverCallback) { intersect = callback; }
      observe() {}
      disconnect() {}
    });

    const baseTask = makeTask({
      column: "in-progress",
      updatedAt: "2026-09-09T15:00:00.000Z",
      modifiedFiles: ["src/a.ts"],
      worktree: "/repo/.worktrees/fn-321",
      mergeDetails: undefined,
    });
    const props = { onOpenDetail: vi.fn(), addToast: vi.fn(), onOpenDetailWithTab: vi.fn() };
    const view = render(<TaskCard {...props} task={baseTask} projectId="project-a" />);
    expect(screen.getByRole("button", { name: "1 file changed" })).toBeTruthy();

    await act(async () => {
      intersect([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
      firstDiff.resolve({ files: [], stats: { filesChanged: 9, additions: 1, deletions: 0 } });
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "9 files changed" })).toBeTruthy();

    view.rerender(<TaskCard {...props} task={{
      ...baseTask,
      updatedAt: "2026-09-09T15:01:00.000Z",
      modifiedFiles: ["src/a.ts", "src/b.ts", "src/c.ts"],
    }} projectId="project-a" />);
    expect(screen.getByRole("button", { name: "3 files changed" })).toBeTruthy();

    await act(async () => {
      secondDiff.resolve({ files: [], stats: { filesChanged: 4, additions: 2, deletions: 1 } });
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "4 files changed" })).toBeTruthy();
    expect(fetchTaskDiff).toHaveBeenCalledTimes(2);
  });

  it("does not add a files region when the snapshot has no delivery evidence", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    vi.mocked(fetchTaskDiff).mockResolvedValue({ files: [], stats: { filesChanged: 5, additions: 1, deletions: 0 } } as Awaited<ReturnType<typeof fetchTaskDiff>>);
    const { container } = render(<TaskCard task={makeTask({ mergeDetails: { commitSha: "abc", mergeConfirmed: true } as Task["mergeDetails"] })} onOpenDetail={vi.fn()} addToast={vi.fn()} onOpenDetailWithTab={vi.fn()} />);
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector(".card-session-files")).toBeNull();
    expect(container.querySelector(".card-footer-row")).toBeNull();
  });
});
