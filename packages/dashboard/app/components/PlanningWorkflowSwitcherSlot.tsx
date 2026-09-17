import { HeaderWorkflowSwitcherSlot, type HeaderWorkflowSelection } from "./HeaderWorkflowSwitcherSlot";

/*
FNXC:PlanningWorkflowSwitcher 2026-06-25-00:00:
Planning keeps this compatibility wrapper while the neutral HeaderWorkflowSwitcherSlot owns the shared header portal behavior. Missions uses the same slot so task-creating views share one workflow-selection affordance without duplicating polling or WorkflowSwitcher markup.
*/

interface PlanningWorkflowSwitcherSlotProps {
  projectId?: string;
  onWorkflowSelectionChange?: (selection: HeaderWorkflowSelection | null) => void;
  /* FNXC:WorkflowControls 2026-09-16-23:24: FN-483 — relais de la permission de rendu vers le slot partagé. */
  showWorkflowControls?: boolean;
}

export function PlanningWorkflowSwitcherSlot(props: PlanningWorkflowSwitcherSlotProps) {
  return <HeaderWorkflowSwitcherSlot {...props} />;
}
