/*
FNXC:WorkflowResolvedColumns 2026-07-30-23:50:
THE NEAR-DUPLICATE CHIP KEPT POINTING AT WORK THAT HAD ALREADY LANDED.

`resolveNearDuplicateCanonicalInactive` decides whether a card's "duplicate of X" chip is hidden
because the canonical is finished. It calls `getTaskColumnFlags`, whose identity changes when the
board's workflow traits arrive — but its own dependency list was `[allTasks]` alone, so it kept the
closure created during the PRE-LOAD render, over an empty trait map.

With no traits the role helpers fall back to the legacy ids, so a canonical sitting in a renamed
complete lane reads as still ACTIVE and the chip stays up, advertising a duplicate of work that has
shipped.

SEVERITY, STATED HONESTLY: the stale closure is rebuilt whenever `allTasks` changes identity, which
any task-list refresh does — so this is a bounded window rather than a permanent wrong answer, unlike
the TaskCard ticker defect (#2996) where the dependency that would have refreshed it never changes.
On a quiet board the window is the gap until the next update.

THE OBSERVABLE IS THE PROP COLUMN COMPUTES, not the chip markup: `Column` is the producer here, and
asserting on TaskCard's rendering would test the consumer of a value this component gets wrong.

Found by the same sweep as #2996 — memoized hooks reading a lane value absent from their deps. That
sweep's 13 hits were triaged by hand; this is the second of two live defects, and the comment already
at this call site reasons carefully about declaration ORDER while saying nothing about staleness,
which is how it read as considered.
*/

import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import type { Task, Column as ColumnType } from "@fusion/core";
import { Column } from "../Column";

/* Capture the computed prop rather than the chip: this is the value Column is responsible for. */
const seen: (boolean | undefined)[] = [];
vi.mock("../TaskCard", () => ({
  TaskCard: ({ nearDuplicateCanonicalInactive }: { nearDuplicateCanonicalInactive?: boolean }) => {
    seen.push(nearDuplicateCanonicalInactive);
    return <article />;
  },
}));
vi.mock("../WorktreeGroup", () => ({ WorktreeGroup: () => <div /> }));
vi.mock("../QuickEntryBox", () => ({ QuickEntryBox: () => <div /> }));

const BASE = { description: "t", createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z", steps: [] };

const duplicate = {
  id: "KB-DUP", title: "the duplicate", column: "drafting",
  sourceMetadata: { nearDuplicateOf: "KB-CANON" }, ...BASE,
} as unknown as Task;

/* The canonical has LANDED, in a lane called `shipped` rather than `done`. */
const canonical = { id: "KB-CANON", title: "the canonical", column: "shipped", ...BASE } as unknown as Task;

/* One stable array identity across both renders: if this changed, the callback would be rebuilt for
   an unrelated reason and the test would pass without the fix. */
const allTasks = [duplicate, canonical];

const props = {
  column: "drafting" as ColumnType,
  maxConcurrent: 2,
  showWorktreeGrouping: false,
  onMoveTask: vi.fn().mockResolvedValue({} as Task),
  onOpenDetail: vi.fn(),
  addToast: vi.fn(),
  tasks: [duplicate],
  allTasks,
};

/** The traits the board resolves once its workflow fetch lands. */
const arrivedTraits = new Map([
  ["KB-CANON", [{ id: "shipped", label: "Shipped", flags: { complete: true } }]],
  ["KB-DUP", [{ id: "drafting", label: "Drafting", flags: { hold: true, intake: true } }]],
]);

describe("the near-duplicate canonical check when column traits arrive after first paint", () => {
  it("re-resolves the canonical once traits arrive, without a task-list change", () => {
    seen.length = 0;
    const { rerender } = render(<Column {...(props as never)} />);

    /* Pre-load: no traits, so the legacy fallback cannot see `shipped` as terminal. Correct for
       what it knows — the canonical genuinely has not been proven inactive yet. */
    expect(seen[seen.length - 1]).not.toBe(true);

    rerender(<Column {...(props as never)} taskContextMenuColumnsByTaskId={arrivedTraits as never} />);

    /* The traits now prove the canonical landed, so the chip must be suppressed. */
    expect(seen[seen.length - 1]).toBe(true);
  });

  /*
  The paired negative: re-resolving must not degrade into "every canonical is inactive". A canonical
  still in a live lane must keep the chip up, or the fix silently hides real duplicate warnings —
  which is worse than showing a stale one, because nothing then points at the collision at all.
  */
  it("a canonical still in a live lane keeps the chip", () => {
    seen.length = 0;
    const liveTraits = new Map([
      ["KB-CANON", [{ id: "building", label: "Building", flags: { countsTowardWip: true } }]],
      ["KB-DUP", [{ id: "drafting", label: "Drafting", flags: { hold: true, intake: true } }]],
    ]);
    const liveCanonical = { ...canonical, column: "building" } as Task;
    const liveAll = [duplicate, liveCanonical];

    render(
      <Column
        {...(props as never)}
        allTasks={liveAll as never}
        taskContextMenuColumnsByTaskId={liveTraits as never}
      />,
    );

    expect(seen[seen.length - 1]).not.toBe(true);
  });
});
