import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => {
  const handlers = new Map<string, (payload: any) => void>();
  const sendMessage = vi.fn();
  const end = vi.fn();
  const logout = vi.fn();
  const requestPairingCode = vi.fn().mockResolvedValue("123-456");
  const toDataURL = vi.fn().mockResolvedValue("data:image/png;base64,abc");
  const makeWASocket = vi.fn(() => ({
    ev: {
      on: (name: string, handler: (payload: any) => void) => handlers.set(name, handler),
      off: (name: string) => handlers.delete(name),
    },
    user: { id: "15550001111@s.whatsapp.net" },
    sendMessage,
    end,
    logout,
    requestPairingCode,
  }));
  return { handlers, sendMessage, end, logout, requestPairingCode, makeWASocket, toDataURL };
});

vi.mock("@whiskeysockets/baileys", () => ({
  default: mockState.makeWASocket,
  makeWASocket: mockState.makeWASocket,
  DisconnectReason: { loggedOut: 401 },
  BufferJSON: { reviver: undefined, replacer: undefined },
  initAuthCreds: () => ({}),
}));

vi.mock("qrcode", () => ({
  default: { toDataURL: mockState.toDataURL },
}));

import { WhatsAppConnection } from "../connection.js";
import { createSqliteWhatsAppPersistence } from "../persistence.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createInMemoryDb() {
  const sessions = new Map<string, string>();
  const dedupe = new Set<string>();
  const creds = new Map<string, string>();
  const keys = new Map<string, string>();
  return {
    exec() {},
    prepare(sql: string) {
      return {
        get: (...args: unknown[]) => {
          if (sql.includes("FROM whatsapp_chat_sessions")) {
            const history = sessions.get(args[0] as string);
            return history ? { history } : undefined;
          }
          if (sql.includes("FROM whatsapp_chat_dedupe")) return dedupe.has(args[0] as string) ? { found: 1 } : undefined;
          if (sql.includes("FROM whatsapp_auth_creds")) return creds.get("creds") ? { value: creds.get("creds") } : undefined;
          if (sql.includes("FROM whatsapp_auth_keys")) return keys.get(`${args[0]}:${args[1]}`) ? { value: keys.get(`${args[0]}:${args[1]}`) } : undefined;
          return undefined;
        },
        run: (...args: unknown[]) => {
          if (sql.includes("whatsapp_chat_sessions")) sessions.set(args[0] as string, args[1] as string);
          if (sql.includes("DELETE FROM whatsapp_chat_dedupe")) return { changes: 0 };
          if (sql.includes("INSERT OR IGNORE INTO whatsapp_chat_dedupe")) {
            const messageId = args[0] as string;
            if (dedupe.has(messageId)) return { changes: 0 };
            dedupe.add(messageId);
            return { changes: 1 };
          }
          if (sql.includes("whatsapp_chat_dedupe")) dedupe.add(args[0] as string);
          if (sql.includes("INSERT INTO whatsapp_auth_creds")) creds.set("creds", args[0] as string);
          if (sql.includes("DELETE FROM whatsapp_auth_creds")) creds.clear();
          if (sql.includes("INSERT INTO whatsapp_auth_keys")) keys.set(`${args[0]}:${args[1]}`, args[2] as string);
          if (sql.includes("DELETE FROM whatsapp_auth_keys WHERE category")) keys.delete(`${args[0]}:${args[1]}`);
          if (sql.includes("DELETE FROM whatsapp_auth_keys")) keys.clear();
        },
      };
    },
  };
}

function makeCtx(settings: Record<string, unknown> = {}) {
  return {
    pluginId: "fusion-plugin-whatsapp-chat",
    settings: { allowedSenders: ["15550001111"], ...settings },
    taskStore: { getRootDir: () => "/tmp", getPluginStore: () => ({}) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    emitEvent: vi.fn(),
  } as any;
}

describe("WhatsAppConnection", () => {
  beforeEach(() => {
    mockState.handlers.clear();
    mockState.makeWASocket.mockClear();
    mockState.sendMessage.mockClear();
    mockState.end.mockClear();
    mockState.logout.mockReset();
    mockState.toDataURL.mockReset();
    mockState.toDataURL.mockResolvedValue("data:image/png;base64,abc");
  });

  it("starts and stops idempotently", async () => {
    const connection = new WhatsAppConnection(makeCtx(), "0.1.0", vi.fn().mockResolvedValue("reply"), createSqliteWhatsAppPersistence(createInMemoryDb() as any));
    await connection.start();
    await connection.stop();
    await connection.stop();
    expect(mockState.makeWASocket).toHaveBeenCalledTimes(1);
    expect(mockState.end).toHaveBeenCalledTimes(1);
  });

  it("exposes qr updates", async () => {
    const connection = new WhatsAppConnection(makeCtx(), "0.1.0", vi.fn().mockResolvedValue("reply"), createSqliteWhatsAppPersistence(createInMemoryDb() as any));
    await connection.start();
    await mockState.handlers.get("connection.update")?.({ qr: "abc" });
    expect(connection.getStatus()).toMatchObject({ state: "awaiting-qr", qr: "abc" });
  });

  it("logs rejected async EventEmitter listeners", async () => {
    const ctx = makeCtx();
    const connection = new WhatsAppConnection(ctx, "0.1.0", vi.fn().mockResolvedValue("reply"), createSqliteWhatsAppPersistence(createInMemoryDb() as any));
    await connection.start();
    mockState.toDataURL.mockRejectedValueOnce(new Error("bad qr"));

    await mockState.handlers.get("connection.update")?.({ qr: "invalid" });

    expect(ctx.logger.error).toHaveBeenCalledWith("WhatsApp connection update failed", expect.any(Error));
    expect(connection.getStatus()).toMatchObject({ state: "error", lastError: "bad qr" });
  });

  it("reconnects on close unless logged out", async () => {
    vi.useFakeTimers();
    const connection = new WhatsAppConnection(makeCtx(), "0.1.0", vi.fn().mockResolvedValue("reply"), createSqliteWhatsAppPersistence(createInMemoryDb() as any));
    await connection.start();
    await mockState.handlers.get("connection.update")?.({ connection: "close", lastDisconnect: { error: new Error("boom") } });
    vi.advanceTimersByTime(1000);
    expect(mockState.makeWASocket).toHaveBeenCalledTimes(2);

    await mockState.handlers.get("connection.update")?.({ connection: "close", lastDisconnect: { error: { output: { statusCode: 401 } } } });
    vi.advanceTimersByTime(1000);
    expect(mockState.makeWASocket).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("drops unsupported inbound traffic", async () => {
    const reply = vi.fn().mockResolvedValue("hello");
    const connection = new WhatsAppConnection(makeCtx(), "0.1.0", reply, createSqliteWhatsAppPersistence(createInMemoryDb() as any));
    await connection.start();
    const upsert = mockState.handlers.get("messages.upsert")!;
    await upsert({ type: "notify", messages: [{ key: { remoteJid: "abc@g.us", id: "1", fromMe: false }, message: { conversation: "hi" } }] });
    await upsert({ type: "notify", messages: [{ key: { remoteJid: "15550001111@s.whatsapp.net", id: "2", fromMe: true }, message: { conversation: "hi" } }] });
    await upsert({ type: "notify", messages: [{ key: { remoteJid: "15550001111@s.whatsapp.net", id: "3", fromMe: false }, message: {} }] });
    expect(reply).not.toHaveBeenCalled();
  });

  it("dedupes and handles reply failure with fallback", async () => {
    const reply = vi.fn().mockRejectedValue(new Error("nope"));
    const connection = new WhatsAppConnection(makeCtx(), "0.1.0", reply, createSqliteWhatsAppPersistence(createInMemoryDb() as any));
    await connection.start();
    const payload = { type: "notify", messages: [{ key: { remoteJid: "15550001111@s.whatsapp.net", id: "m-1", fromMe: false }, message: { conversation: "hi" } }] };
    await mockState.handlers.get("messages.upsert")?.(payload);
    await mockState.handlers.get("messages.upsert")?.(payload);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(mockState.sendMessage).toHaveBeenCalledWith("15550001111@s.whatsapp.net", { text: "Sorry, I hit an internal error while processing that message." });
  });

  it("atomically claims concurrent duplicate deliveries", async () => {
    const reply = vi.fn().mockResolvedValue("one reply");
    const connection = new WhatsAppConnection(makeCtx(), "0.1.0", reply, createSqliteWhatsAppPersistence(createInMemoryDb() as any));
    await connection.start();
    const payload = { type: "notify", messages: [{ key: { remoteJid: "15550001111@s.whatsapp.net", id: "same-id", fromMe: false }, message: { conversation: "hi" } }] };

    await Promise.all([
      mockState.handlers.get("messages.upsert")?.(payload),
      mockState.handlers.get("messages.upsert")?.(payload),
    ]);

    expect(reply).toHaveBeenCalledTimes(1);
    expect(mockState.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent messages from one sender and preserves both turns", async () => {
    const firstReplyStarted = deferred();
    const releaseFirstReply = deferred();
    const db = createInMemoryDb();
    const persistence = createSqliteWhatsAppPersistence(db as any);
    const reply = vi.fn(async (_ctx: unknown, _sender: string, text: string, history: Array<{ text: string }>) => {
      if (text === "first") {
        firstReplyStarted.resolve();
        await releaseFirstReply.promise;
      }
      return `${text}-reply-${history.length}`;
    });
    const connection = new WhatsAppConnection(makeCtx(), "0.1.0", reply, persistence);
    await connection.start();
    const upsert = mockState.handlers.get("messages.upsert")!;

    const first = upsert({ type: "notify", messages: [{ key: { remoteJid: "15550001111@s.whatsapp.net", id: "m-first", fromMe: false }, message: { conversation: "first" } }] });
    await firstReplyStarted.promise;
    const second = upsert({ type: "notify", messages: [{ key: { remoteJid: "15550001111@s.whatsapp.net", id: "m-second", fromMe: false }, message: { conversation: "second" } }] });

    await Promise.resolve();
    expect(reply).toHaveBeenCalledTimes(1);
    releaseFirstReply.resolve();
    await Promise.all([first, second]);

    expect(reply.mock.calls[1]?.[3].map((turn: { text: string }) => turn.text)).toEqual(["first", "first-reply-0"]);
    expect((await persistence.loadHistory("15550001111")).map((turn) => turn.text)).toEqual([
      "first",
      "first-reply-0",
      "second",
      "second-reply-2",
    ]);
  });

  it("sends an accepted reply before a concurrent stop closes its socket", async () => {
    const replyPersisted = deferred();
    const releasePersistedReply = deferred();
    const persistence = createSqliteWhatsAppPersistence(createInMemoryDb() as any);
    const appendHistory = persistence.appendHistory.bind(persistence);
    vi.spyOn(persistence, "appendHistory").mockImplementation(async (...args) => {
      await appendHistory(...args);
      replyPersisted.resolve();
      await releasePersistedReply.promise;
    });
    const connection = new WhatsAppConnection(makeCtx(), "0.1.0", vi.fn().mockResolvedValue("saved reply"), persistence);
    await connection.start();
    const upsert = mockState.handlers.get("messages.upsert")!;

    const inbound = upsert({ type: "notify", messages: [{ key: { remoteJid: "15550001111@s.whatsapp.net", id: "m-stop-race", fromMe: false }, message: { conversation: "hello" } }] });
    await replyPersisted.promise;
    const stop = connection.stop();

    await Promise.resolve();
    expect(mockState.handlers.has("messages.upsert")).toBe(false);
    expect(mockState.end).not.toHaveBeenCalled();
    releasePersistedReply.resolve();
    await Promise.all([inbound, stop]);

    expect(mockState.sendMessage).toHaveBeenCalledWith("15550001111@s.whatsapp.net", { text: "saved reply" });
    expect(mockState.sendMessage.mock.invocationCallOrder[0])
      .toBeLessThan(mockState.end.mock.invocationCallOrder[0]!);
  });

  it("attempts server logout through the socket captured before a concurrent stop", async () => {
    const logoutStarted = deferred();
    const releaseLogout = deferred();
    mockState.logout.mockImplementationOnce(async () => {
      logoutStarted.resolve();
      await releaseLogout.promise;
    });
    const connection = new WhatsAppConnection(makeCtx(), "0.1.0", vi.fn().mockResolvedValue("reply"), createSqliteWhatsAppPersistence(createInMemoryDb() as any));
    await connection.start();

    const logout = connection.logout();
    await logoutStarted.promise;
    await connection.stop();
    releaseLogout.resolve();
    await logout;

    expect(mockState.logout).toHaveBeenCalledTimes(1);
  });

  it("logs reconnect timer rejection instead of leaking it", async () => {
    vi.useFakeTimers();
    const ctx = makeCtx();
    const connection = new WhatsAppConnection(ctx, "0.1.0", vi.fn().mockResolvedValue("reply"), createSqliteWhatsAppPersistence(createInMemoryDb() as any));
    await connection.start();
    mockState.makeWASocket.mockImplementationOnce(() => {
      throw new Error("reconnect exploded");
    });

    await mockState.handlers.get("connection.update")?.({ connection: "close", lastDisconnect: { error: new Error("closed") } });
    await vi.advanceTimersByTimeAsync(1000);

    expect(ctx.logger.error).toHaveBeenCalledWith("WhatsApp reconnect failed", expect.any(Error));
    expect(connection.getStatus()).toMatchObject({ state: "error", lastError: "reconnect exploded" });
    await connection.stop();
    vi.useRealTimers();
  });

  it("splits oversized messages", () => {
    const chunks = WhatsAppConnection.splitMessageForWhatsapp("x".repeat(9000));
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0].length).toBeLessThanOrEqual(4096);
  });
});
