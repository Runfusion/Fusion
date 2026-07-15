import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DASHBOARD_USER_ID, type MessageStore as MessageStoreType, type Message } from "@fusion/core";
import {
  POSTGRES_MIGRATION_COMPLETE_NOTICE_KIND,
  POSTGRES_MIGRATION_HELP_URL,
  POSTGRES_MIGRATION_NOTICE_KIND,
  deliverPostgresMigrationCompleteNoticeIfNeeded,
  deliverPostgresMigrationNoticeIfNeeded,
  isPostgresMigrationNoticeVersion,
} from "../postgres-migration-notice.js";

/*
FNXC:PostgresCutover 2026-07-12 (merge port from main):
Upstream's harness built the removed sqlite Database + MessageStore
(SqliteFinalRemoval — the stub throws on init). The notice only touches the
getInbox/sendMessage seam, so a minimal in-memory fake with the async
MessageStore shape preserves upstream's full coverage (delivery, idempotency,
version gate, failure swallowing) without a database.
*/
function makeFakeMessageStore() {
  const messages: Array<Partial<Message>> = [];
  const onceKeys = new Set<string>();
  const fake = {
    getInbox: vi.fn(async (
      _ownerId: string,
      _ownerType: string,
      filter?: { type?: string; metadataKind?: string; limit?: number },
    ) => messages
      .filter((m) => !filter?.type || m.type === filter.type)
      .filter((m) => !filter?.metadataKind || m.metadata?.kind === filter.metadataKind)
      .slice(0, filter?.limit)),
    sendMessage: vi.fn(async (input: Partial<Message>) => {
      const message = { ...input, id: `msg-${messages.length + 1}` };
      messages.push(message);
      return message;
    }),
    sendMessageOnce: vi.fn(async (input: Partial<Message>, idempotencyKey: string) => {
      const inserted = !onceKeys.has(idempotencyKey);
      onceKeys.add(idempotencyKey);
      const message = { ...input, id: `msg-once-${idempotencyKey}` };
      if (inserted) messages.push(message);
      return { message, inserted };
    }),
  };
  return fake as unknown as MessageStoreType & typeof fake;
}

describe("postgres migration notice", () => {
  let store: ReturnType<typeof makeFakeMessageStore>;

  beforeEach(() => {
    store = makeFakeMessageStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("matches only the 0.59 release line", () => {
    expect(isPostgresMigrationNoticeVersion("0.59.0")).toBe(true);
    expect(isPostgresMigrationNoticeVersion("0.59.3")).toBe(true);
    expect(isPostgresMigrationNoticeVersion("0.59.10")).toBe(true);

    expect(isPostgresMigrationNoticeVersion(undefined)).toBe(false);
    expect(isPostgresMigrationNoticeVersion("")).toBe(false);
    expect(isPostgresMigrationNoticeVersion("0.58.0")).toBe(false);
    expect(isPostgresMigrationNoticeVersion("0.60.0")).toBe(false);
    expect(isPostgresMigrationNoticeVersion("1.59.0")).toBe(false);
    expect(isPostgresMigrationNoticeVersion("0.0.0")).toBe(false);
    expect(isPostgresMigrationNoticeVersion("0.0.0-dev")).toBe(false);
    expect(isPostgresMigrationNoticeVersion("not-semver")).toBe(false);
  });

  it("delivers exactly one system inbox notice for 0.59.x", async () => {
    const result = await deliverPostgresMigrationNoticeIfNeeded({
      messageStore: store,
      version: "0.59.3",
    });

    expect(result).toBe("delivered");
    const inbox = await store.getInbox(DASHBOARD_USER_ID, "user", { type: "system" });
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toEqual(expect.objectContaining({
      fromType: "system",
      toType: "user",
      toId: DASHBOARD_USER_ID,
      type: "system",
      metadata: expect.objectContaining({
        kind: POSTGRES_MIGRATION_NOTICE_KIND,
        version: "0.59.3",
        helpUrl: POSTGRES_MIGRATION_HELP_URL,
      }),
    }));
    expect(inbox[0]?.content).toContain("Postgres backend for data storage");
    expect(inbox[0]?.content).toContain(POSTGRES_MIGRATION_HELP_URL);
  });

  it("is idempotent across restart-like repeated calls", async () => {
    await expect(deliverPostgresMigrationNoticeIfNeeded({
      messageStore: store,
      version: "0.59.0",
    })).resolves.toBe("delivered");

    await expect(deliverPostgresMigrationNoticeIfNeeded({
      messageStore: store,
      version: "0.59.0",
    })).resolves.toBe("already-delivered");

    const inbox = await store.getInbox(DASHBOARD_USER_ID, "user", { type: "system" });
    expect(inbox).toHaveLength(1);
  });

  it("does not deliver for version mismatches", async () => {
    await expect(deliverPostgresMigrationNoticeIfNeeded({
      messageStore: store,
      version: "0.58.0",
    })).resolves.toBe("version-mismatch");
    await expect(deliverPostgresMigrationNoticeIfNeeded({
      messageStore: store,
      version: undefined,
    })).resolves.toBe("version-mismatch");

    expect(await store.getInbox(DASHBOARD_USER_ID, "user", { type: "system" })).toHaveLength(0);
  });

  it("returns no-store when the message store is unavailable", async () => {
    await expect(deliverPostgresMigrationNoticeIfNeeded({
      messageStore: undefined,
      version: "0.59.0",
    })).resolves.toBe("no-store");
  });

  it("swallows getInbox failures and logs a warning", async () => {
    const warn = vi.fn();
    const throwingStore = {
      getInbox: vi.fn(() => {
        throw new Error("inbox unavailable");
      }),
      sendMessage: vi.fn(),
    } as unknown as MessageStoreType;

    await expect(deliverPostgresMigrationNoticeIfNeeded({
      messageStore: throwingStore,
      version: "0.59.0",
      log: { warn },
    })).resolves.toBe("already-delivered");

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("inbox unavailable"));
  });

  it("swallows sendMessage failures and logs a warning", async () => {
    const warn = vi.fn();
    const throwingStore = {
      getInbox: vi.fn(() => []),
      sendMessage: vi.fn(() => {
        throw new Error("send unavailable");
      }),
    } as unknown as MessageStoreType;

    await expect(deliverPostgresMigrationNoticeIfNeeded({
      messageStore: throwingStore,
      version: "0.59.0",
      log: { warn },
    })).resolves.toBe("already-delivered");

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("send unavailable"));
  });
});

describe("postgres migration complete notice", () => {
  let store: ReturnType<typeof makeFakeMessageStore>;

  const notice = {
    migratedAt: "2026-07-14T18:00:00.000Z",
    migratedRows: 527_784,
    tables: 221,
    sqliteBackups: ["/project/.fusion/fusion.db", "/project/.fusion/archive.db"],
    dismissed: false,
  };

  beforeEach(() => {
    store = makeFakeMessageStore();
  });

  it("delivers one system inbox message with migration details and Discord help", async () => {
    const markDelivered = vi.fn(async () => undefined);
    await expect(deliverPostgresMigrationCompleteNoticeIfNeeded({
      messageStore: store,
      notice,
      markDelivered,
    })).resolves.toBe("delivered");

    const inbox = await store.getInbox(DASHBOARD_USER_ID, "user", {
      type: "system",
      metadataKind: POSTGRES_MIGRATION_COMPLETE_NOTICE_KIND,
    });
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.content).toContain("527,784 rows across 221 tables");
    expect(inbox[0]?.content).toContain("2026-07-14T18:00:00.000Z");
    expect(inbox[0]?.content).toContain("/project/.fusion/fusion.db");
    expect(inbox[0]?.content).toContain(POSTGRES_MIGRATION_HELP_URL);
    expect(inbox[0]?.content).toContain(`[Get help on Discord](${POSTGRES_MIGRATION_HELP_URL})`);
    expect(inbox[0]?.metadata).toEqual(expect.objectContaining({
      kind: POSTGRES_MIGRATION_COMPLETE_NOTICE_KIND,
      migratedRows: 527_784,
      tables: 221,
      helpUrl: POSTGRES_MIGRATION_HELP_URL,
    }));
    expect(markDelivered).toHaveBeenCalledTimes(1);
  });

  /*
  FNXC:PostgresMigrationInbox 2026-07-14-12:10:
  Concurrent project-start paths must contend on one database-backed idempotency key so only the winning insert is reported as delivered and only one completion message reaches the dashboard inbox.
  */
  it("atomically delivers once when completion helpers run concurrently", async () => {
    const markDelivered = vi.fn(async () => undefined);
    const results = await Promise.all([
      deliverPostgresMigrationCompleteNoticeIfNeeded({ messageStore: store, notice, markDelivered }),
      deliverPostgresMigrationCompleteNoticeIfNeeded({ messageStore: store, notice, markDelivered }),
    ]);

    expect(results.sort()).toEqual(["already-delivered", "delivered"]);
    expect(store.sendMessageOnce).toHaveBeenCalledTimes(2);
    const completionMessages = (await store.getInbox(DASHBOARD_USER_ID, "user"))
      .filter((message) => message.metadata?.kind === POSTGRES_MIGRATION_COMPLETE_NOTICE_KIND);
    expect(completionMessages).toHaveLength(1);
  });

  it("does not deliver without a completed migration", async () => {
    await expect(deliverPostgresMigrationCompleteNoticeIfNeeded({
      messageStore: store,
      notice: undefined,
    })).resolves.toBe("no-migration");
    expect(store.sendMessage).not.toHaveBeenCalled();
  });

  it("uses the settings marker to remain once-only even when old inbox messages are pruned", async () => {
    await expect(deliverPostgresMigrationCompleteNoticeIfNeeded({
      messageStore: store,
      notice,
      deliveredAt: "2026-07-14T18:01:00.000Z",
    })).resolves.toBe("already-delivered");
    expect(store.sendMessageOnce).not.toHaveBeenCalled();
  });

  it("reconciles an existing atomic message into the durable settings marker", async () => {
    await deliverPostgresMigrationCompleteNoticeIfNeeded({ messageStore: store, notice });
    const markDelivered = vi.fn(async () => undefined);

    await expect(deliverPostgresMigrationCompleteNoticeIfNeeded({
      messageStore: store,
      notice,
      markDelivered,
    })).resolves.toBe("already-delivered");
    expect(store.sendMessageOnce).toHaveBeenCalledTimes(2);
    expect(markDelivered).toHaveBeenCalledTimes(1);
  });
});
