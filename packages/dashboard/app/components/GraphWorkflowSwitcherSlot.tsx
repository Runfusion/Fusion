import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { BoardWorkflowDefinition, BoardWorkflowsPayload } from "../api";
import { useBoardWorkflows } from "../hooks/useBoardWorkflows";
import { ALL_WORKFLOWS_BOARD_VIEW_ID } from "../utils/boardWorkflowSelection";
import { useViewportMode } from "../hooks/useViewportMode";
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
  FNXC:WorkflowEditorFloating 2026-06-24-00:00:
  Graph shares the Board/List workflow dropdown contract, so row edit must forward the workflow id into the floating editor. Keeping the parameter prevents Graph edits from falling back to the default workflow.
  */
  onOpenWorkflowEditor?: (workflowId?: string) => void;
  onCreateWorkflow?: () => void;
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
  onOpenWorkflowEditor,
  onCreateWorkflow,
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
  const viewportMode = useViewportMode();

  const [headerWorkflowSlot, setHeaderWorkflowSlot] = useState<HTMLElement | null>(() => {
    if (typeof document === "undefined") return null;
    return document.getElementById("header-workflow-slot");
  });

  useEffect(() => {
    if (typeof document === "undefined") return;
    const resolve = () => {
      const slot = document.getElementById("header-workflow-slot");
      setHeaderWorkflowSlot((previous) => (previous === slot ? previous : slot));
      return slot;
    };
    if (resolve()) return;
    /*
    FNXC:GraphWorkflowSwitcher 2026-06-23-21:45:
    Graph shares the Board/List header workflow affordance, but mobile and inactive left-sidebar layouts can omit `#header-workflow-slot`. Poll only briefly and re-resolve on viewport changes so Graph never spins forever or leaves an empty dropdown shell when the header slot is absent.
    */
    let attempts = 0;
    const interval = window.setInterval(() => {
      attempts += 1;
      if (resolve() || attempts >= 20) window.clearInterval(interval);
    }, 250);
    return () => window.clearInterval(interval);
  }, [viewportMode]);

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
          onEditWorkflow={onOpenWorkflowEditor}
          onCreateWorkflow={onCreateWorkflow}
        />
      </div>
    </div>,
    headerWorkflowSlot,
  );
}
