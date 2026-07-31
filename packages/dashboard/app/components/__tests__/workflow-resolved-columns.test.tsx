import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { Task } from "@fusion/core";
import { Board } from "../Board";
import { ListView } from "../ListView";
import { getTaskMoveTransitions, type TaskContextMenuColumnMetadata } from "../TaskContextMenu";
import type { BoardWorkflowsPayload } from "../../api";
import { ALL_WORKFLOWS_BOARD_VIEW_ID } from "../../utils/boardWorkflowSelection";

/*
FNXC:WorkflowResolvedColumns 2026-07-27-14:10 (U10 / R8):
Board, List, and the move menu must render the columns the CARD'S OWN WORKFLOW declares —
with the workflow's names and the workflow's order. The two failure modes this file pins are
the ones that survive a green suite:
  - a RENAMED column rendering under its legacy label or in legacy position, and
  - a REMOVED column stranding its cards (dropped from the render entirely) while a phantom
    lane for that removed column is still drawn from the legacy `COLUMNS` enum.
Both are asserted on desktop AND mobile, and across empty / populated / duplicate-id column
states, per the AGENTS.md Surface Enumeration rule (this unit changes UI affordances).
*/

const fetchBoardWorkflowsMock = vi.fn();

vi.mock("../../api", () => ({
  fetchWorkflowSteps: vi.fn(() => new Promise(() => {})),
  fetchBoardWorkflows: (...args: unknown[]) => fetchBoardWorkflowsMock(...args),
  promoteTask: vi.fn().mockResolvedValue({}),
  fetchTaskDetail: vi.fn(() => new Promise(() => {})),
  batchUpdateTaskModels: vi.fn(),
  fetchNodes: vi.fn(() => new Promise(() => {})),
  fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] }),
  fetchSettings: vi.fn().mockResolvedValue({}),
  fetchGlobalSettings: vi.fn().mockResolvedValue({}),
  refreshPrStatus: vi.fn().mockResolvedValue({}),
  rebuildTaskSpec: vi.fn().mockResolvedValue({}),
  updateTask: vi.fn(),
  api: vi.fn().mockResolvedValue({ sessions: [] }),
  setProjectBoardSelectedWorkflow: vi.fn().mockResolvedValue({}),
}));

vi.mock("../../sse-bus", () => ({ subscribeSse: vi.fn(() => () => {}) }));

vi.mock("../Column", () => ({
  Column: ({ column, tasks, columnDisplayName }: { column: string; tasks: Task[]; columnDisplayName?: string }) => (
    <section
      data-testid={`column-${column}`}
      data-column-label={columnDisplayName ?? column}
      data-task-ids={JSON.stringify(tasks.map((task) => task.id))}
    />
  ),
}));

vi.mock("../QuickEntryBox", () => ({ QuickEntryBox: () => <div data-testid="quick-entry" /> }));
vi.mock("../TaskDetailModal", () => ({ TaskDetailContent: () => <div data-testid="task-detail-content" /> }));
vi.mock("../CustomModelDropdown", () => ({ CustomModelDropdown: () => <div /> }));

const PROJECT_ID = "project-u10";

/**
 * A workflow that both RENAMES (`todo` → `staging`, "Ready to build") and REMOVES
 * nothing yet — used as the rename surface.
 */
const RENAMED_WORKFLOW = {
  id: "wf-renamed",
  name: "Renamed Flow",
  columns: [
    { id: "backlog", name: "Backlog", flags: { intake: true } },
    { id: "staging", name: "Ready to build", flags: { hold: true } },
    { id: "building", name: "Building", flags: { countsTowardWip: true } },
    { id: "signoff", name: "Sign-off", flags: { mergeBlocker: true, humanReview: true } },
    { id: "shipped", name: "Shipped", flags: { complete: true } },
  ],
};

/** A workflow that REMOVED the hold column entirely (the U11 shape). */
const REMOVED_HOLD_WORKFLOW = {
  id: "wf-no-todo",
  name: "No Todo Flow",
  columns: [
    { id: "triage", name: "Planning", flags: { intake: true, hold: true } },
    { id: "in-progress", name: "In progress", flags: { countsTowardWip: true } },
    { id: "in-review", name: "In review", flags: { mergeBlocker: true } },
    { id: "done", name: "Done", flags: { complete: true } },
  ],
};

function mkTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    title: overrides.id,
    description: "Task",
    column: "triage",
    dependencies: [],
    steps: [],
    currentStep: 0,
    status: "pending",
    paused: false,
    log: [],
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
    ...overrides,
  } as Task;
}

function payload(
  workflows: BoardWorkflowsPayload["workflows"],
  taskWorkflowIds: Record<string, string>,
): BoardWorkflowsPayload {
  return {
    flagEnabled: true,
    defaultWorkflowId: workflows[0]!.id,
    workflows,
    taskWorkflowIds,
  };
}

function renderBoard(tasks: Task[]) {
  return render(
    <Board
      tasks={tasks}
      projectId={PROJECT_ID}
      maxConcurrent={2}
      showWorktreeGrouping={false}
      onMoveTask={vi.fn(async () => tasks[0]!)}
      onOpenDetail={vi.fn()}
      addToast={vi.fn()}
      onNewTask={vi.fn()}
      autoMerge
      onToggleAutoMerge={vi.fn()}
      planAutoApproveEnabled={false}
      onTogglePlanAutoApprove={vi.fn()}
      settingsLoaded
    />,
  );
}

function renderList(tasks: Task[]) {
  return render(
    <ListView
      tasks={tasks}
      projectId={PROJECT_ID}
      onMoveTask={vi.fn(async () => tasks[0]!)}
      onRetryTask={vi.fn(async () => tasks[0]!)}
      onDeleteTask={vi.fn(async () => tasks[0]!)}
      onMergeTask={vi.fn()}
      onResetTask={vi.fn(async () => tasks[0]!)}
      onDuplicateTask={vi.fn(async () => tasks[0]!)}
      onOpenDetail={vi.fn()}
      addToast={vi.fn()}
      globalPaused={false}
      onNewTask={vi.fn()}
      settingsLoaded
    />,
  );
}

function selectAllWorkflowsView() {
  window.localStorage.setItem(`kb:${PROJECT_ID}:kb-dashboard-board-workflow-selection`, ALL_WORKFLOWS_BOARD_VIEW_ID);
}

/**
 * Mobile is a required surface here: the breakpoint is `(max-width: 768px), (max-height: 480px)`,
 * so a landscape phone matches on HEIGHT while exceeding 768px wide.
 */
function mockViewport(mobile: boolean) {
  Object.defineProperty(window, "innerWidth", { value: mobile ? 375 : 1280, configurable: true });
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: mobile && (query.includes("max-width: 768px") || query.includes("max-height: 480px")),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList,
  });
}

function renderedColumnIds(): string[] {
  return Array.from(document.querySelectorAll("[data-testid^='column-']")).map(
    (node) => node.getAttribute("data-testid")!.replace(/^column-/, ""),
  );
}

/**
 * The list groups rows under `.list-section-header` rows, so a row's section is the nearest
 * preceding header. Asserting the header text (rather than merely "the row exists") is what
 * catches a row landing in the WRONG lane instead of being dropped.
 */
function listSectionOfRow(taskId: string): string | null {
  const rows = Array.from(document.querySelectorAll("tr, .list-row, .list-section-header"));
  const rowIndex = rows.findIndex((node) => node.getAttribute("data-id") === taskId);
  if (rowIndex < 0) return null;
  for (let index = rowIndex - 1; index >= 0; index -= 1) {
    if (rows[index]!.className.includes("list-section-header")) return rows[index]!.textContent ?? "";
  }
  return null;
}

function taskIdsInColumn(columnId: string): string[] {
  const node = document.querySelector(`[data-testid='column-${columnId}']`);
  if (!node) return [];
  return JSON.parse(node.getAttribute("data-task-ids") ?? "[]") as string[];
}

describe("U10 — surfaces render workflow-resolved columns", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    fetchBoardWorkflowsMock.mockReset();
    mockViewport(false);
  });

  describe("Board — single-workflow lane", () => {
    it("renders a renamed workflow's own column ids, labels, and order", async () => {
      fetchBoardWorkflowsMock.mockResolvedValue(
        payload([RENAMED_WORKFLOW], { "FN-1": RENAMED_WORKFLOW.id }),
      );
      renderBoard([mkTask({ id: "FN-1", column: "staging" as Task["column"] })]);

      await waitFor(() => expect(renderedColumnIds().length).toBeGreaterThan(0));
      expect(renderedColumnIds()).toEqual(["backlog", "staging", "building", "signoff", "shipped"]);
      expect(
        document.querySelector("[data-testid='column-staging']")?.getAttribute("data-column-label"),
      ).toBe("Ready to build");
      expect(taskIdsInColumn("staging")).toEqual(["FN-1"]);
    });

    it("does not render a lane for a column the workflow removed", async () => {
      fetchBoardWorkflowsMock.mockResolvedValue(
        payload([REMOVED_HOLD_WORKFLOW], { "FN-2": REMOVED_HOLD_WORKFLOW.id }),
      );
      renderBoard([mkTask({ id: "FN-2", column: "triage" })]);

      await waitFor(() => expect(renderedColumnIds().length).toBeGreaterThan(0));
      expect(renderedColumnIds()).not.toContain("todo");
    });

    it("keeps a card stored in a removed column visible in the workflow's hold lane", async () => {
      fetchBoardWorkflowsMock.mockResolvedValue(
        payload([REMOVED_HOLD_WORKFLOW], { "FN-3": REMOVED_HOLD_WORKFLOW.id }),
      );
      renderBoard([mkTask({ id: "FN-3", column: "todo" })]);

      await waitFor(() => expect(renderedColumnIds().length).toBeGreaterThan(0));
      const allRendered = renderedColumnIds().flatMap((id) => taskIdsInColumn(id));
      expect(allRendered).toContain("FN-3");
    });
  });

  describe("Board — All workflows aggregate lane", () => {
    it("draws no phantom lane for a legacy column that no workflow declares", async () => {
      selectAllWorkflowsView();
      fetchBoardWorkflowsMock.mockResolvedValue(
        payload([RENAMED_WORKFLOW], { "FN-4": RENAMED_WORKFLOW.id }),
      );
      renderBoard([mkTask({ id: "FN-4", column: "backlog" as Task["column"] })]);

      await waitFor(() => expect(renderedColumnIds().length).toBeGreaterThan(0));
      const ids = renderedColumnIds();
      expect(ids).not.toContain("todo");
      expect(ids).not.toContain("in-progress");
      expect(ids).not.toContain("in-review");
      expect(ids).not.toContain("archived");
      expect(ids).toEqual(["backlog", "staging", "building", "signoff", "shipped"]);
    });

    it("labels aggregate lanes with the workflow's column names, never the raw id", async () => {
      selectAllWorkflowsView();
      fetchBoardWorkflowsMock.mockResolvedValue(
        payload([RENAMED_WORKFLOW], { "FN-5": RENAMED_WORKFLOW.id }),
      );
      renderBoard([mkTask({ id: "FN-5", column: "signoff" as Task["column"] })]);

      await waitFor(() => expect(renderedColumnIds().length).toBeGreaterThan(0));
      for (const column of RENAMED_WORKFLOW.columns) {
        expect(
          document.querySelector(`[data-testid='column-${column.id}']`)?.getAttribute("data-column-label"),
        ).toBe(column.name);
      }
    });

    it("still renders a fallback lane for a stored column no workflow declares", async () => {
      selectAllWorkflowsView();
      fetchBoardWorkflowsMock.mockResolvedValue(
        payload([REMOVED_HOLD_WORKFLOW], { "FN-6": REMOVED_HOLD_WORKFLOW.id }),
      );
      renderBoard([mkTask({ id: "FN-6", column: "todo" })]);

      await waitFor(() => expect(renderedColumnIds().length).toBeGreaterThan(0));
      const allRendered = renderedColumnIds().flatMap((id) => taskIdsInColumn(id));
      expect(allRendered).toContain("FN-6");
    });

    it("keeps a duplicate column id declared by two workflows as one lane", async () => {
      selectAllWorkflowsView();
      const second = {
        id: "wf-second",
        name: "Second",
        columns: [
          { id: "backlog", name: "Backlog (other)", flags: { intake: true } },
          { id: "shipped", name: "Shipped", flags: { complete: true } },
        ],
      };
      fetchBoardWorkflowsMock.mockResolvedValue(
        payload([RENAMED_WORKFLOW, second], { "FN-7": second.id }),
      );
      renderBoard([mkTask({ id: "FN-7", column: "backlog" as Task["column"] })]);

      await waitFor(() => expect(renderedColumnIds().length).toBeGreaterThan(0));
      const ids = renderedColumnIds();
      expect(ids.filter((id) => id === "backlog")).toHaveLength(1);
      // The default (first) workflow owns the shared label.
      expect(
        document.querySelector("[data-testid='column-backlog']")?.getAttribute("data-column-label"),
      ).toBe("Backlog");
    });

    it("renders an empty board with the workflow's lanes and no legacy lanes", async () => {
      selectAllWorkflowsView();
      fetchBoardWorkflowsMock.mockResolvedValue(payload([RENAMED_WORKFLOW], {}));
      renderBoard([]);

      await waitFor(() => expect(renderedColumnIds().length).toBeGreaterThan(0));
      expect(renderedColumnIds()).toEqual(["backlog", "staging", "building", "signoff", "shipped"]);
    });
  });

  describe("Board — mobile breakpoint", () => {
    it("renders the same resolved column set on mobile", async () => {
      mockViewport(true);
      fetchBoardWorkflowsMock.mockResolvedValue(
        payload([RENAMED_WORKFLOW], { "FN-8": RENAMED_WORKFLOW.id }),
      );
      renderBoard([mkTask({ id: "FN-8", column: "staging" as Task["column"] })]);

      await waitFor(() => expect(renderedColumnIds().length).toBeGreaterThan(0));
      expect(renderedColumnIds()).toEqual(["backlog", "staging", "building", "signoff", "shipped"]);
      expect(taskIdsInColumn("staging")).toEqual(["FN-8"]);
    });
  });

  describe("ListView", () => {
    it("groups rows under the workflow's renamed column headings", async () => {
      fetchBoardWorkflowsMock.mockResolvedValue(
        payload([RENAMED_WORKFLOW], { "FN-9": RENAMED_WORKFLOW.id }),
      );
      renderList([mkTask({ id: "FN-9", title: "Renamed row", column: "staging" as Task["column"] })]);

      await screen.findByText("Renamed row");
      expect(
        screen.getAllByRole("row").some((row) => row.textContent?.includes("Ready to build")),
      ).toBe(true);
    });

    it("does not drop a card whose stored column the workflow no longer declares", async () => {
      fetchBoardWorkflowsMock.mockResolvedValue(
        payload([REMOVED_HOLD_WORKFLOW], { "FN-10": REMOVED_HOLD_WORKFLOW.id }),
      );
      renderList([mkTask({ id: "FN-10", title: "Stranded row", column: "todo" })]);

      // Wait for the workflow payload to be applied before asserting.
      await waitFor(() => expect(fetchBoardWorkflowsMock).toHaveBeenCalled());
      expect(await screen.findByText("Stranded row")).toBeTruthy();
    });

    /*
    FNXC:WorkflowResolvedColumns 2026-07-27-18:35 (U10 / R8 — greptile P1 on PR #2492):
    In the All-workflows list the column set is a cross-workflow union with the DEFAULT workflow
    first, so a single global fallback lane sends a stranded card from workflow B into workflow A's
    intake — visible, but filed under another workflow's lifecycle. The landing lane must come from
    the card's OWN workflow.
    */
    it("re-homes a stranded card into its own workflow's intake, not the default workflow's", async () => {
      selectAllWorkflowsView();
      const alpha = {
        id: "wf-alpha",
        name: "Alpha",
        columns: [
          { id: "alpha-intake", name: "Alpha Intake", flags: { intake: true } },
          { id: "alpha-done", name: "Alpha Done", flags: { complete: true } },
        ],
      };
      const beta = {
        id: "wf-beta",
        name: "Beta",
        columns: [
          { id: "beta-intake", name: "Beta Intake", flags: { intake: true } },
          { id: "beta-done", name: "Beta Done", flags: { complete: true } },
        ],
      };
      fetchBoardWorkflowsMock.mockResolvedValue(payload([alpha, beta], { "FN-15": beta.id }));
      renderList([mkTask({ id: "FN-15", title: "Beta stranded row", column: "beta-gone" as Task["column"] })]);

      await screen.findByText("Beta stranded row");
      await waitFor(() => expect(listSectionOfRow("FN-15")).toContain("Beta Intake"));
      expect(listSectionOfRow("FN-15")).not.toContain("Alpha Intake");
    });

    it("does not drop a stranded card on mobile either", async () => {
      mockViewport(true);
      fetchBoardWorkflowsMock.mockResolvedValue(
        payload([REMOVED_HOLD_WORKFLOW], { "FN-11": REMOVED_HOLD_WORKFLOW.id }),
      );
      renderList([mkTask({ id: "FN-11", title: "Stranded mobile row", column: "todo" })]);

      await waitFor(() => expect(fetchBoardWorkflowsMock).toHaveBeenCalled());
      expect(await screen.findByText("Stranded mobile row")).toBeTruthy();
    });
  });

  describe("Move menu (TaskContextMenu)", () => {
    const t = ((_key: string, fallback: string, vars?: Record<string, string>) =>
      vars?.column ? fallback.replace("{{column}}", vars.column) : fallback) as never;
    const columnLabel = (column: string) => column;

    const renamedMoveColumns: TaskContextMenuColumnMetadata[] = RENAMED_WORKFLOW.columns.map((column) => ({
      id: column.id,
      label: column.name,
      flags: column.flags,
    }));
    const removedHoldMoveColumns: TaskContextMenuColumnMetadata[] = REMOVED_HOLD_WORKFLOW.columns.map((column) => ({
      id: column.id,
      label: column.name,
      flags: column.flags,
    }));

    it("offers exactly the workflow's neighbouring columns, by their own labels", () => {
      const transitions = getTaskMoveTransitions(
        mkTask({ id: "FN-12", column: "staging" as Task["column"] }),
        t,
        columnLabel,
        renamedMoveColumns,
      );
      expect(transitions.map((transition) => transition.column)).toEqual(["backlog", "building"]);
      expect(transitions.map((transition) => transition.label)).toEqual([
        "Move to Backlog",
        "Move to Building",
      ]);
    });

    /*
    FNXC:TaskContextMenu 2026-07-29-00:00 (U12 — R8):
    The "Back to X" label must follow the workflow's TRAITS, not the hardcoded ids
    `in-review`/`in-progress`. This workflow renames both lanes — `signoff` carries
    `mergeBlocker`, `building` carries `countsTowardWip` — so leaving review backwards
    into the work lane must read "Back to Building" and name the column the operator
    actually sees.

    REVERT CHECK: restore `column === "in-progress" && task.column === "in-review"` and
    this fails twice over — the ids never match, so the label falls through to "Move to
    Building"; and the old hardcoded string would have said "Back to In Progress", a
    column name absent from this board entirely.
    */
    it("labels a backwards move using the workflow's own review/work traits and label", () => {
      const transitions = getTaskMoveTransitions(
        mkTask({ id: "FN-15", column: "signoff" as Task["column"] }),
        t,
        columnLabel,
        renamedMoveColumns,
      );
      const building = transitions.find((transition) => transition.column === "building");
      expect(building).toBeDefined();
      expect(building!.label).toBe("Back to Building");
      // The forward move keeps "Move to", so the rule stays a distinction and not a
      // blanket relabel.
      const shipped = transitions.find((transition) => transition.column === "shipped");
      expect(shipped?.label).toBe("Move to Shipped");
    });

    /*
    FNXC:TaskContextMenu 2026-07-29-00:00 (PR #2521 review — greptile):
    A workflow may place a `countsTowardWip` lane AFTER its `mergeBlocker` one (rework
    or hotfix downstream of review). The traits alone would label that FORWARD move
    "Back to"; direction has to be part of the predicate.

    REVERT CHECK: drop the order comparison and this fails — `hotfix` is labelled
    "Back to Hotfix" despite sitting after `signoff` in the declared order.
    */
    it("does not call a forward move backwards when a WIP lane follows review", () => {
      // Placed immediately AFTER signoff so it is a neighbour (and therefore offered),
      // while still sitting later in the declared order.
      const signoffIndex = renamedMoveColumns.findIndex((column) => column.id === "signoff");
      const downstreamWip: TaskContextMenuColumnMetadata[] = [
        ...renamedMoveColumns.slice(0, signoffIndex + 1),
        { id: "hotfix" as ColumnId, label: "Hotfix", flags: { countsTowardWip: true } },
        ...renamedMoveColumns.slice(signoffIndex + 1),
      ];
      const transitions = getTaskMoveTransitions(
        mkTask({ id: "FN-18", column: "signoff" as Task["column"] }),
        t,
        columnLabel,
        downstreamWip,
      );
      const hotfix = transitions.find((transition) => transition.column === "hotfix");
      expect(hotfix).toBeDefined();
      expect(hotfix!.label).toBe("Move to Hotfix");
      // The genuinely-backwards move keeps its label, so the fix narrows rather than
      // disables the rule.
      const building = transitions.find((transition) => transition.column === "building");
      expect(building?.label).toBe("Back to Building");
    });

    /*
    FNXC:WorkflowResolvedColumns 2026-07-29-00:00 (U12 — R8):
    When the payload carries `moveTargets`, the menu uses the workflow's REAL graph
    adjacency instead of approximating from neighbouring columns. This fixture makes
    the two disagree on purpose: `staging` sits between `backlog` and `building`, so
    the neighbour approximation yields exactly those two — while the declared
    adjacency also allows a jump to `shipped` and forbids going back to `backlog`.

    REVERT CHECK: drop the `declaredTargets` branch and this fails — the neighbour
    fallback returns ["backlog","building"], missing the legal `shipped` jump and
    offering `backlog`, which the workflow's graph does not allow. That is precisely
    the class of defect the old neighbour approximation shipped for every custom
    workflow: menu entries the store would reject, and legal moves it never offered.
    */
    it("uses the workflow's declared adjacency, not neighbouring columns", () => {
      const withAdjacency: TaskContextMenuColumnMetadata[] = renamedMoveColumns.map((column) =>
        column.id === "staging"
          ? { ...column, moveTargets: ["building", "shipped"] }
          : column,
      );
      const transitions = getTaskMoveTransitions(
        mkTask({ id: "FN-16", column: "staging" as Task["column"] }),
        t,
        columnLabel,
        withAdjacency,
      );
      expect(transitions.map((transition) => transition.column)).toEqual(["building", "shipped"]);
    });

    it("drops an adjacency edge into a column this board cannot show", () => {
      /*
      Two distinct exclusions, because they fail differently (PR #2525 review —
      CodeRabbit): `hidden` is a DECLARED column carrying `hiddenFromBoard`, which only
      the visibility filter removes, and `nowhere` is an id the workflow does not
      declare at all. Testing only the unknown id would let the hidden-column filtering
      be deleted with the case still green.
      */
      const withHidden: TaskContextMenuColumnMetadata[] = [
        ...renamedMoveColumns.map((column) =>
          column.id === "staging"
            ? { ...column, moveTargets: ["building", "hidden", "nowhere"] }
            : column,
        ),
        { id: "hidden" as ColumnId, label: "Hidden", flags: { hiddenFromBoard: true } },
      ];
      const transitions = getTaskMoveTransitions(
        mkTask({ id: "FN-17", column: "staging" as Task["column"] }),
        t,
        columnLabel,
        withHidden,
      );
      expect(transitions.map((transition) => transition.column)).toEqual(["building"]);
    });

    it("never offers a column the workflow does not declare", () => {
      const transitions = getTaskMoveTransitions(
        mkTask({ id: "FN-13", column: "in-review" }),
        t,
        columnLabel,
        removedHoldMoveColumns,
      );
      expect(transitions.map((transition) => transition.column)).not.toContain("todo");
    });

    it("gives a card stranded in an undeclared column a way out", () => {
      const transitions = getTaskMoveTransitions(
        mkTask({ id: "FN-14", column: "todo" }),
        t,
        columnLabel,
        removedHoldMoveColumns,
      );
      expect(transitions.length).toBeGreaterThan(0);
      expect(transitions.map((transition) => transition.column)).toContain("triage");
    });
  });
});
