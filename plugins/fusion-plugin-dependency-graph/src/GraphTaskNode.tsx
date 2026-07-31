import type { CSSProperties, ComponentProps, HTMLAttributes } from "react";
import type { GraphPosition } from "./types.js";
import { useNodeDrag } from "./hooks/useNodeDrag.js";
import { TaskCard } from "@fusion/dashboard/app/components/TaskCard";
import { isTaskStuck } from "@fusion/dashboard/app/utils/taskStuck";
import "./GraphTaskNode.css";
import "./GraphHighlight.css";
import "./styles/drag.css";

type TaskCardComponentProps = ComponentProps<typeof TaskCard>;

type TaskCardBridgeProps = Pick<
  TaskCardComponentProps,
  | "task"
  | "projectId"
  | "onOpenDetail"
  | "addToast"
  | "globalPaused"
  | "onUpdateTask"
  | "onArchiveTask"
  | "onUnarchiveTask"
  | "onDeleteTask"
  | "onRetryTask"
  | "onOpenDetailWithTab"
  | "taskStuckTimeoutMs"
  | "onOpenMission"
  | "onMoveTask"
  | "lastFetchTimeMs"
  | "workflowStepNameLookup"
  /* FNXC:WorkflowResolvedColumns 2026-07-31-06:25: the card's resolved lane traits — a Pick that
     omits them is why the stuck indicator could only ask the legacy question. */
  | "taskColumnFlags"
>;

export interface GraphTaskNodeProps extends TaskCardBridgeProps, Pick<HTMLAttributes<HTMLDivElement>, "onMouseEnter" | "onMouseLeave" | "onClick"> {
  style?: CSSProperties;
  position: GraphPosition;
  scale: number;
  isSelected?: boolean;
  isHighlighted?: boolean;
  isDimmed?: boolean;
  onNodePositionChange: (taskId: string, position: GraphPosition) => void;
  onNodeDragStateChange?: (isDragging: boolean) => void;
  onNodeDragEnd?: () => void;
}

const ACTIVE_STATUSES = new Set(["planning", "researching", "executing", "finalizing", "merging", "merging-fix"]);

function getStatusLabel(status?: string): string {
  if (!status) {
    return "Executing";
  }

  return status.charAt(0).toUpperCase() + status.slice(1);
}

export function GraphTaskNode({
  style,
  position,
  scale,
  isSelected = false,
  isHighlighted = false,
  isDimmed = false,
  onMouseEnter,
  onMouseLeave,
  onClick,
  onNodePositionChange,
  onNodeDragStateChange,
  onNodeDragEnd,
  ...taskCardProps
}: GraphTaskNodeProps) {
  const { task, globalPaused, taskStuckTimeoutMs, lastFetchTimeMs, onOpenDetail, taskColumnFlags } = taskCardProps;
  const isFailed = task.status === "failed";
  const isPaused = task.paused === true;
  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-06:20:
  The card's OWN resolved traits, now that the host supplies them through the plugin view context.

  Six of the seven other `isTaskStuck` call sites in the tree already passed this; the graph's stuck
  indicator answered for the legacy vocabulary on every board. It was exempted in the inert-seam gate
  on the grounds that supplying it needed a published-API change, then that it needed build plumbing.
  Both were wrong: the blocker was a hand-maintained interop declaration that had drifted to the
  pre-conversion three-argument signature.

  Absent flags still degrade to the legacy id, the documented no-metadata path.
  */
  const isStuck = isTaskStuck(task, taskStuckTimeoutMs, lastFetchTimeMs, taskColumnFlags);
  /*
  FNXC:PluginLifecycleColumns 2026-07-30-03:40 (U11 #2515 audit):
  Keyed on `column === "triage"`, this went permanently FALSE for default-lineage
  cards once U11 merged Todo into Planning and dropped the `triage` id — an
  awaiting-approval card sits in `todo` now. The node then stopped showing the
  awaiting-approval state AND fell through to `isActive`, rendering a card that is
  blocked on a human as if it were running.

  The column condition is DELETED rather than converted, because it was always
  redundant: `awaiting-approval` is written only by the plan-approval gate and the
  replan-cap park, both of which act on a card in the planning lane, so the status
  alone is the signal. Deleting it is also the only option that needs no resolution —
  this is a synchronous React render, where an IR lookup is not available.
  */
  /*
  FNXC:PluginLifecycleColumns 2026-07-31-11:50 (PR #2644 review, greptile P1):
  A STALE APPROVAL STATUS MUST NOT HIDE A RUNNING CARD. Dropping the column condition made the
  awaiting-approval signal status-only, which is right for a planning-lane card — but `awaiting-approval`
  is DURABLE, so a card that carries it into an execution lane was rendered as not-active: no active
  styling, no execution-status indicator, no current-step metadata, while it was plainly running.

  So the suppression now yields to an execution SIGNAL rather than to a column name. If the card shows
  execution activity, it is active and the stale approval status is residue; if it does not, the approval
  state is the truth. That ordering needs no IR lookup, which matters here — this is a synchronous React
  render.

  The `in-progress` literal is pre-existing and NOT on the triage bar; converting it needs the board's
  column traits, which this component is not given. Left with this note rather than half-converted.
  */
  const hasExecutionSignal = task.column === "in-progress" || ACTIVE_STATUSES.has(task.status as string);
  const isAwaitingApproval = task.status === "awaiting-approval" && !hasExecutionSignal;
  const isActive =
    !globalPaused &&
    !isFailed &&
    !isPaused &&
    !isStuck &&
    !isAwaitingApproval &&
    hasExecutionSignal;

  const hasValidCurrentStep =
    typeof task.currentStep === "number" &&
    task.currentStep >= 0 &&
    Array.isArray(task.steps) &&
    task.currentStep < task.steps.length;
  const isInReview = task.column === "in-review";

  const drag = useNodeDrag({
    taskId: task.id,
    position,
    scale,
    canDrag: isSelected,
    onPositionChange: onNodePositionChange,
    onDragStateChange: onNodeDragStateChange,
    onDragEnd: onNodeDragEnd,
    onDoubleTap: () => onOpenDetail(task),
  });

  return (
    <div
      className={`graph-task-node${isSelected ? " graph-node--draggable graph-task-node--selected" : ""}${drag.isDragging ? " graph-node--dragging" : ""}${isHighlighted ? " graph-task-node--highlighted graph-node--highlighted" : ""}${isDimmed ? " graph-task-node--dimmed graph-node--dimmed" : ""}${isActive ? " graph-task-node--active" : ""}${isInReview ? " graph-task-node--in-review" : ""}`}
      style={style}
      draggable={false}
      data-testid={`graph-task-node-${task.id}`}
      data-current-step={isActive && hasValidCurrentStep ? String(task.currentStep) : undefined}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={onClick}
      onDoubleClick={(event) => {
        if (event.defaultPrevented) {
          return;
        }
        onOpenDetail(task);
      }}
      onClickCapture={drag.onClickCapture}
      onPointerDown={drag.onPointerDown}
      onPointerMove={drag.onPointerMove}
      onPointerUp={drag.onPointerUp}
      onPointerCancel={drag.onPointerCancel}
    >
      {isActive ? (
        <div className="graph-task-active-indicator">
          <span className="graph-task-active-indicator-text">{getStatusLabel(task.status)}</span>
        </div>
      ) : null}
      <TaskCard {...taskCardProps} onOpenDetail={() => {}} disableDrag={true} />
    </div>
  );
}
