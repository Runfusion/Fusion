import { memo } from "react";
import { useTranslation } from "react-i18next";
import type { Task, TaskDetail } from "@fusion/core";
import { isNearDuplicateCanonicalInactive } from "../../../core/src/near-duplicate-canonical";
import { ClipboardList, GitBranch } from "lucide-react";
import { TaskCard } from "./TaskCard";
import type { ToastType } from "../hooks/useToast";
import type { BlockerFanoutEntry } from "../hooks/useBlockerFanout";

interface WorktreeGroupProps {
  label: string;
  activeTasks: Task[];
  queuedTasks: Task[];
  allTasks?: Task[];
  projectId?: string;
  onOpenDetail: (task: Task | TaskDetail) => void;
  addToast: (message: string, type?: ToastType) => void;
  globalPaused?: boolean;
  onUpdateTask?: (
    id: string,
    updates: { title?: string; description?: string; dependencies?: string[] }
  ) => Promise<Task>;
  onRetryTask?: (id: string) => Promise<Task>;
  onOpenDetailWithTab?: (task: Task | TaskDetail, initialTab: "changes" | "retries" | "workflow") => void;
  /** Project-level stuck task timeout in milliseconds (undefined = disabled) */
  taskStuckTimeoutMs?: number;
  /** Called when user clicks a mission badge on a task card */
  onOpenMission?: (missionId: string) => void;
  /** Timestamp (ms) when task data was last confirmed fresh from the server. Used for freshness-aware stuck detection. */
  lastFetchTimeMs?: number;
  /** Lookup of workflow step IDs to display names, fetched once at board level. */
  workflowStepNameLookup?: ReadonlyMap<string, string>;
  /** Per-task card-placed custom field definitions (U13/KTD-14). */
  taskCardFieldDefs?: ReadonlyMap<string, import("../api").WorkflowFieldDefinition[]>;
  /** Precomputed blocker fanout keyed by blocker task ID. */
  blockerFanoutMap?: ReadonlyMap<string, BlockerFanoutEntry>;
  /** Whether GitHub CLI auth is available for creating PRs from task cards. */
  prAuthAvailable?: boolean;
  /** Whether project-level auto-merge is enabled, which hides manual Create PR card actions. */
  autoMergeEnabled?: boolean;
}

function WorktreeGroupComponent({
  label,
  activeTasks,
  queuedTasks,
  allTasks,
  projectId,
  onOpenDetail,
  addToast,
  globalPaused,
  onUpdateTask,
  onRetryTask,
  onOpenDetailWithTab,
  taskStuckTimeoutMs,
  onOpenMission,
  lastFetchTimeMs,
  workflowStepNameLookup,
  taskCardFieldDefs,
  blockerFanoutMap,
  prAuthAvailable,
  autoMergeEnabled,
}: WorktreeGroupProps) {
  const { t } = useTranslation("app");
  const upNextLabel = t("worktree.upNext", "Up Next");
  const unassignedLabel = t("worktree.unassigned", "Unassigned");
  const resolveNearDuplicateCanonicalInactive = (task: Task): boolean | undefined => {
    const nearDuplicateOf = task.sourceMetadata?.nearDuplicateOf;
    if (typeof nearDuplicateOf !== "string" || !allTasks) return undefined;
    return isNearDuplicateCanonicalInactive(allTasks.find((candidate) => candidate.id === nearDuplicateOf));
  };

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
          addToast={addToast}
          globalPaused={globalPaused}
          onUpdateTask={onUpdateTask}
          onRetryTask={onRetryTask}
          onOpenDetailWithTab={onOpenDetailWithTab}
          taskStuckTimeoutMs={taskStuckTimeoutMs}
          onOpenMission={onOpenMission}
          lastFetchTimeMs={lastFetchTimeMs}
          workflowStepNameLookup={workflowStepNameLookup}
          cardFieldDefs={taskCardFieldDefs?.get(task.id)}
          fanout={blockerFanoutMap?.get(task.id)}
          prAuthAvailable={prAuthAvailable}
          autoMergeEnabled={autoMergeEnabled}
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
          addToast={addToast}
          globalPaused={globalPaused}
          onUpdateTask={onUpdateTask}
          onRetryTask={onRetryTask}
          onOpenDetailWithTab={onOpenDetailWithTab}
          taskStuckTimeoutMs={taskStuckTimeoutMs}
          onOpenMission={onOpenMission}
          lastFetchTimeMs={lastFetchTimeMs}
          workflowStepNameLookup={workflowStepNameLookup}
          cardFieldDefs={taskCardFieldDefs?.get(task.id)}
          fanout={blockerFanoutMap?.get(task.id)}
          prAuthAvailable={prAuthAvailable}
          autoMergeEnabled={autoMergeEnabled}
          nearDuplicateCanonicalInactive={resolveNearDuplicateCanonicalInactive(task)}
        />
      ))}
    </div>
  );
}

export const WorktreeGroup = memo(WorktreeGroupComponent);
WorktreeGroup.displayName = "WorktreeGroup";
