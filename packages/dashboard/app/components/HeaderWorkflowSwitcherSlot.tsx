import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { BoardWorkflowDefinition, BoardWorkflowsPayload } from "../api";
import { useBoardWorkflows } from "../hooks/useBoardWorkflows";
import { ALL_WORKFLOWS_BOARD_VIEW_ID } from "../utils/boardWorkflowSelection";
import { useViewportMode } from "../hooks/useViewportMode";
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
  FNXC:WorkflowEditorFloating 2026-06-24-00:00:
  Header-slot workflow edit actions serve Planning and Missions, so this callback must forward the row workflow id exactly like Board/List. Dropping the argument opens the floating editor on the default workflow instead of the selected row.
  */
  onOpenWorkflowEditor?: (workflowId?: string) => void;
  onCreateWorkflow?: () => void;
  onWorkflowSelectionChange?: (selection: HeaderWorkflowSelection | null) => void;
}

// Counts require live task/column data that non-board header slots do not thread here.
// WorkflowSwitcher renders zero counts for an empty map, so pass a stable empty Map.
const EMPTY_COUNTS: Map<string, WorkflowStatusCounts> = new Map();

export function HeaderWorkflowSwitcherSlot({
  projectId,
  onOpenWorkflowEditor,
  onCreateWorkflow,
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
    FNXC:MissionWorkflows 2026-06-25-00:00:
    Missions shares Planning's header workflow dropdown because mission triage creates tasks. The header slot can be absent on mobile or during layout swaps, so poll only briefly and re-resolve on viewport changes to avoid an empty toolbar shell or an unbounded timer.
    */
    let attempts = 0;
    const interval = window.setInterval(() => {
      attempts += 1;
      if (resolve() || attempts >= 20) window.clearInterval(interval);
    }, 250);
    return () => window.clearInterval(interval);
  }, [viewportMode]);

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
          onEditWorkflow={onOpenWorkflowEditor}
          onCreateWorkflow={onCreateWorkflow}
        />
      </div>
    </div>,
    headerWorkflowSlot,
  );
}
