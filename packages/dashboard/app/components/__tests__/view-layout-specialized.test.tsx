import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { WorkflowDefinition } from "@fusion/core";
import { ProjectOverview } from "../ProjectOverview";
import { ListView } from "../ListView";
import { WorkflowNodeEditor } from "../WorkflowNodeEditor";
import { ViewLayoutProvider } from "../../context/ViewLayoutContext";
import type { ProjectInfoWithSource } from "../../api";

/*
FNXC:StandardizedViewLayout 2026-09-13-22:40:
FN-379 exercises the specialized destinations through their real components: Projects, List, and Workflows each
own one shared header, one canonical creation entry, and a rail that survives empty data, selection, and the
create form. None of them mutates anything merely by mounting.
*/

vi.mock("../../api", () => ({
  fetchProjectHealth: vi.fn().mockResolvedValue({
    projectId: "p1", status: "active", activeTaskCount: 0, inFlightAgentCount: 0,
    totalTasksCompleted: 0, totalTasksFailed: 0, updatedAt: "2026-01-01T00:00:00.000Z",
  }),
  fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] }),
  fetchSettings: vi.fn().mockResolvedValue({ modelPresets: [], defaultPresetBySize: {}, autoMerge: true }),
  fetchGlobalSettings: vi.fn().mockResolvedValue({}),
  fetchConfig: vi.fn().mockResolvedValue({}),
  updateSettings: vi.fn(),
  updateGlobalSettings: vi.fn(),
  fetchTaskDetail: vi.fn(),
  batchUpdateTaskModels: vi.fn(),
  fetchNodes: vi.fn(() => new Promise(() => {})),
  fetchBoardWorkflows: vi.fn(),
  rebuildTaskSpec: vi.fn().mockResolvedValue({}),
  refreshPrStatus: vi.fn().mockResolvedValue({}),
  updateTask: vi.fn(),
  api: vi.fn().mockResolvedValue({ sessions: [] }),
  fetchWorkflowOptionalSteps: vi.fn().mockResolvedValue({ steps: [] }),
  fetchWorkflows: vi.fn().mockResolvedValue([]),
  createWorkflow: vi.fn(),
  updateWorkflow: vi.fn(),
  deleteWorkflow: vi.fn(),
  exportWorkflow: vi.fn(),
  importWorkflow: vi.fn(),
  designWorkflow: vi.fn(),
  fetchTraits: vi.fn().mockResolvedValue([]),
  fetchStepParsers: vi.fn().mockResolvedValue(["step-headings"]),
  fetchAgents: vi.fn().mockResolvedValue([]),
  fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
  fetchWorkflowStepTemplates: vi.fn().mockResolvedValue({ templates: [] }),
  fetchPluginWorkflowStepTemplates: vi.fn().mockResolvedValue({ templates: [] }),
  fetchWorkflowSettingValues: vi.fn().mockResolvedValue({ stored: {}, effective: {}, orphaned: [] }),
  updateWorkflowSettingValues: vi.fn().mockResolvedValue({ stored: {}, effective: {}, orphaned: [] }),
  fetchWorkflowPromptOverrides: vi.fn().mockResolvedValue({ stored: {}, effective: {}, defaults: {} }),
  updateWorkflowPromptOverrides: vi.fn().mockResolvedValue({ stored: {}, effective: {}, defaults: {} }),
  ApiRequestError: class ApiRequestError extends Error {
    status: number;
    constructor(message: string, status: number) { super(message); this.name = "ApiRequestError"; this.status = status; }
  },
}));

vi.mock("../../sse-bus", () => ({ subscribeSse: vi.fn(() => () => undefined) }));

const api = await import("../../api");
const { writeBoardWorkflowsCache } = await import("../../utils/boardWorkflowsCache");

const LANE_PAYLOAD = {
  flagEnabled: true,
  defaultWorkflowId: "builtin:coding",
  workflows: [
    {
      id: "builtin:coding",
      name: "Coding",
      columns: [
        { id: "triage", name: "Planning", flags: { intake: true } },
        { id: "todo", name: "Todo", flags: { hold: true } },
        { id: "in-progress", name: "In progress", flags: { countsTowardWip: true } },
        { id: "in-review", name: "In review", flags: { mergeBlocker: true } },
        { id: "done", name: "Done", flags: { complete: true } },
      ],
    },
  ],
  taskWorkflowIds: {},
};

function project(id: string): ProjectInfoWithSource {
  return {
    id,
    name: `Project ${id}`,
    path: `/workspace/${id}`,
    status: "active",
    isolationMode: "in-process",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as ProjectInfoWithSource;
}

function workflow(id: string, name: string): WorkflowDefinition {
  return {
    id,
    name,
    isBuiltIn: false,
    ir: {
      version: 2,
      columns: [{ id: "todo", name: "Todo", traits: ["entry"] }],
      nodes: [],
      edges: [],
    },
  } as unknown as WorkflowDefinition;
}

function renderList(props: Record<string, unknown> = {}) {
  return render(
    <ViewLayoutProvider projectId="proj-spec">
      <ListView
        tasks={[]}
        onMoveTask={vi.fn()}
        onRetryTask={vi.fn()}
        onDeleteTask={vi.fn()}
        onMergeTask={vi.fn()}
        onResetTask={vi.fn()}
        onOpenDetail={vi.fn()}
        addToast={vi.fn()}
        globalPaused={false}
        projectId="proj-spec"
        {...(props as never)}
      />
    </ViewLayoutProvider>,
  );
}

describe("FN-379 standardized specialized destinations", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("fusion:wf-editor-view-mode", "advanced");
    localStorage.setItem("fusion:wf-mobile-graph-style", "list");
    vi.clearAllMocks();
    vi.mocked(api.fetchWorkflows).mockResolvedValue([]);
    vi.mocked(api.fetchTraits).mockResolvedValue([] as never);
    vi.mocked(api.fetchBoardWorkflows).mockResolvedValue(LANE_PAYLOAD as never);
    writeBoardWorkflowsCache("proj-spec", LANE_PAYLOAD as never);
  });
  afterEach(() => cleanup());

  it("gives Projects one shared header whose only creation entry is canonical", async () => {
    const onAddProject = vi.fn();
    render(
      <ViewLayoutProvider projectId="proj-spec">
        <ProjectOverview
          projects={[project("p1"), project("p2")]}
          onSelectProject={vi.fn()}
          onAddProject={onAddProject}
          onPauseProject={vi.fn()}
          onResumeProject={vi.fn()}
          onRemoveProject={vi.fn()}
        />
      </ViewLayoutProvider>,
    );

    expect(screen.getAllByRole("banner")).toHaveLength(1);
    const create = screen.getByRole("button", { name: "Add Project" });
    expect(create).toHaveClass("view-action-button--create");
    expect(within(screen.getByRole("banner")).getByRole("button", { name: "Add Project" })).toBe(create);

    fireEvent.click(create);
    expect(onAddProject).toHaveBeenCalledTimes(1);
  });

  it("keeps an empty Projects collection headed without a duplicate creation entry", async () => {
    render(
      <ViewLayoutProvider projectId="proj-spec">
        <ProjectOverview
          projects={[]}
          onSelectProject={vi.fn()}
          onAddProject={vi.fn()}
          onPauseProject={vi.fn()}
          onResumeProject={vi.fn()}
          onRemoveProject={vi.fn()}
        />
      </ViewLayoutProvider>,
    );

    expect(screen.getAllByRole("banner")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Add Project" })).toHaveLength(1);
  });

  it("keeps the List destination rail and its canonical New Task in the shared header", async () => {
    const onNewTask = vi.fn();
    renderList({ onNewTask });
    await waitFor(() => expect(screen.getByTestId("list-primary-action-cluster")).toBeInTheDocument());

    const banner = screen.getByRole("banner");
    const create = within(banner).getByRole("button", { name: "New Task" });
    expect(create).toHaveClass("view-action-button--create");
    expect(screen.getAllByRole("button", { name: "New Task" })).toHaveLength(1);

    fireEvent.click(create);
    expect(onNewTask).toHaveBeenCalledTimes(1);
    expect(api.updateTask).not.toHaveBeenCalled();
  });

  it("omits a creation affordance from List when the host provides no create callback", async () => {
    renderList();
    await waitFor(() => expect(screen.getByTestId("list-primary-action-cluster")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "New Task" })).toBeNull();
  });

  it("keeps the Workflows rail mounted with one canonical creation entry, empty and populated", async () => {
    render(<WorkflowNodeEditor isOpen onClose={vi.fn()} addToast={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("wf-new-workflow")).toBeInTheDocument());
    expect(screen.getAllByTestId("wf-new-workflow")).toHaveLength(1);
    expect(screen.getByTestId("wf-new-workflow")).toHaveClass("view-action-button--create");
    expect(document.querySelector(".wf-editor-sidebar")).toBeInTheDocument();
    cleanup();

    vi.mocked(api.fetchWorkflows).mockResolvedValue([workflow("WF-1", "QA"), workflow("WF-2", "Docs")] as never);
    render(<WorkflowNodeEditor isOpen onClose={vi.fn()} addToast={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "QA" }).length).toBeGreaterThan(0));
    expect(document.querySelector(".wf-editor-sidebar")).toBeInTheDocument();
    expect(screen.getAllByTestId("wf-new-workflow")).toHaveLength(1);
    expect(api.createWorkflow).not.toHaveBeenCalled();
    expect(api.updateWorkflow).not.toHaveBeenCalled();
    expect(api.deleteWorkflow).not.toHaveBeenCalled();
  });

  it("keeps the Workflows rail mounted while the create form occupies the detail pane", async () => {
    vi.mocked(api.fetchWorkflows).mockResolvedValue([workflow("WF-1", "QA")] as never);
    render(<WorkflowNodeEditor isOpen onClose={vi.fn()} addToast={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("wf-new-workflow")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("wf-new-workflow"));
    expect(document.querySelector(".wf-editor-sidebar")).toBeInTheDocument();
    expect(api.createWorkflow).not.toHaveBeenCalled();
  });
});
