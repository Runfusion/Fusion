/*
FNXC:PostgresSchema 2026-07-13-19:40:
Regression invariant for the SQLite → PostgreSQL first-boot migration failure
where project.ce_sessions.last_activity_at was declared `integer` but stores
epoch milliseconds (Date.now() ≈ 1.78e12), overflowing PG integer (max ~2.1e9)
and aborting startup ("value ... is out of range for type integer").

Invariant across ALL schemas (project/central/archive/plugin): a numeric column
whose name marks it as a point-in-time value (`*_at`, `*_time`, `*_timestamp`)
must be bigint, never 32-bit integer. Timestamp columns stored as ISO text are
fine; durations/counters (`*_ms` intervals, counts) fit integer and are exempt.
*/
import { describe, it, expect } from "vitest";
import { getTableColumns, getTableName } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import * as schema from "../../postgres/schema/index.js";

const TIMESTAMP_NAME = /(_at|_time|_timestamp)$/;

function collectTables(mod: Record<string, unknown>): PgTable[] {
  return Object.values(mod).filter((v): v is PgTable => v instanceof PgTable);
}

describe("PG schema epoch-ms columns", () => {
  it("declares every numeric *_at/*_time/*_timestamp column as bigint, not integer", () => {
    const offenders: string[] = [];
    for (const mod of [schema.project, schema.central, schema.archive, schema.plugin]) {
      for (const table of collectTables(mod as Record<string, unknown>)) {
        for (const column of Object.values(getTableColumns(table))) {
          if (!TIMESTAMP_NAME.test(column.name)) continue;
          if (column.getSQLType() === "integer") {
            offenders.push(`${getTableName(table)}.${column.name}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
