#!/usr/bin/env node
/**
 * FNXC:ProjectMemory 2026-07-08-00:00:
 * Symptom-verification fixture for FN-7706. Fires a background qmd project-memory
 * refresh (scheduleQmdProjectMemoryRefresh, fire-and-forget) against whatever `qmd`
 * resolves on PATH, then returns from main immediately. If the default exec path
 * does not unref its spawned child + stdio, this process stays alive until the
 * background `qmd` child exits (or is force-killed) instead of exiting on its own
 * once this script's own work is done. Loaded via `tsx` so it can import the real
 * TypeScript source directly (no separate build step required for the test).
 */
import { scheduleQmdProjectMemoryRefresh, scheduleQmdAgentMemoryRefresh } from "../../memory-backend.ts";

const rootDir = process.argv[2];
const mode = process.argv[3] ?? "project";
if (!rootDir) {
  throw new Error("qmd-refresh-fixture: missing rootDir argument");
}

if (mode === "agent") {
  scheduleQmdAgentMemoryRefresh(rootDir, "fn-7706-fixture-agent");
} else {
  scheduleQmdProjectMemoryRefresh(rootDir);
}

// Print a marker so the test can confirm the fixture actually reached this point
// (i.e. the schedule call itself did not throw synchronously) before exiting.
console.log("qmd-refresh-fixture:scheduled");
