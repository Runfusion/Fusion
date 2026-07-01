import { HeaderWorkflowSwitcherSlot, type HeaderWorkflowSelection } from "./HeaderWorkflowSwitcherSlot";

/*
FNXC:PlanningWorkflowSwitcher 2026-06-25-00:00:
Planning keeps this compatibility wrapper while the neutral HeaderWorkflowSwitcherSlot owns the shared header portal behavior. Missions uses the same slot so task-creating views share one workflow-selection affordance without duplicating polling or WorkflowSwitcher markup.
*/

interface PlanningWorkflowSwitcherSlotProps {
  projectId?: string;
  onOpenWorkflowEditor?: (workflowId?: string) => void;
  onCreateWorkflow?: () => void;
  onWorkflowSelectionChange?: (selection: HeaderWorkflowSelection | null) => void;
}

export function PlanningWorkflowSwitcherSlot(props: PlanningWorkflowSwitcherSlotProps) {
  return <HeaderWorkflowSwitcherSlot {...props} />;
}
