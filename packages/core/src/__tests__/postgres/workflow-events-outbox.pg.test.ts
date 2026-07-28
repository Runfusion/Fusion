/*
FNXC:WorkflowEvents 2026-07-27-13:10 (U3 / R5 — workflow-owned lifecycle):
The TRANSACTIONAL OUTBOX half of the post-commit event seam, proven against a
REAL PostgreSQL `workflow_work_items` table.

Why real PG and not a fake: both properties under test are properties of the
STORE, not of any code this repo would mock. A hand-written fake of the lease
predicate would only prove the fake redelivers, which is exactly the
green-suite-proves-nothing failure the plan warns about.

The two claims:

  1. CRASH SURVIVAL. Durable follow-on work must be written INSIDE the transition
     transaction, not by a post-commit subscriber. The alternative — "emit after
     commit, let a subscriber enqueue the work" — has a window where a process
     dies between the commit and the subscriber, leaving no event AND no
     work-item row: the work is skipped permanently with nothing to recover
     from. Simulated here by committing the transaction and then never running
     any post-commit code at all, which is strictly worse than a real crash.

  2. AT-LEAST-ONCE DELIVERY. `listDueWorkflowWorkItems` returns items whose lease
     has EXPIRED (`leaseExpiresAt IS NULL OR <= now`), so a worker that performs
     a side effect and dies before recording completion will have its item
     re-claimed and re-run. Calling this substrate "at-most-once" would invite
     subscribers to skip the deduplication the delivery semantics actually
     require — so the redelivery is asserted, and an idempotent handler is shown
     producing ONE effect across TWO deliveries.

Skipped when PostgreSQL is unreachable (FUSION_PG_TEST_SKIP=1) so the merge gate
stays green without a running server — the same posture as the sibling PG suites.
*/

import { describe, it, expect, afterEach } from "vitest";
import postgres from "postgres";
import { execSync } from "node:child_process";
import { createAsyncDataLayer, type AsyncDataLayer } from "../../postgres/data-layer.js";
import { createConnectionSetFromUrl } from "../../postgres/connection.js";
import type { ResolvedBackend } from "../../postgres/backend-resolver.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
import { insertTaskRow, readTaskRow } from "../../task-store/async-persistence.js";
import * as schema from "../../postgres/schema/index.js";
import { and, eq } from "drizzle-orm";
import type { DbTransaction } from "../../postgres/data-layer.js";
import {
  upsertWorkflowWorkItem,
  listDueWorkflowWorkItems,
  transitionWorkflowWorkItem,
  getWorkflowWorkItem,
} from "../../task-store/async-workflow-workitems.js";
import { createWorkflowEventBus } from "../../workflow-events.js";
import type { WorkflowLifecycleEvent } from "../../types/workflow-events.js";

const PG_TEST_URL_BASE = process.env.FUSION_PG_TEST_URL_BASE ?? "postgresql://localhost:5432";
const PG_AVAILABLE = process.env.FUSION_PG_TEST_SKIP !== "1" && Boolean(PG_TEST_URL_BASE);
const pgDescribe = PG_AVAILABLE ? describe : describe.skip;

const TEST_PROJECT_ID = "proj_test_u3_outbox";

function uniqueDbName(): string {
  return `fusion_u3_outbox_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
}

function adminExec(statement: string): void {
  execSync(
    `psql "${PG_TEST_URL_BASE}/postgres" -v ON_ERROR_STOP=1 -c "${statement.replace(/"/g, '\\"')}"`,
    { stdio: "pipe", env: process.env },
  );
}

interface TestCtx {
  dbName: string;
  layer: AsyncDataLayer;
  adminSql: ReturnType<typeof postgres>;
}

async function setupCtx(): Promise<TestCtx> {
  const dbName = uniqueDbName();
  try {
    adminExec(`DROP DATABASE IF EXISTS "${dbName}"`);
  } catch {
    // may not exist
  }
  adminExec(`CREATE DATABASE "${dbName}"`);
  const testUrl = `${PG_TEST_URL_BASE}/${dbName}`;
  const backend: ResolvedBackend = {
    mode: "external",
    runtimeUrl: testUrl,
    migrationUrl: testUrl,
    migrationUrlOverridden: false,
  };
  const schemaConnections = await createConnectionSetFromUrl(backend, { poolMax: 1, connectTimeoutSeconds: 5 });
  await applySchemaBaseline(schemaConnections.migration);
  await schemaConnections.close();

  // Bind the layer to a project, as production does — an unbound harness runs
  // with RLS bypassed and writes rows the bound reader cannot see.
  const connections = await createConnectionSetFromUrl(backend, {
    poolMax: 5,
    connectTimeoutSeconds: 5,
    projectId: TEST_PROJECT_ID,
  });
  const layer = createAsyncDataLayer(connections, { projectId: TEST_PROJECT_ID });
  const adminSql = postgres(testUrl, {
    max: 2,
    prepare: false,
    onnotice: () => {},
    connection: { "fusion.project_id": TEST_PROJECT_ID },
  });
  return { dbName, layer, adminSql };
}

async function teardownCtx(ctx: TestCtx | null): Promise<void> {
  if (!ctx) return;
  try { await ctx.layer.close(); } catch { /* closing best-effort */ }
  try { await ctx.adminSql.end({ timeout: 5 }); } catch { /* closing best-effort */ }
  try { adminExec(`DROP DATABASE IF EXISTS "${ctx.dbName}"`); } catch { /* dropped best-effort */ }
}

async function seedTask(ctx: TestCtx, id: string, column = "in-progress"): Promise<void> {
  await insertTaskRow(
    ctx.layer,
    {
      id,
      title: `outbox ${id}`,
      description: "",
      column,
      priority: "medium",
      steps: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      columnMovedAt: new Date().toISOString(),
    } as unknown as Record<string, unknown>,
    TEST_PROJECT_ID,
  );
}

/** The column half of a transition, written on the SAME transaction handle as
 *  the outbox row — the atomicity this suite exists to demonstrate. */
async function moveColumnInTransaction(tx: DbTransaction, taskId: string, column: string): Promise<void> {
  await tx
    .update(schema.project.tasks)
    .set({ column, columnMovedAt: new Date().toISOString() })
    .where(and(eq(schema.project.tasks.id, taskId), eq(schema.project.tasks.projectId, TEST_PROJECT_ID)));
}

pgDescribe("transactional outbox — durable follow-on work (U3 / R5)", () => {
  let ctx: TestCtx | null = null;
  afterEach(async () => {
    await teardownCtx(ctx);
    ctx = null;
  });

  it("a work item written INSIDE the transition transaction survives a crash before the event is emitted", async () => {
    ctx = await setupCtx();
    await seedTask(ctx, "FN-OUT-1");

    // The transition transaction: the COLUMN CHANGE and the durable follow-on
    // work commit together — the shape `createCompletionHandoffWorkflowWork`
    // already uses at the handoff seam in moves.ts.
    await ctx.layer.transactionImmediate(async (tx) => {
      await moveColumnInTransaction(tx, "FN-OUT-1", "in-review");
      await upsertWorkflowWorkItem(
        ctx!.layer,
        { runId: "run-1", taskId: "FN-OUT-1", nodeId: "merge-gate", kind: "merge", state: "runnable" },
        tx,
      );
    });

    // ...and then the process "dies": no post-commit code runs at all — not the
    // emit, not a subscriber, nothing. This is strictly worse than a real crash
    // between commit and emit.
    //
    // Both halves are durable: the transition landed AND the work that must
    // follow it is queued and claimable by the next process to come up.
    expect((await readTaskRow(ctx.layer, "FN-OUT-1"))?.column).toBe("in-review");
    const due = await listDueWorkflowWorkItems(ctx.layer.db, { kinds: ["merge"] });
    expect(due.map((item) => item.taskId)).toEqual(["FN-OUT-1"]);
    expect(due[0].state).toBe("runnable");
  });

  it("a ROLLED-BACK transition leaves no column change, no orphan work, and emits NOTHING", async () => {
    ctx = await setupCtx();
    await seedTask(ctx, "FN-OUT-2");

    // The emit point sits AFTER the transaction block in moves.ts, so a throw
    // inside the block unwinds past it — this test models that placement.
    const bus = createWorkflowEventBus();
    const reaction = countingSubscriber();
    bus.subscribe(reaction, { name: "notify" });

    await expect(
      ctx.layer.transactionImmediate(async (tx) => {
        await moveColumnInTransaction(tx, "FN-OUT-2", "in-review");
        await upsertWorkflowWorkItem(
          ctx!.layer,
          { runId: "run-2", taskId: "FN-OUT-2", nodeId: "merge-gate", kind: "merge", state: "runnable" },
          tx,
        );
        // A guard rejects after both writes — the whole transition unwinds.
        throw new Error("transition guard rejected");
      }).then(() => {
        // Unreachable: the emit would only run on a committed transition.
        bus.emit({
          type: "TaskTransitioned", taskId: "FN-OUT-2", at: new Date().toISOString(),
          from: "in-progress", to: "in-review",
        } as WorkflowLifecycleEvent);
      }),
    ).rejects.toThrow("transition guard rejected");
    await bus.drain();

    expect((await readTaskRow(ctx.layer, "FN-OUT-2"))?.column).toBe("in-progress");
    expect(await listDueWorkflowWorkItems(ctx.layer.db, { kinds: ["merge"] })).toEqual([]);
    expect(reaction.calls).toBe(0);
  });
});

pgDescribe("transactional outbox — delivery is AT-LEAST-ONCE (U3 / R5)", () => {
  let ctx: TestCtx | null = null;
  afterEach(async () => {
    await teardownCtx(ctx);
    ctx = null;
  });

  it("an item whose lease EXPIRED mid-flight is re-claimable — the store redelivers", async () => {
    ctx = await setupCtx();
    await seedTask(ctx, "FN-OUT-3");

    const created = await upsertWorkflowWorkItem(ctx.layer, {
      runId: "run-3", taskId: "FN-OUT-3", nodeId: "merge-gate", kind: "merge", state: "runnable",
    });

    // Worker A claims it with a lease, then dies without recording completion.
    const future = new Date(Date.now() + 60_000).toISOString();
    await transitionWorkflowWorkItem(ctx.layer, created.id, "running", {
      leaseOwner: "worker-a",
      leaseExpiresAt: future,
    });

    // While the lease is live the item is NOT due — no double-dispatch.
    const whileLeased = await listDueWorkflowWorkItems(ctx.layer.db, { kinds: ["merge"], now: new Date().toISOString() });
    expect(whileLeased).toEqual([]);

    // Once the lease expires the SAME item comes back — the side effect worker A
    // may already have performed is about to happen a second time.
    const afterExpiry = await listDueWorkflowWorkItems(ctx.layer.db, {
      kinds: ["merge"],
      now: new Date(Date.now() + 120_000).toISOString(),
    });
    expect(afterExpiry.map((item) => item.id)).toEqual([created.id]);
  });

  it("an IDEMPOTENT handler run twice over one redelivered item produces exactly one effect", async () => {
    ctx = await setupCtx();
    await seedTask(ctx, "FN-OUT-4");

    const created = await upsertWorkflowWorkItem(ctx.layer, {
      runId: "run-4", taskId: "FN-OUT-4", nodeId: "merge-gate", kind: "merge", state: "runnable",
    });

    /*
    The handler contract every durable subscriber must meet: keyed on a
    payload-identifying invariant, not on "have I been called". Here that key is
    (runId, taskId, nodeId) — the same tuple the work-item table is unique on —
    so a redelivery recognises the effect it already produced.
    */
    const effects = new Set<string>();
    const handle = (item: { runId: string; taskId: string; nodeId: string }): void => {
      effects.add(`${item.runId}:${item.taskId}:${item.nodeId}`);
    };

    handle(created);
    const redelivered = await getWorkflowWorkItem(ctx.layer.db, created.id);
    expect(redelivered).toBeTruthy();
    handle(redelivered!);

    expect(effects.size).toBe(1);
  });
});

pgDescribe("post-commit event vs. outbox — the division of labour (U3 / R5, KTD-3)", () => {
  let ctx: TestCtx | null = null;
  afterEach(async () => {
    await teardownCtx(ctx);
    ctx = null;
  });

  it("dropping every subscriber loses the REACTION but not the durable work", async () => {
    ctx = await setupCtx();
    await seedTask(ctx, "FN-OUT-5");

    const bus = createWorkflowEventBus();
    const reaction = countingSubscriber();
    const off = bus.subscribe(reaction, { name: "notify" });

    await ctx.layer.transactionImmediate(async (tx) => {
      await upsertWorkflowWorkItem(
        ctx!.layer,
        { runId: "run-5", taskId: "FN-OUT-5", nodeId: "merge-gate", kind: "merge", state: "runnable" },
        tx,
      );
    });

    // Every subscriber goes away before the post-commit emit — the crash window.
    off();
    bus.emit({
      type: "TaskTransitioned",
      taskId: "FN-OUT-5",
      at: new Date().toISOString(),
      from: "in-progress",
      to: "in-review",
    } as WorkflowLifecycleEvent);
    await bus.drain();

    expect(reaction.calls).toBe(0);
    // The unit of work is still there and still claimable. A dropped event costs
    // a notification, never a state change or a unit of work.
    const due = await listDueWorkflowWorkItems(ctx.layer.db, { kinds: ["merge"] });
    expect(due.map((item) => item.taskId)).toEqual(["FN-OUT-5"]);
  });
});

/** Minimal call counter — this suite avoids vitest mock objects so the payload
 *  assertions above stay plain-value comparisons. */
function countingSubscriber(): { (event: WorkflowLifecycleEvent): void; calls: number } {
  const fn = ((_event: WorkflowLifecycleEvent) => { fn.calls += 1; }) as {
    (event: WorkflowLifecycleEvent): void;
    calls: number;
  };
  fn.calls = 0;
  return fn;
}
