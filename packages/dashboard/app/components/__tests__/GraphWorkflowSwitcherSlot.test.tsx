import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardWorkflowDefinition, BoardWorkflowsPayload } from "../../api";
import { filterTasksByGraphWorkflowSelection, GraphWorkflowSwitcherSlot, type GraphWorkflowSelection } from "../GraphWorkflowSwitcherSlot";

const fetchBoardWorkflowsMock = vi.fn();
const subscribeSseMock = vi.fn(() => vi.fn());

vi.mock("../../api", () => ({
  fetchBoardWorkflows: (...args: unknown[]) => fetchBoardWorkflowsMock(...args),
}));

vi.mock("../../sse-bus", () => ({
  subscribeSse: (...args: unknown[]) => subscribeSseMock(...args),
}));

const DEFAULT_WORKFLOW: BoardWorkflowDefinition = {
  id: "builtin:coding",
  name: "Coding",
  columns: [],
};

const CUSTOM_WORKFLOW: BoardWorkflowDefinition = {
  id: "wf-review",
  name: "Review",
  columns: [],
};

function workflowPayload(overrides: Partial<BoardWorkflowsPayload> = {}): BoardWorkflowsPayload {
  return {
    flagEnabled: true,
    defaultWorkflowId: DEFAULT_WORKFLOW.id,
    workflows: [DEFAULT_WORKFLOW, CUSTOM_WORKFLOW],
    taskWorkflowIds: {},
    ...overrides,
  };
}

function appendHeaderWorkflowSlot() {
  const slot = document.createElement("div");
  slot.id = "header-workflow-slot";
  slot.className = "header-workflow-slot";
  document.body.appendChild(slot);
  return slot;
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
  document.getElementById("header-workflow-slot")?.remove();
  vi.restoreAllMocks();
});

describe("filterTasksByGraphWorkflowSelection", () => {
  it("uses task workflow assignments with default fallback for graph scoping", () => {
    const tasks = [
      { id: "FN-default" },
      { id: "FN-unassigned" },
      { id: "FN-review" },
      { id: "FN-unknown" },
    ];
    const selection: GraphWorkflowSelection = {
      boardWorkflows: workflowPayload({
        taskWorkflowIds: {
          "FN-review": CUSTOM_WORKFLOW.id,
          "FN-unknown": "wf-missing",
        },
      }),
      selectedWorkflow: DEFAULT_WORKFLOW,
    };

    expect(filterTasksByGraphWorkflowSelection(tasks, "project-graph", selection).map((task) => task.id)).toEqual([
      "FN-default",
      "FN-unassigned",
      "FN-unknown",
    ]);
    expect(filterTasksByGraphWorkflowSelection(tasks, "project-graph", { ...selection, selectedWorkflow: CUSTOM_WORKFLOW }).map((task) => task.id)).toEqual([
      "FN-review",
    ]);
  });

  it("preserves unfiltered graph tasks without a project or workflow payload", () => {
    const tasks = [{ id: "FN-a" }, { id: "FN-b" }];
    const selection: GraphWorkflowSelection = {
      boardWorkflows: workflowPayload({ taskWorkflowIds: { "FN-b": CUSTOM_WORKFLOW.id } }),
      selectedWorkflow: CUSTOM_WORKFLOW,
    };

    expect(filterTasksByGraphWorkflowSelection(tasks, undefined, selection)).toBe(tasks);
    expect(filterTasksByGraphWorkflowSelection(tasks, "project-graph", null)).toBe(tasks);
  });
});

describe("GraphWorkflowSwitcherSlot", () => {
  it("portals the shared workflow switcher into the header workflow slot", async () => {
    const headerSlot = appendHeaderWorkflowSlot();
    const onWorkflowSelectionChange = vi.fn();

    render(<GraphWorkflowSwitcherSlot projectId="project-graph" onWorkflowSelectionChange={onWorkflowSelectionChange} />);

    const selector = await screen.findByTestId("workflow-switcher");
    expect(headerSlot.contains(selector)).toBe(true);
    expect(headerSlot.querySelector(".board-workflow-toolbar")).not.toBeNull();
    await waitFor(() => {
      expect(onWorkflowSelectionChange).toHaveBeenLastCalledWith({
        boardWorkflows: workflowPayload(),
        selectedWorkflow: DEFAULT_WORKFLOW,
      });
    });
  });

  it("refreshes the board-workflows payload when the dropdown opens", async () => {
    appendHeaderWorkflowSlot();
    render(<GraphWorkflowSwitcherSlot projectId="project-refresh" />);

    const selector = await screen.findByTestId("workflow-switcher");
    await waitFor(() => expect(fetchBoardWorkflowsMock).toHaveBeenCalledTimes(1));
    fireEvent.click(selector);

    await waitFor(() => expect(fetchBoardWorkflowsMock).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("listbox", { name: "Workflow" })).toBeInTheDocument();
  });

  it("reports selection changes so App can scope graph tasks", async () => {
    appendHeaderWorkflowSlot();
    const onWorkflowSelectionChange = vi.fn();
    render(<GraphWorkflowSwitcherSlot projectId="project-select" onWorkflowSelectionChange={onWorkflowSelectionChange} />);

    fireEvent.click(await screen.findByTestId("workflow-switcher"));
    fireEvent.click(screen.getByTestId("workflow-switcher-option-wf-review"));

    await waitFor(() => {
      const lastSelection = onWorkflowSelectionChange.mock.calls.at(-1)?.[0] as GraphWorkflowSelection | null;
      expect(lastSelection?.selectedWorkflow.id).toBe("wf-review");
    });
  });

  it("hydrates a remounted graph selector from durable project storage while fetch is pending", async () => {
    appendHeaderWorkflowSlot();
    const { unmount } = render(<GraphWorkflowSwitcherSlot projectId="project-graph-persist" />);

    fireEvent.click(await screen.findByTestId("workflow-switcher"));
    fireEvent.click(screen.getByTestId("workflow-switcher-option-wf-review"));
    await waitFor(() => expect(screen.getByTestId("workflow-switcher")).toHaveTextContent(CUSTOM_WORKFLOW.name));

    unmount();
    fetchBoardWorkflowsMock.mockImplementation(() => new Promise<BoardWorkflowsPayload>(() => {}));
    render(<GraphWorkflowSwitcherSlot projectId="project-graph-persist" />);

    expect(await screen.findByTestId("workflow-switcher")).toHaveTextContent(CUSTOM_WORKFLOW.name);
  });

  it("repairs a stale stored graph workflow id to the default workflow", async () => {
    appendHeaderWorkflowSlot();
    localStorage.setItem("kb:project-graph-stale:kb-dashboard-board-workflow-selection", "wf-deleted");
    const onWorkflowSelectionChange = vi.fn();

    render(<GraphWorkflowSwitcherSlot projectId="project-graph-stale" onWorkflowSelectionChange={onWorkflowSelectionChange} />);

    expect(await screen.findByTestId("workflow-switcher")).toHaveTextContent(DEFAULT_WORKFLOW.name);
    await waitFor(() => {
      const lastSelection = onWorkflowSelectionChange.mock.calls.at(-1)?.[0] as GraphWorkflowSelection | null;
      expect(lastSelection?.selectedWorkflow.id).toBe(DEFAULT_WORKFLOW.id);
    });
    expect(localStorage.getItem("kb:project-graph-stale:kb-dashboard-board-workflow-selection")).toBe(DEFAULT_WORKFLOW.id);
  });

  it("keeps a valid graph workflow selection through focus refreshes", async () => {
    appendHeaderWorkflowSlot();
    const onWorkflowSelectionChange = vi.fn();
    render(<GraphWorkflowSwitcherSlot projectId="project-focus" onWorkflowSelectionChange={onWorkflowSelectionChange} />);

    fireEvent.click(await screen.findByTestId("workflow-switcher"));
    fireEvent.click(screen.getByTestId("workflow-switcher-option-wf-review"));
    await waitFor(() => {
      const lastSelection = onWorkflowSelectionChange.mock.calls.at(-1)?.[0] as GraphWorkflowSelection | null;
      expect(lastSelection?.selectedWorkflow.id).toBe(CUSTOM_WORKFLOW.id);
    });

    fetchBoardWorkflowsMock.mockResolvedValue(workflowPayload({
      defaultWorkflowId: DEFAULT_WORKFLOW.id,
      workflows: [DEFAULT_WORKFLOW, CUSTOM_WORKFLOW],
    }));
    const callsBeforeFocus = fetchBoardWorkflowsMock.mock.calls.length;
    window.dispatchEvent(new Event("focus"));

    await waitFor(() => expect(fetchBoardWorkflowsMock).toHaveBeenCalledTimes(callsBeforeFocus + 1));
    await waitFor(() => {
      const lastSelection = onWorkflowSelectionChange.mock.calls.at(-1)?.[0] as GraphWorkflowSelection | null;
      expect(lastSelection?.selectedWorkflow.id).toBe(CUSTOM_WORKFLOW.id);
    });
  });

  it("forwards dropdown edit workflow ids to the graph editor launcher", async () => {
    appendHeaderWorkflowSlot();
    const onOpenWorkflowEditor = vi.fn();
    render(<GraphWorkflowSwitcherSlot projectId="project-edit" onOpenWorkflowEditor={onOpenWorkflowEditor} />);

    fireEvent.click(await screen.findByTestId("workflow-switcher"));
    fireEvent.click(screen.getByTestId("workflow-switcher-edit-wf-review"));

    expect(onOpenWorkflowEditor).toHaveBeenCalledWith("wf-review");
  });

  it("renders no dropdown shell when the header slot is absent", async () => {
    render(<GraphWorkflowSwitcherSlot projectId="project-no-slot" />);

    await waitFor(() => expect(fetchBoardWorkflowsMock).toHaveBeenCalled());
    expect(screen.queryByTestId("workflow-switcher")).toBeNull();
    expect(document.querySelector(".board-workflow-toolbar")).toBeNull();
  });

  it("renders no dropdown shell when workflow mode is disabled, empty, or not switchable", async () => {
    const headerSlot = appendHeaderWorkflowSlot();
    const { rerender } = render(<GraphWorkflowSwitcherSlot projectId="project-disabled" />);

    fetchBoardWorkflowsMock.mockResolvedValue(workflowPayload({ flagEnabled: false, workflows: [] }));
    rerender(<GraphWorkflowSwitcherSlot projectId="project-disabled-next" />);
    await waitFor(() => expect(fetchBoardWorkflowsMock).toHaveBeenCalledWith("project-disabled-next"));
    expect(screen.queryByTestId("workflow-switcher")).toBeNull();
    expect(headerSlot.childElementCount).toBe(0);

    fetchBoardWorkflowsMock.mockResolvedValue(workflowPayload({ workflows: [] }));
    rerender(<GraphWorkflowSwitcherSlot projectId="project-empty" />);
    await waitFor(() => expect(fetchBoardWorkflowsMock).toHaveBeenCalledWith("project-empty"));
    expect(screen.queryByTestId("workflow-switcher")).toBeNull();
    expect(headerSlot.childElementCount).toBe(0);

    fetchBoardWorkflowsMock.mockResolvedValue(workflowPayload({ workflows: [DEFAULT_WORKFLOW] }));
    rerender(<GraphWorkflowSwitcherSlot projectId="project-single" />);
    await waitFor(() => expect(fetchBoardWorkflowsMock).toHaveBeenCalledWith("project-single"));
    expect(screen.queryByTestId("workflow-switcher")).toBeNull();
    expect(headerSlot.childElementCount).toBe(0);
  });
});
