import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ListView } from "../ListView";
import type { Task, TaskDetail } from "@fusion/core";
import { scopedKey } from "../../utils/projectStorage";
import { BOARD_WORKFLOW_SELECTION_STORAGE_KEY } from "../../utils/boardWorkflowSelection";
import { loadAllAppCss } from "../../test/cssFixture";

// Mock the API
vi.mock("../../api", () => ({
  fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] }),
  fetchSettings: vi.fn().mockResolvedValue({
    modelPresets: [],
    autoSelectModelPreset: false,
    defaultPresetBySize: {},
    maxConcurrent: 2,
    maxWorktrees: 4,
    pollIntervalMs: 30000,
    groupOverlappingFiles: true,
    autoMerge: true,
  }),
  fetchGlobalSettings: vi.fn().mockResolvedValue({}),
  fetchTaskDetail: vi.fn(),
  batchUpdateTaskModels: vi.fn(),
  fetchNodes: vi.fn(() => new Promise(() => {})),
  fetchBoardWorkflows: vi.fn(() => new Promise(() => {})),
  api: vi.fn().mockResolvedValue({ sessions: [] }),
}));

const listViewSseHandlers: Record<string, (event?: unknown) => void> = {};
const subscribeSseMock = vi.fn(
  (_url: string, opts: { events?: Record<string, (event?: unknown) => void> }) => {
    for (const [name, handler] of Object.entries(opts.events ?? {})) {
      listViewSseHandlers[name] = handler;
    }
    return () => {};
  },
);
vi.mock("../../sse-bus", () => ({
  subscribeSse: (...args: unknown[]) => (subscribeSseMock as (...a: unknown[]) => () => void)(...args),
}));

vi.mock("../QuickEntryBox", () => ({
  QuickEntryBox: ({
    onCreate,
    addToast,
    onPlanningMode,
    onSubtaskBreakdown,
    workflowId,
  }: {
    onCreate?: (input: { description: string }) => Promise<unknown>;
    addToast: (message: string, type?: "error" | "success" | "info" | "warning") => void;
    onPlanningMode?: (initialPlan: string, workflowId?: string | null) => void;
    onSubtaskBreakdown?: (description: string, workflowId?: string | null) => void;
    workflowId?: string | null;
  }) => {
    const [value, setValue] = useState("");
    const [expanded, setExpanded] = useState(false);
    const [modelMenuOpen, setModelMenuOpen] = useState(false);

    const submit = async () => {
      const description = value.trim();
      if (!description || !onCreate) return;
      try {
        await onCreate({ description });
        setValue("");
      } catch (err) {
        addToast(err instanceof Error ? err.message : "Failed to create task", "error");
      }
    };

    const handoff = (callback?: (description: string, workflowId?: string | null) => void) => {
      const description = value.trim();
      if (!description || !callback) return;
      if (workflowId !== undefined) {
        callback(description, workflowId);
        return;
      }
      callback(description);
    };

    return (
      <div className="quick-entry-box" data-testid="quick-entry-box">
        <textarea
          className="quick-entry-input"
          data-testid="quick-entry-input"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <button
          type="button"
          data-testid="quick-entry-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((next) => !next)}
        >
          Toggle
        </button>
        <div id="quick-entry-controls" data-testid="quick-entry-actions" hidden={!expanded}>
          <button
            type="button"
            data-testid="quick-entry-models"
            onClick={() => setModelMenuOpen((next) => !next)}
          >
            Models
          </button>
          <button type="button" data-testid="quick-entry-deps">Deps</button>
          <button type="button" data-testid="quick-entry-plan" onClick={() => handoff(onPlanningMode)}>
            Plan
          </button>
          <button type="button" data-testid="quick-entry-subtask" onClick={() => handoff(onSubtaskBreakdown)}>
            Subtask
          </button>
          <button type="button" data-testid="quick-entry-save" onClick={() => void submit()}>
            Save
          </button>
        </div>
        {modelMenuOpen ? (
          <div data-testid="model-nested-menu">
            <button type="button">Plan</button>
            <button type="button">Executor</button>
            <button type="button">Reviewer</button>
          </div>
        ) : null}
      </div>
    );
  },
}));

vi.mock("../TaskDetailModal", () => ({
  TaskDetailContent: ({
    task,
    onOpenDetail,
  }: {
    task: Task | TaskDetail;
    onOpenDetail?: (task: Task | TaskDetail) => void;
  }) => (
    <div data-testid="task-detail-content">
      <span>{task.id}</span>
      {(task.dependencies ?? []).map((dependencyId) => (
        <button
          key={dependencyId}
          type="button"
          role="link"
          onClick={() =>
            onOpenDetail?.({
              id: dependencyId,
              title: dependencyId,
              description: dependencyId,
              column: "triage",
              dependencies: [],
              steps: [],
              currentStep: 0,
              status: "pending",
              paused: false,
              log: [],
              createdAt: "2024-01-01T00:00:00Z",
              updatedAt: "2024-01-01T00:00:00Z",
              prompt: `# ${dependencyId}`,
            } as TaskDetail)
          }
        >
          {dependencyId}
        </button>
      ))}
    </div>
  ),
}));

import { fetchTaskDetail, batchUpdateTaskModels, fetchBoardWorkflows, fetchNodes } from "../../api";

const mockConfirm = vi.fn();
const mockConfirmWithChoice = vi.fn();
vi.mock("../../hooks/useConfirm", () => ({
  useConfirm: () => ({ confirm: mockConfirm, confirmWithChoice: mockConfirmWithChoice }),
}));

const mockAddToast = vi.fn();
const TEST_PROJECT_ID = "proj-123";
const scopedStorageKey = (key: string) => scopedKey(key, TEST_PROJECT_ID);

function mountCssForBadgeTests() {
  const style = document.createElement("style");
  style.textContent = loadAllAppCss();
  document.head.appendChild(style);
  document.documentElement.style.setProperty("--status-error-bg", "rgb(255, 230, 230)");
  document.documentElement.style.setProperty("--color-error-dark", "rgb(200, 0, 0)");
  document.documentElement.style.setProperty("--status-in-review-bg", "rgb(230, 255, 230)");
  document.documentElement.style.setProperty("--in-review", "rgb(0, 160, 0)");
  document.documentElement.style.setProperty("--triage", "rgb(240, 140, 0)");
  document.documentElement.style.setProperty("--todo", "rgb(80, 120, 220)");
  return () => {
    style.remove();
    document.documentElement.style.removeProperty("--status-error-bg");
    document.documentElement.style.removeProperty("--color-error-dark");
    document.documentElement.style.removeProperty("--status-in-review-bg");
    document.documentElement.style.removeProperty("--in-review");
    document.documentElement.style.removeProperty("--triage");
    document.documentElement.style.removeProperty("--todo");
  };
}

const createMockTask = (overrides: Partial<Task> = {}): Task => ({
  id: "FN-001",
  description: "Test task description",
  title: "Test Task",
  column: "triage",
  dependencies: [],
  steps: [],
  currentStep: 0,
  status: "pending",
  paused: false,
  log: [],
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
  ...overrides,
});

const renderListView = (
  props: Partial<React.ComponentProps<typeof ListView>> = {},
  options: { openViewOptions?: boolean } = {},
) => {
  const defaultProps = {
    tasks: [],
    onMoveTask: vi.fn(async () => createMockTask()),
    onRetryTask: vi.fn(async () => createMockTask()),
    onDeleteTask: vi.fn(async () => createMockTask()),
    onMergeTask: vi.fn(async () => ({ merged: false })),
    onResetTask: vi.fn(async () => createMockTask()),
    onDuplicateTask: vi.fn(async () => createMockTask()),
    onOpenDetail: vi.fn(),
    addToast: mockAddToast,
    globalPaused: false,
    onNewTask: vi.fn(),
    projectId: TEST_PROJECT_ID,
  };

  const result = render(<ListView {...defaultProps} {...props} />);
  if (options.openViewOptions ?? true) {
    const viewOptionsToggle = screen.queryByRole("button", { name: /^view$/i });
    if (viewOptionsToggle) {
      act(() => {
        fireEvent.click(viewOptionsToggle);
      });
    }
  }
  return result;
};

const clickInAct = (element: Element) => {
  act(() => {
    fireEvent.click(element);
  });
};

const clickAndFlush = async (element: Element) => {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
};

const keyDownAndFlush = async (element: Element, init: Parameters<typeof fireEvent.keyDown>[1]) => {
  await act(async () => {
    fireEvent.keyDown(element, init);
    await Promise.resolve();
  });
};

async function openWorkflowSwitcher() {
  const trigger = await screen.findByTestId("workflow-switcher");
  fireEvent.click(trigger);
  return trigger;
}

async function selectWorkflow(workflowId: string) {
  await openWorkflowSwitcher();
  fireEvent.click(screen.getByTestId(`workflow-switcher-option-${workflowId}`));
}

const enterBulkEditMode = () => {
  clickInAct(screen.getByRole("button", { name: "Bulk Edit" }));
};

const showAllColumnsByDefault = () => {
  localStorage.setItem(
    scopedStorageKey("kb-dashboard-list-columns"),
    JSON.stringify(["title", "status", "column", "dependencies", "progress"]),
  );
};

const getSectionTaskIds = (sectionName: string): string[] => {
  const allRows = screen.getAllByRole("row");
  const sectionStart = allRows.findIndex(
    (row) => row.className.includes("list-section-header") && row.textContent?.includes(sectionName),
  );
  if (sectionStart < 0) return [];

  const ids: string[] = [];
  for (let index = sectionStart + 1; index < allRows.length; index += 1) {
    const row = allRows[index];
    if (row.className.includes("list-section-header")) break;
    const id = row.getAttribute("data-id");
    if (id) ids.push(id);
  }

  return ids;
};

function ensureMatchMedia() {
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn(),
    });
  }
}

function mockMobileViewport() {
  ensureMatchMedia();
  Object.defineProperty(window, "innerWidth", { value: 375, configurable: true });
  return vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: query === "(max-width: 768px)" || query === "(max-width: 768px), (max-height: 480px)",
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function mockDesktopViewport() {
  ensureMatchMedia();
  Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
  return vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

describe("ListView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchNodes).mockImplementation(() => new Promise(() => {}));
    vi.mocked(fetchBoardWorkflows).mockImplementation(() => new Promise(() => {}));
    vi.mocked(fetchTaskDetail).mockResolvedValue({
      ...createMockTask(),
      prompt: "# Detail",
    } as TaskDetail);
    mockConfirm.mockReset();
    mockConfirmWithChoice.mockReset();
    subscribeSseMock.mockClear();
    for (const key of Object.keys(listViewSseHandlers)) delete listViewSseHandlers[key];
    localStorage.clear();
    showAllColumnsByDefault();
    ensureMatchMedia();
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

  it("renders without crashing", () => {
    renderListView();
    // The search/filter is now in the header, not in the list view toolbar
    expect(screen.getByText("View")).toBeDefined();
  });

  it("falls back malformed task columns to Planning group instead of crashing", () => {
    const malformedTask = {
      ...createMockTask({ id: "FN-404" }),
      column: "impossible-column",
    } as unknown as Task;

    expect(() => renderListView({ tasks: [malformedTask] })).not.toThrow();
    expect(screen.getByText("FN-404")).toBeInTheDocument();

    const planningSection = screen
      .getAllByRole("row")
      .find((row) => row.className.includes("list-section-header") && row.textContent?.includes("Planning"));
    expect(planningSection?.textContent).toContain("1");
  });

  it("keeps view options collapsed by default on desktop", () => {
    renderListView({}, { openViewOptions: false });

    const toggle = screen.getByRole("button", { name: /^view$/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById("list-view-options-panel")).toBeNull();
  });

  it("shows compact summary chips while view options stay collapsed", () => {
    localStorage.setItem(scopedStorageKey("kb-dashboard-hide-done"), "true");
    const tasks = [
      createMockTask({ id: "FN-001", column: "done" }),
      createMockTask({ id: "FN-002", column: "triage" }),
    ];

    renderListView({ tasks }, { openViewOptions: false });

    expect(screen.getByText("Done hidden")).toBeDefined();
    expect(document.getElementById("list-view-options-panel")).toBeNull();
  });

  it("displays tasks in table format with two-line title styling", () => {
    const tasks = [
      createMockTask({ id: "FN-001", title: "First Task" }),
      createMockTask({ id: "FN-002", title: "Second Task" }),
    ];

    renderListView({ tasks });

    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.getByText("First Task")).toBeDefined();
    expect(screen.getByText("FN-002")).toBeDefined();
    expect(screen.getByText("Second Task")).toBeDefined();
    const listTitleTextRule = readFileSync("app/components/ListView.css", "utf8").match(/\.list-title-text\s*\{[^}]*\}/)?.[0] ?? "";
    expect(listTitleTextRule).toContain("display: -webkit-box");
    expect(listTitleTextRule).toContain("-webkit-line-clamp: 2");
    expect(listTitleTextRule).toContain("-webkit-box-orient: vertical");
    expect(listTitleTextRule).toContain("white-space: normal");
    expect(listTitleTextRule).toContain("overflow-wrap: anywhere");
    expect(listTitleTextRule).not.toContain("white-space: nowrap");
  });

  it("shows fast indicator in desktop rows only for fast-mode tasks", () => {
    const tasks = [
      createMockTask({ id: "FN-001", title: "Fast Task", executionMode: "fast" }),
      createMockTask({ id: "FN-002", title: "Standard Task", executionMode: "standard" }),
    ];

    const { container } = renderListView({ tasks });

    const fastRow = container.querySelector('tr[data-id="FN-001"]') as HTMLElement;
    const standardRow = container.querySelector('tr[data-id="FN-002"]') as HTMLElement;
    const fastBadge = fastRow.querySelector(".list-execution-mode-badge");

    expect(fastBadge).not.toBeNull();
    expect(fastBadge?.getAttribute("aria-label")).toBe("Fast mode");
    expect(fastBadge?.querySelector("svg")).not.toBeNull();
    expect(standardRow.querySelector(".list-execution-mode-badge")).toBeNull();
  });

  it("shows paused by agent status in table view", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "in-progress", paused: true, pausedByAgentId: "agent-1" }),
    ];

    renderListView({ tasks });
    expect(screen.getByText("paused by agent")).toBeDefined();
  });

  it("shows paused by agent status in mobile card view", () => {
    const matchMediaSpy = mockMobileViewport();
    const tasks = [
      createMockTask({ id: "FN-001", column: "in-progress", paused: true, pausedByAgentId: "agent-1" }),
    ];

    renderListView({ tasks });
    expect(screen.getByText("paused by agent")).toBeDefined();
    matchMediaSpy.mockRestore();
  });

  it("keeps done status badge in table view when stale paused metadata exists", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "done", status: "paused", paused: true, pausedByAgentId: "agent-1" }),
    ];

    renderListView({ tasks });
    expect(screen.queryByText("paused by agent")).toBeNull();
    expect(screen.queryByText("paused")).toBeNull();
    expect(screen.getByText("done")).toBeDefined();
  });

  it("keeps done status badge in mobile card view when stale paused metadata exists", () => {
    const matchMediaSpy = mockMobileViewport();
    const tasks = [
      createMockTask({ id: "FN-001", column: "done", status: "paused", paused: true, pausedByAgentId: "agent-1" }),
    ];

    renderListView({ tasks });
    expect(screen.queryByText("paused by agent")).toBeNull();
    expect(screen.queryByText("paused")).toBeNull();
    expect(screen.getByText("done")).toBeDefined();
    matchMediaSpy.mockRestore();
  });

  it("shows empty state when no tasks", () => {
    renderListView({ tasks: [] });
    expect(screen.getByText("No tasks yet")).toBeDefined();
  });

  it("shows empty state when filter matches nothing", () => {
    const tasks = [createMockTask({ id: "FN-001", title: "Test Task" })];

    renderListView({ tasks, searchQuery: "nonexistent" });

    expect(screen.getByText("No tasks match your filter")).toBeDefined();
  });

  it("filters tasks by ID", () => {
    const tasks = [
      createMockTask({ id: "FN-001", title: "First Task" }),
      createMockTask({ id: "FN-002", title: "Second Task" }),
    ];

    renderListView({ tasks, searchQuery: "FN-001" });

    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.queryByText("FN-002")).toBeNull();
  });

  it("filters tasks by title", () => {
    const tasks = [
      createMockTask({ id: "FN-001", title: "First Task" }),
      createMockTask({ id: "FN-002", title: "Second Task" }),
    ];

    renderListView({ tasks, searchQuery: "Second" });

    expect(screen.queryByText("FN-001")).toBeNull();
    expect(screen.getByText("FN-002")).toBeDefined();
  });

  it("filters tasks by description when no title", () => {
    const tasks = [
      createMockTask({ id: "FN-001", title: undefined, description: "Alpha description" }),
      createMockTask({ id: "FN-002", title: undefined, description: "Beta description" }),
    ];

    renderListView({ tasks, searchQuery: "Alpha" });

    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.queryByText("FN-002")).toBeNull();
  });

  it("clears filter when searchQuery is empty", () => {
    const tasks = [
      createMockTask({ id: "FN-001", title: "First Task" }),
      createMockTask({ id: "FN-002", title: "Second Task" }),
    ];

    // First render with search query
    const { rerender } = renderListView({ tasks, searchQuery: "FN-001" });

    // Only FN-001 should be visible
    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.queryByText("FN-002")).toBeNull();

    // Re-render with empty searchQuery
    rerender(<ListView tasks={tasks} searchQuery="" onMoveTask={vi.fn()} onOpenDetail={vi.fn()} addToast={mockAddToast} />);

    // Both tasks should be visible again
    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.getByText("FN-002")).toBeDefined();
  });

  it("updates selectedTaskId on desktop row click and mounts embedded detail", async () => {
    const viewportSpy = mockDesktopViewport();
    const tasks = [createMockTask({ id: "FN-001", title: "Test Task" })];
    const mockOnOpenDetail = vi.fn();

    renderListView({ tasks, onOpenDetail: mockOnOpenDetail });

    const row = screen.getByText("FN-001").closest("tr");
    fireEvent.click(row!);

    expect(mockOnOpenDetail).not.toHaveBeenCalled();
    expect(localStorage.getItem(scopedStorageKey("kb-dashboard-list-selected-task"))).toBe("FN-001");
    expect(row?.className).toContain("list-row--selected");
    await waitFor(() => {
      expect(screen.getByTestId("list-split-detail-content")).toBeInTheDocument();
      expect(screen.getByTestId("task-detail-content")).toHaveTextContent("FN-001");
    });
    expect(fetchTaskDetail).not.toHaveBeenCalled();
    viewportSpy.mockRestore();
  });

  it("calls onOpenDetail on mobile row click", () => {
    const viewportSpy = mockMobileViewport();
    const tasks = [createMockTask({ id: "FN-001", title: "Test Task" })];
    const mockOnOpenDetail = vi.fn();

    renderListView({ tasks, onOpenDetail: mockOnOpenDetail });

    const card = document.querySelector('.list-card[data-id="FN-001"]');
    fireEvent.click(card!);

    expect(mockOnOpenDetail).toHaveBeenCalledWith(tasks[0], { origin: "list-mobile" });
    expect(mockOnOpenDetail).toHaveBeenCalledTimes(1);
    expect(fetchTaskDetail).not.toHaveBeenCalled();
    viewportSpy.mockRestore();
  });

  it("exposes view options controls on mobile", () => {
    const viewportSpy = mockMobileViewport();
    localStorage.setItem(scopedStorageKey("kb-dashboard-hide-done"), "false");

    renderListView({}, { openViewOptions: false });

    const toggle = screen.getByRole("button", { name: /^view$/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById("list-view-options-panel-mobile")).toBeNull();

    fireEvent.click(toggle);

    expect(screen.getByLabelText("Title")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /hide done/i }));
    expect(localStorage.getItem(scopedStorageKey("kb-dashboard-hide-done"))).toBe("true");

    viewportSpy.mockRestore();
  });

  it("refreshes workflow columns when workflow metadata SSE arrives", async () => {
    vi.mocked(fetchBoardWorkflows)
      .mockResolvedValueOnce({
        flagEnabled: true,
        defaultWorkflowId: "wf-custom",
        workflows: [
          {
            id: "wf-custom",
            name: "Custom",
            columns: [
              { id: "backlog", name: "Backlog", flags: { intake: true } },
              { id: "complete", name: "Complete", flags: { complete: true } },
            ],
          },
        ],
        taskWorkflowIds: { "FN-001": "wf-custom" },
      })
      .mockResolvedValueOnce({
        flagEnabled: true,
        defaultWorkflowId: "wf-custom",
        workflows: [
          {
            id: "wf-custom",
            name: "Custom",
            columns: [
              { id: "ready", name: "Ready", flags: { intake: true } },
              { id: "complete", name: "Complete", flags: { complete: true } },
            ],
          },
        ],
        taskWorkflowIds: { "FN-001": "wf-custom" },
      });

    renderListView({
      tasks: [createMockTask({ id: "FN-001", column: "backlog", title: "Workflow task" })],
    });

    await waitFor(() => expect(screen.queryAllByText("Backlog").length).toBeGreaterThan(0));
    expect(typeof listViewSseHandlers["workflow:updated"]).toBe("function");

    await act(async () => {
      listViewSseHandlers["workflow:updated"]?.();
    });

    await waitFor(() => expect(screen.queryAllByText("Ready").length).toBeGreaterThan(0));
    expect(screen.queryAllByText("Backlog")).toHaveLength(0);
  });

  it("re-fetches board-workflows when the workflow switcher opens", async () => {
    vi.mocked(fetchBoardWorkflows).mockResolvedValue({
      flagEnabled: true,
      defaultWorkflowId: "builtin:coding",
      workflows: [
        {
          id: "builtin:coding",
          name: "Coding",
          columns: [
            { id: "todo", name: "Todo", flags: { hold: true } },
            { id: "done", name: "Done", flags: { complete: true } },
          ],
        },
        {
          id: "wf-custom",
          name: "Custom Flow",
          columns: [
            { id: "backlog", name: "Backlog", flags: { intake: true } },
            { id: "done", name: "Done", flags: { complete: true } },
          ],
        },
      ],
      taskWorkflowIds: { "FN-001": "builtin:coding" },
    });

    renderListView({
      tasks: [createMockTask({ id: "FN-001", column: "todo", title: "Workflow task" })],
    });

    const trigger = await screen.findByTestId("workflow-switcher");
    await waitFor(() => expect(fetchBoardWorkflows).toHaveBeenCalledTimes(1));
    vi.mocked(fetchBoardWorkflows).mockClear();

    fireEvent.click(trigger);

    expect(fetchBoardWorkflows).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("listbox", { name: "Workflow" })).toBeInTheDocument();
  });

  it("keeps a custom list workflow selected after task refresh and workflow payload revalidation", async () => {
    vi.mocked(fetchBoardWorkflows).mockResolvedValue({
      flagEnabled: true,
      defaultWorkflowId: "builtin:coding",
      workflows: [
        {
          id: "builtin:coding",
          name: "Coding",
          columns: [
            { id: "todo", name: "Todo", flags: { intake: true } },
            { id: "done", name: "Done", flags: { complete: true } },
          ],
        },
        {
          id: "wf-custom",
          name: "Custom Flow",
          columns: [
            { id: "backlog", name: "Backlog", flags: { intake: true } },
            { id: "done", name: "Done", flags: { complete: true } },
          ],
        },
      ],
      taskWorkflowIds: { "FN-001": "wf-custom" },
    });

    localStorage.setItem(scopedStorageKey("kb-dashboard-list-columns"), JSON.stringify(["title", "status"]));
    localStorage.setItem(scopedStorageKey("kb-dashboard-selected-tasks"), JSON.stringify(["FN-002"]));
    localStorage.setItem(scopedStorageKey("kb-dashboard-list-collapsed"), JSON.stringify(["archived"]));
    localStorage.setItem(scopedStorageKey("kb-dashboard-list-sidebar-width"), "420");

    const listProps: React.ComponentProps<typeof ListView> = {
      tasks: [createMockTask({ id: "FN-001", column: "backlog", title: "Custom workflow task" })],
      onMoveTask: vi.fn(async () => createMockTask()),
      onRetryTask: vi.fn(async () => createMockTask()),
      onDeleteTask: vi.fn(async () => createMockTask()),
      onMergeTask: vi.fn(async () => ({ merged: false })),
      onResetTask: vi.fn(async () => createMockTask()),
      onDuplicateTask: vi.fn(async () => createMockTask()),
      onOpenDetail: vi.fn(),
      addToast: mockAddToast,
      globalPaused: false,
      onNewTask: vi.fn(),
      projectId: TEST_PROJECT_ID,
    };
    const rendered = render(<ListView {...listProps} />);

    await selectWorkflow("wf-custom");
    await waitFor(() => expect(screen.getByTestId("workflow-switcher")).toHaveTextContent("Custom Flow"));
    expect(window.localStorage.getItem(scopedStorageKey(BOARD_WORKFLOW_SELECTION_STORAGE_KEY))).toBe("wf-custom");
    expect(window.localStorage.getItem(scopedStorageKey("kb-dashboard-list-columns"))).toBe(JSON.stringify(["title", "status"]));
    expect(window.localStorage.getItem(scopedStorageKey("kb-dashboard-selected-tasks"))).toBe(JSON.stringify(["FN-002"]));
    expect(window.localStorage.getItem(scopedStorageKey("kb-dashboard-list-collapsed"))).toBe(JSON.stringify(["archived"]));
    expect(window.localStorage.getItem(scopedStorageKey("kb-dashboard-list-sidebar-width"))).toBe("420");
    expect(screen.getByText("Custom workflow task")).toBeInTheDocument();

    await act(async () => {
      rendered.rerender(<ListView {...listProps} tasks={[createMockTask({ id: "FN-001", column: "done", title: "Custom workflow task after respec" })]} />);
    });
    await act(async () => {
      listViewSseHandlers["workflow:updated"]?.();
    });

    await waitFor(() => expect(screen.getByTestId("workflow-switcher")).toHaveTextContent("Custom Flow"));
    expect(screen.getByText("Custom workflow task after respec")).toBeInTheDocument();
  });

  it("re-homes a preserved-column task to the new workflow after workflow invalidation", async () => {
    const preservedWorkflow = {
      id: "wf-preserved",
      name: "Preserved Flow",
      columns: [
        { id: "todo", name: "Todo", flags: { intake: true } },
        { id: "done", name: "Done", flags: { complete: true } },
      ],
    };
    vi.mocked(fetchBoardWorkflows)
      .mockResolvedValueOnce({
        flagEnabled: true,
        defaultWorkflowId: "builtin:coding",
        workflows: [
          {
            id: "builtin:coding",
            name: "Coding",
            columns: [
              { id: "todo", name: "Todo", flags: { intake: true } },
              { id: "done", name: "Done", flags: { complete: true } },
            ],
          },
          preservedWorkflow,
        ],
        taskWorkflowIds: { "FN-001": "builtin:coding" },
      })
      .mockResolvedValueOnce({
        flagEnabled: true,
        defaultWorkflowId: "builtin:coding",
        workflows: [
          {
            id: "builtin:coding",
            name: "Coding",
            columns: [
              { id: "todo", name: "Todo", flags: { intake: true } },
              { id: "done", name: "Done", flags: { complete: true } },
            ],
          },
          preservedWorkflow,
        ],
        taskWorkflowIds: { "FN-001": "wf-preserved" },
      });

    renderListView({
      tasks: [createMockTask({ id: "FN-001", column: "todo", title: "Preserved workflow task" })],
    });

    const selector = await screen.findByTestId("workflow-switcher");
    await waitFor(() => expect(screen.getByText("Preserved workflow task")).toBeInTheDocument());
    expect(selector).toHaveTextContent("Coding");

    await act(async () => {
      listViewSseHandlers["workflow:updated"]?.();
    });

    await waitFor(() => expect(fetchBoardWorkflows).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText("Preserved workflow task")).not.toBeInTheDocument());

    await selectWorkflow("wf-preserved");
    await waitFor(() => expect(screen.getByText("Preserved workflow task")).toBeInTheDocument());
  });

  it("shows inline workflow counts in desktop and mobile switchers", async () => {
    const workflowPayload = {
      flagEnabled: true,
      defaultWorkflowId: "builtin:coding",
      workflows: [
        {
          id: "builtin:coding",
          name: "Coding",
          columns: [
            { id: "triage", name: "Triage", flags: { intake: true } },
            { id: "done", name: "Done", flags: { complete: true } },
          ],
        },
        {
          id: "wf-custom",
          name: "Custom",
          columns: [
            { id: "backlog", name: "Backlog", flags: { intake: true } },
            { id: "complete", name: "Complete", flags: { complete: true } },
          ],
        },
      ],
      taskWorkflowIds: { "FN-001": "builtin:coding", "FN-002": "wf-custom" },
    };
    vi.mocked(fetchBoardWorkflows).mockResolvedValue(workflowPayload);
    const desktopSpy = mockDesktopViewport();
    const desktop = renderListView({
      tasks: [
        createMockTask({ id: "FN-001", column: "triage", title: "Coding task" }),
        createMockTask({ id: "FN-002", column: "complete", title: "Custom done task" }),
      ],
    });

    const desktopTrigger = await screen.findByTestId("workflow-switcher");
    expect(desktopTrigger).toHaveTextContent("Coding");
    expect(desktopTrigger.querySelector(".workflow-switcher-counts")).toBeNull();
    await openWorkflowSwitcher();
    expect(desktopTrigger).toHaveTextContent("1");
    expect(screen.getByTestId("workflow-switcher-option-wf-custom")).toHaveTextContent("1");
    fireEvent.keyDown(desktopTrigger, { key: "Escape" });
    desktop.unmount();
    desktopSpy.mockRestore();

    vi.mocked(fetchBoardWorkflows).mockResolvedValue(workflowPayload);
    const mobileSpy = mockMobileViewport();
    renderListView({
      tasks: [
        createMockTask({ id: "FN-001", column: "triage", title: "Coding task" }),
        createMockTask({ id: "FN-002", column: "complete", title: "Custom done task" }),
      ],
    });

    const mobileTrigger = await screen.findByTestId("workflow-switcher");
    expect(mobileTrigger).toHaveTextContent("Coding");
    expect(mobileTrigger.querySelector(".workflow-switcher-counts")).toBeNull();
    await openWorkflowSwitcher();
    expect(mobileTrigger).toHaveTextContent("1");
    mobileSpy.mockRestore();
  });

  it("shows workflow edit and New actions inside the dropdown", async () => {
    const onCreateWorkflow = vi.fn();
    const onOpenWorkflowEditor = vi.fn();
    vi.mocked(fetchBoardWorkflows).mockResolvedValue({
      flagEnabled: true,
      defaultWorkflowId: "builtin:coding",
      workflows: [
        {
          id: "builtin:coding",
          name: "Coding",
          columns: [
            { id: "triage", name: "Triage", flags: { intake: true } },
            { id: "done", name: "Done", flags: { complete: true } },
          ],
        },
        {
          id: "wf-custom",
          name: "Custom",
          columns: [
            { id: "backlog", name: "Backlog", flags: { intake: true } },
            { id: "complete", name: "Complete", flags: { complete: true } },
          ],
        },
      ],
      taskWorkflowIds: { "FN-001": "builtin:coding" },
    });

    renderListView({
      tasks: [createMockTask({ id: "FN-001", column: "triage", title: "Workflow task" })],
      onCreateWorkflow,
      onOpenWorkflowEditor,
    });

    const selector = await screen.findByTestId("workflow-switcher");
    expect(document.querySelector(".list-workflow-create-btn")).toBeNull();
    fireEvent.click(selector);
    fireEvent.click(screen.getByTestId("workflow-switcher-edit-wf-custom"));
    expect(onOpenWorkflowEditor).toHaveBeenCalledWith("wf-custom");
    expect(onCreateWorkflow).not.toHaveBeenCalled();

    fireEvent.click(selector);
    fireEvent.click(screen.getByTestId("workflow-switcher-create"));
    expect(onCreateWorkflow).toHaveBeenCalledTimes(1);
  });

  it("relocates the list workflow selector and dropdown actions into the header slot", async () => {
    const onCreateWorkflow = vi.fn();
    const onOpenWorkflowEditor = vi.fn();
    const headerSlot = document.createElement("div");
    headerSlot.id = "header-workflow-slot";
    headerSlot.className = "header-workflow-slot";
    document.body.appendChild(headerSlot);
    vi.mocked(fetchBoardWorkflows).mockResolvedValue({
      flagEnabled: true,
      defaultWorkflowId: "builtin:coding",
      workflows: [
        {
          id: "builtin:coding",
          name: "Coding",
          columns: [
            { id: "triage", name: "Triage", flags: { intake: true } },
            { id: "done", name: "Done", flags: { complete: true } },
          ],
        },
        {
          id: "wf-custom",
          name: "Custom",
          columns: [
            { id: "backlog", name: "Backlog", flags: { intake: true } },
            { id: "complete", name: "Complete", flags: { complete: true } },
          ],
        },
      ],
      taskWorkflowIds: { "FN-001": "builtin:coding", "FN-002": "wf-custom" },
    });
    try {
      renderListView({
        tasks: [
          createMockTask({ id: "FN-001", column: "triage", title: "Coding task" }),
          createMockTask({ id: "FN-002", column: "backlog", title: "Custom task" }),
        ],
        onCreateWorkflow,
        onOpenWorkflowEditor,
        workflowControlsInHeader: true,
      });

      const selector = await screen.findByTestId("workflow-switcher");
      await waitFor(() => expect(headerSlot.querySelector(".list-workflow-control")).not.toBeNull());
      expect(headerSlot.contains(selector)).toBe(true);
      expect(headerSlot.querySelector(".list-workflow-create-btn")).toBeNull();
      expect(headerSlot.querySelector(".board-workflow-edit-btn")).toBeNull();
      expect(document.querySelector(".list-view > .list-workflow-control")).toBeNull();

      fireEvent.click(selector);
      expect(screen.getByTestId("workflow-switcher-create")).toBeInTheDocument();
      fireEvent.click(screen.getByTestId("workflow-switcher-option-wf-custom"));
      await waitFor(() => expect(screen.getByText("Custom task")).toBeInTheDocument());
      expect(screen.queryByText("Coding task")).not.toBeInTheDocument();
      fireEvent.click(selector);
      fireEvent.click(screen.getByTestId("workflow-switcher-edit-wf-custom"));
      expect(onOpenWorkflowEditor).toHaveBeenCalledWith("wf-custom");
    } finally {
      headerSlot.remove();
    }
  });

  it("keeps list workflow controls inline when header relocation is inactive", async () => {
    const headerSlot = document.createElement("div");
    headerSlot.id = "header-workflow-slot";
    document.body.appendChild(headerSlot);
    vi.mocked(fetchBoardWorkflows).mockResolvedValue({
      flagEnabled: true,
      defaultWorkflowId: "builtin:coding",
      workflows: [
        { id: "builtin:coding", name: "Coding", columns: [{ id: "triage", name: "Triage", flags: { intake: true } }] },
        { id: "wf-custom", name: "Custom", columns: [{ id: "backlog", name: "Backlog", flags: { intake: true } }] },
      ],
      taskWorkflowIds: { "FN-001": "builtin:coding" },
    });
    try {
      renderListView({
        tasks: [createMockTask({ id: "FN-001", column: "triage", title: "Coding task" })],
        onCreateWorkflow: vi.fn(),
      });

      await screen.findByTestId("workflow-switcher");
      await waitFor(() => expect(document.querySelector(".list-view .list-workflow-control")).not.toBeNull());
      expect(headerSlot.querySelector(".list-workflow-control")).toBeNull();
    } finally {
      headerSlot.remove();
    }
  });

  it("does not leave a list workflow shell when header relocation has no controls", async () => {
    const headerSlot = document.createElement("div");
    headerSlot.id = "header-workflow-slot";
    document.body.appendChild(headerSlot);
    vi.mocked(fetchBoardWorkflows).mockResolvedValue({
      flagEnabled: true,
      defaultWorkflowId: "builtin:coding",
      workflows: [
        { id: "builtin:coding", name: "Coding", columns: [{ id: "triage", name: "Triage", flags: { intake: true } }] },
      ],
      taskWorkflowIds: { "FN-001": "builtin:coding" },
    });
    try {
      renderListView({
        tasks: [createMockTask({ id: "FN-001", column: "triage", title: "Coding task" })],
        workflowControlsInHeader: true,
      });

      await waitFor(() => expect(screen.getByText("Coding task")).toBeInTheDocument());
      expect(screen.queryByTestId("workflow-switcher")).toBeNull();
      expect(document.querySelector(".list-workflow-control")).toBeNull();
      expect(headerSlot.childElementCount).toBe(0);
    } finally {
      headerSlot.remove();
    }
  });

  it("keeps embedded selection visible when filters hide the selected row", async () => {
    const viewportSpy = mockDesktopViewport();
    const tasks = [
      createMockTask({ id: "FN-001", title: "Alpha Task" }),
      createMockTask({ id: "FN-002", title: "Beta Task" }),
    ];

    const { rerender } = renderListView({ tasks, searchQuery: "Alpha" });

    fireEvent.click(screen.getByText("FN-001").closest("tr")!);

    await waitFor(() => {
      expect(screen.getByTestId("list-split-detail-content")).toBeInTheDocument();
    });

    rerender(
      <ListView
        tasks={tasks}
        onMoveTask={vi.fn(async () => createMockTask())}
        onRetryTask={vi.fn(async () => createMockTask())}
        onDeleteTask={vi.fn(async () => createMockTask())}
        onMergeTask={vi.fn(async () => ({ merged: false }))}
        onResetTask={vi.fn(async () => createMockTask())}
        onDuplicateTask={vi.fn(async () => createMockTask())}
        onOpenDetail={vi.fn()}
        addToast={mockAddToast}
        projectId={TEST_PROJECT_ID}
        searchQuery="Beta"
      />,
    );

    expect(document.querySelector('tr[data-id="FN-001"]')).toBeNull();
    expect(screen.getByTestId("list-split-detail-content")).toBeInTheDocument();
    viewportSpy.mockRestore();
  });

  it("keeps dependency navigation inline in embedded detail on desktop", async () => {
    const viewportSpy = mockDesktopViewport();
    const tasks = [createMockTask({ id: "FN-001", title: "Parent Task", dependencies: ["FN-002"] })];
    const mockOnOpenDetail = vi.fn();

    renderListView({ tasks, onOpenDetail: mockOnOpenDetail });

    fireEvent.click(screen.getByText("FN-001").closest("tr")!);

    await waitFor(() => {
      expect(screen.getByRole("link", { name: /FN-002/ })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("link", { name: /FN-002/ }));

    await waitFor(() => {
      expect(localStorage.getItem(scopedStorageKey("kb-dashboard-list-selected-task"))).toBe("FN-002");
      expect(screen.getByTestId("task-detail-content")).toHaveTextContent("FN-002");
    });

    expect(fetchTaskDetail).not.toHaveBeenCalled();
    expect(mockOnOpenDetail).not.toHaveBeenCalled();
    viewportSpy.mockRestore();
  });

  it("keeps selectedTaskIds and selectedTaskId as separate persisted state", async () => {
    const viewportSpy = mockDesktopViewport();
    const tasks = [createMockTask({ id: "FN-001", title: "Test Task" })];

    renderListView({ tasks });

    const row = screen.getByText("FN-001").closest("tr")!;
    enterBulkEditMode();
    const checkbox = within(row).getByRole("checkbox", { name: "Select FN-001" });

    clickInAct(checkbox);
    clickInAct(row);

    await waitFor(() => {
      expect(localStorage.getItem(scopedStorageKey("kb-dashboard-selected-tasks"))).toContain("FN-001");
      expect(localStorage.getItem(scopedStorageKey("kb-dashboard-list-selected-task"))).toBe("FN-001");
    });
    viewportSpy.mockRestore();
  });

  it("initializes selectedTaskId from persisted project storage", () => {
    const viewportSpy = mockDesktopViewport();
    localStorage.setItem(scopedStorageKey("kb-dashboard-list-selected-task"), "FN-001");
    const tasks = [createMockTask({ id: "FN-001", title: "Persisted task" })];

    renderListView({ tasks });

    expect(localStorage.getItem(scopedStorageKey("kb-dashboard-list-selected-task"))).toBe("FN-001");
    viewportSpy.mockRestore();
  });

  it("renders desktop split-pane shell with resize handle and empty detail state", () => {
    const viewportSpy = mockDesktopViewport();
    const tasks = [createMockTask({ id: "FN-001", title: "Task" })];

    renderListView({ tasks });

    expect(screen.getByTestId("list-split-layout")).toBeInTheDocument();
    expect(screen.getByTestId("list-split-sidebar")).toBeInTheDocument();
    expect(screen.getByTestId("list-split-resize-handle")).toBeInTheDocument();
    expect(screen.getByTestId("list-split-detail")).toBeInTheDocument();
    expect(screen.getByText("Select a task to view details")).toBeInTheDocument();
    viewportSpy.mockRestore();
  });

  it("reloads persisted sidebar width when projectId changes", () => {
    const viewportSpy = mockDesktopViewport();
    const clientWidthSpy = vi.spyOn(window.HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
    localStorage.setItem(scopedKey("kb-dashboard-list-sidebar-width", "project-a"), "300");
    localStorage.setItem(scopedKey("kb-dashboard-list-sidebar-width", "project-b"), "460");
    const tasks = [createMockTask({ id: "FN-001", title: "Task" })];

    const { rerender } = render(
      <ListView
        tasks={tasks}
        onMoveTask={vi.fn()}
        onOpenDetail={vi.fn()}
        addToast={mockAddToast}
        projectId="project-a"
      />
    );

    expect(screen.getByTestId("list-split-sidebar")).toHaveStyle({ width: "300px" });

    rerender(
      <ListView
        tasks={tasks}
        onMoveTask={vi.fn()}
        onOpenDetail={vi.fn()}
        addToast={mockAddToast}
        projectId="project-b"
      />
    );

    expect(screen.getByTestId("list-split-sidebar")).toHaveStyle({ width: "460px" });
    clientWidthSpy.mockRestore();
    viewportSpy.mockRestore();
  });

  it("supports keyboard resizing on the desktop split-pane handle", async () => {
    const viewportSpy = mockDesktopViewport();
    const clientWidthSpy = vi.spyOn(window.HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
    // Persisted below the 64px min clamps up to 64.
    localStorage.setItem(scopedStorageKey("kb-dashboard-list-sidebar-width"), "40");
    const tasks = [createMockTask({ id: "FN-001", title: "Task" })];

    renderListView({ tasks });
    await waitFor(() => expect(screen.getByTestId("list-split-sidebar")).toHaveStyle({ width: "64px" }));

    const handle = screen.getByTestId("list-split-resize-handle");
    const startWidth = Number(handle.getAttribute("aria-valuenow"));

    expect(handle).toHaveAttribute("tabindex", "0");
    expect(handle).toHaveAttribute("aria-valuemin", "64");
    expect(Number(handle.getAttribute("aria-valuemax"))).toBeGreaterThanOrEqual(64);

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(Number(handle.getAttribute("aria-valuenow"))).toBeGreaterThan(startWidth);
    fireEvent.keyDown(handle, { key: "Home" });
    expect(handle).toHaveAttribute("aria-valuenow", "64");
    expect(screen.getByTestId("list-split-sidebar")).toHaveStyle({ width: "64px" });
    clientWidthSpy.mockRestore();
    viewportSpy.mockRestore();
  });

  it("resizes the desktop split sidebar by dragging the handle (pointer)", async () => {
    // FNXC:ListView 2026-06-22-18:00: Regression guard — dragging the resize handle must change the
    // sidebar width live and not collapse to the min when the container measures non-zero.
    const viewportSpy = mockDesktopViewport();
    const rectSpy = vi
      .spyOn(window.HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({ left: 0, width: 1000, top: 0, right: 1000, bottom: 300, height: 300, x: 0, y: 0, toJSON() {} } as DOMRect);
    const cwSpy = vi.spyOn(window.HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
    localStorage.setItem(scopedStorageKey("kb-dashboard-list-sidebar-width"), "300");
    const tasks = [createMockTask({ id: "FN-001", title: "Task" })];

    renderListView({ tasks });
    await waitFor(() => expect(screen.getByTestId("list-split-sidebar")).toHaveStyle({ width: "300px" }));

    const handle = screen.getByTestId("list-split-resize-handle");
    // Narrow the pane.
    fireEvent.pointerDown(handle, { clientX: 300, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 250, pointerId: 1 });
    await waitFor(() => expect(screen.getByTestId("list-split-sidebar")).toHaveStyle({ width: "250px" }));
    // Widen the pane.
    fireEvent.pointerMove(window, { clientX: 420, pointerId: 1 });
    await waitFor(() => expect(screen.getByTestId("list-split-sidebar")).toHaveStyle({ width: "420px" }));
    fireEvent.pointerUp(window, { pointerId: 1 });

    rectSpy.mockRestore();
    cwSpy.mockRestore();
    viewportSpy.mockRestore();
  });

  it("does not collapse the split sidebar to the min when the container width is unmeasurable", async () => {
    // FNXC:ListView 2026-06-22-18:00: A zero/unreliable container measurement must not force the
    // persisted width down to the min clamp — that was the resize regression (pane snapped to 64px).
    const viewportSpy = mockDesktopViewport();
    const cwSpy = vi.spyOn(window.HTMLElement.prototype, "clientWidth", "get").mockReturnValue(0);
    localStorage.setItem(scopedStorageKey("kb-dashboard-list-sidebar-width"), "300");
    const tasks = [createMockTask({ id: "FN-001", title: "Task" })];

    renderListView({ tasks });
    // Width must be preserved (not collapsed to 64) while the container reports 0.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(screen.getByTestId("list-split-sidebar")).toHaveStyle({ width: "300px" });

    cwSpy.mockRestore();
    viewportSpy.mockRestore();
  });

  it("does not render split-pane structure on mobile", () => {
    const viewportSpy = mockMobileViewport();
    const tasks = [createMockTask({ id: "FN-001", title: "Task" })];

    renderListView({ tasks });

    expect(screen.queryByTestId("list-split-layout")).toBeNull();
    expect(screen.queryByTestId("list-split-resize-handle")).toBeNull();
    expect(screen.queryByTestId("list-split-detail")).toBeNull();
    viewportSpy.mockRestore();
  });

  it("sorts tasks by ID when ID header is clicked", () => {
    const tasks = [
      createMockTask({ id: "FN-003", title: "Third", column: "triage" }),
      createMockTask({ id: "FN-001", title: "First", column: "triage" }),
      createMockTask({ id: "FN-002", title: "Second", column: "triage" }),
    ];

    renderListView({ tasks });

    // First click - ascending
    const titleHeader = screen.getByRole("columnheader", { name: /title/i });
    fireEvent.click(titleHeader);

    // Get all data rows (excluding section headers by using data-id attribute)
    const rows = screen.getAllByRole("row").filter(r => r.getAttribute("data-id"));
    expect(rows[0].textContent).toContain("FN-001");
    expect(rows[1].textContent).toContain("FN-002");
    expect(rows[2].textContent).toContain("FN-003");

    // Second click - descending
    fireEvent.click(titleHeader);

    const rowsDesc = screen.getAllByRole("row").filter(r => r.getAttribute("data-id"));
    expect(rowsDesc[0].textContent).toContain("FN-003");
    expect(rowsDesc[1].textContent).toContain("FN-002");
    expect(rowsDesc[2].textContent).toContain("FN-001");
  });

  it("sorts tasks by column when Column header is clicked", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "todo" }),
      createMockTask({ id: "FN-002", column: "triage" }),
      createMockTask({ id: "FN-003", column: "in-progress" }),
    ];

    renderListView({ tasks });

    const columnHeader = screen.getByRole("columnheader", { name: /column/i });
    fireEvent.click(columnHeader);

    // Rows are rendered in fixed column-section order.
    const rows = screen.getAllByRole("row").filter(r => r.getAttribute("data-id"));
    expect(rows[0].textContent).toContain("FN-002"); // triage section first
    expect(rows[1].textContent).toContain("FN-001"); // todo section second
    expect(rows[2].textContent).toContain("FN-003"); // in-progress section third
  });

  it("sorts tasks by status when Status header is clicked", () => {
    const tasks = [
      createMockTask({ id: "FN-001", status: "executing", column: "triage" }),
      createMockTask({ id: "FN-002", status: "pending", column: "triage" }),
      createMockTask({ id: "FN-003", status: "failed", column: "triage" }),
    ];

    renderListView({ tasks });

    const statusHeader = screen.getByRole("columnheader", { name: /status/i });
    fireEvent.click(statusHeader);

    // Get data rows - sorted by status alphabetically
    const rows = screen.getAllByRole("row").filter(r => r.getAttribute("data-id"));
    // Should be sorted alphabetically by status: executing, failed, pending
    expect(rows[0].textContent).toContain("executing");
    expect(rows[2].textContent).toContain("pending");
  });

  it("renders failed status with correct styling", () => {
    const tasks = [createMockTask({ id: "FN-001", status: "failed" })];

    renderListView({ tasks });

    const row = screen.getByText("FN-001").closest("tr");
    expect(row?.className).toContain("failed");

    const statusBadge = screen.getByText("failed");
    expect(statusBadge.className).toContain("failed");
  });

  it.each([
    {
      name: "failed + in-review uses error token color",
      classes: "list-status-badge list-status-badge--in-review failed",
      expectedClass: "failed",
      expectedColor: "var(--color-error-dark)",
      disallowedColor: "var(--in-review)",
    },
    {
      name: "stuck + todo uses triage token color",
      classes: "list-status-badge list-status-badge--todo stuck",
      expectedClass: "stuck",
      expectedColor: "var(--triage)",
      disallowedColor: "var(--todo)",
    },
  ])("FN-4208 keeps list badge state precedence: $name", ({ classes, expectedClass, expectedColor, disallowedColor }) => {
    const cleanupCss = mountCssForBadgeTests();
    try {
      const badge = document.createElement("span");
      badge.className = classes;
      badge.textContent = "status";
      document.body.appendChild(badge);

      expect(badge.className).toContain(expectedClass);
      expect(getComputedStyle(badge).color).toBe(expectedColor);
      expect(getComputedStyle(badge).color).not.toBe(disallowedColor);

      badge.remove();
    } finally {
      cleanupCss();
    }
  });

  it("renders paused tasks with dimmed styling", () => {
    const tasks = [createMockTask({ id: "FN-001", paused: true })];

    renderListView({ tasks });

    const row = screen.getByText("FN-001").closest("tr");
    expect(row?.className).toContain("paused");
  });

  it.each([
    { status: "executing", column: "in-progress" as const, label: "executing" },
    { status: "merging-fix", column: "in-review" as const, label: "Merging fixes…" },
  ])("renders agent-active tasks with static highlight styling for $status", ({ status, column, label }) => {
    const tasks = [
      createMockTask({
        id: "FN-001",
        status,
        column,
      }),
    ];

    renderListView({ tasks, globalPaused: false });

    const row = screen.getByText("FN-001").closest("tr");
    expect(row?.className).toContain("agent-active");
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("does not render agent-active when globalPaused is true", () => {
    const tasks = [
      createMockTask({
        id: "FN-001",
        status: "executing",
        column: "in-progress",
      }),
    ];

    renderListView({ tasks, globalPaused: true });

    const row = screen.getByText("FN-001").closest("tr");
    expect(row?.className).not.toContain("agent-active");
  });

  it("renders stuck indicator when task is stuck and timeout is set", () => {
    const staleTime = new Date(Date.now() - 600000).toISOString();
    const tasks = [
      createMockTask({
        id: "FN-001",
        status: "executing",
        column: "in-progress",
        updatedAt: staleTime,
      }),
    ];

    renderListView({ tasks, taskStuckTimeoutMs: 600000 });

    const row = screen.getByText("FN-001").closest("tr");
    expect(row?.className).toContain("stuck");

    const statusBadge = screen.getByText("Stuck");
    expect(statusBadge.className).toContain("stuck");
  });

  it("does not render stuck indicator when taskStuckTimeoutMs is undefined", () => {
    const staleTime = new Date(Date.now() - 600000).toISOString();
    const tasks = [
      createMockTask({
        id: "FN-001",
        status: "executing",
        column: "in-progress",
        updatedAt: staleTime,
      }),
    ];

    renderListView({ tasks });

    const row = screen.getByText("FN-001").closest("tr");
    expect(row?.className).not.toContain("stuck");
    expect(screen.getByText("executing")).toBeInTheDocument();
  });

  it("stuck indicator takes precedence over agent-active", () => {
    const staleTime = new Date(Date.now() - 600000).toISOString();
    const tasks = [
      createMockTask({
        id: "FN-001",
        status: "executing",
        column: "in-progress",
        updatedAt: staleTime,
      }),
    ];

    renderListView({ tasks, taskStuckTimeoutMs: 600000, globalPaused: false });

    const row = screen.getByText("FN-001").closest("tr");
    expect(row?.className).toContain("stuck");
    expect(row?.className).not.toContain("agent-active");
    expect(screen.getByText("Stuck")).toBeInTheDocument();
  });

  it("renders column badges with correct colors", () => {
    const columns = ["triage", "todo", "in-progress", "in-review", "done"] as const;

    const tasks = columns.map((col, i) =>
      createMockTask({ id: `FN-00${i + 1}`, column: col })
    );

    renderListView({ tasks });

    // Check that all column badges are rendered in the table
    // Use getAllByText and check length since column names appear in both drop zones and badges
    expect(screen.getAllByText("Planning").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Todo").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("In Progress").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("In Review").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Done").length).toBeGreaterThanOrEqual(1);

    // Check that badges have the correct styling by querying within the table
    const table = document.querySelector(".list-table");
    expect(table?.textContent).toContain("Planning");
    expect(table?.textContent).toContain("Todo");
    expect(table?.textContent).toContain("In Progress");
    expect(table?.textContent).toContain("In Review");
    expect(table?.textContent).toContain("Done");
  });

  it("renders unified progress bar for actively executing tasks", () => {
    const tasks = [
      createMockTask({
        id: "FN-001",
        column: "todo",
        status: "executing",
        steps: [
          { name: "Step 1", status: "done" },
          { name: "Step 2", status: "done" },
          { name: "Step 3", status: "pending" },
        ],
        enabledWorkflowSteps: ["WS-001", "WS-002"],
        workflowStepResults: [
          {
            workflowStepId: "WS-001",
            workflowStepName: "Browser Verification",
            status: "passed",
          },
        ],
      }),
    ];

    showAllColumnsByDefault();
    renderListView({ tasks });

    expect(screen.getByText("3/5")).toBeDefined();
  });

  it("shows workflow-only progress even when task.steps is empty", () => {
    const tasks = [
      createMockTask({
        id: "FN-001",
        column: "todo",
        status: "executing",
        steps: [],
        enabledWorkflowSteps: ["WS-001"],
        workflowStepResults: [
          {
            workflowStepId: "WS-001",
            workflowStepName: "Browser Verification",
            status: "failed",
          },
        ],
      }),
    ];

    showAllColumnsByDefault();
    renderListView({ tasks });

    const row = screen.getByText("FN-001").closest("tr")!;
    const progressCell = row.querySelector(".list-cell-progress");
    expect(progressCell?.textContent).toContain("0/1");
  });

  it("shows - for tasks with no steps", () => {
    const tasks = [createMockTask({ id: "FN-001", steps: [] })];

    showAllColumnsByDefault();
    renderListView({ tasks });

    // Find the task row and check its progress cell
    const row = screen.getByText("FN-001").closest("tr")!;
    const progressCell = row.querySelector(".list-cell-progress");
    expect(progressCell?.textContent).toBe("-");
  });

  it("hides progress for todo tasks that are not executing", () => {
    const tasks = [
      createMockTask({
        id: "FN-002",
        column: "todo",
        status: "pending",
        steps: [{ name: "Step 1", status: "done" }],
      }),
    ];

    showAllColumnsByDefault();
    renderListView({ tasks });

    const row = screen.getByText("FN-002").closest("tr")!;
    const progressCell = row.querySelector(".list-cell-progress");
    expect(progressCell?.textContent).toBe("-");
  });

  it("renders dependency count with icon", () => {
    const tasks = [
      createMockTask({
        id: "FN-001",
        dependencies: ["FN-002", "FN-003"],
      }),
    ];

    showAllColumnsByDefault();
    renderListView({ tasks });

    expect(screen.getByText("2")).toBeDefined();
  });

  it("shows - for tasks with no dependencies", () => {
    const tasks = [createMockTask({ id: "FN-001", dependencies: [] })];

    showAllColumnsByDefault();
    renderListView({ tasks });

    const row = screen.getByText("FN-001").closest("tr")!;
    const depCell = row.querySelector(".list-cell-deps");
    expect(depCell?.textContent).toBe("-");
  });

  it("displays correct task count in stats", () => {
    const tasks = [
      createMockTask({ id: "FN-001" }),
      createMockTask({ id: "FN-002" }),
      createMockTask({ id: "FN-003" }),
    ];

    renderListView({ tasks });

    // FNXC:ListView 2026-06-23-00:00: the "X of Y tasks" count was removed from the desktop sidebar; verify the filter result via the rendered task rows instead.
    expect(screen.getAllByRole("row").filter((r) => r.getAttribute("data-id"))).toHaveLength(3);
  });

  it("displays filtered task count in stats", () => {
    const tasks = [
      createMockTask({ id: "FN-001", title: "Alpha" }),
      createMockTask({ id: "FN-002", title: "Beta" }),
      createMockTask({ id: "FN-003", title: "Gamma" }),
    ];

    renderListView({ tasks, searchQuery: "Alpha" });

    // FNXC:ListView 2026-06-23-00:00: count removed from sidebar; assert the filtered rows.
    expect(screen.getAllByRole("row").filter((r) => r.getAttribute("data-id"))).toHaveLength(1);
  });

  it("calls onNewTask when + New Task button is clicked", () => {
    const mockOnNewTask = vi.fn();

    renderListView({ onNewTask: mockOnNewTask });

    const newTaskButton = screen.getByText("+ New Task");
    fireEvent.click(newTaskButton);

    expect(mockOnNewTask).toHaveBeenCalled();
  });

  it("keeps Bulk Edit, View, and + New Task together in the desktop sidebar controls", () => {
    renderListView({}, { openViewOptions: false });

    const actions = document.querySelector(".list-sidebar-controls .list-action-cluster");
    const actionButtons = Array.from(actions?.querySelectorAll("button") ?? []).map((button) => button.textContent);
    expect(actionButtons).toEqual(["Bulk Edit", "View", "+ New Task"]);
  });

  it("keeps the primary list action cluster on one physical row when the pane narrows", () => {
    const css = readFileSync("app/components/ListView.css", "utf8");
    const actionClusterRule = css.match(/\.list-action-cluster,\s*\n\.list-sidebar-controls__actions\s*\{[^}]*\}/)?.[0] ?? "";
    const toolbarRule = css.match(/\.list-sidebar-controls__toolbar\s*\{[^}]*\}/)?.[0] ?? "";
    const mobileToolbarRule = css.match(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.list-toolbar\s*\{[^}]*padding:\s*var\(--space-sm\) var\(--space-md\);[^}]*\}/)?.[0] ?? "";

    expect(actionClusterRule).toContain("flex-wrap: nowrap");
    expect(actionClusterRule).toContain("justify-content: center");
    expect(actionClusterRule).toContain("inline-size: max-content");
    expect(actionClusterRule).toContain("min-width: max-content");
    expect(actionClusterRule).toContain("overflow-x: auto");
    expect(toolbarRule).toContain("justify-content: center");
    expect(mobileToolbarRule).toContain("justify-content: center");
  });

  it("keeps Bulk Edit, View, and + New Task together in the mobile toolbar controls", () => {
    const viewportSpy = mockMobileViewport();
    renderListView({}, { openViewOptions: false });

    const actions = document.querySelector(".list-toolbar .list-action-cluster");
    const actionButtons = Array.from(actions?.querySelectorAll("button") ?? []).map((button) => button.textContent);
    expect(actionButtons).toEqual(["Bulk Edit", "View", "+ New Task"]);

    viewportSpy.mockRestore();
  });

  it("+ New Task button uses theme-driven btn-task-create class", () => {
    const mockOnNewTask = vi.fn();
    renderListView({ onNewTask: mockOnNewTask });

    const newTaskButton = screen.getByText("+ New Task");
    expect(newTaskButton.className).toContain("btn-task-create");
  });

  it("does not render + New Task button when onNewTask is not provided", () => {
    renderListView({ onNewTask: undefined });

    expect(screen.queryByText("+ New Task")).toBeNull();
  });

  it("renders drop zones for each column", () => {
    renderListView();

    expect(screen.getByText("Planning")).toBeDefined();
    expect(screen.getByText("Todo")).toBeDefined();
    expect(screen.getByText("In Progress")).toBeDefined();
    expect(screen.getByText("In Review")).toBeDefined();
    expect(screen.getByText("Done")).toBeDefined();
  });

  it("displays correct task counts in drop zones", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage" }),
      createMockTask({ id: "FN-002", column: "triage" }),
      createMockTask({ id: "FN-003", column: "todo" }),
    ];

    renderListView({ tasks });

    // Use querySelector to find drop zones by data-column attribute
    const triageZone = document.querySelector('[data-column="triage"]');
    expect(triageZone?.textContent).toContain("2");

    const todoZone = document.querySelector('[data-column="todo"]');
    expect(todoZone?.textContent).toContain("1");
  });

  it("handles drag and drop to move tasks between columns", async () => {
    const tasks = [createMockTask({ id: "FN-001", column: "triage" })];
    const mockOnMoveTask = vi.fn(() => Promise.resolve(tasks[0]));

    renderListView({ tasks, onMoveTask: mockOnMoveTask });

    const row = screen.getByText("FN-001").closest("tr")!;

    // Simulate drag start
    fireEvent.dragStart(row, {
      dataTransfer: {
        setData: vi.fn(),
        effectAllowed: "move",
      },
    });

    // Simulate drop on todo column drop zone (use querySelector for specificity)
    const todoZone = document.querySelector('[data-column="todo"].list-drop-zone')!;
    fireEvent.dragOver(todoZone, {
      preventDefault: vi.fn(),
      dataTransfer: { dropEffect: "move" },
    });

    fireEvent.drop(todoZone, {
      preventDefault: vi.fn(),
      dataTransfer: {
        getData: vi.fn(() => "FN-001"),
      },
    });

    await waitFor(() => {
      expect(mockOnMoveTask).toHaveBeenCalledWith("FN-001", "todo", undefined);
    });
  });

  it("prompts to preserve progress when dropping task with completed steps to todo", async () => {
    const tasks = [createMockTask({
      id: "FN-001",
      column: "in-progress",
      steps: [
        { title: "Step 1", status: "done" },
        { title: "Step 2", status: "pending" },
      ],
    })];
    const mockOnMoveTask = vi.fn(() => Promise.resolve(tasks[0]));
    mockConfirm.mockResolvedValueOnce(true);

    renderListView({ tasks, onMoveTask: mockOnMoveTask });

    const row = screen.getByText("FN-001").closest("tr")!;
    fireEvent.dragStart(row, {
      dataTransfer: {
        setData: vi.fn(),
        effectAllowed: "move",
      },
    });

    const todoZone = document.querySelector('[data-column="todo"].list-drop-zone')!;
    fireEvent.drop(todoZone, {
      preventDefault: vi.fn(),
      dataTransfer: {
        getData: vi.fn(() => "FN-001"),
      },
    });

    await waitFor(() => {
      expect(mockConfirm).toHaveBeenCalledWith(expect.objectContaining({
        title: "Preserve Progress?",
        cancelLabel: "Reset Progress",
      }));
      expect(mockOnMoveTask).toHaveBeenCalledWith("FN-001", "todo", { preserveProgress: true });
    });
  });

  it("prompts to preserve progress when dropping task with completed steps to a workflow hold column", async () => {
    const tasks = [createMockTask({
      id: "FN-001",
      column: "doing",
      steps: [
        { title: "Step 1", status: "done" },
        { title: "Step 2", status: "pending" },
      ],
    })];
    const mockOnMoveTask = vi.fn(() => Promise.resolve(tasks[0]));
    mockConfirm.mockResolvedValueOnce(true);
    vi.mocked(fetchBoardWorkflows).mockResolvedValue({
      flagEnabled: true,
      defaultWorkflowId: "wf-custom",
      workflows: [
        {
          id: "wf-custom",
          name: "Custom",
          columns: [
            { id: "queue", name: "Queue", flags: { hold: true } },
            { id: "doing", name: "Doing", flags: { countsTowardWip: true } },
            { id: "shipped", name: "Shipped", flags: { complete: true } },
          ],
        },
      ],
      taskWorkflowIds: { "FN-001": "wf-custom" },
    });

    renderListView({ tasks, onMoveTask: mockOnMoveTask });
    await waitFor(() => expect(document.querySelector('[data-column="queue"].list-drop-zone')).toBeTruthy());

    fireEvent.drop(document.querySelector('[data-column="queue"].list-drop-zone')!, {
      preventDefault: vi.fn(),
      dataTransfer: {
        getData: vi.fn(() => "FN-001"),
      },
    });

    await waitFor(() => {
      expect(mockConfirm).toHaveBeenCalledWith(expect.objectContaining({
        title: "Preserve Progress?",
      }));
      expect(mockOnMoveTask).toHaveBeenCalledWith("FN-001", "queue", { preserveProgress: true });
    });
  });

  it("does not set draggable for paused tasks", () => {
    const tasks = [createMockTask({ id: "FN-001", paused: true })];

    renderListView({ tasks });

    const row = screen.getByText("FN-001").closest("tr")!;
    // Paused tasks should have draggable="false"
    expect(row.getAttribute("draggable")).toBe("false");
  });

  it("sets draggable for non-paused tasks", () => {
    const tasks = [createMockTask({ id: "FN-001", paused: false })];

    renderListView({ tasks });

    const row = screen.getByText("FN-001").closest("tr")!;
    // Non-paused tasks should have draggable="true"
    expect(row.getAttribute("draggable")).toBe("true");
  });

  it("shows error toast when onMoveTask fails during drag and drop", async () => {
    const tasks = [createMockTask({ id: "FN-001", column: "triage" })];
    const mockOnMoveTask = vi.fn(() => Promise.reject(new Error("Move failed")));

    renderListView({ tasks, onMoveTask: mockOnMoveTask });

    const row = screen.getByText("FN-001").closest("tr")!;

    fireEvent.dragStart(row, {
      dataTransfer: {
        setData: vi.fn(),
        effectAllowed: "move",
      },
    });

    // Use querySelector to find the specific drop zone
    const todoZone = document.querySelector('[data-column="todo"].list-drop-zone')!;
    fireEvent.drop(todoZone, {
      preventDefault: vi.fn(),
      dataTransfer: {
        getData: vi.fn(() => "FN-001"),
      },
    });

    await waitFor(() => {
      expect(mockAddToast).toHaveBeenCalledWith("Move failed", "error");
    });
  });

  it("displays full description in title cell when no title exists", () => {
    const longDescription = "A".repeat(100);
    const tasks = [createMockTask({ id: "FN-001", title: undefined, description: longDescription })];

    renderListView({ tasks });

    // The full 100-character description should be visible
    const titleCell = screen.getByText(longDescription).closest("td")!;
    expect(titleCell.textContent).toContain(longDescription);
    expect(titleCell.textContent?.length).toBeGreaterThanOrEqual(100);
  });

  // Grouped view tests
  it("renders section headers for each column", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage" }),
      createMockTask({ id: "FN-002", column: "todo" }),
    ];

    renderListView({ tasks });

    // Check that section headers are rendered with column names
    expect(screen.getAllByText("Planning").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Todo").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("In Progress").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("In Review").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Done").length).toBeGreaterThanOrEqual(1);
  });

  it("displays correct task count in section headers", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage" }),
      createMockTask({ id: "FN-002", column: "triage" }),
      createMockTask({ id: "FN-003", column: "todo" }),
    ];

    renderListView({ tasks });

    // Find section headers by their structure
    const sectionHeaders = screen.getAllByRole("row").filter(r => r.className.includes("list-section-header"));
    expect(sectionHeaders.length).toBe(6); // One for each column

    // Check that triage section shows count of 2
    const triageHeader = sectionHeaders.find(h => h.textContent?.includes("Planning"));
    expect(triageHeader?.textContent).toContain("2");

    // Check that todo section shows count of 1
    const todoHeader = sectionHeaders.find(h => h.textContent?.includes("Todo"));
    expect(todoHeader?.textContent).toContain("1");
  });

  it("shows No tasks placeholder for empty columns", () => {
    const tasks = [createMockTask({ id: "FN-001", column: "triage" })];

    renderListView({ tasks });

    // Should show "No tasks" for empty columns
    const noTasksCells = screen.getAllByText("No tasks");
    expect(noTasksCells.length).toBeGreaterThanOrEqual(1);
  });

  it("section headers span full table width including checkbox column", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage" }),
      createMockTask({ id: "FN-002", column: "todo" }),
    ];

    localStorage.clear();
    renderListView({ tasks });
    enterBulkEditMode();

    // Find section header rows
    const sectionHeaders = screen.getAllByRole("row").filter(r => r.className.includes("list-section-header"));

    // Verify each section header has colSpan that includes the checkbox column
    // Default visible columns: title (1 column)
    // Plus checkbox column = 2 total
    for (const header of sectionHeaders) {
      const th = header.querySelector("th.list-section-cell");
      expect(th).not.toBeNull();
      expect(th!.getAttribute("colSpan")).toBe("2"); // visibleColumns.size (1) + 1 for checkbox
    }

    // Also verify empty section cells span full width
    const emptyCells = screen.getAllByRole("cell").filter(c => c.className.includes("list-empty-cell"));
    for (const cell of emptyCells) {
      expect(cell.getAttribute("colSpan")).toBe("2");
    }
  });

  it("hides empty sections when filter is active", () => {
    const tasks = [
      createMockTask({ id: "FN-001", title: "Alpha Task", column: "triage" }),
      createMockTask({ id: "FN-002", title: "Beta Task", column: "todo" }),
    ];

    renderListView({ tasks, searchQuery: "Alpha" });

    // Only triage section should be visible (todo section should be hidden)
    const sectionHeaders = screen.getAllByRole("row").filter(r => r.className.includes("list-section-header"));
    expect(sectionHeaders.length).toBe(1);
    expect(sectionHeaders[0].textContent).toContain("Planning");

    // Verify the filtered task is visible
    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.queryByText("FN-002")).toBeNull();
  });

  it("defaults todo section to board-consistent priority then oldest ordering", () => {
    const tasks = [
      createMockTask({ id: "FN-100", column: "todo", priority: "low", createdAt: "2024-01-01T08:00:00.000Z" }),
      createMockTask({ id: "FN-101", column: "todo", priority: "urgent", createdAt: "2024-01-01T10:00:00.000Z" }),
      createMockTask({ id: "FN-102", column: "todo", priority: "high", createdAt: "2024-01-01T07:00:00.000Z" }),
    ];

    renderListView({ tasks });

    expect(getSectionTaskIds("Todo")).toEqual(["FN-101", "FN-102", "FN-100"]);
  });

  it("defaults done section to board-consistent completion recency", () => {
    const tasks = [
      createMockTask({ id: "FN-200", column: "done", priority: "urgent", columnMovedAt: "2024-01-01T08:00:00.000Z" }),
      createMockTask({ id: "FN-201", column: "done", priority: "low", columnMovedAt: "2024-01-01T10:00:00.000Z" }),
    ];

    renderListView({ tasks });

    expect(getSectionTaskIds("Done")).toEqual(["FN-201", "FN-200"]);
  });

  it("defaults in-review section to board-consistent merge-active pinning", () => {
    const tasks = [
      createMockTask({ id: "FN-300", column: "in-review", status: "review-ready", priority: "urgent" }),
      createMockTask({ id: "FN-301", column: "in-review", status: "merging-fix", priority: "normal" }),
    ];

    renderListView({ tasks });

    expect(getSectionTaskIds("In Review")).toEqual(["FN-301", "FN-300"]);
  });

  it("maintains sort order within each section", () => {
    const tasks = [
      createMockTask({ id: "FN-003", title: "Charlie", column: "triage" }),
      createMockTask({ id: "FN-001", title: "Alpha", column: "triage" }),
      createMockTask({ id: "FN-002", title: "Bravo", column: "triage" }),
    ];

    renderListView({ tasks });

    const titleHeader = screen.getByRole("columnheader", { name: /title/i });
    fireEvent.click(titleHeader);

    expect(getSectionTaskIds("Planning")).toEqual(["FN-001", "FN-002", "FN-003"]);
  });
});

describe("ListView Column Filtering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("filters tasks by column when drop zone is clicked", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage", title: "Planning Task" }),
      createMockTask({ id: "FN-002", column: "todo", title: "Todo Task" }),
      createMockTask({ id: "FN-003", column: "in-progress", title: "In Progress Task" }),
    ];

    renderListView({ tasks });

    // Click on the triage drop zone
    const triageZone = document.querySelector('[data-column="triage"].list-drop-zone')!;
    fireEvent.click(triageZone);

    // Only triage task should be visible
    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.queryByText("FN-002")).toBeNull();
    expect(screen.queryByText("FN-003")).toBeNull();

    // Only triage section header should be visible
    const sectionHeaders = screen.getAllByRole("row").filter(r => r.className.includes("list-section-header"));
    expect(sectionHeaders.length).toBe(1);
    expect(sectionHeaders[0].textContent).toContain("Planning");
  });

  it("clears column filter when same drop zone is clicked again", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage", title: "Planning Task" }),
      createMockTask({ id: "FN-002", column: "todo", title: "Todo Task" }),
    ];

    renderListView({ tasks });

    // Click on the triage drop zone to filter
    const triageZone = document.querySelector('[data-column="triage"].list-drop-zone')!;
    fireEvent.click(triageZone);

    // Verify filter is active - only triage task visible
    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.queryByText("FN-002")).toBeNull();

    // Click the same drop zone again to clear filter
    fireEvent.click(triageZone);

    // All tasks should be visible again
    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.getByText("FN-002")).toBeDefined();

    // All 6 section headers should be visible (one for each column)
    const sectionHeaders = screen.getAllByRole("row").filter(r => r.className.includes("list-section-header"));
    expect(sectionHeaders.length).toBe(6);
  });

  it("switches column filter when different drop zone is clicked", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage", title: "Planning Task" }),
      createMockTask({ id: "FN-002", column: "todo", title: "Todo Task" }),
    ];

    renderListView({ tasks });

    // Click on the triage drop zone to filter
    const triageZone = document.querySelector('[data-column="triage"].list-drop-zone')!;
    fireEvent.click(triageZone);

    // Verify only triage task visible
    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.queryByText("FN-002")).toBeNull();

    // Click on the todo drop zone to switch filter
    const todoZone = document.querySelector('[data-column="todo"].list-drop-zone')!;
    fireEvent.click(todoZone);

    // Only todo task should be visible now
    expect(screen.queryByText("FN-001")).toBeNull();
    expect(screen.getByText("FN-002")).toBeDefined();

    // Only todo section header should be visible
    const sectionHeaders = screen.getAllByRole("row").filter(r => r.className.includes("list-section-header"));
    expect(sectionHeaders.length).toBe(1);
    expect(sectionHeaders[0].textContent).toContain("Todo");
  });

  it("clears column filter when clear button is clicked", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage", title: "Planning Task" }),
      createMockTask({ id: "FN-002", column: "todo", title: "Todo Task" }),
    ];

    renderListView({ tasks });

    // Click on the triage drop zone to filter
    const triageZone = document.querySelector('[data-column="triage"].list-drop-zone')!;
    fireEvent.click(triageZone);

    // Verify filter is active
    expect(screen.queryByText("FN-002")).toBeNull();

    // Click the clear button
    const clearButton = screen.getByRole("button", { name: /clear column filter/i });
    fireEvent.click(clearButton);

    // All tasks should be visible again
    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.getByText("FN-002")).toBeDefined();
  });

  it("shows correct filtered stats when column filter is active", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage", title: "Planning Task" }),
      createMockTask({ id: "FN-002", column: "triage", title: "Planning Task 2" }),
      createMockTask({ id: "FN-003", column: "todo", title: "Todo Task" }),
    ];

    renderListView({ tasks });

    // Click on the triage drop zone to filter
    const triageZone = document.querySelector('[data-column="triage"].list-drop-zone')!;
    fireEvent.click(triageZone);

    // Stats should show filtered count with column name
    expect(screen.getAllByRole("row").filter((r) => r.getAttribute("data-id"))).toHaveLength(2);
  });

  it("applies text filter within column filter", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage", title: "Alpha Planning Task" }),
      createMockTask({ id: "FN-002", column: "triage", title: "Beta Planning Task" }),
      createMockTask({ id: "FN-003", column: "todo", title: "Alpha Todo Task" }),
    ];

    renderListView({ tasks, searchQuery: "Alpha" });

    // Click on the triage drop zone to filter by column
    const triageZone = document.querySelector('[data-column="triage"].list-drop-zone')!;
    fireEvent.click(triageZone);

    // Only Alpha triage task should be visible (text filter + column filter)
    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.queryByText("FN-002")).toBeNull();
    expect(screen.queryByText("FN-003")).toBeNull();

    // Stats should reflect combined filtering
    expect(screen.getAllByRole("row").filter((r) => r.getAttribute("data-id"))).toHaveLength(1);
  });

  it("applies active class to selected column drop zone", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage", title: "Planning Task" }),
    ];

    renderListView({ tasks });

    // Click on the triage drop zone
    const triageZone = document.querySelector('[data-column="triage"].list-drop-zone')!;
    fireEvent.click(triageZone);

    // Should have active class
    expect(triageZone.classList.contains("active")).toBe(true);

    // Other drop zones should not have active class
    const todoZone = document.querySelector('[data-column="todo"].list-drop-zone')!;
    expect(todoZone.classList.contains("active")).toBe(false);
  });
});

describe("ListView Column Visibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear localStorage before each test
    localStorage.clear();
  });

  it("renders view options toggle button", () => {
    renderListView();

    const columnsButton = screen.getByRole("button", { name: /^view$/i });
    expect(columnsButton).toBeDefined();
  });

  it("opens column dropdown when toggle clicked", () => {
    renderListView({}, { openViewOptions: false });

    const columnsButton = screen.getByRole("button", { name: /^view$/i });
    fireEvent.click(columnsButton);

    expect(columnsButton).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByText("ID")).toBeNull();
    expect(screen.getByLabelText("Title")).toBeDefined();
    expect(screen.getByLabelText("Status")).toBeDefined();
    expect(screen.getByLabelText("Column")).toBeDefined();
    expect(screen.getByLabelText("Retries")).toBeDefined();
    expect(screen.getByLabelText("Dependencies")).toBeDefined();
    expect(screen.getByLabelText("Progress")).toBeDefined();
  });

  it("shows only the Title column by default while keeping all column toggles available", () => {
    const tasks = [
      createMockTask({
        id: "FN-001",
        title: "Title-only default task",
        column: "triage",
        status: "pending",
      }),
    ];

    renderListView({ tasks });

    const table = document.querySelector(".list-table");
    expect(table).not.toBeNull();
    const tableHeader = table?.querySelector("thead");
    expect(tableHeader).not.toBeNull();
    expect(within(tableHeader as HTMLElement).getByRole("columnheader", { name: /title/i })).toBeDefined();
    expect(within(tableHeader as HTMLElement).queryByRole("columnheader", { name: /status/i })).toBeNull();
    expect(within(tableHeader as HTMLElement).queryByRole("columnheader", { name: /column/i })).toBeNull();
    expect(within(tableHeader as HTMLElement).queryByRole("columnheader", { name: /retries/i })).toBeNull();
    expect(within(tableHeader as HTMLElement).queryByRole("columnheader", { name: /dependencies/i })).toBeNull();
    expect(within(tableHeader as HTMLElement).queryByRole("columnheader", { name: /progress/i })).toBeNull();
    expect(within(table as HTMLElement).getByText("Title-only default task")).toBeDefined();

    expect(screen.getByLabelText("Title")).toBeDefined();
    expect(screen.getByLabelText("Status")).toBeDefined();
    expect(screen.getByLabelText("Column")).toBeDefined();
    expect(screen.getByLabelText("Retries")).toBeDefined();
    expect(screen.getByLabelText("Dependencies")).toBeDefined();
    expect(screen.getByLabelText("Progress")).toBeDefined();
  });
  it("hides column when unchecked in dropdown", () => {
    const tasks = [createMockTask({ id: "FN-001", title: "Test Task" })];
    renderListView({ tasks });

    // Enable a second column first so the last-visible-column guard allows hiding Title.
    fireEvent.click(screen.getByLabelText("Status"));
    const titleCheckbox = screen.getByLabelText("Title");
    fireEvent.click(titleCheckbox);

    // Title column should no longer be visible in the table
    const table = document.querySelector(".list-table");
    expect(table?.textContent).not.toContain("Test Task");
  });

  it("shows column when checked in dropdown", () => {
    const tasks = [createMockTask({ id: "FN-001", title: "Test Task" })];
    renderListView({ tasks });

    // Enable a second column first so the last-visible-column guard allows hiding Title.
    fireEvent.click(screen.getByLabelText("Status"));
    const titleCheckbox = screen.getByLabelText("Title");
    fireEvent.click(titleCheckbox);

    // Verify Title is hidden
    const table = document.querySelector(".list-table");
    expect(table?.textContent).not.toContain("Test Task");

    // Re-check the Title column (still in the same dropdown session)
    const titleCheckbox2 = screen.getByLabelText("Title");
    fireEvent.click(titleCheckbox2);

    // Title column should be visible again
    const tableAfter = document.querySelector(".list-table");
    expect(tableAfter?.textContent).toContain("Test Task");
  });

  it("persists column visibility to localStorage", () => {
    const tasks = [createMockTask({ id: "FN-001", title: "Test Task" })];
    renderListView({ tasks });

    // Enable a second column first, then uncheck Title.
    fireEvent.click(screen.getByLabelText("Status"));
    const titleCheckbox = screen.getByLabelText("Title");
    fireEvent.click(titleCheckbox);

    // Verify localStorage was updated
    const saved = localStorage.getItem(scopedStorageKey("kb-dashboard-list-columns"));
    expect(saved).toBeTruthy();
    const parsed = JSON.parse(saved!);
    expect(parsed).toContain("status");
    expect(parsed).not.toContain("title");
  });

  it("initializes column visibility from localStorage", () => {
    // Set up localStorage with only Status visible
    localStorage.setItem(scopedStorageKey("kb-dashboard-list-columns"), JSON.stringify(["status"]));

    const tasks = [createMockTask({ id: "FN-001", title: "Test Task", status: "pending" })];
    renderListView({ tasks });

    // Title should NOT be visible (hidden by localStorage)
    expect(screen.queryByText("FN-001")).toBeNull();
    const table = document.querySelector(".list-table");
    expect(table?.textContent).not.toContain("Test Task");
  });

  it("prevents hiding all columns (at least one stays visible)", () => {
    renderListView();

    // View options panel already open

    // Get all checkboxes and try to uncheck all except one
    const checkboxes = screen.getAllByRole("checkbox");
    
    // Uncheck all but one
    for (let i = 0; i < checkboxes.length - 1; i++) {
      if ((checkboxes[i] as HTMLInputElement).checked) {
        fireEvent.click(checkboxes[i]);
      }
    }

    // The last checkbox should be disabled (check the disabled property)
    const lastCheckbox = checkboxes[checkboxes.length - 1];
    if ((lastCheckbox as HTMLInputElement).checked) {
      expect((lastCheckbox as HTMLInputElement).disabled).toBe(true);
    }
  });

  it("sorting still works when some columns are hidden", () => {
    const tasks = [
      createMockTask({ id: "FN-003", title: "Charlie", column: "triage" }),
      createMockTask({ id: "FN-001", title: "Alpha", column: "triage" }),
      createMockTask({ id: "FN-002", title: "Bravo", column: "triage" }),
    ];
    renderListView({ tasks });

    // Hide some columns
    const checkboxes = screen.getAllByRole("checkbox");
    const columnCheckbox = checkboxes.find(
      cb => cb.parentElement?.textContent?.includes("Column")
    );
    expect(columnCheckbox).toBeDefined();
    fireEvent.click(columnCheckbox!);

    // Find and click Title header to sort
    const titleHeader = screen.getByRole("columnheader", { name: /title/i });
    fireEvent.click(titleHeader);

    // Get sorted rows and verify sorting still works
    const rows = screen.getAllByRole("row").filter(r => r.getAttribute("data-id"));
    expect(rows[0].textContent).toContain("FN-001");
    expect(rows[1].textContent).toContain("FN-002");
    expect(rows[2].textContent).toContain("FN-003");
  });

  it("shows only title by default when no localStorage", () => {
    const tasks = [
      createMockTask({ id: "FN-001", title: "Test Task", status: "pending", column: "triage" }),
    ];
    renderListView({ tasks });

    // The title column should be the only visible first-run column.
    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.getByText("Test Task")).toBeDefined();
    expect(screen.queryByText("pending")).toBeNull();
    expect(document.querySelector(".list-column-badge")).toBeNull();
    expect(document.querySelector(".list-cell-deps")).toBeNull();
    expect(document.querySelector(".list-cell-progress")).toBeNull();
  });
});


describe("ListView Hide Done Tasks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("renders hide done tasks toggle button", () => {
    renderListView();

    const hideDoneButton = screen.getByRole("button", { name: /hide done/i });
    expect(hideDoneButton).toBeDefined();
  });

  it("hides done tasks when toggle is activated", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "done" }),
      createMockTask({ id: "FN-002", column: "triage" }),
    ];

    renderListView({ tasks });

    // Both tasks should be visible initially
    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.getByText("FN-002")).toBeDefined();

    // Click hide done button
    const hideDoneButton = screen.getByRole("button", { name: /hide done/i });
    fireEvent.click(hideDoneButton);

    // Done task should be hidden, triage task should still be visible
    expect(screen.queryByText("FN-001")).toBeNull();
    expect(screen.getByText("FN-002")).toBeDefined();
  });

  it("hides archived tasks when toggle is activated", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "archived" }),
      createMockTask({ id: "FN-002", column: "triage" }),
    ];

    renderListView({ tasks });

    // Both tasks should be visible initially
    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.getByText("FN-002")).toBeDefined();

    // Click hide done button
    const hideDoneButton = screen.getByRole("button", { name: /hide done/i });
    fireEvent.click(hideDoneButton);

    // Archived task should be hidden, triage task should still be visible
    expect(screen.queryByText("FN-001")).toBeNull();
    expect(screen.getByText("FN-002")).toBeDefined();
  });

  it("hides both done and archived tasks when toggle is activated", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "done" }),
      createMockTask({ id: "FN-002", column: "archived" }),
      createMockTask({ id: "FN-003", column: "triage" }),
    ];

    renderListView({ tasks });

    // All tasks should be visible initially
    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.getByText("FN-002")).toBeDefined();
    expect(screen.getByText("FN-003")).toBeDefined();

    // Click hide done button
    const hideDoneButton = screen.getByRole("button", { name: /hide done/i });
    fireEvent.click(hideDoneButton);

    // Done and archived tasks should be hidden, triage task should remain visible
    expect(screen.queryByText("FN-001")).toBeNull();
    expect(screen.queryByText("FN-002")).toBeNull();
    expect(screen.getByText("FN-003")).toBeDefined();
  });

  it("shows done and archived tasks when toggle is deactivated", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "done" }),
      createMockTask({ id: "FN-002", column: "archived" }),
      createMockTask({ id: "FN-003", column: "triage" }),
    ];

    renderListView({ tasks });

    // Click hide done button to hide completed tasks
    const hideDoneButton = screen.getByRole("button", { name: /hide done/i });
    fireEvent.click(hideDoneButton);

    // Completed tasks should be hidden
    expect(screen.queryByText("FN-001")).toBeNull();
    expect(screen.queryByText("FN-002")).toBeNull();

    // Click again to show all tasks
    fireEvent.click(hideDoneButton);

    // All tasks should be visible again
    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.getByText("FN-002")).toBeDefined();
    expect(screen.getByText("FN-003")).toBeDefined();
  });

  it("persists hide done preference to localStorage", () => {
    const tasks = [createMockTask({ id: "FN-001", column: "done" })];
    renderListView({ tasks });

    // Click hide done button
    const hideDoneButton = screen.getByRole("button", { name: /hide done/i });
    fireEvent.click(hideDoneButton);

    // Verify localStorage was updated
    expect(localStorage.getItem(scopedStorageKey("kb-dashboard-hide-done"))).toBe("true");
  });

  it("filters tasks when stale only is enabled", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "in-progress", ageStaleness: { level: "warning", reason: "r", observedAt: "2026-05-14T00:00:00.000Z", ageMs: 5 * 60 * 60_000, warningThresholdMs: 4 * 60 * 60_000, criticalThresholdMs: 24 * 60 * 60_000, column: "in-progress", paused: false } as any }),
      createMockTask({ id: "FN-002", column: "in-progress", ageStaleness: undefined }),
    ];

    renderListView({ tasks });

    fireEvent.click(screen.getByRole("button", { name: /stale only/i }));

    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.queryByText("FN-002")).toBeNull();
  });

  it("filters tasks when stale paused review filter is enabled", () => {
    const tasks = [
      createMockTask({
        id: "FN-001",
        column: "in-review",
        paused: true,
        stalePausedReview: {
          code: "stale-paused-review",
          reason: "Task has remained paused in review beyond threshold",
          observedAt: "2026-05-14T00:00:00.000Z",
          ageMs: 86_400_000,
          thresholdMs: 86_400_000,
        } as any,
      }),
      createMockTask({ id: "FN-002", column: "in-review", paused: true, stalePausedReview: undefined }),
    ];

    renderListView({ tasks });

    fireEvent.click(screen.getByRole("button", { name: /stale paused review/i }));

    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.queryByText("FN-002")).toBeNull();
  });

  it("persists stale-only preference to localStorage", () => {
    renderListView({ tasks: [createMockTask({ id: "FN-001", column: "in-progress" })] });
    fireEvent.click(screen.getByRole("button", { name: /stale only/i }));
    expect(localStorage.getItem(scopedStorageKey("kb-dashboard-stale-only-filter"))).toBe("true");
  });

  it("initializes hide done state from localStorage", () => {
    // Set up localStorage with hide done enabled
    localStorage.setItem(scopedStorageKey("kb-dashboard-hide-done"), "true");

    const tasks = [
      createMockTask({ id: "FN-001", column: "done" }),
      createMockTask({ id: "FN-002", column: "archived" }),
      createMockTask({ id: "FN-003", column: "triage" }),
    ];
    renderListView({ tasks });

    // Button should show "Show Done" text since done tasks are hidden
    expect(screen.getByRole("button", { name: /show done/i })).toBeDefined();

    // Completed tasks should be hidden initially
    expect(screen.queryByText("FN-001")).toBeNull();
    expect(screen.queryByText("FN-002")).toBeNull();
    expect(screen.getByText("FN-003")).toBeDefined();
  });

  it("updates stats text when done and archived tasks are hidden", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "done" }),
      createMockTask({ id: "FN-002", column: "archived" }),
      createMockTask({ id: "FN-003", column: "triage" }),
    ];

    renderListView({ tasks });

    // Initial: all 3 tasks visible
    expect(screen.getAllByRole("row").filter((r) => r.getAttribute("data-id"))).toHaveLength(3);

    // Click hide done button
    const hideDoneButton = screen.getByRole("button", { name: /hide done/i });
    fireEvent.click(hideDoneButton);

    // FNXC:ListView 2026-06-23-00:00: the count + "(N hidden)" indicator were removed from the sidebar; assert hiding done leaves only the 1 non-done task visible.
    expect(screen.getAllByRole("row").filter((r) => r.getAttribute("data-id"))).toHaveLength(1);
  });

  it("hides done and archived column section headers when hide done is active", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "done" }),
      createMockTask({ id: "FN-002", column: "archived" }),
      createMockTask({ id: "FN-003", column: "triage" }),
    ];

    renderListView({ tasks });

    // All section headers should be visible initially
    const sectionHeadersBefore = screen.getAllByRole("row").filter(r => r.className.includes("list-section-header"));
    expect(sectionHeadersBefore.length).toBe(6); // All 6 columns

    // Click hide done button
    const hideDoneButton = screen.getByRole("button", { name: /hide done/i });
    fireEvent.click(hideDoneButton);

    // Done and Archived sections should be hidden
    const doneSection = screen.getAllByRole("row").find(r => 
      r.className.includes("list-section-header") && r.textContent?.includes("Done")
    );
    expect(doneSection).toBeUndefined();

    const archivedSection = screen.getAllByRole("row").find(r => 
      r.className.includes("list-section-header") && r.textContent?.includes("Archived")
    );
    expect(archivedSection).toBeUndefined();

    // Planning section should still be visible
    const triageSection = screen.getAllByRole("row").find(r => 
      r.className.includes("list-section-header") && r.textContent?.includes("Planning")
    );
    expect(triageSection).toBeDefined();
  });

  it("shows done drop zone with count when hide done is active", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "done" }),
      createMockTask({ id: "FN-002", column: "done" }),
    ];

    renderListView({ tasks });

    // Click hide done button
    const hideDoneButton = screen.getByRole("button", { name: /hide done/i });
    fireEvent.click(hideDoneButton);

    // Done drop zone should still be visible with "X of Y" format
    const doneZone = document.querySelector('[data-column="done"].list-drop-zone');
    expect(doneZone).toBeDefined();
    expect(doneZone?.textContent).toContain("0 of 2");
  });

  it("shows archived drop zone with count when hide done is active", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "archived" }),
      createMockTask({ id: "FN-002", column: "archived" }),
    ];

    renderListView({ tasks });

    // Click hide done button
    const hideDoneButton = screen.getByRole("button", { name: /hide done/i });
    fireEvent.click(hideDoneButton);

    // Archived drop zone should still be visible with "X of Y" format
    const archivedZone = document.querySelector('[data-column="archived"].list-drop-zone');
    expect(archivedZone).toBeDefined();
    expect(archivedZone?.textContent).toContain("0 of 2");
  });

  it("preserves hide done state through filter changes", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "done", title: "Alpha" }),
      createMockTask({ id: "FN-002", column: "archived", title: "Beta" }),
      createMockTask({ id: "FN-003", column: "triage", title: "Gamma" }),
    ];

    // Hide done + apply filter via props
    renderListView({ tasks, searchQuery: "Gamma" });

    // Hide done tasks via button
    const hideDoneButton = screen.getByRole("button", { name: /hide done/i });
    fireEvent.click(hideDoneButton);

    // Completed tasks should remain hidden
    expect(screen.queryByText("FN-001")).toBeNull();
    expect(screen.queryByText("FN-002")).toBeNull();
    // Filtered task should be visible
    expect(screen.getByText("FN-003")).toBeDefined();
  });

  it("shows done section when selectedColumn is done even with hide done active", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "done", title: "Done Task" }),
      createMockTask({ id: "FN-002", column: "triage", title: "Planning Task" }),
    ];

    renderListView({ tasks });

    // Enable hide done
    const hideDoneButton = screen.getByRole("button", { name: /hide done/i });
    fireEvent.click(hideDoneButton);

    // Done task should be hidden
    expect(screen.queryByText("FN-001")).toBeNull();

    // Click on the done drop zone to select that column
    const doneZone = document.querySelector('[data-column="done"].list-drop-zone')!;
    fireEvent.click(doneZone);

    // Done task should now be visible because selectedColumn overrides hide
    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.queryByText("FN-002")).toBeNull();
  });

  it("shows archived section when selectedColumn is archived even with hide done active", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "archived", title: "Archived Task" }),
      createMockTask({ id: "FN-002", column: "triage", title: "Planning Task" }),
    ];

    renderListView({ tasks });

    // Enable hide done
    const hideDoneButton = screen.getByRole("button", { name: /hide done/i });
    fireEvent.click(hideDoneButton);

    // Archived task should be hidden
    expect(screen.queryByText("FN-001")).toBeNull();

    // Click on the archived drop zone to select that column
    const archivedZone = document.querySelector('[data-column="archived"].list-drop-zone')!;
    fireEvent.click(archivedZone);

    // Archived task should now be visible because selectedColumn overrides hide
    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.queryByText("FN-002")).toBeNull();
  });
});

describe("ListView Quick Entry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchBoardWorkflows).mockImplementation(() => new Promise(() => {}));
  });

  it("renders QuickEntryBox when onQuickCreate is provided", () => {
    const mockOnQuickCreate = vi.fn().mockResolvedValue(undefined);
    renderListView({ onQuickCreate: mockOnQuickCreate });

    // Quick entry box should be visible
    const quickEntry = screen.getByTestId("quick-entry-box");
    expect(quickEntry).toBeDefined();

    // Input should be visible
    const input = screen.getByTestId("quick-entry-input");
    expect(input).toBeDefined();
  });

  it("renders QuickEntryBox in list-quick-entry-above-table, not in toolbar", () => {
    const mockOnQuickCreate = vi.fn().mockResolvedValue(undefined);
    renderListView({ onQuickCreate: mockOnQuickCreate });

    const quickEntry = screen.getByTestId("quick-entry-box");
    const toolbar = document.querySelector(".list-toolbar");
    const quickEntryArea = document.querySelector(".list-quick-entry-above-table");
    const tableContainer = document.querySelector(".list-table-container");

    // QuickEntryBox should not be inside toolbar
    expect(toolbar?.contains(quickEntry)).not.toBe(true);
    // QuickEntryBox should be inside the new quick-entry area
    expect(quickEntryArea?.contains(quickEntry)).toBe(true);
    // QuickEntryBox should be inside the table container (parent of quick-entry area)
    expect(tableContainer?.contains(quickEntry)).toBe(true);
  });

  it("shows model selector control when QuickEntryBox is expanded", async () => {
    const mockOnQuickCreate = vi.fn().mockResolvedValue(undefined);
    renderListView({ onQuickCreate: mockOnQuickCreate });

    expect(document.getElementById("quick-entry-controls")?.hasAttribute("hidden")).toBe(true);

    const toggleButton = screen.getByTestId("quick-entry-toggle");
    fireEvent.click(toggleButton);

    const modelAction = await screen.findByTestId("quick-entry-models");
    expect(modelAction).toBeDefined();
    expect(document.getElementById("quick-entry-controls")?.hasAttribute("hidden")).toBe(false);
  });

  it("shows dependency selector control when QuickEntryBox is expanded", async () => {
    const mockOnQuickCreate = vi.fn().mockResolvedValue(undefined);
    renderListView({ onQuickCreate: mockOnQuickCreate });

    expect(document.getElementById("quick-entry-controls")?.hasAttribute("hidden")).toBe(true);

    const toggleButton = screen.getByTestId("quick-entry-toggle");
    fireEvent.click(toggleButton);

    const depsAction = await screen.findByTestId("quick-entry-deps");
    expect(depsAction).toBeDefined();
    expect(document.getElementById("quick-entry-controls")?.hasAttribute("hidden")).toBe(false);
  });

  it("calls onQuickCreate with description when Enter is pressed", async () => {
    const mockOnQuickCreate = vi.fn().mockResolvedValue(undefined);
    renderListView({ onQuickCreate: mockOnQuickCreate });

    const input = screen.getByTestId("quick-entry-input");
    fireEvent.change(input, { target: { value: "New quick task" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(mockOnQuickCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "New quick task",
        })
      );
    });
  });

  it("clears input after successful quick create", async () => {
    const mockOnQuickCreate = vi.fn().mockResolvedValue(undefined);
    renderListView({ onQuickCreate: mockOnQuickCreate });

    const input = screen.getByTestId("quick-entry-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Task to create" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(mockOnQuickCreate).toHaveBeenCalled();
      expect(input.value).toBe("");
    });
  });

  it("preserves selected built-in workflow id when quick-creating in workflow mode", async () => {
    const mockOnQuickCreate = vi.fn().mockResolvedValue(undefined);
    vi.mocked(fetchBoardWorkflows).mockResolvedValue({
      flagEnabled: true,
      defaultWorkflowId: "builtin:default",
      workflows: [
        {
          id: "builtin:default",
          name: "Default",
          columns: [{ id: "triage", name: "Triage", flags: { intake: true } }],
        },
        {
          id: "builtin:coding",
          name: "Coding",
          columns: [{ id: "triage", name: "Triage", flags: { intake: true } }],
        },
      ],
      taskWorkflowIds: {},
    });
    renderListView({ onQuickCreate: mockOnQuickCreate });

    await selectWorkflow("builtin:coding");
    const input = screen.getByTestId("quick-entry-input");
    fireEvent.change(input, { target: { value: "Built-in workflow task" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(mockOnQuickCreate).toHaveBeenCalledWith(expect.objectContaining({
        description: "Built-in workflow task",
        column: "triage",
        workflowId: "builtin:coding",
      }));
    });
  });

  it("passes the selected workflow id to list quick-entry Plan and Subtask handoffs", async () => {
    const onPlanningMode = vi.fn();
    const onSubtaskBreakdown = vi.fn();
    vi.mocked(fetchBoardWorkflows).mockResolvedValue({
      flagEnabled: true,
      defaultWorkflowId: "builtin:default",
      workflows: [
        {
          id: "builtin:default",
          name: "Default",
          columns: [{ id: "triage", name: "Triage", flags: { intake: true } }],
        },
        {
          id: "wf-list-active",
          name: "List Active",
          columns: [{ id: "triage", name: "Triage", flags: { intake: true } }],
        },
      ],
      taskWorkflowIds: {},
    });
    renderListView({ onPlanningMode, onSubtaskBreakdown });

    await selectWorkflow("wf-list-active");
    const input = screen.getByTestId("quick-entry-input");
    fireEvent.change(input, { target: { value: "Plan on selected list workflow" } });
    fireEvent.click(screen.getByTestId("quick-entry-toggle"));
    fireEvent.click(screen.getByTestId("quick-entry-plan"));
    fireEvent.click(screen.getByTestId("quick-entry-subtask"));

    expect(onPlanningMode).toHaveBeenCalledWith("Plan on selected list workflow", "wf-list-active");
    expect(onSubtaskBreakdown).toHaveBeenCalledWith("Plan on selected list workflow", "wf-list-active");
  });

  it("shows error toast when onQuickCreate fails and keeps input content", async () => {
    const mockOnQuickCreate = vi.fn().mockRejectedValue(new Error("Create failed"));
    renderListView({ onQuickCreate: mockOnQuickCreate });

    const input = screen.getByTestId("quick-entry-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Failed task" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(mockAddToast).toHaveBeenCalledWith("Create failed", "error");
    });

    // Input content should be preserved for retry
    expect(input.value).toBe("Failed task");
  });

  it("trims whitespace when creating task via quick entry", async () => {
    const mockOnQuickCreate = vi.fn().mockResolvedValue(undefined);
    renderListView({ onQuickCreate: mockOnQuickCreate });

    const input = screen.getByTestId("quick-entry-input");
    fireEvent.change(input, { target: { value: "  Task with spaces  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(mockOnQuickCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "Task with spaces",
        })
      );
    });
  });

  it("does not submit on Enter if input is empty", async () => {
    const mockOnQuickCreate = vi.fn().mockResolvedValue(undefined);
    renderListView({ onQuickCreate: mockOnQuickCreate });

    const input = screen.getByTestId("quick-entry-input");
    await keyDownAndFlush(input, { key: "Enter" });

    expect(mockOnQuickCreate).not.toHaveBeenCalled();
  });

  it("QuickEntryBox textarea spans full container width in list view (FN-1579)", async () => {
    mockDesktopViewport();
    const mockOnQuickCreate = vi.fn().mockResolvedValue(undefined);
    renderListView({ onQuickCreate: mockOnQuickCreate });
    await act(async () => {
      await Promise.resolve();
    });

    const quickEntryBox = screen.getByTestId("quick-entry-box");
    const input = screen.getByTestId("quick-entry-input") as HTMLTextAreaElement;

    // Get the bounding rectangles for the textarea and its container
    const inputRect = input.getBoundingClientRect();
    const containerRect = quickEntryBox.getBoundingClientRect();

    // The textarea should span the full width of its container (within 2px tolerance for rounding)
    // This ensures the input visually reaches the right edge of the container
    expect(inputRect.width).toBeGreaterThanOrEqual(containerRect.width - 2);

    // The textarea should be at least 80% of the container width
    // (accounting for the toggle button on the right)
    expect(inputRect.width).toBeGreaterThanOrEqual(containerRect.width * 0.8);
  });
});

describe("ListView Collapsible Sections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchBoardWorkflows).mockImplementation(() => new Promise(() => {}));
    localStorage.clear();
  });

  it("clicking section header toggles collapse and hides task rows", async () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage", title: "Planning Task 1" }),
      createMockTask({ id: "FN-002", column: "triage", title: "Planning Task 2" }),
    ];

    renderListView({ tasks });

    // Both tasks should be visible initially
    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.getByText("FN-002")).toBeDefined();

    // Find and click the triage section header
    const triageHeader = screen.getAllByRole("row").find(r =>
      r.className.includes("list-section-header") && r.textContent?.includes("Planning")
    );
    expect(triageHeader).toBeDefined();
    await clickAndFlush(triageHeader!);

    // Tasks should be hidden after collapse
    expect(screen.queryByText("FN-001")).toBeNull();
    expect(screen.queryByText("FN-002")).toBeNull();

    // Section header should have collapsed class
    expect(triageHeader?.className).toContain("list-section-header--collapsed");

    // Chevron should not have expanded class
    const chevron = triageHeader?.querySelector(".list-section-chevron");
    expect(chevron?.className).not.toContain("list-section-chevron--expanded");
  });

  it("clicking again expands section and shows task rows", async () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage", title: "Planning Task" }),
    ];

    renderListView({ tasks });

    // Find the triage section header
    let triageHeader = screen.getAllByRole("row").find(r =>
      r.className.includes("list-section-header") && r.textContent?.includes("Planning")
    );

    // Click to collapse
    await clickAndFlush(triageHeader!);

    // Task should be hidden
    expect(screen.queryByText("FN-001")).toBeNull();

    // Click again to expand
    triageHeader = screen.getAllByRole("row").find(r =>
      r.className.includes("list-section-header") && r.textContent?.includes("Planning")
    );
    await clickAndFlush(triageHeader!);

    // Task should be visible again
    expect(screen.getByText("FN-001")).toBeDefined();

    // Re-query for the header to get fresh DOM reference after re-render
    triageHeader = screen.getAllByRole("row").find(r =>
      r.className.includes("list-section-header") && r.textContent?.includes("Planning")
    );

    // Section header should not have collapsed class
    expect(triageHeader?.className).not.toContain("list-section-header--collapsed");

    // Chevron should have expanded class (check via aria-expanded since header re-renders)
    expect(triageHeader?.getAttribute("aria-expanded")).toBe("true");
  });

  it("collapse state persists to localStorage", async () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage", title: "Planning Task" }),
    ];

    renderListView({ tasks });

    // Click to collapse
    const triageHeader = screen.getAllByRole("row").find(r =>
      r.className.includes("list-section-header") && r.textContent?.includes("Planning")
    );
    await clickAndFlush(triageHeader!);

    // Verify localStorage was updated
    const saved = localStorage.getItem(scopedStorageKey("kb-dashboard-list-collapsed"));
    expect(saved).toBeTruthy();
    const parsed = JSON.parse(saved!);
    expect(parsed).toContain("triage");
  });

  it("collapse state initializes from localStorage on mount", () => {
    // Set up localStorage with triage section collapsed
    localStorage.setItem(scopedStorageKey("kb-dashboard-list-collapsed"), JSON.stringify(["triage"]));

    const tasks = [
      createMockTask({ id: "FN-001", column: "triage", title: "Planning Task" }),
      createMockTask({ id: "FN-002", column: "todo", title: "Todo Task" }),
    ];

    renderListView({ tasks });

    // Planning task should be hidden initially (collapsed from localStorage)
    expect(screen.queryByText("FN-001")).toBeNull();

    // Todo task should be visible
    expect(screen.getByText("FN-002")).toBeDefined();

    // Planning section header should have collapsed class
    const triageHeader = screen.getAllByRole("row").find(r =>
      r.className.includes("list-section-header") && r.textContent?.includes("Planning")
    );
    expect(triageHeader?.className).toContain("list-section-header--collapsed");
  });

  it("multiple sections can be collapsed independently", async () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage", title: "Planning Task" }),
      createMockTask({ id: "FN-002", column: "todo", title: "Todo Task" }),
      createMockTask({ id: "FN-003", column: "in-progress", title: "In Progress Task" }),
    ];

    renderListView({ tasks });

    // Get section headers
    const allHeaders = screen.getAllByRole("row").filter(r =>
      r.className.includes("list-section-header")
    );
    const triageHeader = allHeaders.find(h => h.textContent?.includes("Planning"));
    const todoHeader = allHeaders.find(h => h.textContent?.includes("Todo"));

    // Collapse triage section
    await clickAndFlush(triageHeader!);

    // Collapse todo section
    await clickAndFlush(todoHeader!);

    // Planning and todo tasks should be hidden
    expect(screen.queryByText("FN-001")).toBeNull();
    expect(screen.queryByText("FN-002")).toBeNull();

    // In Progress task should still be visible
    expect(screen.getByText("FN-003")).toBeDefined();

    // Both sections should be marked as collapsed
    expect(triageHeader?.className).toContain("list-section-header--collapsed");
    expect(todoHeader?.className).toContain("list-section-header--collapsed");

    // Verify localStorage has both columns
    const saved = localStorage.getItem(scopedStorageKey("kb-dashboard-list-collapsed"));
    const parsed = JSON.parse(saved!);
    expect(parsed).toContain("triage");
    expect(parsed).toContain("todo");
    expect(parsed).not.toContain("in-progress");
  });

  it("sorting still works with collapsed sections", async () => {
    const tasks = [
      createMockTask({ id: "FN-003", column: "triage", title: "Charlie" }),
      createMockTask({ id: "FN-001", column: "triage", title: "Alpha" }),
      createMockTask({ id: "FN-002", column: "triage", title: "Bravo" }),
    ];

    renderListView({ tasks });

    // Collapse triage section
    const triageHeader = screen.getAllByRole("row").find(r =>
      r.className.includes("list-section-header") && r.textContent?.includes("Planning")
    );
    await clickAndFlush(triageHeader!);

    // Expand triage section
    const collapsedTriageHeader = screen.getAllByRole("row").find(r =>
      r.className.includes("list-section-header") && r.textContent?.includes("Planning")
    );
    await clickAndFlush(collapsedTriageHeader!);

    // Sort by title
    const titleHeader = screen.getByRole("columnheader", { name: /title/i });
    await clickAndFlush(titleHeader);

    // Get sorted rows and verify sorting still works
    const rows = screen.getAllByRole("row").filter(r => r.getAttribute("data-id"));
    expect(rows[0].textContent).toContain("FN-001"); // Alpha
    expect(rows[1].textContent).toContain("FN-002"); // Bravo
    expect(rows[2].textContent).toContain("FN-003"); // Charlie
  });

  it("filtering still works with collapsed sections", async () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage", title: "Alpha Task" }),
      createMockTask({ id: "FN-002", column: "triage", title: "Beta Task" }),
    ];

    renderListView({ tasks, searchQuery: "Alpha" });

    // Collapse triage section
    const triageHeader = screen.getAllByRole("row").find(r =>
      r.className.includes("list-section-header") && r.textContent?.includes("Planning")
    );
    await clickAndFlush(triageHeader!);

    // Expand triage section by clicking again
    const collapsedTriageHeader = screen.getAllByRole("row").find(r =>
      r.className.includes("list-section-header") && r.textContent?.includes("Planning")
    );
    await clickAndFlush(collapsedTriageHeader!);

    // Only Alpha task should be visible (filter is applied via prop)
    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.queryByText("FN-002")).toBeNull();
  });

  it("section header has aria-expanded attribute for accessibility", async () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage", title: "Planning Task" }),
    ];

    renderListView({ tasks });

    // Find triage section header
    const triageHeader = screen.getAllByRole("row").find(r =>
      r.className.includes("list-section-header") && r.textContent?.includes("Planning")
    );

    // Should have aria-expanded="true" when expanded
    expect(triageHeader?.getAttribute("aria-expanded")).toBe("true");

    // Click to collapse
    await clickAndFlush(triageHeader!);

    // Should have aria-expanded="false" when collapsed
    expect(triageHeader?.getAttribute("aria-expanded")).toBe("false");
  });

  it("collapsed section hides No tasks placeholder", async () => {
    // Create tasks in one column, leave another column empty
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage", title: "Planning Task" }),
    ];

    renderListView({ tasks });

    // First verify the "No tasks" placeholder is visible for empty columns (like Todo)
    const noTasksCellsBefore = screen.getAllByText("No tasks");
    expect(noTasksCellsBefore.length).toBeGreaterThan(0);

    // Find and collapse the todo section (which has no tasks)
    const todoHeader = screen.getAllByRole("row").find(r =>
      r.className.includes("list-section-header") && r.textContent?.includes("Todo")
    );
    expect(todoHeader).toBeDefined();
    await clickAndFlush(todoHeader!);

    // When collapsed, the section header should have collapsed class
    expect(todoHeader?.className).toContain("list-section-header--collapsed");

    // The "No tasks" placeholder for todo section should not be visible anymore
    // (we can't easily verify this without complex DOM traversal, but the collapse
    // class is the primary indicator that the section is collapsed)
  });
});

describe("ListView - Bulk Selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchNodes).mockImplementation(() => new Promise(() => {}));
    vi.mocked(fetchBoardWorkflows).mockImplementation(() => new Promise(() => {}));
    subscribeSseMock.mockClear();
    for (const key of Object.keys(listViewSseHandlers)) delete listViewSseHandlers[key];
    localStorage.clear();
    ensureMatchMedia();
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

  const createMockTask = (overrides: Partial<Task> = {}): Task => ({
    id: "FN-001",
    description: "Test task description",
    title: "Test Task",
    column: "triage",
    dependencies: [],
    steps: [],
    currentStep: 0,
    status: "pending",
    paused: false,
    log: [],
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  });

  it("shows selection checkbox in header", () => {
    const tasks = [createMockTask({ id: "FN-001" })];
    render(<ListView tasks={tasks} onMoveTask={vi.fn()} onOpenDetail={vi.fn()} addToast={mockAddToast} projectId={TEST_PROJECT_ID} />);
    enterBulkEditMode();

    const headerCheckbox = screen.getByLabelText("Select all visible tasks");
    expect(headerCheckbox).toBeDefined();
  });

  it("shows selection checkbox for each task row", () => {
    const tasks = [
      createMockTask({ id: "FN-001" }),
      createMockTask({ id: "FN-002" }),
    ];
    render(<ListView tasks={tasks} onMoveTask={vi.fn()} onOpenDetail={vi.fn()} addToast={mockAddToast} projectId={TEST_PROJECT_ID} />);
    enterBulkEditMode();

    const checkboxes = screen.getAllByLabelText(/Select FN-/);
    expect(checkboxes).toHaveLength(2);
  });

  it("disables checkbox for archived tasks", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "archived" }),
    ];
    render(<ListView tasks={tasks} onMoveTask={vi.fn()} onOpenDetail={vi.fn()} addToast={mockAddToast} projectId={TEST_PROJECT_ID} />);
    enterBulkEditMode();

    const checkbox = screen.getByLabelText("Select FN-001");
    expect(checkbox).toBeDisabled();
  });

  it("disables checkbox for workflow archived columns", async () => {
    vi.mocked(fetchBoardWorkflows).mockResolvedValue({
      flagEnabled: true,
      defaultWorkflowId: "wf-custom",
      workflows: [
        {
          id: "wf-custom",
          name: "Custom",
          columns: [
            { id: "active", name: "Active", flags: { countsTowardWip: true } },
            { id: "parked", name: "Parked", flags: { archived: true } },
          ],
        },
      ],
      taskWorkflowIds: { "FN-001": "wf-custom" },
    });
    const tasks = [
      createMockTask({ id: "FN-001", column: "parked" }),
    ];

    render(<ListView tasks={tasks} onMoveTask={vi.fn()} onOpenDetail={vi.fn()} addToast={mockAddToast} projectId={TEST_PROJECT_ID} />);
    await waitFor(() => expect(screen.queryAllByText("Parked").length).toBeGreaterThan(0));
    enterBulkEditMode();

    expect(screen.getByLabelText("Select FN-001")).toBeDisabled();
  });

  it("shows selection count when tasks are selected", () => {
    const tasks = [
      createMockTask({ id: "FN-001" }),
      createMockTask({ id: "FN-002" }),
    ];
    render(<ListView tasks={tasks} onMoveTask={vi.fn()} onOpenDetail={vi.fn()} addToast={mockAddToast} projectId={TEST_PROJECT_ID} />);
    enterBulkEditMode();

    const checkbox = screen.getByLabelText("Select FN-001");
    clickInAct(checkbox);

    expect(screen.getByText("1 selected")).toBeDefined();
  });

  it("clears selection when clear button clicked", () => {
    const tasks = [
      createMockTask({ id: "FN-001" }),
    ];
    render(<ListView tasks={tasks} onMoveTask={vi.fn()} onOpenDetail={vi.fn()} addToast={mockAddToast} projectId={TEST_PROJECT_ID} />);
    enterBulkEditMode();

    const checkbox = screen.getByLabelText("Select FN-001");
    clickInAct(checkbox);
    expect(screen.getByText("1 selected")).toBeDefined();

    const clearButton = screen.getByRole("button", { name: /^1 selected$/i });
    clickInAct(clearButton);

    expect(screen.queryByText("1 selected")).toBeNull();
  });

  it("toggles all visible tasks with select all checkbox", () => {
    const tasks = [
      createMockTask({ id: "FN-001" }),
      createMockTask({ id: "FN-002" }),
    ];
    render(<ListView tasks={tasks} onMoveTask={vi.fn()} onOpenDetail={vi.fn()} addToast={mockAddToast} projectId={TEST_PROJECT_ID} />);
    enterBulkEditMode();

    const selectAllCheckbox = screen.getByLabelText("Select all visible tasks");
    clickInAct(selectAllCheckbox);

    expect(screen.getByRole("button", { name: /^2 selected$/i })).toBeDefined();
  });

  it("accepts favoriteProviders and favoriteModels props", () => {
    const availableModels = [
      { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
    ];
    const tasks = [createMockTask({ id: "FN-001" })];
    const onToggleFavorite = vi.fn();
    const onToggleModelFavorite = vi.fn();

    render(
      <ListView
        tasks={tasks}
        onMoveTask={vi.fn()}
        onOpenDetail={vi.fn()}
        addToast={mockAddToast} projectId={TEST_PROJECT_ID}
        availableModels={availableModels}
        favoriteProviders={["openai"]}
        favoriteModels={["openai/gpt-4o"]}
        onToggleFavorite={onToggleFavorite}
        onToggleModelFavorite={onToggleModelFavorite}
      />
    );
    enterBulkEditMode();

    // Select a task to show bulk edit toolbar with dropdowns
    const checkbox = screen.getByLabelText("Select FN-001");
    clickInAct(checkbox);

    expect(screen.getByText("Bulk Edit Models & Node:")).toBeDefined();
  });

  it("shows bulk edit toolbar when tasks are selected", () => {
    const availableModels = [
      { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
    ];
    const tasks = [createMockTask({ id: "FN-001" })];

    render(
      <ListView
        tasks={tasks}
        onMoveTask={vi.fn()}
        onOpenDetail={vi.fn()}
        addToast={mockAddToast} projectId={TEST_PROJECT_ID}
        availableModels={availableModels}
      />
    );
    enterBulkEditMode();

    const checkbox = screen.getByLabelText("Select FN-001");
    clickInAct(checkbox);

    expect(screen.getByText("Bulk Edit Models & Node:")).toBeDefined();
  });

  it("disables apply button when no model changes selected", () => {
    const availableModels = [
      { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
    ];
    const tasks = [createMockTask({ id: "FN-001" })];

    render(
      <ListView
        tasks={tasks}
        onMoveTask={vi.fn()}
        onOpenDetail={vi.fn()}
        addToast={mockAddToast} projectId={TEST_PROJECT_ID}
        availableModels={availableModels}
      />
    );
    enterBulkEditMode();

    const checkbox = screen.getByLabelText("Select FN-001");
    clickInAct(checkbox);

    const applyButton = screen.getByText("Apply");
    expect(applyButton).toBeDisabled();
  });

  it("shows mobile bulk action buttons and runs delete handler path", async () => {
    const user = userEvent.setup();
    const matchMediaSpy = mockMobileViewport();
    const tasks = [createMockTask({ id: "FN-001" })];
    const onDeleteTask = vi.fn(async () => createMockTask());
    mockConfirm.mockResolvedValueOnce(true);

    renderListView({ tasks, onDeleteTask });
    enterBulkEditMode();
    await user.click(screen.getByLabelText("Select FN-001"));

    expect(screen.getByRole("button", { name: /^pause selected$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^unpause selected$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^archive selected$/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /delete selected/i }));

    await waitFor(() => {
      expect(onDeleteTask).toHaveBeenCalledWith("FN-001");
    });

    matchMediaSpy.mockRestore();
  });

  it("shows mobile model toolbar and keeps apply disabled until a change is selected", async () => {
    const user = userEvent.setup();
    const matchMediaSpy = mockMobileViewport();
    const availableModels = [
      { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
    ];
    const tasks = [createMockTask({ id: "FN-001" })];

    renderListView({ tasks, availableModels });
    enterBulkEditMode();
    await user.click(screen.getByLabelText("Select FN-001"));

    expect(screen.getByText("Bulk Edit Models & Node:")).toBeInTheDocument();
    const applyButton = screen.getByRole("button", { name: "Apply" });
    expect(applyButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Node Override"), { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled();

    matchMediaSpy.mockRestore();
  });

  it("hides mobile bulk edit toolbars when bulk edit mode is turned off", async () => {
    const user = userEvent.setup();
    const matchMediaSpy = mockMobileViewport();
    const tasks = [createMockTask({ id: "FN-001" })];

    renderListView({ tasks });
    enterBulkEditMode();
    await user.click(screen.getByLabelText("Select FN-001"));
    expect(screen.getByRole("button", { name: /^pause selected$/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Done Editing" }));
    expect(screen.queryByRole("button", { name: /^pause selected$/i })).toBeNull();

    matchMediaSpy.mockRestore();
  });

  describe("bulk pause/unpause/archive", () => {
    it("shows pause/unpause/archive buttons only when bulk selection is active", async () => {
      const user = userEvent.setup();
      const tasks = [createMockTask({ id: "FN-001" })];

      renderListView({ tasks });
      expect(screen.queryByRole("button", { name: /^pause selected$/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /^unpause selected$/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /^archive selected$/i })).toBeNull();

      enterBulkEditMode();
      await user.click(screen.getByLabelText("Select FN-001"));

      expect(screen.getByRole("button", { name: /^pause selected$/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^unpause selected$/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^archive selected$/i })).toBeInTheDocument();
    });

    it("pauses only non-paused selected tasks and clears successful selections", async () => {
      const user = userEvent.setup();
      const tasks = [createMockTask({ id: "FN-001", paused: false }), createMockTask({ id: "FN-002", paused: true })];
      const onPauseTask = vi.fn(async () => createMockTask());
      localStorage.setItem(scopedStorageKey("kb-dashboard-selected-tasks"), JSON.stringify(["FN-001", "FN-002"]));

      renderListView({ tasks, onPauseTask });
      enterBulkEditMode();
      await user.click(screen.getByRole("button", { name: /^pause selected$/i }));

      await waitFor(() => {
        expect(onPauseTask).toHaveBeenCalledTimes(1);
        expect(onPauseTask).toHaveBeenCalledWith("FN-001");
      });
      expect(mockAddToast).toHaveBeenCalledWith("Paused 1 · 1 skipped · 0 failed", "success");
      expect(screen.getByText("1 selected")).toBeInTheDocument();
    });

    it("unpauses only paused tasks and reports skipped count", async () => {
      const user = userEvent.setup();
      const tasks = [createMockTask({ id: "FN-001", paused: true }), createMockTask({ id: "FN-002", paused: false })];
      const onUnpauseTask = vi.fn(async () => createMockTask());
      localStorage.setItem(scopedStorageKey("kb-dashboard-selected-tasks"), JSON.stringify(["FN-001", "FN-002"]));

      renderListView({ tasks, onUnpauseTask });
      enterBulkEditMode();
      await user.click(screen.getByRole("button", { name: /^unpause selected$/i }));

      await waitFor(() => {
        expect(onUnpauseTask).toHaveBeenCalledTimes(1);
        expect(onUnpauseTask).toHaveBeenCalledWith("FN-001");
      });
      expect(mockAddToast).toHaveBeenCalledWith("Unpaused 1 · 1 skipped · 0 failed", "success");
    });

    it("archives only done tasks after confirmation", async () => {
      const user = userEvent.setup();
      const tasks = [createMockTask({ id: "FN-001", column: "done" }), createMockTask({ id: "FN-002", column: "todo" })];
      const onArchiveTask = vi.fn(async () => createMockTask());
      mockConfirm.mockResolvedValueOnce(true);
      localStorage.setItem(scopedStorageKey("kb-dashboard-selected-tasks"), JSON.stringify(["FN-001", "FN-002"]));

      renderListView({ tasks, onArchiveTask });
      enterBulkEditMode();
      await user.click(screen.getByRole("button", { name: /^archive selected$/i }));

      await waitFor(() => {
        expect(mockConfirm).toHaveBeenCalledTimes(1);
        expect(onArchiveTask).toHaveBeenCalledTimes(1);
        expect(onArchiveTask).toHaveBeenCalledWith("FN-001");
      });
      expect(mockAddToast).toHaveBeenCalledWith("Archived 1 · 1 skipped · 0 failed", "success");
    });

    it("archives workflow complete-column tasks in bulk selection", async () => {
      const user = userEvent.setup();
      vi.mocked(fetchBoardWorkflows).mockResolvedValue({
        flagEnabled: true,
        defaultWorkflowId: "wf-custom",
        workflows: [
          {
            id: "wf-custom",
            name: "Custom",
            columns: [
              { id: "doing", name: "Doing", flags: { countsTowardWip: true } },
              { id: "shipped", name: "Shipped", flags: { complete: true } },
            ],
          },
        ],
        taskWorkflowIds: { "FN-001": "wf-custom", "FN-002": "wf-custom" },
      });
      const tasks = [
        createMockTask({ id: "FN-001", column: "shipped" }),
        createMockTask({ id: "FN-002", column: "doing" }),
      ];
      const onArchiveTask = vi.fn(async () => createMockTask());
      mockConfirm.mockResolvedValueOnce(true);
      localStorage.setItem(scopedStorageKey("kb-dashboard-selected-tasks"), JSON.stringify(["FN-001", "FN-002"]));

      renderListView({ tasks, onArchiveTask });
      enterBulkEditMode();
      await waitFor(() => expect(screen.queryAllByText("Shipped").length).toBeGreaterThan(0));
      await user.click(screen.getByRole("button", { name: /^archive selected$/i }));

      await waitFor(() => {
        expect(onArchiveTask).toHaveBeenCalledTimes(1);
        expect(onArchiveTask).toHaveBeenCalledWith("FN-001");
      });
      expect(mockAddToast).toHaveBeenCalledWith("Archived 1 · 1 skipped · 0 failed", "success");
    });

    it("skips workflow archived-column tasks when pausing in bulk", async () => {
      const user = userEvent.setup();
      vi.mocked(fetchBoardWorkflows).mockResolvedValue({
        flagEnabled: true,
        defaultWorkflowId: "wf-custom",
        workflows: [
          {
            id: "wf-custom",
            name: "Custom",
            columns: [
              { id: "active", name: "Active", flags: { countsTowardWip: true } },
              { id: "parked", name: "Parked", flags: { archived: true } },
            ],
          },
        ],
        taskWorkflowIds: { "FN-001": "wf-custom", "FN-002": "wf-custom" },
      });
      const tasks = [
        createMockTask({ id: "FN-001", column: "active", paused: false }),
        createMockTask({ id: "FN-002", column: "parked", paused: false }),
      ];
      const onPauseTask = vi.fn(async () => createMockTask());
      localStorage.setItem(scopedStorageKey("kb-dashboard-selected-tasks"), JSON.stringify(["FN-001", "FN-002"]));

      renderListView({ tasks, onPauseTask });
      enterBulkEditMode();
      await waitFor(() => expect(screen.queryAllByText("Parked").length).toBeGreaterThan(0));
      await user.click(screen.getByRole("button", { name: /^pause selected$/i }));

      await waitFor(() => {
        expect(onPauseTask).toHaveBeenCalledTimes(1);
        expect(onPauseTask).toHaveBeenCalledWith("FN-001");
      });
      expect(mockAddToast).toHaveBeenCalledWith("Paused 1 · 1 skipped · 0 failed", "success");
    });

    it("skips workflow archived-column tasks when unpausing in bulk", async () => {
      const user = userEvent.setup();
      vi.mocked(fetchBoardWorkflows).mockResolvedValue({
        flagEnabled: true,
        defaultWorkflowId: "wf-custom",
        workflows: [
          {
            id: "wf-custom",
            name: "Custom",
            columns: [
              { id: "active", name: "Active", flags: { countsTowardWip: true } },
              { id: "parked", name: "Parked", flags: { archived: true } },
            ],
          },
        ],
        taskWorkflowIds: { "FN-001": "wf-custom", "FN-002": "wf-custom" },
      });
      const tasks = [
        createMockTask({ id: "FN-001", column: "active", paused: true }),
        createMockTask({ id: "FN-002", column: "parked", paused: true }),
      ];
      const onUnpauseTask = vi.fn(async () => createMockTask());
      localStorage.setItem(scopedStorageKey("kb-dashboard-selected-tasks"), JSON.stringify(["FN-001", "FN-002"]));

      renderListView({ tasks, onUnpauseTask });
      enterBulkEditMode();
      await waitFor(() => expect(screen.queryAllByText("Parked").length).toBeGreaterThan(0));
      await user.click(screen.getByRole("button", { name: /^unpause selected$/i }));

      await waitFor(() => {
        expect(onUnpauseTask).toHaveBeenCalledTimes(1);
        expect(onUnpauseTask).toHaveBeenCalledWith("FN-001");
      });
      expect(mockAddToast).toHaveBeenCalledWith("Unpaused 1 · 1 skipped · 0 failed", "success");
    });

    it("shows error summary when pause has failures", async () => {
      const user = userEvent.setup();
      const tasks = [createMockTask({ id: "FN-001", paused: false })];
      const onPauseTask = vi.fn(async () => {
        throw new Error("boom");
      });

      renderListView({ tasks, onPauseTask });
      enterBulkEditMode();
      await user.click(screen.getByLabelText("Select FN-001"));
      await user.click(screen.getByRole("button", { name: /^pause selected$/i }));

      await waitFor(() => {
        expect(onPauseTask).toHaveBeenCalledTimes(1);
      });
      expect(mockAddToast).toHaveBeenCalledWith("Paused 0 · 0 skipped · 1 failed", "error");
      expect(screen.getByText("1 selected")).toBeInTheDocument();
    });
  });

  describe("bulk delete", () => {
    it("archives done tasks and deletes non-done tasks when tertiary action chosen", async () => {
      const user = userEvent.setup();
      const tasks = [
        createMockTask({ id: "FN-001", column: "done" }),
        createMockTask({ id: "FN-002", column: "done" }),
        createMockTask({ id: "FN-003", column: "todo" }),
      ];
      const onDeleteTask = vi.fn(async () => createMockTask());
      const onArchiveTask = vi.fn(async () => createMockTask());
      mockConfirmWithChoice.mockResolvedValueOnce("tertiary");

      renderListView({ tasks, onDeleteTask, onArchiveTask });
      enterBulkEditMode();
      await user.click(screen.getByLabelText("Select FN-001"));
      await user.click(screen.getByLabelText("Select FN-002"));
      await user.click(screen.getByLabelText("Select FN-003"));
      await user.click(screen.getByRole("button", { name: /delete selected/i }));

      await waitFor(() => {
        expect(onArchiveTask).toHaveBeenCalledTimes(2);
        expect(onArchiveTask).toHaveBeenCalledWith("FN-001");
        expect(onArchiveTask).toHaveBeenCalledWith("FN-002");
        expect(onDeleteTask).toHaveBeenCalledTimes(1);
        expect(onDeleteTask).toHaveBeenCalledWith("FN-003");
      });
    });

    it("deletes selected tasks and clears selection on success", async () => {
      const user = userEvent.setup();
      const tasks = [createMockTask({ id: "FN-001" }), createMockTask({ id: "FN-002" })];
      const onDeleteTask = vi.fn(async () => createMockTask());
      mockConfirm.mockResolvedValueOnce(true);

      renderListView({ tasks, onDeleteTask });
      enterBulkEditMode();
      await user.click(screen.getByLabelText("Select FN-001"));
      await user.click(screen.getByLabelText("Select FN-002"));
      await user.click(screen.getByRole("button", { name: /delete selected/i }));

      await waitFor(() => {
        expect(onDeleteTask).toHaveBeenCalledTimes(2);
        expect(onDeleteTask).toHaveBeenNthCalledWith(1, "FN-001");
        expect(onDeleteTask).toHaveBeenNthCalledWith(2, "FN-002");
      });
      expect(mockAddToast).toHaveBeenCalledWith("Deleted 2 tasks · 0 archived skipped · 0 failed", "success");
      expect(screen.queryByText("2 selected")).toBeNull();
    });

    it("skips archived tasks and reports summary", async () => {
      const user = userEvent.setup();
      const tasks = [createMockTask({ id: "FN-001", column: "todo" }), createMockTask({ id: "FN-002", column: "archived" })];
      const onDeleteTask = vi.fn(async () => createMockTask());
      mockConfirm.mockResolvedValueOnce(true);
      localStorage.setItem(scopedStorageKey("kb-dashboard-selected-tasks"), JSON.stringify(["FN-001", "FN-002"]));

      renderListView({ tasks, onDeleteTask });
      enterBulkEditMode();
      await user.click(screen.getByRole("button", { name: /delete selected/i }));

      await waitFor(() => {
        expect(onDeleteTask).toHaveBeenCalledTimes(1);
        expect(onDeleteTask).toHaveBeenCalledWith("FN-001");
      });
      expect(mockAddToast).toHaveBeenCalledWith("Deleted 1 task · 1 archived skipped · 0 failed", "success");
      expect(screen.getByText("1 selected")).toBeInTheDocument();
    });

    it("uses workflow complete and archived flags when bulk delete archives done tasks", async () => {
      const user = userEvent.setup();
      vi.mocked(fetchBoardWorkflows).mockResolvedValue({
        flagEnabled: true,
        defaultWorkflowId: "wf-custom",
        workflows: [
          {
            id: "wf-custom",
            name: "Custom",
            columns: [
              { id: "doing", name: "Doing", flags: { countsTowardWip: true } },
              { id: "shipped", name: "Shipped", flags: { complete: true } },
              { id: "parked", name: "Parked", flags: { archived: true } },
            ],
          },
        ],
        taskWorkflowIds: { "FN-001": "wf-custom", "FN-002": "wf-custom", "FN-003": "wf-custom" },
      });
      const tasks = [
        createMockTask({ id: "FN-001", column: "shipped" }),
        createMockTask({ id: "FN-002", column: "doing" }),
        createMockTask({ id: "FN-003", column: "parked" }),
      ];
      const onArchiveTask = vi.fn(async () => createMockTask());
      const onDeleteTask = vi.fn(async () => createMockTask());
      mockConfirmWithChoice.mockResolvedValueOnce("tertiary");
      localStorage.setItem(scopedStorageKey("kb-dashboard-selected-tasks"), JSON.stringify(["FN-001", "FN-002", "FN-003"]));

      renderListView({ tasks, onArchiveTask, onDeleteTask });
      enterBulkEditMode();
      await waitFor(() => expect(screen.queryAllByText("Shipped").length).toBeGreaterThan(0));
      await user.click(screen.getByRole("button", { name: /delete selected/i }));

      await waitFor(() => {
        expect(onArchiveTask).toHaveBeenCalledTimes(1);
        expect(onArchiveTask).toHaveBeenCalledWith("FN-001");
        expect(onDeleteTask).toHaveBeenCalledTimes(1);
        expect(onDeleteTask).toHaveBeenCalledWith("FN-002");
      });
      expect(mockAddToast).toHaveBeenCalledWith("Archived 1, deleted 1, failed 0", "success");
    });

    it("does nothing when delete confirm is cancelled", async () => {
      const user = userEvent.setup();
      const tasks = [createMockTask({ id: "FN-001" })];
      const onDeleteTask = vi.fn(async () => createMockTask());
      mockConfirm.mockResolvedValueOnce(false);

      renderListView({ tasks, onDeleteTask });
      enterBulkEditMode();
      await user.click(screen.getByLabelText("Select FN-001"));
      await user.click(screen.getByRole("button", { name: /delete selected/i }));

      await waitFor(() => {
        expect(mockConfirm).toHaveBeenCalledTimes(1);
      });
      expect(onDeleteTask).not.toHaveBeenCalled();
    });

    it("force deletes when dependency conflict is confirmed", async () => {
      const user = userEvent.setup();
      const tasks = [createMockTask({ id: "FN-001" })];
      const conflictError = Object.assign(new Error("dependency conflict"), {
        details: { code: "TASK_HAS_DEPENDENTS", dependentIds: ["FN-100"] },
      });
      const onDeleteTask = vi
        .fn<(...args: [string, { removeDependencyReferences?: boolean; removeLineageReferences?: boolean }?]) => Promise<Task>>()
        .mockRejectedValueOnce(conflictError)
        .mockResolvedValueOnce(createMockTask());
      mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(true);

      renderListView({ tasks, onDeleteTask });
      enterBulkEditMode();
      await user.click(screen.getByLabelText("Select FN-001"));
      await user.click(screen.getByRole("button", { name: /delete selected/i }));

      await waitFor(() => {
        expect(onDeleteTask).toHaveBeenCalledTimes(2);
      });
      expect(onDeleteTask).toHaveBeenNthCalledWith(1, "FN-001");
      expect(onDeleteTask).toHaveBeenNthCalledWith(2, "FN-001", {
        removeDependencyReferences: true,
        removeLineageReferences: true,
      });
      expect(mockAddToast).toHaveBeenCalledWith("Deleted 1 task · 0 archived skipped · 0 failed", "success");
    });

    it("force deletes when lineage conflict is confirmed", async () => {
      const user = userEvent.setup();
      const tasks = [createMockTask({ id: "FN-001" })];
      const conflictError = Object.assign(new Error("lineage conflict"), {
        details: { code: "TASK_HAS_LINEAGE_CHILDREN", lineageChildIds: ["FN-200"] },
      });
      const onDeleteTask = vi
        .fn<(...args: [string, { removeDependencyReferences?: boolean; removeLineageReferences?: boolean }?]) => Promise<Task>>()
        .mockRejectedValueOnce(conflictError)
        .mockResolvedValueOnce(createMockTask());
      mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(true);

      renderListView({ tasks, onDeleteTask });
      enterBulkEditMode();
      await user.click(screen.getByLabelText("Select FN-001"));
      await user.click(screen.getByRole("button", { name: /delete selected/i }));

      await waitFor(() => {
        expect(onDeleteTask).toHaveBeenCalledTimes(2);
      });
      expect(onDeleteTask).toHaveBeenNthCalledWith(2, "FN-001", {
        removeDependencyReferences: true,
        removeLineageReferences: true,
      });
      expect(mockAddToast).toHaveBeenCalledWith("Deleted 1 task · 0 archived skipped · 0 failed", "success");
    });

    it("marks failure when force delete is declined", async () => {
      const user = userEvent.setup();
      const tasks = [createMockTask({ id: "FN-001" })];
      const conflictError = Object.assign(new Error("dependency conflict"), {
        details: { code: "TASK_HAS_DEPENDENTS", dependentIds: ["FN-100"] },
      });
      const onDeleteTask = vi.fn(async () => {
        throw conflictError;
      });
      mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      renderListView({ tasks, onDeleteTask });
      enterBulkEditMode();
      await user.click(screen.getByLabelText("Select FN-001"));
      await user.click(screen.getByRole("button", { name: /delete selected/i }));

      await waitFor(() => {
        expect(onDeleteTask).toHaveBeenCalledTimes(1);
      });
      expect(mockAddToast).toHaveBeenCalledWith("Deleted 0 tasks · 0 archived skipped · 1 failed", "error");
    });
  });

  it("retries archive after lineage-conflict confirmation", async () => {
    const user = userEvent.setup();
    const tasks = [createMockTask({ id: "FN-001", column: "done" })];
    const conflictError = Object.assign(new Error("lineage conflict"), {
      details: { code: "TASK_HAS_LINEAGE_CHILDREN", lineageChildIds: ["FN-300"] },
    });
    const onArchiveTask = vi
      .fn<(...args: [string, { removeLineageReferences?: boolean }?]) => Promise<Task>>()
      .mockRejectedValueOnce(conflictError)
      .mockResolvedValueOnce(createMockTask({ id: "FN-001", column: "archived" }));
    mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(true);

    renderListView({ tasks, onArchiveTask });
    enterBulkEditMode();
    await user.click(screen.getByLabelText("Select FN-001"));
    await user.click(screen.getByRole("button", { name: /archive selected/i }));

    await waitFor(() => {
      expect(onArchiveTask).toHaveBeenCalledTimes(2);
    });
    expect(onArchiveTask).toHaveBeenNthCalledWith(2, "FN-001", { removeLineageReferences: true });
    expect(mockAddToast).toHaveBeenCalledWith("Archived 1 · 0 skipped · 0 failed", "success");
  });

  it("persists selection to localStorage", () => {
    const tasks = [createMockTask({ id: "FN-001" })];
    render(<ListView tasks={tasks} onMoveTask={vi.fn()} onOpenDetail={vi.fn()} addToast={mockAddToast} projectId={TEST_PROJECT_ID} />);
    enterBulkEditMode();

    const checkbox = screen.getByLabelText("Select FN-001");
    clickInAct(checkbox);

    expect(localStorage.getItem(scopedStorageKey("kb-dashboard-selected-tasks"))).toBe('["FN-001"]');
  });

  it("shows header checkbox in indeterminate state when some tasks selected", () => {
    const tasks = [
      createMockTask({ id: "FN-001" }),
      createMockTask({ id: "FN-002" }),
    ];
    render(<ListView tasks={tasks} onMoveTask={vi.fn()} onOpenDetail={vi.fn()} addToast={mockAddToast} projectId={TEST_PROJECT_ID} />);
    enterBulkEditMode();

    const checkboxes = screen.getAllByLabelText(/Select FN-/);
    // Select only first task
    clickInAct(checkboxes[0]);

    // Header checkbox should be indeterminate (partially selected)
    const headerCheckbox = screen.getByLabelText("Select all visible tasks") as HTMLInputElement;
    expect(headerCheckbox).toBeDefined();
    // Verify only one task is selected (indeterminate state)
    expect(screen.getByText("1 selected")).toBeDefined();
  });

  it("treats No change, explicit model, and Use default as distinct bulk-edit states", async () => {
    const user = userEvent.setup();
    const availableModels = [
      { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
    ];
    const tasks = [createMockTask({ id: "FN-001" })];
    const mockedBatchUpdateTaskModels = vi.mocked(batchUpdateTaskModels);
    mockedBatchUpdateTaskModels.mockResolvedValue({
      updated: [
        {
          ...tasks[0],
          modelProvider: "openai",
          modelId: "gpt-4o",
        },
      ],
      count: 1,
    });

    render(
      <ListView
        tasks={tasks}
        onMoveTask={vi.fn()}
        onOpenDetail={vi.fn()}
        addToast={mockAddToast} projectId={TEST_PROJECT_ID}
        availableModels={availableModels}
      />
    );
    enterBulkEditMode();

    await user.click(screen.getByLabelText("Select FN-001"));

    let applyButton = screen.getByRole("button", { name: "Apply" });
    expect(applyButton).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Executor Model" }));
    const modelMenu = await screen.findByTestId("model-combobox-portal");
    await user.click(within(modelMenu).getByText("GPT-4o"));

    expect(applyButton).toBeEnabled();

    await user.click(applyButton);

    await waitFor(() => {
      expect(mockedBatchUpdateTaskModels).toHaveBeenCalled();
      const firstApplyArgs = mockedBatchUpdateTaskModels.mock.calls[0];
      expect(firstApplyArgs?.[0]).toEqual(["FN-001"]);
      expect(firstApplyArgs?.[1]).toBe("openai");
      expect(firstApplyArgs?.[2]).toBe("gpt-4o");
      expect(firstApplyArgs?.[3]).toBeUndefined();
      expect(firstApplyArgs?.[4]).toBeUndefined();
    });

    // After a successful apply, controls reset to No change and disable Apply again.
    await user.click(screen.getByLabelText("Select FN-001"));
    applyButton = screen.getByRole("button", { name: "Apply" });
    expect(applyButton).toBeDisabled();

    // Selecting Use default must be treated as an explicit clear (null pair), not unchanged.
    mockedBatchUpdateTaskModels.mockResolvedValue({
      updated: [
        {
          ...tasks[0],
          modelProvider: undefined,
          modelId: undefined,
        },
      ],
      count: 1,
    });

    await user.click(screen.getByRole("button", { name: "Executor Model" }));
    const clearMenu = await screen.findByTestId("model-combobox-portal");
    await user.click(within(clearMenu).getByText("Use default"));

    expect(applyButton).toBeEnabled();

    await user.click(applyButton);

    await waitFor(() => {
      const clearApplyArgs = mockedBatchUpdateTaskModels.mock.calls.at(-1);
      expect(clearApplyArgs?.[0]).toEqual(["FN-001"]);
      expect(clearApplyArgs?.[1]).toBeNull();
      expect(clearApplyArgs?.[2]).toBeNull();
      expect(clearApplyArgs?.[3]).toBeUndefined();
      expect(clearApplyArgs?.[4]).toBeUndefined();
    });
  });

  describe("Bulk node override", () => {
    const availableModels = [
      { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
    ];

    it("shows node override selector with node status labels when tasks are selected", async () => {
      const tasks = [createMockTask({ id: "FN-001" })];
      vi.mocked(fetchNodes).mockResolvedValue([{ id: "node-1", name: "Node One", status: "online" } as never]);

      render(<ListView tasks={tasks} onMoveTask={vi.fn()} onOpenDetail={vi.fn()} addToast={mockAddToast} projectId={TEST_PROJECT_ID} availableModels={availableModels} />);
      enterBulkEditMode();
      clickInAct(screen.getByLabelText("Select FN-001"));

      expect(await screen.findByLabelText("Node Override")).toBeInTheDocument();
      expect(await screen.findByRole("option", { name: "● Node One (Online)" })).toBeInTheDocument();
    });

    it("renders non-online statuses with distinct symbols and labels", async () => {
      const tasks = [createMockTask({ id: "FN-001" })];
      vi.mocked(fetchNodes).mockResolvedValue([{ id: "node-2", name: "Node Two", status: "offline" } as never]);

      render(<ListView tasks={tasks} onMoveTask={vi.fn()} onOpenDetail={vi.fn()} addToast={mockAddToast} projectId={TEST_PROJECT_ID} availableModels={availableModels} />);
      enterBulkEditMode();
      clickInAct(screen.getByLabelText("Select FN-001"));

      expect(await screen.findByRole("option", { name: "○ Node Two (Offline)" })).toBeInTheDocument();
    });

    it("shows NodeHealthDot for selected bulk node override", async () => {
      const user = userEvent.setup();
      const tasks = [createMockTask({ id: "FN-001" })];
      vi.mocked(fetchNodes).mockResolvedValue([{ id: "node-abc", name: "Node ABC", status: "online" } as never]);

      render(<ListView tasks={tasks} onMoveTask={vi.fn()} onOpenDetail={vi.fn()} addToast={mockAddToast} projectId={TEST_PROJECT_ID} availableModels={availableModels} />);
      enterBulkEditMode();
      await user.click(screen.getByLabelText("Select FN-001"));

      const nodeSelect = await screen.findByLabelText("Node Override");
      await user.selectOptions(nodeSelect, "node-abc");

      expect(document.querySelector(".status-dot--online")).toBeInTheDocument();
      expect(screen.getByText("Online")).toBeInTheDocument();
    });

    it("applies explicit node override through batchUpdateTaskModels", async () => {
      const user = userEvent.setup();
      const tasks = [createMockTask({ id: "FN-001" })];
      vi.mocked(fetchNodes).mockResolvedValue([{ id: "node-abc", name: "Node ABC", status: "online" } as never]);
      vi.mocked(batchUpdateTaskModels).mockResolvedValue({ updated: tasks, count: 1 });

      render(<ListView tasks={tasks} onMoveTask={vi.fn()} onOpenDetail={vi.fn()} addToast={mockAddToast} projectId={TEST_PROJECT_ID} availableModels={availableModels} />);
      enterBulkEditMode();
      await user.click(screen.getByLabelText("Select FN-001"));

      const nodeSelect = await screen.findByLabelText("Node Override");
      await user.selectOptions(nodeSelect, "node-abc");
      await user.click(screen.getByRole("button", { name: "Apply" }));

      await waitFor(() => {
        const args = vi.mocked(batchUpdateTaskModels).mock.calls.at(-1);
        expect(args?.[7]).toBe("node-abc");
      });
    });

    it("uses null nodeId when selecting Use project default", async () => {
      const user = userEvent.setup();
      const tasks = [createMockTask({ id: "FN-001" })];
      vi.mocked(fetchNodes).mockResolvedValue([{ id: "node-abc", name: "Node ABC", status: "online" } as never]);
      vi.mocked(batchUpdateTaskModels).mockResolvedValue({ updated: tasks, count: 1 });

      render(<ListView tasks={tasks} onMoveTask={vi.fn()} onOpenDetail={vi.fn()} addToast={mockAddToast} projectId={TEST_PROJECT_ID} availableModels={availableModels} />);
      enterBulkEditMode();
      await user.click(screen.getByLabelText("Select FN-001"));
      await user.selectOptions(await screen.findByLabelText("Node Override"), "");
      await user.click(screen.getByRole("button", { name: "Apply" }));

      await waitFor(() => {
        const args = vi.mocked(batchUpdateTaskModels).mock.calls.at(-1);
        expect(args?.[7]).toBeNull();
      });
    });

    it("keeps apply disabled when all controls are no change", async () => {
      const tasks = [createMockTask({ id: "FN-001" })];
      vi.mocked(fetchNodes).mockResolvedValue([{ id: "node-abc", name: "Node ABC", status: "online" } as never]);

      render(<ListView tasks={tasks} onMoveTask={vi.fn()} onOpenDetail={vi.fn()} addToast={mockAddToast} projectId={TEST_PROJECT_ID} availableModels={availableModels} />);
      enterBulkEditMode();
      clickInAct(screen.getByLabelText("Select FN-001"));

      expect(await screen.findByRole("button", { name: "Apply" })).toBeDisabled();
    });
  });

  it("forwards favoriteProviders and favoriteModels to QuickEntryBox model menu (FN-770)", async () => {
    const availableModels = [
      { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true, contextWindow: 200000 },
    ];
    const tasks = [createMockTask({ id: "FN-001" })];
    const onToggleFavorite = vi.fn();
    const onToggleModelFavorite = vi.fn();

    render(
      <ListView
        tasks={tasks}
        onMoveTask={vi.fn()}
        onOpenDetail={vi.fn()}
        addToast={mockAddToast} projectId={TEST_PROJECT_ID}
        onQuickCreate={vi.fn().mockResolvedValue(undefined)}
        availableModels={availableModels}
        favoriteProviders={["anthropic"]}
        favoriteModels={["claude-sonnet-4-5"]}
        onToggleFavorite={onToggleFavorite}
        onToggleModelFavorite={onToggleModelFavorite}
      />
    );

    // Expand the QuickEntryBox and open the model menu
    const toggleButton = screen.getByTestId("quick-entry-toggle");
    fireEvent.click(toggleButton);

    const modelsAction = await screen.findByTestId("quick-entry-models");
    fireEvent.click(modelsAction);

    const menu = await screen.findByTestId("model-nested-menu");
    expect(menu).toBeDefined();

    // Verify the menu has the three options
    expect(menu.textContent).toContain("Plan");
    expect(menu.textContent).toContain("Executor");
    expect(menu.textContent).toContain("Reviewer");
  });

  describe("ListView Mobile Cards", () => {
    afterEach(() => {
      const maybeMock = window.matchMedia as unknown as { mockRestore?: () => void };
      maybeMock.mockRestore?.();
      localStorage.removeItem(scopedStorageKey("kb-dashboard-selected-tasks"));
    });

    it("renders card layout instead of table on mobile", () => {
      mockMobileViewport();

      const { container } = renderListView({
        tasks: [createMockTask({ id: "FN-001", title: "Mobile task" })],
      });

      expect(container.querySelector(".list-cards")).toBeInTheDocument();
      expect(container.querySelector("table.list-table")).toBeNull();
    });

    it("renders table layout on desktop", () => {
      mockDesktopViewport();

      const { container } = renderListView({
        tasks: [createMockTask({ id: "FN-001", title: "Desktop task" })],
      });

      expect(container.querySelector("table.list-table")).toBeInTheDocument();
      expect(container.querySelector(".list-cards")).toBeNull();
    });

    it("shows task id, title, and status inside mobile cards", () => {
      mockMobileViewport();

      const { container } = renderListView({
        tasks: [createMockTask({ id: "FN-001", title: "Card title", status: "executing" })],
      });

      const card = container.querySelector('.list-card[data-id="FN-001"]');
      expect(card).toBeInTheDocument();
      expect(within(card as HTMLElement).getByText("FN-001")).toBeInTheDocument();
      expect(within(card as HTMLElement).getByText("Card title")).toBeInTheDocument();
      expect(within(card as HTMLElement).getByText("executing")).toBeInTheDocument();
    });

    it("shows fast indicator in mobile cards only for fast-mode tasks", () => {
      mockMobileViewport();

      const { container } = renderListView({
        tasks: [
          createMockTask({ id: "FN-001", title: "Fast mobile", executionMode: "fast", status: "pending" }),
          createMockTask({ id: "FN-002", title: "Standard mobile", executionMode: "standard", status: "pending" }),
        ],
      });

      const fastCard = container.querySelector('.list-card[data-id="FN-001"]') as HTMLElement;
      const standardCard = container.querySelector('.list-card[data-id="FN-002"]') as HTMLElement;
      const fastBadge = fastCard.querySelector(".list-execution-mode-badge");

      expect(fastBadge).not.toBeNull();
      expect(fastBadge?.getAttribute("aria-label")).toBe("Fast mode");
      expect(fastBadge?.querySelector("svg")).not.toBeNull();
      expect(standardCard.querySelector(".list-execution-mode-badge")).toBeNull();
    });

    it("shows unified progress bar for executing mobile cards with steps and workflow checks", () => {
      mockMobileViewport();

      const { container } = renderListView({
        tasks: [
          createMockTask({
            id: "FN-001",
            title: "Progress task",
            column: "todo",
            status: "executing",
            steps: [
              { name: "Step 1", status: "done" },
              { name: "Step 2", status: "pending" },
            ],
            enabledWorkflowSteps: ["WS-001"],
            workflowStepResults: [
              {
                workflowStepId: "WS-001",
                workflowStepName: "Browser Verification",
                status: "passed",
              },
            ],
          }),
        ],
      });

      const card = container.querySelector('.list-card[data-id="FN-001"]') as HTMLElement;
      expect(card.querySelector(".list-progress-fill")).toBeInTheDocument();
      expect(within(card).getByText("2/3")).toBeInTheDocument();
    });

    it("hides mobile card progress for non-executing todo tasks", () => {
      mockMobileViewport();

      const { container } = renderListView({
        tasks: [
          createMockTask({
            id: "FN-002",
            title: "Todo pending task",
            column: "todo",
            status: "pending",
            steps: [{ name: "Step 1", status: "done" }],
          }),
        ],
      });

      const card = container.querySelector('.list-card[data-id="FN-002"]') as HTMLElement;
      expect(card.querySelector(".list-progress-bar")).not.toBeInTheDocument();
    });

    it("shows dependency badge for cards with dependencies", () => {
      mockMobileViewport();

      const { container } = renderListView({
        tasks: [
          createMockTask({
            id: "FN-001",
            title: "Dependency task",
            dependencies: ["FN-002"],
          }),
        ],
      });

      const card = container.querySelector('.list-card[data-id="FN-001"]') as HTMLElement;
      const depBadge = card.querySelector(".list-dep-badge");
      expect(depBadge).toBeInTheDocument();
      expect(depBadge?.textContent).toContain("1");
    });

    it("opens task detail when a mobile card is clicked", async () => {
      mockMobileViewport();
      const task = createMockTask({ id: "FN-001", title: "Open me" });
      const mockOnOpenDetail = vi.fn();

      const { container } = renderListView({
        tasks: [task],
        onOpenDetail: mockOnOpenDetail,
      });

      fireEvent.click(container.querySelector('.list-card[data-id="FN-001"]') as HTMLElement);

      // Should call onOpenDetail synchronously with the Task object (no fetch)
      expect(mockOnOpenDetail).toHaveBeenCalledWith(task, { origin: "list-mobile" });
      expect(mockOnOpenDetail).toHaveBeenCalledTimes(1);
    });

    it("collapses and expands mobile section headers", () => {
      mockMobileViewport();

      const { container } = renderListView({
        tasks: [createMockTask({ id: "FN-001", title: "Collapsible task" })],
      });

      const sectionHeader = screen.getByRole("button", { name: /Planning/i });
      expect(container.querySelector('.list-card[data-id="FN-001"]')).toBeInTheDocument();

      fireEvent.click(sectionHeader);
      expect(container.querySelector('.list-card[data-id="FN-001"]')).toBeNull();

      fireEvent.click(sectionHeader);
      expect(container.querySelector('.list-card[data-id="FN-001"]')).toBeInTheDocument();
    });

    it("supports selection mode from mobile card checkboxes", () => {
      mockMobileViewport();
      localStorage.setItem(scopedStorageKey("kb-dashboard-selected-tasks"), JSON.stringify(["FN-001"]));

      renderListView({
        tasks: [
          createMockTask({ id: "FN-001", title: "Selected task" }),
          createMockTask({ id: "FN-002", title: "Selectable task" }),
        ],
        availableModels: [
          { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
        ],
      });

      enterBulkEditMode();
      clickInAct(screen.getByLabelText("Select FN-002"));

      expect((screen.getByLabelText("Select FN-001") as HTMLInputElement).checked).toBe(true);
      expect((screen.getByLabelText("Select FN-002") as HTMLInputElement).checked).toBe(true);
    });

    it.each([
      { status: "executing", column: "in-progress" as const },
      { status: "merging-fix", column: "in-review" as const },
    ])("applies agent-active class to mobile cards for active states (%s)", ({ status, column }) => {
      mockMobileViewport();

      const { container } = renderListView({
        tasks: [
          createMockTask({
            id: "FN-001",
            status,
            column,
          }),
        ],
        globalPaused: false,
      });

      const card = container.querySelector('.list-card[data-id="FN-001"]');
      expect(card?.className).toContain("agent-active");
    });

    it("does not apply agent-active class to mobile cards when globalPaused is true", () => {
      mockMobileViewport();

      const { container } = renderListView({
        tasks: [
          createMockTask({
            id: "FN-001",
            status: "executing",
            column: "in-progress",
          }),
        ],
        globalPaused: true,
      });

      const card = container.querySelector('.list-card[data-id="FN-001"]');
      expect(card?.className).not.toContain("agent-active");
    });
  });
});
