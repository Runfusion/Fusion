import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readAppFile } from "../../test/cssFixture";
import { ListView } from "../ListView";

const workflows = [
  {
    id: "builtin:coding-ideas-v2",
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
  FN-384 replaced the old "a short release creates nothing" rule with "a short release is an ordinary Save", and this
  test still encoded the superseded contract. The 500ms start boundary itself is covered by the QuickEntryBox suite
  ("starts exactly once at the 500ms %s boundary", "runs hold-to-Start from the collapsed List host"); what belongs
  here is that the production List host mounts the shared Alpha composer and honours that gesture contract.
  */
  it("runs the production mobile List Quick Entry as the shared Alpha composer", async () => {
    const restoreViewport = mockViewport("mobile");
    vi.useFakeTimers();
    const onQuickCreate = vi.fn().mockResolvedValue(undefined);
    const onMoveTask = vi.fn().mockResolvedValue({});
    const view = render(<ListView {...listProps({ onQuickCreate, onMoveTask })} />);

    try {
      const composer = screen.getByTestId("quick-entry-box");
      const save = screen.getByTestId("quick-entry-save");
      expect(window.innerWidth).toBe(375);
      expect(composer.closest('[data-alpha-surface="true"]')).not.toBeNull();
      expect(save).toHaveClass("btn-icon", "quick-entry-alpha-save");
      expect(save).toHaveAccessibleName("Save task; hold to start");
      expect(save).toHaveStyle({ "--quick-entry-alpha-hold-duration": "500ms" });
      expect(screen.queryByTestId("quick-entry-save-start")).toBeNull();

      fireEvent.change(screen.getByTestId("quick-entry-input"), { target: { value: "List Alpha task" } });
      fireEvent.pointerDown(save, { pointerId: 31, pointerType: "mouse", button: 0, isPrimary: true });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(499);
      });
      fireEvent.pointerUp(save, { pointerId: 31, pointerType: "mouse" });
      fireEvent.click(save);
      await act(async () => Promise.resolve());

      // FN-384: a release before the 500ms threshold is an ordinary Save, not a no-op.
      expect(onQuickCreate).toHaveBeenCalledTimes(1);
      expect(onQuickCreate).toHaveBeenCalledWith(expect.objectContaining({ description: "List Alpha task" }));
      expect(onMoveTask).not.toHaveBeenCalled();
      expect(screen.getByTestId("quick-entry-input")).toHaveValue("");
    } finally {
      view.unmount();
      vi.clearAllTimers();
      restoreViewport();
    }
  });

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
});
