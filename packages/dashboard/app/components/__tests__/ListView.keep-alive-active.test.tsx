import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readAppFile } from "../../test/cssFixture";
import { ListView } from "../ListView";

const workflows = [
  {
    id: "builtin:coding-ideas",
    name: "Coding (Ideas)",
    columns: [
      { id: "ideas", name: "Ideas", flags: { hold: true } },
      { id: "todo", name: "Todo", flags: {} },
      { id: "done", name: "Done", flags: { complete: true } },
    ],
  },
  { id: "wf-custom", name: "Custom", columns: [{ id: "backlog", name: "Backlog", flags: { intake: true } }] },
];

vi.mock("../../hooks/useBoardWorkflows", () => ({
  useBoardWorkflows: () => ({
    boardWorkflows: { defaultWorkflowId: workflows[0].id, workflows, taskWorkflowIds: {} },
    workflowMode: true,
    workflowOptions: workflows,
    selectedWorkflow: workflows[0],
    selectedWorkflowId: workflows[0].id,
    isAllWorkflowsSelected: false,
    setSelectedWorkflowId: vi.fn(),
    refreshBoardWorkflows: vi.fn(),
    setBoardWorkflowsState: vi.fn(),
  }),
}));

vi.mock("../../api", () => ({
  batchUpdateTaskModels: vi.fn(),
  fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] }),
  fetchSettings: vi.fn().mockResolvedValue({}),
  fetchGlobalSettings: vi.fn().mockResolvedValue({}),
  fetchNodes: vi.fn().mockResolvedValue([]),
  fetchWorkflowOptionalSteps: vi.fn().mockResolvedValue([]),
  fetchTaskDetail: vi.fn(),
  checkDuplicateTasks: vi.fn().mockResolvedValue([]),
  fetchAgents: vi.fn().mockResolvedValue([]),
  uploadAttachment: vi.fn().mockResolvedValue({}),
  updateGlobalSettings: vi.fn().mockResolvedValue({}),
  refreshPrStatus: vi.fn(),
  updateTask: vi.fn(),
}));

function listProps(overrides: Partial<React.ComponentProps<typeof ListView>> = {}) {
  return {
    tasks: [],
    onMoveTask: vi.fn(async () => ({})),
    onDeleteTask: vi.fn(async () => ({})),
    onMergeTask: vi.fn(async () => ({ merged: false })),
    onOpenDetail: vi.fn(),
    addToast: vi.fn(),
    ...overrides,
  } as React.ComponentProps<typeof ListView>;
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

describe("ListView active keep-alive gate", () => {
  beforeEach(() => {
    localStorage.clear();
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
    vi.useRealTimers();
    vi.restoreAllMocks();
    localStorage.clear();
    document.getElementById("header-workflow-slot")?.remove();
  });

  it("guards portal selection during render, before the inactive effect can clear a cached slot", () => {
    const source = readAppFile("components/ListView.tsx");
    expect(source).toContain("return active && workflowControlsInHeader && headerWorkflowSlot");
  });

  /*
  List no longer mounts a Quick Entry of its own, so the host-level composer case is deleted with the affordance.
  The Alpha gesture contract itself stays covered by the QuickEntryBox suite, which mounts the real composer.
  */

  it.each(["desktop", "mobile"] as const)("releases the header workflow slot while inactive on %s", async (mode) => {
    const restoreViewport = mockViewport(mode);
    const slot = createHeaderSlot();
    try {
      const { rerender } = render(<ListView {...listProps({ active: true, workflowControlsInHeader: true })} />);
      await waitFor(() => expect(slot.querySelector(".list-workflow-control")).not.toBeNull());

      rerender(<ListView {...listProps({ active: false, workflowControlsInHeader: true })} />);
      await waitFor(() => expect(slot).toBeEmptyDOMElement());
    } finally {
      restoreViewport();
    }
  });

  /*
  FNXC:WorkflowControls 2026-09-15-01:44:
  FN-405: an inactive List must release the shared slot, but a List that becomes active again must
  RECLAIM it. The shared resolver re-resolves on re-enable, so the round trip must end with the control
  back in the header and no residual inline copy.
  */
  it("reclaims the header workflow slot when it becomes active again", async () => {
    const slot = createHeaderSlot();
    const { container, rerender } = render(<ListView {...listProps({ active: true, workflowControlsInHeader: true })} />);
    await waitFor(() => expect(slot.querySelector(".list-workflow-control")).not.toBeNull());

    rerender(<ListView {...listProps({ active: false, workflowControlsInHeader: true })} />);
    await waitFor(() => expect(slot).toBeEmptyDOMElement());

    rerender(<ListView {...listProps({ active: true, workflowControlsInHeader: true })} />);
    await waitFor(() => expect(slot.querySelector(".list-workflow-control")).not.toBeNull());
    expect(container.querySelector(".list-workflow-control")).toBeNull();
    expect(document.querySelectorAll(".list-workflow-control")).toHaveLength(1);
  });

  /*
  FNXC:BoardNavigation 2026-09-18-02:12:
  FN-522 — même contrat de réactivation que le Board : la reprise appartient au commit, pas à un effet ultérieur,
  sinon la vue conservée peint un contrôle hors du Header et déplace sa propre disposition.
  */
  it("reprend le slot dès le commit de réactivation, y compris après remplacement du nœud", async () => {
    const first = createHeaderSlot();
    const { container, rerender } = render(<ListView {...listProps({ active: true, workflowControlsInHeader: true })} />);
    await waitFor(() => expect(first.querySelector(".list-workflow-control")).not.toBeNull());

    rerender(<ListView {...listProps({ active: false, workflowControlsInHeader: true })} />);
    await waitFor(() => expect(first).toBeEmptyDOMElement());
    first.remove();
    const second = createHeaderSlot();

    rerender(<ListView {...listProps({ active: true, workflowControlsInHeader: true })} />);
    expect(second.querySelector(".list-workflow-control")).not.toBeNull();
    expect(container.querySelector(".list-workflow-control")).toBeNull();
    expect(document.querySelectorAll(".list-workflow-control")).toHaveLength(1);
  });
});
