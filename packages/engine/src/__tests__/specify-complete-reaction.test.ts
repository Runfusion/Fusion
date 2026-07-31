/*
FNXC:PlanningHandoffOutcome 2026-07-28-10:05 (U7 / R4, R5, R12 — workflow-owned lifecycle):

THE INVARIANT: the engine arms a pre-release Plan Review run only for a card that
was actually handed off to the graph.

Before this, the reaction fired on every finished specification, because the seam
that announces it fired unconditionally. A card parked at the manual plan-approval
gate — finalize writes `status: "awaiting-approval"` and RETURNS EARLY, before the
release move — was logged as `Specified X → todo` and had a Plan Review run armed
for a plan the operator had not approved.

PR #2491 stopped the SEEDER from acting on that, defensively, at the seeder. This
removes the reason it was ever asked. Both layers are deliberate and neither is
redundant: the seeder guard covers every caller including self-healing's re-seed,
while this one stops the engine from doing work nobody asked for and from telling
the operator something false about their own board.

WHY `released` IS THE ONLY LICENCE. It is the only outcome meaning the card crossed
into the hold column (or was already resting there, plan-in-place) and is the
graph's now. `parked` belongs to a human; `withheld` belongs to the caller's retry
budget. Arming a run for either is acting on a handoff that did not happen.

WHY THIS FILE EXISTS AT ALL. The reaction was an inline callback constructed inside
`InProcessRuntime`, whose construction attaches to the real central project
registry — so no test could tell "the reaction respects the outcome" from "the
reaction ignores it". Same extraction, same reason, as the continuation drain in
PR #2491. A guard that cannot be shown to fail is not a guard.
*/
import { describe, expect, it, vi } from "vitest";
import type { Task, WorkflowIr } from "@fusion/core";

import { reactToSpecificationComplete } from "../runtimes/in-process-runtime.js";
import type { PlanningHandoffOutcome } from "../triage.js";

const IR = { version: "v2", name: "wf", columns: [], nodes: [], edges: [] } as unknown as WorkflowIr;

// `null` means the row vanished. NOT `undefined`: that would trigger the default
// parameter and silently hand the reaction a live task, turning the
// vanished-task case into a duplicate of the control.
function harness(task: Task | null = { id: "FN-1", column: "todo" } as Task) {
  const seeded: string[] = [];
  const kicks: string[] = [];
  const logs: string[] = [];
  return {
    seeded,
    kicks,
    logs,
    run: (outcome: PlanningHandoffOutcome) => reactToSpecificationComplete({
      taskId: "FN-1",
      outcome,
      getTask: async () => task ?? undefined,
      resolveIr: async () => IR,
      seed: async (t) => { seeded.push(t.id); return { seeded: true }; },
      kick: () => { kicks.push("kick"); },
      log: (m) => { logs.push(m); },
    }),
  };
}

describe("specification-complete reaction arms a plan review only on a real handoff", () => {
  it("arms the run when the card was RELEASED (the control)", async () => {
    const h = harness();

    await h.run("released");

    expect(h.seeded).toEqual(["FN-1"]);
    expect(h.kicks).toEqual(["kick"]);
    expect(h.logs).toEqual(["Specified FN-1 → todo"]);
  });

  for (const outcome of ["parked", "withheld"] as const) {
    it(`arms NOTHING when finalize reported ${outcome}`, async () => {
      const h = harness();

      await h.run(outcome);

      expect(h.seeded).toEqual([]);
      expect(h.kicks).toEqual([]);
    });

    it(`does not claim the card moved when finalize reported ${outcome}`, async () => {
      // Truthfulness, not cosmetics: an operator reading "Specified → todo" for a
      // card still sitting in the planner column is being told something false
      // about their own board, and that log was the only trace of this path.
      const h = harness();

      await h.run(outcome);

      expect(h.logs).toHaveLength(1);
      expect(h.logs[0]).not.toContain("→ todo");
      expect(h.logs[0]).toContain(outcome);
    });
  }

  it("still respects an operator pause that lands after the release", async () => {
    // Pre-existing guard, kept: the release happened, but the operator parked the
    // card before the reaction ran. Nothing is armed.
    const h = harness({ id: "FN-1", column: "todo", paused: true } as Task);

    await h.run("released");

    expect(h.seeded).toEqual([]);
    expect(h.kicks).toEqual([]);
  });

  it("survives a task that vanished between the release and the reaction", async () => {
    const h = harness(null);

    await expect(h.run("released")).resolves.toBeUndefined();
    expect(h.seeded).toEqual([]);
  });

  it("never resolves the workflow or reads the task for a non-release", async () => {
    // The cheap assertion that catches a future "log it but still do the work"
    // regression: a non-release must not even reach the store.
    const getTask = vi.fn(async () => ({ id: "FN-1", column: "todo" } as Task));
    const resolveIr = vi.fn(async () => IR);

    await reactToSpecificationComplete({
      taskId: "FN-1",
      outcome: "parked",
      getTask,
      resolveIr,
      seed: async () => ({ seeded: true }),
      kick: () => {},
      log: () => {},
    });

    expect(getTask).not.toHaveBeenCalled();
    expect(resolveIr).not.toHaveBeenCalled();
  });
});
