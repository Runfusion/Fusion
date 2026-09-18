import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { readAppFile } from "../../test/cssFixture";
import { Board } from "../Board";
import { clearResumeEvents, getResumeEvents } from "../../utils/resumeInstrumentation";

const workflow = {
  id: "builtin:coding",
  name: "Coding",
  columns: [
    { id: "triage", name: "Triage", flags: { intake: true } },
    { id: "done", name: "Done", flags: { complete: true } },
  ],
};

vi.mock("../../hooks/useBoardWorkflows", () => ({
  useBoardWorkflows: () => ({
    boardWorkflows: { defaultWorkflowId: workflow.id, workflows: [workflow], taskWorkflowIds: {} },
    workflowMode: true,
    workflowOptions: [workflow],
    selectedWorkflow: workflow,
    selectedWorkflowId: workflow.id,
    setSelectedWorkflowId: vi.fn(),
    refreshBoardWorkflows: vi.fn(),
    setBoardWorkflowsState: vi.fn(),
  }),
}));

vi.mock("../Column", () => ({ Column: () => null }));

function boardProps(overrides: Partial<React.ComponentProps<typeof Board>> = {}) {
  return {
    tasks: [],
    maxConcurrent: 2,
    showWorktreeGrouping: false,
    onMoveTask: vi.fn(async () => ({})),
    onOpenDetail: vi.fn(),
    addToast: vi.fn(),
    onNewTask: vi.fn(),
    autoMerge: true,
    planAutoApproveEnabled: false,
    onTogglePlanAutoApprove: vi.fn(),
    ...overrides,
  } as React.ComponentProps<typeof Board>;
}

function createHeaderSlot() {
  const slot = document.createElement("div");
  slot.id = "header-workflow-slot";
  document.body.appendChild(slot);
  return slot;
}

function mockViewport(mode: "desktop" | "mobile") {
  const originalWidth = window.innerWidth;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: mode === "mobile" ? 375 : 1280 });
  vi.mocked(window.matchMedia).mockImplementation((query: string) => ({
    matches: mode === "mobile" && query.includes("max-width: 768px"),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  return () => Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
}

describe("Board active keep-alive gate", () => {
  beforeEach(() => {
    clearResumeEvents();
    vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.getElementById("header-workflow-slot")?.remove();
  });

  it("records inactive and active transitions without remounting", async () => {
    const { rerender } = render(<Board {...boardProps({ active: true })} />);
    await waitFor(() => expect(getResumeEvents().filter((event) => event.view === "Board").map((event) => event.trigger)).toEqual(["remount"]));

    rerender(<Board {...boardProps({ active: false })} />);
    await waitFor(() => expect(getResumeEvents().filter((event) => event.view === "Board").map((event) => event.trigger)).toEqual(["remount", "route-inactive"]));

    rerender(<Board {...boardProps({ active: true })} />);
    await waitFor(() => expect(getResumeEvents().filter((event) => event.view === "Board").map((event) => event.trigger)).toEqual(["remount", "route-inactive", "route-active"]));
  });

  it.each(["desktop", "mobile"] as const)("releases the header workflow slot while inactive on %s", async (mode) => {
    const restoreViewport = mockViewport(mode);
    const slot = createHeaderSlot();
    try {
      const { rerender } = render(<Board {...boardProps({ active: true, workflowControlsInHeader: true })} />);
      await waitFor(() => expect(slot.querySelector(".board-workflow-toolbar")).not.toBeNull());

      rerender(<Board {...boardProps({ active: false, workflowControlsInHeader: true })} />);
      await waitFor(() => expect(slot).toBeEmptyDOMElement());
    } finally {
      restoreViewport();
    }
  });

  /*
  FNXC:WorkflowControls 2026-09-15-01:44:
  FN-405: releasing the shared slot while inactive is only half the contract — a Board that becomes
  active again must RECLAIM it. The shared resolver re-resolves on re-enable, so the round trip must
  leave the selector back in the header with no residual inline toolbar.
  */
  it("reclaims the header workflow slot when it becomes active again", async () => {
    const slot = createHeaderSlot();
    const { container, rerender } = render(<Board {...boardProps({ active: true, workflowControlsInHeader: true })} />);
    await waitFor(() => expect(slot.querySelector(".board-workflow-toolbar")).not.toBeNull());

    rerender(<Board {...boardProps({ active: false, workflowControlsInHeader: true })} />);
    await waitFor(() => expect(slot).toBeEmptyDOMElement());

    rerender(<Board {...boardProps({ active: true, workflowControlsInHeader: true })} />);
    await waitFor(() => expect(slot.querySelector(".board-workflow-toolbar")).not.toBeNull());
    expect(container.querySelector(".board-workflow-view > .board-workflow-toolbar")).toBeNull();
    expect(document.querySelectorAll(".board-workflow-toolbar")).toHaveLength(1);
  });

  it("guards portal selection during render, before the inactive effect can clear a cached slot", () => {
    const source = readAppFile("components/Board.tsx");
    expect(source).toContain("const shouldRelocateWorkflowToolbar = active && workflowControlsInHeader");
    expect(source).toContain("const renderedWorkflowToolbar = shouldRelocateWorkflowToolbar ? relocatedWorkflowToolbar : workflowToolbar");
  });

  /*
  FNXC:BoardNavigation 2026-09-18-02:12:
  FN-522 — reprendre le slot « à terme » ne suffisait pas : le commit de réactivation lui-même peignait le repli en
  ligne, ce qui poussait le tableau de la hauteur de cette bande. Ce cas n'attend RIEN après la réactivation.
  */
  it("reprend le slot dès le commit de réactivation, sans repli en ligne intermédiaire", async () => {
    const slot = createHeaderSlot();
    const { container, rerender } = render(<Board {...boardProps({ active: true, workflowControlsInHeader: true })} />);
    await waitFor(() => expect(slot.querySelector(".board-workflow-toolbar")).not.toBeNull());

    rerender(<Board {...boardProps({ active: false, workflowControlsInHeader: true })} />);
    await waitFor(() => expect(slot).toBeEmptyDOMElement());

    rerender(<Board {...boardProps({ active: true, workflowControlsInHeader: true })} />);
    expect(slot.querySelector(".board-workflow-toolbar")).not.toBeNull();
    expect(container.querySelector(".board-workflow-view > .board-workflow-toolbar")).toBeNull();
    expect(document.querySelectorAll(".board-workflow-toolbar")).toHaveLength(1);
  });

  it("adopte un slot remplacé pendant l'inactivité dès la réactivation", async () => {
    const first = createHeaderSlot();
    const { container, rerender } = render(<Board {...boardProps({ active: true, workflowControlsInHeader: true })} />);
    await waitFor(() => expect(first.querySelector(".board-workflow-toolbar")).not.toBeNull());

    rerender(<Board {...boardProps({ active: false, workflowControlsInHeader: true })} />);
    await waitFor(() => expect(first).toBeEmptyDOMElement());
    first.remove();
    const second = createHeaderSlot();

    rerender(<Board {...boardProps({ active: true, workflowControlsInHeader: true })} />);
    expect(second.querySelector(".board-workflow-toolbar")).not.toBeNull();
    expect(container.querySelector(".board-workflow-view > .board-workflow-toolbar")).toBeNull();
    expect(document.querySelectorAll(".board-workflow-toolbar")).toHaveLength(1);
  });

  it("keeps its toolbar inline while inactive without a header relocation target", async () => {
    const slot = createHeaderSlot();
    const { container } = render(<Board {...boardProps({ active: false, workflowControlsInHeader: false })} />);

    await waitFor(() => expect(container.querySelector(".board-workflow-toolbar")).not.toBeNull());
    expect(slot).toBeEmptyDOMElement();
  });
});
