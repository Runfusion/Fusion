/*
FNXC:WorkflowAgentRouting 2026-08-07-23:50:
GROUND TRUTH for the single-active-continuation slot, against a REAL PostgreSQL
partial unique index.

`idx_workflow_work_items_one_active_task_continuation` is
  UNIQUE (project_id, task_id) WHERE kind = 'task' AND state IN ('runnable','running','held','retrying')
while `upsertWorkflowWorkItem`'s ON CONFLICT target is the DIFFERENT constraint
(project_id, run_id, task_id, node_id, kind). A row the graph has already left therefore does
not upsert — it RAISES. In production that raise deadlocked every task: the executor's routing
failed closed, the run re-suspended on every dispatch, and only an operator moving the card back
to the hold column cleared it.

Every test here uses the real store and the real index, because a mock cannot have this bug: the
earlier regression suite exercised the repair's helper against a hand-rolled fake store and so
proved only that the helper branched as written. These pin the two facts the repair actually
rests on — that the bare upsert really does raise, and that
`replaceActiveTaskWorkflowContinuation` really does retire the predecessor and install the
successor atomically — and they pin the invariant across every shape that reaches it, not just
the one reported reproduction:
  - a DIFFERENT node (the resumed continuation: `parse` -> `step-execute`)
  - the SAME node id with a different runId (two materialized foreach instances,
    `steps#0:step-execute` -> `steps#1:step-execute`) — the shape the first repair missed
  - a `held` predecessor, not just a `running` one
  - re-entering the same node twice (idempotent; must not retire itself)
*/

import { expect, it, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { ACTIVE_WORKFLOW_WORK_ITEM_STATES } from "../../types.js";
import type { WorkflowWorkItemState } from "../../types.js";

pgDescribe("single active task continuation slot", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_continuation_slot",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  const fence = (taskId: string, runId: string, nodeId: string, extra: Record<string, unknown> = {}) => ({
    runId,
    taskId,
    nodeId,
    kind: "task" as const,
    state: "running" as WorkflowWorkItemState,
    leaseOwner: `executor:${taskId}`,
    leaseExpiresAt: null,
    nodeInstanceId: nodeId,
    ...extra,
  });

  const activeRows = async (taskId: string) => {
    const items = await h.store().listWorkflowWorkItemsForTask(taskId, { kinds: ["task"] });
    return items.filter((i) => ACTIVE_WORKFLOW_WORK_ITEM_STATES.includes(i.state));
  };

  /*
  The premise of the whole repair. If this ever stops raising — the ON CONFLICT target is
  widened, or the partial index is dropped — the repair is solving a problem that no longer
  exists and this test says so loudly instead of silently passing.
  */
  it("a bare upsert RAISES when the task already holds an active continuation elsewhere", async () => {
    const store = h.store();
    const task = await h.createTestTask();
    await store.upsertWorkflowWorkItem(fence(task.id, `${task.id}:run:parse`, "parse"));

    const err = await store
      .upsertWorkflowWorkItem(fence(task.id, `${task.id}:run:step-execute`, "step-execute"))
      .then(() => null, (e: unknown) => e as Error);

    expect(err, "a second active continuation must violate the partial unique index").toBeInstanceOf(Error);
    expect((await activeRows(task.id)).map((i) => i.nodeId)).toEqual(["parse"]);
  });

  it("replace retires the resumed continuation and installs the successor atomically", async () => {
    const store = h.store();
    const task = await h.createTestTask();
    await store.upsertWorkflowWorkItem(fence(task.id, `${task.id}:run:parse`, "parse"));

    const item = await store.replaceActiveTaskWorkflowContinuation(
      fence(task.id, `${task.id}:run:step-execute`, "step-execute"),
    );

    const active = await activeRows(task.id);
    expect(active.map((i) => i.nodeId)).toEqual(["step-execute"]);
    expect(active[0]?.id).toBe(item.id);
    // Never a window with zero active rows, and the predecessor is retired truthfully.
    const all = await store.listWorkflowWorkItemsForTask(task.id, { kinds: ["task"] });
    expect(all.find((i) => i.nodeId === "parse")?.state).toBe("succeeded");
  });

  /*
  THE SHAPE THE FIRST REPAIR MISSED. Two materialized foreach instances share the template
  `nodeId` ("step-execute") and differ only by runId/nodeInstanceId, so a node-identity guard
  short-circuits and releases nothing — leaving instance #1 to deadlock exactly like the
  original bug. Instance #0's fence is still active here because the interpreter terminalizes
  fence rows only after it returns.
  */
  it("replace retires a SIBLING FOREACH INSTANCE of the same template node", async () => {
    const store = h.store();
    const task = await h.createTestTask();
    await store.upsertWorkflowWorkItem(
      fence(task.id, `${task.id}:run:steps#0:step-execute`, "step-execute", { nodeInstanceId: "steps#0:step-execute" }),
    );

    await store.replaceActiveTaskWorkflowContinuation(
      fence(task.id, `${task.id}:run:steps#1:step-execute`, "step-execute", { nodeInstanceId: "steps#1:step-execute" }),
    );

    const active = await activeRows(task.id);
    expect(active).toHaveLength(1);
    expect(active[0]?.nodeInstanceId).toBe("steps#1:step-execute");
    const all = await store.listWorkflowWorkItemsForTask(task.id, { kinds: ["task"] });
    expect(all.find((i) => i.nodeInstanceId === "steps#0:step-execute")?.state).toBe("succeeded");
  });

  /*
  A held predecessor is an ACTIVE row too, so it occupies the same slot. The availability-hold
  write must be able to take the slot over from it rather than raising.
  */
  it("replace takes the slot over from a HELD predecessor", async () => {
    const store = h.store();
    const task = await h.createTestTask();
    await store.upsertWorkflowWorkItem(
      fence(task.id, `${task.id}:run:plan-review`, "plan-review", { state: "held", leaseOwner: null }),
    );

    await store.replaceActiveTaskWorkflowContinuation(
      fence(task.id, `${task.id}:run:step-execute`, "step-execute", { state: "held", leaseOwner: null, blockedReason: "workflow-principal-role-pool-exhausted:executor" }),
    );

    const active = await activeRows(task.id);
    expect(active).toHaveLength(1);
    expect(active[0]?.nodeId).toBe("step-execute");
    expect(active[0]?.state).toBe("held");
  });

  /*
  A SECOND ATTEMPT AT THE SAME NODE. The fence run id is derived
  (`<taskId>:<workflowId>:<nodeInstanceId>`), not per-attempt, so every attempt at a node
  instance targets the same row — and a fence is terminalized at the end of every run. Without
  the terminal-key drop, `upsertWorkflowWorkItem`'s (correct) refusal to requeue a terminal row
  turned every retry, rework cycle, and operator re-dispatch into a parked card.
  */
  it.each(["succeeded", "failed", "cancelled"] as const)(
    "replace re-attempts a node whose previous attempt ended %s",
    async (priorState) => {
      const store = h.store();
      const task = await h.createTestTask();
      const runId = `${task.id}:run:steps#0:step-execute`;
      const first = await store.upsertWorkflowWorkItem(fence(task.id, runId, "step-execute"));
      await store.transitionWorkflowWorkItem(first.id, priorState, { leaseOwner: null, leaseExpiresAt: null });

      const retry = await store.replaceActiveTaskWorkflowContinuation(fence(task.id, runId, "step-execute"));

      expect(retry.state).toBe("running");
      const active = await activeRows(task.id);
      expect(active).toHaveLength(1);
      expect(active[0]?.id).toBe(retry.id);
    },
  );

  /* Only the exact target key is dropped — a finished attempt at another node stays on record. */
  it("re-attempting one node leaves another node's terminal row intact", async () => {
    const store = h.store();
    const task = await h.createTestTask();
    const parse = await store.upsertWorkflowWorkItem(fence(task.id, `${task.id}:run:parse`, "parse"));
    await store.transitionWorkflowWorkItem(parse.id, "succeeded", { leaseOwner: null, leaseExpiresAt: null });
    const stepRun = `${task.id}:run:step-execute`;
    const prior = await store.upsertWorkflowWorkItem(fence(task.id, stepRun, "step-execute"));
    await store.transitionWorkflowWorkItem(prior.id, "failed", { leaseOwner: null, leaseExpiresAt: null });

    await store.replaceActiveTaskWorkflowContinuation(fence(task.id, stepRun, "step-execute"));

    const all = await store.listWorkflowWorkItemsForTask(task.id, { kinds: ["task"] });
    expect(all.find((i) => i.id === parse.id)?.state).toBe("succeeded");
    expect(await activeRows(task.id)).toHaveLength(1);
  });

  /* Re-entering the same node must not retire the row it is about to write. */
  it("replace is idempotent for the same (runId, nodeId)", async () => {
    const store = h.store();
    const task = await h.createTestTask();
    const input = fence(task.id, `${task.id}:run:step-execute`, "step-execute");

    const first = await store.replaceActiveTaskWorkflowContinuation(input);
    const second = await store.replaceActiveTaskWorkflowContinuation(input);

    expect(second.id).toBe(first.id);
    const active = await activeRows(task.id);
    expect(active).toHaveLength(1);
    expect(active[0]?.state).toBe("running");
  });

  /*
  FNXC:WorkflowAgentRouting 2026-08-07-23:50 (cross-package drift guard):
  The engine's handover is only correct because `ACTIVE_WORKFLOW_WORK_ITEM_STATES` matches the
  state list written by hand into the index's raw `sql` predicate in another file. Nothing links
  them, so adding a state to one side would silently un-fix the deadlock. Read the schema source
  and assert they agree.
  */
  it("the index predicate lists exactly ACTIVE_WORKFLOW_WORK_ITEM_STATES", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const schemaPath = fileURLToPath(new URL("../../postgres/schema/project.ts", import.meta.url));
    const source = await readFile(schemaPath, "utf8");

    const predicate = /idx_workflow_work_items_one_active_task_continuation[\s\S]*?state\}? IN \(([^)]*)\)/.exec(source);
    expect(predicate, "could not locate the partial unique index predicate").not.toBeNull();

    const declared = [...predicate![1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    expect(declared).toEqual([...ACTIVE_WORKFLOW_WORK_ITEM_STATES].sort());
  });
});
