/*
FNXC:WorkflowLifecycleColumns 2026-07-29-12:10 (U11 conversion — auto-claim):

`isRunnableAutoClaimCandidate` is the single source of truth for "may an idle
agent claim this card?", and it decided two things by literal column id:

  the CANDIDATE GATE     `task.column === "todo"` — the hold column.
  DEPENDENCY SATISFACTION `dep.column === "done" || "archived"` — the terminal set.

The two fail in OPPOSITE directions, which is why both are covered here:

  a renamed HOLD column makes every card fail the gate, so auto-claim silently
  surfaces nothing and idle agents sit with an empty candidate list — a stall with
  no error anywhere;

  a renamed TERMINAL column makes finished dependencies read as UNMET, so a card
  whose blockers are all done is never offered — the same stall, arrived at from
  the other side.

FN-6873 pinned the literal gate after an archived card leaked into a heartbeat
prompt from a stale cache. That intent is preserved exactly: the gate still admits
ONLY the hold column, and archived/done/intake/wip/review rows are still excluded.
This changes which id means "hold", not which roles may be claimed.

Written against the literal implementation and observed FAILING first.
*/
import { describe, expect, it } from "vitest";
import type { Task } from "@fusion/core";

import { isRunnableAutoClaimCandidate } from "../auto-claim-snapshot.js";

function task(over: Partial<Task> = {}): Task {
  return {
    id: "FN-1",
    title: "t",
    column: "drafting",
    paused: false,
    assignedAgentId: undefined,
    checkedOutBy: undefined,
    deletedAt: undefined,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    columnMovedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  } as unknown as Task;
}

const RENAMED = { hold: "drafting", terminal: ["shipped", "retired"] };

describe("auto-claim candidacy under a renamed column vocabulary", () => {
  describe("the candidate gate (renamed hold)", () => {
    it("admits a card resting in the RENAMED hold column", () => {
      const t = task();
      expect(isRunnableAutoClaimCandidate(t, new Map([[t.id, t]]), RENAMED)).toBe(true);
    });

    it("still EXCLUDES every non-hold column, preserving the FN-6873 intent", () => {
      /*
      The gate exists because an archived card leaked into a heartbeat prompt.
      Converting must change which id means "hold", never which roles may be
      claimed — so each of these stays excluded.
      */
      for (const column of ["inbox", "building", "reviewing", "shipped", "retired"]) {
        const t = task({ column });
        expect(isRunnableAutoClaimCandidate(t, new Map([[t.id, t]]), RENAMED)).toBe(false);
      }
    });

    it("defaults to the legacy todo gate when no roles are supplied", () => {
      const legacy = task({ column: "todo" });
      expect(isRunnableAutoClaimCandidate(legacy, new Map([[legacy.id, legacy]]))).toBe(true);
      const renamed = task({ column: "drafting" });
      expect(isRunnableAutoClaimCandidate(renamed, new Map([[renamed.id, renamed]]))).toBe(false);
    });
  });

  describe("dependency satisfaction (renamed terminal)", () => {
    it("treats a dependency in a RENAMED terminal column as satisfied", () => {
      const dep = task({ id: "FN-DEP", column: "shipped" });
      const t = task({ dependencies: ["FN-DEP"] });
      const byId = new Map([[t.id, t], [dep.id, dep]]);
      expect(isRunnableAutoClaimCandidate(t, byId, RENAMED)).toBe(true);
    });

    it("honors the SECOND declared terminal column, not just the first", () => {
      /* Terminal is a set. A fix handling only the primary complete column would
         pass the case above and fail here. */
      const dep = task({ id: "FN-DEP", column: "retired" });
      const t = task({ dependencies: ["FN-DEP"] });
      expect(isRunnableAutoClaimCandidate(t, new Map([[t.id, t], [dep.id, dep]]), RENAMED)).toBe(true);
    });

    it("still blocks on a dependency that has NOT reached a terminal column", () => {
      /* The negative half: without it, "always satisfied" would pass both cases
         above and prove nothing. */
      const dep = task({ id: "FN-DEP", column: "building" });
      const t = task({ dependencies: ["FN-DEP"] });
      expect(isRunnableAutoClaimCandidate(t, new Map([[t.id, t], [dep.id, dep]]), RENAMED)).toBe(false);
    });
  });

  describe("non-column guards are untouched", () => {
    it.each([
      ["paused", { paused: true }],
      ["assigned", { assignedAgentId: "a1" }],
      ["checked out", { checkedOutBy: "a1" }],
      ["soft-deleted", { deletedAt: "2026-01-01T00:00:00.000Z" }],
    ])("still excludes a %s card in the renamed hold column", (_label, over) => {
      const t = task(over as Partial<Task>);
      expect(isRunnableAutoClaimCandidate(t, new Map([[t.id, t]]), RENAMED)).toBe(false);
    });
  });
});
