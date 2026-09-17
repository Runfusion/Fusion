import { useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import type { BoardWorkflowDefinition, BoardWorkflowsPayload } from "../api";
import { useBoardWorkflows } from "../hooks/useBoardWorkflows";
import { ALL_WORKFLOWS_BOARD_VIEW_ID } from "../utils/boardWorkflowSelection";
import { useHeaderWorkflowSlot } from "../hooks/useHeaderWorkflowSlot";
import { WorkflowSwitcher } from "./WorkflowSwitcher";
import type { WorkflowStatusCounts } from "./workflowStatusCounts";

export interface GraphWorkflowSelection {
  boardWorkflows: BoardWorkflowsPayload;
  selectedWorkflow: BoardWorkflowDefinition;
  isAllWorkflowsSelected: boolean;
}

interface GraphWorkflowSwitcherSlotProps {
  projectId?: string;
  /*
  FNXC:WorkflowEditorFloating 2026-09-15-05:29:
  FN-407: Graph shares the Board/List workflow dropdown contract, which is now selection-only. Workflow editing
  is reachable exclusively from the Workflows view, so this slot carries no edit or create callback.
  */
  onWorkflowSelectionChange?: (selection: GraphWorkflowSelection | null) => void;
}

const EMPTY_COUNTS: Map<string, WorkflowStatusCounts> = new Map();

export function filterTasksByGraphWorkflowSelection<T extends { id: string }>(
  tasks: T[],
  projectId: string | undefined,
  selection: GraphWorkflowSelection | null,
): T[] {
  if (!projectId || !selection || selection.isAllWorkflowsSelected) return tasks;
  const workflowIds = new Set(selection.boardWorkflows.workflows.map((workflow) => workflow.id));
  return tasks.filter((task) => {
    const rawAssignedWorkflowId = selection.boardWorkflows.taskWorkflowIds[task.id];
    /*
    FNXC:GraphWorkflowSelection 2026-06-26-03:48:
    Graph task scoping treats stale taskWorkflowIds entries that reference deleted workflows as default-workflow assignments. The board-workflows payload can outlive workflow deletion across cache/remount boundaries, so filtering must not hide those tasks from every workflow view.
    */
    const assignedWorkflowId = rawAssignedWorkflowId && workflowIds.has(rawAssignedWorkflowId)
      ? rawAssignedWorkflowId
      : selection.boardWorkflows.defaultWorkflowId;
    return assignedWorkflowId === selection.selectedWorkflow.id;
  });
}

export function GraphWorkflowSwitcherSlot({
  projectId,
  onWorkflowSelectionChange,
}: GraphWorkflowSwitcherSlotProps) {
  const {
    boardWorkflows,
    workflowMode,
    workflowOptions,
    selectedWorkflow,
    isAllWorkflowsSelected,
    setSelectedWorkflowId,
    refreshBoardWorkflows,
  } = useBoardWorkflows({ projectId });
  /*
  FNXC:GraphWorkflowSwitcher 2026-06-23-21:45:
  Graph shares the Board/List header workflow affordance, but mobile and inactive left-sidebar layouts can omit `#header-workflow-slot`. Poll only briefly and re-resolve on viewport changes so Graph never spins forever or leaves an empty dropdown shell when the header slot is absent.

  FNXC:WorkflowControls 2026-09-15-01:44:
  FN-405: that bounded retry now lives in the shared `useHeaderWorkflowSlot` resolver used by Board,
  List, Graph, and the Planning/Missions slot, so all four surfaces survive a late-mounted or replaced
  slot identically instead of drifting apart.
  */
  const headerWorkflowSlot = useHeaderWorkflowSlot({ enabled: true });

  const selection = useMemo<GraphWorkflowSelection | null>(() => {
    if (!workflowMode || !boardWorkflows || !selectedWorkflow) return null;
    return { boardWorkflows, selectedWorkflow, isAllWorkflowsSelected };
  }, [boardWorkflows, isAllWorkflowsSelected, selectedWorkflow, workflowMode]);

  useEffect(() => {
    onWorkflowSelectionChange?.(selection);
  }, [onWorkflowSelectionChange, selection]);

  useEffect(() => {
    return () => onWorkflowSelectionChange?.(null);
  }, [onWorkflowSelectionChange]);

  if (!workflowMode || !selectedWorkflow || workflowOptions.length < 2 || !headerWorkflowSlot) {
    return null;
  }

  return createPortal(
    <div className="board-workflow-toolbar">
      <div className="board-workflow-selector">
        <WorkflowSwitcher
          workflows={workflowOptions}
          value={isAllWorkflowsSelected ? ALL_WORKFLOWS_BOARD_VIEW_ID : selectedWorkflow.id}
          onChange={setSelectedWorkflowId}
          counts={EMPTY_COUNTS}
          aggregateOption={{ id: ALL_WORKFLOWS_BOARD_VIEW_ID, name: "All workflows" }}
          onOpen={refreshBoardWorkflows}
        />
      </div>
    </div>,
    headerWorkflowSlot,
  );
}
