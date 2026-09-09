import React from "react";
import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";

vi.mock("../../hooks/useToast", () => ({ useOptionalToast: () => null, useToast: () => ({ addToast: vi.fn(), removeToast: vi.fn(), toasts: [] }) }));
vi.mock("../../api", () => ({
  fetchTaskDiff: vi.fn(),
  fetchWorkflowSettingValues: vi.fn(),
  fetchMission: vi.fn(),
  fetchAgent: vi.fn(),
  fetchAgents: vi.fn().mockResolvedValue([]),
  rebuildTaskSpec: vi.fn(),
}));
vi.mock("../../hooks/useBadgeWebSocket", () => ({
  useBadgeWebSocket: () => ({ badgeUpdates: new Map(), isConnected: false, subscribeToBadge: vi.fn(), unsubscribeFromBadge: vi.fn() }),
}));
vi.mock("../../hooks/useAgentsMapCache", () => ({
  useAgentsMapCache: (projectId?: string) => {
    const [agentsMap, setAgentsMap] = React.useState(() => new Map());
    React.useEffect(() => setAgentsMap(new Map()), [projectId]);
    return { agentsMap, agents: [], loading: false, refresh: vi.fn() };
  },
}));
vi.mock("../ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("../PluginSlot", () => ({ PluginSlot: () => null }));

import { fetchAgent, fetchMission, fetchTaskDiff, fetchWorkflowSettingValues } from "../../api";
import { __test_clearDiffStatsCache } from "../../hooks/useTaskDiffStats";
import {
  __test_clearAgentNameCache,
  __test_clearMissionTitleCache,
  __test_clearWorkflowOversightEffectiveCache,
} from "../TaskCard";
import { Column } from "../Column";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeTask(): Task {
  return {
    id: "FN-321",
    title: "Measured card",
    description: "",
    column: "done",
    steps: [],
    dependencies: [],
    missionId: "M-321",
    assignedAgentId: "agent-321",
    planningWorkflowId: "builtin:coding",
    mergeDetails: { commitSha: "abc", filesChanged: 2, mergeConfirmed: true },
  } as Task;
}

const structuralSelectors = [
  ".card-header",
  ".card-header-badges",
  ".card-mission-badge",
  ".card-footer-row",
  ".card-session-files",
  ".card-agent-row",
  ".card-agent-badge",
  ".card-meta-badges",
  ".card-oversight-level-badge",
] as const;

function structuralSignature(card: HTMLElement): string {
  return structuralSelectors.filter((selector) => card.querySelector(selector)).join("|");
}

function installMeasuredVirtualRows(width: number) {
  const observedRows = new Set<Element>();
  const resizeCallbacks: ResizeObserverCallback[] = [];
  const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function measuredRect() {
    const card = this.matches("[data-virtual-task-row]") ? this.querySelector<HTMLElement>(".card") : null;
    const regionCount = card ? structuralSelectors.filter((selector) => card.querySelector(selector)).length : 0;
    const height = card ? 96 + regionCount * 12 : 640;
    return { x: 0, y: 0, width, height, top: 0, right: width, bottom: height, left: 0, toJSON: () => ({}) } as DOMRect;
  });
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { resizeCallbacks.push(callback); }
    observe(target: Element) { observedRows.add(target); }
    unobserve(target: Element) { observedRows.delete(target); }
    disconnect() {}
  });
  return {
    observedRows,
    notify() {
      for (const callback of resizeCallbacks) {
        const entries = [...observedRows].map((target) => ({
          target,
          contentRect: target.getBoundingClientRect(),
          borderBoxSize: [],
        })) as unknown as ResizeObserverEntry[];
        callback(entries, {} as ResizeObserver);
      }
    },
    restore: () => rectSpy.mockRestore(),
  };
}

function renderColumn(task: Task) {
  return render(
    <Column
      column="done"
      tasks={[task]}
      projectId="project-a"
      maxConcurrent={1}
      maxWorktrees={1}
      showWorktreeGrouping={false}
      onMoveTask={vi.fn(async () => task)}
      onOpenDetail={vi.fn()}
      onOpenDetailWithTab={vi.fn()}
      addToast={vi.fn()}
      workflowMode
      workflowId="builtin:coding"
      columnDisplayName="Complete"
      columnFlags={{ complete: true }}
    />,
  );
}

describe("TaskCard measured-row stability through Column virtualization", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    __test_clearDiffStatsCache();
    __test_clearMissionTitleCache();
    __test_clearAgentNameCache();
    __test_clearWorkflowOversightEffectiveCache();
  });

  it.each([
    { width: 1280, observer: "retained", outcome: "success" },
    { width: 768, observer: "retained", outcome: "success" },
    { width: 375, observer: "retained", outcome: "success" },
    { width: 1280, observer: "absent", outcome: "success" },
    { width: 768, observer: "absent", outcome: "success" },
    { width: 375, observer: "absent", outcome: "success" },
    { width: 1280, observer: "retained", outcome: "failure" },
    { width: 768, observer: "retained", outcome: "failure" },
    { width: 375, observer: "retained", outcome: "failure" },
    { width: 1280, observer: "absent", outcome: "failure" },
    { width: 768, observer: "absent", outcome: "failure" },
    { width: 375, observer: "absent", outcome: "failure" },
  ] as const)("keeps the measured row stable at $width px with observer $observer and $outcome enrichments", async ({ width, observer, outcome }) => {
    Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
    const measurement = installMeasuredVirtualRows(width);
    const diff = deferred<Awaited<ReturnType<typeof fetchTaskDiff>>>();
    const mission = deferred<Awaited<ReturnType<typeof fetchMission>>>();
    const agent = deferred<Awaited<ReturnType<typeof fetchAgent>>>();
    const oversight = deferred<Awaited<ReturnType<typeof fetchWorkflowSettingValues>>>();
    vi.mocked(fetchTaskDiff).mockReturnValue(diff.promise);
    vi.mocked(fetchMission).mockReturnValue(mission.promise);
    vi.mocked(fetchAgent).mockReturnValue(agent.promise);
    vi.mocked(fetchWorkflowSettingValues).mockReturnValue(oversight.promise);

    let intersect: IntersectionObserverCallback | undefined;
    if (observer === "retained") {
      vi.stubGlobal("IntersectionObserver", class {
        constructor(callback: IntersectionObserverCallback) { intersect = callback; }
        observe() {}
        disconnect() {}
      });
    } else {
      vi.stubGlobal("IntersectionObserver", undefined);
    }

    const view = renderColumn(makeTask());
    const row = view.container.querySelector<HTMLElement>("[data-virtual-task-row='FN-321']")!;
    const card = row.querySelector<HTMLElement>(".card")!;
    const initialSignature = structuralSignature(card);
    const initialHeight = row.getBoundingClientRect().height;
    const missionNode = card.querySelector(".card-mission-badge");
    const agentNode = card.querySelector(".card-agent-badge");
    const filesNode = card.querySelector(".card-session-files");

    expect(row).toBeTruthy();
    expect(measurement.observedRows.has(row)).toBe(true);
    expect(initialSignature).toContain(".card-session-files");
    expect(initialSignature).toContain(".card-mission-badge");
    expect(initialSignature).toContain(".card-agent-badge");

    if (intersect) {
      await act(async () => {
        intersect?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
        await Promise.resolve();
      });
    }
    await waitFor(() => expect(fetchTaskDiff).toHaveBeenCalledTimes(1));

    await act(async () => {
      if (outcome === "success") {
        diff.resolve({ files: [], stats: { filesChanged: 4, additions: 2, deletions: 1 } });
        mission.resolve({ id: "M-321", title: "Mission enrichie" } as Awaited<ReturnType<typeof fetchMission>>);
        agent.resolve({ id: "agent-321", name: "Agent enrichi" } as Awaited<ReturnType<typeof fetchAgent>>);
        oversight.resolve({ stored: {}, effective: { plannerOversightLevel: "steer" }, orphaned: [] });
      } else {
        diff.reject(new Error("diff unavailable"));
        mission.reject(new Error("mission unavailable"));
        agent.reject(new Error("agent unavailable"));
        oversight.reject(new Error("oversight unavailable"));
      }
      await Promise.resolve();
    });
    await act(async () => {
      measurement.notify();
      await Promise.resolve();
    });

    expect(structuralSignature(card)).toBe(initialSignature);
    expect(row.getBoundingClientRect().height).toBe(initialHeight);
    expect(card.querySelector(".card-mission-badge")).toBe(missionNode);
    expect(card.querySelector(".card-agent-badge")).toBe(agentNode);
    expect(card.querySelector(".card-session-files")).toBe(filesNode);
    measurement.restore();
  });
});
