import type { PluginContext } from "@fusion/plugin-sdk";
import { sql } from "drizzle-orm";

export type ChatTurn = { role: "user" | "assistant"; text: string; createdAt: string };
export type AuthKeyBatch = Record<string, Record<string, string | null>>;

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
  writeAuthKeys(batch: AuthKeyBatch): Promise<void>;
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

/**
 * FNXC:WhatsAppPostgresPersistence 2026-07-14-18:05:
 * WhatsApp runtime and Baileys auth state require the TaskStore's project-bound AsyncDataLayer. There is no PluginStore/private-database or SQLite compatibility branch: unavailable or unbound PostgreSQL state fails before the connection starts, and every statement includes project_id because all projects share this schema.
 */
export function createWhatsAppPersistence(ctx: PluginContext): WhatsAppPersistence {
  const layer = typeof ctx.taskStore.getAsyncLayer === "function" ? ctx.taskStore.getAsyncLayer() : null;
  if (!layer) throw new Error("WhatsApp plugin requires a PostgreSQL AsyncDataLayer");
  const projectId = layer.projectId?.trim();
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
    async writeAuthKeys(batch) {
      const now = new Date().toISOString();
      await layer.transactionImmediate(async (tx) => {
        for (const [category, values] of Object.entries(batch)) {
          const removals = Object.entries(values).filter(([, value]) => value === null).map(([id]) => id);
          const upserts = Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== null);
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
