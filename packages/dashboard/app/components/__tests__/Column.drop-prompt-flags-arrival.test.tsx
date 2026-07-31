/*
FNXC:WorkflowResolvedColumns 2026-07-31-00:45:
DROPPING ONTO A RENAMED INTAKE LANE RESET PROGRESS WITHOUT ASKING.

`handleDrop` gates the "Preserve Progress?" confirmation on
`isPreImplementationColumnRole(columnFlags, column)`, but its `useCallback` deps omitted `columnFlags`.
The board resolves workflow traits after first paint, so the DOM kept the closure built during the
pre-load render — one holding `columnFlags === undefined`, where the helper falls back to
`LEGACY_PRE_IMPLEMENTATION_COLUMN_IDS` and a renamed intake lane is not a member.

Consequence: a card with completed steps dropped into that lane moved with `shouldPrompt === false`,
so the user was never offered "Keep Progress" and the steps were reset silently. This is the only one
of the six instances of this shape that LOSES WORK rather than mis-renders.

SEVERITY: `allTasks`/`tasks` are also in the dep list and change on any task-list refresh, so the
stale closure is rebuilt within seconds on a busy board. The exposure is the quiet gap right after
the traits land — bounded, like the near-duplicate chip, not permanent like the ticker.

THE OBSERVABLE IS `confirm`, not the move: whether the prompt was offered is the contract. Asserting
on `onMoveTask` alone would pass whether or not the user was asked.
*/

import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import type { Task, Column as ColumnType } from "@fusion/core";
import { Column } from "../Column";

const confirmMock = vi.hoisted(() => vi.fn());
vi.mock("../../hooks/useConfirm", () => ({ useConfirm: () => ({ confirm: confirmMock }) }));
vi.mock("../TaskCard", () => ({ TaskCard: () => <article /> }));
vi.mock("../WorktreeGroup", () => ({ WorktreeGroup: () => <div /> }));
vi.mock("../QuickEntryBox", () => ({ QuickEntryBox: () => <div /> }));

const BASE = { description: "t", createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z" };

/* A card carrying real step progress — the only kind the prompt is meant to protect. */
const worked = {
  id: "KB-WORK", title: "has progress", column: "building",
  steps: [{ id: "s1", name: "step", status: "done" }],
  ...BASE,
} as unknown as Task;

/* Stable identity across both renders: if this changed, the callback would be rebuilt for an
   unrelated reason and the test would pass without the fix. */
const allTasks = [worked];

const props = {
  column: "drafting" as ColumnType,
  maxConcurrent: 2,
  showWorktreeGrouping: false,
  onMoveTask: vi.fn().mockResolvedValue({} as Task),
  onOpenDetail: vi.fn(),
  addToast: vi.fn(),
  tasks: [],
  allTasks,
};

/** `drafting` is this board's intake lane — it just isn't called `todo`. */
const DRAFTING_IS_INTAKE = { intake: true, hold: true } as const;

function dropOnto(container: HTMLElement) {
  const zone = container.querySelector(".column") ?? container.firstElementChild!;
  fireEvent.drop(zone, { dataTransfer: { getData: () => "KB-WORK" } });
}

describe("the drop-progress prompt when column traits arrive after first paint", () => {
  it("prompts once the renamed intake lane's flags have arrived", async () => {
    confirmMock.mockReset();
    confirmMock.mockResolvedValue(true);

    const { container, rerender } = render(<Column {...(props as never)} />);
    rerender(<Column {...(props as never)} columnFlags={DRAFTING_IS_INTAKE as never} />);

    dropOnto(container);

    /* Without `columnFlags` in the deps the DOM keeps the pre-load closure, `shouldPrompt` is false,
       and the card moves with its progress reset and no question asked. */
    await waitFor(() => { expect(confirmMock).toHaveBeenCalledTimes(1); });
  });

  /*
  The paired negative: the fix must not turn every lane into a prompting one. A drop onto a lane that
  is NOT pre-implementation must still move silently, or the prompt becomes noise and gets clicked
  through — which costs the same progress it was added to protect.
  */
  it("does not prompt for a lane that is not pre-implementation", async () => {
    confirmMock.mockReset();
    confirmMock.mockResolvedValue(true);

    const { container, rerender } = render(<Column {...(props as never)} />);
    rerender(<Column {...(props as never)} columnFlags={{ countsTowardWip: true } as never} />);

    dropOnto(container);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(confirmMock).not.toHaveBeenCalled();
  });
});
