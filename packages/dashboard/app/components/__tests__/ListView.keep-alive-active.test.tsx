import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { readAppFile } from "../../test/cssFixture";
import { ListView } from "../ListView";

const workflows = [
  { id: "builtin:coding", name: "Coding", columns: [{ id: "triage", name: "Triage", flags: { intake: true } }] },
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

  it("guards portal selection during render, before the inactive effect can clear a cached slot", () => {
    const source = readAppFile("components/ListView.tsx");
    expect(source).toContain("return active && workflowControlsInHeader && headerWorkflowSlot");
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
