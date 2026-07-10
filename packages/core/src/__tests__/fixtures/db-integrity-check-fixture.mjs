#!/usr/bin/env node
/**
 * FNXC:Database 2026-07-08-00:00:
 * Symptom-verification fixture for FN-7709. Fires
 * `integrityCheckSqliteFileAsync` (fire-and-forget, mirroring how
 * `scheduleBackgroundIntegrityCheck` invokes it in production) against
 * whatever `sqlite3` resolves on PATH, then returns from main immediately.
 * If the async spawn path does not unref its child + stdio, this process
 * stays alive until the background `sqlite3` child exits (or is
 * force-killed by the AbortSignal timeout) instead of exiting on its own
 * once this script's own work is done. Loaded via `tsx` so it can import
 * the real TypeScript source directly (no separate build step required).
 */
import { integrityCheckSqliteFileAsync } from "../../db.ts";

const dbPath = process.argv[2];
if (!dbPath) {
  throw new Error("db-integrity-check-fixture: missing dbPath argument");
}

// Intentionally NOT awaited — mirrors `scheduleBackgroundIntegrityCheck`'s
// `void (async () => { await integrityCheckSqliteFileAsync(...) })()` fire-and-forget
// call site in db.ts.
void integrityCheckSqliteFileAsync(dbPath);

// Print a marker so the test can confirm the fixture actually reached this
// point (i.e. the call itself did not throw synchronously) before exiting.
console.log("db-integrity-check-fixture:scheduled");
