/*
FNXC:WorkflowLifecycleColumns 2026-07-30-23:40:

THE INVARIANT: "is this card archived?" is answered by the board's archived LANE, not by the id
`archived`.

`async-comments-attachments.ts` holds two classes of `=== "archived"` spelled identically, which is
why they were miscounted once already (#2877 review). The comparisons downstream of
`getLiveTaskColumn` test a value that function MANUFACTURES and must stay literal. The two covered
here read `task.column` straight off a row `select`, so a renamed archived lane is simply not
recognised, and they fail in OPPOSITE directions:

  - `upsertTaskDocument` fails to REJECT — an archived card's documents stay writable, so the
    read-only contract on archived tasks silently does not hold;
  - `publishArchivedTaskDocumentAddition` fails to ACCEPT — a legitimate archived-document
    publication is rejected as `parent-not-archived`, which reads to an operator as a data-integrity
    error rather than a lifecycle mismatch. This is the sharper of the two: valid work refused.

REAL PostgreSQL on purpose. Both guards are row predicates inside a transaction; a mocked store would
assert the arguments and prove nothing about the comparison that actually runs — the same reason
#2875 drove its SQL change through a live database.

REVERT PROOF, measured: restore `task.column === "archived"` in either guard and its case fails —
the upsert resolves instead of rejecting, and the publication throws `parent-not-archived`.
*/

import { it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import * as schema from "../../postgres/schema/index.js";
import { eq, and } from "drizzle-orm";

pgDescribe("archived-document guards resolve the board's archived lane", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_archived_doc_lanes",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  /*
  Put the card in a renamed archived lane and NOTHING ELSE.

  `deletedAt` is deliberately left null. My first version set it, and the revert proof passed with
  the fix removed — the guards are `column-is-archived || deletedAt != null`, so a soft-deleted
  fixture short-circuits the very comparison under test and the assertion holds for an unrelated
  reason. A live row in a workflow-declared archived lane is also the real shape: it is what
  `getLiveTaskColumn` was written to catch and what a renamed board actually produces.
  */
  async function parkInRenamedArchivedLane(taskId: string, opts: { deleted?: boolean } = {}): Promise<void> {
    const store = h.store();
    /* The tasks table partitions on this sentinel when the layer has no project id. */
    const projectId = h.layer().projectId ?? "__legacy_unscoped__";
    await store.createWorkflowDefinition({
      name: "Renamed archive",
      ir: {
        version: "v2",
        name: "Renamed archive",
        columns: [
          { id: "todo", name: "Todo", traits: [{ trait: "intake" }, { trait: "hold" }] },
          { id: "vault", name: "Vault", traits: [{ trait: "archived" }] },
        ],
        nodes: [
          { id: "start", kind: "start", column: "todo" },
          { id: "end", kind: "end", column: "vault" },
        ],
        edges: [{ from: "start", to: "end", condition: "success" }],
      } as never,
    });
    await h.adminDb()
      .update(schema.project.tasks)
      .set(opts.deleted ? { column: "vault", deletedAt: new Date().toISOString() } : { column: "vault" })
      .where(and(eq(schema.project.tasks.projectId, projectId), eq(schema.project.tasks.id, taskId)));
  }

  it("keeps documents read-only for a card in a RENAMED archived lane", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "Archived into a renamed lane" });
    await parkInRenamedArchivedLane(task.id);

    await expect(
      store.upsertTaskDocument(task.id, { key: "plan", content: "should be refused", author: "user" }),
    ).rejects.toThrow(/read-only/);
  });

  it("still rejects on the legacy archived id — the degraded path is unchanged", async () => {
    // Most boards never rename anything; the legacy vocabulary has to keep working.
    const store = h.store();
    const projectId = h.layer().projectId ?? "__legacy_unscoped__";
    const task = await store.createTask({ description: "Archived the built-in way" });
    await h.adminDb()
      .update(schema.project.tasks)
      .set({ column: "archived", deletedAt: new Date().toISOString() })
      .where(and(eq(schema.project.tasks.projectId, projectId), eq(schema.project.tasks.id, task.id)));

    await expect(
      store.upsertTaskDocument(task.id, { key: "plan", content: "should be refused", author: "user" }),
    ).rejects.toThrow(/read-only/);
  });

  it("does NOT treat a live card as archived just because a lane is named vault", async () => {
    // The guard must still let real work through — rejecting everything would be its own bug.
    const store = h.store();
    const task = await store.createTask({ description: "Live card" });

    const doc = await store.upsertTaskDocument(task.id, { key: "plan", content: "allowed", author: "user" });

    expect(doc.key).toBe("plan");
  });
});
