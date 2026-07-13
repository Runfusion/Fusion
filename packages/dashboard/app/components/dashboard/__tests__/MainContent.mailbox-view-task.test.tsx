import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TaskDetail } from "@fusion/core";
import { MainContent } from "../MainContent";
import type { MainContentProps } from "../types";

const { fetchTaskDetailMock } = vi.hoisted(() => ({
  fetchTaskDetailMock: vi.fn(),
}));

vi.mock("../../../api", () => ({
  fetchTaskDetail: fetchTaskDetailMock,
}));

vi.mock("../../MailboxView", () => ({
  MailboxView: ({ onOpenTask }: { onOpenTask?: (taskId: string) => void }) => (
    <button type="button" onClick={() => onOpenTask?.("FN-7935")}>Open mailbox artifact task</button>
  ),
}));

function mainContentProps(overrides: Partial<MainContentProps> = {}): MainContentProps {
  return {
    showBackendConnectionErrorPage: false,
    projectsError: null,
    t: ((key: string, fallback?: string) => fallback ?? key) as MainContentProps["t"],
    retryingProjects: false,
    handleRetryProjects: vi.fn(),
    shellApi: null,
    taskView: "mailbox",
    modalManager: {} as MainContentProps["modalManager"],
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

describe("MainContent mailbox artifact View task routing", () => {
  it("opens mailbox artifact tasks in the shared popped-out task-detail window", async () => {
    const fetchedTask = {
      id: "FN-7935",
      title: "Mailbox artifact task",
      description: "Task opened from a mailbox artifact message",
      column: "todo",
      status: "todo",
      dependencies: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      steps: [],
    } as unknown as TaskDetail;
    const openDetailTask = vi.fn();
    const popOutTaskDetail = vi.fn();

    fetchTaskDetailMock.mockResolvedValueOnce(fetchedTask);

    render(<MainContent {...mainContentProps({ openDetailTask, popOutTaskDetail })} />);

    screen.getByText("Open mailbox artifact task").click();

    await waitFor(() => expect(popOutTaskDetail).toHaveBeenCalledWith(fetchedTask));
    expect(fetchTaskDetailMock).toHaveBeenCalledWith("FN-7935", "project-1");
    expect(openDetailTask).not.toHaveBeenCalled();
  });
});
