/*
FNXC:WorkflowResolvedColumns 2026-07-31-06:35:
THE GRAPH'S STUCK INDICATOR ASKED THE LEGACY QUESTION ON EVERY BOARD.

`GraphTaskNode` called `isTaskStuck(task, timeoutMs, lastFetchMs)` with no resolved traits, while six
of the seven other call sites in the tree supplied them. Stuck detection is a lane question — a card
is stuck only in an executing lane — so on a renamed board the answer came from `in-progress`, a
column that board does not have.

WHY IT SAT SO LONG. The gate that flags exactly this shape did not scan `plugins/` until #3002, and
the exemption added there justified itself first as a published-API change and then as build
plumbing. Both were wrong. The actual blocker was `dashboard-interop.d.ts`, a hand-maintained mirror
of the dashboard surfaces this plugin uses, which still declared the pre-conversion three-argument
`isTaskStuck` — so the argument could not be passed even deliberately.

The assertion is on the ARGUMENT the component hands the predicate, not on rendered output: the
defect is a dropped argument, and rendering asserts what the predicate does with it.
*/

import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type React from "react";
import type { Task } from "@fusion/core";
import { GraphTaskNode } from "../GraphTaskNode";

const stuckCalls: unknown[][] = [];
vi.mock("@fusion/dashboard/app/utils/taskStuck", () => ({
  isTaskStuck: (...args: unknown[]) => {
    stuckCalls.push(args);
    return false;
  },
}));

vi.mock("@fusion/dashboard/app/hooks/useToast", () => ({
  useToast: () => ({ addToast: vi.fn(), removeToast: vi.fn(), toasts: [] }),
  useOptionalToast: () => ({ addToast: vi.fn(), removeToast: vi.fn(), toasts: [] }),
}));

function task(column: string): Task {
  return { id: "FN-1", description: "FN-1", column, dependencies: [], steps: [], currentStep: 0, log: [] } as unknown as Task;
}

function props(overrides: Partial<React.ComponentProps<typeof GraphTaskNode>> = {}): React.ComponentProps<typeof GraphTaskNode> {
  return {
    task: task("building"),
    projectId: "p1",
    position: { x: 0, y: 0 },
    scale: 1,
    isSelected: false,
    isHighlighted: false,
    isDimmed: false,
    onNodePositionChange: vi.fn(),
    onNodeDragStateChange: vi.fn(),
    onOpenDetail: vi.fn(),
    addToast: vi.fn(),
    onUpdateTask: vi.fn(),
    onArchiveTask: vi.fn(),
    onUnarchiveTask: vi.fn(),
    onDeleteTask: vi.fn(),
    onRetryTask: vi.fn(),
    onOpenDetailWithTab: vi.fn(),
    onMoveTask: vi.fn(),
    onOpenMission: vi.fn(),
    taskStuckTimeoutMs: 1000,
    lastFetchTimeMs: Date.now(),
    workflowStepNameLookup: new Map<string, string>(),
    ...overrides,
  } as React.ComponentProps<typeof GraphTaskNode>;
}

describe("the graph node's stuck check under a renamed board vocabulary", () => {
  afterEach(() => { cleanup(); stuckCalls.length = 0; });

  it("hands the card's resolved traits to the stuck predicate", () => {
    render(<GraphTaskNode {...props({ taskColumnFlags: { countsTowardWip: true } })} />);

    expect(stuckCalls.length).toBeGreaterThan(0);
    expect(stuckCalls[0]?.[3]).toEqual({ countsTowardWip: true });
  });

  /* The documented degraded path: no traits resolved is an ANSWER — the predicate falls back to the
     legacy id rather than receiving a fabricated set. */
  it("passes undefined when the host resolved no traits for the card", () => {
    render(<GraphTaskNode {...props()} />);

    expect(stuckCalls.length).toBeGreaterThan(0);
    expect(stuckCalls[0]?.[3]).toBeUndefined();
  });
});
