import { definePlugin } from "@fusion/plugin-sdk";
import type { FusionPlugin, PluginContext, PluginRouteDefinition, PluginRouteResponse, PluginSettingSchema } from "@fusion/plugin-sdk";
import { WhatsAppConnection } from "./connection.js";
import { generateReply } from "./reply.js";
import { createWhatsAppPersistence } from "./persistence.js";
export { claimMessage, loadHistory, saveHistory, wasProcessed, markProcessed } from "./persistence.js";
export type { ChatTurn, PluginDb } from "./persistence.js";

const DEFAULT_HISTORY_TURN_LIMIT = 40;
const DEFAULT_DEDUPE_RETENTION_DAYS = 7;

import type { ChatTurn, PluginDb } from "./persistence.js";

const settingsSchema: Record<string, PluginSettingSchema> = {
  pairingMode: {
    type: "enum",
    label: "Pairing Mode",
    enumValues: ["qr", "code"],
    defaultValue: "qr",
  },
  pairingPhoneNumber: {
    type: "string",
    label: "Pairing Phone Number",
    description: "E.164 digits without + (required when pairingMode is code)",
  },
  allowedSenders: { type: "array", label: "Allowed WhatsApp Senders", itemType: "string" },
  agentSystemPrompt: {
    type: "string",
    label: "Agent System Prompt",
    multiline: true,
    defaultValue: "You are a helpful assistant replying in WhatsApp chats.",
  },
  historyTurnLimit: {
    type: "number",
    label: "History Turn Limit",
    defaultValue: DEFAULT_HISTORY_TURN_LIMIT,
  },
  dedupeRetentionDays: {
    type: "number",
    label: "Dedupe Retention (days)",
    description: "How long inbound message IDs are kept for replay protection. Older rows are pruned on each inbound message.",
    defaultValue: DEFAULT_DEDUPE_RETENTION_DAYS,
  },
};

const connections = new Map<string, WhatsAppConnection>();

function getConnectionKey(ctx: PluginContext): string {
  return `${ctx.taskStore.getRootDir()}::${ctx.pluginId}`;
}

export function getSettingString(settings: Record<string, unknown>, key: string): string | undefined {
  const value = settings[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function getAllowedSenders(settings: Record<string, unknown>): Set<string> {
  const senders = settings.allowedSenders;
  if (!Array.isArray(senders)) return new Set<string>();
  return new Set(senders.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim()));
}

export function getHistoryTurnLimit(settings: Record<string, unknown>): number {
  const value = settings.historyTurnLimit;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_HISTORY_TURN_LIMIT;
  }
  return Math.floor(value);
}

export function getDedupeRetentionDays(settings: Record<string, unknown>): number {
  const value = settings.dedupeRetentionDays;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_DEDUPE_RETENTION_DAYS;
  }
  return Math.floor(value);
}

export function splitMessageForWhatsapp(text: string): string[] {
  return WhatsAppConnection.splitMessageForWhatsapp(text);
}

export function ensureSchema(db: PluginDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS whatsapp_chat_sessions (
      sender TEXT PRIMARY KEY,
      history TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS whatsapp_chat_dedupe (
      messageId TEXT PRIMARY KEY,
      sender TEXT NOT NULL,
      receivedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS whatsapp_auth_creds (
      id TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS whatsapp_auth_keys (
      category TEXT NOT NULL,
      keyId TEXT NOT NULL,
      value TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      PRIMARY KEY (category, keyId)
    );
  `);
}

function getConnectionOrResponse(ctx: PluginContext): { connection?: WhatsAppConnection; error?: PluginRouteResponse } {
  const connection = connections.get(getConnectionKey(ctx));
  if (!connection) {
    return { error: { status: 503, body: { error: "WhatsApp connection is not initialized" } } };
  }
  return { connection };
}

const routes: PluginRouteDefinition[] = [
  {
    method: "GET",
    path: "/status",
    handler: async (_req, ctx) => {
      const { connection, error } = getConnectionOrResponse(ctx);
      if (!connection) return error as PluginRouteResponse;
      const status = connection.getStatus();
      return {
        status: 200,
        body: {
          status: status.state,
          jid: status.jid,
          allowedSenders: Array.from(getAllowedSenders(ctx.settings)),
        },
      };
    },
  },
  {
    method: "GET",
    path: "/qr",
    handler: async (_req, ctx) => {
      const { connection, error } = getConnectionOrResponse(ctx);
      if (!connection) return error as PluginRouteResponse;
      const status = connection.getStatus();
      if (status.state !== "awaiting-qr" || !status.qrDataUrl || !status.qr) {
        return { status: 409, body: { error: "QR is not currently available" } };
      }
      return { status: 200, body: { qrDataUrl: status.qrDataUrl, qr: status.qr } };
    },
  },
  {
    method: "POST",
    path: "/pair-code",
    handler: async (req, ctx) => {
      const { connection, error } = getConnectionOrResponse(ctx);
      if (!connection) return error as PluginRouteResponse;
      const body = (req as { body?: { phoneNumber?: unknown } })?.body;
      const phoneNumber = typeof body?.phoneNumber === "string" ? body.phoneNumber.trim() : "";
      if (!phoneNumber) {
        return { status: 400, body: { error: "phoneNumber is required" } };
      }
      const pairingCode = await connection.requestPairingCode(phoneNumber);
      return { status: 200, body: { pairingCode } };
    },
  },
  {
    method: "POST",
    path: "/logout",
    handler: async (_req, ctx) => {
      const { connection, error } = getConnectionOrResponse(ctx);
      if (!connection) return error as PluginRouteResponse;
      await connection.logout();
      return { status: 200, body: { ok: true } };
    },
  },
];

const plugin: FusionPlugin = definePlugin({
  manifest: {
    id: "fusion-plugin-whatsapp-chat",
    name: "WhatsApp Chat",
    version: "0.1.0",
    description: "WhatsApp Web (multi-device) bridge that pairs via QR/code and forwards messages to Fusion AI",
    author: "Fusion Team",
    settingsSchema,
  },
  state: "installed",
  routes,
  hooks: {
    onSchemaInit: (db) => {
      ensureSchema(db as PluginDb);
    },
    onLoad: async (ctx) => {
      const persistence = createWhatsAppPersistence(ctx);
      const connection = new WhatsAppConnection(ctx, plugin.manifest.version, generateReply, persistence);
      connections.set(getConnectionKey(ctx), connection);
      await connection.start();
    },
    onUnload: async (ctx) => {
      const connectionKey = getConnectionKey(ctx);
      const connection = connections.get(connectionKey);
      if (!connection) return;
      await connection.stop();
      connections.delete(connectionKey);
    },
  },
});

export default plugin;
