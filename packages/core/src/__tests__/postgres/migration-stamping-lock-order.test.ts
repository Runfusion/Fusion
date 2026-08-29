import { describe, expect, it, vi } from "vitest";
import {
  rekeyFallbackProjectPartition,
  stampMigratedProjectRows,
} from "../../postgres/migration-stamping.js";

function queryText(query: unknown): string {
  return (query as { queryChunks?: Array<{ value: string[] }> }).queryChunks
    ?.flatMap((chunk) => chunk.value).join("") ?? "";
}

function recordingDb(statements: string[]) {
  const execute = vi.fn(async (query: unknown) => {
    statements.push(queryText(query));
    return [];
  });
  return {
    transaction: vi.fn(async (callback: (tx: { execute: typeof execute }) => Promise<unknown>) => (
      callback({ execute })
    )),
  };
}

describe("migration stamping advisory-lock order", () => {
  it("locks out schema DDL before scanning every project-owned table", async () => {
    const statements: string[] = [];

    await rekeyFallbackProjectPartition(
      recordingDb(statements) as never,
      "local-fallback",
      "project-registered",
    );

    expect(statements[0]).toContain("fusion:sqlite-migration-state");
    expect(statements[1]).toContain("information_schema.columns");
  });

  it("locks out schema DDL before stamping migrated rows across tables", async () => {
    const statements: string[] = [];

    await stampMigratedProjectRows(recordingDb(statements) as never, {
      projectId: "project-registered",
      rootDir: "/project",
    });

    expect(statements[0]).toContain("fusion:sqlite-migration-state");
    expect(statements[1]).toContain("fusion_sqlite_migrations");
  });
});
