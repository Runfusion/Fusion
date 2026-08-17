/*
FNXC:ReliabilityFixtures 2026-08-16-22:30:
FN-9133 pins the reliability helper's bounded maintenance-connection contract.
A live extra database connection must not survive cleanup, and DDL must never
create a psql child that can outlive Vitest's subprocess guard.
*/
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createConnectionSetFromUrl, drizzleSql, type ResolvedBackend } from "@fusion/core";
import postgres from "postgres";

import { createPgLayer, hasPg } from "./_helpers.js";

const PG_TEST_URL_BASE = process.env.FUSION_PG_TEST_URL_BASE ?? "postgresql://localhost:5432";

function maintenanceUrl(): string {
  const url = new URL(PG_TEST_URL_BASE);
  url.pathname = "/postgres";
  return url.toString();
}

function connectionBackend(url: string): ResolvedBackend {
  return {
    mode: "external",
    runtimeUrl: url,
    migrationUrl: url,
    migrationUrlOverridden: false,
  };
}

const pgDescribe = hasPg ? describe : describe.skip;

pgDescribe("FN-9133 reliability PostgreSQL DDL contract", () => {
  it("force-drops a live fixture database, is idempotent, and has no psql DDL spawn", async () => {
    const fixture = await createPgLayer();
    const heldClient = postgres(`${PG_TEST_URL_BASE}/${fixture.dbName}`, {
      max: 1,
      prepare: false,
      onnotice: () => {},
    });
    const heldConnection = await heldClient.reserve();
    const maint = await createConnectionSetFromUrl(connectionBackend(maintenanceUrl()), {
      poolMax: 1,
      connectTimeoutSeconds: 5,
    });

    try {
      // A reserved connection with an open transaction stays attached until FORCE ends it.
      await heldConnection.unsafe("BEGIN");
      await expect(fixture.cleanup()).resolves.toBeUndefined();
      await expect(fixture.cleanup()).resolves.toBeUndefined();
      const rows = await maint.runtime.execute(drizzleSql`
        SELECT datname FROM pg_database WHERE datname = ${fixture.dbName}
      `);
      expect(rows).toEqual([]);
      const source = await readFile(new URL("./_helpers.ts", import.meta.url), "utf8");
      expect(source).not.toMatch(/(?:exec|execSync|spawnSync)\(\s*["'`]psql\b/);
    } finally {
      // FORCE may already have closed this socket; do not issue a follow-up query on it.
      heldConnection.release();
      void heldClient.end({ timeout: 0 }).catch(() => {});
      await maint.close().catch(() => {});
      await fixture.cleanup();
    }
  });
});
