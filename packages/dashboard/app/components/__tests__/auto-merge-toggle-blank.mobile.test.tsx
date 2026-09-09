import React, { useState } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { Board } from "../Board";
import { PageErrorBoundary } from "../ErrorBoundary";
import { MOBILE_MEDIA_QUERY } from "../../hooks/useViewportMode";
import type { Task } from "@fusion/core";

vi.mock("../../api", () => ({
  /*
  FNXC:WorkflowColumns 2026-07-30-07:10:
  The board needs a RESOLVED lane payload or it renders the skeleton forever. Board.tsx:874 shows
  `BoardWorkflowSkeleton` whenever `boardWorkflows === null || boardWorkflows.workflows.length === 0`,
  so an empty `workflows: []` leaves the board at `data-testid="board-workflows-skeleton"` with no
  lanes, no task cards and no Auto-merge toggle — which is why every query here failed with
  "Unable to find an accessible element".

  This fixture passed `flagEnabled: false` to get the LEGACY board. U12/R9 deleted that path and
  dropped the `flagEnabled` conjunct from the skeleton condition, so the flag now selects nothing and
  the empty lane list is all that remains. These are the default lifecycle lanes a real board sends.

  Inlined rather than referencing a module const: `vi.mock` factories are HOISTED above const
  declarations, so a named payload above this block fails with "Cannot access before initialization"
  and the file reports "no tests".
  */
  fetchBoardWorkflows: vi.fn().mockResolvedValue({
    flagEnabled: true,
    defaultWorkflowId: "builtin:coding",
    workflows: [
      {
        id: "builtin:coding",
        name: "Coding",
        columns: [
          { id: "todo", name: "Todo", flags: { intake: true, hold: true } },
          { id: "in-progress", name: "In Progress", flags: { countsTowardWip: true } },
          { id: "in-review", name: "In Review", flags: { mergeBlocker: true, humanReview: true } },
          { id: "done", name: "Done", flags: { complete: true } },
        ],
      },
    ],
    taskWorkflowIds: {},
  }),
  fetchWorkflowSteps: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../hooks/useBlockerFanout", () => ({
  useBlockerFanout: () => new Map(),
}));

vi.mock("../../hooks/useConfirm", () => ({
  useConfirm: () => ({ confirm: vi.fn() }),
}));

vi.mock("../../hooks/useFlashOnIncrease", () => ({
  useFlashOnIncrease: () => false,
}));

vi.mock("../PluginSlot", () => ({
  PluginSlot: () => null,
}));

vi.mock("../QuickEntryBox", () => ({
  QuickEntryBox: () => null,
}));

vi.mock("../TaskCard", () => ({
  TaskCard: ({ task, autoMergeEnabled }: { task: Task; autoMergeEnabled?: boolean }) => {
    if (task.id === "FN-ERROR" && autoMergeEnabled === false) {
      throw new Error("Auto-merge render failed");
    }
    return <div data-testid={`task-card-${task.id}`}>task:{task.id}:{String(autoMergeEnabled)}</div>;
  },
}));

vi.mock("../WorktreeGroup", () => ({
  WorktreeGroup: ({ label, autoMergeEnabled }: { label: string; autoMergeEnabled?: boolean }) => (
    <div data-testid={`worktree-group-${label}`}>worktree:{String(autoMergeEnabled)}</div>
  ),
}));

function ensureMatchMedia() {
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn(),
    });
  }
}

function mockViewport(width: number, height = 812) {
  ensureMatchMedia();
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: height, configurable: true });
  return vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: query === MOBILE_MEDIA_QUERY ? width <= 768 || height <= 480 : false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function createVisualViewport(scale = 1) {
  const resizeListeners = new Set<() => void>();
  return {
    scale,
    addEventListener: vi.fn((event: string, listener: () => void) => {
      if (event === "resize") {
        resizeListeners.add(listener);
      }
    }),
    removeEventListener: vi.fn((event: string, listener: () => void) => {
      if (event === "resize") {
        resizeListeners.delete(listener);
      }
    }),
    dispatchResize: () => {
      for (const listener of [...resizeListeners]) {
        listener();
      }
    },
  };
}

/*
FNXC:BoardNavigation 2026-07-14-19:30:
Board stabilization resets document horizontal scroll only — #board is the intentional column scroller and must not be forced to 0 on visualViewport resize/pageshow.
*/
function expectDocumentScrollPinned() {
  expect(window.scrollX).toBe(0);
  expect(document.documentElement.scrollLeft).toBe(0);
  if (document.body) {
    expect(document.body.scrollLeft).toBe(0);
  }
}

function createTask(id: string, column: Task["column"]): Task {
  return {
    id,
    title: id,
    description: `${id} description`,
    column,
    status: column === "in-review" ? "in-review" : undefined,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
  } as Task;
}

function BaseBoardHarness({
  tasks,
  autoMerge,
  onToggleAutoMerge,
  showWorktreeGrouping = false,
}: {
  tasks: Task[];
  autoMerge: boolean;
  onToggleAutoMerge: () => void | Promise<void>;
  showWorktreeGrouping?: boolean;
}) {
  return (
    <PageErrorBoundary>
      <Board
        tasks={tasks}
        maxConcurrent={2}
        showWorktreeGrouping={showWorktreeGrouping}
        onMoveTask={vi.fn(async () => ({} as Task))}
        onOpenDetail={vi.fn()}
        addToast={vi.fn()}
        onQuickCreate={vi.fn(async () => undefined)}
        onNewTask={vi.fn()}
        autoMerge={autoMerge}
        onToggleAutoMerge={onToggleAutoMerge}
        globalPaused={false}
      />
    </PageErrorBoundary>
  );
}

function BoardHarness({
  tasks,
  initialAutoMerge = true,
  showWorktreeGrouping = false,
}: {
  tasks: Task[];
  initialAutoMerge?: boolean;
  showWorktreeGrouping?: boolean;
}) {
  const [autoMerge, setAutoMerge] = useState(initialAutoMerge);

  return (
    <BaseBoardHarness
      tasks={tasks}
      autoMerge={autoMerge}
      showWorktreeGrouping={showWorktreeGrouping}
      onToggleAutoMerge={() => setAutoMerge((current) => !current)}
    />
  );
}

function RollbackBoardHarness({ tasks }: { tasks: Task[] }) {
  const [autoMerge, setAutoMerge] = useState(true);

  return (
    <BaseBoardHarness
      tasks={tasks}
      autoMerge={autoMerge}
      onToggleAutoMerge={async () => {
        const previousAutoMerge = autoMerge;
        const nextAutoMerge = !previousAutoMerge;
        setAutoMerge(nextAutoMerge);

        try {
          await Promise.reject(new Error("network"));
        } catch {
          setAutoMerge(previousAutoMerge);
        }
      }}
    />
  );
}

function installAnimationFrame() {
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    setTimeout(() => cb(0), 0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
}

/*
FNXC:WorkflowColumns 2026-07-30-07:30:
Render, then FLUSH the board-workflows promise before asserting. `Board` resolves its lane payload
asynchronously and shows `BoardWorkflowSkeleton` until it lands (Board.tsx:874), so a synchronous
assertion right after `render()` always saw "Loading workflow lanes" and no lanes. These fixtures
used to pass `flagEnabled: false` and get the LEGACY board, which rendered synchronously — U12/R9
deleted that path, so the await is now required rather than optional.

Wrapped in `act` so the resulting state update is applied before the queries run, and kept to a
microtask flush (not a timer advance) because this suite runs on fake timers.
*/
async function renderBoardWithLanes(ui: React.ReactElement) {
  const result = render(ui);
  await act(async () => {
    await Promise.resolve();
  });
  return result;
}

function expectBoardVisible() {
  expect(document.querySelector("main.board")).not.toBeNull();
  expect(screen.getByText("In Review")).toBeInTheDocument();
  expect(screen.queryByText("Something went wrong")).toBeNull();
}

describe("auto-merge toggle mobile blank regression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps the mobile board visible after an Android viewport resize triggered by toggling auto-merge", async () => {
    const viewportSpy = mockViewport(375);
    const visualViewport = createVisualViewport(1);
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: visualViewport,
    });
    installAnimationFrame();

    await renderBoardWithLanes(<BoardHarness tasks={[createTask("FN-5936", "in-review")]} />);

    const board = document.querySelector("main.board") as HTMLElement;
    expect(screen.getByTestId("task-card-FN-5936")).toHaveTextContent("true");
    expectBoardVisible();

    act(() => {
      vi.runOnlyPendingTimers();
    });

    board.scrollLeft = 240;
    act(() => {
      visualViewport.dispatchResize();
      vi.runOnlyPendingTimers();
    });
    expectDocumentScrollPinned();

    board.scrollLeft = 240;
    fireEvent.click(screen.getByRole("checkbox", { name: "Auto-merge" }));

    expect(screen.getByTestId("task-card-FN-5936")).toHaveTextContent("false");

    board.scrollLeft = 240;
    act(() => {
      visualViewport.dispatchResize();
      vi.runOnlyPendingTimers();
    });

    expectBoardVisible();
    expectDocumentScrollPinned();
    viewportSpy.mockRestore();
  });

  it("round-trips auto-merge on mobile Android with an empty in-review column without blanking", async () => {
    const viewportSpy = mockViewport(375);
    const visualViewport = createVisualViewport(1);
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: visualViewport,
    });
    installAnimationFrame();

    await renderBoardWithLanes(<BoardHarness tasks={[]} />);
    const board = document.querySelector("main.board") as HTMLElement;

    act(() => {
      vi.runOnlyPendingTimers();
    });

    const toggle = screen.getByRole("checkbox", { name: "Auto-merge" });
    expect(toggle).toBeChecked();
    expectBoardVisible();

    fireEvent.click(toggle);
    expect(toggle).not.toBeChecked();
    board.scrollLeft = 180;
    act(() => {
      visualViewport.dispatchResize();
      vi.runOnlyPendingTimers();
    });
    expectBoardVisible();
    expectDocumentScrollPinned();

    fireEvent.click(toggle);
    expect(toggle).toBeChecked();
    board.scrollLeft = 180;
    act(() => {
      visualViewport.dispatchResize();
      vi.runOnlyPendingTimers();
    });
    expectBoardVisible();
    expectDocumentScrollPinned();
    viewportSpy.mockRestore();
  });

  it("keeps populated task-card and worktree surfaces visible when auto-merge toggles on mobile", async () => {
    const viewportSpy = mockViewport(375);
    const visualViewport = createVisualViewport(1);
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: visualViewport,
    });
    installAnimationFrame();

    await renderBoardWithLanes(
      <BoardHarness
        showWorktreeGrouping
        tasks={[
          createTask("FN-5936", "in-review"),
          createTask("FN-IP", "in-progress"),
        ]}
      />,
    );

    act(() => {
      vi.runOnlyPendingTimers();
    });

    expect(screen.getByTestId("task-card-FN-5936")).toHaveTextContent("true");
    expect(screen.getByTestId("worktree-group-Unassigned")).toHaveTextContent("true");

    fireEvent.click(screen.getByRole("checkbox", { name: "Auto-merge" }));

    expect(screen.getByTestId("task-card-FN-5936")).toHaveTextContent("false");
    expect(screen.getByTestId("worktree-group-Unassigned")).toHaveTextContent("false");
    expectBoardVisible();
    viewportSpy.mockRestore();
  });

  it("re-anchors on the mobile iOS pageshow path after toggling auto-merge", async () => {
    const viewportSpy = mockViewport(375);
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: createVisualViewport(1.1),
    });
    installAnimationFrame();

    await renderBoardWithLanes(<BoardHarness tasks={[createTask("FN-IOS", "in-review")]} />);
    const board = document.querySelector("main.board") as HTMLElement;

    act(() => {
      vi.runOnlyPendingTimers();
    });

    fireEvent.click(screen.getByRole("checkbox", { name: "Auto-merge" }));
    board.scrollLeft = 210;

    const pageShow = new Event("pageshow") as PageTransitionEvent;
    Object.defineProperty(pageShow, "persisted", { configurable: true, value: true });
    act(() => {
      window.dispatchEvent(pageShow);
      vi.runOnlyPendingTimers();
    });

    expectBoardVisible();
    expectDocumentScrollPinned();
    viewportSpy.mockRestore();
  });

  it("keeps the board visible on tablet where the mobile stabilization effect is disabled", async () => {
    const viewportSpy = mockViewport(900);
    installAnimationFrame();

    await renderBoardWithLanes(<BoardHarness tasks={[createTask("FN-TABLET", "in-review")]} />);

    const toggle = screen.getByRole("checkbox", { name: "Auto-merge" });
    expect(toggle).toBeChecked();
    expectBoardVisible();

    fireEvent.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(screen.getByTestId("task-card-FN-TABLET")).toHaveTextContent("false");
    expectBoardVisible();
    viewportSpy.mockRestore();
  });

  it("keeps the board visible on desktop after toggling auto-merge", async () => {
    const viewportSpy = mockViewport(1280);
    installAnimationFrame();

    await renderBoardWithLanes(<BoardHarness tasks={[createTask("FN-DESKTOP", "in-review")]} />);

    fireEvent.click(screen.getByRole("checkbox", { name: "Auto-merge" }));

    expect(screen.getByTestId("task-card-FN-DESKTOP")).toHaveTextContent("false");
    expectBoardVisible();
    viewportSpy.mockRestore();
  });

  it("keeps the mobile board visible when the toggle rolls back after an update failure", async () => {
    const viewportSpy = mockViewport(375);
    const visualViewport = createVisualViewport(1);
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: visualViewport,
    });
    installAnimationFrame();

    await renderBoardWithLanes(<RollbackBoardHarness tasks={[createTask("FN-ROLLBACK", "in-review")]} />);

    const toggle = screen.getByRole("checkbox", { name: "Auto-merge" });
    expect(toggle).toBeChecked();

    await act(async () => {
      fireEvent.click(toggle);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(toggle).toBeChecked();
    expect(screen.getByTestId("task-card-FN-ROLLBACK")).toHaveTextContent("true");
    expectBoardVisible();
    viewportSpy.mockRestore();
  });

  it("shows a visible page error boundary fallback instead of a blank board when a board child throws", async () => {
    const viewportSpy = mockViewport(375);
    const visualViewport = createVisualViewport(1);
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: visualViewport,
    });
    installAnimationFrame();
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await renderBoardWithLanes(<BoardHarness tasks={[createTask("FN-ERROR", "in-review")]} />);

    fireEvent.click(screen.getByRole("checkbox", { name: "Auto-merge" }));

    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();

    consoleErrorSpy.mockRestore();
    viewportSpy.mockRestore();
  });
});
