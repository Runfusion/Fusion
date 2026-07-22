/**
 * FNXC:PostgresSafeDefaults 2026-07-14-17:36:
 * PostgreSQL production paths must execute durable cleanup and safety invariants instead of returning empty safe defaults. This suite covers authoritative audit reads, deleted-branch reference cleanup, archived write rejection, and soft-delete column repair through the public TaskStore seams.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../../postgres/schema/index.js";
import { ChatStore } from "../../chat/chat-store.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

pgDescribe("TaskStore PostgreSQL safe-default removal", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_safe_defaults" });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("reads run audit authoritatively and clears stale execution-start branches", async () => {
    const store = h.store();
    const owner = await store.createTask({ description: "branch owner" });
    const dependent = await store.createTask({ description: "branch dependent" });
    await store.updateTask(owner.id, { executionStartBranch: "fusion/deleted" });
    await store.updateTask(dependent.id, { executionStartBranch: "fusion/deleted" });

    await store.recordRunAuditEvent({
      taskId: dependent.id,
      agentId: "test",
      runId: "safe-default-audit",
      domain: "database",
      mutationType: "task:updated",
      target: dependent.id,
    });
    expect((await store.getRunAuditEventsAsync({ runId: "safe-default-audit" })).map((event) => event.target)).toEqual([dependent.id]);

    expect(await store.clearStaleExecutionStartBranchReferences(["fusion/deleted"], owner.id)).toEqual([dependent.id]);
    expect((await store.getTask(owner.id)).executionStartBranch).toBe("fusion/deleted");
    expect((await store.getTask(dependent.id)).executionStartBranch).toBeUndefined();
  });

  it("keeps archived logs, comments, documents, and artifacts read-only", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "archive safety" });
    const commented = await store.addComment(task.id, "before archive", "user");
    const commentId = commented.comments?.[0]?.id;
    expect(commentId).toBeTruthy();
    await store.upsertTaskDocument(task.id, { key: "spec", content: "before archive" });
    const artifact = await store.registerArtifact({
      type: "document",
      title: "before archive",
      content: "body",
      authorId: "user",
      authorType: "user",
      taskId: task.id,
    });
    await store.archiveTask(task.id, { cleanup: false });

    await expect(store.logEntry(task.id, "must reject")).rejects.toThrow(/archived.*read-only/);
    await expect(store.addComment(task.id, "must reject", "user")).rejects.toThrow(/archived.*read-only/);
    await expect(store.updateTaskComment(task.id, commentId!, "must reject")).rejects.toThrow(/archived.*read-only/);
    await expect(store.deleteTaskComment(task.id, commentId!)).rejects.toThrow(/archived.*read-only/);
    await expect(store.upsertTaskDocument(task.id, { key: "spec", content: "must reject" })).rejects.toThrow(/archived.*read-only/);
    await expect(store.deleteTaskDocument(task.id, "spec")).rejects.toThrow(/archived.*read-only/);
    await expect(store.updateArtifact(artifact.id, { title: "must reject" })).rejects.toThrow(/archived.*read-only/);
    await expect(store.registerArtifact({
      type: "document",
      title: "must reject",
      content: "body",
      authorId: "user",
      authorType: "user",
      taskId: task.id,
    })).rejects.toThrow(/archived.*read-only/);
    expect(await store.getTaskDocuments(task.id)).toEqual([]);
    expect(await store.getArtifacts(task.id)).toEqual([]);
  });

  it("runs plugin schema initialization through the PostgreSQL executor without opening SQLite", async () => {
    const store = h.store();
    const executor = vi.fn().mockResolvedValue(undefined);
    const getDatabase = vi.spyOn(store, "getDatabase");
    store.setPluginPostgresSchemaExecutor(executor);

    await store.runPluginSchemaInits([]);

    expect(executor).toHaveBeenCalledWith([]);
    expect(getDatabase).not.toHaveBeenCalled();
  });

  it("repairs soft-deleted task column drift and audits the repaired row", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "drift repair" });
    await store.archiveTask(task.id, { cleanup: false });
    await h.layer().db
      .update(schema.project.tasks)
      .set({ column: "todo" })
      .where(eq(schema.project.tasks.id, task.id));
    const audited: Array<{ id: string; previousColumn: string }> = [];

    expect(await store.reconcileSoftDeletedColumnDriftBackend(async (candidate) => {
      audited.push(candidate);
    })).toEqual({ reconciled: 1 });
    expect(audited).toEqual([{ id: task.id, previousColumn: "todo" }]);
    const [row] = await h.layer().db
      .select({ column: schema.project.tasks.column })
      .from(schema.project.tasks)
      .where(eq(schema.project.tasks.id, task.id));
    expect(row?.column).toBe("archived");
  });

  it("clears live near-duplicate metadata when its canonical task becomes inactive", async () => {
    const store = h.store();
    const canonical = await store.createTask({ description: "canonical" });
    const duplicate = await store.createTask({ description: "duplicate" });
    await store.updateTask(duplicate.id, {
      sourceMetadataPatch: {
        nearDuplicateOf: canonical.id,
        nearDuplicateScore: 0.92,
        nearDuplicateSharedTokens: ["same"],
        retained: true,
      },
    });

    expect((await store.clearNearDuplicateReferencesTo(canonical.id, {
      column: "done",
      reason: "completed",
    })).map((task) => task.id)).toEqual([duplicate.id]);
    const updated = await store.getTask(duplicate.id);
    expect(updated.sourceMetadata).toEqual({ retained: true });
    expect(updated.log.at(-1)?.action).toContain("cleared duplicate flag");
  });

  it("persists and lists chat token usage without a fire-and-forget race", async () => {
    const chat = new ChatStore(h.layer());
    const recorded = await chat.recordTokenUsage({
      sourceKind: "chat",
      inputTokens: 12,
      outputTokens: 7,
      cachedTokens: 3,
      cacheWriteTokens: 0,
      agentId: "agent-pg",
      createdAt: "2026-07-14T18:49:00.000Z",
    });

    expect((await chat.listTokenUsageAsync()).map((entry) => entry.id)).toEqual([recorded?.id]);
  });
});
