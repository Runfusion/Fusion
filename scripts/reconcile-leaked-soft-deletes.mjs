#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export function parseArgs(argv = process.argv.slice(2)) {
  const args = [...argv];
  let dbPath = ".fusion/fusion.db";

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--db" && args[i + 1]) {
      dbPath = args[i + 1];
      i += 1;
    }
  }

  return {
    apply: args.includes("--apply"),
    dryRun: !args.includes("--apply"),
    dbPath,
  };
}

export function findLeakedSoftDeletes(db) {
  return db.prepare(`
    SELECT id, "column", status, deletedAt
    FROM tasks
    WHERE deletedAt IS NOT NULL AND "column" != 'archived'
    ORDER BY id
  `).all();
}

export function reconcileLeakedSoftDeletes({ db, dryRun = true, runId = `synthetic-reconcile-fn-5175-${Date.now()}` }) {
  const rows = findLeakedSoftDeletes(db);
  const summary = {
    rowsScanned: rows.length,
    rowsUpdated: 0,
    auditRowsInserted: 0,
    runId,
    findings: rows.map((row) => ({ ...row, status: row.status ?? null })),
  };

  if (dryRun || rows.length === 0) {
    return summary;
  }

  const now = new Date().toISOString();
  const updateTask = db.prepare(`UPDATE tasks SET "column" = 'archived' WHERE id = ?`);
  const insertAudit = db.prepare(`
    INSERT INTO runAuditEvents (
      id, timestamp, taskId, agentId, runId, domain, mutationType, target, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) {
      updateTask.run(row.id);
      insertAudit.run(
        randomUUID(),
        now,
        row.id,
        "system",
        runId,
        "database",
        "task:soft-delete-column-reconcile",
        row.id,
        JSON.stringify({
          previousColumn: row.column,
          previousStatus: row.status ?? null,
          source: "FN-5175 reconcile",
        }),
      );
      summary.rowsUpdated += 1;
      summary.auditRowsInserted += 1;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

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
  ];
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const { dryRun, dbPath } = parseArgs(argv);
  const resolvedDbPath = path.resolve(dbPath);
  const db = new DatabaseSync(resolvedDbPath);

  try {
    const summary = reconcileLeakedSoftDeletes({ db, dryRun });
    console.log(formatSummary(summary, dryRun));
    return summary;
  } finally {
    db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
