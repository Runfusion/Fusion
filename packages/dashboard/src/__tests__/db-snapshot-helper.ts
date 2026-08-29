/*
 * FNXC:DashboardTests 2026-06-25-16:30:
 * Migrated in-memory DB snapshot for dashboard route suites.
 *
 * Route tests build a fresh in-memory TaskStore/AgentStore per test, and each
 * store.init() replays SCHEMA_SQL + ~129 migrations (~30-90ms). This helper
 * migrates ONE in-memory DB per test file, serializes it, and registers the
 * bytes via @fusion/core's setInMemoryTemplateSnapshot so every later in-memory
 * Database is restored from the snapshot instead of re-migrating. Test
 * isolation is unchanged — each test still gets its own fresh in-memory DB.
 *
 * Mirrors packages/core/src/__tests__/store-test-helpers.ts; kept separate
 * because that file lives in @fusion/core's private __tests__ dir.
 *
 * Usage:
 *   beforeAll(() => installInMemoryDbSnapshot());
 *   afterAll(() => clearInMemoryDbSnapshot());
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database, setInMemoryTemplateSnapshot } from "@fusion/core";

let cachedMigratedSnapshot: Uint8Array | null = null;

export function installInMemoryDbSnapshot(): void {
  if (process.env.FN_NO_SNAPSHOT === "1") return; // A/B benchmark escape hatch
  if (!cachedMigratedSnapshot) {
    // Build the template with the hook OFF so it runs real migrations once.
    setInMemoryTemplateSnapshot(null);
    const templateDir = mkdtempSync(join(tmpdir(), "fn-dash-db-snapshot-"));
    const template = new Database(templateDir, { inMemory: true });
    try {
      template.init();
      cachedMigratedSnapshot = template.serializeSnapshot();
    } finally {
      template.close();
    }
  }
  setInMemoryTemplateSnapshot(cachedMigratedSnapshot);
}

export function clearInMemoryDbSnapshot(): void {
  setInMemoryTemplateSnapshot(null);
}
