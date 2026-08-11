import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { MainContentProps } from "../types";
import { MainContent } from "../MainContent";
import { NATIVE_STRUCTURE_DRAG_MIME } from "../../../utils/nativeStructureDrag";

const { fetchMissionMock, fetchMissionsMock, fetchInsightsMock, listEvalsMock, receivedPluginContexts } = vi.hoisted(() => ({
  fetchMissionMock: vi.fn(),
  fetchMissionsMock: vi.fn(),
  fetchInsightsMock: vi.fn(),
  listEvalsMock: vi.fn(),
  receivedPluginContexts: [] as Array<{ beginNativeStructureDrag?: (dataTransfer: DataTransfer, ref: { kind: "roadmap-item"; id: string; projectId?: string }) => boolean }>,
}));

vi.mock("../../../api", () => ({
  fetchMission: fetchMissionMock,
  fetchMissions: fetchMissionsMock,
  fetchInsights: fetchInsightsMock,
  listEvals: listEvalsMock,
  fetchTaskDetail: vi.fn(),
}));

vi.mock("../../../plugins/PluginDashboardViewHost", () => ({
  PluginDashboardViewHost: ({ context }: { context: (typeof receivedPluginContexts)[number] }) => {
    receivedPluginContexts.push(context);
    return null;
  },
}));

vi.mock("../../MailboxView", () => ({
  MailboxView: ({ nativeStructureCandidates = [], onOpenNativeStructure }: {
    nativeStructureCandidates?: Array<{ ref: { kind: string; id: string }; label: string }>;
    onOpenNativeStructure?: (ref: { kind: string; id: string }, payload: { available: boolean; openTarget: Record<string, string> }) => void;
  }) => (
    <>
      <output data-testid="native-structure-candidates">{nativeStructureCandidates.map((candidate) => `${candidate.ref.kind}:${candidate.label}`).join("|")}</output>
      {["mission", "milestone", "goal", "research-finding", "eval-result", "roadmap-item"].map((kind) => (
        <button
          key={kind}
          type="button"
          onClick={() => onOpenNativeStructure?.({ kind, id: `${kind}-id` }, { available: true, openTarget: { id: `${kind}-id`, missionId: "mission-id" } })}
        >Open {kind}</button>
      ))}
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
    taskView: "mailbox",
    modalManager: { openPlanningWithSession: vi.fn() } as unknown as MainContentProps["modalManager"],
    handleChangeTaskView: vi.fn(),
    refreshAppSettings: vi.fn(async () => undefined),
    addToast: vi.fn(),
    currentProject: { id: "project-1", name: "Project 1" } as MainContentProps["currentProject"],
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
    ...overrides,
  } as unknown as MainContentProps;
}

function response(body: unknown, ok = true) {
  return { ok, json: vi.fn(async () => body) } as unknown as Response;
}

describe("MainContent roadmap native structures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMissionsMock.mockResolvedValue([{ id: "M-1", title: "Mission" }]);
    fetchMissionMock.mockResolvedValue({ milestones: [{ id: "MS-1", title: "Milestone" }] });
    fetchInsightsMock.mockResolvedValue({ insights: [{ id: "I-1", title: "Research" }], count: 1 });
    listEvalsMock.mockResolvedValue({ results: [{ id: "E-1", taskId: "FN-1", taskSnapshot: { title: "Eval" } }], count: 1 });
  });

  it("loads roadmap feature candidates alongside the five existing kinds and opens every mail destination", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.startsWith("/api/goals")) return Promise.resolve(response({ goals: [{ id: "G-1", title: "Goal" }] }));
      if (url.includes("/roadmaps/RM-1")) return Promise.resolve(response({ milestones: [{ features: [{ id: "RF-1", title: "Roadmap feature" }] }] }));
      return Promise.resolve(response([{ id: "RM-1" }]));
    });
    vi.stubGlobal("fetch", fetchMock);
    const handleChangeTaskView = vi.fn();
    const setMissionTargetId = vi.fn();
    const setGoalAnchorId = vi.fn();
    render(<MainContent {...props({ handleChangeTaskView, setMissionTargetId, setGoalAnchorId })} />);

    await waitFor(() => expect(screen.getByTestId("native-structure-candidates")).toHaveTextContent(
      "mission:Mission|milestone:Milestone|research-finding:Research|eval-result:Eval|goal:Goal|roadmap-item:Roadmap feature",
    ));
    screen.getByRole("button", { name: "Open roadmap-item" }).click();
    expect(handleChangeTaskView).toHaveBeenCalledWith("plugin:fusion-plugin-roadmap:roadmaps");

    screen.getByRole("button", { name: "Open mission" }).click();
    screen.getByRole("button", { name: "Open milestone" }).click();
    expect(setMissionTargetId).toHaveBeenLastCalledWith("mission-id");
    screen.getByRole("button", { name: "Open goal" }).click();
    expect(setGoalAnchorId).toHaveBeenCalledWith("goal-id");
    screen.getByRole("button", { name: "Open research-finding" }).click();
    expect(handleChangeTaskView).toHaveBeenCalledWith("research");
    screen.getByRole("button", { name: "Open eval-result" }).click();
    expect(handleChangeTaskView).toHaveBeenCalledWith("evals");
    vi.unstubAllGlobals();
  });

  it("injects the host-owned native-structure drag hook into the production plugin context", () => {
    receivedPluginContexts.length = 0;
    render(<MainContent {...props({
      taskView: "plugin:fusion-plugin-roadmap:roadmaps",
      pluginDashboardViews: [{
        pluginId: "fusion-plugin-roadmap",
        view: { viewId: "roadmaps", label: "Roadmaps", placement: "primary" },
      }],
    })} />);

    const beginNativeStructureDrag = receivedPluginContexts.at(-1)?.beginNativeStructureDrag;
    expect(beginNativeStructureDrag).toBeTypeOf("function");
    const values = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: "move",
      setData: (type: string, value: string) => values.set(type, value),
      getData: (type: string) => values.get(type) ?? "",
    } as unknown as DataTransfer;

    expect(beginNativeStructureDrag?.(dataTransfer, { kind: "roadmap-item", id: "RF-1", projectId: "project-1" })).toBe(true);
    expect(dataTransfer.getData(NATIVE_STRUCTURE_DRAG_MIME)).toBe(JSON.stringify({ kind: "roadmap-item", id: "RF-1", projectId: "project-1" }));
    expect(dataTransfer.effectAllowed).toBe("move");
  });

  it("keeps the production plugin drag hook inert on coarse pointers", () => {
    receivedPluginContexts.length = 0;
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    render(<MainContent {...props({
      taskView: "plugin:fusion-plugin-roadmap:roadmaps",
      pluginDashboardViews: [{
        pluginId: "fusion-plugin-roadmap",
        view: { viewId: "roadmaps", label: "Roadmaps", placement: "primary" },
      }],
    })} />);

    const values = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: "move",
      setData: (type: string, value: string) => values.set(type, value),
      getData: (type: string) => values.get(type) ?? "",
    } as unknown as DataTransfer;
    expect(receivedPluginContexts.at(-1)?.beginNativeStructureDrag?.(dataTransfer, { kind: "roadmap-item", id: "RF-1" })).toBe(false);
    expect(values.size).toBe(0);
    expect(dataTransfer.effectAllowed).toBe("move");
    vi.unstubAllGlobals();
  });

  it("silently keeps existing candidates when roadmap routes are unavailable or empty", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(
      url.startsWith("/api/goals")
        ? response({ goals: [{ id: "G-1", title: "Goal" }] })
        : response([], false),
    )));
    render(<MainContent {...props()} />);

    await waitFor(() => expect(screen.getByTestId("native-structure-candidates")).toHaveTextContent(
      "mission:Mission|milestone:Milestone|research-finding:Research|eval-result:Eval|goal:Goal",
    ));
    expect(screen.getByTestId("native-structure-candidates")).not.toHaveTextContent("roadmap-item");
    vi.unstubAllGlobals();
  });
});
