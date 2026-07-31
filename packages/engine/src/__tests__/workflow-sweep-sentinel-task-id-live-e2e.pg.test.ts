/*
FNXC:WorkflowLifecycleColumns 2026-07-31-13:20 (E2E evidence — a THIRD inert-conversion mechanism):

Two mechanisms are already measured in this series:

  #2789-#2794   the site resolves the workflow SYNCHRONOUSLY, so PostgreSQL hands it the default board
  #2795-#2802   the role answer is an OPTIONAL parameter and the caller does not pass it

This is a third, and it is inert by CONSTRUCTION rather than by environment. `triage.ts`'s startup
sweep resolves its lane vocabulary with a SENTINEL task id:

    const sweepLanes = resolvePlannerLanes(this.store, "");
    const sweepColumns = [...new Set(["triage", "todo", sweepLanes.intake, sweepLanes.hold])];

There is no task `""`, so no selection can be read for it and no board can be resolved from it. The
lanes come back as the default board's, and the union collapses to the legacy pair `{triage, todo}`.
Note what this means for the other two mechanisms' fixes: making `resolvePlannerLanes` async would
NOT repair this site, because the defect is the argument, not the resolver.

WHAT BREAKS. The sweep clears stale `planning` status so a card cannot hold a planning admission slot
forever. Its own comment explains that the union is "load-bearing, not defensive", because the merged
post-U11 default collapses `intake` and `hold` onto `todo` and "nothing ever swept `triage`". That
reasoning fixes the MERGED case and leaves the RENAMED one: a card parked in a renamed hold column
with a stale `planning` status is in none of the four queried columns, is never swept, and occupies a
planning admission slot permanently — the exact failure the comment describes, on every custom board.

A SWEEP-WIDE defect, which is what makes the sentinel distinct from the other two mechanisms. The
others resolve per task and get one card's answer wrong; this one resolves ONCE for the whole board
and cannot be right for any workflow but the default, however many boards the project runs.

OBSERVED STATE. Whether the card's persisted `status` is still `planning` after the real sweep runs
against a real store. The sweep is a private method, so it is invoked through a cast — that is
production code executing, not a stand-in, and nothing about the assertion depends on the cast.

LANE. `.pg.test.ts`, skipped via `pgDescribe` when no PostgreSQL is reachable, so the merge gate is
unaffected. Throwaway per-file database; never port 4040.
*/
import { beforeAll, beforeEach, afterEach, afterAll, expect, it } from "vitest";
import "@fusion/core"; // registers the built-in column traits
import type { TaskStore } from "@fusion/core";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";

import { TriageProcessor } from "../triage.js";
import { resolvePlannerLanes } from "../replan-target.js";
import { DEFAULT_VOCAB, RENAMED_VOCAB, lifecycleIr, type Vocabulary } from "./_workflow-vocabulary-fixture.js";

pgDescribe("startup sweep lane vocabulary, resolved from a sentinel task id", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_sweep_sentinel",
  });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(async () => { await h.beforeEach(); });
  afterEach(async () => { await h.afterEach(); });

  /** A real card parked in its workflow's hold column carrying a STALE `planning` status. */
  async function stalePlanningCard(store: TaskStore, v: Vocabulary, key: string): Promise<string> {
    const created = await store.createWorkflowDefinition({
      name: `Sweep ${key}`,
      kind: "workflow",
      ir: lifecycleIr(v, `custom:${key}`),
    } as never);
    const workflowId = (created as { id: string }).id;

    const task = await store.createTask({ description: `sweep probe ${key}` });
    await store.writeTaskWorkflowSelection(task.id, workflowId, []);
    store.taskCache.delete(task.id);
    await store.moveTask(task.id, v.hold as never, { recoveryRehome: true } as never);
    await store.updateTask(task.id, { status: "planning" });

    store.taskCache.delete(task.id);
    return task.id;
  }

  /** Run the real startup sweep, then read the card back. Private method, invoked through a cast. */
  async function sweepThenRead(store: TaskStore, taskId: string): Promise<string | null | undefined> {
    const processor = new TriageProcessor(store, "/tmp/fn-sweep-sentinel-e2e");
    try {
      await (processor as unknown as { clearStaleSpecifyingStatuses(): Promise<void> })
        .clearStaleSpecifyingStatuses();
    } finally {
      /* Unregisters the admission provider the constructor registered; leaking it across cases would
         let one case's provider observe another's store. */
      processor.stop();
    }
    store.taskCache.delete(taskId);
    return (await store.getTask(taskId))?.status ?? null;
  }

  it("the sentinel resolves the DEFAULT lanes, whatever boards the project has", async () => {
    /*
    The mechanism, isolated. Two custom workflows exist by the time this runs and neither can
    influence the answer, because the argument names no task.
    */
    const store = h.store();
    await stalePlanningCard(store, RENAMED_VOCAB, "wf-sentinel-probe");

    const lanes = resolvePlannerLanes(store, "");

    expect(lanes.hold).toBe("todo");
    expect(lanes.intake).toBe("todo"); // merged on the post-U11 default board
    expect(lanes.hold).not.toBe(RENAMED_VOCAB.hold);
  });

  it("CONTROL — a stale planning card on the DEFAULT board IS swept", async () => {
    /* The legacy pair is right here, which is why the gap went unnoticed. */
    const store = h.store();
    const taskId = await stalePlanningCard(store, DEFAULT_VOCAB, "wf-default-sweep");

    expect(await sweepThenRead(store, taskId)).toBeNull();
  });

  /*
  FNXC:WorkflowLifecycleColumns 2026-07-31-23:59:
  WAS A CHARACTERIZATION, IS NOW A REGRESSION TEST — the defect it pinned is fixed.

  It asserted `"planning"` survives: the card sat in none of the four queried columns, because the
  sentinel `""` task id could resolve no board and the union collapsed to the legacy pair. The header
  above notes that making `resolvePlannerLanes` async would NOT repair this, "because the defect is
  the argument, not the resolver" — which is right, and is why the fix is a PROJECT-level resolver.

  `resolveProjectColumnsForRoles(store, ["intake", "hold"])` asks the question this sweep actually has:
  there is no task to resolve against, and it wants every column playing those roles anywhere in the
  project. The renamed planning column is now queried, so the stale status is cleared.

  The assertion is inverted rather than deleted, so the file keeps its record of what the bug WAS.
  */
  it("clears a stale planning status on a RENAMED board", async () => {
    const store = h.store();
    const taskId = await stalePlanningCard(store, RENAMED_VOCAB, "wf-renamed-sweep");

    expect(await sweepThenRead(store, taskId)).toBeNull();
  });
});
