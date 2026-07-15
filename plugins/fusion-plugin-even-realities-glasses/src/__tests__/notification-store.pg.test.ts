import { expect, it } from "vitest";
import type { AsyncDataLayer } from "@fusion/core";
import {
  createTaskStoreForTest,
  pgDescribe,
} from "../../../../packages/core/src/__test-utils__/pg-test-harness.js";
import { pruneMissing, readSnapshot, writeSnapshot } from "../notifications/store.js";

function bind(layer: AsyncDataLayer, projectId: string): AsyncDataLayer {
  return { ...layer, projectId };
}

pgDescribe("Even Realities notification snapshots on PostgreSQL", () => {
  /* FNXC:EvenRealitiesPostgres 2026-07-14-17:45: Runtime snapshot writes, reads, and pruning must use the bound project partition and permit identical task IDs in another project. */
  it("persists and prunes only the bound project's snapshot", async () => {
    const h = await createTaskStoreForTest({ prefix: "fusion_even_realities" });
    try {
      const projectA = bind(h.layer, "even-a");
      const projectB = bind(h.layer, "even-b");
      await expect(writeSnapshot(h.layer, [])).rejects.toThrow("requires asyncLayer.projectId");
      await writeSnapshot(projectA, [
        { taskId: "FN-1", lastColumn: "todo", updatedAt: "2026-07-14T17:00:00.000Z" },
        { taskId: "FN-2", lastColumn: "in-review", updatedAt: "2026-07-14T17:01:00.000Z" },
      ]);
      await writeSnapshot(projectB, [
        { taskId: "FN-1", lastColumn: "done", updatedAt: "2026-07-14T17:02:00.000Z" },
      ]);
      await writeSnapshot(projectA, [
        { taskId: "FN-1", lastColumn: "in-progress", updatedAt: "2026-07-14T17:03:00.000Z" },
        { taskId: "FN-2", lastColumn: "done", updatedAt: "2026-07-14T17:04:00.000Z" },
      ]);
      expect((await readSnapshot(projectA)).get("FN-1")?.lastColumn).toBe("in-progress");
      expect((await readSnapshot(projectA)).get("FN-2")?.lastColumn).toBe("done");
      expect((await readSnapshot(projectB)).get("FN-1")?.lastColumn).toBe("done");
      expect(await pruneMissing(projectA, new Set(["FN-2"]))).toBe(1);
      const remainingA = await readSnapshot(projectA);
      const remainingB = await readSnapshot(projectB);
      expect([...remainingA.keys()]).toEqual(["FN-2"]);
      expect([...remainingB.keys()]).toEqual(["FN-1"]);
    } finally {
      await h.teardown();
    }
  });

  it("chunks large snapshot upserts and stale-id deletes", async () => {
    const h = await createTaskStoreForTest({ prefix: "fusion_even_realities_chunks" });
    try {
      const project = bind(h.layer, "even-chunks");
      const rows = Array.from({ length: 501 }, (_, index) => ({
        taskId: `FN-${index}`,
        lastColumn: "todo" as const,
        updatedAt: "2026-07-14T17:00:00.000Z",
      }));
      await writeSnapshot(project, rows);
      expect((await readSnapshot(project)).size).toBe(501);
      expect(await pruneMissing(project, new Set(["FN-500"]))).toBe(500);
      expect([...(await readSnapshot(project)).keys()]).toEqual(["FN-500"]);
    } finally {
      await h.teardown();
    }
  });
});
