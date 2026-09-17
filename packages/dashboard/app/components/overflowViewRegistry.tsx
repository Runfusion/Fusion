import { Suspense, lazy, type ComponentType, type ReactNode } from "react";
import {
  Folder,
  List as ListIcon,
  MessageSquare,
  StickyNote,
  type LucideProps,
} from "lucide-react";
import type { GithubIssueAction, Task, TaskDetail, WorkflowStep } from "@fusion/core";
import type { PluginDashboardViewEntry } from "../api";
import type { ToastType } from "../hooks/useToast";
import type { ChatSessionInfo } from "../hooks/useChat";
import type { ChatReportHandoff } from "./chatReportHandoff";
import type { DetailTaskTab, PluginDashboardViewContext } from "../plugins/types";
import { DockFilesView } from "./DockFilesView";
import { PageErrorBoundary } from "./ErrorBoundary";

/*
FNXC:ToolSurfaces 2026-09-15-16:04:
FN-426 empties this registry of every tool that now owns a canonical host elsewhere. Git Manager and Files are main
content pages, Activity and Notes open as header popovers, Secrets is a Settings section, Pull Requests is a Git
section, Dev Server and plugin destinations belong to the primary navigation. What remains is a deliberately small set
of SHORTCUTS: the optional dock duplicates no owner, it only offers a second route to four surfaces that each still
have their own.
*/
const ChatView = lazy(() => import("./ChatView").then((m) => ({ default: m.ChatView })));
const NotesView = lazy(() => import("./NotesView").then((m) => ({ default: m.NotesView })));

export type OverflowViewHostMode = "standard" | "desktop";

/*
FNXC:ToolSurfaces 2026-09-15-16:04:
FN-426 narrows the dock's tool set to exactly the four shortcuts the optional panel may offer. A persisted selection
naming a retired tool (`git-manager`, `activity-log`, `secrets`, `pull-requests`, `devserver`, `plugin:*`) is simply
not a visible key any more, so `readStoredRightDockView` already resolves it through its existing Files fallback.
*/
export const OPTIONAL_RIGHT_DOCK_TOOL_KEYS = ["files", "chat", "list", "notes"] as const;

export type OverflowViewKey = (typeof OPTIONAL_RIGHT_DOCK_TOOL_KEYS)[number];

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
  /** Explicit host contract; shared consumers default to standard behavior. */
  hostMode?: OverflowViewHostMode;
  experimentalFeatures?: OverflowViewFeatureState;
  /** Per-task resolved column traits, threaded from App via useRightDockController. */
  columnFlagsByTaskId?: ReadonlyMap<string, { complete?: boolean; countsTowardWip?: boolean; mergeBlocker?: boolean; humanReview?: boolean; intake?: boolean; hold?: boolean }>;
  surface?: "dock" | "expand";
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
  onOpenSessionInNewWindow?: (session: ChatSessionInfo) => void;
  openChatWindows?: ReadonlySet<string>;
  onSendAsReport?: (handoff: ChatReportHandoff) => void;
  onUpdateTask?: (id: string, updates: { title?: string; description?: string; dependencies?: string[]; dismissNearDuplicate?: boolean; githubTracking?: { enabled?: boolean } }) => Promise<Task>;
  onDeleteTask?: (id: string, options?: { removeDependencyReferences?: boolean; removeLineageReferences?: boolean; githubIssueAction?: GithubIssueAction; allowResurrection?: boolean }) => Promise<Task>;
  onOpenChatWithPrefill?: (prefillText: string) => void;
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
  notesController?: import("../hooks/useNotes").UseNotesController;
  onOpenNote?: (note: import("@fusion/core").ProjectNoteSummary) => void;
  registerNotesGuard?: (guard: () => boolean | Promise<boolean>, onAccepted?: () => void) => () => void;
  /*
  FNXC:ListInRightDock 2026-09-14-03:31:
  FN-382: the dock renders the REAL List surface, supplied by its owner rather than rebuilt here. Threading a render
  callback instead of ~35 task props keeps one wiring of tasks, handlers and Quick Entry, so the dock cannot drift
  from the dedicated route. The tab is absent whenever the owner provides no renderer (phone hosts, tests).
  */
  renderListView?: () => ReactNode;
}

export interface OverflowViewEntry {
  key: OverflowViewKey;
  label: string;
  icon: ComponentType<LucideProps>;
  testId: string;
  render?: (props: OverflowViewRenderProps) => ReactNode;
  onActivate?: (props: OverflowViewRenderProps) => void;
  isVisible?: (options: OverflowViewVisibilityOptions) => boolean;
  /** Whether this entry may own the inline dock body; launcher-only entries still keep `render` for their expand window. */
  isInline?: (options: OverflowViewVisibilityOptions) => boolean;
  isExpandable?: (options: OverflowViewVisibilityOptions) => boolean;
}

export interface OverflowViewVisibilityOptions {
  experimentalFeatures?: OverflowViewFeatureState;
  hostMode?: OverflowViewHostMode;
  showSkillsTab?: boolean;
  pluginDashboardViews?: PluginDashboardViewEntry[];
  /** FN-382: true only where the host actually supplies the List surface, i.e. the non-mobile dock. */
  listViewAvailable?: boolean;
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
/*
FNXC:RightDockTasks 2026-09-12-01:35:
Tasks is not a dock destination: Board and List already own task browsing. Programmatic task detail remains a temporary layer over the selected tool, so legacy stored "tasks" falls back through the ordinary Files default without leaving a tab, title, or expanded modal.
*/
export const STATIC_OVERFLOW_VIEW_ENTRIES: readonly OverflowViewEntry[] = [
  /* FNXC:Navigation 2026-06-22-00:20: Files remains the default right-dock tool when no valid stored view exists. */
  {
    key: "files",
    label: "Files",
    icon: Folder,
    testId: "right-dock-tab-files",
    render: (props) => wrapOverflowView(<DockFilesView projectId={props.projectId} openFile={props.openFile} />),
  },
  /*
  FNXC:ChatSurfaceUnification 2026-09-14-17:46:
  FN-392: Chat is the dock's compact conversation LIST on every wide host, restoring the
  behavior FN-390 replaced with an expanded window. It is deliberately inline and NOT expandable, exactly like Notes:
  an expand modal would create a second Chat owner beside the dock list. Clicking or creating a conversation delegates
  to the project-scoped window owner (`onOpenSessionInNewWindow`), so transcripts live in their dedicated windows and
  the list stays in the panel. An external composer prefill is carried by the opened window, never injected into the
  list itself.
  */
  {
    key: "chat",
    label: "Chat",
    icon: MessageSquare,
    testId: "right-dock-tab-chat",
    isExpandable: () => false,
    render: (props) => wrapOverflowView(
      <ChatView
        projectId={props.projectId}
        addToast={props.addToast}
        experimentalFeatures={{ ...(props.experimentalFeatures ?? {}) }}
        onOpenSessionInNewWindow={props.onOpenSessionInNewWindow}
        openChatWindows={props.openChatWindows}
        onSendAsReport={props.onSendAsReport}
        compactLayout
        listOnly
      />,
    ),
  },
  /*
  FNXC:ListInRightDock 2026-09-14-03:31:
  FN-382: List is a dock tool on every non-mobile host, so tasks can be read and created over whatever page is open
  instead of navigating to a dedicated route. It renders its owner's real List surface and is deliberately NOT
  expandable: the expand modal would create a second List owner beside the dock one.
  */
  {
    key: "list",
    label: "List",
    icon: ListIcon,
    testId: "right-dock-tab-list",
    isVisible: (options) => Boolean(options.listViewAvailable),
    isExpandable: () => false,
    render: (props) => (props.renderListView ? wrapOverflowView(props.renderListView()) : null),
  },
  /*
  FNXC:DesktopRightDock 2026-09-11-21:48:
  Notes is an inline, non-expandable tool only in the explicit wide desktop dock. Standard docks exclude it entirely, preventing stale stored selections from creating a hidden or modal Notes owner.
  */
  {
    key: "notes",
    label: "Notes",
    icon: StickyNote,
    testId: "right-dock-tab-notes",
    /*
    FNXC:ToolSurfaces 2026-09-15-16:04:
    FN-426: the opted-in dock offers the same four shortcuts on tablet and desktop. The previous desktop-only gate
    existed to stop a stale selection creating a hidden Notes owner in a dock the operator never chose; the dock is
    now chosen explicitly, and the header popover remains the canonical Notes list either way.
    */
    isExpandable: () => false,
    render: (props) => wrapOverflowView(
      <NotesView projectId={props.projectId} addToast={props.addToast} controller={props.notesController} onOpenNote={props.onOpenNote} compact listOnly />,
    ),
  },
];

/*
FNXC:ToolSurfaces 2026-09-15-16:04:
FN-426: plugin dashboard views are no longer dock tools. They keep their primary-navigation destinations, so hosting
them here as well would give a plugin two owners in a panel that is now purely optional.
*/
export function getVisibleOverflowViewEntries(options: OverflowViewVisibilityOptions = {}): OverflowViewEntry[] {
  return STATIC_OVERFLOW_VIEW_ENTRIES.filter((entry) => entry.isVisible?.(options) ?? true);
}

export function findOverflowViewEntry(key: OverflowViewKey, options: OverflowViewVisibilityOptions = {}): OverflowViewEntry | undefined {
  return getVisibleOverflowViewEntries(options).find((entry) => entry.key === key);
}

export function isOverflowViewKeyVisible(key: string, options: OverflowViewVisibilityOptions = {}): key is OverflowViewKey {
  return getVisibleOverflowViewEntries(options).some((entry) => entry.key === key);
}

export function isOverflowViewEntryInline(entry: OverflowViewEntry | undefined, options: OverflowViewVisibilityOptions = {}): boolean {
  return Boolean(entry?.render && (entry.isInline?.(options) ?? true));
}

export function isOverflowViewEntryExpandable(entry: OverflowViewEntry | undefined, options: OverflowViewVisibilityOptions = {}): boolean {
  return Boolean(entry?.render && (entry.isExpandable?.(options) ?? true));
}
