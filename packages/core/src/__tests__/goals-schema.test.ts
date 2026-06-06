import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Database } from "../db.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-goals-schema-test-"));
}

describe("goals schema", () => {
  let tmpDir: string;
  let fusionDir: string;
  let db: Database;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    fusionDir = join(tmpDir, ".fusion");
    db = new Database(fusionDir);
    db.init();
  });

  afterEach(async () => {
    db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates goals table with expected columns on fresh init", () => {
    const columns = db.prepare("PRAGMA table_info(goals)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual([
      "id",
      "title",
      "description",
      "status",
      "createdAt",
      "updatedAt",
    ]);
  });

  it("creates idxGoalsStatus index", () => {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idxGoalsStatus'")
      .get() as { name: string } | undefined;
    expect(row?.name).toBe("idxGoalsStatus");
  });

  it("round-trips inserted goal rows", () => {
    db.prepare(
      "INSERT INTO goals (id, title, description, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      "G-001",
      "North Star",
      "Strategic markdown",
      "active",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );

    const row = db
      .prepare("SELECT title, description, status, createdAt, updatedAt FROM goals WHERE id = ?")
      .get("G-001") as {
      title: string;
      description: string | null;
      status: string;
      createdAt: string;
      updatedAt: string;
    };

    expect(row).toEqual({
      title: "North Star",
      description: "Strategic markdown",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("creates goals table when migrating from schema version 91", () => {
    db.exec("DROP INDEX IF EXISTS idxGoalsStatus");
    db.exec("DROP TABLE IF EXISTS goals");
    db.prepare("UPDATE __meta SET value = '91' WHERE key = 'schemaVersion'").run();

    (db as unknown as { migrate: () => void }).migrate();

    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='goals'")
      .get() as { name: string } | undefined;
    expect(table?.name).toBe("goals");
  });

  it("reports schema version 101", () => {
    expect(db.getSchemaVersion()).toBe(112);
  });
});
