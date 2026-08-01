/*
FNXC:WorkflowResolvedColumns 2026-07-31-23:15:
TWO CREATE-TIME DUPLICATE GUARDS, on a RENAMED board.

Both decide "is this candidate still LIVE?" by excluding finished lanes, and both were converted to
`resolveProjectColumnsForRoles`:

  findRecentTasksByContentFingerprint  — excludes ARCHIVED (unless includeArchived)
  findRecentTasksBySourceParentTaskId  — excludes COMPLETE and ARCHIVED

Blinding either back to its literals left the whole 16-file lane-detector set green: no test in
`packages/core` reaches either method.

WHAT BREAKS WITHOUT THEM. They fail in OPPOSITE directions, which is why both are here.

  Fingerprint guard — a renamed board leaves archived cards in the candidate set, so filing a new
  task is REFUSED as a duplicate of one the operator already archived. The operator cannot create
  the card and the thing blocking them is invisible.

  Sibling guard — a renamed board leaves finished siblings in the "recent live siblings" set, so a
  completed sibling keeps counting as active work.

Each is a silent wrong answer on a create path, and neither surfaces an error.

DIFFERENTIAL. The same seeded rows are queried under two vocabularies whose traits are identical and
only the ids differ; `shipped`/`vaulted` collide with no legacy id. The default-vocabulary cases are
controls — they pass with or without the conversion.

WINDOWED. Both queries cut off at `Date.now() - windowMs` with `windowMs` capped at 24h, so fixtures
are seeded at the current time rather than at a fixed past instant; a frozen timestamp falls outside
the window and every case passes vacuously with an empty result.
*/

import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "../../builtin-coding-workflow-ir.js";

pgDescribe("create-time duplicate guards under a renamed board vocabulary", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_dup_sibling_lanes",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  async function seedRenamedWorkflow(): Promise<void> {
    const RENAME: Record<string, string> = {
      todo: "drafting",
      "in-progress": "building",
      "in-review": "checking",
      done: "shipped",
      archived: "vaulted",
    };
    const rename = (id: string | undefined) => (id && RENAME[id]) ?? id;
    const ir = JSON.parse(JSON.stringify(BUILTIN_CODING_WORKFLOW_IR)) as {
      id: string;
      nodes?: { column?: string }[];
      columns?: { id: string }[];
    };
    ir.id = "custom:renamed-dup-guards";
    for (const node of ir.nodes ?? []) node.column = rename(node.column);
    for (const column of ir.columns ?? []) column.id = rename(column.id) as string;

    const ids = (ir.columns ?? []).map((column) => column.id);
    expect(ids).toContain("vaulted");
    expect(ids).not.toContain("archived");

    await h.store().createWorkflowDefinition({ name: "Renamed", kind: "workflow", ir } as never);
  }

  /** A row carrying `contentFingerprint`, parked in `lane`, created inside the 24h window. */
  async function seedFingerprintRow(id: string, lane: string): Promise<void> {
    const store = h.store();
    const now = new Date().toISOString();
    await store.createTaskWithReservedId(
      { description: id, column: "todo" },
      { taskId: id, createdAt: now, updatedAt: now, applyDefaultWorkflowSteps: false },
    );
    await h.adminDb().execute(sql`
      UPDATE project.tasks
         SET "column" = ${lane}, source_metadata = ${JSON.stringify({ contentFingerprint: "FP-1" })}::jsonb
       WHERE id = ${id}`);
    store.taskCache.delete(id);
  }

  /** A row parented to KB-PARENT, parked in `lane`, created inside the 24h window. */
  async function seedSiblingRow(id: string, lane: string): Promise<void> {
    const store = h.store();
    const now = new Date().toISOString();
    await store.createTaskWithReservedId(
      { description: id, column: "todo" },
      { taskId: id, createdAt: now, updatedAt: now, applyDefaultWorkflowSteps: false },
    );
    await h.adminDb().execute(sql`
      UPDATE project.tasks
         SET "column" = ${lane}, source_parent_task_id = 'KB-PARENT'
       WHERE id = ${id}`);
    store.taskCache.delete(id);
  }

  // ── Guard 1: content-fingerprint duplicate ────────────────────────────────

  it("default vocabulary: an ARCHIVED fingerprint match is not a duplicate candidate", async () => {
    await seedFingerprintRow("KB-FP", "archived");

    expect(await h.store().findRecentTasksByContentFingerprint("FP-1")).toEqual([]);
  });

  it("renamed vocabulary: a fingerprint match in the RENAMED archived lane is not a candidate", async () => {
    await seedRenamedWorkflow();
    await seedFingerprintRow("KB-FP", "vaulted");

    expect(await h.store().findRecentTasksByContentFingerprint("FP-1")).toEqual([]);
  });

  it("renamed vocabulary: a LIVE fingerprint match is still a duplicate candidate", async () => {
    /* The paired positive: excluding archived must not degrade into excluding everything, or the
       duplicate guard stops guarding. */
    await seedRenamedWorkflow();
    await seedFingerprintRow("KB-FP", "building");

    const found = await h.store().findRecentTasksByContentFingerprint("FP-1");
    expect(found.map((task) => task.id)).toEqual(["KB-FP"]);
  });

  it("renamed vocabulary: includeArchived opts the RENAMED archived lane back in", async () => {
    await seedRenamedWorkflow();
    await seedFingerprintRow("KB-FP", "vaulted");

    const found = await h.store().findRecentTasksByContentFingerprint("FP-1", { includeArchived: true });
    expect(found.map((task) => task.id)).toEqual(["KB-FP"]);
  });

  // ── Guard 2: recent live siblings ─────────────────────────────────────────

  it("default vocabulary: a FINISHED sibling is not a recent live sibling", async () => {
    await seedSiblingRow("KB-SIB", "done");

    expect(await h.store().findRecentTasksBySourceParentTaskId("KB-PARENT")).toEqual([]);
  });

  it("renamed vocabulary: a sibling in the RENAMED complete lane is not live", async () => {
    await seedRenamedWorkflow();
    await seedSiblingRow("KB-SIB", "shipped");

    expect(await h.store().findRecentTasksBySourceParentTaskId("KB-PARENT")).toEqual([]);
  });

  it("renamed vocabulary: a sibling in the RENAMED archived lane is not live", async () => {
    await seedRenamedWorkflow();
    await seedSiblingRow("KB-SIB", "vaulted");

    expect(await h.store().findRecentTasksBySourceParentTaskId("KB-PARENT")).toEqual([]);
  });

  it("renamed vocabulary: a WORKING sibling IS live", async () => {
    await seedRenamedWorkflow();
    await seedSiblingRow("KB-SIB", "building");

    const found = await h.store().findRecentTasksBySourceParentTaskId("KB-PARENT");
    expect(found.map((task) => task.id)).toEqual(["KB-SIB"]);
  });
});
