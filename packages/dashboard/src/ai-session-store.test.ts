import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "@fusion/core";
import { AiSessionStore, type AiSessionRow, type AiSessionStatus } from "./ai-session-store.js";

describe("AiSessionStore", () => {
  let tmpRoot: string;
  let db: Database;
  let store: AiSessionStore;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "kb-ai-session-store-"));
    db = new Database(join(tmpRoot, ".fusion"));
    db.init();
    store = new AiSessionStore(db);
  });

  afterEach(async () => {
    store.stopScheduledCleanup();
    vi.useRealTimers();
    try {
      db.close();
    } catch {
      // no-op
    }
    await rm(tmpRoot, { recursive: true, force: true });
  });

  function makeRow(id: string, status: AiSessionStatus, projectId: string | null = null): AiSessionRow {
    const now = new Date().toISOString();
    return {
      id,
      type: "planning",
      status,
      title: `Session ${id}`,
      inputPayload: JSON.stringify({ plan: `plan-${id}` }),
      conversationHistory: "[]",
      currentQuestion: null,
      result: status === "complete" ? JSON.stringify({ title: "Done" }) : null,
      thinkingOutput: "",
      error: status === "error" ? "boom" : null,
      projectId,
      createdAt: now,
      updatedAt: now,
    };
  }

  function seedSession(params: {
    id: string;
    status: AiSessionStatus;
    ageMs?: number;
    projectId?: string | null;
    currentQuestion?: object | null;
    error?: string | null;
  }): void {
    const { id, status, ageMs = 0, projectId = null, currentQuestion = null, error } = params;
    const row = makeRow(id, status, projectId);
    row.currentQuestion = currentQuestion ? JSON.stringify(currentQuestion) : null;
    row.error = error ?? row.error;
    store.upsert(row);

    if (ageMs > 0) {
      const staleTs = new Date(Date.now() - ageMs).toISOString();
      db.prepare("UPDATE ai_sessions SET updatedAt = ? WHERE id = ?").run(staleTs, id);
    }
  }

  it("cleanupOld removes stale sessions across all statuses and emits deleted events", () => {
    const deletedIds: string[] = [];
    store.on("ai_session:deleted", (id) => deletedIds.push(id));

    seedSession({ id: "S-complete", status: "complete", ageMs: 2 * 60 * 60 * 1000 });
    seedSession({ id: "S-error", status: "error", ageMs: 2 * 60 * 60 * 1000 });
    seedSession({ id: "S-generating", status: "generating", ageMs: 2 * 60 * 60 * 1000 });
    seedSession({ id: "S-awaiting", status: "awaiting_input", ageMs: 2 * 60 * 60 * 1000 });
    seedSession({ id: "S-fresh", status: "generating", ageMs: 5 * 60 * 1000 });

    const removed = store.cleanupOld(60 * 60 * 1000);

    expect(removed).toBe(4);
    expect(store.get("S-complete")).toBeNull();
    expect(store.get("S-error")).toBeNull();
    expect(store.get("S-generating")).toBeNull();
    expect(store.get("S-awaiting")).toBeNull();
    expect(store.get("S-fresh")).not.toBeNull();
    expect(deletedIds.sort()).toEqual(["S-awaiting", "S-complete", "S-error", "S-generating"]);
  });

  it("cleanupOld marks stale generating/awaiting_input sessions as error before delete", () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_session_status_audit (
        id TEXT NOT NULL,
        oldStatus TEXT NOT NULL,
        newStatus TEXT NOT NULL,
        error TEXT
      );
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_ai_sessions_mark_expired
      AFTER UPDATE OF status ON ai_sessions
      WHEN NEW.status = 'error' AND OLD.status IN ('generating', 'awaiting_input')
      BEGIN
        INSERT INTO ai_session_status_audit (id, oldStatus, newStatus, error)
        VALUES (NEW.id, OLD.status, NEW.status, NEW.error);
      END;
    `);

    seedSession({ id: "S-generating", status: "generating", ageMs: 2 * 60 * 60 * 1000, error: null });
    seedSession({ id: "S-awaiting", status: "awaiting_input", ageMs: 2 * 60 * 60 * 1000, error: null });

    store.cleanupOld(60 * 60 * 1000);

    const auditRows = db
      .prepare("SELECT id, oldStatus, newStatus, error FROM ai_session_status_audit ORDER BY id")
      .all() as Array<{ id: string; oldStatus: string; newStatus: string; error: string }>;

    expect(auditRows).toEqual([
      {
        id: "S-awaiting",
        oldStatus: "awaiting_input",
        newStatus: "error",
        error: "Session expired",
      },
      {
        id: "S-generating",
        oldStatus: "generating",
        newStatus: "error",
        error: "Session expired",
      },
    ]);
  });

  it("startScheduledCleanup and stopScheduledCleanup control cleanup interval", () => {
    vi.useFakeTimers();

    seedSession({ id: "S-old", status: "complete", ageMs: 2 * 60 * 1000 });

    store.startScheduledCleanup(1_000, 60_000);
    vi.advanceTimersByTime(1_000);

    expect(store.get("S-old")).toBeNull();

    seedSession({ id: "S-old-2", status: "complete", ageMs: 2 * 60 * 1000 });
    store.stopScheduledCleanup();

    vi.advanceTimersByTime(5_000);
    expect(store.get("S-old-2")).not.toBeNull();
  });

  it("supports configurable TTL values", () => {
    seedSession({ id: "S-older", status: "complete", ageMs: 2 * 60 * 60 * 1000 });
    seedSession({ id: "S-recent", status: "complete", ageMs: 30 * 60 * 1000 });

    const removedWithShortTtl = store.cleanupOld(60 * 60 * 1000);

    expect(removedWithShortTtl).toBe(1);
    expect(store.get("S-older")).toBeNull();
    expect(store.get("S-recent")).not.toBeNull();

    const removedWithLongTtl = store.cleanupOld(3 * 60 * 60 * 1000);
    expect(removedWithLongTtl).toBe(0);
  });

  it("recoverStaleSessions keeps recoverable sessions and marks unrecoverable ones as error", () => {
    seedSession({
      id: "S-recoverable",
      status: "generating",
      currentQuestion: { id: "q-1", type: "text", question: "Continue?" },
    });
    seedSession({ id: "S-broken", status: "generating", currentQuestion: null });

    const recovered = store.recoverStaleSessions();

    expect(recovered).toBe(2);
    expect(store.get("S-recoverable")?.status).toBe("awaiting_input");
    expect(store.get("S-broken")?.status).toBe("error");
    expect(store.get("S-broken")?.error).toBe("Session interrupted — please restart");
  });

  it("listActive only returns generating/awaiting_input sessions", () => {
    seedSession({ id: "S-generating", status: "generating" });
    seedSession({ id: "S-awaiting", status: "awaiting_input" });
    seedSession({ id: "S-complete", status: "complete" });
    seedSession({ id: "S-error", status: "error" });

    const active = store.listActive();

    expect(active.map((session) => session.status).sort()).toEqual(["awaiting_input", "generating"]);
    expect(active.map((session) => session.id).sort()).toEqual(["S-awaiting", "S-generating"]);
  });

  it("listActive filters by projectId", () => {
    seedSession({ id: "S-a1", status: "generating", projectId: "project-a" });
    seedSession({ id: "S-a2", status: "awaiting_input", projectId: "project-a" });
    seedSession({ id: "S-b1", status: "awaiting_input", projectId: "project-b" });
    seedSession({ id: "S-a-done", status: "complete", projectId: "project-a" });

    const projectA = store.listActive("project-a");

    expect(projectA).toHaveLength(2);
    expect(projectA.map((session) => session.id).sort()).toEqual(["S-a1", "S-a2"]);
    expect(projectA.every((session) => session.projectId === "project-a")).toBe(true);
  });

  it("ping updates updatedAt for existing sessions without emitting updates", () => {
    seedSession({ id: "S-ping", status: "awaiting_input" });

    const staleTs = new Date(Date.now() - 60_000).toISOString();
    db.prepare("UPDATE ai_sessions SET updatedAt = ? WHERE id = ?").run(staleTs, "S-ping");

    const onUpdated = vi.fn();
    store.on("ai_session:updated", onUpdated);

    const updated = store.ping("S-ping");

    expect(updated).toBe(true);
    expect(store.get("S-ping")?.updatedAt).not.toBe(staleTs);
    expect(onUpdated).not.toHaveBeenCalled();
  });

  it("ping returns false for nonexistent sessions", () => {
    const onUpdated = vi.fn();
    store.on("ai_session:updated", onUpdated);

    expect(store.ping("missing-session")).toBe(false);
    expect(onUpdated).not.toHaveBeenCalled();
  });

  it("listRecoverable returns awaiting_input and generating sessions", () => {
    seedSession({ id: "S-generating", status: "generating", ageMs: 3_000 });
    seedSession({ id: "S-awaiting", status: "awaiting_input", ageMs: 1_000 });
    seedSession({ id: "S-complete", status: "complete" });

    const recoverable = store.listRecoverable();

    expect(recoverable.map((session) => session.id)).toEqual(["S-awaiting", "S-generating"]);
    expect(recoverable.map((session) => session.status).sort()).toEqual(["awaiting_input", "generating"]);
  });

  it("listRecoverable excludes complete and error sessions", () => {
    seedSession({ id: "S-complete", status: "complete" });
    seedSession({ id: "S-error", status: "error" });

    const recoverable = store.listRecoverable();

    expect(recoverable).toEqual([]);
  });

  it("listRecoverable filters by projectId", () => {
    seedSession({ id: "S-a1", status: "generating", projectId: "project-a" });
    seedSession({ id: "S-a2", status: "awaiting_input", projectId: "project-a" });
    seedSession({ id: "S-b1", status: "awaiting_input", projectId: "project-b" });

    const projectA = store.listRecoverable("project-a");

    expect(projectA).toHaveLength(2);
    expect(projectA.map((session) => session.id).sort()).toEqual(["S-a1", "S-a2"]);
    expect(projectA.every((session) => session.projectId === "project-a")).toBe(true);
  });

  it("listRecoverable returns full AiSessionRow objects", () => {
    seedSession({
      id: "S-full",
      status: "awaiting_input",
      projectId: "project-a",
      currentQuestion: { id: "q-1", type: "text", question: "Next?" },
    });

    const [row] = store.listRecoverable();

    expect(row).toMatchObject({
      id: "S-full",
      type: "planning",
      status: "awaiting_input",
      title: "Session S-full",
      inputPayload: expect.any(String),
      conversationHistory: expect.any(String),
      currentQuestion: expect.any(String),
      result: null,
      thinkingOutput: expect.any(String),
      error: null,
      projectId: "project-a",
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
  });
});
