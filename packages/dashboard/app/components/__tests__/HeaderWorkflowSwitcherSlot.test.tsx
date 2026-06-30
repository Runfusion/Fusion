/*
FNXC:MissionWorkflows 2026-06-25-00:00:
The shared header workflow slot is the canonical desktop workflow selector for Planning and Missions, and it must render no leftover toolbar shell when workflow mode cannot be switched.
*/

import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardWorkflowDefinition, BoardWorkflowsPayload } from "../../api";
import { HeaderWorkflowSwitcherSlot, type HeaderWorkflowSelection } from "../HeaderWorkflowSwitcherSlot";
import { PlanningWorkflowSwitcherSlot } from "../PlanningWorkflowSwitcherSlot";

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

const MISSION_WORKFLOW: BoardWorkflowDefinition = {
  id: "wf-missions",
  name: "Missions",
  columns: [],
};

function workflowPayload(overrides: Partial<BoardWorkflowsPayload> = {}): BoardWorkflowsPayload {
  return {
    flagEnabled: true,
    defaultWorkflowId: DEFAULT_WORKFLOW.id,
    workflows: [DEFAULT_WORKFLOW, MISSION_WORKFLOW],
    taskWorkflowIds: {},
    ...overrides,
  };
}

function renderWithHeader(children: ReactNode) {
  return render(
    <>
      <div id="header-workflow-slot" data-testid="header-workflow-slot" />
      {children}
    </>,
  );
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fetchBoardWorkflowsMock.mockReset();
  subscribeSseMock.mockClear();
  fetchBoardWorkflowsMock.mockResolvedValue(workflowPayload());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("HeaderWorkflowSwitcherSlot", () => {
  it("ports the workflow switcher into the desktop header slot and reports selection changes", async () => {
    const onWorkflowSelectionChange = vi.fn<(selection: HeaderWorkflowSelection | null) => void>();

    renderWithHeader(
      <HeaderWorkflowSwitcherSlot projectId="project-missions" onWorkflowSelectionChange={onWorkflowSelectionChange} />,
    );

    const headerSlot = screen.getByTestId("header-workflow-slot");
    const selector = await screen.findByTestId("workflow-switcher");
    expect(headerSlot.contains(selector)).toBe(true);

    await waitFor(() => {
      expect(onWorkflowSelectionChange).toHaveBeenLastCalledWith(expect.objectContaining({
        selectedWorkflow: expect.objectContaining({ id: DEFAULT_WORKFLOW.id }),
      }));
    });

    fireEvent.click(selector);
    fireEvent.click(screen.getByTestId("workflow-switcher-option-wf-missions"));

    await waitFor(() => {
      expect(onWorkflowSelectionChange).toHaveBeenLastCalledWith(expect.objectContaining({
        selectedWorkflow: expect.objectContaining({ id: MISSION_WORKFLOW.id }),
      }));
    });
  });

  it("keeps the Planning wrapper rendering the shared header switcher", async () => {
    renderWithHeader(<PlanningWorkflowSwitcherSlot projectId="project-planning" />);

    const headerSlot = screen.getByTestId("header-workflow-slot");
    const selector = await screen.findByTestId("workflow-switcher");
    expect(headerSlot.contains(selector)).toBe(true);
  });

  it("hydrates a remounted desktop header selector from durable project storage", async () => {
    const { unmount } = renderWithHeader(<HeaderWorkflowSwitcherSlot projectId="project-header-persist" />);

    fireEvent.click(await screen.findByTestId("workflow-switcher"));
    fireEvent.click(screen.getByTestId("workflow-switcher-option-wf-missions"));
    await waitFor(() => expect(screen.getByTestId("workflow-switcher")).toHaveTextContent(MISSION_WORKFLOW.name));

    unmount();
    fetchBoardWorkflowsMock.mockImplementation(() => new Promise<BoardWorkflowsPayload>(() => {}));
    renderWithHeader(<HeaderWorkflowSwitcherSlot projectId="project-header-persist" />);

    expect(await screen.findByTestId("workflow-switcher")).toHaveTextContent(MISSION_WORKFLOW.name);
  });

  it("repairs a stale stored header workflow id to the default workflow", async () => {
    localStorage.setItem("kb:project-header-stale:kb-dashboard-board-workflow-selection", "wf-deleted");
    const onWorkflowSelectionChange = vi.fn<(selection: HeaderWorkflowSelection | null) => void>();

    renderWithHeader(
      <HeaderWorkflowSwitcherSlot projectId="project-header-stale" onWorkflowSelectionChange={onWorkflowSelectionChange} />,
    );

    expect(await screen.findByTestId("workflow-switcher")).toHaveTextContent(DEFAULT_WORKFLOW.name);
    await waitFor(() => {
      expect(onWorkflowSelectionChange).toHaveBeenLastCalledWith(expect.objectContaining({
        selectedWorkflow: expect.objectContaining({ id: DEFAULT_WORKFLOW.id }),
      }));
    });
    expect(localStorage.getItem("kb:project-header-stale:kb-dashboard-board-workflow-selection")).toBe(DEFAULT_WORKFLOW.id);
  });

  it("forwards dropdown edit workflow ids from the shared header slot", async () => {
    const onOpenWorkflowEditor = vi.fn();
    renderWithHeader(<HeaderWorkflowSwitcherSlot projectId="project-header-edit" onOpenWorkflowEditor={onOpenWorkflowEditor} />);

    fireEvent.click(await screen.findByTestId("workflow-switcher"));
    fireEvent.click(screen.getByTestId("workflow-switcher-edit-wf-missions"));

    expect(onOpenWorkflowEditor).toHaveBeenCalledWith("wf-missions");
  });

  it("renders no toolbar shell when workflow mode is off, empty, or only one workflow exists", async () => {
    fetchBoardWorkflowsMock.mockResolvedValueOnce(workflowPayload({ flagEnabled: false, workflows: [] }));
    const { unmount } = renderWithHeader(<HeaderWorkflowSwitcherSlot projectId="project-off" />);
    await waitFor(() => expect(fetchBoardWorkflowsMock).toHaveBeenCalledWith("project-off"));
    expect(screen.queryByTestId("workflow-switcher")).toBeNull();
    expect(screen.getByTestId("header-workflow-slot")).toBeEmptyDOMElement();

    unmount();
    sessionStorage.clear();
    fetchBoardWorkflowsMock.mockResolvedValueOnce(workflowPayload({ workflows: [] }));
    const empty = renderWithHeader(<HeaderWorkflowSwitcherSlot projectId="project-empty" />);
    await waitFor(() => expect(fetchBoardWorkflowsMock).toHaveBeenCalledWith("project-empty"));
    expect(screen.queryByTestId("workflow-switcher")).toBeNull();
    expect(screen.getByTestId("header-workflow-slot")).toBeEmptyDOMElement();

    empty.unmount();
    sessionStorage.clear();
    fetchBoardWorkflowsMock.mockResolvedValueOnce(workflowPayload({ workflows: [DEFAULT_WORKFLOW] }));
    renderWithHeader(<HeaderWorkflowSwitcherSlot projectId="project-one" />);
    await waitFor(() => expect(fetchBoardWorkflowsMock).toHaveBeenCalledWith("project-one"));
    expect(screen.queryByTestId("workflow-switcher")).toBeNull();
    expect(screen.getByTestId("header-workflow-slot")).toBeEmptyDOMElement();
  });

  it("renders no toolbar shell when the header slot is absent", async () => {
    render(<HeaderWorkflowSwitcherSlot projectId="project-mobile" />);

    await waitFor(() => expect(fetchBoardWorkflowsMock).toHaveBeenCalledWith("project-mobile"));
    expect(screen.queryByTestId("workflow-switcher")).toBeNull();
  });
});
