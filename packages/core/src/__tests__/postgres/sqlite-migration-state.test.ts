import { describe, expect, it, vi } from "vitest";

import {
  getSqliteMigrationState,
  isSqliteMigrationComplete,
} from "../../postgres/sqlite-migrator.js";

function queryText(query: unknown): string {
  return (query as { queryChunks?: Array<{ value: string[] }> }).queryChunks
    ?.flatMap((chunk) => chunk.value).join("") ?? "";
}

describe("SQLite migration state reads", () => {
  function recordingDb(results: unknown[][]) {
    const statements: string[] = [];
    const execute = vi.fn(async (query: unknown) => {
      statements.push(queryText(query));
      return results.shift() ?? [];
    });
    return { db: { execute }, statements };
  }

  function expectReadOnly(statements: string[]) {
    expect(statements).not.toEqual([]);
    for (const statement of statements) {
      expect(statement).not.toMatch(/\b(?:CREATE|INSERT|UPDATE|DELETE|ALTER|DROP)\b/i);
    }
  }

  it("treats a missing marker table as no state without issuing DDL", async () => {
    const { db, statements } = recordingDb([[{ exists: false }]]);

    await expect(getSqliteMigrationState(db as never, "project:demo")).resolves.toBeNull();
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("to_regclass");
    expectReadOnly(statements);
  });

  it("returns no state when the marker table exists without the requested key", async () => {
    const { db, statements } = recordingDb([[{ exists: true }], []]);

    await expect(getSqliteMigrationState(db as never, "project:demo")).resolves.toBeNull();
    expect(statements).toHaveLength(2);
    expectReadOnly(statements);
  });

  it("maps an existing marker without issuing writes", async () => {
    const marker = {
      migration_key: "project:demo",
      project_id: "demo",
      status: "failed" as const,
      last_error: "copy failed",
      updated_at: "2026-07-19T00:00:00.000Z",
    };
    const { db, statements } = recordingDb([[{ exists: true }], [marker]]);

    await expect(getSqliteMigrationState(db as never, "project:demo")).resolves.toEqual({
      migrationKey: marker.migration_key,
      projectId: marker.project_id,
      status: marker.status,
      lastError: marker.last_error,
      updatedAt: marker.updated_at,
    });
    expectReadOnly(statements);
  });

  it.each([
    [undefined, false],
    ["running", false],
    ["failed", false],
    ["complete", true],
  ] as const)("reports %s markers as complete=%s without issuing DDL", async (status, expected) => {
    const results = status === undefined
      ? [[{ exists: false }]]
      : [[{ exists: true }], [{
          migration_key: "project:demo",
          project_id: "demo",
          status,
          last_error: null,
          updated_at: "2026-07-19T00:00:00.000Z",
        }]];
    const { db, statements } = recordingDb(results);

    await expect(isSqliteMigrationComplete(db as never, "project:demo")).resolves.toBe(expected);
    expectReadOnly(statements);
  });
});
