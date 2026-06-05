// FN-1416: Board-level coverage of the canDropTask drag pre-check (R17).
//
// canDropTask is an internal Board closure passed down to <Lane>. Board.tsx is
// being edited by another agent, so rather than touch it (or its existing
// test), this file mocks <Lane> to CAPTURE the real canDropTask closure Board
// constructs, then drives the three rejection branches plus the allowed case:
//   - cross-workflow drag                    → "board.rejection.workflowMismatch"
//   - unknown target column in the lane      → "board.rejection.unknownColumn"
//   - full wip column (>= maxConcurrent)     → "board.rejection.capacityExhausted"
//   - valid same-lane, under-capacity drop   → null (allowed)
//
// This exercises the production closure (not a copy), so a regression in any
// branch fails here.

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import type { Task } from "@fusion/core";
import { Board } from "../Board";

vi.mock("../../hooks/useBatchBadgeFetch", () => ({
  useBatchBadgeFetch: vi.fn(() => ({
    fetchBatch: vi.fn(),
    isLoading: false,
    lastFetchTime: null,
    getBatchData: vi.fn(),
  })),
}));

const fetchBoardWorkflowsMock = vi.fn();
vi.mock("../../api", () => ({
  fetchWorkflowSteps: vi.fn().mockResolvedValue([]),
  fetchBoardWorkflows: (...args: unknown[]) => fetchBoardWorkflowsMock(...args),
  promoteTask: vi.fn().mockResolvedValue({}),
}));

vi.mock("../../sse-bus", () => ({
  subscribeSse: vi.fn(() => () => {}),
}));

// Don't pull in the full Column tree from the mocked Lane.
vi.mock("../Column", () => ({ Column: () => <div /> }));

// Capture the canDropTask closure Board passes to each Lane.
type CanDrop = (taskId: string, targetColumnId: string, workflowId: string) => string | null;
let capturedCanDropTask: CanDrop | null = null;
vi.mock("../Lane", () => ({
  Lane: (props: { canDropTask: CanDrop }) => {
    capturedCanDropTask = props.canDropTask;
    return <section data-testid="lane" />;
  },
}));

const DEFAULT_LANE = "builtin:coding";
const CUSTOM_LANE = "WF-001";

// builtin:coding columns (in-progress counts toward wip; todo does not).
const defaultColumns = [
  { id: "triage", name: "Triage", flags: {} },
  { id: "todo", name: "Todo", flags: {} },
  { id: "in-progress", name: "In Progress", flags: { countsTowardWip: true } },
  { id: "in-review", name: "In Review", flags: {} },
  { id: "done", name: "Done", flags: { complete: true } },
];
const customColumns = [
  { id: "c-intake", name: "Intake", flags: { intake: true } },
  { id: "c-run", name: "Run", flags: { countsTowardWip: true } },
  { id: "c-done", name: "Done", flags: { complete: true } },
];

function makeTask(id: string, column: string): Task {
  const now = new Date().toISOString();
  return {
    id,
    description: id,
    column,
    dependencies: [],
    createdAt: now,
    updatedAt: now,
    size: "M",
    subtasks: [],
    log: [],
    tags: [],
    blockedBy: [],
    source: { sourceType: "api" },
  } as unknown as Task;
}

function boardProps(overrides: Record<string, unknown> = {}) {
  return {
    tasks: [] as Task[],
    maxConcurrent: 2,
    onMoveTask: () => Promise.resolve({} as never),
    onOpenDetail: () => {},
    addToast: () => {},
    onQuickCreate: () => Promise.resolve({} as never),
    onNewTask: () => {},
    autoMerge: true,
    onToggleAutoMerge: () => {},
    globalPaused: false,
    ...overrides,
  };
}

/** Render Board flag-ON with the given tasks and wait for canDropTask capture. */
async function renderAndCapture(tasks: Task[], taskWorkflowIds: Record<string, string>) {
  fetchBoardWorkflowsMock.mockResolvedValue({
    flagEnabled: true,
    defaultWorkflowId: DEFAULT_LANE,
    workflows: [
      { id: DEFAULT_LANE, name: "Coding", columns: defaultColumns },
      { id: CUSTOM_LANE, name: "Custom", columns: customColumns },
    ],
    taskWorkflowIds,
  });
  await act(async () => {
    const props = boardProps({ tasks }) as unknown as React.ComponentProps<typeof Board>;
    render(<Board {...props} />);
    await Promise.resolve();
  });
  expect(capturedCanDropTask).toBeTypeOf("function");
  return capturedCanDropTask!;
}

describe("Board canDropTask pre-check (FN-1416)", () => {
  beforeEach(() => {
    capturedCanDropTask = null;
    fetchBoardWorkflowsMock.mockReset();
    try { window.localStorage.clear(); } catch { /* jsdom */ }
  });

  it("cross-workflow drag → workflowMismatch", async () => {
    // FN-1 lives in the default lane; dragging it into the custom lane crosses
    // workflows (R17 never switches a card's workflow via drag).
    const tasks = [makeTask("FN-1", "todo")];
    const canDrop = await renderAndCapture(tasks, { "FN-1": DEFAULT_LANE });
    expect(canDrop("FN-1", "c-run", CUSTOM_LANE)).toBe("board.rejection.workflowMismatch");
  });

  it("unknown target column in the lane → unknownColumn", async () => {
    const tasks = [makeTask("FN-1", "todo")];
    const canDrop = await renderAndCapture(tasks, { "FN-1": DEFAULT_LANE });
    expect(canDrop("FN-1", "does-not-exist", DEFAULT_LANE)).toBe("board.rejection.unknownColumn");
  });

  it("full wip column (occupants >= maxConcurrent) → capacityExhausted", async () => {
    // maxConcurrent: 2; two cards already occupy in-progress in the default lane.
    // Dragging a third (from todo) into in-progress must reject on capacity.
    const tasks = [
      makeTask("FN-1", "todo"),
      makeTask("FN-2", "in-progress"),
      makeTask("FN-3", "in-progress"),
    ];
    const canDrop = await renderAndCapture(tasks, {
      "FN-1": DEFAULT_LANE,
      "FN-2": DEFAULT_LANE,
      "FN-3": DEFAULT_LANE,
    });
    expect(canDrop("FN-1", "in-progress", DEFAULT_LANE)).toBe("board.rejection.capacityExhausted");
  });

  it("valid same-lane drop under capacity → allowed (null)", async () => {
    // One free in-progress slot (maxConcurrent 2, one occupant); moving FN-1 from
    // todo into in-progress in its own lane is permitted.
    const tasks = [makeTask("FN-1", "todo"), makeTask("FN-2", "in-progress")];
    const canDrop = await renderAndCapture(tasks, { "FN-1": DEFAULT_LANE, "FN-2": DEFAULT_LANE });
    expect(canDrop("FN-1", "in-progress", DEFAULT_LANE)).toBeNull();
    // Dropping into a non-wip column (todo → in-review) is also allowed.
    expect(canDrop("FN-1", "in-review", DEFAULT_LANE)).toBeNull();
  });
});
