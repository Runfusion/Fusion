import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "@fusion/core";
import {
  AiSessionStore,
  SESSION_CLEANUP_DEFAULT_MAX_AGE_MS,
  type AiSessionRow,
  type AiSessionStatus,
} from "../ai-session-store.js";
import { resetDiagnosticsSink, setDiagnosticsSink, type LogEntry } from "../ai-session-diagnostics.js";

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
    resetDiagnosticsSink();
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

  function captureDiagnostics(): LogEntry[] {
    const entries: LogEntry[] = [];
    setDiagnosticsSink((level, scope, message, context) => {
      entries.push({
        level,
        scope,
        message,
        context,
        timestamp: new Date(),
      });
    });
    return entries;
  }

  it("cleanupOld removes only stale terminal sessions and emits deleted events", () => {
    const deletedIds: string[] = [];
    store.on("ai_session:deleted", (id) => deletedIds.push(id));

    seedSession({ id: "S-complete", status: "complete", ageMs: 2 * 60 * 60 * 1000 });
    seedSession({ id: "S-error", status: "error", ageMs: 2 * 60 * 60 * 1000 });
    seedSession({ id: "S-generating", status: "generating", ageMs: 2 * 60 * 60 * 1000 });
    seedSession({ id: "S-awaiting", status: "awaiting_input", ageMs: 2 * 60 * 60 * 1000 });

    const removed = store.cleanupOld(60 * 60 * 1000);

    expect(removed).toBe(2);
    expect(store.get("S-complete")).toBeNull();
    expect(store.get("S-error")).toBeNull();
    expect(store.get("S-generating")).not.toBeNull();
    expect(store.get("S-awaiting")).not.toBeNull();
    expect(deletedIds.sort()).toEqual(["S-complete", "S-error"]);
  });

  it("cleanupStaleSessions removes stale terminal and orphaned sessions with summary", () => {
    seedSession({ id: "S-complete-old", status: "complete", ageMs: 8 * 24 * 60 * 60 * 1000 });
    seedSession({ id: "S-error-old", status: "error", ageMs: 8 * 24 * 60 * 60 * 1000 });
    seedSession({ id: "S-generating-old", status: "generating", ageMs: 8 * 24 * 60 * 60 * 1000 });
    seedSession({ id: "S-awaiting-old", status: "awaiting_input", ageMs: 8 * 24 * 60 * 60 * 1000 });
    seedSession({ id: "S-generating-fresh", status: "generating", ageMs: 2 * 24 * 60 * 60 * 1000 });

    const summary = store.cleanupStaleSessions();

    expect(summary).toEqual({
      terminalDeleted: 2,
      orphanedDeleted: 2,
      totalDeleted: 4,
    });
    expect(store.get("S-complete-old")).toBeNull();
    expect(store.get("S-error-old")).toBeNull();
    expect(store.get("S-generating-old")).toBeNull();
    expect(store.get("S-awaiting-old")).toBeNull();
    expect(store.get("S-generating-fresh")).not.toBeNull();
  });

  it("cleanupStaleSessions emits structured diagnostics with cleanup summary counts", () => {
    const diagnostics = captureDiagnostics();

    seedSession({ id: "S-complete-old", status: "complete", ageMs: 8 * 24 * 60 * 60 * 1000 });
    seedSession({ id: "S-error-old", status: "error", ageMs: 8 * 24 * 60 * 60 * 1000 });
    seedSession({ id: "S-generating-old", status: "generating", ageMs: 8 * 24 * 60 * 60 * 1000 });

    const summary = store.cleanupStaleSessions();

    expect(summary).toEqual({
      terminalDeleted: 2,
      orphanedDeleted: 1,
      totalDeleted: 3,
    });

    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        level: "info",
        scope: "ai-session-store",
        message: "Cleanup removed stale sessions",
        context: expect.objectContaining({
          terminalDeleted: 2,
          orphanedDeleted: 1,
          totalDeleted: 3,
          maxAgeMs: SESSION_CLEANUP_DEFAULT_MAX_AGE_MS,
          operation: "cleanup-stale-sessions",
        }),
      }),
    );
  });

  it("cleanupStaleSessions respects explicit maxAgeMs values", () => {
    seedSession({ id: "S-complete-older", status: "complete", ageMs: 2 * 60 * 60 * 1000 });
    seedSession({ id: "S-awaiting-older", status: "awaiting_input", ageMs: 2 * 60 * 60 * 1000 });
    seedSession({ id: "S-error-recent", status: "error", ageMs: 30 * 60 * 1000 });

    const summary = store.cleanupStaleSessions(60 * 60 * 1000);

    expect(summary).toEqual({
      terminalDeleted: 1,
      orphanedDeleted: 1,
      totalDeleted: 2,
    });
    expect(store.get("S-complete-older")).toBeNull();
    expect(store.get("S-awaiting-older")).toBeNull();
    expect(store.get("S-error-recent")).not.toBeNull();
  });

  it("cleanupStaleSessions defaults to 7-day max age", () => {
    seedSession({ id: "S-complete-6days", status: "complete", ageMs: SESSION_CLEANUP_DEFAULT_MAX_AGE_MS - 60_000 });
    seedSession({ id: "S-complete-8days", status: "complete", ageMs: SESSION_CLEANUP_DEFAULT_MAX_AGE_MS + 60_000 });

    const summary = store.cleanupStaleSessions();

    expect(summary).toEqual({
      terminalDeleted: 1,
      orphanedDeleted: 0,
      totalDeleted: 1,
    });
    expect(store.get("S-complete-6days")).not.toBeNull();
    expect(store.get("S-complete-8days")).toBeNull();
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

  it("startScheduledCleanup emits structured error diagnostics and remains non-fatal on cleanup failure", () => {
    vi.useFakeTimers();
    const diagnostics = captureDiagnostics();

    const cleanupSpy = vi
      .spyOn(store, "cleanupStaleSessions")
      .mockImplementation(() => {
        throw new Error("boom");
      });

    store.startScheduledCleanup(1_000, 60_000);

    expect(() => vi.advanceTimersByTime(2_000)).not.toThrow();
    expect(cleanupSpy).toHaveBeenCalledTimes(2);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        scope: "ai-session-store",
        message: "Scheduled cleanup failed",
        context: expect.objectContaining({
          ttlMs: 60_000,
          operation: "scheduled-cleanup",
          error: expect.objectContaining({ message: "boom" }),
        }),
      }),
    );
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

  it("recoverStaleSessions emits structured diagnostics when stale sessions are recovered", () => {
    const diagnostics = captureDiagnostics();

    seedSession({
      id: "S-recoverable",
      status: "generating",
      currentQuestion: { id: "q-1", type: "text", question: "Continue?" },
    });
    seedSession({ id: "S-broken", status: "generating", currentQuestion: null });

    const recovered = store.recoverStaleSessions();

    expect(recovered).toBe(2);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        level: "info",
        scope: "ai-session-store",
        message: "Recovered stale sessions after restart",
        context: expect.objectContaining({
          recovered: 2,
          operation: "recover-stale-sessions",
        }),
      }),
    );
  });

  it("listActive returns generating/awaiting_input/error sessions", () => {
    seedSession({ id: "S-generating", status: "generating" });
    seedSession({ id: "S-awaiting", status: "awaiting_input" });
    seedSession({ id: "S-complete", status: "complete" });
    seedSession({ id: "S-error", status: "error" });

    const active = store.listActive();

    expect(active.map((session) => session.status).sort()).toEqual(["awaiting_input", "error", "generating"]);
    expect(active.map((session) => session.id).sort()).toEqual(["S-awaiting", "S-error", "S-generating"]);
  });

  it("listActive filters by projectId", () => {
    seedSession({ id: "S-a1", status: "generating", projectId: "project-a" });
    seedSession({ id: "S-a2", status: "awaiting_input", projectId: "project-a" });
    seedSession({ id: "S-a3", status: "error", projectId: "project-a" });
    seedSession({ id: "S-b1", status: "awaiting_input", projectId: "project-b" });
    seedSession({ id: "S-a-done", status: "complete", projectId: "project-a" });

    const projectA = store.listActive("project-a");

    expect(projectA).toHaveLength(3);
    expect(projectA.map((session) => session.id).sort()).toEqual(["S-a1", "S-a2", "S-a3"]);
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

  it("updateStatus atomically transitions status and clears error when omitted", () => {
    seedSession({ id: "S-retry", status: "error", error: "Transient failure" });

    const onUpdated = vi.fn();
    store.on("ai_session:updated", onUpdated);

    const updated = store.updateStatus("S-retry", "generating");

    expect(updated).toBe(true);
    expect(store.get("S-retry")?.status).toBe("generating");
    expect(store.get("S-retry")?.error).toBeNull();
    expect(onUpdated).toHaveBeenCalledTimes(1);
    expect(onUpdated).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "S-retry",
        status: "generating",
      }),
    );
  });

  it("updateStatus sets explicit error and returns false for missing session", () => {
    seedSession({ id: "S-failed", status: "generating" });

    expect(store.updateStatus("S-failed", "error", "Agent crashed")).toBe(true);
    expect(store.get("S-failed")?.status).toBe("error");
    expect(store.get("S-failed")?.error).toBe("Agent crashed");

    expect(store.updateStatus("S-missing", "error", "Nope")).toBe(false);
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
