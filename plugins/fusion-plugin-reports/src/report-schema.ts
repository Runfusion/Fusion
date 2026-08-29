import type { Database } from "@fusion/core";

function addColumnIfMissing(db: Database, table: string, column: string, ddl: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((entry) => entry.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  return true;
}

export function ensureReportSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      cadence TEXT NOT NULL CHECK (cadence IN ('daily','weekly','monthly','quarterly','manual')),
      periodStart TEXT NOT NULL,
      periodEnd TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('generating','review_pending','review_in_progress','review_complete','approved','published','archived','failed')),
      generationStartedAt TEXT NOT NULL,
      generationCompletedAt TEXT,
      reviewStartedAt TEXT,
      reviewCompletedAt TEXT,
      approvedAt TEXT,
      approvedBy TEXT,
      publishedAt TEXT,
      archivedAt TEXT,
      failureReason TEXT,
      approval_state TEXT NOT NULL DEFAULT 'not_required',
      approval_history TEXT NOT NULL DEFAULT '[]',
      draftMarkdown TEXT,
      renderedHtmlPath TEXT,
      rendered_html TEXT,
      rendered_html_generated_at TEXT,
      metadataJson TEXT NOT NULL DEFAULT '{}',
      combinedReviewJson TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idxReportsCadenceCreated
      ON reports(cadence, createdAt DESC, id);

    CREATE INDEX IF NOT EXISTS idxReportsStatusUpdated
      ON reports(status, updatedAt DESC, id);

    CREATE INDEX IF NOT EXISTS idxReportsPeriod
      ON reports(periodStart, periodEnd, id);
  `);

  addColumnIfMissing(db, "reports", "rendered_html", "TEXT");
  addColumnIfMissing(db, "reports", "rendered_html_generated_at", "TEXT");
  addColumnIfMissing(db, "reports", "approval_state", "TEXT NOT NULL DEFAULT 'not_required'");
  addColumnIfMissing(db, "reports", "approval_history", "TEXT NOT NULL DEFAULT '[]'");

  db.exec(`
    UPDATE reports
    SET approval_state = 'published',
        publishedAt = COALESCE(publishedAt, generationCompletedAt)
    WHERE status = 'published';

    UPDATE reports
    SET approval_state = 'published'
    WHERE status = 'approved';

    UPDATE reports
    SET approval_state = 'not_required'
    WHERE status = 'review_complete';
  `);
}
