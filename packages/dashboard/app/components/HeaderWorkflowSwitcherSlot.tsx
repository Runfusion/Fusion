import { useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import type { BoardWorkflowDefinition, BoardWorkflowsPayload } from "../api";
import { useBoardWorkflows } from "../hooks/useBoardWorkflows";
import { ALL_WORKFLOWS_BOARD_VIEW_ID } from "../utils/boardWorkflowSelection";
import { useHeaderWorkflowSlot } from "../hooks/useHeaderWorkflowSlot";
import { WorkflowSwitcher } from "./WorkflowSwitcher";
import type { WorkflowStatusCounts } from "./workflowStatusCounts";

export interface HeaderWorkflowSelection {
  boardWorkflows: BoardWorkflowsPayload;
  selectedWorkflow: BoardWorkflowDefinition;
  isAllWorkflowsSelected: boolean;
}

interface HeaderWorkflowSwitcherSlotProps {
  projectId?: string;
  /*
  FNXC:WorkflowEditorFloating 2026-09-15-05:29:
  FN-407: the header slot renders a selection-only switcher. Workflow editing is no longer reachable from this
  dropdown at all — it lives in the Workflows view — so the slot carries no edit or create callback.
  */
  onWorkflowSelectionChange?: (selection: HeaderWorkflowSelection | null) => void;
}

// Counts require live task/column data that non-board header slots do not thread here.
// WorkflowSwitcher renders zero counts for an empty map, so pass a stable empty Map.
const EMPTY_COUNTS: Map<string, WorkflowStatusCounts> = new Map();

export function HeaderWorkflowSwitcherSlot({
  projectId,
  onWorkflowSelectionChange,
}: HeaderWorkflowSwitcherSlotProps) {
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
  FNXC:MissionWorkflows 2026-06-25-00:00:
  Missions shares Planning's header workflow dropdown because mission triage creates tasks. The header slot can be absent on mobile or during layout swaps, so poll only briefly and re-resolve on viewport changes to avoid an empty toolbar shell or an unbounded timer.

  FNXC:WorkflowControls 2026-09-15-01:44:
  FN-405: that bounded retry now lives in the shared `useHeaderWorkflowSlot` resolver used by Board,
  List, Graph, and this slot, so a late-mounted or replaced header slot is handled identically on every
  surface instead of four divergent copies.
  */
  const headerWorkflowSlot = useHeaderWorkflowSlot({ enabled: true });

  const selection = useMemo<HeaderWorkflowSelection | null>(() => {
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
