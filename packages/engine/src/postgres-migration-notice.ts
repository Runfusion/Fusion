import { DASHBOARD_USER_ID, type MessageStore } from "@fusion/core";

export const POSTGRES_MIGRATION_NOTICE_KIND = "postgres-migration-notice";
export const POSTGRES_MIGRATION_HELP_URL = "https://discord.gg/ksrfuy7WYR";

export type PostgresMigrationNoticeResult = "delivered" | "already-delivered" | "version-mismatch" | "no-store";

export interface PostgresMigrationNoticeLog {
  warn(message: string): void;
  log?(message: string): void;
}

export interface DeliverPostgresMigrationNoticeArgs {
  messageStore: MessageStore | undefined;
  version: string | undefined;
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
