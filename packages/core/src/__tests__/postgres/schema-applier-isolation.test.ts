import { afterEach, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { applySchemaBaseline } from "../../postgres/index.js";
import {
  createBaselinedPgTestDatabase,
  createEmptyPgTestDatabase,
  pgDescribe,
} from "../../__test-utils__/pg-test-harness.js";

/*
FNXC:PgSchemaApplierIsolation 2026-08-16-19:08:
First-apply and historical-upgrade tests need empty fixtures, while schema-present
parity and rekey tests need serialized golden clones. Verify both fixture contracts
so future bootstrap changes cannot reintroduce repeated baseline DDL into the
registered four-action loop or make migration assertions vacuous.
*/
pgDescribe("schema-applier PostgreSQL bootstrap isolation", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((dispose) => dispose()));
  });

  it("uses shared empty and baselined primitives for their distinct contracts", async () => {
    const source = readFileSync(
      fileURLToPath(new URL("./schema-applier.test.ts", import.meta.url)),
      "utf8",
    );
    expect(source).toContain("return setupTestDb(createEmptyPgTestDatabase);");
    expect(source).toContain("return setupTestDb(createBaselinedPgTestDatabase);");
    expect(source).toContain('ctx = await setupBaselinedDb();\n      await applySchemaBaseline(ctx.db);');
    expect(source).not.toMatch(/function\s+(?:adminExec|uniqueDbName)\s*\(/);
    expect(source).not.toContain("CREATE DATABASE");

    const empty = await createEmptyPgTestDatabase("fusion_schema_applier_isolation_empty");
    const emptyConnection = postgres(empty.testUrl, { max: 1, prepare: false, onnotice: () => {} });
    cleanup.push(async () => {
      await emptyConnection.end({ timeout: 5 }).catch(() => {});
      await empty.drop();
    });
    expect((await applySchemaBaseline(drizzle(emptyConnection))).applied).toBe(true);

    const baselined = await createBaselinedPgTestDatabase("fusion_schema_applier_isolation_ready");
    const baselinedConnection = postgres(baselined.testUrl, { max: 1, prepare: false, onnotice: () => {} });
    cleanup.push(async () => {
      await baselinedConnection.end({ timeout: 5 }).catch(() => {});
      await baselined.drop();
    });
    expect((await applySchemaBaseline(drizzle(baselinedConnection))).applied).toBe(false);
  });
});
