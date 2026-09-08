import React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Column } from "../Column";
import type { Task, Column as ColumnType } from "@fusion/core";

const { rebuildTaskSpecMock } = vi.hoisted(() => ({ rebuildTaskSpecMock: vi.fn() }));
vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal()),
  rebuildTaskSpec: rebuildTaskSpecMock,
}));

// Mock child components to keep tests focused on the Column badge behavior
const taskCardRenderSpy = vi.fn();

vi.mock("../TaskCard", () => ({
  TaskCard: React.memo(({ task }: { task: Task }) => {
    taskCardRenderSpy(task.id);
    return <div data-testid={`task-${task.id}`} />;
  }),
}));
vi.mock("../WorktreeGroup", () => ({
  WorktreeGroup: ({ label, kind, activeTasks, queuedTasks }: { label: string; kind: string; activeTasks: Task[]; queuedTasks: Task[] }) => (
    <div data-testid="worktree-group" data-label={label} data-kind={kind} data-active-count={activeTasks.length} data-queued-count={queuedTasks.length}>
      <span>{label}</span>
      {activeTasks.map((task) => <div key={task.id} data-testid={`group-active-${task.id}`}>{task.id}</div>)}
      {queuedTasks.map((task) => <div key={task.id} data-testid={`group-queued-${task.id}`}>{task.id}</div>)}
    </div>
  ),
}));
vi.mock("../QuickEntryBox", () => ({
  QuickEntryBox: ({ favoriteProviders, favoriteModels, onToggleFavorite, onToggleModelFavorite, autoExpand, onCreate, onMoveTask, workflowId, workflowOptions }: { favoriteProviders?: string[]; favoriteModels?: string[]; onToggleFavorite?: (provider: string) => void; onToggleModelFavorite?: (modelId: string) => void; autoExpand?: boolean; onCreate?: (input: { description: string; workflowId?: string; column?: string }) => void; onMoveTask?: (id: string, column: string) => Promise<unknown>; workflowId?: string; workflowOptions?: { id: string; columns?: { flags?: { manualIntake?: boolean } }[] }[] }) => {
    const selectedWorkflow = workflowOptions?.find((option) => option.id === workflowId);
    const showStart = workflowId === "builtin:coding-ideas-v2" || selectedWorkflow?.columns?.[0]?.flags?.manualIntake === true;
    return (
    <div
      data-testid="quick-entry-box"
      data-favorite-providers={JSON.stringify(favoriteProviders ?? [])}
      data-favorite-models={JSON.stringify(favoriteModels ?? [])}
      data-has-toggle-favorite={onToggleFavorite ? "yes" : "no"}
      data-has-toggle-model-favorite={onToggleModelFavorite ? "yes" : "no"}
      data-auto-expand={autoExpand === false ? "false" : "true"}
    >
      <button type="button" onClick={() => onCreate?.({ description: "Quick task" })}>create</button>
      {showStart && <button type="button" data-testid="quick-entry-start" onClick={() => onCreate?.({ description: "Started task", workflowId: "builtin:coding-ideas-v2", column: "todo" })}>start</button>}
      <button type="button" data-testid="quick-entry-move" onClick={() => void onMoveTask?.("FN-created", "todo")}>move</button>
    </div>
    );
  },
}));
vi.mock("lucide-react", () => ({
  Link: () => null,
  Clock: () => null,
  ChevronDown: () => null,
  ChevronUp: () => null,
  Archive: () => null,
  MoreVertical: () => null,
  AlertTriangle: () => null,
}));

// Mock usePluginUiSlots hook
const mockUsePluginUiSlots = vi.fn((_projectId?: string) => ({
  slots: [] as import("../../api").PluginUiSlotEntry[],
  getSlotsForId: vi.fn((_slotId: string) => [] as import("../../api").PluginUiSlotEntry[]),
  loading: false,
  error: null,
}));

vi.mock("../../hooks/usePluginUiSlots", () => ({
  usePluginUiSlots: (projectId?: string) => mockUsePluginUiSlots(projectId),
}));

const mockConfirm = vi.fn();

vi.mock("../../hooks/useConfirm", () => ({
  useConfirm: () => ({ confirm: mockConfirm }),
}));

function makeTask(id: string): Task {
  return {
    id,
    title: `Task ${id}`,
    column: "triage" as ColumnType,
    status: undefined as any,
    steps: [],
    currentStep: 0,
    dependencies: [],
    description: "",
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

beforeEach(() => {
  rebuildTaskSpecMock.mockReset();
  taskCardRenderSpy.mockClear();
  mockConfirm.mockReset();
  mockConfirm.mockResolvedValue(true);
});

const defaultProps = {
  column: "triage" as ColumnType,
  maxConcurrent: 2,
  showWorktreeGrouping: false,
  onMoveTask: vi.fn().mockResolvedValue({} as Task),
  onOpenDetail: vi.fn(),
  addToast: vi.fn(),
};

describe("Column count-flash", () => {
  it("does not apply count-flash class on initial render", () => {
    const tasks = [makeTask("FN-001")];
    render(<Column {...defaultProps} tasks={tasks} />);

    // Badge is active/total (0/1 for triage without a live planner).
    const badge = screen.getByText("1").parentElement!;
    expect(badge.className).toContain("column-count");
    expect(badge.className).not.toContain("count-flash");
    expect(badge).toHaveTextContent("0/1");
  });

  it("applies count-flash class when task count increases", () => {
    const tasks = [makeTask("FN-001")];
    const { rerender } = render(<Column {...defaultProps} tasks={tasks} />);

    const moreTasks = [makeTask("FN-001"), makeTask("FN-002")];
    rerender(<Column {...defaultProps} tasks={moreTasks} />);

    const badge = screen.getByText("2").parentElement!;
    expect(badge.className).toContain("count-flash");
    expect(badge).toHaveTextContent("0/2");
  });

  it("does not apply count-flash class when task count decreases", () => {
    const tasks = [makeTask("FN-001"), makeTask("FN-002")];
    const { rerender } = render(<Column {...defaultProps} tasks={tasks} />);

    const fewerTasks = [makeTask("FN-001")];
    rerender(<Column {...defaultProps} tasks={fewerTasks} />);

    const badge = screen.getByText("1").parentElement!;
    expect(badge.className).not.toContain("count-flash");
  });

  it.each([1_200, 600])("keeps measured Done pagination bounded and crash-free at %ipx", async (viewportWidth) => {
    const previousWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: viewportWidth });
    const resizeCallbacks: ResizeObserverCallback[] = [];
    const observedRows = new Set<Element>();
    class Observer {
      constructor(callback: ResizeObserverCallback) { resizeCallbacks.push(callback); }
      observe(element: Element) { observedRows.add(element); }
      unobserve(element: Element) { observedRows.delete(element); }
      disconnect() { observedRows.clear(); }
    }
    vi.stubGlobal("ResizeObserver", Observer);
    const rowGeometry = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function measuredRow() {
      const id = this.getAttribute("data-virtual-task-row") ?? "";
      const index = Number(id.split("-").at(-1) ?? 0);
      return { height: 280 + (index % 3) * 40 } as DOMRect;
    });
    let releasePage!: () => void;
    const page = new Promise<void>((resolve) => { releasePage = resolve; });
    const onLoadMore = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    function DoneHarness() {
      const [tasks, setTasks] = React.useState(() => Array.from({ length: 50 }, (_, index) => ({
        ...makeTask(`FN-DONE-${index}`),
        column: "done" as ColumnType,
      })));
      const [loading, setLoading] = React.useState(false);
      const [hasMore, setHasMore] = React.useState(true);
      const loadMore = React.useCallback(async () => {
        onLoadMore();
        setLoading(true);
        await page;
        setTasks(Array.from({ length: 75 }, (_, index) => ({
          ...makeTask(`FN-DONE-${index}`),
          column: "done" as ColumnType,
        })));
        setHasMore(false);
        setLoading(false);
      }, []);
      return <Column {...defaultProps} column={"done" as ColumnType} columnName="Done" columnFlags={{ complete: true }} tasks={tasks} totalTaskCount={1_284} serverHasMore={hasMore} serverLoadingMore={loading} onLoadMoreServer={loadMore} />;
    }

    try {
      render(<DoneHarness />);
      const root = document.querySelector<HTMLElement>(".column-body")!;
      Object.defineProperties(root, {
        clientHeight: { configurable: true, value: 640 },
        scrollHeight: { configurable: true, value: 24_000 },
        scrollTop: { configurable: true, writable: true, value: 23_500 },
      });
      await act(async () => {
        for (const callback of resizeCallbacks) callback(Array.from(observedRows, (target, index) => ({ target, borderBoxSize: [{ blockSize: 280 + (index % 3) * 40 }], contentRect: { height: 280 + (index % 3) * 40 } }) as unknown as ResizeObserverEntry), {} as ResizeObserver);
        await Promise.resolve();
      });

      expect(screen.getByLabelText("1,284 tasks")).toHaveTextContent("1,284");
      expect(document.querySelectorAll("[data-virtual-task-row]").length).toBeLessThanOrEqual(40);
      expect(screen.queryByRole("button", { name: /Show more|Load .*more/i })).toBeNull();
      fireEvent.scroll(root);
      fireEvent.scroll(root);
      await waitFor(() => expect(onLoadMore).toHaveBeenCalledOnce());

      await act(async () => {
        releasePage();
        await page;
      });
      await waitFor(() => expect(screen.queryByTestId("column-auto-pagination-sentinel")).toBeNull());
      act(() => {
        root.scrollTop = 24_000;
        fireEvent.scroll(root);
      });
      await waitFor(() => expect(screen.getByTestId("task-FN-DONE-74")).toBeTruthy());
      expect(document.querySelectorAll("[data-virtual-task-row]").length).toBeLessThanOrEqual(40);
      expect(onLoadMore).toHaveBeenCalledOnce();
      expect(consoleError.mock.calls.flat().join(" ")).not.toMatch(/Maximum update depth|Minified React error #185|ErrorBoundary/i);
    } finally {
      rowGeometry.mockRestore();
      consoleError.mockRestore();
      vi.unstubAllGlobals();
      Object.defineProperty(window, "innerWidth", { configurable: true, value: previousWidth });
    }
  });

  it("shows accurate executing/total for WIP (unpaused active over card total)", () => {
    const tasks = [
      { ...makeTask("FN-001"), column: "in-progress" as ColumnType },
      { ...makeTask("FN-002"), column: "in-progress" as ColumnType },
      { ...makeTask("FN-003"), column: "in-progress" as ColumnType, paused: true },
      { ...makeTask("FN-004"), column: "in-progress" as ColumnType, userPaused: true },
    ];
    render(
      <Column
        {...defaultProps}
        column={"in-progress" as ColumnType}
        columnFlags={{ countsTowardWip: true }}
        tasks={tasks}
      />,
    );

    expect(screen.getByLabelText("2 executing of 4")).toHaveTextContent("2/4");
  });

  it("counts only live planners as executing in todo (queued is not executing)", () => {
    const tasks = [
      { ...makeTask("FN-001"), column: "todo" as ColumnType, status: "planning" as any },
      { ...makeTask("FN-002"), column: "todo" as ColumnType, status: "queued" as any },
      { ...makeTask("FN-003"), column: "todo" as ColumnType, status: "queued" as any },
      { ...makeTask("FN-004"), column: "todo" as ColumnType, status: "queued" as any },
    ];
    render(
      <Column
        {...defaultProps}
        column={"todo" as ColumnType}
        columnFlags={{ hold: true }}
        tasks={tasks}
      />,
    );

    expect(screen.getByLabelText("1 executing of 4")).toHaveTextContent("1/4");
  });

  it("does NOT count a parked REVISING (needs-replan) todo card — it holds no concurrency slot", () => {
    // FNXC:BoardColumnCount 2026-08-01-17:53: summing lane headers must never exceed the
    // engine's live-agent population, so the header counts only the shared Running predicate.
    // A parked replan glows nothing and counts nothing; a live planning card counts.
    const tasks = [
      { ...makeTask("FN-001"), column: "todo" as ColumnType, status: "needs-replan" as any },
      { ...makeTask("FN-002"), column: "todo" as ColumnType, status: "planning" as any },
    ];
    render(
      <Column
        {...defaultProps}
        column={"todo" as ColumnType}
        columnFlags={{ hold: true }}
        tasks={tasks}
      />,
    );
    expect(screen.getByLabelText("1 executing of 2")).toHaveTextContent("1/2");
  });

  it("counts an in-review card whose code-review gate holds a pending step lease", () => {
    const tasks = [
      {
        ...makeTask("FN-001"),
        column: "in-review" as ColumnType,
        workflowStepResults: [{ workflowStepId: "code-review", workflowStepName: "Code Review", status: "pending" as const, startedAt: new Date().toISOString() }],
      },
      { ...makeTask("FN-002"), column: "in-review" as ColumnType },
    ];
    render(
      <Column
        {...defaultProps}
        column={"in-review" as ColumnType}
        columnFlags={{ mergeBlocker: true }}
        tasks={tasks}
      />,
    );
    expect(screen.getByLabelText("1 executing of 2")).toHaveTextContent("1/2");
  });
});

/*
FNXC:CodingIdeasWorkflow 2026-07-21-23:42:
Coding (Ideas) uses the canonical non-legacy `ideas` intake ID. Cover empty and
populated real Column markup here because Board selected/aggregate views and Lane
all compose this shared renderer; duplicate consumer tests would not add another path.
*/
describe("Column Coding (Ideas) header indicator", () => {
  it.each([
    ["empty", []],
    ["populated", [{ ...makeTask("FN-IDEA-1"), column: "ideas" as ColumnType }]],
  ])("renders one Ideas dot before the heading for a %s intake column", (_state, tasks) => {
    render(
      <Column
        {...defaultProps}
        column={"ideas" as ColumnType}
        workflowMode
        columnDisplayName="Ideas"
        columnFlags={{ intake: true }}
        tasks={tasks}
      />,
    );

    const heading = screen.getByRole("heading", { name: "Ideas", level: 2 });
    const header = heading.closest(".column-header");
    expect(header?.querySelectorAll(".column-dot.dot-ideas")).toHaveLength(1);
    expect(heading.previousElementSibling).toHaveClass("column-dot", "dot-ideas");
  });

  it("maps the canonical Ideas dot to the shared triage token", () => {
    const css = readFileSync(resolve(__dirname, "../../styles.css"), "utf8");
    expect(css).toMatch(/\.dot-ideas\s*\{\s*background:\s*var\(--triage\);\s*\}/);
  });
});

/*
FNXC:BoardColumnDescriptions 2026-07-21-00:00:
Todo and In Review omit redundant readiness prose, and the shared Column renderer
must leave no empty description shell across desktop/mobile and task-data states.
*/
describe("Column legacy descriptions", () => {
  it.each([
    ["Todo", "todo" as ColumnType, "Specified and ready to start"],
    ["In Review", "in-review" as ColumnType, "Complete — ready to merge"],
  ])("omits the description shell for an empty %s column", (label, column, removedDescription) => {
    render(<Column {...defaultProps} column={column} tasks={[]} />);

    expect(screen.getByRole("heading", { name: label, level: 2 })).toBeInTheDocument();
    expect(screen.queryByText(removedDescription)).not.toBeInTheDocument();
    expect(document.querySelector(".column-desc")).toBeNull();
  });

  it.each([
    ["Todo", "todo" as ColumnType, "Specified and ready to start"],
    ["In Review", "in-review" as ColumnType, "Complete — ready to merge"],
  ])("omits the description shell for a populated %s column", (label, column, removedDescription) => {
    render(<Column {...defaultProps} column={column} tasks={[{ ...makeTask("FN-8480"), column }]} />);

    expect(screen.getByRole("heading", { name: label, level: 2 })).toBeInTheDocument();
    expect(screen.queryByText(removedDescription)).not.toBeInTheDocument();
    expect(document.querySelector(".column-desc")).toBeNull();
  });

  it("retains the description for Planning", () => {
    render(<Column {...defaultProps} tasks={[]} />);

    expect(screen.getByText("Raw ideas — AI will plan these")).toHaveClass("column-desc");
  });
});

describe("Column workflow mode (U9)", () => {
  it("preserves multiline workflow descriptions and uses overflow-safe board styling", () => {
    const description = `Send work to this lane.\nhttps://example.test/${"unbroken-token-".repeat(24)}`;
    render(
      <Column
        {...defaultProps}
        column={"custom-col" as ColumnType}
        workflowMode
        columnDisplayName="Custom lane"
        columnDescription={description}
        tasks={[]}
      />,
    );

    const descriptionElement = document.querySelector(".column-desc");
    expect(descriptionElement?.textContent).toBe(description);
    const css = readFileSync(resolve(__dirname, "../../styles.css"), "utf8");
    expect(css).toMatch(/\.column-desc\s*\{[\s\S]*white-space:\s*pre-wrap;[\s\S]*overflow-wrap:\s*anywhere;/);
  });

  it("uses the workflow column display name instead of the legacy label", () => {
    render(
      <Column
        {...defaultProps}
        column={"custom-col" as ColumnType}
        workflowMode
        columnDisplayName="Planning Hold"
        columnFlags={{ hold: true }}
        tasks={[]}
      />,
    );
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Planning Hold");
  });

  it("re-keys bulk actions to trait flags (a wip column gets the processing menu)", () => {
    render(
      <Column
        {...defaultProps}
        column={"exec" as ColumnType}
        workflowMode
        columnDisplayName="Executing"
        columnFlags={{ countsTowardWip: true }}
        onPauseTask={vi.fn()}
        tasks={[{ ...makeTask("FN-1"), column: "exec" as ColumnType }]}
      />,
    );
    // The processing-column actions button (column-menu) is present.
    expect(document.querySelector(".column-menu")).not.toBeNull();
  });

});

describe("Column worktree grouping setting", () => {
  it("renders legacy in-progress columns as plain cards when the setting is off", () => {
    const assigned = { ...makeTask("FN-001"), column: "in-progress" as ColumnType, worktree: "/repo/.worktrees/amber-finch" };
    render(<Column {...defaultProps} column="in-progress" tasks={[assigned]} allTasks={[assigned]} />);

    expect(screen.queryByTestId("worktree-group")).toBeNull();
    expect(screen.queryByText("amber-finch")).toBeNull();
    expect(screen.getByTestId("task-FN-001")).toBeInTheDocument();
  });

  it("groups legacy in-progress tasks by worktree when the setting is on", () => {
    const assigned = { ...makeTask("FN-001A"), column: "in-progress" as ColumnType, worktree: "/repo/.worktrees/amber-finch" };
    render(<Column {...defaultProps} column="in-progress" showWorktreeGrouping tasks={[assigned]} allTasks={[assigned]} />);

    expect(screen.getByTestId("worktree-group")).toHaveAttribute("data-label", "amber-finch");
    expect(screen.getByTestId("group-active-FN-001A")).toBeInTheDocument();
    expect(screen.queryByTestId("task-FN-001A")).toBeNull();
  });

  it("renders workflow processing columns as plain cards when the setting is off", () => {
    const assigned = { ...makeTask("FN-002"), column: "exec" as ColumnType, worktree: "/repo/.worktrees/workflow-wren" };
    render(
      <Column
        {...defaultProps}
        column={"exec" as ColumnType}
        workflowMode
        columnDisplayName="Executing"
        columnFlags={{ countsTowardWip: true }}
        tasks={[assigned]}
        allTasks={[assigned]}
      />,
    );

    expect(screen.queryByTestId("worktree-group")).toBeNull();
    expect(screen.queryByText("workflow-wren")).toBeNull();
    expect(screen.getByTestId("task-FN-002")).toBeInTheDocument();
  });

  it("groups workflow processing tasks by worktree when the setting is on", () => {
    const assigned = { ...makeTask("FN-003"), column: "exec" as ColumnType, worktree: "/repo/.worktrees/workflow-hawk" };
    const unassigned = { ...makeTask("FN-004"), column: "exec" as ColumnType };
    const queued = { ...makeTask("FN-005"), column: "todo" as ColumnType };
    render(
      <Column
        {...defaultProps}
        column={"exec" as ColumnType}
        workflowMode
        columnDisplayName="Executing"
        columnFlags={{ countsTowardWip: true }}
        showWorktreeGrouping
        tasks={[assigned, unassigned]}
        allTasks={[assigned, unassigned, queued]}
      />,
    );

    expect(screen.getByText("workflow-hawk")).toBeInTheDocument();
    expect(screen.getByText("Unassigned")).toBeInTheDocument();
    expect(screen.getByText("Up Next")).toBeInTheDocument();
    expect(screen.getByTestId("group-active-FN-003")).toBeInTheDocument();
    expect(screen.getByTestId("group-active-FN-004")).toBeInTheDocument();
    expect(screen.getByTestId("group-queued-FN-005")).toBeInTheDocument();
    expect(screen.queryByTestId("task-FN-003")).toBeNull();
  });

  it("passes a single acquired workspace repo to a workspace group instead of stale singular routing", () => {
    const workspaceTask = {
      ...makeTask("FN-9044"),
      column: "exec" as ColumnType,
      worktree: "/ws/unrelated/.worktrees/stale-worktree",
      workspaceWorktrees: {
        "repo-a": { worktreePath: "/ws/repo-a/.worktrees/FN-9044", branch: "fusion/FN-9044" },
      },
    };
    render(
      <Column
        {...defaultProps}
        column={"exec" as ColumnType}
        workflowMode
        columnDisplayName="Executing"
        columnFlags={{ countsTowardWip: true }}
        showWorktreeGrouping
        tasks={[workspaceTask]}
        allTasks={[workspaceTask]}
      />,
    );

    expect(screen.getByTestId("worktree-group")).toHaveAttribute("data-kind", "workspace");
    expect(screen.getByTestId("worktree-group")).toHaveAttribute("data-label", "FN-9044");
    expect(screen.queryByText("stale-worktree")).toBeNull();
    expect(screen.queryByText("Unassigned")).toBeNull();
    expect(screen.getByTestId("group-active-FN-9044")).toBeInTheDocument();
  });

  it("does not leave worktree shells in empty processing columns", () => {
    const { rerender } = render(
      <Column
        {...defaultProps}
        column={"exec" as ColumnType}
        workflowMode
        columnDisplayName="Executing"
        columnFlags={{ countsTowardWip: true }}
        showWorktreeGrouping
        tasks={[]}
        allTasks={[]}
      />,
    );

    expect(screen.queryByTestId("worktree-group")).toBeNull();
    expect(screen.getByText("No tasks")).toBeInTheDocument();

    rerender(
      <Column
        {...defaultProps}
        column={"exec" as ColumnType}
        workflowMode
        columnDisplayName="Executing"
        columnFlags={{ countsTowardWip: true }}
        showWorktreeGrouping={false}
        tasks={[]}
        allTasks={[]}
      />,
    );

    expect(screen.queryByTestId("worktree-group")).toBeNull();
    expect(screen.getByText("No tasks")).toBeInTheDocument();
  });
});

describe("Column memoization", () => {
  it("does not re-render task cards when rerendered with the same task references", () => {
    const tasks = [makeTask("FN-001")];
    const props = { ...defaultProps, tasks };

    const { rerender } = render(<Column {...props} />);
    expect(taskCardRenderSpy).toHaveBeenCalledTimes(1);

    rerender(<Column {...props} />);

    expect(taskCardRenderSpy).toHaveBeenCalledTimes(1);
  });

});

describe("Column automatic pagination and virtualization", () => {
  it.each([false, true])("keeps a 1,000-task result bounded without manual pagination (search=%s)", (isSearchActive) => {
    const tasks = Array.from({ length: 1_000 }, (_, index) => makeTask(`KB-${String(index + 1).padStart(4, "0")}`));
    render(<Column {...defaultProps} column="todo" tasks={tasks} isSearchActive={isSearchActive} />);
    expect(screen.getAllByTestId(/task-/).length).toBeLessThanOrEqual(40);
    expect(screen.queryByRole("button", { name: /Load .*more|Show more/i })).toBeNull();
  });

  it.each([false, true])("loads the next server page automatically from the column scroller (search=%s)", async (isSearchActive) => {
    const onLoadMoreServer = vi.fn().mockResolvedValue(undefined);
    render(<Column {...defaultProps} column="todo" tasks={[makeTask("KB-001")]} isSearchActive={isSearchActive} serverHasMore onLoadMoreServer={onLoadMoreServer} />);
    const sentinel = screen.getByTestId("column-auto-pagination-sentinel");
    fireEvent.scroll(sentinel.parentElement!);
    await waitFor(() => expect(onLoadMoreServer).toHaveBeenCalledOnce());
    expect(screen.queryByRole("button", { name: /Load .*more|Show more/i })).toBeNull();
  });

  it("keeps capacity-bounded worktree groups exempt from the card virtualizer", () => {
    const tasks = Array.from({ length: 10 }, (_, index) => ({ ...makeTask(`KB-${index}`), column: "in-progress" as ColumnType }));
    render(<Column {...defaultProps} column="in-progress" showWorktreeGrouping tasks={tasks} />);
    expect(screen.queryByTestId("column-auto-pagination-sentinel")).toBeNull();
  });
});

describe("Column QuickEntryBox", () => {
  it("renders QuickEntryBox in triage column when onQuickCreate is provided", () => {
    const tasks = [makeTask("FN-001")];
    render(<Column {...defaultProps} workflowMode columnFlags={{ intake: true }} tasks={tasks} onQuickCreate={vi.fn()} />);
    expect(screen.getByTestId("quick-entry-box")).toBeTruthy();
  });

  it("does not render QuickEntryBox in triage column when onQuickCreate is not provided", () => {
    const tasks = [makeTask("FN-001")];
    render(<Column {...defaultProps} tasks={tasks} />);
    expect(screen.queryByTestId("quick-entry-box")).toBeNull();
  });

  it("does not render QuickEntryBox in non-triage columns", () => {
    const tasks = [makeTask("FN-001")];
    render(<Column {...defaultProps} tasks={tasks} column="todo" onQuickCreate={vi.fn()} />);
    expect(screen.queryByTestId("quick-entry-box")).toBeNull();
  });

  it("passes autoExpand={false} to QuickEntryBox in triage column (collapsed by default)", () => {
    const tasks = [makeTask("FN-001")];
    render(<Column {...defaultProps} workflowMode columnFlags={{ intake: true }} tasks={tasks} onQuickCreate={vi.fn()} />);
    const quickEntry = screen.getByTestId("quick-entry-box");
    expect(quickEntry.getAttribute("data-auto-expand")).toBe("false");
  });

  it("wires QuickEntry Start moves through the host state-updating callback", async () => {
    const onMoveTask = vi.fn().mockResolvedValue(makeTask("FN-created"));
    render(<Column {...defaultProps} workflowMode columnFlags={{ intake: true }} tasks={[]} onQuickCreate={vi.fn()} onMoveTask={onMoveTask} />);
    fireEvent.click(screen.getByTestId("quick-entry-move"));
    await waitFor(() => expect(onMoveTask).toHaveBeenCalledWith("FN-created", "todo"));
  });

  it("preserves the explicit Coding Ideas Start column in workflow mode", async () => {
    const onQuickCreate = vi.fn().mockResolvedValue({});
    render(<Column {...defaultProps} column="ideas" workflowMode workflowId="builtin:coding-ideas-v2" workflowOptions={[{ id: "builtin:coding-ideas-v2", name: "Coding (Ideas)", columns: [{ id: "ideas", name: "Ideas", flags: { intake: true, hold: true, manualIntake: true } }] }]} tasks={[]} onQuickCreate={onQuickCreate} />);

    fireEvent.click(screen.getByTestId("quick-entry-start"));

    await waitFor(() => expect(onQuickCreate).toHaveBeenCalledWith({
      description: "Started task",
      workflowId: "builtin:coding-ideas-v2",
      column: "todo",
    }));
  });

  it("does not expose a Quick Add Start control for Coding's merged intake/hold lane", () => {
    render(<Column {...defaultProps} workflowMode workflowId="builtin:coding" workflowOptions={[{ id: "builtin:coding", name: "Coding", columns: [{ id: "planning", name: "Planning", flags: { intake: true, hold: true } }] }]} tasks={[]} onQuickCreate={vi.fn()} />);

    expect(screen.queryByTestId("quick-entry-start")).toBeNull();
  });

  it("preserves selected built-in workflow id when quick-creating in workflow mode", async () => {
    const onQuickCreate = vi.fn().mockResolvedValue({});
    render(
      <Column
        {...defaultProps}
        column="triage"
        workflowMode
        workflowId="builtin:coding"
        tasks={[]}
        onQuickCreate={onQuickCreate}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "create" }));

    await waitFor(() => expect(onQuickCreate).toHaveBeenCalledWith({
      description: "Quick task",
      column: "triage",
      workflowId: "builtin:coding",
    }));
  });
});

describe("Column in-progress/in-review bulk actions", () => {
  it.each(["in-progress", "in-review"] as const)("renders Stop All without manual move actions for %s", async (column) => {
    const user = userEvent.setup();
    render(
      <Column
        {...defaultProps}
        column={column}
        tasks={[{ ...makeTask("FN-001"), column }]}
        onPauseTask={vi.fn().mockResolvedValue({} as Task)}
      />,
    );

    const menuButton = screen.getByRole("button", { name: `${column === "in-progress" ? "In Progress" : "In Review"} column actions` });
    expect(menuButton).toHaveAttribute("aria-haspopup", "menu");
    expect(menuButton).toHaveAttribute("aria-expanded", "false");

    await user.click(menuButton);

    expect(menuButton).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Stop All/i })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /Move All/i })).toBeNull();
  });

  it.each(["in-progress", "in-review"] as const)("Stop All pauses only manually-pausable tasks in %s", async (column) => {
    const user = userEvent.setup();
    const onPauseTask = vi.fn().mockResolvedValue({} as Task);

    render(
      <Column
        {...defaultProps}
        column={column}
        tasks={[
          { ...makeTask("FN-001"), column, paused: false },
          { ...makeTask("FN-002"), column, paused: true },
          { ...makeTask("FN-003"), column, paused: false, assignedAgentId: "agent-1" },
          { ...makeTask("FN-004"), column, paused: false },
        ]}
        onPauseTask={onPauseTask}
      />,
    );

    await user.click(screen.getByRole("button", { name: `${column === "in-progress" ? "In Progress" : "In Review"} column actions` }));
    await user.click(screen.getByRole("menuitem", { name: /Stop All/i }));

    await waitFor(() => {
      expect(onPauseTask).toHaveBeenCalledTimes(2);
    });
    expect(onPauseTask).toHaveBeenCalledWith("FN-001");
    expect(onPauseTask).toHaveBeenCalledWith("FN-004");
    expect(onPauseTask).not.toHaveBeenCalledWith("FN-003");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(mockConfirm).toHaveBeenCalledWith({
      title: "Stop All Tasks",
      message: `Stop all 2 ${column === "in-progress" ? "in progress" : "in review"} tasks?`,
      danger: true,
    });
  });

  it.each(["in-progress", "in-review"] as const)("disables Stop All when %s is empty", async (column) => {
    const user = userEvent.setup();

    render(
      <Column
        {...defaultProps}
        column={column}
        tasks={[]}
        onPauseTask={vi.fn().mockResolvedValue({} as Task)}
      />,
    );

    await user.click(screen.getByRole("button", { name: `${column === "in-progress" ? "In Progress" : "In Review"} column actions` }));
    expect(screen.getByRole("menuitem", { name: /Stop All/i })).toBeDisabled();
    expect(screen.getByText("No tasks in this column")).toBeTruthy();
  });

  it.each(["in-progress", "in-review"] as const)("disables Stop All when no %s tasks are manually pausable", async (column) => {
    const user = userEvent.setup();

    render(
      <Column
        {...defaultProps}
        column={column}
        tasks={[
          { ...makeTask("FN-010"), column, paused: true },
          { ...makeTask("FN-011"), column, paused: false, assignedAgentId: "agent-1" },
        ]}
        onPauseTask={vi.fn().mockResolvedValue({} as Task)}
      />,
    );

    await user.click(screen.getByRole("button", { name: `${column === "in-progress" ? "In Progress" : "In Review"} column actions` }));
    expect(screen.getByRole("menuitem", { name: /Stop All/i })).toBeDisabled();
    expect(screen.getByText("No manually pausable tasks")).toBeTruthy();
  });

});

describe("Column plan auto-approval action", () => {
  it.each([
    ["workflow", false],
    ["auto-approve-all", true],
    ["require-all", false],
  ] as const)("renders the Triage switch checked only for %s mode", async (_mode, enabled) => {
    const user = userEvent.setup();
    const onTogglePlanAutoApprove = vi.fn();

    render(
      <Column
        {...defaultProps}
        column="triage"
        tasks={[]}
        planAutoApproveEnabled={enabled}
        onTogglePlanAutoApprove={onTogglePlanAutoApprove}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Planning column actions" }));
    const switchItem = screen.getByRole("menuitemcheckbox", { name: /Auto-approve plan/i });
    expect(switchItem).toHaveAttribute("aria-checked", enabled ? "true" : "false");
    expect(screen.getByText(enabled ? /On bypasses manual plan approval/i : /Off uses the workflow\/default/i)).toBeInTheDocument();
  });

  it("calls the plan auto-approval toggle exactly once and closes the menu", async () => {
    const user = userEvent.setup();
    const onTogglePlanAutoApprove = vi.fn();

    render(
      <Column
        {...defaultProps}
        column="triage"
        tasks={[makeTask("FN-001")]}
        planAutoApproveEnabled={false}
        onTogglePlanAutoApprove={onTogglePlanAutoApprove}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Planning column actions" }));
    await user.click(screen.getByRole("checkbox", { name: "Auto-approve plan" }));

    expect(onTogglePlanAutoApprove).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("replans each task through the server and never moves cards client-side", async () => {
    const user = userEvent.setup();
    const onMoveTask = vi.fn();
    rebuildTaskSpecMock.mockResolvedValue({});
    render(<Column {...defaultProps} column="todo" projectId="project-1" onMoveTask={onMoveTask} tasks={[makeTask("FN-001"), makeTask("FN-002")]} />);

    await user.click(screen.getByRole("button", { name: "Todo column actions" }));
    await user.click(screen.getByRole("menuitem", { name: /Replan All/i }));

    await waitFor(() => expect(rebuildTaskSpecMock).toHaveBeenCalledTimes(2));
    expect(rebuildTaskSpecMock).toHaveBeenCalledWith("FN-001", "project-1");
    expect(rebuildTaskSpecMock).toHaveBeenCalledWith("FN-002", "project-1");
    expect(onMoveTask).not.toHaveBeenCalled();
  });

  it("coexists with workflow intake replan actions", async () => {
    const user = userEvent.setup();
    render(
      <Column
        {...defaultProps}
        column={"intake" as ColumnType}
        workflowMode
        columnDisplayName="Intake"
        columnFlags={{ intake: true }}
        tasks={[{ ...makeTask("FN-002"), column: "intake" as ColumnType }]}
        planAutoApproveEnabled={true}
        onTogglePlanAutoApprove={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Intake column actions" }));

    expect(screen.getByRole("menuitemcheckbox", { name: /Auto-approve plan/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Replan All/i })).toBeInTheDocument();
  });

  it("does not leave an actions shell on non-Triage columns without actions", () => {
    render(<Column {...defaultProps} column="done" tasks={[]} />);

    expect(screen.queryByRole("button", { name: "Done column actions" })).toBeNull();
    expect(screen.queryByRole("menuitemcheckbox", { name: /Auto-approve plan/i })).toBeNull();
  });
});

describe("Column terminal actions", () => {
  it("does not render an action shell for Done", () => {
    const { container } = render(<Column {...defaultProps} column="done" columnFlags={{ complete: true }} tasks={[{ ...makeTask("FN-001"), column: "done" }]} />);
    expect(screen.queryByRole("button", { name: "Done column actions" })).toBeNull();
    expect(container.querySelector(".column-menu")).toBeNull();
  });

  it("keeps the generic sort menu on non-complete columns", async () => {
    const user = userEvent.setup();
    render(<Column {...defaultProps} column="todo" tasks={[{ ...makeTask("FN-001"), column: "todo" }]} sortMode="completion-date-desc" onSortModeChange={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Todo column actions" }));
    expect(screen.getByRole("menuitemradio", { name: /Arrival in this column/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: /Task ID \(newest first\)/ })).toBeInTheDocument();
  });
});


  describe("favorite model prop forwarding (FN-770)", () => {
    it("forwards favoriteProviders, favoriteModels, and toggle callbacks to QuickEntryBox", () => {
      const onToggleFavorite = vi.fn();
      const onToggleModelFavorite = vi.fn();

      render(
        <Column
          {...defaultProps}
          column="triage"
          workflowMode
          columnFlags={{ intake: true }}
          tasks={[]}
          onQuickCreate={vi.fn().mockResolvedValue({})}
          favoriteProviders={["anthropic"]}
          favoriteModels={["claude-sonnet-4-5"]}
          onToggleFavorite={onToggleFavorite}
          onToggleModelFavorite={onToggleModelFavorite}
        />,
      );

      const quickEntry = screen.getByTestId("quick-entry-box");
      expect(quickEntry.getAttribute("data-favorite-providers")).toBe(JSON.stringify(["anthropic"]));
      expect(quickEntry.getAttribute("data-favorite-models")).toBe(JSON.stringify(["claude-sonnet-4-5"]));
      expect(quickEntry.getAttribute("data-has-toggle-favorite")).toBe("yes");
      expect(quickEntry.getAttribute("data-has-toggle-model-favorite")).toBe("yes");
    });

    it("passes empty favorites when props not provided", () => {
      render(
        <Column
          {...defaultProps}
          column="triage"
          workflowMode
          columnFlags={{ intake: true }}
          tasks={[]}
          onQuickCreate={vi.fn().mockResolvedValue({})}
        />,
      );

      const quickEntry = screen.getByTestId("quick-entry-box");
      expect(quickEntry.getAttribute("data-favorite-providers")).toBe("[]");
      expect(quickEntry.getAttribute("data-favorite-models")).toBe("[]");
      expect(quickEntry.getAttribute("data-has-toggle-favorite")).toBe("no");
      expect(quickEntry.getAttribute("data-has-toggle-model-favorite")).toBe("no");
    });
  });

describe("Column PluginSlot integration", () => {
  it("renders PluginSlot for board-column-footer", () => {
    mockUsePluginUiSlots.mockReturnValue({
      slots: [{ pluginId: "test-plugin", slot: { slotId: "board-column-footer", label: "Column Footer", componentPath: "./test.js" } }],
      getSlotsForId: vi.fn((id: string) => id === "board-column-footer" ? [{ pluginId: "test-plugin", slot: { slotId: "board-column-footer", label: "Column Footer", componentPath: "./test.js" } }] : []),
      loading: false,
      error: null,
    });
    const { container } = render(
      <Column
        {...defaultProps}
        column="triage"
        tasks={[]}
      />,
    );
    // Check that column-body exists
    const columnBody = container.querySelector(".column-body");
    expect(columnBody).not.toBeNull();
    // Check for plugin slot inside column-body (always rendered, even for empty columns)
    const slot = container.querySelector('[data-slot-id="board-column-footer"]');
    expect(slot).not.toBeNull();
    expect(slot).toHaveAttribute("data-plugin-id", "test-plugin");
  });

  it("renders nothing when no plugins register for board-column-footer slot", () => {
    mockUsePluginUiSlots.mockReturnValue({
      slots: [],
      getSlotsForId: vi.fn(() => []),
      loading: false,
      error: null,
    });
    const { container } = render(
      <Column
        {...defaultProps}
        column="triage"
        tasks={[]}
      />,
    );
    const slot = container.querySelector('[data-slot-id="board-column-footer"]');
    expect(slot).toBeNull();
  });
});
