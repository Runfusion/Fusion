/*
FNXC:WorkflowResolvedColumns 2026-07-30-23:50:
THE CARD FAN-OUT BADGES READ LEGACY LANE IDS ON A RENAMED BOARD.

`computeBlockerFanoutMap` in core takes four lane options. The dashboard wrapper
(`hooks/useBlockerFanout.ts`) declared and forwarded only `staleHighFanoutAgeThresholdMs`, so core
fell back to `holdColumn: "todo"`, `LEGACY_TERMINAL_COLUMNS` and `BLOCKER_ESCALATION_COLUMNS` for
every dashboard caller. On a board whose lanes are renamed none of those match, so `activeTodoCount`
— the "blocking N tasks" count on the card — comes back ZERO while real cards sit blocked.

WHY THIS TEST DRIVES `Board` RATHER THAN THE HOOK. Testing the wrapper would prove the wrapper
forwards what it is given and say nothing about whether anything gives it — the exact producer/
consumer split that this program's learnings doc records as its fifth failure shape, where a
converted consumer with an unconverted producer passed every instrument. The defect here IS the
producer: `Board` had no supplier for these options. So the assertion runs through the real Board,
the real per-task workflow metadata, and core's real computation.

The cases are DIFFERENTIAL: identical task graphs under two vocabularies whose roles are the same and
only the ids differ. `drafting` collides with no legacy id, so a surviving `"todo"` cannot pass by
luck.
*/

import type React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import type { Task } from "@fusion/core";
import { Board } from "../Board";
import type { BoardWorkflowsPayload } from "../../api";
import type { BlockerFanoutEntry } from "../../hooks/useBlockerFanout";

const fetchBoardWorkflowsMock = vi.fn();

vi.mock("../../api", () => ({
  fetchWorkflowSteps: vi.fn(() => new Promise(() => {})),
  fetchBoardWorkflows: (...args: unknown[]) => fetchBoardWorkflowsMock(...args),
  promoteTask: vi.fn().mockResolvedValue({}),
  fetchTaskDetail: vi.fn(() => new Promise(() => {})),
  batchUpdateTaskModels: vi.fn(),
  fetchNodes: vi.fn(() => new Promise(() => {})),
}));

vi.mock("../../sse-bus", () => ({ subscribeSse: vi.fn(() => () => {}) }));

/* The Column mock is the probe: it captures the fan-out map Board computed and handed down. */
let captured: ReadonlyMap<string, BlockerFanoutEntry> | undefined;
let renderedColumns = 0;
vi.mock("../Column", () => ({
  Column: ({ blockerFanoutMap }: { blockerFanoutMap?: ReadonlyMap<string, BlockerFanoutEntry> }) => {
    renderedColumns += 1;
    if (blockerFanoutMap) captured = blockerFanoutMap;
    return <section />;
  },
}));

const RENAME: Record<string, string> = {
  todo: "drafting",
  "in-progress": "building",
  "in-review": "checking",
  done: "shipped",
  archived: "filed",
};

function workflowsPayload(renamed: boolean): BoardWorkflowsPayload {
  const id = (legacy: string) => (renamed ? RENAME[legacy] : legacy);
  return {
    flagEnabled: true,
    defaultWorkflowId: "builtin:coding",
    /* Every card is explicitly mapped, so the per-task accessor resolves against THIS workflow
       rather than falling through the unmapped path. */
    taskWorkflowIds: { "KB-BLOCK": "builtin:coding", "KB-DEP1": "builtin:coding", "KB-DEP2": "builtin:coding" },
    workflows: [
      {
        id: "builtin:coding",
        name: "Coding",
        columns: [
          { id: id("todo"), name: "Hold", flags: { hold: true, intake: true } },
          { id: id("in-progress"), name: "Building", flags: { countsTowardWip: true } },
          {
            id: id("in-review"),
            name: "Checking",
            flags: { countsTowardWip: true, mergeBlocker: true, humanReview: true },
          },
          { id: id("done"), name: "Shipped", flags: { complete: true } },
        ],
      },
    ],
  } as unknown as BoardWorkflowsPayload;
}

/** One blocker plus two cards held behind it, in whichever lane plays the hold role. */
function tasksFor(holdLane: string): Task[] {
  const base = { description: "t", createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z" };
  return [
    { id: "KB-BLOCK", title: "the blocker", column: holdLane, ...base },
    { id: "KB-DEP1", title: "dep one", column: holdLane, dependencies: ["KB-BLOCK"], ...base },
    { id: "KB-DEP2", title: "dep two", column: holdLane, dependencies: ["KB-BLOCK"], ...base },
  ] as unknown as Task[];
}

async function renderBoard(renamed: boolean): Promise<BlockerFanoutEntry | undefined> {
  captured = undefined;
  fetchBoardWorkflowsMock.mockResolvedValue(workflowsPayload(renamed));
  const holdLane = renamed ? "drafting" : "todo";
  const props = {
    tasks: tasksFor(holdLane),
    projectId: "p1",
    maxConcurrent: 2,
    onMoveTask: vi.fn(),
    onOpenDetail: vi.fn(),
    addToast: vi.fn(),
    onQuickCreate: vi.fn(),
    onNewTask: vi.fn(),
    autoMerge: true,
    onToggleAutoMerge: vi.fn(),
    showWorktreeGrouping: false,
    planAutoApproveEnabled: false,
    onTogglePlanAutoApprove: vi.fn(),
  } as unknown as React.ComponentProps<typeof Board>;
  render(<Board {...props} />);
  /* ANTI-VACUITY: a Board that throws during render also produces no fan-out map, and the assertions
     below would then read `undefined` rather than a wrong number. Prove the tree actually rendered
     before trusting anything it handed down. */
  await waitFor(() => expect(renderedColumns).toBeGreaterThan(0));
  await waitFor(() => expect(captured).toBeDefined());
  return captured?.get("KB-BLOCK");
}

describe("blocker fan-out under a renamed board vocabulary", () => {
  beforeEach(() => {
    captured = undefined;
    vi.clearAllMocks();
  });

  /* Control: the default vocabulary counts both dependents. Passes before and after the fix, so a
     generally broken fan-out cannot hide behind the renamed case below. */
  it("default vocabulary: both held dependents are counted", async () => {
    const entry = await renderBoard(false);
    expect(entry?.totalCount).toBe(2);
    expect(entry?.activeTodoCount).toBe(2);
  });

  /* The defect: before the fix `holdColumn` was the literal "todo", which this board does not have,
     so the held count came back zero while two cards sat blocked. */
  it("renamed vocabulary: both held dependents are counted", async () => {
    const entry = await renderBoard(true);
    expect(entry?.totalCount).toBe(2);
    expect(entry?.activeTodoCount).toBe(2);
  });
});
