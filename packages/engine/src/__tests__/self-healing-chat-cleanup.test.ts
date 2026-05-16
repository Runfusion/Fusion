import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";

import { ChatStore, Database } from "@fusion/core";

import { SelfHealingManager } from "../self-healing.js";

describe("FN-4733: self-healing chat cleanup maintenance", () => {
  let tmpRoot: string;
  let db: Database;
  let chatStore: ChatStore;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "fusion-self-healing-chat-cleanup-"));
    const fusionDir = join(tmpRoot, ".fusion");
    db = new Database(fusionDir, { inMemory: true });
    db.init();
    chatStore = new ChatStore(fusionDir, db);
  });

  beforeEach(() => {
    db.exec(`
      DELETE FROM chat_room_messages;
      DELETE FROM chat_room_members;
      DELETE FROM chat_rooms;
      DELETE FROM chat_messages;
      DELETE FROM chat_sessions;
    `);
  });

  afterAll(async () => {
    db.close();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  function buildManager(days: number) {
    const store = {
      getSettings: vi.fn(async () => ({ chatAutoCleanupDays: days, globalPause: true, enginePaused: false })),
    } as any;

    const manager = new SelfHealingManager(store, { rootDir: tmpRoot, chatStore });
    vi.spyOn(manager as any, "pruneWorktrees").mockResolvedValue(undefined);
    vi.spyOn(manager as any, "cleanupOrphans").mockResolvedValue(undefined);
    vi.spyOn(manager as any, "cleanupOrphanedBranches").mockResolvedValue(undefined);
    vi.spyOn(manager as any, "checkpointWal").mockReturnValue(undefined);
    vi.spyOn(manager as any, "enforceWorktreeCap").mockResolvedValue(undefined);
    vi.spyOn(manager, "archiveStaleDoneTasks").mockResolvedValue(0);

    return manager;
  }

  it("removes only stale sessions and rooms when chatAutoCleanupDays is enabled", async () => {
    const staleSession = chatStore.createSession({ agentId: "agent-1", title: "stale" });
    const freshSession = chatStore.createSession({ agentId: "agent-1", title: "fresh" });
    const staleRoom = chatStore.createRoom({ name: "stale-room", projectId: "proj-1" });
    const freshRoom = chatStore.createRoom({ name: "fresh-room", projectId: "proj-1" });

    const staleTimestamp = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const freshTimestamp = new Date(Date.now() - 2 * 86_400_000).toISOString();
    db.prepare("UPDATE chat_sessions SET updatedAt = ? WHERE id = ?").run(staleTimestamp, staleSession.id);
    db.prepare("UPDATE chat_sessions SET updatedAt = ? WHERE id = ?").run(freshTimestamp, freshSession.id);
    db.prepare("UPDATE chat_rooms SET updatedAt = ? WHERE id = ?").run(staleTimestamp, staleRoom.id);
    db.prepare("UPDATE chat_rooms SET updatedAt = ? WHERE id = ?").run(freshTimestamp, freshRoom.id);

    const manager = buildManager(7);
    await (manager as any).runMaintenance();

    expect(chatStore.getSession(staleSession.id)).toBeUndefined();
    expect(chatStore.getRoom(staleRoom.id)).toBeUndefined();
    expect(chatStore.getSession(freshSession.id)).toBeDefined();
    expect(chatStore.getRoom(freshRoom.id)).toBeDefined();
  });

  it("is a no-op when chatAutoCleanupDays is off", async () => {
    const session = chatStore.createSession({ agentId: "agent-1", title: "keep" });
    const room = chatStore.createRoom({ name: "keep-room", projectId: "proj-1" });

    db.prepare("UPDATE chat_sessions SET updatedAt = ? WHERE id = ?").run(new Date(Date.now() - 100 * 86_400_000).toISOString(), session.id);
    db.prepare("UPDATE chat_rooms SET updatedAt = ? WHERE id = ?").run(new Date(Date.now() - 100 * 86_400_000).toISOString(), room.id);

    const manager = buildManager(0);
    await (manager as any).runMaintenance();

    expect(chatStore.getSession(session.id)).toBeDefined();
    expect(chatStore.getRoom(room.id)).toBeDefined();
  });
});
