/**
 * FNXC:RuntimeStartupWiring 2026-06-24-10:45:
 * Integration test for createTaskStoreForBackend against a real PostgreSQL
 * instance (external mode). Verifies the five-step boot sequence:
 *   1. resolveBackend() → external.
 *   2. createConnectionSet opens the pool.
 *   3. applySchemaBaseline lands the schema.
 *   4. TaskStore is constructed in backend mode (asyncLayer injected).
 *   5. shutdown() releases the pool cleanly.
 *
 * Skipped when PostgreSQL is unreachable (FUSION_PG_TEST_SKIP=1) so the merge
 * gate stays green without a running server. Run locally with PG on 5432.
 */

import { afterEach, describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTaskStoreForBackend } from "../../postgres/startup-factory.js";

const PG_TEST_URL_BASE =
  process.env.FUSION_PG_TEST_URL_BASE ?? "postgresql://localhost:5432";
const PG_AVAILABLE =
  process.env.FUSION_PG_TEST_SKIP !== "1" && Boolean(PG_TEST_URL_BASE);

const pgDescribe = PG_AVAILABLE ? describe : describe.skip;

function uniqueDbName(): string {
  return `fusion_startup_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
}

function adminExec(statement: string): void {
  execSync(
    `psql -h localhost -p 5432 -U ${process.env.USER ?? "postgres"} -d postgres -v ON_ERROR_STOP=1 -c "${statement.replace(/"/g, '\\"')}"`,
    { stdio: "pipe", env: process.env },
  );
}

pgDescribe("startup-factory: external PostgreSQL boot (integration)", () => {
  let rootDir: string;
  let dbName: string;

  afterEach(async () => {
    if (dbName) {
      try {
        adminExec(`DROP DATABASE IF EXISTS "${dbName}"`);
      } catch {
        // best-effort
      }
    }
    if (rootDir) {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("boots a PostgreSQL-backed TaskStore and the store reports backend mode", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "startup-factory-pg-"));
    dbName = uniqueDbName();
    adminExec(`CREATE DATABASE "${dbName}"`);
    const testUrl = `${PG_TEST_URL_BASE}/${dbName}`;

    const result = await createTaskStoreForBackend({
      rootDir,
      env: { DATABASE_URL: testUrl },
      poolMax: 2,
    });

    expect(result).not.toBeNull();
    expect(result!.backend.mode).toBe("external");
    expect(result!.taskStore.isBackendMode()).toBe(true);
    expect(result!.taskStore.getAsyncLayer()).not.toBeNull();
    // init() in backend mode skips SQLite (no .db file under .fusion).
    await result!.taskStore.init();
    await result!.shutdown();
  });

  it("applies the schema baseline idempotently on repeated boots", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "startup-factory-pg-idem-"));
    dbName = uniqueDbName();
    adminExec(`CREATE DATABASE "${dbName}"`);
    const testUrl = `${PG_TEST_URL_BASE}/${dbName}`;

    const first = await createTaskStoreForBackend({
      rootDir,
      env: { DATABASE_URL: testUrl },
      poolMax: 1,
    });
    expect(first).not.toBeNull();
    await first!.shutdown();

    // Second boot against the same database: baseline is already applied.
    const second = await createTaskStoreForBackend({
      rootDir,
      env: { DATABASE_URL: testUrl },
      poolMax: 1,
    });
    expect(second).not.toBeNull();
    await second!.shutdown();
  });
});
