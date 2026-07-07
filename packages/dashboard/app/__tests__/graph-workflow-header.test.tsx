import { useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardWorkflowDefinition, BoardWorkflowsPayload } from "../api";
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

const REVIEW_WORKFLOW: BoardWorkflowDefinition = {
  id: "wf-review",
  name: "Review",
  columns: [],
};

const TASKS = [
  { id: "FN-default", title: "Default task" },
  { id: "FN-unassigned", title: "Unassigned task" },
  { id: "FN-review", title: "Review task" },
  { id: "FN-unknown", title: "Unknown task" },
];

function workflowPayload(overrides: Partial<BoardWorkflowsPayload> = {}): BoardWorkflowsPayload {
  return {
    flagEnabled: true,
    defaultWorkflowId: DEFAULT_WORKFLOW.id,
    workflows: [DEFAULT_WORKFLOW, REVIEW_WORKFLOW],
    taskWorkflowIds: {
      "FN-review": REVIEW_WORKFLOW.id,
      "FN-unknown": "wf-missing",
    },
    ...overrides,
  };
}

function GraphPluginContextHarness({ projectId = "project-graph" }: { projectId?: string }) {
  const [selection, setSelection] = useState<GraphWorkflowSelection | null>(null);
  const pluginTasks = filterTasksByGraphWorkflowSelection(TASKS, projectId, selection);

  return (
    <>
      <div id="header-workflow-slot" data-testid="header-workflow-slot" />
      <GraphWorkflowSwitcherSlot projectId={projectId} onWorkflowSelectionChange={setSelection} />
      <ul data-testid="graph-plugin-context-tasks">
        {pluginTasks.map((task) => (
          <li key={task.id} data-testid={`graph-context-task-${task.id}`}>{task.title}</li>
        ))}
      </ul>
    </>
  );
}

beforeEach(() => {
  sessionStorage.clear();
  fetchBoardWorkflowsMock.mockReset();
  subscribeSseMock.mockClear();
  fetchBoardWorkflowsMock.mockResolvedValue(workflowPayload());
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Graph workflow header integration", () => {
  it("ports the dropdown into the header and scopes graph plugin tasks by selected workflow", async () => {
    render(<GraphPluginContextHarness />);

    const headerSlot = screen.getByTestId("header-workflow-slot");
    const selector = await screen.findByTestId("workflow-switcher");
    expect(headerSlot.contains(selector)).toBe(true);

    const contextTasks = screen.getByTestId("graph-plugin-context-tasks");
      /*
      FNXC:GraphWorkflowSelection 2026-07-07-08:15:
      FN-7057 changed filterTasksByGraphWorkflowSelection to treat stale taskWorkflowIds entries that reference deleted/missing workflows as DEFAULT-workflow assignments (so tasks never vanish from every view). FN-unknown carries wf-missing, so under the default Coding selection it now resolves to the default workflow and is SHOWN, not filtered out.
      */
    await waitFor(() => {
      expect(within(contextTasks).getByTestId("graph-context-task-FN-default")).toBeInTheDocument();
      expect(within(contextTasks).getByTestId("graph-context-task-FN-unassigned")).toBeInTheDocument();
      expect(within(contextTasks).queryByTestId("graph-context-task-FN-review")).toBeNull();
      expect(within(contextTasks).getByTestId("graph-context-task-FN-unknown")).toBeInTheDocument();
    });

    fireEvent.click(selector);
    fireEvent.click(screen.getByTestId("workflow-switcher-option-wf-review"));

    await waitFor(() => {
      expect(within(contextTasks).getByTestId("graph-context-task-FN-review")).toBeInTheDocument();
      expect(within(contextTasks).queryByTestId("graph-context-task-FN-default")).toBeNull();
      expect(within(contextTasks).queryByTestId("graph-context-task-FN-unassigned")).toBeNull();
      expect(within(contextTasks).queryByTestId("graph-context-task-FN-unknown")).toBeNull();
    });
  });

  it("keeps graph plugin tasks unfiltered when workflow mode is disabled or no project is selected", async () => {
    fetchBoardWorkflowsMock.mockResolvedValue(workflowPayload({ flagEnabled: false, workflows: [] }));
    const { rerender } = render(<GraphPluginContextHarness />);

    await waitFor(() => expect(fetchBoardWorkflowsMock).toHaveBeenCalledWith("project-graph"));
    expect(screen.queryByTestId("workflow-switcher")).toBeNull();
    for (const task of TASKS) {
      expect(screen.getByTestId(`graph-context-task-${task.id}`)).toBeInTheDocument();
    }

    fetchBoardWorkflowsMock.mockResolvedValue(workflowPayload());
    rerender(<GraphPluginContextHarness projectId="" />);
    await waitFor(() => expect(fetchBoardWorkflowsMock).toHaveBeenCalledWith(""));
    for (const task of TASKS) {
      expect(screen.getByTestId(`graph-context-task-${task.id}`)).toBeInTheDocument();
    }
  });
});
