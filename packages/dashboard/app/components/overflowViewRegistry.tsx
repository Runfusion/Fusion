import { lazy, Suspense, type ComponentType, type ReactNode } from "react";
import {
  Brain,
  CheckSquare,
  FileText,
  Folder,
  Lock,
  Monitor,
  Search,
  Sparkles,
  Target,
  Zap,
  type LucideProps,
} from "lucide-react";
import type { Task, TaskDetail, WorkflowStep } from "@fusion/core";
import type { PluginDashboardViewEntry } from "../api";
import type { ToastType } from "../hooks/useToast";
import { useWorkspaceFileBrowser } from "../hooks/useWorkspaceFileBrowser";
import { buildPluginTaskViewId } from "../plugins/pluginViewRegistry";
import { PluginDashboardViewHost } from "../plugins/PluginDashboardViewHost";
import type { DetailTaskTab, PluginDashboardViewContext } from "../plugins/types";
import { FileBrowser } from "./FileBrowser";
import { PageErrorBoundary } from "./ErrorBoundary";
import { getPluginNavIcon } from "./pluginNavIcon";

const DocumentsView = lazy(() => import("./DocumentsView").then((m) => ({ default: m.DocumentsView })));
const InsightsView = lazy(() => import("./InsightsView").then((m) => ({ default: m.InsightsView })));
const ResearchView = lazy(() => import("./ResearchView").then((m) => ({ default: m.ResearchView })));
const EvalsView = lazy(() => import("./EvalsView").then((m) => ({ default: m.EvalsView })));
const SkillsView = lazy(() => import("./SkillsView").then((m) => ({ default: m.SkillsView })));
const MemoryView = lazy(() => import("./MemoryView").then((m) => ({ default: m.MemoryView })));
const SecretsView = lazy(() => import("./SecretsView").then((m) => ({ default: m.SecretsView })));
const DevServerView = lazy(() => import("./DevServerView").then((m) => ({ default: m.DevServerView })));
const TodoView = lazy(() => import("./TodoView").then((m) => ({ default: m.TodoView })));
const GoalsView = lazy(() => import("./GoalsView").then((m) => ({ default: m.GoalsView })));

export type OverflowViewKey =
  | "files"
  | "documents"
  | "research"
  | "insights"
  | "skills"
  | "memory"
  | "secrets"
  | "evals"
  | "goalsView"
  | "todos"
  | "devserver"
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
}

export interface OverflowViewEntry {
  key: OverflowViewKey;
  label: string;
  icon: ComponentType<LucideProps>;
  testId: string;
  render: (props: OverflowViewRenderProps) => ReactNode;
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

function InlineFilesView({ projectId, openFile }: Pick<OverflowViewRenderProps, "projectId" | "openFile">) {
  const { entries, currentPath, setPath, loading, error, refresh } = useWorkspaceFileBrowser("project", true, projectId);
  return (
    <div data-testid="right-dock-files-view">
      <FileBrowser
        entries={entries}
        currentPath={currentPath}
        onSelectFile={(path) => openFile?.(path, { workspace: "project" })}
        onNavigate={setPath}
        loading={loading}
        error={error}
        onRetry={refresh}
        workspace="project"
        onRefresh={refresh}
        projectId={projectId}
      />
    </div>
  );
}

/*
FNXC:Navigation 2026-06-21-00:00:
The right dock and its expand modal must resolve every hosted overflow destination through this registry so toolbar gating, component choice, and props cannot drift between the compact panel and full-size modal surfaces.
*/
export const STATIC_OVERFLOW_VIEW_ENTRIES: readonly OverflowViewEntry[] = [
  {
    key: "files",
    label: "Files",
    icon: Folder,
    testId: "right-dock-tab-files",
    render: (props) => wrapOverflowView(<InlineFilesView projectId={props.projectId} openFile={props.openFile} />),
  },
  {
    key: "documents",
    /*
    FNXC:Navigation 2026-06-21-18:25:
    Top-level Documents was renamed to Artifacts for FN-6890; keep the documents key, route, and test id stable while changing only the displayed label.
    */
    label: "Artifacts",
    icon: FileText,
    testId: "right-dock-tab-documents",
    render: (props) => wrapOverflowView(
      <DocumentsView
        projectId={props.projectId}
        addToast={props.addToast}
        onOpenDetail={(task) => props.onOpenDetail?.(task)}
        onSendSelectionToTask={props.onSendSelectionToTask}
      />,
    ),
  },
  {
    key: "research",
    label: "Research",
    icon: Search,
    testId: "right-dock-tab-research",
    isVisible: ({ experimentalFeatures }) => experimentalFeatures?.researchView === true,
    render: (props) => props.settingsLoaded === false ? null : wrapOverflowView(
      <ResearchView
        projectId={props.projectId}
        addToast={props.addToast}
        onOpenSettings={(section) => props.onOpenSettings?.(section)}
        readinessVersion={props.readinessVersion ?? 0}
      />,
    ),
  },
  {
    key: "insights",
    label: "Insights",
    icon: Sparkles,
    testId: "right-dock-tab-insights",
    isVisible: ({ experimentalFeatures }) => experimentalFeatures?.insights === true,
    render: (props) => props.settingsLoaded === false ? null : wrapOverflowView(
      <InsightsView
        projectId={props.projectId}
        addToast={props.addToast}
        onClose={() => undefined}
        onCreateTask={async (payload) => {
          await props.onCreateTaskFromInsight?.(payload);
        }}
      />,
    ),
  },
  {
    key: "skills",
    label: "Skills",
    icon: Zap,
    testId: "right-dock-tab-skills",
    isVisible: ({ showSkillsTab }) => showSkillsTab === true,
    render: (props) => wrapOverflowView(<SkillsView addToast={props.addToast} projectId={props.projectId} onClose={() => undefined} />),
  },
  {
    key: "memory",
    label: "Memory",
    icon: Brain,
    testId: "right-dock-tab-memory",
    isVisible: ({ experimentalFeatures }) => experimentalFeatures?.memoryView === true,
    render: (props) => props.settingsLoaded === false ? null : wrapOverflowView(
      <MemoryView
        addToast={props.addToast}
        projectId={props.projectId}
        onSendSelectionToTask={props.onSendSelectionToTask}
      />,
    ),
  },
  {
    key: "secrets",
    label: "Secrets",
    icon: Lock,
    testId: "right-dock-tab-secrets",
    render: (props) => wrapOverflowView(<SecretsView addToast={props.addToast} />),
  },
  {
    key: "evals",
    label: "Evals",
    icon: Target,
    testId: "right-dock-tab-evals",
    isVisible: ({ experimentalFeatures }) => experimentalFeatures?.evalsView === true,
    render: (props) => props.settingsLoaded === false ? null : wrapOverflowView(
      <EvalsView
        projectId={props.projectId}
        onOpenSettings={(section) => props.onOpenSettings?.(section)}
        onOpenTaskDetail={(taskId) => props.onOpenTaskDetail?.(taskId)}
      />,
    ),
  },
  {
    key: "goalsView",
    label: "Goals",
    icon: Target,
    testId: "right-dock-tab-goals",
    isVisible: ({ experimentalFeatures }) => experimentalFeatures?.goalsView === true,
    render: (props) => props.settingsLoaded === false ? null : wrapOverflowView(
      <GoalsView anchorGoalId={props.anchorGoalId} onNavigateToMission={(missionId) => props.onNavigateToMission?.(missionId)} />,
    ),
  },
  {
    key: "todos",
    label: "Todos",
    icon: CheckSquare,
    testId: "right-dock-tab-todos",
    isVisible: ({ todosEnabled }) => todosEnabled === true,
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
    key: "devserver",
    label: "Dev Server",
    icon: Monitor,
    testId: "right-dock-tab-devserver",
    isVisible: ({ experimentalFeatures }) => experimentalFeatures?.devServerView === true,
    render: (props) => props.settingsLoaded === false ? null : wrapOverflowView(<DevServerView addToast={props.addToast} projectId={props.projectId} />),
  },
];

function buildPluginOverflowViewEntries(pluginDashboardViews: PluginDashboardViewEntry[] = []): OverflowViewEntry[] {
  return pluginDashboardViews
    .filter((entry) => entry.view.placement !== "primary")
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
