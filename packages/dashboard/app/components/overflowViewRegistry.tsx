import { Suspense, lazy, type ComponentType, type ReactNode } from "react";
import {
  CheckSquare,
  Folder,
  GitBranch,
  GitPullRequest,
  History,
  Lock,
  MessageSquare,
  Monitor,
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
import { ActivityLogModal } from "./ActivityLogModal";
import { GitManagerModal } from "./GitManagerModal";

/*
FNXC:Navigation 2026-06-22-00:40:
Dev Server and Secrets are right-dock tools (moved off the left sidebar). They render inline in the dock; Dev Server is gated by the devServerView experimental flag. Lazy-loaded to keep them out of the main bundle.
*/
const DevServerView = lazy(() => import("./DevServerView").then((m) => ({ default: m.DevServerView })));
const SecretsView = lazy(() => import("./SecretsView").then((m) => ({ default: m.SecretsView })));
const TodoView = lazy(() => import("./TodoView").then((m) => ({ default: m.TodoView })));
const PullRequestView = lazy(() => import("./PullRequestView").then((m) => ({ default: m.PullRequestView })));
const ChatView = lazy(() => import("./ChatView").then((m) => ({ default: m.ChatView })));

export type OverflowViewKey =
  | "usage"
  | "activity-log"
  | "git-manager"
  | "files"
  | "chat"
  | "devserver"
  | "secrets"
  | "todos"
  | "pull-requests"
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
  /*
  FNXC:RightDockFiles 2026-06-22-15:00:
  `surface` tells a registry render function which host it is mounting into so it can pick a deterministic layout instead of relying on a fragile CSS container query.
  The compact right-dock body leaves this undefined ("dock"); the RightDockExpandModal sets `surface="expand"` so DockFilesView forces its LEFT|RIGHT two-pane layout regardless of measured container width.
  */
  surface?: "dock" | "expand";
  /*
  FNXC:RightDockFiles 2026-06-23-00:50:
  Measured outer width (px) of the compact right dock body host, threaded from RightDock so a registry render function can deterministically pick a wide layout from the actual dock size. Only set on the "dock" surface; the expand pop-out leaves it undefined (it already forces its wide layout via surface="expand").
  */
  dockWidth?: number;
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

/*
FNXC:RightDockFiles 2026-06-23-00:50:
When the dock body is at least this wide there is clearly room for the Files tree|viewer two-pane split, so the dock forces DockFilesView layout="two-pane" deterministically instead of relying on the unreliable @container dock-files query (its root content-box often measured under the breakpoint and kept the view stacked). Matched to the CSS @container dock-files (min-width: 640px) breakpoint; compared against the threaded outer dock width (the dock chrome padding is small relative to 640px of content, so 640 outer width safely implies enough body width for two panes).
*/
const RIGHT_DOCK_FILES_TWO_PANE_MIN_WIDTH = 640;
/*
FNXC:RightDockChat 2026-06-27-23:12:
ChatView's desktop split pane is unusable in the default 360px right dock, so compact dock hosts force ChatView's narrow list/detail layout until the dock is wider than the tablet/mobile breakpoint. The expanded pop-out keeps the full desktop layout.
*/
const RIGHT_DOCK_CHAT_COMPACT_MAX_WIDTH = 768;

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
  /* FNXC:Navigation 2026-06-22-00:20: Files is the first/default right-dock tool. */
  {
    key: "files",
    label: "Files",
    icon: Folder,
    testId: "right-dock-tab-files",
    /*
    FNXC:RightDockFiles 2026-06-22-15:00:
    Map the host surface to a deterministic DockFilesView layout. The expand pop-out gets `layout="two-pane"` so the tree+viewer render LEFT|RIGHT without depending on the @container query matching inside the modal body. The compact dock keeps `layout="auto"` (the container-query single-panel stack).

    FNXC:RightDockFiles 2026-06-23-00:50:
    Extend the deterministic approach to the DOCK itself: when the dock body is dragged wide (threaded `dockWidth` >= 640px) force the same LEFT|RIGHT two-pane split deterministically, NOT via the unreliable @container dock-files query (which kept the wide dock stacked because the root content-box measured under the breakpoint). Below the threshold the narrow dock keeps the single-panel stacked nav. The expand pop-out is always two-pane.
    */
    render: (props) => wrapOverflowView(
      <DockFilesView
        projectId={props.projectId}
        openFile={props.openFile}
        layout={
          props.surface === "expand"
          || (props.surface === "dock" && (props.dockWidth ?? 0) >= RIGHT_DOCK_FILES_TWO_PANE_MIN_WIDTH)
            ? "two-pane"
            : "auto"
        }
      />,
    ),
  },
  /*
  FNXC:Navigation 2026-06-27-00:00:
  The right dock hosts the full ChatView as an always-visible inline tool so the compact dock body and the floating expand modal reuse the same conversational surface without adding another navigation destination.
  */
  {
    key: "chat",
    label: "Chat",
    icon: MessageSquare,
    testId: "right-dock-tab-chat",
    render: (props) => wrapOverflowView(
      <ChatView
        projectId={props.projectId}
        addToast={props.addToast}
        compactLayout={props.surface === "dock" && (props.dockWidth ?? RIGHT_DOCK_CHAT_COMPACT_MAX_WIDTH) <= RIGHT_DOCK_CHAT_COMPACT_MAX_WIDTH}
      />,
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
    key: "devserver",
    label: "Dev Server",
    icon: Monitor,
    testId: "right-dock-tab-devserver",
    isVisible: (options) => options.experimentalFeatures?.devServerView === true,
    render: (props) => wrapOverflowView(<DevServerView tasks={props.tasks} addToast={props.addToast} projectId={props.projectId} />),
  },
  {
    key: "secrets",
    label: "Secrets",
    icon: Lock,
    testId: "right-dock-tab-secrets",
    render: (props) => wrapOverflowView(<SecretsView addToast={props.addToast} />),
  },
  {
    key: "todos",
    label: "Todos",
    icon: CheckSquare,
    testId: "right-dock-tab-todos",
    isVisible: (options) => options.todosEnabled === true,
    render: (props) => wrapOverflowView(
      <TodoView
        projectId={props.projectId}
        addToast={props.addToast}
        onPlanningMode={props.onPlanningMode}
        onTaskCreated={props.onTaskCreated}
      />,
    ),
  },
  {
    key: "pull-requests",
    label: "Pull Requests",
    icon: GitPullRequest,
    testId: "right-dock-tab-pull-requests",
    render: (props) => wrapOverflowView(<PullRequestView projectId={props.projectId} />),
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
