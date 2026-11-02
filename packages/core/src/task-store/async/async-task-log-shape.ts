import { sql } from "drizzle-orm";
import { coerceTaskLogArray } from "../../db/db-helpers.js";
import { createLogger } from "../../process/logger.js";
import type { TaskStore } from "../../store.js";

/*
FNXC:TaskLogShape 2026-11-02-19:10 (RUFU-858):
`createLogger` is used directly instead of importing `storeLog` from `store.js`, because `store.ts` is a
VALUE module and this file sits in the async barrel that `store.ts` imports - a value import back would be a
real runtime cycle. `TaskStore` stays a type-only import for the same reason.
*/
const log = createLogger("task-store");

export interface TaskLogShapeRepairResult {
  /** Ids whose `log` was a double-encoded jsonb scalar and is now a real array. */
  repaired: string[];
  /** Ids whose `log` is a non-array jsonb that cannot be proven to be an array - reported, never rewritten. */
  unrepairable: string[];
}

const EMPTY: TaskLogShapeRepairResult = { repaired: [], unrepairable: [] };

/*
FNXC:TaskLogShape 2026-11-02-19:05 (RUFU-858 acceptance 3):
`project.tasks.log` is jsonb whose contract is an array of entries. The write seam now refuses to create a
bad row (see `toJsonArray` in db-helpers.ts), but rows that were already poisoned before that guard keep
breaking READS: store queries select `id, log` across a whole `project_id`, so one jsonb scalar makes every
project-wide read throw. Measured on 2026-11-02 with two such rows: `fn task delete` reported failure after
its own write had committed, and `fn task create` failed having created nothing. Acceptance 3 of the card
asks for a check that NAMES a recurrence instead of rediscovering it through a failing CLI.

Why this runs at store open: the corruption only exists because an older writer could produce it, so the
check must happen before the first project-wide read of the process, and `TaskStore.init` is the only such
point that is PostgreSQL-only (see `SqliteDualPathCleanup` in lifecycle-ops.ts).

Decisions encoded here:
- Scope is THIS store's project. The table is shared across projects and `projectScopeFor` is how every
  other query scopes it, so a project's store-open repairs its own rows and leaves its siblings to theirs.
  A cross-project write from one project's boot would also be executed 24 times over.
- Heal only what can be PROVEN to be an array (`coerceTaskLogArray` unwraps at most two layers). Anything
  else goes into `unrepairable` and is reported untouched - guessing at history is worse than a loud count.
- `updated_at` is deliberately NOT bumped. It is the anchor for dwell, stall and admission-age measurements
  (RUFU-273 measured that an unconditional bump made a sweep retract its own finding), so a storage-shape
  repair must not move the clock the product measures.
- No run-audit emission: this emits nothing rather than emitting an event whose synthetic run id would be
  invented at boot. The durable record is the warn log plus the return value the caller can surface.
*/
export async function repairDoubleEncodedTaskLogsAsync(
  store: TaskStore,
): Promise<TaskLogShapeRepairResult> {
  const layer = store.getAsyncLayer();
  if (!layer) return EMPTY;
  // Same project-scope convention as the sibling maintenance primitives (`async-phantom-reservations.ts`):
  // an unscoped store is the legacy project bucket, NOT "skip the check". Returning early here would leave
  // exactly the rows that break reads unrepaired, and the harness/CLI hosts live in that bucket.
  const projectId = layer.projectId?.trim() || "__legacy_unscoped__";

  const rows = ((await layer.db.execute(sql`
    SELECT id, jsonb_typeof(log) AS shape, log::text AS raw
      FROM project.tasks
     WHERE project_id = ${projectId}
       AND jsonb_typeof(log) IN ('string', 'object', 'number', 'boolean')
  `)) ?? []) as unknown as Array<{ id: string; shape: string; raw: string | null }>;

  const result: TaskLogShapeRepairResult = { repaired: [], unrepairable: [] };
  for (const row of rows) {
    let healed: string | null = null;
    try {
      const entries = coerceTaskLogArray(row.raw);
      if (entries.length > 0) healed = JSON.stringify(entries);
    } catch {
      healed = null;
    }
    if (healed === null) {
      result.unrepairable.push(row.id);
      continue;
    }
    await layer.db.execute(sql`
      UPDATE project.tasks
         SET log = ${healed}::jsonb
       WHERE id = ${row.id}
         AND jsonb_typeof(log) = 'string'
    `);
    result.repaired.push(row.id);
  }

  if (result.repaired.length > 0 || result.unrepairable.length > 0) {
    // Ids and counts only; the poisoned payload itself is never logged.
    log.warn("Task log jsonb shape repair ran during store open", {
      phase: "init:task-log-shape-repair",
      repairedCount: result.repaired.length,
      unrepairableCount: result.unrepairable.length,
      unrepairableIds: result.unrepairable.slice(0, 20),
    });
  }
  return result;
}
