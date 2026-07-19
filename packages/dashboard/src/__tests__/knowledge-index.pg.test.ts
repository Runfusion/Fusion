// @vitest-environment node

/**
 * FNXC:KnowledgeIndex 2026-07-14-17:05:
 * PostgreSQL cutover must preserve incremental task-history indexing, project-local duplicate source keys, keyword query/count behavior, and the authenticated route response instead of silently returning an empty index.
 */
import { expect, it, vi } from "vitest";
import type { AsyncDataLayer, TaskStore } from "@fusion/core";
import {
  createTaskStoreForTest,
  pgDescribe,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import {
  countKnowledgePagesAsync,
  queryKnowledgePagesAsync,
  refreshKnowledgeForTask,
  upsertKnowledgePageAsync,
} from "../knowledge-index.js";
import { registerKnowledgeRoutes } from "../routes/register-knowledge-routes.js";

function bind(layer: AsyncDataLayer, projectId: string): AsyncDataLayer {
  return { ...layer, projectId };
}

pgDescribe("knowledge index PostgreSQL persistence", () => {
  it("upserts, searches, refreshes, and serves only the bound project", async () => {
    const h = await createTaskStoreForTest({ prefix: "fusion_knowledge_index" });
    try {
      const projectA = bind(h.layer, "knowledge-a");
      const projectB = bind(h.layer, "knowledge-b");

      await expect(upsertKnowledgePageAsync(h.layer, {
        sourceKind: "task",
        sourceId: "FN-1",
        title: "Unbound",
        content: "must fail",
      })).rejects.toThrow("requires asyncLayer.projectId");

      const first = await upsertKnowledgePageAsync(projectA, {
        sourceKind: "task",
        sourceId: "FN-1",
        title: "Postgres migration",
        content: "Port the durable knowledge index",
        tags: ["storage.ts"],
        now: "2026-07-14T17:00:00.000Z",
      });
      expect(first.created).toBe(true);
      const updated = await upsertKnowledgePageAsync(projectA, {
        sourceKind: "task",
        sourceId: "FN-1",
        title: "Postgres migration complete",
        content: "Port the durable knowledge index and route",
        tags: ["storage.ts", "routes.ts"],
        now: "2026-07-14T17:01:00.000Z",
      });
      expect(updated.created).toBe(false);
      expect(updated.page.createdAt).toBe("2026-07-14T17:00:00.000Z");
      expect(updated.page.updatedAt).toBe("2026-07-14T17:01:00.000Z");

      await upsertKnowledgePageAsync(projectB, {
        sourceKind: "task",
        sourceId: "FN-1",
        title: "Other project",
        content: "Same source key in an isolated project",
      });
      expect(await countKnowledgePagesAsync(projectA)).toBe(1);
      expect(await countKnowledgePagesAsync(projectB)).toBe(1);
      expect(await queryKnowledgePagesAsync(projectA, { query: "postgres route" })).toEqual([
        expect.objectContaining({ sourceKey: "task:FN-1", title: "Postgres migration complete" }),
      ]);
      expect(await queryKnowledgePagesAsync(projectB, { query: "postgres route" })).toEqual([]);

      const fakeStore = {
        isBackendMode: () => true,
        getAsyncLayer: () => projectA,
        getTask: vi.fn().mockResolvedValue({
          id: "FN-2",
          lineageId: "lineage-2",
          title: "Refresh backend task",
          description: "Knowledge refresh persists after cutover",
          modifiedFiles: ["packages/dashboard/src/knowledge-index.ts"],
          column: "done",
        }),
        getTaskCommitAssociationsByLineageId: vi.fn().mockResolvedValue([
          { commitSubject: "fix: persist knowledge", authoredAt: "2026-07-14T16:00:00.000Z" },
        ]),
        getDatabase: vi.fn(() => { throw new Error("SQLite must not be opened"); }),
      } as unknown as TaskStore;
      const refreshed = await refreshKnowledgeForTask(fakeStore, "FN-2", {
        now: "2026-07-14T17:02:00.000Z",
      });
      expect(refreshed).toEqual(expect.objectContaining({ sourceKey: "task:FN-2" }));

      let queryHandler: ((req: any, res: any) => Promise<void>) | undefined;
      registerKnowledgeRoutes({
        router: {
          get: (path: string, handler: typeof queryHandler) => {
            if (path === "/knowledge/query") queryHandler = handler;
          },
          post: vi.fn(),
        },
        getScopedStore: vi.fn().mockResolvedValue(fakeStore),
        rethrowAsApiError: (error: unknown) => { throw error; },
      } as any);
      const json = vi.fn();
      await queryHandler!({ query: { q: "refresh cutover" } }, { json });
      expect(json).toHaveBeenCalledWith({
        query: "refresh cutover",
        pages: [expect.objectContaining({ sourceKey: "task:FN-2" })],
        total: 2,
      });
      expect((fakeStore as any).getDatabase).not.toHaveBeenCalled();

      const concurrent = await Promise.all(
        Array.from({ length: 6 }, (_, index) => upsertKnowledgePageAsync(projectA, {
          sourceKind: "task",
          sourceId: "FN-CONCURRENT",
          title: `Concurrent writer ${index}`,
          content: "Only the atomic insert winner reports creation",
        })),
      );
      expect(concurrent.filter((result) => result.created)).toHaveLength(1);
    } finally {
      await h.teardown();
    }
  });
});
