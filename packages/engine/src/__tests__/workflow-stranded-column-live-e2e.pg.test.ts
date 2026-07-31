/*
FNXC:WorkflowLifecycleColumns 2026-07-30-14:30 (E2E evidence — U11 stranded-column work):

WHY THIS FILE EXISTS. My U11 slices closed with unit-level evidence only, and this
program has been burned eight times by a test that passed without exercising its
subject. Three claims in particular were argued from reading the code rather than
from running it, and each is the kind that a mock would happily confirm:

  1. #2515 left `triage` a LEGAL id but removed it from the default lineage, so a
     card sitting there is declared by nothing. (Argued from the IR; never observed
     against a real store.)
  2. #2603 — `createTask` resolves the WORKFLOW'S intake column, and an explicit
     `column` overrides it. The nine write sites were removed on that reasoning.
  3. #2591 — a card stranded on a legacy planner id is admitted by planning
     discovery, which is what lets it heal without a data migration.

This drives a REAL PostgreSQL TaskStore (per-file throwaway database, never the
operator's) and the REAL builtin default workflow — not a fixture IR. Claim 3 is
asserted through the REAL `discoverReadyPlanningTasks`, the same method the poll
calls.

ASSERTION RULE, inherited from `workflow-lifecycle-live-e2e.pg.test.ts`: every claim
is asserted on OBSERVED PERSISTED STATE — a fresh `getTask` after clearing the task
cache — never on "a function was called".

WHAT THIS DOES NOT COVER, stated because the gap is the point of the file: it does
not run a planning SESSION (that lane is the AI, substituted here as `testMode`
does in production), so it proves the card is ADMITTED and re-homable, not that a
full plan-and-release round trip happens. The release half is covered by
`workflow-lifecycle-live-e2e.pg.test.ts`.

LANE. `.pg.test.ts`, skipped via `pgDescribe` when no PostgreSQL is reachable, so
the merge gate is unaffected. Throwaway per-file database; never port 4040; no
temp-root walk.
*/
import { beforeAll, beforeEach, afterEach, afterAll, expect, it } from "vitest";
import "@fusion/core"; // registers the built-in column traits into the shared registry
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";
import { resolveLifecycleColumns, resolveWorkflowIrForTask, workflowHasColumn } from "@fusion/core";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";

import { TriageProcessor } from "../triage.js";

pgDescribe("U11 stranded-column behaviour against a live store and the REAL default workflow", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_u11_stranded",
  });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(async () => { await h.beforeEach(); });
  afterEach(async () => { await h.afterEach(); });

  /** Observed persisted state, never the cached row. */
  async function persistedColumn(store: TaskStore, taskId: string): Promise<string> {
    store.taskCache.delete(taskId);
    return (await store.getTask(taskId)).column as string;
  }

  async function irFor(store: TaskStore, taskId: string): Promise<WorkflowIr> {
    return resolveWorkflowIrForTask(store, taskId);
  }

  it("CLAIM 1: the real default lineage declares no `triage`, and its intake IS the merged column", async () => {
    /*
    The premise every other claim rests on, taken from the SHIPPED workflow rather
    than a fixture that could drift from it.
    */
    const store = h.store();
    const task = await store.createTask({ description: "premise" });
    const ir = await irFor(store, task.id);

    expect(workflowHasColumn(ir, "triage")).toBe(false);
    expect(workflowHasColumn(ir, "todo")).toBe(true);

    const roles = resolveLifecycleColumns(ir);
    expect(roles?.intake).toBe("todo");
    expect(roles?.hold).toBe("todo");
  });

  it("CLAIM 2: a create with no column lands in the workflow's intake, and an explicit column overrides it", async () => {
    /*
    The reasoning #2603 rested on, observed. The override half is the defect: it is
    why nine call sites passing `column: "triage"` were manufacturing stranded cards
    rather than being harmlessly redundant.
    */
    const store = h.store();

    const resolved = await store.createTask({ description: "no explicit column" });
    expect(await persistedColumn(store, resolved.id)).toBe("todo");

    const overridden = await store.createTask({
      description: "explicit legacy column",
      column: "triage" as never,
    });
    expect(await persistedColumn(store, overridden.id)).toBe("triage");
  });

  it("CLAIM 3: planning discovery ADMITS a card stranded on the legacy planner id", async () => {
    /*
    #2591, through the real `discoverReadyPlanningTasks` — the same method the poll
    calls. Before that change this returned nothing for such a card, and nothing
    else owned it.
    */
    const store = h.store();
    const stranded = await store.createTask({
      description: "stranded on the legacy planner id",
      column: "triage" as never,
    });
    expect(await persistedColumn(store, stranded.id)).toBe("triage");

    const fresh = await store.getTask(stranded.id);
    const discovered = await (new TriageProcessor(store, store.getRootDir()) as unknown as {
      discoverReadyPlanningTasks: (t: Task[], now: number) => Promise<Task[]>;
    }).discoverReadyPlanningTasks([fresh as Task], Date.now());

    expect(discovered.map((t) => t.id)).toContain(stranded.id);
  });

  it("CLAIM 3b: a card in the workflow's OWN terminal column is not swept up by the rescue", async () => {
    /*
    The negative half. The rescue is scoped to legacy planner ids a workflow no
    longer declares; a DECLARED column is owned by its workflow and planning must
    keep its hands off. Without this the previous test passes for a rescue that
    admits everything.
    */
    const store = h.store();
    const finished = await store.createTask({ description: "declared terminal" });
    await store.moveTask(finished.id, "in-progress" as never, { moveSource: "user" } as never);
    await store.moveTask(finished.id, "in-review" as never, { moveSource: "user" } as never);
    await store.moveTask(finished.id, "done" as never, { moveSource: "user" } as never);
    expect(await persistedColumn(store, finished.id)).toBe("done");

    const fresh = await store.getTask(finished.id);
    const discovered = await (new TriageProcessor(store, store.getRootDir()) as unknown as {
      discoverReadyPlanningTasks: (t: Task[], now: number) => Promise<Task[]>;
    }).discoverReadyPlanningTasks([fresh as Task], Date.now());

    expect(discovered.map((t) => t.id)).not.toContain(finished.id);
  });

  it("CLAIM 4: the stranded card can still be MOVED back into the lifecycle", async () => {
    /*
    Re-homing is what makes the rescue terminate: once planning finishes, the
    release lands the card in the workflow's hold column and the stranded state is
    gone. Asserted on persisted state through the real move path.
    */
    const store = h.store();
    const stranded = await store.createTask({
      description: "re-homable",
      column: "triage" as never,
    });

    await store.moveTask(stranded.id, "todo" as never, {
      moveSource: "engine",
      recoveryRehome: true,
    } as never);

    expect(await persistedColumn(store, stranded.id)).toBe("todo");

    const ir = await irFor(store, stranded.id);
    expect(workflowHasColumn(ir, await persistedColumn(store, stranded.id))).toBe(true);
  });
});
