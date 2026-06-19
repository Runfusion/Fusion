// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";

import { Database, SCHEMA_VERSION } from "@fusion/core";
import type { TaskStore } from "@fusion/core";
import {
  upsertKnowledgePage,
  queryKnowledgePages,
  getKnowledgePage,
  countKnowledgePages,
  refreshKnowledgeForTask,
  renderTaskPage,
  tokenizeQuery,
  buildSearchText,
} from "../knowledge-index.js";

function makeDb(): { db: Database; tmpDir: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), "kb-knowledge-index-"));
  const db = new Database(join(tmpDir, ".fusion"));
  db.init();
  return { db, tmpDir };
}

describe("knowledge-index store", () => {
  let db: Database;
  let tmpDir: string;

  beforeEach(() => {
    ({ db, tmpDir } = makeDb());
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates knowledge_pages with the expected columns on fresh init", () => {
    const cols = (db.prepare("PRAGMA table_info(knowledge_pages)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toEqual([
      "id",
      "sourceKind",
      "sourceId",
      "sourceKey",
      "title",
      "summary",
      "content",
      "tags",
      "searchText",
      "createdAt",
      "updatedAt",
    ]);
  });

  it("upserts a page and returns it via a keyword query", () => {
    const { created } = upsertKnowledgePage(db, {
      sourceKind: "task",
      sourceId: "T-1",
      title: "Add caching layer",
      content: "Introduced an LRU cache in fetcher.ts",
      tags: ["fetcher.ts"],
    });
    expect(created).toBe(true);
    const hits = queryKnowledgePages(db, { query: "cache" });
    expect(hits).toHaveLength(1);
    expect(hits[0].sourceId).toBe("T-1");
    expect(hits[0].tags).toEqual(["fetcher.ts"]);
  });

  it("AND-matches all query terms", () => {
    upsertKnowledgePage(db, { sourceKind: "task", sourceId: "T-1", title: "alpha gadget", content: "only alpha here" });
    upsertKnowledgePage(db, { sourceKind: "task", sourceId: "T-2", title: "alpha thing", content: "beta widget" });
    expect(queryKnowledgePages(db, { query: "alpha widget" }).map((p) => p.sourceId)).toEqual(["T-2"]);
  });

  it("a blank/termless query returns nothing (never the whole index)", () => {
    upsertKnowledgePage(db, { sourceKind: "task", sourceId: "T-1", title: "x", content: "y" });
    expect(queryKnowledgePages(db, { query: "" })).toHaveLength(0);
    expect(queryKnowledgePages(db, { query: "   " })).toHaveLength(0);
    expect(countKnowledgePages(db)).toBe(1);
  });

  it("escapes LIKE wildcards so user input can't widen the match", () => {
    upsertKnowledgePage(db, { sourceKind: "task", sourceId: "T-1", title: "literal", content: "100% done" });
    // A bare "%" must not match every row; it has no alphanumeric token at all.
    expect(queryKnowledgePages(db, { query: "%" })).toHaveLength(0);
    // The literal token does match.
    expect(queryKnowledgePages(db, { query: "100" })).toHaveLength(1);
  });

  it("incremental refresh updates only the affected page; others keep their timestamps", () => {
    const { page: a } = upsertKnowledgePage(db, {
      sourceKind: "task",
      sourceId: "T-A",
      title: "A",
      content: "a",
      now: "2026-01-01T00:00:00.000Z",
    });
    const { page: b } = upsertKnowledgePage(db, {
      sourceKind: "task",
      sourceId: "T-B",
      title: "B",
      content: "b",
      now: "2026-01-01T00:00:00.000Z",
    });
    expect(a.createdAt).toBe("2026-01-01T00:00:00.000Z");

    // Re-index only T-A at a later time.
    const { created, page: aUpdated } = upsertKnowledgePage(db, {
      sourceKind: "task",
      sourceId: "T-A",
      title: "A v2",
      content: "a v2",
      now: "2026-02-02T00:00:00.000Z",
    });
    expect(created).toBe(false);
    expect(aUpdated.createdAt).toBe("2026-01-01T00:00:00.000Z"); // createdAt preserved
    expect(aUpdated.updatedAt).toBe("2026-02-02T00:00:00.000Z"); // updatedAt advanced

    // T-B is untouched: same updatedAt as when it was created.
    const bAfter = getKnowledgePage(db, "task", "T-B");
    expect(bAfter?.updatedAt).toBe(b.updatedAt);
    expect(bAfter?.updatedAt).toBe("2026-01-01T00:00:00.000Z");
    // Still exactly two pages — no duplicate created on re-index.
    expect(countKnowledgePages(db)).toBe(2);
  });

  // Seed a DB at the PREVIOUS schema version (118), run migrate, assert the
  // table exists and SCHEMA_VERSION lands at the highest migration target (119).
  // Fresh-DB tests cannot catch the migrate-loop early-return bug this guards.
  it("creates knowledge_pages when migrating from the previous schema version", () => {
    db.exec("DROP INDEX IF EXISTS idxKnowledgePagesSourceKind");
    db.exec("DROP INDEX IF EXISTS idxKnowledgePagesUpdatedAt");
    db.exec("DROP TABLE IF EXISTS knowledge_pages");
    // Pinned to the literal pre-migration version (118), NOT SCHEMA_VERSION-1:
    // knowledge_pages was created by migration 119, so seeding at 118 keeps this
    // test exercising that CREATE block even after later migrations land (mirrors
    // the literal-117 pin in usage-events.test.ts).
    db.prepare("UPDATE __meta SET value = ? WHERE key = 'schemaVersion'").run("118");

    (db as unknown as { migrate: () => void }).migrate();

    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_pages'")
      .get() as { name: string } | undefined;
    expect(table?.name).toBe("knowledge_pages");
    expect(db.getSchemaVersion()).toBe(SCHEMA_VERSION);

    // The migrated table is writable and queryable.
    upsertKnowledgePage(db, { sourceKind: "task", sourceId: "T-mig", title: "migrated", content: "ok" });
    expect(queryKnowledgePages(db, { query: "migrated" })).toHaveLength(1);
  });

  it("SCHEMA_VERSION matches the highest applied migration on a fresh DB", () => {
    expect(db.getSchemaVersion()).toBe(SCHEMA_VERSION);
  });
});

describe("knowledge-index pure helpers", () => {
  it("tokenizeQuery splits on non-word chars and lowercases", () => {
    expect(tokenizeQuery("Add OAuth, login-flow!")).toEqual(["add", "oauth", "login", "flow"]);
    expect(tokenizeQuery("   ")).toEqual([]);
  });

  it("buildSearchText concatenates and lowercases all fields", () => {
    const text = buildSearchText({ title: "Title", summary: "Sum", content: "Body", tags: ["Tag"] });
    expect(text).toBe("title sum body tag");
  });

  it("renderTaskPage builds a deterministic page from task facts", () => {
    const page = renderTaskPage({
      id: "FN-7",
      title: "Fix bug",
      description: "Null deref in parser",
      modifiedFiles: ["src/parser.ts"],
      commitSubjects: ["fix: guard null"],
      prUrl: "https://example.com/pr/7",
    });
    expect(page.sourceKind).toBe("task");
    expect(page.sourceId).toBe("FN-7");
    expect(page.title).toBe("Fix bug");
    expect(page.content).toContain("Null deref in parser");
    expect(page.content).toContain("src/parser.ts");
    expect(page.content).toContain("fix: guard null");
    expect(page.content).toContain("https://example.com/pr/7");
    expect(page.tags).toEqual(["parser.ts"]);
  });

  it("renderTaskPage falls back to a generated title when none is set", () => {
    const page = renderTaskPage({ id: "FN-8", description: "", modifiedFiles: [] });
    expect(page.title).toBe("Task FN-8");
  });
});

describe("refreshKnowledgeForTask hook", () => {
  let db: Database;
  let tmpDir: string;

  function storeFor(database: Database, tasks: Record<string, unknown>): TaskStore {
    const store = new EventEmitter() as unknown as TaskStore & {
      getDatabase(): Database;
      getTask(id: string): Promise<unknown>;
    };
    store.getDatabase = () => database;
    store.getTask = async (id: string) => tasks[id] ?? null;
    return store;
  }

  beforeEach(() => {
    ({ db, tmpDir } = makeDb());
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("indexes a completed task so it becomes queryable", async () => {
    const store = storeFor(db, {
      "FN-1": {
        id: "FN-1",
        title: "Implement retry",
        description: "Exponential backoff in client.ts",
        modifiedFiles: ["client.ts"],
        column: "done",
      },
    });
    const page = await refreshKnowledgeForTask(store, "FN-1");
    expect(page?.sourceId).toBe("FN-1");
    expect(queryKnowledgePages(db, { query: "backoff" })).toHaveLength(1);
  });

  it("is fail-soft: returns null for a missing task without throwing", async () => {
    const store = storeFor(db, {});
    await expect(refreshKnowledgeForTask(store, "nope")).resolves.toBeNull();
    expect(countKnowledgePages(db)).toBe(0);
  });
});
