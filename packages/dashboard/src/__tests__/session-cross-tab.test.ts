/**
 * Covers optimistic locking and cross-tab continuity primitives:
 * lock conflicts, beacon release, stale lock expiry, SSE summaries, and stale cleanup.
 */

// @vitest-environment node

import express from "express";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setImmediate } from "node:timers";
import { join } from "node:path";
import { Database, TaskStore } from "@fusion/core";
import { AiSessionStore, type AiSessionRow } from "../ai-session-store.js";
import { createApiRoutes } from "../routes.js";
import { request } from "../test-request.js";

function makeRow(id: string, overrides: Partial<AiSessionRow> = {}): AiSessionRow {
  const now = new Date().toISOString();
  return {
    id,
    type: "planning",
    status: "awaiting_input",
    title: `Session ${id}`,
    inputPayload: JSON.stringify({ initialPlan: "Cross-tab lock test" }),
    conversationHistory: "[]",
    currentQuestion: JSON.stringify({ id: "q-1", type: "text", question: "Q" }),
    result: null,
    thinkingOutput: "",
    error: null,
    projectId: "proj-locks",
    createdAt: now,
    updatedAt: now,
    lockedByTab: null,
    lockedAt: null,
    ...overrides,
  };
}

describe("cross-tab session locking", () => {
  let tmpRoot: string;
  let taskStore: TaskStore;
  let db: Database;
  let aiSessionStore: AiSessionStore;
  let app: express.Express;

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "kb-session-cross-tab-"));
    taskStore = new TaskStore(tmpRoot, join(tmpRoot, ".fusion-global-settings"), { inMemoryDb: true });
    await taskStore.init();
    /*
    FNXC:DashboardSessionTests 2026-06-14-09:10:
    AiSessionStore uses SQLite files that must be closed independently before tmpRoot cleanup. Keep it on a dedicated Database handle outside TaskStore's .fusion directory so TaskStore teardown cannot leave session-store writers racing recursive rm.
    */
    db = new Database(join(tmpRoot, ".fusion-ai-sessions"));
    db.init();
    aiSessionStore = new AiSessionStore(db);

    app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(taskStore, { aiSessionStore }));
  });

  afterEach(async () => {
    try {
      taskStore.close();
    } catch {
      // no-op
    }
    try {
      db.close();
    } catch {
      // no-op
    }
    // FNXC:DashboardSessionTests 2026-06-14-09:20: TaskStore.close() closes watcher/database handles synchronously but their filesystem close callbacks settle on the next event-loop turn; drain that turn before deleting .fusion.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("enforces optimistic lock conflicts and reports current holder", () => {
    aiSessionStore.upsert(makeRow("lock-conflict"));

    const first = aiSessionStore.acquireLock("lock-conflict", "tab-a");
    const second = aiSessionStore.acquireLock("lock-conflict", "tab-b");

    expect(first).toEqual({ acquired: true, currentHolder: null });
    expect(second).toEqual({ acquired: false, currentHolder: "tab-a" });
    expect(aiSessionStore.getLockHolder("lock-conflict").tabId).toBe("tab-a");
  });

  it("supports concurrent lock attempts where only one tab acquires", async () => {
    aiSessionStore.upsert(makeRow("lock-race"));

    const [resultA, resultB] = await Promise.all([
      Promise.resolve(aiSessionStore.acquireLock("lock-race", "tab-a")),
      Promise.resolve(aiSessionStore.acquireLock("lock-race", "tab-b")),
    ]);

    const acquiredCount = [resultA, resultB].filter((result) => result.acquired).length;
    const denied = [resultA, resultB].find((result) => !result.acquired);

    expect(acquiredCount).toBe(1);
    expect(denied?.currentHolder).toMatch(/^tab-[ab]$/);
  });

  it("releases lock on tab close beacon endpoint", async () => {
    aiSessionStore.upsert(makeRow("lock-beacon"));
    aiSessionStore.acquireLock("lock-beacon", "tab-a");

    const response = await request(
      app,
      "DELETE",
      "/api/ai-sessions/lock-beacon/lock/beacon?tabId=tab-a",
    );

    expect(response.status).toBe(200);
    expect(aiSessionStore.getLockHolder("lock-beacon")).toEqual({ tabId: null, lockedAt: null });
  });

  it("expires stale locks and clears ownership", () => {
    aiSessionStore.upsert(makeRow("lock-expiry"));
    aiSessionStore.acquireLock("lock-expiry", "tab-expired");

    const staleTimestamp = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    db.prepare("UPDATE ai_sessions SET lockedAt = ? WHERE id = ?").run(staleTimestamp, "lock-expiry");

    const released = aiSessionStore.releaseStaleLocks(30 * 60 * 1000);

    expect(released).toBe(1);
    expect(aiSessionStore.getLockHolder("lock-expiry")).toEqual({ tabId: null, lockedAt: null });
  });

  it("emits ai_session:updated summaries on lock acquisition/release transitions", () => {
    aiSessionStore.upsert(makeRow("lock-sse"));
    const summaries: Array<{ id: string; lockedByTab: string | null }> = [];

    aiSessionStore.on("ai_session:updated", (summary) => {
      summaries.push({ id: summary.id, lockedByTab: summary.lockedByTab });
    });

    aiSessionStore.acquireLock("lock-sse", "tab-a");
    aiSessionStore.releaseLock("lock-sse", "tab-a");
    aiSessionStore.forceAcquireLock("lock-sse", "tab-b");

    expect(summaries).toEqual(
      expect.arrayContaining([
        { id: "lock-sse", lockedByTab: "tab-a" },
        { id: "lock-sse", lockedByTab: null },
        { id: "lock-sse", lockedByTab: "tab-b" },
      ]),
    );

    const listActive = aiSessionStore.listActive("proj-locks");
    const latest = listActive.find((session) => session.id === "lock-sse");
    expect(latest?.lockedByTab).toBe("tab-b");
  });

  it("cleans stale active sessions and leaves fresh sessions intact", () => {
    aiSessionStore.upsert(makeRow("stale-generating", { status: "generating" }));
    aiSessionStore.upsert(makeRow("stale-awaiting", { status: "awaiting_input" }));
    aiSessionStore.upsert(makeRow("fresh-generating", { status: "generating" }));

    const stale = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const fresh = new Date(Date.now() - 60 * 1000).toISOString();
    db.prepare("UPDATE ai_sessions SET updatedAt = ? WHERE id IN (?, ?)").run(
      stale,
      "stale-generating",
      "stale-awaiting",
    );
    db.prepare("UPDATE ai_sessions SET updatedAt = ? WHERE id = ?").run(fresh, "fresh-generating");

    const summary = aiSessionStore.cleanupStaleSessions(7 * 24 * 60 * 60 * 1000);

    expect(summary.orphanedDeleted).toBe(2);
    expect(aiSessionStore.get("stale-generating")).toBeNull();
    expect(aiSessionStore.get("stale-awaiting")).toBeNull();
    expect(aiSessionStore.get("fresh-generating")).not.toBeNull();
  });
});
