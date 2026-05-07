import type { CSSProperties, ComponentProps, HTMLAttributes } from "react";
import { TaskCard } from "@fusion/dashboard/app/components/TaskCard";
import { isTaskStuck } from "@fusion/dashboard/app/utils/taskStuck";
import "./GraphTaskNode.css";
import "./GraphHighlight.css";

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
  isHighlighted?: boolean;
  isDimmed?: boolean;
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
  isHighlighted = false,
  isDimmed = false,
  onMouseEnter,
  onMouseLeave,
  onClick,
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

  return (
    <div
      className={`graph-task-node${isHighlighted ? " graph-task-node--highlighted graph-node--highlighted" : ""}${isDimmed ? " graph-task-node--dimmed graph-node--dimmed" : ""}${isActive ? " graph-task-node--active" : ""}${isInReview ? " graph-task-node--in-review" : ""}`}
      style={style}
      draggable={false}
      data-testid={`graph-task-node-${task.id}`}
      data-current-step={isActive && hasValidCurrentStep ? String(task.currentStep) : undefined}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={onClick}
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
