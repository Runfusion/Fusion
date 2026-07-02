/**
 * FNXC:SqliteFinalRemoval 2026-06-25:
 * PostgreSQL-backed counterpart of the attachments subset of
 * store-attachments.test.ts.
 *
 * Exercises the backend-mode (asyncLayer) path for attachment metadata
 * persistence (stored in the tasks.attachments jsonb column) and the
 * filesystem-backed attachment file storage (rootDir-scoped).
 *
 * The original SQLite test remains until SQLite is fully removed; this PG
 * twin is auto-skipped in CI without PostgreSQL (pgDescribe).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

const pgTest = pgDescribe;

pgTest("TaskStore attachments (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_attach",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  const TINY_PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
    "base64",
  );

  it("adds an attachment and persists metadata in task", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "attach target" });
    const attachment = await store.addAttachment(task.id, "screenshot.png", TINY_PNG, "image/png");

    expect(attachment.originalName).toBe("screenshot.png");
    expect(attachment.mimeType).toBe("image/png");
    expect(attachment.size).toBe(TINY_PNG.length);
    expect(attachment.filename).toMatch(/^\d+-screenshot\.png$/);

    const updated = await store.getTask(task.id);
    expect(updated.attachments).toHaveLength(1);
    expect(updated.attachments![0].filename).toBe(attachment.filename);

    const filePath = join(h.rootDir(), ".fusion", "tasks", task.id, "attachments", attachment.filename);
    const content = await readFile(filePath);
    expect(content).toEqual(TINY_PNG);
  });

  it("accepts text/plain mime type", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "text attach" });
    const attachment = await store.addAttachment(
      task.id,
      "error.log",
      Buffer.from("log content"),
      "text/plain",
    );
    expect(attachment.originalName).toBe("error.log");
    expect(attachment.mimeType).toBe("text/plain");
  });

  it("accepts application/json mime type", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "json attach" });
    const attachment = await store.addAttachment(
      task.id,
      "config.json",
      Buffer.from('{"key":"val"}'),
      "application/json",
    );
    expect(attachment.mimeType).toBe("application/json");
  });

  it("accepts text/yaml mime type", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "yaml attach" });
    const attachment = await store.addAttachment(
      task.id,
      "config.yaml",
      Buffer.from("key: val"),
      "text/yaml",
    );
    expect(attachment.mimeType).toBe("text/yaml");
  });

  it("rejects unsupported mime types", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "reject mime" });
    await expect(
      store.addAttachment(task.id, "file.bin", Buffer.from("data"), "application/octet-stream"),
    ).rejects.toThrow("Invalid mime type");
  });

  it("rejects oversized files", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "oversized" });
    const bigBuffer = Buffer.alloc(6 * 1024 * 1024); // 6MB
    await expect(store.addAttachment(task.id, "big.png", bigBuffer, "image/png")).rejects.toThrow(
      "File too large",
    );
  });

  it("gets attachment path and mime type", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "get attach" });
    const attachment = await store.addAttachment(task.id, "shot.png", TINY_PNG, "image/png");

    const result = await store.getAttachment(task.id, attachment.filename);
    expect(result.mimeType).toBe("image/png");
    expect(result.path).toContain(attachment.filename);
  });

  it("deletes an attachment from disk and metadata", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "delete attach" });
    const attachment = await store.addAttachment(task.id, "del.png", TINY_PNG, "image/png");

    const updated = await store.deleteAttachment(task.id, attachment.filename);
    expect(updated.attachments).toBeUndefined();

    const filePath = join(h.rootDir(), ".fusion", "tasks", task.id, "attachments", attachment.filename);
    expect(existsSync(filePath)).toBe(false);
  });

  it("throws ENOENT when getting non-existent attachment", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "get missing" });
    await expect(store.getAttachment(task.id, "nonexistent.png")).rejects.toThrow("not found");
  });

  it("throws ENOENT when deleting non-existent attachment", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "delete missing" });
    await expect(store.deleteAttachment(task.id, "nonexistent.png")).rejects.toThrow("not found");
  });
});
