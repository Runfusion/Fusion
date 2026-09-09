import { memo } from "react";
import { useTranslation } from "react-i18next";
import type { Task, TaskDetail, MergeResult, GithubIssueAction, ColumnId } from "@fusion/core";
import type { WorktreeGroupData } from "../utils/worktreeGrouping";
import { isNearDuplicateCanonicalInactive } from "../../../core/src/duplicates/near-duplicate-canonical";
import { ClipboardList, GitBranch } from "lucide-react";
import { TaskCard } from "./TaskCard";
import type { ToastType } from "../hooks/useToast";
import type { RevertTaskOptions, RevertTaskResult } from "../api";
import type { BlockerFanoutEntry } from "../hooks/useBlockerFanout";
import type { TaskContextMenuColumnMetadata } from "./TaskContextMenu";

interface WorktreeGroupProps {
  kind: WorktreeGroupData["kind"];
  label: string;
  repoCount?: number;
  activeTasks: Task[];
  queuedTasks: Task[];
  allTasks?: Task[];
  projectId?: string;
  onOpenDetail: (task: Task | TaskDetail) => void;
  onPlanningMode?: (initialPlan: string, workflowId?: string | null) => void;
  workflowId?: string | null;
  onOpenRefine?: (task: Task | TaskDetail) => void;
  onMoveTask?: (id: string, column: ColumnId, optionsOrPosition?: { preserveProgress?: boolean; expectedColumn?: string } | number) => Promise<Task>;
  addToast: (message: string, type?: ToastType) => void;
  globalPaused?: boolean;
  onUpdateTask?: (
    id: string,
    updates: { title?: string; description?: string; dependencies?: string[] }
  ) => Promise<Task>;
  onPauseTask?: (id: string) => Promise<Task>;
  onRetryTask?: (id: string) => Promise<Task>;
  onOpenChatWithPrefill?: (prefillText: string) => void;
  onUnpauseTask?: (id: string) => Promise<Task>;
  onResetTask?: (id: string, options?: { description?: string }) => Promise<Task>;
  onDuplicateTask?: (id: string, options?: { workflowId?: string }) => Promise<Task>;
  onMergeTask?: (id: string) => Promise<MergeResult>;
  onRevertTask?: (id: string, body?: RevertTaskOptions) => Promise<RevertTaskResult>;
  onDeleteTask?: (id: string, options?: {
    removeDependencyReferences?: boolean;
    removeLineageReferences?: boolean;
    githubIssueAction?: GithubIssueAction;
  }) => Promise<Task>;
  onOpenDetailWithTab?: (task: Task | TaskDetail, initialTab: "changes" | "retries" | "workflow") => void;
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
  kind,
  label,
  repoCount,
  activeTasks,
  queuedTasks,
  allTasks,
  projectId,
  onOpenDetail,
  onPlanningMode,
  workflowId,
  onOpenRefine,
  onMoveTask,
  addToast,
  globalPaused,
  onUpdateTask,
  onPauseTask,
  onRetryTask,
  onOpenChatWithPrefill,
  onUnpauseTask,
  onResetTask,
    onDuplicateTask,
  onMergeTask,
  onRevertTask,
  onDeleteTask,
  onOpenDetailWithTab,
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
  /*
  FNXC:Workspace 2026-08-15-03:35:
  Group labels originate in a pure utility as English display values, while this component
  translates headers. Comparing those strings selected the wrong icon in non-English locales;
  the stable group kind is the locale-independent header contract.
  */
  const headerLabel = kind === "workspace"
    ? t("worktree.workspaceRepos", "{{label}} · {{count}} repos", { label, count: repoCount ?? 0 })
    : label;
  const resolveNearDuplicateCanonicalInactive = (task: Task): boolean | undefined => {
    const nearDuplicateOf = task.sourceMetadata?.nearDuplicateOf;
    if (typeof nearDuplicateOf !== "string" || !allTasks) return undefined;
    const canonical = allTasks.find((candidate) => candidate.id === nearDuplicateOf);
    /*
    FNXC:WorkflowResolvedColumns 2026-07-30-23:30 (repo-wide seam scan):
    Supply the CANONICAL's own flags — the second parameter core added and no caller here passed.
    Without it `isActiveNearDuplicateColumn` falls to the legacy ids, so on a renamed board a
    canonical resting in an active lane read as INACTIVE and the duplicate badge stopped warning
    about a live twin. `getTaskColumnFlags` is defined just below and already resolves per task.
    */
    return isNearDuplicateCanonicalInactive(canonical, canonical ? getTaskColumnFlags(canonical) : undefined);
  };
  const getTaskContextMenuColumns = (task: Task) => taskContextMenuColumnsByTaskId?.get(task.id) ?? workflowContextMenuColumns;
  const getTaskColumnFlags = (task: Task) => getTaskContextMenuColumns(task)?.find((candidate) => candidate.id === task.column)?.flags;
  const getTaskPlanningWorkflowId = (task: Task) => (task as Task & { workflowId?: string | null }).workflowId ?? taskWorkflowBadges?.get(task.id)?.workflowId ?? workflowId ?? null;

  return (
    <div className="worktree-group">
      <div className="worktree-group-header">
        <span className="worktree-icon">
          {kind === "unassigned" || kind === "up-next" ? <ClipboardList size={14} /> : <GitBranch size={14} />}
        </span>
        <span className="worktree-label">{headerLabel}</span>
      </div>
      {activeTasks.map((task) => (
        <TaskCard
          key={task.id}
          task={task}
          projectId={projectId}
          onOpenDetail={onOpenDetail}
          onPlanningMode={onPlanningMode}
          planningWorkflowId={getTaskPlanningWorkflowId(task)}
          onOpenRefine={onOpenRefine}
          onMoveTask={onMoveTask}
          taskColumnFlags={getTaskColumnFlags(task)}
          taskMoveColumns={getTaskContextMenuColumns(task)}
          addToast={addToast}
          globalPaused={globalPaused}
          onUpdateTask={onUpdateTask}
          onPauseTask={onPauseTask}
          onRetryTask={onRetryTask}
          onOpenChatWithPrefill={onOpenChatWithPrefill}
          onUnpauseTask={onUnpauseTask}
                  onResetTask={onResetTask}
          onDuplicateTask={onDuplicateTask}
          onMergeTask={onMergeTask}
          onRevertTask={onRevertTask}
          onDeleteTask={onDeleteTask}
          onOpenDetailWithTab={onOpenDetailWithTab}
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
          onPlanningMode={onPlanningMode}
          planningWorkflowId={getTaskPlanningWorkflowId(task)}
          onOpenRefine={onOpenRefine}
          onMoveTask={onMoveTask}
          taskColumnFlags={getTaskColumnFlags(task)}
          taskMoveColumns={getTaskContextMenuColumns(task)}
          addToast={addToast}
          globalPaused={globalPaused}
          onUpdateTask={onUpdateTask}
          onPauseTask={onPauseTask}
          onRetryTask={onRetryTask}
          onOpenChatWithPrefill={onOpenChatWithPrefill}
          onUnpauseTask={onUnpauseTask}
                  onResetTask={onResetTask}
          onDuplicateTask={onDuplicateTask}
          onMergeTask={onMergeTask}
          onRevertTask={onRevertTask}
          onDeleteTask={onDeleteTask}
          onOpenDetailWithTab={onOpenDetailWithTab}
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
