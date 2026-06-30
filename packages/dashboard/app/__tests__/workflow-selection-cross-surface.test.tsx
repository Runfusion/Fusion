import { useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardWorkflowDefinition, BoardWorkflowsPayload } from "../api";
import { HeaderWorkflowSwitcherSlot, type HeaderWorkflowSelection } from "../components/HeaderWorkflowSwitcherSlot";
import {
  filterTasksByGraphWorkflowSelection,
  GraphWorkflowSwitcherSlot,
  type GraphWorkflowSelection,
} from "../components/GraphWorkflowSwitcherSlot";

const fetchBoardWorkflowsMock = vi.fn();
const subscribeSseMock = vi.fn(() => vi.fn());

vi.mock("../api", () => ({
  fetchBoardWorkflows: (...args: unknown[]) => fetchBoardWorkflowsMock(...args),
}));

vi.mock("../sse-bus", () => ({
  subscribeSse: (...args: unknown[]) => subscribeSseMock(...args),
}));

const DEFAULT_WORKFLOW: BoardWorkflowDefinition = {
  id: "builtin:coding",
  name: "Coding",
  columns: [],
};

const GRAPH_WORKFLOW: BoardWorkflowDefinition = {
  id: "wf-graph",
  name: "Graph",
  columns: [],
};

const HEADER_WORKFLOW: BoardWorkflowDefinition = {
  id: "wf-header",
  name: "Header",
  columns: [],
};

const TASKS = [
  { id: "FN-default", title: "Default task" },
  { id: "FN-unassigned", title: "Unassigned task" },
  { id: "FN-graph", title: "Graph task" },
  { id: "FN-deleted", title: "Deleted workflow task" },
];

function workflowPayload(overrides: Partial<BoardWorkflowsPayload> = {}): BoardWorkflowsPayload {
  return {
    flagEnabled: true,
    defaultWorkflowId: DEFAULT_WORKFLOW.id,
    workflows: [DEFAULT_WORKFLOW, GRAPH_WORKFLOW, HEADER_WORKFLOW],
    taskWorkflowIds: {
      "FN-graph": GRAPH_WORKFLOW.id,
      "FN-deleted": "wf-deleted",
    },
    ...overrides,
  };
}

function CrossSurfaceHarness({ projectId = "project-cross" }: { projectId?: string }) {
  const [graphSelection, setGraphSelection] = useState<GraphWorkflowSelection | null>(null);
  const [headerSelection, setHeaderSelection] = useState<HeaderWorkflowSelection | null>(null);
  const graphTasks = filterTasksByGraphWorkflowSelection(TASKS, projectId, graphSelection);

  return (
    <>
      <div id="header-workflow-slot" data-testid="header-workflow-slot" />
      <HeaderWorkflowSwitcherSlot projectId={projectId} onWorkflowSelectionChange={setHeaderSelection} />
      <GraphWorkflowSwitcherSlot projectId={projectId} onWorkflowSelectionChange={setGraphSelection} />
      <output data-testid="header-selection">{headerSelection?.selectedWorkflow.id ?? "none"}</output>
      <output data-testid="graph-selection">{graphSelection?.selectedWorkflow.id ?? "none"}</output>
      <ul data-testid="graph-tasks">
        {graphTasks.map((task) => (
          <li key={task.id} data-testid={`graph-task-${task.id}`}>{task.title}</li>
        ))}
      </ul>
    </>
  );
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fetchBoardWorkflowsMock.mockReset();
  subscribeSseMock.mockClear();
  fetchBoardWorkflowsMock.mockResolvedValue(workflowPayload());
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("workflow selection across dashboard surfaces", () => {
  /*
  FNXC:BoardWorkflowSelection 2026-06-29-13:30:
  Board workflow selectors keep independent mounted state for Header and Graph, but remounts intentionally hydrate from the same project-scoped durable workflow selection so fetch latency cannot bounce operators back to the default workflow.
  */
  it("hydrates remounted Header and Graph surfaces from durable storage while fetch is pending", async () => {
    const { unmount } = render(<CrossSurfaceHarness />);

    expect(await screen.findAllByTestId("workflow-switcher")).toHaveLength(2);
    await waitFor(() => {
      expect(screen.getByTestId("header-selection")).toHaveTextContent(DEFAULT_WORKFLOW.id);
      expect(screen.getByTestId("graph-selection")).toHaveTextContent(DEFAULT_WORKFLOW.id);
    });

    const [, graphSwitcher] = screen.getAllByTestId("workflow-switcher");
    fireEvent.click(graphSwitcher);
    fireEvent.click(screen.getByTestId(`workflow-switcher-option-${GRAPH_WORKFLOW.id}`));
    await waitFor(() => expect(screen.getByTestId("graph-selection")).toHaveTextContent(GRAPH_WORKFLOW.id));

    unmount();
    fetchBoardWorkflowsMock.mockImplementation(() => new Promise<BoardWorkflowsPayload>(() => {}));

    render(<CrossSurfaceHarness />);

    const remountedSwitchers = screen.getAllByTestId("workflow-switcher");
    expect(remountedSwitchers).toHaveLength(2);
    expect(screen.getByTestId("header-selection")).toHaveTextContent(GRAPH_WORKFLOW.id);
    expect(screen.getByTestId("graph-selection")).toHaveTextContent(GRAPH_WORKFLOW.id);
    expect(fetchBoardWorkflowsMock).toHaveBeenCalledWith("project-cross");
  });

  it("keeps mounted Graph and Header workflow selections isolated while Graph filtering follows only Graph", async () => {
    render(<CrossSurfaceHarness />);

    const switchers = await screen.findAllByTestId("workflow-switcher");
    await waitFor(() => {
      expect(screen.getByTestId("header-selection")).toHaveTextContent(DEFAULT_WORKFLOW.id);
      expect(screen.getByTestId("graph-selection")).toHaveTextContent(DEFAULT_WORKFLOW.id);
    });

    const graphTasks = screen.getByTestId("graph-tasks");
    expect(within(graphTasks).getByTestId("graph-task-FN-default")).toBeInTheDocument();
    expect(within(graphTasks).getByTestId("graph-task-FN-unassigned")).toBeInTheDocument();
    expect(within(graphTasks).getByTestId("graph-task-FN-deleted")).toBeInTheDocument();
    expect(within(graphTasks).queryByTestId("graph-task-FN-graph")).toBeNull();

    fireEvent.click(switchers[1]);
    fireEvent.click(screen.getByTestId(`workflow-switcher-option-${GRAPH_WORKFLOW.id}`));

    await waitFor(() => {
      expect(screen.getByTestId("graph-selection")).toHaveTextContent(GRAPH_WORKFLOW.id);
      expect(screen.getByTestId("header-selection")).toHaveTextContent(DEFAULT_WORKFLOW.id);
      expect(within(graphTasks).getByTestId("graph-task-FN-graph")).toBeInTheDocument();
      expect(within(graphTasks).queryByTestId("graph-task-FN-default")).toBeNull();
      expect(within(graphTasks).queryByTestId("graph-task-FN-deleted")).toBeNull();
    });

    fireEvent.click(switchers[0]);
    fireEvent.click(screen.getByTestId(`workflow-switcher-option-${HEADER_WORKFLOW.id}`));

    await waitFor(() => {
      expect(screen.getByTestId("header-selection")).toHaveTextContent(HEADER_WORKFLOW.id);
      expect(screen.getByTestId("graph-selection")).toHaveTextContent(GRAPH_WORKFLOW.id);
      expect(within(graphTasks).getByTestId("graph-task-FN-graph")).toBeInTheDocument();
    });
  });

  it("rehydrates selection per project instead of carrying it across projects", async () => {
    const { rerender } = render(<CrossSurfaceHarness projectId="project-alpha" />);

    const alphaSwitchers = await screen.findAllByTestId("workflow-switcher");
    fireEvent.click(alphaSwitchers[1]);
    fireEvent.click(screen.getByTestId(`workflow-switcher-option-${GRAPH_WORKFLOW.id}`));
    await waitFor(() => expect(screen.getByTestId("graph-selection")).toHaveTextContent(GRAPH_WORKFLOW.id));

    rerender(<CrossSurfaceHarness projectId="project-beta" />);

    await waitFor(() => {
      expect(screen.getByTestId("header-selection")).toHaveTextContent(DEFAULT_WORKFLOW.id);
      expect(screen.getByTestId("graph-selection")).toHaveTextContent(DEFAULT_WORKFLOW.id);
    });
  });

  it("repairs stale stored workflow ids to the default workflow without hiding graph tasks", async () => {
    localStorage.setItem("kb:project-cross:kb-dashboard-board-workflow-selection", "wf-deleted");

    render(<CrossSurfaceHarness />);

    expect(await screen.findAllByTestId("workflow-switcher")).toHaveLength(2);
    await waitFor(() => {
      expect(screen.getByTestId("header-selection")).toHaveTextContent(DEFAULT_WORKFLOW.id);
      expect(screen.getByTestId("graph-selection")).toHaveTextContent(DEFAULT_WORKFLOW.id);
    });
    expect(localStorage.getItem("kb:project-cross:kb-dashboard-board-workflow-selection")).toBe(DEFAULT_WORKFLOW.id);

    const graphTasks = screen.getByTestId("graph-tasks");
    expect(within(graphTasks).getByTestId("graph-task-FN-default")).toBeInTheDocument();
    expect(within(graphTasks).getByTestId("graph-task-FN-unassigned")).toBeInTheDocument();
    expect(within(graphTasks).getByTestId("graph-task-FN-deleted")).toBeInTheDocument();
    expect(within(graphTasks).queryByTestId("graph-task-FN-graph")).toBeNull();
  });

  it("preserves boundary behavior for disabled, empty, and single-workflow payloads", async () => {
    localStorage.setItem("kb:project-disabled:kb-dashboard-board-workflow-selection", GRAPH_WORKFLOW.id);
    fetchBoardWorkflowsMock.mockResolvedValue(workflowPayload({ flagEnabled: false, workflows: [] }));
    const { unmount } = render(<CrossSurfaceHarness projectId="project-disabled" />);

    await waitFor(() => expect(fetchBoardWorkflowsMock).toHaveBeenCalledWith("project-disabled"));
    expect(screen.queryByTestId("workflow-switcher")).toBeNull();
    expect(screen.getByTestId("header-workflow-slot")).toBeEmptyDOMElement();
    expect(localStorage.getItem("kb:project-disabled:kb-dashboard-board-workflow-selection")).toBeNull();
    for (const task of TASKS) {
      expect(screen.getByTestId(`graph-task-${task.id}`)).toBeInTheDocument();
    }

    unmount();
    sessionStorage.clear();
    localStorage.setItem("kb:project-empty:kb-dashboard-board-workflow-selection", GRAPH_WORKFLOW.id);
    fetchBoardWorkflowsMock.mockResolvedValue(workflowPayload({ workflows: [] }));
    const empty = render(<CrossSurfaceHarness projectId="project-empty" />);
    await waitFor(() => expect(fetchBoardWorkflowsMock).toHaveBeenCalledWith("project-empty"));
    expect(screen.queryByTestId("workflow-switcher")).toBeNull();
    expect(screen.getByTestId("header-workflow-slot")).toBeEmptyDOMElement();
    expect(localStorage.getItem("kb:project-empty:kb-dashboard-board-workflow-selection")).toBeNull();
    empty.unmount();

    sessionStorage.clear();
    localStorage.setItem("kb:project-single:kb-dashboard-board-workflow-selection", GRAPH_WORKFLOW.id);
    fetchBoardWorkflowsMock.mockResolvedValue(workflowPayload({ workflows: [DEFAULT_WORKFLOW] }));
    render(<CrossSurfaceHarness projectId="project-single" />);
    await waitFor(() => expect(fetchBoardWorkflowsMock).toHaveBeenCalledWith("project-single"));
    expect(screen.queryByTestId("workflow-switcher")).toBeNull();
    expect(screen.getByTestId("header-workflow-slot")).toBeEmptyDOMElement();
    expect(localStorage.getItem("kb:project-single:kb-dashboard-board-workflow-selection")).toBeNull();
  });
});
