import "./Lane.css";
import { memo, useCallback, useEffect, useMemo, useRef, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { Task, TaskDetail, Column as ColumnType, ColumnId, TaskCreateInput, GithubIssueAction } from "@fusion/core";
import { Column } from "./Column";
import { sortTasksForDisplayColumn } from "./taskSorting";
import type { ModelInfo, BoardWorkflowDefinition, RevertTaskOptions, RevertTaskResult } from "../api";
import type { ToastType } from "../hooks/useToast";
import type { BlockerFanoutEntry } from "../hooks/useBlockerFanout";

/**
 * One workflow's board lane (U9, R16). A full-width row whose own
 * horizontally-scrollable strip renders the workflow's columns (reusing
 * Column.tsx in workflow mode). The header shows the workflow name, the card
 * count, and a collapse toggle (collapse state persisted by the parent Board).
 *
 * Archived / hidden-from-board columns are hidden. Hold columns render the
 * per-card promote affordance. Cross-lane drag is rejected by the drag
 * pre-check the Board threads through (drag never switches workflows).
 *
 * The iOS scroll-stabilization that the single-lane board ran globally is
 * contained PER LANE here (each lane is its own scroll container) so the
 * behavior is not compounded across stacked lanes.
 */

export interface LaneProps {
  workflow: BoardWorkflowDefinition;
  /** Tasks resolved to THIS workflow (already lane-filtered by Board). */
  tasks: Task[];
  collapsed: boolean;
  onToggleCollapse: (workflowId: string) => void;
  projectId?: string;
  maxConcurrent: number;
  showWorktreeGrouping?: boolean;
  onMoveTask: (id: string, column: ColumnId, optionsOrPosition?: { preserveProgress?: boolean } | number) => Promise<Task>;
  onPromote: (taskId: string) => Promise<void>;
  /** Drag pre-check: null = allowed, else an i18n messageKey (R17). */
  canDropTask: (taskId: string, targetColumnId: string, workflowId: string) => string | null;
  getDraggingTaskId: () => string | null;
  onPauseTask?: (id: string) => Promise<Task>;
  onOpenDetail: (task: Task | TaskDetail) => void;
  onOpenGroupModal?: (groupId: string) => void;
  addToast: (message: string, type?: ToastType) => void;
  onQuickCreate?: (input: TaskCreateInput) => Promise<Task | void>;
  onNewTask?: () => void;
  autoMerge?: boolean;
  onToggleAutoMerge?: () => void;
  globalPaused?: boolean;
  onUpdateTask?: (id: string, updates: { title?: string; description?: string; dependencies?: string[] }) => Promise<Task>;
  onRetryTask?: (id: string) => Promise<Task>;
  onArchiveTask?: (id: string, options?: { removeLineageReferences?: boolean }) => Promise<Task>;
  onUnarchiveTask?: (id: string) => Promise<Task>;
  /* FNXC:TaskRevert 2026-07-05-00:00 (FN-7525): threaded alongside onArchiveTask/onUnarchiveTask. */
  onRevertTask?: (id: string, body?: RevertTaskOptions) => Promise<RevertTaskResult>;
  onDeleteTask?: (id: string, options?: {
    removeDependencyReferences?: boolean;
    removeLineageReferences?: boolean;
    githubIssueAction?: GithubIssueAction;
  }) => Promise<Task>;
  availableModels?: ModelInfo[];
  onPlanningMode?: (initialPlan: string, workflowId?: string | null) => void;
  onSubtaskBreakdown?: (description: string, workflowId?: string | null) => void;
  onOpenDetailWithTab?: (task: Task | TaskDetail, initialTab: "changes" | "retries" | "workflow") => void;
  favoriteProviders?: string[];
  favoriteModels?: string[];
  onToggleFavorite?: (provider: string) => void;
  onToggleModelFavorite?: (modelId: string) => void;
  isSearchActive?: boolean;
  taskStuckTimeoutMs?: number;
  onOpenMission?: (missionId: string) => void;
  lastFetchTimeMs?: number;
  /** Per-task card-placed custom field definitions (U13/KTD-14). */
  taskCardFieldDefs?: ReadonlyMap<string, import("../api").WorkflowFieldDefinition[]>;
  blockerFanoutMap?: ReadonlyMap<string, BlockerFanoutEntry>;
  prAuthAvailable?: boolean;
}

function LaneComponent(props: LaneProps) {
  const { workflow, tasks, collapsed, onToggleCollapse } = props;
  const { t } = useTranslation("app");
  const laneRef = useRef<HTMLDivElement | null>(null);

  // Visible columns: archived / hidden-from-board columns are hidden per lane.
  const visibleColumns = useMemo(
    () => workflow.columns.filter((col) => !col.flags.archived && !col.flags.hiddenFromBoard),
    [workflow.columns],
  );
  const contextMenuColumns = useMemo(
    () => workflow.columns
      .filter((col) => !col.flags.hiddenFromBoard)
      .map((col) => ({ id: col.id, label: col.name, flags: col.flags })),
    [workflow.columns],
  );
  const createColumnId = useMemo(() => (
    visibleColumns.find((col) => col.flags.intake && !col.flags.archived)?.id
      ?? visibleColumns.find((col) => !col.flags.archived)?.id
  ), [visibleColumns]);

  // Group + sort tasks by column id (stable per render).
  const tasksByColumn = useMemo(() => {
    const grouped: Record<string, Task[]> = {};
    for (const col of workflow.columns) grouped[col.id] = [];
    for (const task of tasks) {
      (grouped[task.column] ??= []).push(task);
    }
    for (const col of workflow.columns) {
      grouped[col.id] = sortTasksForDisplayColumn(grouped[col.id] ?? [], task_legacyKey(col.id));
    }
    return grouped;
  }, [tasks, workflow.columns]);

  // iOS scroll stabilization, contained to this lane's scroll strip.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!window.matchMedia("(max-width: 768px)").matches) return;
    let rafId: number | null = null;
    const run = () => {
      const el = laneRef.current;
      if (!el) return;
      void el.offsetWidth;
      el.scrollLeft = 0;
    };
    const schedule = () => {
      if (typeof window.requestAnimationFrame === "function") {
        if (rafId !== null) window.cancelAnimationFrame(rafId);
        rafId = window.requestAnimationFrame(() => {
          rafId = null;
          run();
        });
      } else {
        run();
      }
    };
    schedule();
    const vv = window.visualViewport;
    const onResize = () => schedule();
    if (typeof vv?.addEventListener === "function") vv.addEventListener("resize", onResize);
    return () => {
      if (typeof vv?.removeEventListener === "function") vv.removeEventListener("resize", onResize);
      if (rafId !== null) window.cancelAnimationFrame(rafId);
    };
  }, []);

  const handleToggle = useCallback(() => onToggleCollapse(workflow.id), [onToggleCollapse, workflow.id]);
  const handleHeaderKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    handleToggle();
  }, [handleToggle]);

  const makeCanDrop = useCallback(
    (targetColumnId: string) => (taskId: string) => props.canDropTask(taskId, targetColumnId, workflow.id),
    [props, workflow.id],
  );

  return (
    <section className="lane" data-lane={workflow.id} aria-label={workflow.name}>
      <div
        className="lane-header"
        role="button"
        tabIndex={0}
        onClick={handleToggle}
        onKeyDown={handleHeaderKeyDown}
        aria-expanded={!collapsed}
        aria-label={collapsed
          ? t("lane.expand", "Expand {{name}} lane", { name: workflow.name })
          : t("lane.collapse", "Collapse {{name}} lane", { name: workflow.name })}
        data-testid={`lane-header-${workflow.id}`}
      >
        <h2 className="lane-name">{workflow.name}</h2>
        <span className="lane-count" data-testid={`lane-count-${workflow.id}`}>{tasks.length}</span>
      </div>
      {!collapsed && (
        <div className="lane-columns" ref={laneRef}>
          {visibleColumns.map((col) => {
            const isCreateColumn = col.id === createColumnId;
            return (
            <Column
              key={col.id}
              column={col.id as ColumnType}
              workflowMode
              workflowId={workflow.id}
              columnDisplayName={col.name}
              columnFlags={col.flags}
              workflowContextMenuColumns={contextMenuColumns}
              tasks={tasksByColumn[col.id] ?? []}
              allTasks={tasks}
              projectId={props.projectId}
              maxConcurrent={props.maxConcurrent}
              showWorktreeGrouping={props.showWorktreeGrouping === true}
              onMoveTask={props.onMoveTask}
              onPromote={props.onPromote}
              canDropTask={makeCanDrop(col.id)}
              getDraggingTaskId={props.getDraggingTaskId}
              onPauseTask={props.onPauseTask}
              onOpenDetail={props.onOpenDetail}
              onOpenGroupModal={props.onOpenGroupModal}
              addToast={props.addToast}
              globalPaused={props.globalPaused}
              onUpdateTask={props.onUpdateTask}
              onRetryTask={props.onRetryTask}
              onArchiveTask={props.onArchiveTask}
              onUnarchiveTask={props.onUnarchiveTask}
              onRevertTask={props.onRevertTask}
              onDeleteTask={props.onDeleteTask}
              availableModels={props.availableModels}
              onOpenDetailWithTab={props.onOpenDetailWithTab}
              favoriteProviders={props.favoriteProviders}
              favoriteModels={props.favoriteModels}
              onToggleFavorite={props.onToggleFavorite}
              onToggleModelFavorite={props.onToggleModelFavorite}
              isSearchActive={props.isSearchActive}
              taskStuckTimeoutMs={props.taskStuckTimeoutMs}
              onOpenMission={props.onOpenMission}
              lastFetchTimeMs={props.lastFetchTimeMs}
              taskCardFieldDefs={props.taskCardFieldDefs}
              blockerFanoutMap={props.blockerFanoutMap}
              prAuthAvailable={props.prAuthAvailable}
              autoMerge={props.autoMerge}
              {...(isCreateColumn ? { onQuickCreate: props.onQuickCreate, onNewTask: props.onNewTask, onPlanningMode: props.onPlanningMode, onSubtaskBreakdown: props.onSubtaskBreakdown } : {})}
              {...((col.flags.mergeBlocker || col.flags.humanReview) && props.onToggleAutoMerge ? { onToggleAutoMerge: props.onToggleAutoMerge } : {})}
            />
            );
          })}
        </div>
      )}
    </section>
  );
}

/** Custom column ids are not in the legacy ColumnType enum; sortTasksForDisplayColumn
 *  only special-cases the legacy literals, so any unknown id falls through to the
 *  generic priority sort. Cast through unknown for the typed call. */
function task_legacyKey(columnId: string): ColumnType {
  return columnId as ColumnType;
}

export const Lane = memo(LaneComponent);
Lane.displayName = "Lane";
