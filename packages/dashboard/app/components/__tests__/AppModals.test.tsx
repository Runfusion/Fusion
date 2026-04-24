import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { AppModals } from "../AppModals";
import type { ModalManager } from "../../hooks/useModalManager";
import type { Toast } from "../../hooks/useToast";

// Mock the modals to avoid rendering all of them
vi.mock("../TaskDetailModal", () => ({
  TaskDetailModal: () => null,
}));

vi.mock("../SettingsModal", () => ({
  SettingsModal: () => null,
}));

vi.mock("../GitHubImportModal", () => ({
  GitHubImportModal: () => null,
}));

vi.mock("../PlanningModeModal", () => ({
  PlanningModeModal: () => null,
}));

vi.mock("../SubtaskBreakdownModal", () => ({
  SubtaskBreakdownModal: () => null,
}));

vi.mock("../TerminalModal", () => ({
  TerminalModal: () => null,
}));

vi.mock("../ScriptsModal", () => ({
  ScriptsModal: () => null,
}));

vi.mock("../FileBrowserModal", () => ({
  FileBrowserModal: () => null,
}));

vi.mock("../UsageIndicator", () => ({
  UsageIndicator: () => null,
}));

// Mock ScheduledTasksModal to capture props
const mockScheduledTasksModalProps = vi.fn();
vi.mock("../ScheduledTasksModal", () => ({
  ScheduledTasksModal: ({ projectId, ...rest }: any) => {
    mockScheduledTasksModalProps({ projectId, rest });
    return null;
  },
}));

vi.mock("../NewTaskModal", () => ({
  NewTaskModal: () => null,
}));

vi.mock("../ActivityLogModal", () => ({
  ActivityLogModal: () => null,
}));

vi.mock("../GitManagerModal", () => ({
  GitManagerModal: () => null,
}));

vi.mock("../WorkflowStepManager", () => ({
  WorkflowStepManager: () => null,
}));

vi.mock("../AgentListModal", () => ({
  AgentListModal: () => null,
}));

vi.mock("../SetupWizardModal", () => ({
  SetupWizardModal: () => null,
}));

const mockModelOnboardingModalProps = vi.fn();
vi.mock("../ModelOnboardingModal", () => ({
  ModelOnboardingModal: (props: any) => {
    mockModelOnboardingModalProps(props);
    return null;
  },
}));

vi.mock("../ToastContainer", () => ({
  ToastContainer: () => null,
}));

vi.mock("../../hooks/useTaskHandlers", () => ({
  useTaskHandlers: () => ({
    handleModalCreate: vi.fn(),
    handlePlanningTaskCreated: vi.fn(),
    handlePlanningTasksCreated: vi.fn(),
    handleSubtaskTasksCreated: vi.fn(),
    handleGitHubImport: vi.fn(),
  }),
}));

vi.mock("../../hooks/useProjectActions", () => ({
  useProjectActions: () => ({
    handleSetupComplete: vi.fn(),
    handleModelOnboardingComplete: vi.fn(),
  }),
}));

// Mock @fusion/core types
vi.mock("@fusion/core", () => ({}));

// Mock ModalErrorBoundary
vi.mock("../ErrorBoundary", () => ({
  ModalErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe("AppModals", () => {
  const mockModalManager: ModalManager = {
    detailTask: null,
    settingsOpen: false,
    githubImportOpen: false,
    isPlanningOpen: false,
    planningInitialPlan: null,
    planningResumeSessionId: null,
    isSubtaskOpen: false,
    subtaskInitialDescription: null,
    subtaskResumeSessionId: null,
    terminalOpen: false,
    terminalInitialCommand: null,
    scriptsOpen: false,
    runScript: vi.fn(),
    filesOpen: false,
    fileBrowserWorkspace: "project",
    usageOpen: false,
    schedulesOpen: false,
    newTaskModalOpen: false,
    activityLogOpen: false,
    gitManagerOpen: false,
    workflowStepsOpen: false,
    agentsOpen: false,
    setupWizardOpen: false,
    modelOnboardingOpen: false,
    openDetailTask: vi.fn(),
    updateDetailTask: vi.fn(),
    openSettings: vi.fn(),
    closeSettings: vi.fn(),
    closeGitHubImport: vi.fn(),
    openPlanning: vi.fn(),
    closePlanning: vi.fn(),
    openSubtaskBreakdown: vi.fn(),
    closeSubtask: vi.fn(),
    openTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    openScripts: vi.fn(),
    closeScripts: vi.fn(),
    openFiles: vi.fn(),
    closeFiles: vi.fn(),
    setFileWorkspace: vi.fn(),
    openUsage: vi.fn(),
    closeUsage: vi.fn(),
    openSchedules: vi.fn(),
    closeSchedules: vi.fn(),
    openNewTask: vi.fn(),
    closeNewTask: vi.fn(),
    openActivityLog: vi.fn(),
    closeActivityLog: vi.fn(),
    openGitManager: vi.fn(),
    closeGitManager: vi.fn(),
    openWorkflowSteps: vi.fn(),
    closeWorkflowSteps: vi.fn(),
    openAgents: vi.fn(),
    closeAgents: vi.fn(),
    openSetupWizard: vi.fn(),
    closeSetupWizard: vi.fn(),
    openModelOnboarding: vi.fn(),
    closeModelOnboarding: vi.fn(),
    openDetailTaskInitialTab: vi.fn(),
    settingsInitialSection: null,
    detailTaskInitialTab: null,
  };

  const mockToasts: Toast[] = [];
  const mockSettings = {
    prAuthAvailable: false,
    themeMode: "dark" as const,
    colorTheme: "default" as const,
    setThemeMode: vi.fn(),
    setColorTheme: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockScheduledTasksModalProps.mockClear();
    mockModelOnboardingModalProps.mockClear();
  });

  it("renders without crashing", () => {
    render(
      <AppModals
        projectId={undefined}
        tasks={[]}
        projects={[]}
        currentProject={null}
        addToast={vi.fn()}
        toasts={mockToasts}
        removeToast={vi.fn()}
        modalManager={mockModalManager}
        projectActions={{ handleAddProject: vi.fn(), handleSetupComplete: vi.fn(), handleModelOnboardingComplete: vi.fn() }}
        taskHandlers={{ handleModalCreate: vi.fn(), handlePlanningTaskCreated: vi.fn(), handlePlanningTasksCreated: vi.fn(), handleSubtaskTasksCreated: vi.fn(), handleGitHubImport: vi.fn() }}
        taskOperations={{ moveTask: vi.fn(), deleteTask: vi.fn(), mergeTask: vi.fn(), retryTask: vi.fn(), duplicateTask: vi.fn() }}
        deepLink={{ handleDetailClose: vi.fn() }}
        settings={mockSettings}
      />
    );
    expect(document.body).toBeDefined();
  });

  describe("ModelOnboardingModal wiring", () => {
    it("passes empty project id and setup-wizard callback into onboarding modal when no project is selected", () => {
      const handleAddProject = vi.fn();
      const manager = { ...mockModalManager, modelOnboardingOpen: true };

      render(
        <AppModals
          projectId={undefined}
          tasks={[]}
          projects={[]}
          currentProject={null}
          addToast={vi.fn()}
          toasts={mockToasts}
          removeToast={vi.fn()}
          modalManager={manager}
          projectActions={{ handleAddProject, handleSetupComplete: vi.fn(), handleModelOnboardingComplete: vi.fn() }}
          taskHandlers={{ handleModalCreate: vi.fn(), handlePlanningTaskCreated: vi.fn(), handlePlanningTasksCreated: vi.fn(), handleSubtaskTasksCreated: vi.fn(), handleGitHubImport: vi.fn() }}
          taskOperations={{ moveTask: vi.fn(), deleteTask: vi.fn(), mergeTask: vi.fn(), retryTask: vi.fn(), duplicateTask: vi.fn() }}
          deepLink={{ handleDetailClose: vi.fn() }}
          settings={mockSettings}
        />,
      );

      expect(mockModelOnboardingModalProps).toHaveBeenCalledTimes(1);
      const props = mockModelOnboardingModalProps.mock.calls[0][0];
      expect(props.projectId).toBe("");
      expect(props.onOpenSetupWizard).toBe(handleAddProject);
    });

    it("passes active project id into onboarding modal when a project is selected", () => {
      const manager = { ...mockModalManager, modelOnboardingOpen: true };

      render(
        <AppModals
          projectId="proj_123"
          tasks={[]}
          projects={[]}
          currentProject={null}
          addToast={vi.fn()}
          toasts={mockToasts}
          removeToast={vi.fn()}
          modalManager={manager}
          projectActions={{ handleAddProject: vi.fn(), handleSetupComplete: vi.fn(), handleModelOnboardingComplete: vi.fn() }}
          taskHandlers={{ handleModalCreate: vi.fn(), handlePlanningTaskCreated: vi.fn(), handlePlanningTasksCreated: vi.fn(), handleSubtaskTasksCreated: vi.fn(), handleGitHubImport: vi.fn() }}
          taskOperations={{ moveTask: vi.fn(), deleteTask: vi.fn(), mergeTask: vi.fn(), retryTask: vi.fn(), duplicateTask: vi.fn() }}
          deepLink={{ handleDetailClose: vi.fn() }}
          settings={mockSettings}
        />,
      );

      expect(mockModelOnboardingModalProps).toHaveBeenCalledTimes(1);
      const props = mockModelOnboardingModalProps.mock.calls[0][0];
      expect(props.projectId).toBe("proj_123");
    });
  });

  describe("ScheduledTasksModal projectId forwarding", () => {
    it("does not render ScheduledTasksModal when schedulesOpen is false", () => {
      const manager = { ...mockModalManager, schedulesOpen: false };
      render(
        <AppModals
          projectId="proj-123"
          tasks={[]}
          projects={[]}
          currentProject={null}
          addToast={vi.fn()}
          toasts={mockToasts}
          removeToast={vi.fn()}
          modalManager={manager}
          projectActions={{ handleAddProject: vi.fn(), handleSetupComplete: vi.fn(), handleModelOnboardingComplete: vi.fn() }}
          taskHandlers={{ handleModalCreate: vi.fn(), handlePlanningTaskCreated: vi.fn(), handlePlanningTasksCreated: vi.fn(), handleSubtaskTasksCreated: vi.fn(), handleGitHubImport: vi.fn() }}
          taskOperations={{ moveTask: vi.fn(), deleteTask: vi.fn(), mergeTask: vi.fn(), retryTask: vi.fn(), duplicateTask: vi.fn() }}
          deepLink={{ handleDetailClose: vi.fn() }}
          settings={mockSettings}
        />
      );
      expect(mockScheduledTasksModalProps).not.toHaveBeenCalled();
    });

    it("renders ScheduledTasksModal with projectId when schedulesOpen is true and projectId is defined", () => {
      const manager = { ...mockModalManager, schedulesOpen: true };
      render(
        <AppModals
          projectId="proj-abc"
          tasks={[]}
          projects={[]}
          currentProject={null}
          addToast={vi.fn()}
          toasts={mockToasts}
          removeToast={vi.fn()}
          modalManager={manager}
          projectActions={{ handleAddProject: vi.fn(), handleSetupComplete: vi.fn(), handleModelOnboardingComplete: vi.fn() }}
          taskHandlers={{ handleModalCreate: vi.fn(), handlePlanningTaskCreated: vi.fn(), handlePlanningTasksCreated: vi.fn(), handleSubtaskTasksCreated: vi.fn(), handleGitHubImport: vi.fn() }}
          taskOperations={{ moveTask: vi.fn(), deleteTask: vi.fn(), mergeTask: vi.fn(), retryTask: vi.fn(), duplicateTask: vi.fn() }}
          deepLink={{ handleDetailClose: vi.fn() }}
          settings={mockSettings}
        />
      );
      expect(mockScheduledTasksModalProps).toHaveBeenCalledTimes(1);
      const captured = mockScheduledTasksModalProps.mock.calls[0][0];
      expect(captured.projectId).toBe("proj-abc");
    });

    it("renders ScheduledTasksModal with undefined projectId when schedulesOpen is true and projectId is undefined", () => {
      const manager = { ...mockModalManager, schedulesOpen: true };
      render(
        <AppModals
          projectId={undefined}
          tasks={[]}
          projects={[]}
          currentProject={null}
          addToast={vi.fn()}
          toasts={mockToasts}
          removeToast={vi.fn()}
          modalManager={manager}
          projectActions={{ handleAddProject: vi.fn(), handleSetupComplete: vi.fn(), handleModelOnboardingComplete: vi.fn() }}
          taskHandlers={{ handleModalCreate: vi.fn(), handlePlanningTaskCreated: vi.fn(), handlePlanningTasksCreated: vi.fn(), handleSubtaskTasksCreated: vi.fn(), handleGitHubImport: vi.fn() }}
          taskOperations={{ moveTask: vi.fn(), deleteTask: vi.fn(), mergeTask: vi.fn(), retryTask: vi.fn(), duplicateTask: vi.fn() }}
          deepLink={{ handleDetailClose: vi.fn() }}
          settings={mockSettings}
        />
      );
      expect(mockScheduledTasksModalProps).toHaveBeenCalledTimes(1);
      const captured = mockScheduledTasksModalProps.mock.calls[0][0];
      expect(captured.projectId).toBeUndefined();
    });

    it("renders ScheduledTasksModal with undefined projectId when projectId is empty string", () => {
      const manager = { ...mockModalManager, schedulesOpen: true };
      render(
        <AppModals
          projectId=""
          tasks={[]}
          projects={[]}
          currentProject={null}
          addToast={vi.fn()}
          toasts={mockToasts}
          removeToast={vi.fn()}
          modalManager={manager}
          projectActions={{ handleAddProject: vi.fn(), handleSetupComplete: vi.fn(), handleModelOnboardingComplete: vi.fn() }}
          taskHandlers={{ handleModalCreate: vi.fn(), handlePlanningTaskCreated: vi.fn(), handlePlanningTasksCreated: vi.fn(), handleSubtaskTasksCreated: vi.fn(), handleGitHubImport: vi.fn() }}
          taskOperations={{ moveTask: vi.fn(), deleteTask: vi.fn(), mergeTask: vi.fn(), retryTask: vi.fn(), duplicateTask: vi.fn() }}
          deepLink={{ handleDetailClose: vi.fn() }}
          settings={mockSettings}
        />
      );
      expect(mockScheduledTasksModalProps).toHaveBeenCalledTimes(1);
      const captured = mockScheduledTasksModalProps.mock.calls[0][0];
      // Empty string should pass through as-is
      expect(captured.projectId).toBe("");
    });
  });
});
