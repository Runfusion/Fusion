import { render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { MainContent } from "../MainContent";
import type { MainContentProps } from "../types";

/*
FNXC:ProjectSwitchModalReset 2026-07-23-00:00:
Regression coverage: embedded project-scoped views must remount when the active project
changes. Without the project-keyed remount, Planning kept a running plan's stream/selected
session/sidebar list from the previous project (and persisted its session under the new
project's storage key), Chat kept the previous project's active conversation and live
stream rendering under the new project, and Missions kept its nested interview modals
connected to the previous project's sessions.
*/

const { planningMounts, chatMounts, missionMounts } = vi.hoisted(() => ({
  planningMounts: [] as Array<string | undefined>,
  chatMounts: [] as Array<string | undefined>,
  missionMounts: [] as Array<string | undefined>,
}));

vi.mock("../../PlanningModeModal", () => ({
  PlanningModeModal: ({ projectId }: { projectId?: string }) => {
    useEffect(() => {
      planningMounts.push(projectId);
    }, []);
    return <output aria-label="Planning project">{projectId ?? "none"}</output>;
  },
}));

vi.mock("../PlanningWorkflowSwitcherSlot", () => ({
  PlanningWorkflowSwitcherSlot: () => null,
}));

vi.mock("../../MissionManager", () => ({
  MissionManager: ({ projectId }: { projectId?: string }) => {
    useEffect(() => {
      missionMounts.push(projectId);
    }, []);
    return <output aria-label="Missions project">{projectId ?? "none"}</output>;
  },
}));

vi.mock("../../HeaderWorkflowSwitcherSlot", () => ({
  HeaderWorkflowSwitcherSlot: () => null,
}));

// ChatView is a lazy chunk threaded in via props (see MainContent header comment),
// so the mock is passed through mainContentProps instead of vi.mock.
function MockChatView({ projectId }: { projectId?: string }) {
  useEffect(() => {
    chatMounts.push(projectId);
  }, []);
  return <output aria-label="Chat project">{projectId ?? "none"}</output>;
}

function mainContentProps(overrides: Partial<MainContentProps> = {}): MainContentProps {
  return {
    showBackendConnectionErrorPage: false,
    projectsError: null,
    t: ((key: string, fallback?: string) => fallback ?? key) as MainContentProps["t"],
    retryingProjects: false,
    handleRetryProjects: vi.fn(),
    shellApi: null,
    taskView: "planning",
    modalManager: {
      closePlanning: vi.fn(),
      planningInitialPlan: null,
      planningResumeSessionId: undefined,
      planningWorkflowId: null,
    } as unknown as MainContentProps["modalManager"],
    handleChangeTaskView: vi.fn(),
    refreshAppSettings: vi.fn(async () => undefined),
    addToast: vi.fn(),
    currentProject: { id: "project-1", name: "Project 1" } as MainContentProps["currentProject"],
    ChatView: MockChatView,
    viewMode: "project",
    tasks: [],
    workflowSteps: [],
    bgPlanningSessions: [],
    openDetailTask: vi.fn(),
    popOutTaskDetail: vi.fn(),
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

describe("MainContent planning project remount", () => {
  it("remounts embedded Planning when the active project changes", () => {
    const { rerender } = render(<MainContent {...mainContentProps()} />);

    expect(screen.getByLabelText("Planning project")).toHaveTextContent("project-1");
    expect(planningMounts).toEqual(["project-1"]);

    rerender(
      <MainContent
        {...mainContentProps({
          currentProject: { id: "project-2", name: "Project 2" } as MainContentProps["currentProject"],
        })}
      />,
    );

    // A fresh mount for the new project — not a prop update on the old instance.
    expect(screen.getByLabelText("Planning project")).toHaveTextContent("project-2");
    expect(planningMounts).toEqual(["project-1", "project-2"]);
  });

  it("remounts embedded Chat when the active project changes", () => {
    const { rerender } = render(<MainContent {...mainContentProps({ taskView: "chat" })} />);
    expect(chatMounts).toEqual(["project-1"]);

    rerender(
      <MainContent
        {...mainContentProps({
          taskView: "chat",
          currentProject: { id: "project-2", name: "Project 2" } as MainContentProps["currentProject"],
        })}
      />,
    );

    expect(screen.getByLabelText("Chat project")).toHaveTextContent("project-2");
    expect(chatMounts).toEqual(["project-1", "project-2"]);
  });

  it("remounts Missions when the active project changes", () => {
    const { rerender } = render(<MainContent {...mainContentProps({ taskView: "missions" })} />);
    expect(missionMounts).toEqual(["project-1"]);

    rerender(
      <MainContent
        {...mainContentProps({
          taskView: "missions",
          currentProject: { id: "project-2", name: "Project 2" } as MainContentProps["currentProject"],
        })}
      />,
    );

    expect(screen.getByLabelText("Missions project")).toHaveTextContent("project-2");
    expect(missionMounts).toEqual(["project-1", "project-2"]);
  });
});
