/**
 * FNXC:SqliteFinalRemoval 2026-06-25-11:00:
 * PostgreSQL-backed counterpart of the searchTasks portions of
 * store-create.test.ts and store-parsing.test.ts. Validates the public
 * TaskStore.searchTasks() facade against the PostgreSQL backend mode,
 * exercising the full tsvector -> pgRowToTaskRow -> rowToTask -> hydration
 * stack (the low-level tsvector helpers are covered by fts-replacement.test.ts;
 * this file validates the facade glue and derived-field hydration).
 *
 * Migrated from `new TaskStore(rootDir, globalDir, { inMemoryDb: true })`
 * (SQLite) to `createSharedPgTaskStoreTestHarness` (PostgreSQL).
 */
import { afterEach, beforeEach, describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

const pgTest = pgDescribe;

pgTest("TaskStore.searchTasks facade (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_search",
  });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(async () => {
    await h.beforeEach();
  });
  afterEach(async () => {
    await h.afterEach();
  });

  it("empty/whitespace query falls back to listTasks (returns all live tasks)", async () => {
    const store = h.store();
    await store.createTask({ description: "alpha beta" });
    await store.createTask({ description: "gamma delta" });

    const empty = await store.searchTasks("");
    expect(empty.length).toBe(2);

    const whitespace = await store.searchTasks("   ");
    expect(whitespace.length).toBe(2);
  });

  it("matches a term in description and returns hydrated Task objects", async () => {
    const store = h.store();
    await store.createTask({ description: "Migrate the database layer" });
    await store.createTask({ description: "Redesign the frontend" });

    const results = await store.searchTasks("database");
    expect(results.length).toBe(1);
    expect(results[0].description).toContain("database");
    // Hydrated derived fields are present (not undefined crashes).
    expect(results[0].retrySummary).toBeDefined();
  });

  it("matches a term in title", async () => {
    const store = h.store();
    await store.createTask({ title: "Frobnicator setup", description: "setup the frob" });
    await store.createTask({ title: "Unrelated", description: "nothing here" });

    const results = await store.searchTasks("frobnicator");
    expect(results.length).toBe(1);
    expect(results[0].title).toBe("Frobnicator setup");
  });

  it("excludes soft-deleted tasks from search results", async () => {
    const store = h.store();
    const keep = await store.createTask({ description: "searchable keeper term" });
    const drop = await store.createTask({ description: "searchable dropper term" });
    await store.deleteTask(drop.id);

    const results = await store.searchTasks("searchable");
    const ids = results.map((t) => t.id);
    expect(ids).toContain(keep.id);
    expect(ids).not.toContain(drop.id);
  });

  it("includeArchived=false excludes archived-column tasks", async () => {
    const store = h.store();
    const live = await store.createTask({ description: "archived filter probe", column: "todo" });
    const archived = await store.createTask({ description: "archived filter probe", column: "archived" });

    const all = await store.searchTasks("probe");
    expect(all.map((t) => t.id).sort()).toEqual([archived.id, live.id].sort());

    const liveOnly = await store.searchTasks("probe", { includeArchived: false });
    expect(liveOnly.map((t) => t.id)).toEqual([live.id]);
  });

  it("slim mode strips the log payload", async () => {
    const store = h.store();
    await store.createTask({ description: "slim log probe target" });

    const full = await store.searchTasks("slim");
    expect(full.length).toBe(1);

    const slim = await store.searchTasks("slim", { slim: true });
    expect(slim.length).toBe(1);
    expect(slim[0].log).toEqual([]);
  });

  it("prefix matching: partial token finds longer indexed term", async () => {
    const store = h.store();
    await store.createTask({ title: "frobnicator install", description: "install the frob" });

    const results = await store.searchTasks("frob");
    expect(results.length).toBe(1);
    expect(results[0].title).toBe("frobnicator install");
  });
});
