import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "../db.js";
import { TaskStore } from "../store.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-task-docs-test-"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("TaskStore task documents", () => {
  let rootDir: string;
  let kbDir: string;
  let db: Database;
  let store: TaskStore;

  beforeEach(async () => {
    rootDir = makeTmpDir();
    kbDir = join(rootDir, ".fusion");
    db = new Database(kbDir);
    db.init();
    store = new TaskStore(rootDir);
    await store.init();
  });

  afterEach(async () => {
    try {
      store.close();
    } catch {
      // ignore
    }
    try {
      db.close();
    } catch {
      // ignore
    }
    await rm(rootDir, { recursive: true, force: true });
  });

  it("creates task document tables/indexes and bumps schema version", () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const tableNames = new Set(tables.map((table) => table.name));

    expect(tableNames.has("task_documents")).toBe(true);
    expect(tableNames.has("task_document_revisions")).toBe(true);
    expect(db.getSchemaVersion()).toBe(18);

    const index = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'task_documents' AND name = 'idxTaskDocumentsTaskKey'",
      )
      .get() as { name: string } | undefined;
    expect(index?.name).toBe("idxTaskDocumentsTaskKey");
  });

  it("creates a document with revision 1, default author, and optional metadata", async () => {
    const task = await store.createTask({ description: "Document task" });

    const created = await store.upsertTaskDocument(task.id, {
      key: "plan",
      content: "Initial plan",
    });

    expect(created.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(created.taskId).toBe(task.id);
    expect(created.key).toBe("plan");
    expect(created.content).toBe("Initial plan");
    expect(created.revision).toBe(1);
    expect(created.author).toBe("user");
    expect(created.metadata).toBeUndefined();

    const withMetadata = await store.upsertTaskDocument(task.id, {
      key: "notes",
      content: "Captured notes",
      author: "agent",
      metadata: { source: "brainstorm", tags: ["todo"] },
    });

    expect(withMetadata.revision).toBe(1);
    expect(withMetadata.author).toBe("agent");
    expect(withMetadata.metadata).toEqual({ source: "brainstorm", tags: ["todo"] });
  });

  it("validates keys and task existence on create", async () => {
    const task = await store.createTask({ description: "Validation task" });

    const invalidKeys = ["", "my plan", "plan!", "a".repeat(65)];
    for (const key of invalidKeys) {
      await expect(
        store.upsertTaskDocument(task.id, {
          key,
          content: "x",
        }),
      ).rejects.toThrow(/Invalid document key/);
    }

    await expect(
      store.upsertTaskDocument("KB-DOES-NOT-EXIST", {
        key: "plan",
        content: "x",
      }),
    ).rejects.toThrow("Task KB-DOES-NOT-EXIST not found");
  });

  it("updates a document, increments revision, and archives previous content", async () => {
    const task = await store.createTask({ description: "Update task" });

    const first = await store.upsertTaskDocument(task.id, {
      key: "plan",
      content: "v1",
      author: "user",
      metadata: { stage: 1 },
    });

    await sleep(2);

    const second = await store.upsertTaskDocument(task.id, {
      key: "plan",
      content: "v2",
      author: "agent",
      metadata: { stage: 2 },
    });

    expect(second.revision).toBe(2);
    expect(second.content).toBe("v2");
    expect(second.author).toBe("agent");
    expect(second.metadata).toEqual({ stage: 2 });
    expect(new Date(second.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(first.updatedAt).getTime(),
    );

    const revisions = await store.getTaskDocumentRevisions(task.id, "plan");
    expect(revisions).toHaveLength(1);
    expect(revisions[0].revision).toBe(1);
    expect(revisions[0].content).toBe("v1");
    expect(revisions[0].author).toBe("user");
    expect(revisions[0].metadata).toEqual({ stage: 1 });
  });

  it("supports multiple updates with archived revisions queryable", async () => {
    const task = await store.createTask({ description: "Multi update task" });

    await store.upsertTaskDocument(task.id, { key: "plan", content: "v1", author: "user" });
    await store.upsertTaskDocument(task.id, { key: "plan", content: "v2", author: "agent" });
    const latest = await store.upsertTaskDocument(task.id, {
      key: "plan",
      content: "v3",
      author: "system",
    });

    expect(latest.revision).toBe(3);

    const revisions = await store.getTaskDocumentRevisions(task.id, "plan");
    expect(revisions.map((revision) => revision.revision)).toEqual([2, 1]);

    const current = await store.getTaskDocument(task.id, "plan");
    expect(current?.revision).toBe(3);
    expect(current?.content).toBe("v3");
  });

  it("returns document revisions newest-first and supports limit", async () => {
    const task = await store.createTask({ description: "Revision list task" });

    await store.upsertTaskDocument(task.id, { key: "plan", content: "v1" });
    await store.upsertTaskDocument(task.id, { key: "plan", content: "v2" });
    await store.upsertTaskDocument(task.id, { key: "plan", content: "v3" });

    const all = await store.getTaskDocumentRevisions(task.id, "plan");
    expect(all.map((revision) => revision.revision)).toEqual([2, 1]);

    const limited = await store.getTaskDocumentRevisions(task.id, "plan", { limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0].revision).toBe(2);

    const missing = await store.getTaskDocumentRevisions(task.id, "missing");
    expect(missing).toEqual([]);
  });

  it("gets the latest document revision by key and returns null when missing", async () => {
    const task = await store.createTask({ description: "Get doc task" });

    await store.upsertTaskDocument(task.id, { key: "plan", content: "v1" });
    await store.upsertTaskDocument(task.id, { key: "plan", content: "v2" });

    const document = await store.getTaskDocument(task.id, "plan");
    expect(document?.revision).toBe(2);
    expect(document?.content).toBe("v2");

    const missing = await store.getTaskDocument(task.id, "unknown");
    expect(missing).toBeNull();
  });

  it("lists all task documents ordered by key", async () => {
    const task = await store.createTask({ description: "List docs task" });
    const emptyTask = await store.createTask({ description: "Empty docs task" });

    await store.upsertTaskDocument(task.id, { key: "zeta", content: "z" });
    await store.upsertTaskDocument(task.id, { key: "alpha", content: "a" });
    await store.upsertTaskDocument(task.id, { key: "middle", content: "m" });

    const docs = await store.getTaskDocuments(task.id);
    expect(docs.map((doc) => doc.key)).toEqual(["alpha", "middle", "zeta"]);

    const empty = await store.getTaskDocuments(emptyTask.id);
    expect(empty).toEqual([]);
  });

  it("enforces one document per key per task via upsert semantics", async () => {
    const task = await store.createTask({ description: "Unique key task" });

    await store.upsertTaskDocument(task.id, { key: "plan", content: "v1" });
    await store.upsertTaskDocument(task.id, { key: "notes", content: "v1" });
    const updated = await store.upsertTaskDocument(task.id, { key: "plan", content: "v2" });

    expect(updated.revision).toBe(2);

    const docs = await store.getTaskDocuments(task.id);
    expect(docs).toHaveLength(2);
    expect(docs.find((doc) => doc.key === "plan")?.revision).toBe(2);
  });

  it("deletes a document and its revisions, and throws if the document is missing", async () => {
    const task = await store.createTask({ description: "Delete doc task" });

    await store.upsertTaskDocument(task.id, { key: "plan", content: "v1" });
    await store.upsertTaskDocument(task.id, { key: "plan", content: "v2" });

    await store.deleteTaskDocument(task.id, "plan");

    const afterDelete = await store.getTaskDocument(task.id, "plan");
    expect(afterDelete).toBeNull();

    const revisions = await store.getTaskDocumentRevisions(task.id, "plan");
    expect(revisions).toEqual([]);

    await expect(store.deleteTaskDocument(task.id, "plan")).rejects.toThrow(
      `Document plan not found for task ${task.id}`,
    );
  });

  it("deletes task documents via foreign key cascade when a task is deleted", async () => {
    const task = await store.createTask({ description: "Cascade task" });
    await store.upsertTaskDocument(task.id, { key: "plan", content: "v1" });

    await store.deleteTask(task.id);

    const documents = await store.getTaskDocuments(task.id);
    expect(documents).toEqual([]);

    const document = await store.getTaskDocument(task.id, "plan");
    expect(document).toBeNull();
  });

  it("accepts valid key edge cases and rejects invalid ones", async () => {
    const task = await store.createTask({ description: "Key edge case task" });

    const validKeys = ["plan", "PLAN", "my-notes", "doc_123", "a", "a".repeat(64)];
    for (const [index, key] of validKeys.entries()) {
      await expect(
        store.upsertTaskDocument(task.id, {
          key,
          content: `content-${index}`,
        }),
      ).resolves.toBeDefined();
    }

    const invalidKeys = ["", "my plan", "plan!", "a".repeat(65)];
    for (const key of invalidKeys) {
      await expect(
        store.upsertTaskDocument(task.id, {
          key,
          content: "invalid",
        }),
      ).rejects.toThrow(/Invalid document key/);
    }
  });
});
