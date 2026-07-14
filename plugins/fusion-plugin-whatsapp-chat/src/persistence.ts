import type { PluginContext } from "@fusion/plugin-sdk";
import { sql } from "drizzle-orm";

export type ChatTurn = { role: "user" | "assistant"; text: string; createdAt: string };
export type PluginDb = {
  exec(sql: string): void;
  prepare(sql: string): { get(...args: unknown[]): unknown; run(...args: unknown[]): unknown };
};

const DAY_MS = 86_400_000;

export interface WhatsAppPersistence {
  loadHistory(sender: string): Promise<ChatTurn[]>;
  appendHistory(sender: string, turns: ChatTurn[], turnLimit: number): Promise<void>;
  wasProcessed(messageId: string): Promise<boolean>;
  markProcessed(messageId: string, sender: string, retentionDays: number): Promise<void>;
  claimMessage(messageId: string, sender: string, retentionDays: number): Promise<boolean>;
  loadCredentials(): Promise<string | null>;
  saveCredentials(value: string): Promise<void>;
  loadAuthKeys(category: string, ids: string[]): Promise<Record<string, string>>;
  writeAuthKeys(category: string, values: Record<string, string | null>): Promise<void>;
  clearAuthState(): Promise<void>;
}

function parseHistory(raw: string | null | undefined): ChatTurn[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value as ChatTurn[] : [];
  } catch {
    return [];
  }
}

export function loadHistory(db: PluginDb, sender: string): ChatTurn[] {
  const row = db.prepare("SELECT history FROM whatsapp_chat_sessions WHERE sender = ?").get(sender) as { history?: string } | undefined;
  return parseHistory(row?.history);
}

export function saveHistory(db: PluginDb, sender: string, history: ChatTurn[]): void {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO whatsapp_chat_sessions(sender, history, updatedAt) VALUES(?, ?, ?)
    ON CONFLICT(sender) DO UPDATE SET history = excluded.history, updatedAt = excluded.updatedAt`)
    .run(sender, JSON.stringify(history), now);
}

function withImmediateTransaction<T>(db: PluginDb, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * FNXC:WhatsAppConcurrentHistory 2026-07-14-00:42:
 * Concurrent deliveries from one sender must append complete user/assistant turns instead of replacing a stale history snapshot. Keep the read, bounded append, and write in one immediate transaction; the connection also serializes reply generation per sender so each reply observes every earlier delivered turn.
 */
export function appendHistory(
  db: PluginDb,
  sender: string,
  turns: ChatTurn[],
  turnLimit: number,
): void {
  withImmediateTransaction(db, () => {
    const history = [...loadHistory(db, sender), ...turns].slice(-turnLimit);
    saveHistory(db, sender, history);
  });
}

export function wasProcessed(db: PluginDb, messageId: string): boolean {
  return Boolean(db.prepare("SELECT 1 as found FROM whatsapp_chat_dedupe WHERE messageId = ?").get(messageId));
}

export function markProcessed(db: PluginDb, messageId: string, sender: string, retentionDays = 7): void {
  claimMessage(db, messageId, sender, retentionDays);
}

/**
 * FNXC:WhatsAppReplayClaim 2026-07-13-23:40:
 * Duplicate deliveries can reach concurrent EventEmitter callbacks. Claim a message with one uniqueness-enforced insert and process it only when that insert wins; a separate read followed by insert permits both callbacks to generate and send a reply.
 */
export function claimMessage(
  db: PluginDb,
  messageId: string,
  sender: string,
  retentionDays = 7,
): boolean {
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - retentionDays * DAY_MS).toISOString();
  db.prepare("DELETE FROM whatsapp_chat_dedupe WHERE receivedAt < ?").run(cutoff);
  const result = db
    .prepare("INSERT OR IGNORE INTO whatsapp_chat_dedupe(messageId, sender, receivedAt) VALUES(?, ?, ?)")
    .run(messageId, sender, now) as { changes?: number };
  return Number(result.changes ?? 0) === 1;
}

export function createSqliteWhatsAppPersistence(db: PluginDb): WhatsAppPersistence {
  return {
    async loadHistory(sender) {
      return loadHistory(db, sender);
    },
    async appendHistory(sender, turns, turnLimit) {
      appendHistory(db, sender, turns, turnLimit);
    },
    async wasProcessed(messageId) {
      return wasProcessed(db, messageId);
    },
    async markProcessed(messageId, sender, retentionDays) {
      markProcessed(db, messageId, sender, retentionDays);
    },
    async claimMessage(messageId, sender, retentionDays) {
      return claimMessage(db, messageId, sender, retentionDays);
    },
    async loadCredentials() {
      const row = db.prepare("SELECT value FROM whatsapp_auth_creds WHERE id = 'creds'").get() as { value?: string } | undefined;
      return row?.value ?? null;
    },
    async saveCredentials(value) {
      db.prepare(`INSERT INTO whatsapp_auth_creds(id, value, updatedAt) VALUES('creds', ?, ?)
        ON CONFLICT(id) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`)
        .run(value, new Date().toISOString());
    },
    async loadAuthKeys(category, ids) {
      const result: Record<string, string> = {};
      const select = db.prepare("SELECT value FROM whatsapp_auth_keys WHERE category = ? AND keyId = ?");
      for (const id of ids) {
        const row = select.get(category, id) as { value?: string } | undefined;
        if (row?.value !== undefined) result[id] = row.value;
      }
      return result;
    },
    async writeAuthKeys(category, values) {
      /**
       * FNXC:WhatsAppAuthKeyAtomicity 2026-07-14-00:42:
       * A Baileys Signal-key update is one logical batch. Commit every delete/upsert together so a failed statement cannot leave a partially rotated key set that is unusable on the next connection.
       */
      withImmediateTransaction(db, () => {
        const upsert = db.prepare(`INSERT INTO whatsapp_auth_keys(category, keyId, value, updatedAt) VALUES(?, ?, ?, ?)
          ON CONFLICT(category, keyId) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`);
        const remove = db.prepare("DELETE FROM whatsapp_auth_keys WHERE category = ? AND keyId = ?");
        const now = new Date().toISOString();
        for (const [id, value] of Object.entries(values)) {
          if (value === null) remove.run(category, id);
          else upsert.run(category, id, value, now);
        }
      });
    },
    async clearAuthState() {
      /**
       * FNXC:WhatsAppAuthStateAtomicity 2026-07-14-00:54:
       * Credentials and Signal keys form one authentication state. Clear both in one immediate transaction so a failed or interrupted second delete cannot persist credentials without their matching keys, or vice versa.
       */
      withImmediateTransaction(db, () => {
        db.prepare("DELETE FROM whatsapp_auth_creds").run();
        db.prepare("DELETE FROM whatsapp_auth_keys").run();
      });
    },
  };
}

/**
 * FNXC:WhatsAppPostgresPersistence 2026-07-13-22:37:
 * Backend-mode WhatsApp state must use the bound AsyncDataLayer instead of reaching through PluginStore for its former private SQLite database. Every statement includes project_id because bundled plugins from all projects share the same project schema.
 */
export function createWhatsAppPersistence(ctx: PluginContext): WhatsAppPersistence {
  const layer = typeof ctx.taskStore.getAsyncLayer === "function" ? ctx.taskStore.getAsyncLayer() : null;
  if (!layer) {
    const pluginStore = ctx.taskStore.getPluginStore();
    const db = (pluginStore as unknown as { db?: PluginDb }).db;
    if (!db) throw new Error("Plugin database unavailable");
    return createSqliteWhatsAppPersistence(db);
  }

  const projectId = layer.projectId;
  if (!projectId) throw new Error("WhatsApp PostgreSQL persistence requires a project-bound data layer");
  const db = layer.db;

  return {
    async loadHistory(sender) {
      const rows = await db.execute(sql`SELECT history FROM project.whatsapp_chat_sessions
        WHERE project_id = ${projectId} AND sender = ${sender} LIMIT 1`) as unknown as Array<{ history: string }>;
      return parseHistory(rows[0]?.history);
    },
    async appendHistory(sender, turns, turnLimit) {
      const now = new Date().toISOString();
      await layer.transactionImmediate(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${projectId}:${sender}`}, 0))`);
        const rows = await tx.execute(sql`SELECT history FROM project.whatsapp_chat_sessions
          WHERE project_id = ${projectId} AND sender = ${sender} LIMIT 1`) as unknown as Array<{ history: string }>;
        const history = [...parseHistory(rows[0]?.history), ...turns].slice(-turnLimit);
        await tx.execute(sql`INSERT INTO project.whatsapp_chat_sessions(project_id, sender, history, updated_at)
          VALUES(${projectId}, ${sender}, ${JSON.stringify(history)}, ${now})
          ON CONFLICT(project_id, sender) DO UPDATE SET history = excluded.history, updated_at = excluded.updated_at`);
      });
    },
    async wasProcessed(messageId) {
      const rows = await db.execute(sql`SELECT 1 AS found FROM project.whatsapp_chat_dedupe
        WHERE project_id = ${projectId} AND message_id = ${messageId} LIMIT 1`) as unknown as unknown[];
      return rows.length > 0;
    },
    async markProcessed(messageId, sender, retentionDays) {
      const now = new Date().toISOString();
      const cutoff = new Date(Date.now() - retentionDays * DAY_MS).toISOString();
      await layer.transactionImmediate(async (tx) => {
        await tx.execute(sql`DELETE FROM project.whatsapp_chat_dedupe WHERE project_id = ${projectId} AND received_at < ${cutoff}`);
        await tx.execute(sql`INSERT INTO project.whatsapp_chat_dedupe(project_id, message_id, sender, received_at)
          VALUES(${projectId}, ${messageId}, ${sender}, ${now}) ON CONFLICT(project_id, message_id) DO NOTHING`);
      });
    },
    async claimMessage(messageId, sender, retentionDays) {
      const now = new Date().toISOString();
      const cutoff = new Date(Date.now() - retentionDays * DAY_MS).toISOString();
      return layer.transactionImmediate(async (tx) => {
        await tx.execute(sql`DELETE FROM project.whatsapp_chat_dedupe
          WHERE project_id = ${projectId} AND received_at < ${cutoff}`);
        const claimed = await tx.execute(sql`INSERT INTO project.whatsapp_chat_dedupe(project_id, message_id, sender, received_at)
          VALUES(${projectId}, ${messageId}, ${sender}, ${now})
          ON CONFLICT(project_id, message_id) DO NOTHING
          RETURNING message_id`) as unknown as Array<{ message_id: string }>;
        return claimed.length === 1;
      });
    },
    async loadCredentials() {
      const rows = await db.execute(sql`SELECT value FROM project.whatsapp_auth_creds
        WHERE project_id = ${projectId} AND id = 'creds' LIMIT 1`) as unknown as Array<{ value: string }>;
      return rows[0]?.value ?? null;
    },
    async saveCredentials(value) {
      const now = new Date().toISOString();
      await db.execute(sql`INSERT INTO project.whatsapp_auth_creds(project_id, id, value, updated_at)
        VALUES(${projectId}, 'creds', ${value}, ${now}) ON CONFLICT(project_id, id)
        DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
    },
    async loadAuthKeys(category, ids) {
      if (ids.length === 0) return {};
      const result: Record<string, string> = {};
      const rows = await db.execute(sql`SELECT key_id, value FROM project.whatsapp_auth_keys
        WHERE project_id = ${projectId} AND category = ${category} AND key_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`) as unknown as Array<{ key_id: string; value: string }>;
      for (const row of rows) result[row.key_id] = row.value;
      return result;
    },
    async writeAuthKeys(category, values) {
      const now = new Date().toISOString();
      const removals = Object.entries(values).filter(([, value]) => value === null).map(([id]) => id);
      const upserts = Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== null);
      await layer.transactionImmediate(async (tx) => {
        if (removals.length > 0) {
          await tx.execute(sql`DELETE FROM project.whatsapp_auth_keys WHERE project_id = ${projectId} AND category = ${category}
            AND key_id IN (${sql.join(removals.map((id) => sql`${id}`), sql`, `)})`);
        }
        if (upserts.length > 0) {
          const rows = upserts.map(([id, value]) => sql`(${projectId}, ${category}, ${id}, ${value}, ${now})`);
          await tx.execute(sql`INSERT INTO project.whatsapp_auth_keys(project_id, category, key_id, value, updated_at)
            VALUES ${sql.join(rows, sql`, `)} ON CONFLICT(project_id, category, key_id)
            DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
        }
      });
    },
    async clearAuthState() {
      await layer.transactionImmediate(async (tx) => {
        await tx.execute(sql`DELETE FROM project.whatsapp_auth_creds WHERE project_id = ${projectId}`);
        await tx.execute(sql`DELETE FROM project.whatsapp_auth_keys WHERE project_id = ${projectId}`);
      });
    },
  };
}
