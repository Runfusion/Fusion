import type { CSSProperties, ComponentProps, HTMLAttributes } from "react";
import type { GraphPosition } from "./types";
import { useNodeDrag } from "./hooks/useNodeDrag";
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
>;

export interface GraphTaskNodeProps extends TaskCardBridgeProps, Pick<HTMLAttributes<HTMLDivElement>, "onMouseEnter" | "onMouseLeave" | "onClick"> {
  style?: CSSProperties;
  position: GraphPosition;
  scale: number;
  isHighlighted?: boolean;
  isDimmed?: boolean;
  onNodePositionChange: (taskId: string, position: GraphPosition) => void;
  onNodeDragStateChange?: (isDragging: boolean) => void;
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
  isHighlighted = false,
  isDimmed = false,
  onMouseEnter,
  onMouseLeave,
  onClick,
  onNodePositionChange,
  onNodeDragStateChange,
  ...taskCardProps
}: GraphTaskNodeProps) {
  const { task, globalPaused, taskStuckTimeoutMs, lastFetchTimeMs } = taskCardProps;
  const isFailed = task.status === "failed";
  const isPaused = task.paused === true;
  const isStuck = isTaskStuck(task, taskStuckTimeoutMs, lastFetchTimeMs);
  const isAwaitingApproval = task.column === "triage" && task.status === "awaiting-approval";
  const isActive =
    !globalPaused &&
    !isFailed &&
    !isPaused &&
    !isStuck &&
    !isAwaitingApproval &&
    (task.column === "in-progress" || ACTIVE_STATUSES.has(task.status as string));

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
    onPositionChange: onNodePositionChange,
    onDragStateChange: onNodeDragStateChange,
  });

  return (
    <div
      className={`graph-task-node graph-node--draggable${drag.isDragging ? " graph-node--dragging" : ""}${isHighlighted ? " graph-task-node--highlighted graph-node--highlighted" : ""}${isDimmed ? " graph-task-node--dimmed graph-node--dimmed" : ""}${isActive ? " graph-task-node--active" : ""}${isInReview ? " graph-task-node--in-review" : ""}`}
      style={style}
      draggable={false}
      data-testid={`graph-task-node-${task.id}`}
      data-current-step={isActive && hasValidCurrentStep ? String(task.currentStep) : undefined}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={onClick}
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
      <TaskCard {...taskCardProps} disableDrag={true} />
    </div>
  );
}
