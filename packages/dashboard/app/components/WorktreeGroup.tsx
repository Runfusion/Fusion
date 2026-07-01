import { memo } from "react";
import { useTranslation } from "react-i18next";
import type { Task, TaskDetail, MergeResult, GithubIssueAction, ColumnId } from "@fusion/core";
import { isNearDuplicateCanonicalInactive } from "../../../core/src/near-duplicate-canonical";
import { ClipboardList, GitBranch } from "lucide-react";
import { TaskCard } from "./TaskCard";
import type { ToastType } from "../hooks/useToast";
import type { BlockerFanoutEntry } from "../hooks/useBlockerFanout";
import type { TaskContextMenuColumnMetadata } from "./TaskContextMenu";

interface WorktreeGroupProps {
  label: string;
  activeTasks: Task[];
  queuedTasks: Task[];
  allTasks?: Task[];
  projectId?: string;
  onOpenDetail: (task: Task | TaskDetail) => void;
  onMoveTask?: (id: string, column: ColumnId, optionsOrPosition?: { preserveProgress?: boolean } | number) => Promise<Task>;
  addToast: (message: string, type?: ToastType) => void;
  globalPaused?: boolean;
  onUpdateTask?: (
    id: string,
    updates: { title?: string; description?: string; dependencies?: string[] }
  ) => Promise<Task>;
  onPauseTask?: (id: string) => Promise<Task>;
  onRetryTask?: (id: string) => Promise<Task>;
  onUnpauseTask?: (id: string) => Promise<Task>;
  onResetTask?: (id: string) => Promise<Task>;
  onDuplicateTask?: (id: string) => Promise<Task>;
  onMergeTask?: (id: string) => Promise<MergeResult>;
  onArchiveTask?: (id: string, options?: { removeLineageReferences?: boolean }) => Promise<Task>;
  onUnarchiveTask?: (id: string) => Promise<Task>;
  onDeleteTask?: (id: string, options?: {
    removeDependencyReferences?: boolean;
    removeLineageReferences?: boolean;
    githubIssueAction?: GithubIssueAction;
  }) => Promise<Task>;
  onOpenDetailWithTab?: (task: Task | TaskDetail, initialTab: "changes" | "retries" | "workflow") => void;
  /** Project-level stuck task timeout in milliseconds (undefined = disabled) */
  taskStuckTimeoutMs?: number;
  /** Called when user clicks a mission badge on a task card */
  onOpenMission?: (missionId: string) => void;
  /** Timestamp (ms) when task data was last confirmed fresh from the server. Used for freshness-aware stuck detection. */
  lastFetchTimeMs?: number;
  /** Per-task card-placed custom field definitions (U13/KTD-14). */
  taskCardFieldDefs?: ReadonlyMap<string, import("../api").WorkflowFieldDefinition[]>;
  /** Trusted aggregate-board workflow badges keyed by task id; omitted in per-workflow and non-board surfaces. */
  taskWorkflowBadges?: ReadonlyMap<string, { workflowId: string; workflowName: string; workflowIcon?: string }>;
  /** Precomputed blocker fanout keyed by blocker task ID. */
  blockerFanoutMap?: ReadonlyMap<string, BlockerFanoutEntry>;
  /** Whether GitHub CLI auth is available for creating PRs from task cards. */
  prAuthAvailable?: boolean;
  /** Whether project-level auto-merge is enabled, which hides manual Create PR card actions. */
  autoMergeEnabled?: boolean;
  /** Project merge strategy for Task Detail-equivalent card context actions. */
  mergeStrategy?: string;
  /** Ordered workflow columns for deriving context-menu move targets in workflow mode. */
  workflowContextMenuColumns?: readonly TaskContextMenuColumnMetadata[];
  /** Per-task workflow columns for aggregate Board cards whose tasks come from different workflows. */
  taskContextMenuColumnsByTaskId?: ReadonlyMap<string, readonly TaskContextMenuColumnMetadata[]>;
}

function WorktreeGroupComponent({
  label,
  activeTasks,
  queuedTasks,
  allTasks,
  projectId,
  onOpenDetail,
  onMoveTask,
  addToast,
  globalPaused,
  onUpdateTask,
  onPauseTask,
  onRetryTask,
  onUnpauseTask,
  onResetTask,
  onDuplicateTask,
  onMergeTask,
  onArchiveTask,
  onUnarchiveTask,
  onDeleteTask,
  onOpenDetailWithTab,
  taskStuckTimeoutMs,
  onOpenMission,
  lastFetchTimeMs,
  taskCardFieldDefs,
  taskWorkflowBadges,
  blockerFanoutMap,
  prAuthAvailable,
  autoMergeEnabled,
  mergeStrategy = "direct",
  workflowContextMenuColumns,
  taskContextMenuColumnsByTaskId,
}: WorktreeGroupProps) {
  const { t } = useTranslation("app");
  const upNextLabel = t("worktree.upNext", "Up Next");
  const unassignedLabel = t("worktree.unassigned", "Unassigned");
  const resolveNearDuplicateCanonicalInactive = (task: Task): boolean | undefined => {
    const nearDuplicateOf = task.sourceMetadata?.nearDuplicateOf;
    if (typeof nearDuplicateOf !== "string" || !allTasks) return undefined;
    return isNearDuplicateCanonicalInactive(allTasks.find((candidate) => candidate.id === nearDuplicateOf));
  };
  const getTaskContextMenuColumns = (task: Task) => taskContextMenuColumnsByTaskId?.get(task.id) ?? workflowContextMenuColumns;
  const getTaskColumnFlags = (task: Task) => getTaskContextMenuColumns(task)?.find((candidate) => candidate.id === task.column)?.flags;

  return (
    <div className="worktree-group">
      <div className="worktree-group-header">
        <span className="worktree-icon">
          {label === upNextLabel || label === unassignedLabel ? <ClipboardList size={14} /> : <GitBranch size={14} />}
        </span>
        <span className="worktree-label">{label}</span>
      </div>
      {activeTasks.map((task) => (
        <TaskCard
          key={task.id}
          task={task}
          projectId={projectId}
          onOpenDetail={onOpenDetail}
          onMoveTask={onMoveTask}
          taskColumnFlags={getTaskColumnFlags(task)}
          taskMoveColumns={getTaskContextMenuColumns(task)}
          addToast={addToast}
          globalPaused={globalPaused}
          onUpdateTask={onUpdateTask}
          onPauseTask={onPauseTask}
          onRetryTask={onRetryTask}
          onUnpauseTask={onUnpauseTask}
          onResetTask={onResetTask}
          onDuplicateTask={onDuplicateTask}
          onMergeTask={onMergeTask}
          onArchiveTask={onArchiveTask}
          onUnarchiveTask={onUnarchiveTask}
          onDeleteTask={onDeleteTask}
          onOpenDetailWithTab={onOpenDetailWithTab}
          taskStuckTimeoutMs={taskStuckTimeoutMs}
          onOpenMission={onOpenMission}
          lastFetchTimeMs={lastFetchTimeMs}
          cardFieldDefs={taskCardFieldDefs?.get(task.id)}
          workflowBadge={taskWorkflowBadges?.get(task.id)}
          fanout={blockerFanoutMap?.get(task.id)}
          prAuthAvailable={prAuthAvailable}
          autoMergeEnabled={autoMergeEnabled}
          mergeStrategy={mergeStrategy}
          nearDuplicateCanonicalInactive={resolveNearDuplicateCanonicalInactive(task)}
        />
      ))}
      {queuedTasks.map((task) => (
        <TaskCard
          key={task.id}
          task={task}
          projectId={projectId}
          queued
          onOpenDetail={onOpenDetail}
          onMoveTask={onMoveTask}
          taskColumnFlags={getTaskColumnFlags(task)}
          taskMoveColumns={getTaskContextMenuColumns(task)}
          addToast={addToast}
          globalPaused={globalPaused}
          onUpdateTask={onUpdateTask}
          onPauseTask={onPauseTask}
          onRetryTask={onRetryTask}
          onUnpauseTask={onUnpauseTask}
          onResetTask={onResetTask}
          onDuplicateTask={onDuplicateTask}
          onMergeTask={onMergeTask}
          onArchiveTask={onArchiveTask}
          onUnarchiveTask={onUnarchiveTask}
          onDeleteTask={onDeleteTask}
          onOpenDetailWithTab={onOpenDetailWithTab}
          taskStuckTimeoutMs={taskStuckTimeoutMs}
          onOpenMission={onOpenMission}
          lastFetchTimeMs={lastFetchTimeMs}
          cardFieldDefs={taskCardFieldDefs?.get(task.id)}
          workflowBadge={taskWorkflowBadges?.get(task.id)}
          fanout={blockerFanoutMap?.get(task.id)}
          prAuthAvailable={prAuthAvailable}
          autoMergeEnabled={autoMergeEnabled}
          mergeStrategy={mergeStrategy}
          nearDuplicateCanonicalInactive={resolveNearDuplicateCanonicalInactive(task)}
        />
      ))}
    </div>
  );
}

export const WorktreeGroup = memo(WorktreeGroupComponent);
WorktreeGroup.displayName = "WorktreeGroup";
