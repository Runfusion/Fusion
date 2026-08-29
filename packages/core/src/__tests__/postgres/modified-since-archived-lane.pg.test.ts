/*
FNXC:WorkflowResolvedColumns 2026-07-31-09:20 (archived rows leaked into the live stream):

`listTasksModifiedSinceImpl` backs the SSE watcher and modified-since polling — the incremental feed
the dashboard applies to its live task list. Its `includeArchived: false` branch excluded the LITERAL
`archived`, so on a board whose archive lane is named anything else the predicate matched every row
and excluded nothing. Archived cards arrived in the live feed and reappeared on the board.

Nothing errors, and a full refetch filters archived rows by another path, so the symptom is archived
work that comes back until the next reload — the kind of thing an operator reports as "the board is
flaky" rather than as a bug.

The cases are DIFFERENTIAL: the same archived task under two vocabularies whose roles are identical
and only the ids differ. `filed` collides with no legacy id, so a surviving `'archived'` literal
cannot pass by luck.
*/

import { it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "../../index.js";

const SINCE = "2026-06-01T00:00:00.000Z";
const TOUCHED = "2026-06-15T12:00:00.000Z";

pgDescribe("the modified-since feed under a renamed archive lane", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_modsince_archived",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  /** The builtin coding workflow with only its archive column renamed. */
  async function seedRenamedWorkflow(): Promise<void> {
    const ir = JSON.parse(JSON.stringify(BUILTIN_CODING_WORKFLOW_IR)) as {
      id: string;
      nodes?: { column?: string }[];
      columns?: { id: string }[];
    };
    ir.id = "custom:renamed-archive";
    for (const node of ir.nodes ?? []) if (node.column === "archived") node.column = "filed";
    for (const column of ir.columns ?? []) if (column.id === "archived") column.id = "filed";

    const ids = (ir.columns ?? []).map((column) => column.id);
    expect(ids).toContain("filed");
    expect(ids).not.toContain("archived");

    await h.store().createWorkflowDefinition({ name: "Renamed archive", kind: "workflow", ir } as never);
  }

  /** A task parked in whichever lane plays the archive role, touched after `SINCE`. */
  async function seedArchivedTask(lane: string, id = "KB-ARCH"): Promise<void> {
    const store = h.store();
    await store.createTaskWithReservedId(
      { description: id, column: "todo" },
      { taskId: id, createdAt: SINCE, updatedAt: SINCE, applyDefaultWorkflowSteps: false },
    );
    /* Seeded directly: `moveTask` would stamp `updatedAt` with `now`, and this feed is keyed on it. */
    await h.adminDb().execute(sql`
      UPDATE project.tasks SET "column" = ${lane}, updated_at = ${TOUCHED} WHERE id = ${id}`);
    store.taskCache.delete(id);
  }

  const feed = async (includeArchived: boolean) => {
    const { tasks } = await h.store().listTasksModifiedSince(SINCE, 50, { includeArchived });
    return tasks.map((task) => task.id);
  };

  /* Control: the legacy vocabulary already excluded it. Passes before and after the fix. */
  it("default vocabulary: an `archived` task stays out of the live feed", async () => {
    await seedArchivedTask("archived");

    expect(await feed(false)).not.toContain("KB-ARCH");
  });

  /* The defect: `!= 'archived'` matched every row on this board, so nothing was excluded. */
  it("renamed vocabulary: a task in the RENAMED archive lane stays out of the live feed", async () => {
    await seedRenamedWorkflow();
    await seedArchivedTask("filed");

    expect(await feed(false)).not.toContain("KB-ARCH");
  });

  /*
  The paired negative: resolving the archive role must not start excluding live work. A card in the
  renamed WIP lane belongs in the feed — otherwise the fix trades leaked archived rows for missing
  live ones, which is the worse direction: the board would silently stop updating for real work.
  */
  it("renamed vocabulary: a task in a LIVE lane still reaches the feed", async () => {
    await seedRenamedWorkflow();
    await seedArchivedTask("in-progress", "KB-LIVE");

    expect(await feed(false)).toContain("KB-LIVE");
  });

  /* `includeArchived: true` is the forensic read and must still surface the renamed archive lane. */
  it("renamed vocabulary: includeArchived still returns the archived task", async () => {
    await seedRenamedWorkflow();
    await seedArchivedTask("filed");

    expect(await feed(true)).toContain("KB-ARCH");
  });
});
