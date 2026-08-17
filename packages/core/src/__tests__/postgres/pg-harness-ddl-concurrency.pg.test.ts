import { expect, it } from "vitest";
import postgres from "postgres";
import {
  createEmptyPgTestDatabase,
  PG_TEST_URL_BASE,
  pgDescribe,
} from "../../__test-utils__/pg-test-harness.js";

pgDescribe("harness DDL lifecycle (PostgreSQL)", () => {
  it("creates distinct empty databases and removes every one", async () => {
    /*
     * FNXC:PgTestDdlAdmission 2026-08-16-22:54:
     * FN-9130 reverted both hook-inline admission and deferred-drop wiring after
     * loaded measurements regressed wall time. Empty databases retain a real
     * concurrent harness lifecycle check without claiming that an unwired gate
     * bounds CREATE/DROP concurrency; the terminal contract is direct cleanup.
     * Creation must fully settle before cleanup snapshots successful results,
     * and every exit path retries all drops so a failed assertion cannot leak.
     */
    const creationResults = await Promise.allSettled(
      Array.from({ length: 12 }, () => createEmptyPgTestDatabase("ddl_lifecycle")),
    );
    const databases = creationResults.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    let maintenance: ReturnType<typeof postgres> | undefined;

    try {
      const creationFailure = creationResults.find((result) => result.status === "rejected");
      if (creationFailure?.status === "rejected") throw creationFailure.reason;

      const names = databases.map((database) => database.dbName);
      expect(new Set(names).size).toBe(names.length);

      const maintenanceUrl = new URL(PG_TEST_URL_BASE);
      maintenanceUrl.pathname = "/postgres";
      maintenance = postgres(maintenanceUrl.toString(), { max: 1, prepare: false });
      const [{ created }] = await maintenance.unsafe<{ created: number }[]>(
        "SELECT count(*)::int AS created FROM pg_database WHERE datname = ANY($1::text[])",
        [names],
      );
      expect(created).toBe(names.length);

      await Promise.all(databases.map((database) => database.drop()));

      const [{ remaining }] = await maintenance.unsafe<{ remaining: number }[]>(
        "SELECT count(*)::int AS remaining FROM pg_database WHERE datname = ANY($1::text[])",
        [names],
      );
      expect(remaining).toBe(0);
    } finally {
      await Promise.allSettled(databases.map((database) => database.drop()));
      await maintenance?.end({ timeout: 5 });
    }
  });
});
