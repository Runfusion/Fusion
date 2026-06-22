import { Suspense, type ComponentType, type ReactNode } from "react";
import {
  Activity,
  Folder,
  GitBranch,
  History,
  type LucideProps,
} from "lucide-react";
import type { Task, TaskDetail, WorkflowStep } from "@fusion/core";
import type { PluginDashboardViewEntry } from "../api";
import type { ToastType } from "../hooks/useToast";
import { buildPluginTaskViewId } from "../plugins/pluginViewRegistry";
import { PluginDashboardViewHost } from "../plugins/PluginDashboardViewHost";
import type { DetailTaskTab, PluginDashboardViewContext } from "../plugins/types";
import { DockFilesView } from "./DockFilesView";
import { PageErrorBoundary } from "./ErrorBoundary";
import { getPluginNavIcon } from "./pluginNavIcon";
import { UsageIndicator } from "./UsageIndicator";
import { ActivityLogModal } from "./ActivityLogModal";
import { GitManagerModal } from "./GitManagerModal";

export type OverflowViewKey =
  | "usage"
  | "activity-log"
  | "git-manager"
  | "files"
  | `plugin:${string}:${string}`;

export interface OverflowViewFeatureState {
  insights?: boolean;
  memoryView?: boolean;
  devServerView?: boolean;
  researchView?: boolean;
  evalsView?: boolean;
  goalsView?: boolean;
}

export interface OverflowViewRenderProps {
  projectId?: string;
  addToast: (message: string, type?: ToastType) => void;
  settingsLoaded?: boolean;
  readinessVersion?: number;
  anchorGoalId?: string;
  tasks?: Array<Task | TaskDetail>;
  workflowSteps?: WorkflowStep[];
  pluginContext?: PluginDashboardViewContext;
  onOpenSettings?: (section?: string) => void;
  onOpenTaskDetail?: (taskId: string) => void;
  onOpenDetail?: (task: Task | TaskDetail, initialTab?: DetailTaskTab) => void;
  onSendSelectionToTask?: (description: string) => void;
  onCreateTaskFromInsight?: (payload: { insightId: string; title: string; description: string }) => Promise<void> | void;
  onNavigateToMission?: (missionId: string) => void;
  onPlanningMode?: (initialPlan: string) => void;
  onTaskCreated?: (task: Task) => void;
  renderTaskCard?: (task: Task | TaskDetail) => ReactNode;
  subscribePluginEvents?: PluginDashboardViewContext["subscribePluginEvents"];
  openFile?: PluginDashboardViewContext["openFile"];
  onOpenUsage?: (anchorRect?: DOMRect | null) => void;
  onOpenActivityLog?: () => void;
  onOpenGitHubImport?: () => void;
  onOpenGitManager?: () => void;
  onOpenSchedules?: () => void;
}

export interface OverflowViewEntry {
  key: OverflowViewKey;
  label: string;
  icon: ComponentType<LucideProps>;
  testId: string;
  render?: (props: OverflowViewRenderProps) => ReactNode;
  onActivate?: (props: OverflowViewRenderProps) => void;
  isVisible?: (options: OverflowViewVisibilityOptions) => boolean;
}

export interface OverflowViewVisibilityOptions {
  experimentalFeatures?: OverflowViewFeatureState;
  showSkillsTab?: boolean;
  todosEnabled?: boolean;
  pluginDashboardViews?: PluginDashboardViewEntry[];
}

function wrapOverflowView(node: ReactNode): ReactNode {
  return (
    <PageErrorBoundary>
      <Suspense fallback={null}>{node}</Suspense>
    </PageErrorBoundary>
  );
}

/*
FNXC:Navigation 2026-06-21-00:00:
The right dock and its expand modal must resolve every hosted overflow destination through this registry so toolbar gating, component choice, and props cannot drift between the compact panel and full-size modal surfaces.

FNXC:Navigation 2026-06-21-20:10:
FN-6882 makes the right dock a tools rail for Activity, Activity Log, GitHub Import, Git Manager, Files, and Automation so content views live only in the left sidebar and do not duplicate across navigation surfaces.
*/
/*
FNXC:Navigation 2026-06-22-00:00:
Right-dock tools render INLINE inside the dock container, not as popup modals: usage, activity-log, and git-manager use each modal's `presentation="embedded"` mode instead of launching an overlay. (github-import and automation remain launcher actions here only until their left-sidebar/main destinations land, then they leave the dock.)
*/
export const STATIC_OVERFLOW_VIEW_ENTRIES: readonly OverflowViewEntry[] = [
  {
    key: "usage",
    label: "Activity",
    icon: Activity,
    testId: "right-dock-tab-usage",
    render: (props) => wrapOverflowView(
      <UsageIndicator isOpen={true} onClose={() => {}} projectId={props.projectId} presentation="embedded" />,
    ),
  },
  {
    key: "activity-log",
    label: "Activity Log",
    icon: History,
    testId: "right-dock-tab-activity-log",
    render: (props) => wrapOverflowView(
      <ActivityLogModal
        isOpen={true}
        onClose={() => {}}
        tasks={(props.tasks ?? []) as Task[]}
        onOpenTaskDetail={props.onOpenTaskDetail}
        projectId={props.projectId}
        presentation="embedded"
      />,
    ),
  },
  {
    key: "git-manager",
    label: "Git Manager",
    icon: GitBranch,
    testId: "right-dock-tab-git-manager",
    render: (props) => wrapOverflowView(
      <GitManagerModal
        isOpen={true}
        onClose={() => {}}
        tasks={(props.tasks ?? []) as Task[]}
        addToast={props.addToast}
        projectId={props.projectId}
        presentation="embedded"
      />,
    ),
  },
  {
    key: "files",
    label: "Files",
    icon: Folder,
    testId: "right-dock-tab-files",
    render: (props) => wrapOverflowView(<DockFilesView projectId={props.projectId} openFile={props.openFile} />),
  },
];

function buildPluginOverflowViewEntries(pluginDashboardViews: PluginDashboardViewEntry[] = []): OverflowViewEntry[] {
  return pluginDashboardViews
    .filter((entry) => entry.view.placement !== "primary")
    /*
    FNXC:Navigation 2026-06-22-00:00:
    The dependency graph must not appear in the right sidebar; it remains a left-sidebar destination only.
    */
    .filter((entry) => entry.pluginId !== "fusion-plugin-dependency-graph")
    .sort((a, b) => (a.view.order ?? Number.MAX_SAFE_INTEGER) - (b.view.order ?? Number.MAX_SAFE_INTEGER))
    .map((entry) => {
      const pluginTaskView = buildPluginTaskViewId(entry.pluginId, entry.view.viewId);
      const PluginIcon = getPluginNavIcon(entry.view.icon);
      return {
        key: pluginTaskView,
        label: entry.view.label,
        icon: PluginIcon,
        testId: `right-dock-tab-plugin-${entry.pluginId}-${entry.view.viewId}`,
        render: (props: OverflowViewRenderProps) => wrapOverflowView(
          <PluginDashboardViewHost
            taskView={pluginTaskView}
            context={props.pluginContext ?? {
              projectId: props.projectId,
              tasks: (props.tasks ?? []) as Task[],
              workflowSteps: props.workflowSteps ?? [],
              subscribePluginEvents: props.subscribePluginEvents,
              openTaskDetail: props.onOpenDetail ?? (() => undefined),
              openFile: props.openFile ?? (() => undefined),
              renderTaskCard: props.renderTaskCard,
              addToast: props.addToast,
            }}
          />,
        ),
      } satisfies OverflowViewEntry;
    });
}

export function getVisibleOverflowViewEntries(options: OverflowViewVisibilityOptions = {}): OverflowViewEntry[] {
  const staticEntries = STATIC_OVERFLOW_VIEW_ENTRIES.filter((entry) => entry.isVisible?.(options) ?? true);
  return [...staticEntries, ...buildPluginOverflowViewEntries(options.pluginDashboardViews)];
}

export function findOverflowViewEntry(key: OverflowViewKey, options: OverflowViewVisibilityOptions = {}): OverflowViewEntry | undefined {
  return getVisibleOverflowViewEntries(options).find((entry) => entry.key === key);
}

export function isOverflowViewKeyVisible(key: string, options: OverflowViewVisibilityOptions = {}): key is OverflowViewKey {
  return getVisibleOverflowViewEntries(options).some((entry) => entry.key === key);
}
