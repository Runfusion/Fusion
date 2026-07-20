import { DisconnectReason, fetchLatestBaileysVersion, makeWASocket, type ConnectionState, type WAMessage, type WAMessageContent, type WASocket } from "@whiskeysockets/baileys";
import type { PluginContext } from "@fusion/plugin-sdk";
import pino from "pino";
import qrcode from "qrcode";
import { createPersistenceAuthState } from "./auth-state.js";
import {
  getAllowedSenders,
  getDedupeRetentionDays,
  getHistoryTurnLimit,
  type ChatTurn,
} from "./index.js";
import type { WhatsAppPersistence } from "./persistence.js";

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
  private authState: Awaited<ReturnType<typeof createPersistenceAuthState>> | null = null;
  private readonly senderQueues = new Map<string, Promise<void>>();
  private readonly inboundOperations = new Set<Promise<void>>();
  private readonly credentialSaveOperations = new Set<Promise<void>>();
  private readonly authResetOperations = new WeakMap<WASocket, Promise<void>>();
  private readonly credentialUpdateHandlers = new WeakMap<WASocket, () => Promise<void>>();
  private readonly connectionUpdateHandlers = new WeakMap<WASocket, (update: Partial<ConnectionState>) => Promise<void>>();
  private acceptCredentialSaves = false;

  public constructor(
    private readonly ctx: PluginContext,
    private readonly fusionVersion: string,
    private readonly generateReply: ReplyGenerator,
    private readonly persistence: WhatsAppPersistence,
  ) {}


  public async start(): Promise<void> {
    this.authState = await createPersistenceAuthState(this.persistence);
    this.stopped = false;
    this.status = { state: "starting" };
    await this.connect();
  }

  public async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.clearReconnectTimer();

    const socket = this.sock;
    this.status = { state: "disconnected" };

    if (socket) {
      this.disableCredentialSaves(socket);
      const connectionUpdateHandler = this.connectionUpdateHandlers.get(socket);
      if (connectionUpdateHandler) socket.ev.off("connection.update", connectionUpdateHandler);
      socket.ev.off("messages.upsert", this.onMessagesUpsert);
      /**
       * FNXC:WhatsAppGracefulStop 2026-07-14-01:28:
       * Stop must reject new inbound work but let every already-accepted message send its persisted reply before the active socket closes. Otherwise the mutable socket can become null after history is saved, silently skipping a dedupe-claimed reply with no retry path.
       */
      await Promise.allSettled([
        ...this.credentialSaveOperations,
        ...this.inboundOperations,
      ]);
      if (this.sock === socket) this.sock = null;
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
    /**
     * FNXC:WhatsAppLogoutRace 2026-07-14-00:42:
     * Logout must retain the socket selected at invocation even when stop concurrently clears this.sock. The stable reference ensures Baileys still attempts its server-side logout before local credentials are discarded.
     */
    const socket = this.sock;
    if (socket) this.disableCredentialSaves(socket);
    try {
      await socket?.logout();
    } finally {
      if (socket) {
        await this.resetLoggedOutAuth(socket);
      } else {
        await this.persistence.clearAuthState();
        this.authState = await createPersistenceAuthState(this.persistence);
      }
      if (!this.stopped) {
        /**
         * FNXC:WhatsAppSettingsRePair 2026-07-20-12:00:
         * Logout from Plugin Manager is a re-pair action, not a terminal disconnect. Once auth is cleared, reconnect so settings can present a fresh QR or code instead of stranding the operator on disconnected.
         */
        this.status = { state: "starting" };
        this.scheduleReconnect();
      } else {
        this.status = { state: "disconnected" };
      }
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    if (!this.authState) this.authState = await createPersistenceAuthState(this.persistence);

    this.status = { state: "starting" };
    /**
     * FNXC:WhatsAppProtocolVersion 2026-07-17-09:15:
     * WhatsApp rejects handshakes that advertise a stale WA Web protocol version with a 405 "Connection Failure" close, which left the plugin stuck cycling starting→disconnected and no QR was ever issued. Fetch the current version before each socket build; fetchLatestBaileysVersion falls back to the library's baked-in version on network failure, so this never blocks connecting.
     */
    const { version } = await fetchLatestBaileysVersion();
    const socket = makeWASocket({
      version,
      auth: this.authState.state,
      printQRInTerminal: false,
      browser: ["Fusion", "Chrome", this.fusionVersion],
      logger: pino({ level: "silent" }),
    });

    this.sock = socket;
    this.acceptCredentialSaves = true;
    const credentialUpdateHandler = () => this.onCredsUpdate(socket);
    const connectionUpdateHandler = (update: Partial<ConnectionState>) => this.onConnectionUpdate(socket, update);
    this.credentialUpdateHandlers.set(socket, credentialUpdateHandler);
    this.connectionUpdateHandlers.set(socket, connectionUpdateHandler);
    socket.ev.on("creds.update", credentialUpdateHandler);
    socket.ev.on("connection.update", connectionUpdateHandler);
    socket.ev.on("messages.upsert", this.onMessagesUpsert);
  }

  /*
   * FNXC:WhatsAppAsyncListeners 2026-07-13-23:40:
   * Baileys uses EventEmitter, which does not observe rejected async listener promises. Every registered callback attaches its own rejection handler so QR/auth/persistence failures are logged and cannot become process-level unhandled rejections.
   */
  private onCredsUpdate(socket: WASocket): Promise<void> {
    if (this.sock !== socket || !this.acceptCredentialSaves) return Promise.resolve();
    let operation: Promise<void>;
    operation = Promise.resolve(this.authState?.saveCreds())
      .catch((error: unknown) => {
        this.ctx.logger.error("WhatsApp credential persistence failed", error);
      })
      .finally(() => this.credentialSaveOperations.delete(operation));
    this.credentialSaveOperations.add(operation);
    return operation;
  }

  private onConnectionUpdate(
    socket: WASocket,
    update: Partial<ConnectionState>,
  ): Promise<void> {
    return this.handleConnectionUpdate(socket, update).catch((error: unknown) => {
      if (this.sock !== socket) return;
      this.status = {
        state: "error",
        lastError: error instanceof Error ? error.message : String(error),
      };
      this.ctx.logger.error("WhatsApp connection update failed", error);
    });
  }

  private async handleConnectionUpdate(socket: WASocket, update: Partial<ConnectionState>): Promise<void> {
    if (this.sock !== socket) return;
    if (update.qr) {
      const qrDataUrl = await qrcode.toDataURL(update.qr);
      if (this.sock !== socket) return;
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
        await this.resetLoggedOutAuth(socket);
        if (this.stopped) {
          this.status = { state: "disconnected", lastError: "loggedOut" };
          return;
        }
        /**
         * FNXC:WhatsAppSettingsRePair 2026-07-20-12:00:
         * A logged-out socket also needs a fresh pairing connection while the plugin remains enabled. Scheduling through the shared backoff guard prevents logout and close events from creating competing sockets.
         */
        this.status = { state: "starting" };
        this.scheduleReconnect();
        return;
      }

      const closeError = update.lastDisconnect?.error;
      this.status = {
        state: "disconnected",
        lastError: closeError instanceof Error ? closeError.message : "connection closed",
      };
      this.scheduleReconnect();
    }
  }

  private disableCredentialSaves(socket: WASocket): void {
    const credentialUpdateHandler = this.credentialUpdateHandlers.get(socket);
    if (credentialUpdateHandler) socket.ev.off("creds.update", credentialUpdateHandler);
    if (this.sock === socket) this.acceptCredentialSaves = false;
  }

  private resetLoggedOutAuth(socket: WASocket): Promise<void> {
    const existing = this.authResetOperations.get(socket);
    if (existing) return existing;

    /**
     * FNXC:WhatsAppCredentialReset 2026-07-14-02:08:
     * Explicit logout and logged-out connection events must stop accepting credential writes and drain every accepted save before clearing authentication. Otherwise a standalone credentials upsert can finish after the clear and resurrect the stale session; one reset per socket also prevents the two logout surfaces from racing each other.
     */
    this.disableCredentialSaves(socket);
    const operation = (async () => {
      await Promise.allSettled([...this.credentialSaveOperations]);
      if (this.sock !== null && this.sock !== socket) return;
      await this.persistence.clearAuthState();
      const replacementAuthState = await createPersistenceAuthState(this.persistence);
      if (this.sock === null || this.sock === socket) {
        this.authState = replacementAuthState;
      }
    })();
    this.authResetOperations.set(socket, operation);
    return operation;
  }

  private readonly onMessagesUpsert = (
    upsert: { type?: string; messages?: WAMessage[] },
  ): Promise<void> => {
    if (this.stopped) return Promise.resolve();
    let operation: Promise<void>;
    operation = this.handleMessagesUpsert(upsert)
      .catch((error: unknown) => {
        this.ctx.logger.error("WhatsApp inbound listener failed", error);
      })
      .finally(() => this.inboundOperations.delete(operation));
    this.inboundOperations.add(operation);
    return operation;
  };

  private async handleMessagesUpsert(
    upsert: { type?: string; messages?: WAMessage[] },
  ): Promise<void> {
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
      if (!(await this.persistence.claimMessage(
        messageId,
        sender,
        getDedupeRetentionDays(this.ctx.settings),
      ))) continue;

      await this.enqueueSender(sender, async () => {
        try {
          const history = await this.persistence.loadHistory(sender);
          const reply = await this.generateReply(this.ctx, sender, text, history);
          const now = new Date().toISOString();
          const turns: ChatTurn[] = [
            { role: "user" as const, text, createdAt: now },
            { role: "assistant" as const, text: reply, createdAt: now },
          ];
          await this.persistence.appendHistory(sender, turns, getHistoryTurnLimit(this.ctx.settings));

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
      });
    }
  }

  private async enqueueSender(sender: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.senderQueues.get(sender) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.senderQueues.set(sender, current);
    try {
      await current;
    } finally {
      if (this.senderQueues.get(sender) === current) this.senderQueues.delete(sender);
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = BACKOFF_MS[Math.min(this.reconnectAttempt, BACKOFF_MS.length - 1)] ?? 30000;
    this.reconnectAttempt += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      /*
       * FNXC:WhatsAppReconnectErrors 2026-07-13-23:40:
       * Timer callbacks have no promise consumer. Attach failure handling at scheduling time, expose the error through connection status/logs, and continue bounded backoff unless the plugin was stopped.
       */
      void this.connect().catch((error: unknown) => {
        this.status = {
          state: "error",
          lastError: error instanceof Error ? error.message : String(error),
        };
        this.ctx.logger.error("WhatsApp reconnect failed", error);
        this.scheduleReconnect();
      });
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
