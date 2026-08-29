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
  fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 0], isLatest: true }),
  DisconnectReason: { loggedOut: 401 },
  BufferJSON: { reviver: undefined, replacer: undefined },
  initAuthCreds: () => ({}),
}));

vi.mock("qrcode", () => ({
  default: { toDataURL: mockState.toDataURL },
}));

import { WhatsAppConnection } from "../connection.js";
import type { ChatTurn, WhatsAppPersistence } from "../persistence.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createInMemoryPersistence(): WhatsAppPersistence {
  const sessions = new Map<string, ChatTurn[]>();
  const dedupe = new Set<string>();
  let credentials: string | null = null;
  const keys = new Map<string, string>();
  return {
    async loadHistory(sender) { return [...(sessions.get(sender) ?? [])]; },
    async appendHistory(sender, turns, turnLimit) {
      sessions.set(sender, [...(sessions.get(sender) ?? []), ...turns].slice(-turnLimit));
    },
    async wasProcessed(messageId) { return dedupe.has(messageId); },
    async markProcessed(messageId) { dedupe.add(messageId); },
    async claimMessage(messageId) {
      if (dedupe.has(messageId)) return false;
      dedupe.add(messageId);
      return true;
    },
    async loadCredentials() { return credentials; },
    async saveCredentials(value) { credentials = value; },
    async loadAuthKeys(category, ids) {
      return Object.fromEntries(ids.flatMap((id) => {
        const value = keys.get(`${category}:${id}`);
        return value === undefined ? [] : [[id, value]];
      }));
    },
    async writeAuthKeys(batch) {
      for (const [category, values] of Object.entries(batch)) {
        for (const [id, value] of Object.entries(values)) {
          if (value === null) keys.delete(`${category}:${id}`);
          else keys.set(`${category}:${id}`, value);
        }
      }
    },
    async clearAuthState() {
      credentials = null;
      keys.clear();
    },
  };
}

function makeCtx(settings: Record<string, unknown> = {}) {
  return {
    pluginId: "fusion-plugin-whatsapp-chat",
    settings: { allowedSenders: ["15550001111"], ...settings },
    taskStore: { getRootDir: () => "/tmp" },
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
    const connection = new WhatsAppConnection(makeCtx(), "0.1.0", vi.fn().mockResolvedValue("reply"), createInMemoryPersistence());
    await connection.start();
    await connection.stop();
    await connection.stop();
    expect(mockState.makeWASocket).toHaveBeenCalledTimes(1);
    expect(mockState.end).toHaveBeenCalledTimes(1);
  });

  it("exposes qr updates", async () => {
    const connection = new WhatsAppConnection(makeCtx(), "0.1.0", vi.fn().mockResolvedValue("reply"), createInMemoryPersistence());
    await connection.start();
    await mockState.handlers.get("connection.update")?.({ qr: "abc" });
    expect(connection.getStatus()).toMatchObject({ state: "awaiting-qr", qr: "abc" });
  });

  it("logs rejected async EventEmitter listeners", async () => {
    const ctx = makeCtx();
    const connection = new WhatsAppConnection(ctx, "0.1.0", vi.fn().mockResolvedValue("reply"), createInMemoryPersistence());
    await connection.start();
    mockState.toDataURL.mockRejectedValueOnce(new Error("bad qr"));

    await mockState.handlers.get("connection.update")?.({ qr: "invalid" });

    expect(ctx.logger.error).toHaveBeenCalledWith("WhatsApp connection update failed", expect.any(Error));
    expect(connection.getStatus()).toMatchObject({ state: "error", lastError: "bad qr" });
  });

  it("reconnects after a logged-out close while the plugin remains started", async () => {
    vi.useFakeTimers();
    const connection = new WhatsAppConnection(makeCtx(), "0.1.0", vi.fn().mockResolvedValue("reply"), createInMemoryPersistence());
    await connection.start();
    await mockState.handlers.get("connection.update")?.({ connection: "close", lastDisconnect: { error: new Error("boom") } });
    // connect() awaits fetchLatestBaileysVersion before building the socket, so flush microtasks after the timer fires.
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockState.makeWASocket).toHaveBeenCalledTimes(2);

    await mockState.handlers.get("connection.update")?.({ connection: "close", lastDisconnect: { error: { output: { statusCode: 401 } } } });
    await vi.advanceTimersByTimeAsync(2000);
    expect(mockState.makeWASocket).toHaveBeenCalledTimes(3);
    expect(connection.getStatus()).toMatchObject({ state: "starting" });
    vi.useRealTimers();
  });

  it("reconnects after explicit logout so settings can re-pair", async () => {
    vi.useFakeTimers();
    const connection = new WhatsAppConnection(makeCtx(), "0.1.0", vi.fn().mockResolvedValue("reply"), createInMemoryPersistence());
    await connection.start();

    await connection.logout();

    expect(connection.getStatus()).toMatchObject({ state: "starting" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockState.makeWASocket).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("drops unsupported inbound traffic", async () => {
    const reply = vi.fn().mockResolvedValue("hello");
    const connection = new WhatsAppConnection(makeCtx(), "0.1.0", reply, createInMemoryPersistence());
    await connection.start();
    const upsert = mockState.handlers.get("messages.upsert")!;
    await upsert({ type: "notify", messages: [{ key: { remoteJid: "abc@g.us", id: "1", fromMe: false }, message: { conversation: "hi" } }] });
    await upsert({ type: "notify", messages: [{ key: { remoteJid: "15550001111@s.whatsapp.net", id: "2", fromMe: true }, message: { conversation: "hi" } }] });
    await upsert({ type: "notify", messages: [{ key: { remoteJid: "15550001111@s.whatsapp.net", id: "3", fromMe: false }, message: {} }] });
    expect(reply).not.toHaveBeenCalled();
  });

  it("dedupes and handles reply failure with fallback", async () => {
    const reply = vi.fn().mockRejectedValue(new Error("nope"));
    const connection = new WhatsAppConnection(makeCtx(), "0.1.0", reply, createInMemoryPersistence());
    await connection.start();
    const payload = { type: "notify", messages: [{ key: { remoteJid: "15550001111@s.whatsapp.net", id: "m-1", fromMe: false }, message: { conversation: "hi" } }] };
    await mockState.handlers.get("messages.upsert")?.(payload);
    await mockState.handlers.get("messages.upsert")?.(payload);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(mockState.sendMessage).toHaveBeenCalledWith("15550001111@s.whatsapp.net", { text: "Sorry, I hit an internal error while processing that message." });
  });

  it("atomically claims concurrent duplicate deliveries", async () => {
    const reply = vi.fn().mockResolvedValue("one reply");
    const connection = new WhatsAppConnection(makeCtx(), "0.1.0", reply, createInMemoryPersistence());
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
    const persistence = createInMemoryPersistence();
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
    const persistence = createInMemoryPersistence();
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
    const connection = new WhatsAppConnection(makeCtx(), "0.1.0", vi.fn().mockResolvedValue("reply"), createInMemoryPersistence());
    await connection.start();

    const logout = connection.logout();
    await logoutStarted.promise;
    await connection.stop();
    releaseLogout.resolve();
    await logout;

    expect(mockState.logout).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["explicit logout", async (connection: WhatsAppConnection) => connection.logout()],
    ["logged-out connection update", async () => mockState.handlers.get("connection.update")?.({
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 401 } } },
    })],
  ])("drains an accepted credential save before %s clears auth", async (_surface, triggerReset) => {
    const saveStarted = deferred();
    const releaseSave = deferred();
    const persistence = createInMemoryPersistence();
    const saveCredentials = persistence.saveCredentials.bind(persistence);
    vi.spyOn(persistence, "saveCredentials").mockImplementation(async (value) => {
      saveStarted.resolve();
      await releaseSave.promise;
      await saveCredentials(value);
    });
    const clearAuthState = vi.spyOn(persistence, "clearAuthState");
    const connection = new WhatsAppConnection(makeCtx(), "0.1.0", vi.fn().mockResolvedValue("reply"), persistence);
    await connection.start();
    const credentialSave = mockState.handlers.get("creds.update")?.({});
    await saveStarted.promise;

    const reset = triggerReset(connection);
    await Promise.resolve();
    expect(mockState.handlers.has("creds.update")).toBe(false);
    expect(clearAuthState).not.toHaveBeenCalled();
    releaseSave.resolve();
    await Promise.all([credentialSave, reset]);

    expect(clearAuthState).toHaveBeenCalledTimes(1);
    expect(await persistence.loadCredentials()).toBeNull();
  });

  it("deduplicates explicit and connection-event auth resets for one socket", async () => {
    const persistence = createInMemoryPersistence();
    const clearAuthState = vi.spyOn(persistence, "clearAuthState");
    const connection = new WhatsAppConnection(makeCtx(), "0.1.0", vi.fn().mockResolvedValue("reply"), persistence);
    await connection.start();
    const connectionUpdate = mockState.handlers.get("connection.update")!;
    mockState.logout.mockImplementationOnce(async () => connectionUpdate({
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 401 } } },
    }));

    await connection.logout();

    expect(clearAuthState).toHaveBeenCalledTimes(1);
    expect(await persistence.loadCredentials()).toBeNull();
  });

  it("logs reconnect timer rejection instead of leaking it", async () => {
    vi.useFakeTimers();
    const ctx = makeCtx();
    const connection = new WhatsAppConnection(ctx, "0.1.0", vi.fn().mockResolvedValue("reply"), createInMemoryPersistence());
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
