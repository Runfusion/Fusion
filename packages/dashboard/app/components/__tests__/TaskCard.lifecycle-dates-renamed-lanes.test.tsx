/*
FNXC:WorkflowResolvedColumns 2026-07-31-08:25:
THE "Completed <date>" LINE NEVER APPEARED ON A RENAMED BOARD.

`lifecycleDates` gates its `completed` value on the Complete-column role derived from the
`taskColumnFlags` PROP. The board resolves workflow traits asynchronously, so the first
computation runs with the flags undefined, the role helpers fall back to the legacy ids, and on a
board whose complete lane is named anything but `done` the answer is false.

The dependency list held only `task.*` fields, `locale` and `lifecycleNowMs`, so when the flags
arrived nothing invalidated and the card kept rendering no completion date.

WHY THIS SURVIVED THE #3001 SWEEP, which recorded `mergeSignature` as the last live site: this memo
DOES list a dependency that changes — `lifecycleNowMs`. But its timer fires at the viewer's local
midnight, so "eventually recomputes" means once a day. A value that must be correct on first paint is
not covered by a dependency that turns over daily.

Asserted through the rendered `<time>` element rather than the memo, because the memo returning a
value is not the user-visible contract — the date appearing on the card is.
*/

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Task } from "@fusion/core";
import { TaskCard } from "../TaskCard";

vi.mock("../../hooks/useTaskDiffStats", () => ({
  useTaskDiffStats: () => ({ stats: undefined, loading: false }),
}));

const noop = () => {};

/** A card that finished BEFORE the board resolved its traits. */
function completedTaskIn(column: string): Task {
  return {
    id: "KB-LD-1",
    title: "a finished card",
    description: "t",
    column,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-02T00:00:00.000Z",
    executionCompletedAt: "2026-06-02T00:00:00.000Z",
    steps: [],
  } as unknown as Task;
}

/** The board's own complete lane, as the async flags eventually describe it. */
const SHIPPED_IS_COMPLETE = { complete: true } as const;

function renderCard(column: string, flags: Record<string, boolean> | undefined) {
  return render(
    <TaskCard
      task={completedTaskIn(column)}
      onMoveTask={noop as never}
      onDeleteTask={noop as never}
      onOpenDetail={noop as never}
      addToast={noop as never}
      taskColumnFlags={flags as never}
    />,
  );
}

/* Matched by its own label. A positional selector is wrong here: when only "Created" renders,
   `time:last-of-type` returns THAT element and the absence assertion silently passes. */
function completedLine(): HTMLElement | null {
  const host = screen.queryByTestId("card-lifecycle-dates");
  if (!host) return null;
  return [...host.querySelectorAll("time")].find((el) => /Completed/i.test(el.textContent ?? "")) ?? null;
}

describe("TaskCard lifecycle dates on a renamed board", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  /*
  CONTROL. A default board answers `column === "done"` before the flags land, so this case passes
  with or without the fix — it is here so a failure below means "renamed board", not "nothing renders".
  */
  it("renders the completion date on a default board (control)", () => {
    renderCard("done", undefined);
    expect(screen.getByTestId("card-lifecycle-dates")).toBeTruthy();
    expect(completedLine()).toBeTruthy();
  });

  it("renders the completion date once the renamed lane's flags arrive", () => {
    const { rerender } = renderCard("shipped", undefined);

    /* Pre-resolution: the legacy fallback says "shipped" is not complete, so no date yet. */
    expect(completedLine()).toBeNull();

    rerender(
      <TaskCard
        task={completedTaskIn("shipped")}
        onMoveTask={noop as never}
        onDeleteTask={noop as never}
        onOpenDetail={noop as never}
        addToast={noop as never}
        taskColumnFlags={SHIPPED_IS_COMPLETE as never}
      />,
    );

    /* The flags arrived and `task.column` did not change — only a dep on the derived
       flags makes this recompute. Without them the card shows no completion date all session. */
    expect(completedLine()).toBeTruthy();
  });
});
