import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ListView } from "../ListView";
import type { MergeResult, Task } from "@fusion/core";
import { scopedKey } from "../../utils/projectStorage";

/*
FNXC:ListViewWindowing 2026-07-26-11:52:
Regression coverage for the List-view render window. Mobile browsers reclaim a backgrounded tab whose
resident set is large, which operators experience as a white-splash reload on return; rendering every
task row of a large project at once was a direct contributor. These tests pin the invariants the
window must not break — the filter runs over the FULL set with the window applied after, grouping and
section counts stay whole, and id-based selection survives a task falling outside the window.
*/

vi.mock("../../api", () => ({
  fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] }),
  fetchSettings: vi.fn().mockResolvedValue({}),
  fetchGlobalSettings: vi.fn().mockResolvedValue({}),
  fetchTaskDetail: vi.fn(),
  batchUpdateTaskModels: vi.fn(),
  fetchNodes: vi.fn(() => new Promise(() => {})),
  fetchBoardWorkflows: vi.fn(() => new Promise(() => {})),
  rebuildTaskSpec: vi.fn().mockResolvedValue({}),
  refreshPrStatus: vi.fn().mockResolvedValue({}),
  updateTask: vi.fn(),
  api: vi.fn().mockResolvedValue({ sessions: [] }),
}));

vi.mock("../../sse-bus", () => ({
  subscribeSse: () => () => {},
}));

vi.mock("../QuickEntryBox", () => ({
  QuickEntryBox: () => <div data-testid="quick-entry-box" />,
}));

vi.mock("../TaskDetailModal", () => ({
  TaskDetailContent: ({ task }: { task: { id: string } }) => (
    <div data-testid="task-detail-content">{task.id}</div>
  ),
}));

const confirmMocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  confirmWithChoice: vi.fn(),
}));

vi.mock("../../hooks/useConfirm", () => ({
  useConfirm: () => confirmMocks,
}));

const PROJECT_ID = "proj-windowing";
const TOTAL_TASKS = 200;
const INITIAL_WINDOW = 50;
const INCREMENT = 25;

function makeTask(index: number): Task {
  const id = `FN-${String(index).padStart(3, "0")}`;
  return {
    id,
    // Only one task carries the needle so search can be proven to reach past the window.
    title: index === 190 ? "Needle far outside the window" : `Task ${id}`,
    description: `Description for ${id}`,
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    status: "pending",
    paused: false,
    log: [],
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  } as Task;
}

// Sorted ascending by numeric id in the Todo column, so FN-190 is deterministically at index 189 —
// far outside the initial 50-row window.
const TASKS: Task[] = Array.from({ length: TOTAL_TASKS }, (_, i) => makeTask(i + 1));
const FAR_TASK_ID = "FN-190";

function renderList(props: Partial<React.ComponentProps<typeof ListView>> = {}) {
  return render(
    <ListView
      tasks={TASKS}
      onMoveTask={vi.fn(async () => TASKS[0])}
      onDeleteTask={vi.fn(async () => TASKS[0])}
      onMergeTask={vi.fn(async () => ({ merged: false }) as unknown as MergeResult)}
      onOpenDetail={vi.fn()}
      addToast={vi.fn()}
      projectId={PROJECT_ID}
      searchQuery=""
      {...props}
    />,
  );
}

function renderedTaskIds(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-id]"))
    .map((el) => el.dataset.id ?? "")
    .filter((id) => id.startsWith("FN-"));
}

beforeEach(() => {
  localStorage.clear();
  confirmMocks.confirm.mockReset();
  confirmMocks.confirm.mockResolvedValue(false);
  confirmMocks.confirmWithChoice.mockReset();
  confirmMocks.confirmWithChoice.mockResolvedValue("cancel");
});

describe("ListView render windowing", () => {
  it("renders only the initial window of a large section, not every task", () => {
    renderList();

    expect(renderedTaskIds()).toHaveLength(INITIAL_WINDOW);
    // The section header still reports the FULL group size — grouping is preserved.
    expect(screen.getByText(String(TOTAL_TASKS))).toBeTruthy();
    expect(screen.getByRole("button", { name: /Load 25 more/i })).toBeTruthy();
  });

  it("reveals the next increment when Load more is clicked", () => {
    renderList();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /Load 25 more/i }));
    });
    expect(renderedTaskIds()).toHaveLength(INITIAL_WINDOW + INCREMENT);

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /Load 25 more/i }));
    });
    expect(renderedTaskIds()).toHaveLength(INITIAL_WINDOW + INCREMENT * 2);
  });

  it("filters against the full set, so a match beyond the window is still found", () => {
    renderList({ searchQuery: "Needle" });

    const ids = renderedTaskIds();
    expect(ids).toEqual([FAR_TASK_ID]);
    // A single match needs no paging affordance.
    expect(screen.queryByRole("button", { name: /Load \d+ more/i })).toBeNull();
  });

  it("keeps a selected task outside the window selected and visible", () => {
    localStorage.setItem(scopedKey("kb-dashboard-list-selected-task", PROJECT_ID), FAR_TASK_ID);
    localStorage.setItem(
      scopedKey("kb-dashboard-selected-tasks", PROJECT_ID),
      JSON.stringify([FAR_TASK_ID]),
    );

    renderList();

    // Selection state is id-based and untouched by the window.
    expect(
      JSON.parse(localStorage.getItem(scopedKey("kb-dashboard-selected-tasks", PROJECT_ID)) ?? "[]"),
    ).toContain(FAR_TASK_ID);
    expect(localStorage.getItem(scopedKey("kb-dashboard-list-selected-task", PROJECT_ID))).toBe(FAR_TASK_ID);

    // ...and the window is widened so the persisted single selection is still rendered.
    expect(renderedTaskIds()).toContain(FAR_TASK_ID);
  });
});

/*
FNXC:ListViewSelectAll 2026-07-26-14:40:
The header checkbox says "Select all visible tasks" and arms DESTRUCTIVE bulk actions (delete, column
move). Render windowing made that label false: it flattened the full filtered set, so 50 rendered rows
armed 200 tasks. These cases pin the corrected contract at the point that matters — the count a bulk
action actually confirms — not merely at the internal selection state.
*/
describe("ListView select-all under render windowing", () => {
  function enterBulkEdit() {
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /Bulk Edit/i }));
    });
  }

  function selectAll() {
    act(() => {
      fireEvent.click(screen.getByLabelText("Select all visible tasks"));
    });
  }

  it("selects only the rendered window, not the whole filtered set", () => {
    renderList();
    enterBulkEdit();

    const rendered = renderedTaskIds();
    expect(rendered).toHaveLength(INITIAL_WINDOW);

    selectAll();

    const persisted: string[] = JSON.parse(
      localStorage.getItem(scopedKey("kb-dashboard-selected-tasks", PROJECT_ID)) ?? "[]",
    );
    expect(persisted.sort()).toEqual([...rendered].sort());
    expect(persisted).toHaveLength(INITIAL_WINDOW);
    expect(screen.getAllByText(`${INITIAL_WINDOW} selected`).length).toBeGreaterThan(0);
  });

  it("confirms a bulk delete against the rendered rows only", async () => {
    renderList();
    enterBulkEdit();
    selectAll();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Delete selected/i }));
    });

    expect(confirmMocks.confirm).toHaveBeenCalledTimes(1);
    const { message } = confirmMocks.confirm.mock.calls[0][0] as { message: string };
    expect(message).toContain(String(INITIAL_WINDOW));
    expect(message).not.toContain(String(TOTAL_TASKS));
  });

  it("grows the select-all target as the window is expanded", () => {
    renderList();
    enterBulkEdit();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /Load 25 more/i }));
    });
    selectAll();

    const persisted: string[] = JSON.parse(
      localStorage.getItem(scopedKey("kb-dashboard-selected-tasks", PROJECT_ID)) ?? "[]",
    );
    expect(persisted).toHaveLength(INITIAL_WINDOW + INCREMENT);
    expect(persisted.sort()).toEqual([...renderedTaskIds()].sort());
  });

  it("reports checked, not indeterminate, once the rendered window is fully selected", () => {
    renderList();
    enterBulkEdit();
    selectAll();

    const checkbox = screen.getByLabelText("Select all visible tasks") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    expect(checkbox.indeterminate).toBe(false);
  });
});
