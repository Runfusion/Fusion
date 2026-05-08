import { DisconnectReason, makeWASocket, type ConnectionState, type WAMessage, type WAMessageContent, type WASocket } from "@whiskeysockets/baileys";
import type { PluginContext } from "@fusion/plugin-sdk";
import pino from "pino";
import qrcode from "qrcode";
import { clearAuthState, createPluginDbAuthState } from "./auth-state.js";
import { getAllowedSenders, getHistoryTurnLimit, loadHistory, markProcessed, saveHistory, wasProcessed, type ChatTurn, type PluginDb } from "./index.js";

export type ConnectionStatus = {
  state: "starting" | "awaiting-qr" | "awaiting-code" | "connected" | "disconnected" | "error";
  qr?: string;
  qrDataUrl?: string;
  pairingCode?: string;
  lastError?: string;
  jid?: string;
};

export type ReplyGenerator = (ctx: PluginContext, sender: string, text: string, history: ChatTurn[]) => Promise<string>;

const BACKOFF_MS = [1000, 2000, 5000, 15000, 30000];
const FALLBACK_TEXT = "Sorry, I hit an internal error while processing that message.";
const MAX_WHATSAPP_MESSAGE_CHARS = 4096;

function extractText(message?: WAMessageContent | null): string | null {
  const text = message?.conversation ?? message?.extendedTextMessage?.text;
  if (!text || !text.trim()) return null;
  return text.trim();
}

function normalizeSender(jid: string): string {
  return jid.split("@")[0]?.replace(/\D+/g, "") ?? "";
}

function isLoggedOutDisconnect(error: unknown): boolean {
  const statusCode = (error as { output?: { statusCode?: unknown } })?.output?.statusCode;
  return statusCode === DisconnectReason.loggedOut;
}

function splitMessageForWhatsapp(text: string): string[] {
  if (text.length <= MAX_WHATSAPP_MESSAGE_CHARS) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_WHATSAPP_MESSAGE_CHARS) {
      chunks.push(remaining);
      break;
    }
    const candidate = remaining.slice(0, MAX_WHATSAPP_MESSAGE_CHARS);
    const splitAt = Math.max(candidate.lastIndexOf("\n"), candidate.lastIndexOf(" "));
    const breakpoint = splitAt > 0 ? splitAt : MAX_WHATSAPP_MESSAGE_CHARS;
    chunks.push(remaining.slice(0, breakpoint).trim());
    remaining = remaining.slice(breakpoint).trimStart();
  }

  return chunks.filter(Boolean);
}

export class WhatsAppConnection {
  private sock: WASocket | null = null;
  private status: ConnectionStatus = { state: "disconnected" };
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private stopped = true;
  private authState: ReturnType<typeof createPluginDbAuthState>;

  public constructor(
    private readonly ctx: PluginContext,
    private readonly fusionVersion: string,
    private readonly generateReply: ReplyGenerator,
    private readonly db: PluginDb,
  ) {
    this.authState = createPluginDbAuthState(this.db);
  }

  public async start(): Promise<void> {
    this.stopped = false;
    this.status = { state: "starting" };
    await this.connect();
  }

  public async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.clearReconnectTimer();

    const socket = this.sock;
    this.sock = null;
    this.status = { state: "disconnected" };

    if (socket) {
      socket.ev.off("creds.update", this.authState.saveCreds);
      socket.ev.off("connection.update", this.onConnectionUpdate);
      socket.ev.off("messages.upsert", this.onMessagesUpsert);
      await socket.end(undefined);
    }
  }

  public getStatus(): ConnectionStatus {
    return { ...this.status };
  }

  public async requestPairingCode(phoneNumberE164: string): Promise<string> {
    if (!this.sock) throw new Error("WhatsApp socket not initialized");
    const pairingCode = await this.sock.requestPairingCode(phoneNumberE164);
    this.status = { ...this.status, state: "awaiting-code", pairingCode };
    return pairingCode;
  }

  public async logout(): Promise<void> {
    try {
      await this.sock?.logout();
    } finally {
      clearAuthState(this.db);
      this.authState = createPluginDbAuthState(this.db);
      this.status = { state: "disconnected" };
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;

    this.status = { state: "starting" };
    const socket = makeWASocket({
      auth: this.authState.state,
      printQRInTerminal: false,
      browser: ["Fusion", "Chrome", this.fusionVersion],
      logger: pino({ level: "silent" }),
    });

    this.sock = socket;
    socket.ev.on("creds.update", this.authState.saveCreds);
    socket.ev.on("connection.update", this.onConnectionUpdate);
    socket.ev.on("messages.upsert", this.onMessagesUpsert);
  }

  private readonly onConnectionUpdate = async (update: Partial<ConnectionState>): Promise<void> => {
    if (update.qr) {
      const qrDataUrl = await qrcode.toDataURL(update.qr);
      this.ctx.logger.info("WhatsApp pairing QR updated", update.qr);
      this.status = { state: "awaiting-qr", qr: update.qr, qrDataUrl };
    }

    if (update.connection === "open") {
      this.reconnectAttempt = 0;
      this.status = { state: "connected", jid: this.sock?.user?.id };
      return;
    }

    if (update.connection === "close") {
      if (isLoggedOutDisconnect(update.lastDisconnect?.error)) {
        clearAuthState(this.db);
        this.authState = createPluginDbAuthState(this.db);
        this.status = { state: "disconnected", lastError: "loggedOut" };
        return;
      }

      const closeError = update.lastDisconnect?.error;
      this.status = {
        state: "disconnected",
        lastError: closeError instanceof Error ? closeError.message : "connection closed",
      };
      this.scheduleReconnect();
    }
  };

  private readonly onMessagesUpsert = async (upsert: { type?: string; messages?: WAMessage[] }): Promise<void> => {
    if (upsert.type !== "notify") return;

    for (const message of upsert.messages ?? []) {
      const jid = message.key.remoteJid;
      const messageId = message.key.id;
      if (!jid || !messageId) continue;
      if (jid.endsWith("@g.us") || jid.endsWith("@broadcast") || jid === "status@broadcast") continue;
      if (message.key.fromMe) continue;

      const text = extractText(message.message);
      if (!text) continue;

      const sender = normalizeSender(jid);
      const allowedSenders = getAllowedSenders(this.ctx.settings);
      if (allowedSenders.size === 0 || (!allowedSenders.has(sender) && !allowedSenders.has(jid))) continue;
      if (wasProcessed(this.db, messageId)) continue;

      markProcessed(this.db, messageId, sender);

      try {
        const history = loadHistory(this.db, sender);
        const reply = await this.generateReply(this.ctx, sender, text, history);
        const now = new Date().toISOString();
        const nextHistory: ChatTurn[] = [
          ...history,
          { role: "user" as const, text, createdAt: now },
          { role: "assistant" as const, text: reply, createdAt: now },
        ].slice(-getHistoryTurnLimit(this.ctx.settings));
        saveHistory(this.db, sender, nextHistory);

        for (const chunk of splitMessageForWhatsapp(reply)) {
          await this.sock?.sendMessage(jid, { text: chunk });
        }
      } catch (error) {
        this.ctx.logger.error("WhatsApp chat processing failed", error);
        try {
          await this.sock?.sendMessage(jid, { text: FALLBACK_TEXT });
        } catch {
          // no-op
        }
      }
    }
  };

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = BACKOFF_MS[Math.min(this.reconnectAttempt, BACKOFF_MS.length - 1)] ?? 30000;
    this.reconnectAttempt += 1;

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      await this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  public static splitMessageForWhatsapp(text: string, max = 4096): string[] {
    const chunks = splitMessageForWhatsapp(text);
    if (max === 4096) return chunks;
    return chunks.flatMap((chunk) => {
      if (chunk.length <= max) return [chunk];
      const split: string[] = [];
      let remaining = chunk;
      while (remaining.length > max) {
        split.push(remaining.slice(0, max));
        remaining = remaining.slice(max);
      }
      if (remaining.length) split.push(remaining);
      return split;
    });
  }
}
