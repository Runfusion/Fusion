import { useState } from "react";
import type { Task, TaskDetail } from "@fusion/core";
import type { AiSessionSummary } from "../../api";
import { PageErrorBoundary } from "../ErrorBoundary";
import { PlanningModeModal } from "../PlanningModeModal";
import { PlanningWorkflowSwitcherSlot } from "../PlanningWorkflowSwitcherSlot";
import { KeepAliveView } from "../KeepAliveView";
import type { ModalManager, DetailTaskTab } from "../../hooks/useModalManager";
import type { TaskView } from "../../hooks/useViewState";

/*
FNXC:PlanningKeepAlive 2026-07-22-12:30:
FN remount-churn fix R5: the embedded Planning Mode view previously lived inside MainContent's pure taskView switch, so every sidebar navigation destroyed the whole interview (ViewState, conversation, streaming output, draft edits, scroll). This host renders the planning subtree as a kept-alive sibling of MainContent inside .project-content: App mounts it after Planning's first open for the current project (everOpened latch mirroring Quick Chat's quickChatEverOpenedProjectId) and it then stays mounted, hidden via KeepAliveView's out-of-flow visibility contract whenever another view is active.
- `active` (taskView === "planning") gates PlanningModeModal's background work (session-list SSE, recovery poll, elapsed ticker) while hidden per R8.
- The header WorkflowSwitcher portal renders only while active so a hidden Planning view never occupies the shared Header slot.
- App keys this host by project id + modalManager.planningEntryGeneration: project switches and payload-carrying entry points (initial-plan handoff, resume session) remount with fresh-open semantics, while plain navigation restores the live instance (R10 — explicit handoffs keep their pre-keep-alive reset behavior).
- Explicit close still runs modalManager.closePlanning() (clears the entry payload) and returns to Board; the tree stays mounted for the next instant reveal.
*/
export interface PlanningKeepAliveProps {
  active: boolean;
  projectId: string;
  tasks: Task[];
  bgPlanningSessions: AiSessionSummary[];
  modalManager: ModalManager;
  handleChangeTaskView: (newView: TaskView) => void;
  handlePlanningTaskCreated: (task: Task) => void;
  handlePlanningTasksCreated: (tasks: Task[]) => void;
  openBoardTaskDetail: (task: Task | TaskDetail, initialTab?: DetailTaskTab) => void;
  openWorkflowEditorWithNav: (workflowId?: string) => void;
}

export function PlanningKeepAlive({
  active,
  projectId,
  tasks,
  bgPlanningSessions,
  modalManager,
  handleChangeTaskView,
  handlePlanningTaskCreated,
  handlePlanningTasksCreated,
  openBoardTaskDetail,
  openWorkflowEditorWithNav,
}: PlanningKeepAliveProps) {
  const [planningHeaderWorkflowId, setPlanningHeaderWorkflowId] = useState<string | null>(null);

  const closePlanningView = () => {
    modalManager.closePlanning();
    handleChangeTaskView("board");
  };

  return (
    <KeepAliveView hidden={!active} testId="planning-keep-alive">
      <PageErrorBoundary>
        {active ? (
          <PlanningWorkflowSwitcherSlot
            projectId={projectId}
            onOpenWorkflowEditor={openWorkflowEditorWithNav}
            onWorkflowSelectionChange={(selection) => setPlanningHeaderWorkflowId(selection && !selection.isAllWorkflowsSelected ? selection.selectedWorkflow.id : null)}
          />
        ) : null}
        <PlanningModeModal
          isOpen={true}
          active={active}
          onClose={closePlanningView}
          onTaskCreated={handlePlanningTaskCreated}
          onTasksCreated={handlePlanningTasksCreated}
          onViewTask={openBoardTaskDetail}
          tasks={tasks}
          initialSessions={bgPlanningSessions}
          initialPlan={modalManager.planningInitialPlan ?? undefined}
          projectId={projectId}
          workflowId={modalManager.planningWorkflowId ?? planningHeaderWorkflowId}
          resumeSessionId={modalManager.planningResumeSessionId}
          presentation="embedded"
        />
      </PageErrorBoundary>
    </KeepAliveView>
  );
}
