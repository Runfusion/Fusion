import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";

import { Database, MessageStore } from "@fusion/core";

import { SelfHealingManager } from "../self-healing.js";

describe("FN-4743: self-healing mail cleanup maintenance", () => {
  let tmpRoot: string;
  let db: Database;
  let messageStore: MessageStore;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "fusion-self-healing-mail-cleanup-"));
    const fusionDir = join(tmpRoot, ".fusion");
    db = new Database(fusionDir, { inMemory: true });
    db.init();
    messageStore = new MessageStore(db);
  });

  beforeEach(() => {
    db.exec("DELETE FROM messages");
  });

  afterAll(async () => {
    db.close();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  function buildManager(mailAutoCleanupDays?: number, includeMessageStore = true) {
    const store = {
      getSettings: vi.fn(async () => ({ maintenanceIntervalMs: 0, globalPause: false, enginePaused: false, mailAutoCleanupDays })),
    } as any;

    const manager = new SelfHealingManager(store, {
      rootDir: tmpRoot,
      messageStore: includeMessageStore ? messageStore : undefined,
    });
    vi.spyOn(manager as any, "pruneWorktrees").mockResolvedValue(undefined);
    vi.spyOn(manager as any, "cleanupOrphans").mockResolvedValue(undefined);
    vi.spyOn(manager as any, "cleanupOrphanedBranches").mockResolvedValue(undefined);
    vi.spyOn(manager as any, "checkpointWal").mockReturnValue(undefined);
    vi.spyOn(manager as any, "enforceWorktreeCap").mockResolvedValue(undefined);
    vi.spyOn(manager, "archiveStaleDoneTasks").mockResolvedValue(0);

    return manager;
  }

  it("removes only stale messages when mailAutoCleanupDays is enabled", async () => {
    const stale = messageStore.sendMessage({ fromId: "user-1", fromType: "user", toId: "agent-1", toType: "agent", content: "stale", type: "user-to-agent" });
    const fresh = messageStore.sendMessage({ fromId: "agent-1", fromType: "agent", toId: "user-1", toType: "user", content: "fresh", type: "agent-to-user" });

    const staleTimestamp = new Date(Date.now() - 12 * 86_400_000).toISOString();
    const freshTimestamp = new Date(Date.now() - 1 * 86_400_000).toISOString();
    db.prepare("UPDATE messages SET updatedAt = ? WHERE id = ?").run(staleTimestamp, stale.id);
    db.prepare("UPDATE messages SET updatedAt = ? WHERE id = ?").run(freshTimestamp, fresh.id);

    const manager = buildManager(7, true);
    await (manager as any).runMaintenance();

    expect(messageStore.getMessage(stale.id)).toBeNull();
    expect(messageStore.getMessage(fresh.id)).not.toBeNull();
  });

  it("is a no-op when mailAutoCleanupDays is off or undefined", async () => {
    const oldMessage = messageStore.sendMessage({ fromId: "user-1", fromType: "user", toId: "agent-1", toType: "agent", content: "keep", type: "user-to-agent" });
    const oldTimestamp = new Date(Date.now() - 100 * 86_400_000).toISOString();
    db.prepare("UPDATE messages SET updatedAt = ? WHERE id = ?").run(oldTimestamp, oldMessage.id);

    const managerOff = buildManager(0, true);
    await (managerOff as any).runMaintenance();
    expect(messageStore.getMessage(oldMessage.id)).not.toBeNull();

    const managerUndefined = buildManager(undefined, true);
    await (managerUndefined as any).runMaintenance();
    expect(messageStore.getMessage(oldMessage.id)).not.toBeNull();
  });

  it("is a no-op when messageStore option is omitted", async () => {
    const oldMessage = messageStore.sendMessage({ fromId: "user-2", fromType: "user", toId: "agent-2", toType: "agent", content: "keep-no-store", type: "user-to-agent" });
    const oldTimestamp = new Date(Date.now() - 100 * 86_400_000).toISOString();
    db.prepare("UPDATE messages SET updatedAt = ? WHERE id = ?").run(oldTimestamp, oldMessage.id);

    const manager = buildManager(7, false);
    await (manager as any).runMaintenance();

    expect(messageStore.getMessage(oldMessage.id)).not.toBeNull();
  });
});
