import { DASHBOARD_USER_ID, type MessageStore, type Settings } from "@fusion/core";

export const POSTGRES_MIGRATION_NOTICE_KIND = "postgres-migration-notice";
export const POSTGRES_MIGRATION_COMPLETE_NOTICE_KIND = "postgres-migration-complete";
export const POSTGRES_MIGRATION_HELP_URL = "https://discord.gg/ksrfuy7WYR";

export type PostgresMigrationNoticeResult = "delivered" | "already-delivered" | "version-mismatch" | "no-store";
export type PostgresMigrationCompleteNoticeResult = "delivered" | "already-delivered" | "no-migration" | "no-store";

export interface PostgresMigrationNoticeLog {
  warn(message: string): void;
  log?(message: string): void;
}

export interface DeliverPostgresMigrationNoticeArgs {
  messageStore: MessageStore | undefined;
  version: string | undefined;
  log?: PostgresMigrationNoticeLog;
}

type SqliteMigrationNotice = NonNullable<Settings["sqliteMigrationNotice"]>;

export interface DeliverPostgresMigrationCompleteNoticeArgs {
  messageStore: MessageStore | undefined;
  notice: SqliteMigrationNotice | null | undefined;
  projectId?: string;
  deliveredAt?: string;
  markDelivered?: (deliveredAt: string) => Promise<void>;
  log?: PostgresMigrationNoticeLog;
}

const POSTGRES_MIGRATION_NOTICE_TITLE = "Storage update coming in the next Fusion version";
const POSTGRES_MIGRATION_NOTICE_BODY = "The next Fusion version will replace the current SQLite data store with an embedded Postgres backend for data storage, and project databases will be served from the central Fusion database instead of each project's local .fusion/fusion.db SQLite file. No migration runs from this notice; it is an advance heads-up for operators who rely on the current storage layout.";

/*
FNXC:StorageMigrationNotice 2026-07-12-00:00:
Fusion 0.59.x is the only release line that should deliver the durable Postgres-migration heads-up: it is the first-start announcement window before the storage backend change, while dev/unresolved sentinels and all other versions must stay silent so local source builds and later restarts do not surprise operators.
*/
export function isPostgresMigrationNoticeVersion(version: string | undefined): boolean {
  const trimmed = version?.trim();
  if (!trimmed) return false;

  const match = /^(\d+)\.(\d+)\.(\d+)(?:[+-].*)?$/.exec(trimmed);
  if (!match) return false;

  const major = Number.parseInt(match[1] ?? "", 10);
  const minor = Number.parseInt(match[2] ?? "", 10);
  const patch = Number.parseInt(match[3] ?? "", 10);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return false;
  }

  if (major === 0 && minor === 0 && patch === 0) {
    return false;
  }

  return major === 0 && minor === 59;
}

function buildPostgresMigrationNoticeContent(): string {
  return [
    POSTGRES_MIGRATION_NOTICE_TITLE,
    "",
    POSTGRES_MIGRATION_NOTICE_BODY,
    "",
    `Need help? Join us on Discord: ${POSTGRES_MIGRATION_HELP_URL}`,
  ].join("\n");
}

/*
FNXC:StorageMigrationNotice 2026-07-12-00:00:
The startup notice is per project because each project has its own dashboard mailbox. Idempotency uses the durable system-inbox metadata.kind marker instead of a new settings key or marker table: the mailbox survives engine restarts and is the operator-visible record we are protecting from duplication.

FNXC:StorageMigrationNotice 2026-07-12-00:00:
Delivery is best-effort by design. ProjectEngine.start() must never fail or stall because an informational support message could not be queried or written, so every MessageStore interaction is contained here and downgraded to a warning plus a non-delivered result.
*/
export async function deliverPostgresMigrationNoticeIfNeeded({
  messageStore,
  version,
  log,
}: DeliverPostgresMigrationNoticeArgs): Promise<PostgresMigrationNoticeResult> {
  let fallbackResult: PostgresMigrationNoticeResult = "version-mismatch";

  try {
    if (!messageStore) {
      return "no-store";
    }
    fallbackResult = "no-store";

    if (!isPostgresMigrationNoticeVersion(version)) {
      return "version-mismatch";
    }
    fallbackResult = "already-delivered";

    // FNXC:PostgresCutover 2026-07-12: the MessageStore is async on the
    // PostgreSQL backend — await the inbox read and the send (upstream wrote
    // this against the sync sqlite store).
    const inbox = await messageStore.getInbox(DASHBOARD_USER_ID, "user", { type: "system" });
    if (inbox.some((message) => message.metadata?.kind === POSTGRES_MIGRATION_NOTICE_KIND)) {
      return "already-delivered";
    }

    await messageStore.sendMessage({
      fromType: "system",
      toType: "user",
      toId: DASHBOARD_USER_ID,
      type: "system",
      content: buildPostgresMigrationNoticeContent(),
      metadata: {
        kind: POSTGRES_MIGRATION_NOTICE_KIND,
        version,
        helpUrl: POSTGRES_MIGRATION_HELP_URL,
      },
    });

    log?.log?.("Delivered Postgres migration dashboard inbox notice");
    return "delivered";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log?.warn(`Postgres migration inbox notice delivery failed (continuing startup): ${message}`);
    return fallbackResult;
  }
}

function buildPostgresMigrationCompleteContent(notice: SqliteMigrationNotice): string {
  const backupLines = notice.sqliteBackups.length > 0
    ? notice.sqliteBackups.map((path) => `- ${path}`)
    : ["- No backup paths were recorded."];
  return [
    "SQLite to PostgreSQL migration complete",
    "",
    `Fusion migrated ${notice.migratedRows.toLocaleString("en-US")} rows across ${notice.tables.toLocaleString("en-US")} tables on ${notice.migratedAt}.`,
    "Your original SQLite database files were kept as backups:",
    ...backupLines,
    "",
    `Need help or see anything unexpected? [Get help on Discord](${POSTGRES_MIGRATION_HELP_URL}).`,
  ].join("\n");
}

/*
FNXC:PostgresMigrationInbox 2026-07-14-12:10:
After a successful SQLite cutover, the dashboard user must receive exactly one system inbox message containing the migration timestamp, row/table totals, retained backup paths, and the Fusion Discord help link. A deterministic database primary key atomically arbitrates concurrent delivery, while an independent top-level settings marker remains the durable once-only authority if mailbox retention later prunes the message.

FNXC:PostgresMigrationInbox 2026-07-14-12:10:
Delivery remains best-effort so an informational message can never make a successfully migrated project fail to start. A failed marker write is retried on restart; the atomic message insert reports the existing notice instead of creating a duplicate.
*/
export async function deliverPostgresMigrationCompleteNoticeIfNeeded({
  messageStore,
  notice,
  projectId,
  deliveredAt: durableDeliveredAt,
  markDelivered,
  log,
}: DeliverPostgresMigrationCompleteNoticeArgs): Promise<PostgresMigrationCompleteNoticeResult> {
  try {
    if (!notice) return "no-migration";
    if (durableDeliveredAt) return "already-delivered";
    if (!messageStore) return "no-store";

    const deliveredAt = new Date().toISOString();
    const outcome = await messageStore.sendMessageOnce({
      fromType: "system",
      toType: "user",
      toId: DASHBOARD_USER_ID,
      type: "system",
      content: buildPostgresMigrationCompleteContent(notice),
      metadata: {
        kind: POSTGRES_MIGRATION_COMPLETE_NOTICE_KIND,
        migratedAt: notice.migratedAt,
        migratedRows: notice.migratedRows,
        tables: notice.tables,
        sqliteBackups: notice.sqliteBackups,
        helpUrl: POSTGRES_MIGRATION_HELP_URL,
        deliveredAt,
      },
    }, `${POSTGRES_MIGRATION_COMPLETE_NOTICE_KIND}:${projectId ?? notice.migratedAt}`);
    await markDelivered?.(deliveredAt);
    if (!outcome.inserted) return "already-delivered";
    log?.log?.("Delivered PostgreSQL migration-complete dashboard inbox notice");
    return "delivered";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log?.warn(`PostgreSQL migration-complete inbox notice delivery failed (continuing startup): ${message}`);
    return "already-delivered";
  }
}
