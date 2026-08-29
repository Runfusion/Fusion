import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import type { AsyncDataLayer } from "../../postgres/data-layer.js";
import * as schema from "../../postgres/schema/index.js";
import type { ArchivedTaskEntry } from "../../types.js";
import { insertTaskRow } from "../../task-store/async/async-persistence.js";
import { getLiveTaskColumn } from "../../task-store/async/async-comments-attachments.js";
import {
  archiveParentTaskWithLineageGate,
  deleteArchivedTaskEntry,
  filterArchivedTaskEntries,
  findArchivedTaskEntry,
  listArchivedTaskEntries,
  restoreTaskFromArchive,
} from "../../task-store/async/async-archive-lineage.js";

pgDescribe("archive project isolation", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_archive_isolation",
  });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);

  it("isolates duplicate task ids across archive, delete, and restore transactions", async () => {
    /*
    FNXC:ArchiveProjectIsolation 2026-07-14-16:20:
    A shared PostgreSQL cluster permits the same task ID in separate project partitions. Prove every cold-archive read and mutation plus the live-row archive/restore transaction remains confined to its bound project, even when both projects use the identical ID.
    */
    const bind = (projectId: string): AsyncDataLayer => ({ ...h.layer(), projectId });
    const projectA = bind("archive-project-a");
    const projectB = bind("archive-project-b");
    const id = "FN-SAME";
    const now = "2026-07-14T23:20:00.000Z";
    const task = (description: string) => ({
      id,
      description,
      column: "todo",
      currentStep: 0,
      createdAt: now,
      updatedAt: now,
    });
    const entry = (description: string): ArchivedTaskEntry => ({
      ...task(description),
      lineageId: `${description}-lineage`,
      column: "archived",
      dependencies: [],
      steps: [],
      log: [],
      archivedAt: now,
    } as ArchivedTaskEntry);

    await insertTaskRow(projectA, task("project A"), { lineageId: "lineage-a" });
    await insertTaskRow(projectB, task("project B"), { lineageId: "lineage-b" });
    await expect(archiveParentTaskWithLineageGate(projectA, id, entry("project A"), { now }))
      .resolves.toEqual({ archived: true });
    /*
    FNXC:ArchiveProjectIsolation 2026-07-14-21:48:
    Comment, log, document, and artifact state gates must distinguish duplicate task IDs by project. Project A is archived here while project B remains live, making an unscoped first-row lookup observably wrong.
    */
    await expect(getLiveTaskColumn(h.layer().db, id, projectA.projectId)).resolves.toBe("archived");
    await expect(getLiveTaskColumn(h.layer().db, id, projectB.projectId)).resolves.toBe("todo");
    await expect(archiveParentTaskWithLineageGate(projectB, id, entry("project B"), { now }))
      .resolves.toEqual({ archived: true });

    expect((await findArchivedTaskEntry(h.layer().db, id, projectA.projectId))?.description)
      .toBe("project A");
    expect((await findArchivedTaskEntry(h.layer().db, id, projectB.projectId))?.description)
      .toBe("project B");
    expect((await listArchivedTaskEntries(h.layer().db, projectA.projectId)).map((row) => row.description))
      .toEqual(["project A"]);
    expect(await filterArchivedTaskEntries(h.layer().db, [id], projectB.projectId))
      .toEqual(new Set([id]));

    await deleteArchivedTaskEntry(h.layer().db, id, projectA.projectId);
    expect(await findArchivedTaskEntry(h.layer().db, id, projectA.projectId)).toBeUndefined();
    expect((await findArchivedTaskEntry(h.layer().db, id, projectB.projectId))?.description)
      .toBe("project B");

    await restoreTaskFromArchive(projectB, entry("project B"), { now: "2026-07-14T23:21:00.000Z" });
    const rows = await h.adminDb()
      .select({ projectId: schema.project.tasks.projectId, deletedAt: schema.project.tasks.deletedAt })
      .from(schema.project.tasks)
      .where(and(eq(schema.project.tasks.id, id), eq(schema.project.tasks.column, "archived")));
    expect(rows).toEqual(expect.arrayContaining([
      { projectId: "archive-project-a", deletedAt: now },
      { projectId: "archive-project-b", deletedAt: null },
    ]));
    expect(await findArchivedTaskEntry(h.layer().db, id, projectB.projectId)).toBeUndefined();
  });
});
