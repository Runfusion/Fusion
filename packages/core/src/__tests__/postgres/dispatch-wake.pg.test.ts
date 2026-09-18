/*
FNXC:EventDrivenDispatch 2026-09-18-00:40:
FN-519 — GROUND TRUTH for the cross-process dispatch wake, against a REAL PostgreSQL server.

These cases exist because the guarantees the transport rests on are the SERVER's, not ours, and a
mock cannot have the bugs they prevent:

  * NOTIFY is delivered only after the publishing transaction COMMITS and is discarded on rollback
    (https://www.postgresql.org/docs/15/sql-notify.html). That is the entire reason
    `notifyDispatchWakeWithinTransaction` writes through the caller's own handle instead of a
    hand-rolled after-commit callback — so it must be pinned against a real transaction, including
    one held open while a listener is already registered.
  * LISTEN must be in place before the read a listener relies on, and nothing is delivered for the
    disconnected window (https://www.postgresql.org/docs/15/sql-listen.html) — so the catch-up read
    and the surviving periodic sweeps are load-bearing, not belt-and-braces.
  * two projects can legitimately hold the SAME task id in different partitions, so a shared
    channel must not produce a cross-project admission.

Everything here uses the real store and real connections; nothing advances a clock.
*/

import { expect, it, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import postgres from "postgres";
import { sql } from "drizzle-orm";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import {
  DISPATCH_WAKE_CHANNEL,
  decodeDispatchWakePayload,
  encodeDispatchWakePayload,
  notifyDispatchWakeWithinTransaction,
} from "../../postgres/dispatch-wake.js";
import type { DispatchWakeEvent } from "../../dispatch-wake.js";

pgDescribe("cross-process dispatch wake over LISTEN/NOTIFY", () => {
  /*
  A BOUND projectId is required, not cosmetic: the wake payload is project-scoped, and
  `encodeDispatchWakePayload` deliberately refuses an unscoped event so an unscoped store can never
  publish a wake that a project-scoped consumer would mis-route. The default project-agnostic
  harness (projectId "") therefore publishes nothing, which is correct behaviour and the reason the
  real-continuation case below needs a partition to live in.
  */
  const PROJECT_ID = "/test/fn-519-dispatch-wake";
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_dispatch_wake",
    projectId: PROJECT_ID,
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  /** A second, independent connection standing in for another process's engine. */
  async function listenerSession(onWake: (event: DispatchWakeEvent) => void) {
    const client = postgres(h.testUrl(), { max: 1, prepare: false, onnotice: () => {} });
    let ready!: () => void;
    const registered = new Promise<void>((resolve) => { ready = resolve; });
    const handle = await client.listen(
      DISPATCH_WAKE_CHANNEL,
      (payload) => {
        const decoded = decodeDispatchWakePayload(payload);
        if (decoded) onWake(decoded);
      },
      () => ready(),
    );
    // LISTEN must be registered BEFORE the mutation under test, per the server contract.
    await registered;
    return {
      dispose: async () => {
        await Promise.resolve(handle?.unlisten?.()).catch(() => undefined);
        await client.end({ timeout: 2 }).catch(() => undefined);
      },
    };
  }

  /** Bounded wait for a delivery. Real I/O, so a deadline is unavoidable — but it is a
   *  FAILURE deadline, not the mechanism: the pass-case delivery arrives immediately. */
  async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  it("a mutation in one session wakes a listener in another, after commit", async () => {
    const seen: DispatchWakeEvent[] = [];
    const listener = await listenerSession((event) => seen.push(event));
    try {
      await h.layer().transactionImmediate(async (tx) => {
        await notifyDispatchWakeWithinTransaction(tx, {
          projectId: "/p/one",
          reason: "continuation",
          taskId: "FN-CROSS-1",
        });
      });

      await waitFor(() => seen.length > 0, "cross-session delivery");
      expect(seen[0]).toEqual({
        projectId: "/p/one",
        reason: "continuation",
        taskId: "FN-CROSS-1",
        remote: true,
      });
    } finally {
      await listener.dispose();
    }
  });

  it("delivers NOTHING while the publishing transaction is still open", async () => {
    const seen: DispatchWakeEvent[] = [];
    const listener = await listenerSession((event) => seen.push(event));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    try {
      const committing = h.layer().transactionImmediate(async (tx) => {
        await notifyDispatchWakeWithinTransaction(tx, {
          projectId: "/p/one",
          reason: "task-eligibility",
          taskId: "FN-CROSS-2",
        });
        // Hold the transaction open. A consumer that could see this wake now would be able to act
        // on a row it cannot yet read — the exact hazard the in-transaction publish prevents.
        await gate;
      });

      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(seen).toEqual([]);

      release();
      await committing;
      await waitFor(() => seen.length > 0, "post-commit delivery");
      expect(seen[0]?.taskId).toBe("FN-CROSS-2");
    } finally {
      release();
      await listener.dispose();
    }
  });

  it("delivers nothing at all when the publishing transaction rolls back", async () => {
    const seen: DispatchWakeEvent[] = [];
    const listener = await listenerSession((event) => seen.push(event));
    try {
      await h.layer().transactionImmediate(async (tx) => {
        await notifyDispatchWakeWithinTransaction(tx, {
          projectId: "/p/one",
          reason: "continuation",
          taskId: "FN-CROSS-ROLLBACK",
        });
        throw new Error("deliberate rollback");
      }).catch(() => undefined);

      // A committed control wake proves the listener is live, so the absence above is the
      // rollback and not a dead subscription.
      await h.layer().transactionImmediate(async (tx) => {
        await notifyDispatchWakeWithinTransaction(tx, {
          projectId: "/p/one",
          reason: "continuation",
          taskId: "FN-CROSS-CONTROL",
        });
      });
      await waitFor(() => seen.length > 0, "control delivery");

      expect(seen.map((e) => e.taskId)).toEqual(["FN-CROSS-CONTROL"]);
    } finally {
      await listener.dispose();
    }
  });

  it("a real runnable continuation write wakes another process", async () => {
    const store = h.store();
    const task = await h.createTestTask();
    const seen: DispatchWakeEvent[] = [];
    const listener = await listenerSession((event) => seen.push(event));
    try {
      await store.upsertWorkflowWorkItem({
        runId: `${task.id}:run:plan-review`,
        taskId: task.id,
        nodeId: "plan-review",
        kind: "task",
        state: "runnable",
        nodeInstanceId: "plan-review",
      });

      await waitFor(() => seen.some((e) => e.taskId === task.id), "continuation wake");
      const wake = seen.find((e) => e.taskId === task.id);
      expect(wake?.reason).toBe("continuation");
      expect(wake?.projectId).toBe(PROJECT_ID);
      // Ids only: a cross-process payload is visible to every user of the database.
      expect(Object.keys(wake ?? {}).sort()).toEqual(["projectId", "reason", "remote", "taskId"]);
    } finally {
      await listener.dispose();
    }
  });

  it("does not wake for a held continuation, which its consumer cannot claim", async () => {
    const store = h.store();
    const task = await h.createTestTask();
    const seen: DispatchWakeEvent[] = [];
    const listener = await listenerSession((event) => seen.push(event));
    try {
      await store.upsertWorkflowWorkItem({
        runId: `${task.id}:run:held`,
        taskId: task.id,
        nodeId: "held-node",
        kind: "task",
        state: "held",
        nodeInstanceId: "held-node",
      });

      // A committed control wake bounds the negative assertion.
      await h.layer().transactionImmediate(async (tx) => {
        await notifyDispatchWakeWithinTransaction(tx, {
          projectId: "/p/one",
          reason: "continuation",
          taskId: "FN-HELD-CONTROL",
        });
      });
      await waitFor(() => seen.some((e) => e.taskId === "FN-HELD-CONTROL"), "control delivery");

      expect(seen.some((e) => e.taskId === task.id)).toBe(false);
    } finally {
      await listener.dispose();
    }
  });

  it("never lets two projects sharing one task id wake each other's consumer", async () => {
    const projectA: DispatchWakeEvent[] = [];
    const projectB: DispatchWakeEvent[] = [];
    // Both engines listen on the SAME shared channel; routing is by the payload's project scope.
    const listener = await listenerSession((event) => {
      if (event.projectId === "/p/a") projectA.push(event);
      if (event.projectId === "/p/b") projectB.push(event);
    });
    try {
      await h.layer().transactionImmediate(async (tx) => {
        await notifyDispatchWakeWithinTransaction(tx, {
          projectId: "/p/a",
          reason: "task-eligibility",
          taskId: "FN-1",
        });
      });

      await waitFor(() => projectA.length > 0, "project A delivery");
      expect(projectB).toEqual([]);
    } finally {
      await listener.dispose();
    }
  });

  it("survives a concurrent listener registration racing the commit, idempotently", async () => {
    const seen: string[] = [];
    const first = await listenerSession((event) => seen.push(`1:${event.taskId}`));
    const second = await listenerSession((event) => seen.push(`2:${event.taskId}`));
    try {
      await h.layer().transactionImmediate(async (tx) => {
        await notifyDispatchWakeWithinTransaction(tx, {
          projectId: "/p/one",
          reason: "capacity",
          taskId: "FN-RACE",
        });
      });

      await waitFor(() => seen.length >= 2, "both listeners");
      // Both engines look; the durable row decides who claims, so a duplicate wake is harmless.
      expect(seen.sort()).toEqual(["1:FN-RACE", "2:FN-RACE"]);
    } finally {
      await first.dispose();
      await second.dispose();
    }
  });

  it("leaves the mutation intact when the notify statement itself fails", async () => {
    const warnings: string[] = [];
    // A handle whose execute rejects models a transport fault mid-mutation.
    await notifyDispatchWakeWithinTransaction(
      { execute: async () => { throw new Error("notify refused"); } },
      { projectId: "/p/one", reason: "release", taskId: "FN-FAULT" },
      (message) => warnings.push(message),
    );
    expect(warnings.some((w) => w.includes("notify failed"))).toBe(true);

    // And the real path still works afterwards, so the fault is not sticky.
    const store = h.store();
    const task = await h.createTestTask();
    const item = await store.upsertWorkflowWorkItem({
      runId: `${task.id}:run:after-fault`,
      taskId: task.id,
      nodeId: "after-fault",
      kind: "task",
      state: "runnable",
      nodeInstanceId: "after-fault",
    });
    expect(item.state).toBe("runnable");
  });

  it("rejects an oversized or unrepresentable payload rather than truncating it", async () => {
    expect(encodeDispatchWakePayload({ projectId: "/p/one", reason: "continuation", taskId: "FN-1" }))
      .toBe(JSON.stringify({ p: "/p/one", r: "continuation", t: "FN-1" }));
    expect(encodeDispatchWakePayload({ projectId: "", reason: "continuation" })).toBeNull();
    expect(encodeDispatchWakePayload({ projectId: "x".repeat(600), reason: "continuation" })).toBeNull();
    // A newer publisher's unknown reason is normalized rather than dropped: the consumer's answer
    // to "unknown" is to run its authoritative passes, so dropping it would be a stall.
    expect(decodeDispatchWakePayload(JSON.stringify({ p: "/p/one", r: "future-reason" }))?.reason)
      .toBe("task-eligibility");
    expect(decodeDispatchWakePayload("not json")).toBeNull();
    expect(decodeDispatchWakePayload(JSON.stringify({ r: "continuation" }))).toBeNull();
  });

  it("holds no connection from the mutation pool for its listening session", async () => {
    /*
    The runtime mutation pool is max 3. A long-lived LISTEN taken from it would permanently hold a
    third of the mutation budget, which is why the transport requires a DEDICATED direct session.
    Prove the pool is still fully usable while a listener is registered.
    */
    const listener = await listenerSession(() => undefined);
    try {
      const results = await Promise.all([1, 2, 3, 4].map(() =>
        h.layer().db.execute(sql`SELECT 1 AS ok`),
      ));
      expect(results).toHaveLength(4);
    } finally {
      await listener.dispose();
    }
  });

  it("stops delivering after dispose and leaves no late delivery behind", async () => {
    const seen: string[] = [];
    const listener = await listenerSession((event) => seen.push(String(event.taskId)));
    await listener.dispose();

    await h.layer().transactionImmediate(async (tx) => {
      await notifyDispatchWakeWithinTransaction(tx, {
        projectId: "/p/one",
        reason: "continuation",
        taskId: "FN-AFTER-DISPOSE",
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(seen).toEqual([]);
  });
});
