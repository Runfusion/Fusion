/*
FNXC:WorkflowLifecycleColumns 2026-07-29-15:40:

THE SAME DEFECT AS PR #2470's P1, ONE ROLE OVER.

That review caught `getStalePausedTodoSignal` gaining a `holdColumn` parameter in B1
while BOTH hydration sites in `reads.ts` omitted it — a correct guard comparing against
the literal, so the badge was silent for a paused card in a renamed hold column. It was
fixed for `holdColumn` and its sibling role was left alone: `getStalePausedReviewSignal`
and `getInReviewStalledSignal` both take `reviewColumn`, and all SIX call sites in that
file defaulted it to `"in-review"`.

So on a renamed board (`checking`) both review badges were silent, and the fix for the
first role is what makes that visible — the pattern was already known, written down, and
not applied to the neighbour.

Found by auditing "does the caller pass the resolved role?" across every
role-parameterised signal, which is a defect class the column-literal census cannot see:
the literal is a PARAMETER DEFAULT, and the call site that takes it contains no literal
at all.

Real store, real persisted workflow, assertions through the real `listTasks` /
`getTask` / `searchTasks` hydration paths — the same posture as the sibling
renamed-hold suite, because the defect lives in hydration rather than in the pure
signal.
*/
import { it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

const THRESHOLD_MS = 24 * 60 * 60_000;

pgDescribe("TaskStore review-signal hydration under a renamed review column (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_stale_paused_renamed_review",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  /** A workflow whose review column is `checking` — it has NO `in-review` column. */
  async function seedRenamedWorkflow(): Promise<string> {
    const created = await h.store().createWorkflowDefinition({
      name: "Renamed Review",
      kind: "workflow",
      ir: {
        version: "v2",
        id: "custom:renamed-review",
        /* The `review` lifecycle role is carried by the `merge` trait
           (LIFECYCLE_ROLE_FLAGS: review -> mergeOrchestration), and the IR validator
           refuses a merge-blocker/merge column with no reachable merge-class node —
           so the fixture needs a merge-gate to be a valid renamed review lane at all. */
        nodes: [
          { id: "start", kind: "start", column: "drafting" },
          { id: "gate", kind: "merge-gate", column: "checking", config: { gate: "auto-merge" } },
          { id: "end", kind: "end", column: "shipped" },
        ],
        edges: [{ from: "start", to: "gate" }, { from: "gate", to: "end" }],
        columns: [
          { id: "drafting", label: "Drafting", traits: [{ trait: "hold", config: { release: "capacity" } }] },
          { id: "building", label: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
          { id: "checking", label: "Checking", traits: [{ trait: "human-review" }, { trait: "merge" }] },
          { id: "shipped", label: "Shipped", traits: [{ trait: "complete" }] },
        ],
      },
    } as never);
    return (created as { id: string }).id;
  }

  /** A paused card, aged past the threshold, resting in `column`. */
  async function seedPaused(id: string, column: string, workflowId?: string): Promise<void> {
    const store = h.store();
    const aged = new Date(Date.now() - (THRESHOLD_MS + 60_000)).toISOString();
    await store.createTaskWithReservedId(
      { description: id, column } as never,
      { taskId: id, createdAt: aged, updatedAt: aged, applyDefaultWorkflowSteps: false } as never,
    );
    if (workflowId) await store.writeTaskWorkflowSelection(id, workflowId, []);
    await h.adminSql()`
      UPDATE project.tasks SET paused = 1, column_moved_at = ${aged}, updated_at = ${aged} WHERE id = ${id}
    `;
    store.taskCache.delete(id);
    // Prove the fixture: an unpaused or unaged card produces no signal for reasons
    // unrelated to the column, and the suite would then pass while testing nothing.
    const seeded = await store.getTask(id);
    expect(seeded.paused).toBe(true);
    expect(seeded.column).toBe(column);
  }

  /*
  FNXC:WorkflowLifecycleColumns 2026-07-30-14:20 (PR #2586 review — greptile):
  THE STALLED SIBLING NEEDS ITS OWN FIXTURE, and its absence is why the gap existed.
  `getInReviewStalledSignal` requires `paused !== true` — it is the UNPAUSED
  counterpart of `getStalePausedReviewSignal` — so `seedPaused` cannot exercise it,
  and every assertion in this file targeted the paused half.

  That matters because the production change threads `reviewColumn` into BOTH
  signals across the hydration paths. Half the change had no coverage: a future edit
  could drop the role from the stalled call sites and this suite would stay green.
  */
  async function seedStalled(id: string, column: string, workflowId?: string): Promise<void> {
    const store = h.store();
    const aged = new Date(Date.now() - (THRESHOLD_MS + 60_000)).toISOString();
    await store.createTaskWithReservedId(
      { description: id, column } as never,
      { taskId: id, createdAt: aged, updatedAt: aged, applyDefaultWorkflowSteps: false } as never,
    );
    if (workflowId) await store.writeTaskWorkflowSelection(id, workflowId, []);
    await h.adminSql()`
      UPDATE project.tasks SET paused = 0, column_moved_at = ${aged}, updated_at = ${aged} WHERE id = ${id}
    `;
    store.taskCache.delete(id);
    /* Prove the fixture, same reason as its paused sibling: a PAUSED or unaged card
       yields no stalled signal for reasons unrelated to the column, and the suite
       would pass while testing nothing. */
    const seeded = await store.getTask(id);
    expect(seeded.paused).not.toBe(true);
    expect(seeded.column).toBe(column);
  }

  it("hydrates inReviewStalled for an UNPAUSED card in a RENAMED review column", async () => {
    const wf = await seedRenamedWorkflow();
    await seedStalled("FN-RR-5", "checking", wf);

    const task = (await h.store().listTasks({ slim: true })).find((t) => t.id === "FN-RR-5");

    expect(task?.inReviewStalled).toBeDefined();
  });

  it("does NOT badge an unpaused card resting in a non-review column of that workflow", async () => {
    /* The negative half, mirroring the paused sibling: threading the role must not
       turn the stalled badge into "any aged card anywhere". */
    const wf = await seedRenamedWorkflow();
    await seedStalled("FN-RR-6", "building", wf);

    const task = (await h.store().listTasks({ slim: true })).find((t) => t.id === "FN-RR-6");

    expect(task?.inReviewStalled).toBeUndefined();
  });

  it("hydrates stalePausedReview via listTasks for a paused card in a RENAMED review column", async () => {
    const wf = await seedRenamedWorkflow();
    await seedPaused("FN-RR-1", "checking", wf);

    const task = (await h.store().listTasks({ slim: true })).find((t) => t.id === "FN-RR-1");

    expect(task?.stalePausedReview?.code).toBe("stale-paused-review");
  });

  it("does NOT badge a paused card resting in a non-review column of that workflow", async () => {
    /* The negative half: threading the role must not turn the badge into "any paused
       card anywhere", which is a noisier failure than the silence it replaces. */
    const wf = await seedRenamedWorkflow();
    await seedPaused("FN-RR-2", "building", wf);

    const task = (await h.store().listTasks({ slim: true })).find((t) => t.id === "FN-RR-2");

    expect(task?.stalePausedReview).toBeUndefined();
  });

  it("still badges a builtin `in-review` card with no custom workflow (regression floor)", async () => {
    await seedPaused("FN-RR-3", "in-review");

    const task = (await h.store().listTasks({ slim: true })).find((t) => t.id === "FN-RR-3");

    expect(task?.stalePausedReview?.code).toBe("stale-paused-review");
  });

  it("hydrates the badge through listTasksModifiedSince as well", async () => {
    /* A separate call site with a separate resolution path — the hold-column fix had to
       cover two hydration sites for the same reason, and this role has six. */
    const wf = await seedRenamedWorkflow();
    await seedPaused("FN-RR-4", "checking", wf);

    const modified = await h.store().listTasksModifiedSince(new Date(0).toISOString());
    const task = modified.tasks.find((t) => t.id === "FN-RR-4");

    expect(task?.stalePausedReview?.code).toBe("stale-paused-review");
  });
});
