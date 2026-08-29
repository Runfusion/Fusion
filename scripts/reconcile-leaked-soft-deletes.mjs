#!/usr/bin/env node
/*
FNXC:PostgresCutover 2026-07-05-13:00:
Ported from direct node:sqlite access on .fusion/fusion.db to the PostgreSQL
backend (scripts/lib/backend-db.mjs). The planning logic is pure
(planReconcileLeakedSoftDeletes) so tests exercise it with plain row arrays;
only the thin apply step touches PostgreSQL. Behavior preserved from FN-5175:
soft-deleted rows leaked outside 'archived' are moved to 'archived' with a
run-audit event per repaired row.
*/
import process from "node:process";
import { openBackend, rowsOf } from "./lib/backend-db.mjs";

export function parseArgs(argv = process.argv.slice(2)) {
  const args = [...argv];
  let projectRoot = process.cwd();

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--project-root" && args[i + 1]) {
      projectRoot = args[i + 1];
      i += 1;
    }
  }

  return {
    apply: args.includes("--apply"),
    dryRun: !args.includes("--apply"),
    projectRoot,
  };
}

/**
 * Pure planning step: given task rows ({ id, column, status, deletedAt }),
 * report the leaked soft-deletes (deletedAt set but column != 'archived').
 */
/*
FNXC:OperatorScriptLaneAssumptions 2026-07-30-23:50:
`archivedLanes` is the board's OWN archived vocabulary, and it decides what counts as "leaked".

Keyed on the literal, this filter calls a soft-deleted row leaked whenever its column is not the
string `archived` — so on a board whose archived lane is named anything else EVERY soft-deleted row
looks leaked, and `--apply` then rewrites all of them. The repair is the damage: see the write step.

A row already resting in ANY of the board's archived lanes is not leaked, which is why the filter
takes the SET rather than a single id. The WRITE resolves per task instead — see `reconcileLeakedSoftDeletes`.
*/
export function planReconcileLeakedSoftDeletes(rows, { runId = `synthetic-reconcile-fn-5175-${Date.now()}`, archivedLanes } = {}) {
  /* DELIBERATE-LITERAL — the degraded default when the caller resolved no lanes. */
  const isArchivedLane = (column) => (archivedLanes ? archivedLanes.has(column) : column === "archived");
  const findings = rows
    .filter((row) => row.deletedAt != null && !isArchivedLane(row.column))
    .map((row) => ({ id: row.id, column: row.column, status: row.status ?? null, deletedAt: row.deletedAt }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    rowsScanned: rows.length,
    rowsUpdated: 0,
    auditRowsInserted: 0,
    runId,
    findings,
  };
}

/*
FNXC:OperatorScriptLaneAssumptions 2026-07-30-23:50:
The repair writes each task's OWN archived lane, and REFUSES to guess when it cannot resolve one.

This wrote the literal: `UPDATE project."tasks" SET "column" = 'archived'`. On a board that does not
declare `archived` that is not a mislabel — it parks the row in a column the workflow does not have,
manufacturing exactly the undeclared-column state this migration keeps repairing elsewhere, and it
did so under `--apply` against an operator's live database.

The SQL pre-filter went with it. It carried the same literal (`AND "column" != 'archived'`), so the
query and the planner each imposed the legacy vocabulary and fixing only one would leave the other
silently deciding. Soft-deleted rows are a small set, so selecting them all and filtering in the
planner costs nothing and leaves ONE place that decides what "archived" means.

A row whose own archived lane cannot be resolved is SKIPPED and reported, never written with a
guessed id. A recovery script that declines to act on the rows it does not understand is recoverable;
one that writes a plausible wrong value is not.

Verified rather than assumed: a store that answers nothing resolves to the default lifecycle
(`archived: "archived"`), so a legacy board still repairs exactly as before.
*/
export async function reconcileLeakedSoftDeletes({ backend, dryRun = true, runId }) {
  const { core, store, asyncLayer, sql } = backend;
  const rows = rowsOf(
    await asyncLayer.db.execute(sql`
      SELECT id, "column", status, deleted_at AS "deletedAt"
      FROM project."tasks"
      WHERE deleted_at IS NOT NULL
      ORDER BY id
    `),
  );
  const allCount = rowsOf(
    await asyncLayer.db.execute(sql`SELECT count(*)::int AS count FROM project."tasks"`),
  )[0]?.count ?? rows.length;

  const archivedLanes = store && core.resolveArchivedLanes ? await core.resolveArchivedLanes(store) : undefined;
  const summary = planReconcileLeakedSoftDeletes(rows, { ...(runId ? { runId } : {}), archivedLanes });
  summary.skipped = [];
  summary.rowsScanned = allCount;

  if (dryRun || summary.findings.length === 0) {
    return summary;
  }

  await asyncLayer.transactionImmediate(async (tx) => {
    const irCache = new Map();
    for (const row of summary.findings) {
      const target = (await core.resolveTaskLifecycleColumns(store, row.id, irCache))?.archived;
      if (!target) {
        /* Reported, not guessed — see the header. */
        summary.skipped.push({ id: row.id, column: row.column, reason: "unresolved-archived-lane" });
        continue;
      }
      await tx.execute(sql`UPDATE project."tasks" SET "column" = ${target} WHERE id = ${row.id}`);
      await core.recordRunAuditEventWithinTransaction(tx, {
        taskId: row.id,
        agentId: "system",
        runId: summary.runId,
        domain: "database",
        mutationType: "task:soft-delete-column-reconcile",
        target: row.id,
        metadata: {
          previousColumn: row.column,
          previousStatus: row.status ?? null,
          source: "FN-5175 reconcile",
        },
      });
      summary.rowsUpdated += 1;
      summary.auditRowsInserted += 1;
    }
  });

  return summary;
}

export function formatSummary(summary, dryRun) {
  const lines = [
    dryRun ? "Mode: DRY RUN" : "Mode: APPLY",
    "id\tcolumn\tstatus\tdeletedAt",
    ...summary.findings.map((row) => `${row.id}\t${row.column}\t${row.status ?? "NULL"}\t${row.deletedAt}`),
    `Rows scanned: ${summary.rowsScanned}`,
    `Rows updated: ${summary.rowsUpdated}`,
    `Audit rows inserted: ${summary.auditRowsInserted}`,
    ...(summary.skipped?.length
      ? [`Skipped (no resolvable archived lane): ${summary.skipped.map((row) => row.id).join(", ")}`]
      : []),
  ];
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const { dryRun, projectRoot } = parseArgs(argv);
  const backend = await openBackend(projectRoot);

  try {
    const summary = await reconcileLeakedSoftDeletes({ backend, dryRun });
    console.log(formatSummary(summary, dryRun));
    return summary;
  } finally {
    await backend.shutdown().catch(() => {});
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
