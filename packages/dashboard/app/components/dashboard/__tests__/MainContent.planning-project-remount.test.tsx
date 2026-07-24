import { render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { MainContent } from "../MainContent";
import type { MainContentProps } from "../types";

/*
FNXC:ProjectSwitchModalReset 2026-07-23-00:00:
Regression coverage: embedded Planning must remount when the active project changes.
Without the project-keyed remount, a running plan kept its stream, selected session, and
sidebar session list from the previous project, and the durable-active-session effect
persisted the old project's session under the new project's storage key — so the new
project kept restoring the previous project's plan.
*/

const { planningMounts } = vi.hoisted(() => ({
  planningMounts: [] as Array<string | undefined>,
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
});
