/*
FNXC:WorkflowResolvedColumns 2026-07-30-23:10:
THE HIGH-FAN-OUT BLOCKER WARNING NEVER RENDERED ON A RENAMED BOARD.

`ExecutorStatusBar` computes its own fan-out map to find the blocker holding up the most work. It
passed only `staleHighFanoutAgeThresholdMs`, so core fell back to `holdColumn: "todo"` — a lane a
renamed board does not have. `overlapBlockedTodoCount` then stayed at zero, `isHighFanout` (>= 5)
never tripped, and the warning simply never appeared while cards sat blocked.

The flags were in scope the whole time: this component already receives `columnFlagsByTaskId` for
`useExecutorStats`.

The cases are DIFFERENTIAL: the same six-card block under two vocabularies whose roles match and only
the ids differ. `drafting` collides with no legacy id, so a surviving `"todo"` cannot pass by luck.
*/

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Task } from "@fusion/core";
import { ExecutorStatusBar } from "../ExecutorStatusBar";
import type { ExecutorColumnFlags } from "../../hooks/useExecutorStats";

vi.mock("../../hooks/useExecutorStats", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useExecutorStats")>();
  return {
    ...actual,
    /* The blocker warning is independent of live stats; stub them so this test needs no API. */
    useExecutorStats: () => ({
      stats: { running: 0, blocked: 0, waiting: 0, inReview: 0, done: 0, lastActivityAt: null },
      loading: false,
      error: null,
    }),
  };
});

const BASE = {
  description: "t",
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
};

/** One blocker in the WIP lane, plus six cards blocked behind it in the hold lane. */
function tasksFor(holdLane: string, wipLane: string): Task[] {
  const blocked = Array.from({ length: 6 }, (_, index) => ({
    id: `KB-DEP${index + 1}`,
    title: `dep ${index + 1}`,
    column: holdLane,
    blockedBy: "KB-BLOCK",
    ...BASE,
  }));
  return [
    { id: "KB-BLOCK", title: "the blocker", column: wipLane, ...BASE },
    ...blocked,
  ] as unknown as Task[];
}

function flagsFor(tasks: Task[], holdLane: string, wipLane: string): ReadonlyMap<string, ExecutorColumnFlags> {
  const map = new Map<string, ExecutorColumnFlags>();
  for (const task of tasks) {
    if (task.column === holdLane) map.set(task.id, { hold: true, intake: true } as ExecutorColumnFlags);
    if (task.column === wipLane) map.set(task.id, { countsTowardWip: true } as ExecutorColumnFlags);
  }
  return map;
}

describe("the high fan-out blocker warning under a renamed board vocabulary", () => {
  /* Control: the legacy vocabulary trips the warning with no flags at all, which is the byte-identical
     unconverted path. Passes before and after the fix. */
  it("default vocabulary: the warning names the blocker and its held count", () => {
    render(<ExecutorStatusBar tasks={tasksFor("todo", "in-progress")} />);

    const statusBar = screen.getByRole("status");
    expect(statusBar).toHaveTextContent("KB-BLOCK");
    expect(statusBar).toHaveTextContent("6 todo");
  });

  /* The defect: before the fix `holdColumn` was the literal "todo", so the held count was zero, the
     high-fan-out threshold never tripped, and this whole block was absent. */
  it("renamed vocabulary: the warning still names the blocker and its held count", () => {
    const tasks = tasksFor("drafting", "building");
    render(
      <ExecutorStatusBar tasks={tasks} columnFlagsByTaskId={flagsFor(tasks, "drafting", "building")} />,
    );

    const statusBar = screen.getByRole("status");
    expect(statusBar).toHaveTextContent("KB-BLOCK");
    expect(statusBar).toHaveTextContent("6 todo");
  });

  /*
  The paired negative: resolving real lanes must not degrade into "every column is the hold lane".
  Cards already in the renamed WIP lane are not waiting work, so they must not inflate the count —
  otherwise the fix trades a silent zero for a wrong number, which invites no scrutiny at all.
  */
  it("renamed vocabulary: cards in the WIP lane do not count as held", () => {
    const tasks = tasksFor("building", "building");
    render(
      <ExecutorStatusBar tasks={tasks} columnFlagsByTaskId={flagsFor(tasks, "drafting", "building")} />,
    );

    expect(screen.getByRole("status")).not.toHaveTextContent("6 todo");
  });
});
