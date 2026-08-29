// Recovery tool: re-import specific FN-* tasks from .fusion/tasks/<id>/task.json
// into the live PostgreSQL backend. Never overwrites existing rows.
/*
FNXC:PostgresCutover 2026-07-05-13:00:
Ported from a hand-rolled node:sqlite INSERT OR IGNORE into fusion.db to the
store's own FN-6783 orphaned-task-dir reconcile (TaskStore.reconcileOrphanedTaskDirs),
which non-destructively re-imports valid live task directories that have no
task row anywhere — including soft-deleted/archived/tombstoned ID preservation
that the old raw INSERT could not honor. The script boots the backend, runs the
reconcile with the recency window disabled, and reports each requested ID.
*/
import { existsSync } from "node:fs";
import { join } from "node:path";
import { openBackend } from "./lib/backend-db.mjs";

const TASKS_DIR = join(process.cwd(), ".fusion", "tasks");

const TARGET_IDS = process.argv.slice(2);
if (TARGET_IDS.length === 0) {
  console.error("usage: node scripts/reimport-tasks.mjs FN-5414 FN-5415 ...");
  process.exit(2);
}

const backend = await openBackend(process.cwd());
let imported = 0;
let skipped = 0;
let missing = 0;

try {
  const { store } = backend;
  const result = await store.reconcileOrphanedTaskDirs({ ignoreRecencyWindow: true });
  const recovered = new Set(result.recovered);
  const skippedReasons = new Map(result.skipped.map((entry) => [entry.id, entry.reason]));

  for (const id of TARGET_IDS) {
    const path = join(TASKS_DIR, id, "task.json");
    if (recovered.has(id)) {
      const task = await store.getTask(id);
      console.log(`[ok]   ${id}: imported (col=${task?.column ?? "?"} status=${task?.status ?? "-"})`);
      imported++;
      continue;
    }
    if (!existsSync(path)) {
      console.log(`[skip] ${id}: no task.json on disk`);
      missing++;
      continue;
    }
    const existing = await store.getTask(id);
    if (existing) {
      console.log(`[skip] ${id}: already exists in DB`);
      skipped++;
      continue;
    }
    const reason = skippedReasons.get(id) ?? "not recovered by reconcile (see run-audit)";
    console.log(`[fail] ${id}: ${reason}`);
    skipped++;
  }
} finally {
  await backend.shutdown().catch(() => {});
}

console.log(`\ndone: imported=${imported} skipped=${skipped} missing=${missing}`);
