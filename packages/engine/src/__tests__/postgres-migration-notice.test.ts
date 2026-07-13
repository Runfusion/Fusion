import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DASHBOARD_USER_ID, Database, MessageStore, type MessageStore as MessageStoreType } from "@fusion/core";
import {
  POSTGRES_MIGRATION_HELP_URL,
  POSTGRES_MIGRATION_NOTICE_KIND,
  deliverPostgresMigrationNoticeIfNeeded,
  isPostgresMigrationNoticeVersion,
} from "../postgres-migration-notice.js";

describe("postgres migration notice", () => {
  let db: Database;
  let store: MessageStore;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "kb-postgres-notice-test-"));
    db = new Database(tempDir, { inMemory: true });
    db.init();
    store = new MessageStore(db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
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
    const inbox = store.getInbox(DASHBOARD_USER_ID, "user", { type: "system" });
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

    const inbox = store.getInbox(DASHBOARD_USER_ID, "user", { type: "system" });
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

    expect(store.getInbox(DASHBOARD_USER_ID, "user", { type: "system" })).toHaveLength(0);
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
