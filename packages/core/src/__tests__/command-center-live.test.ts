import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Database } from "../db.js";
import { composeLiveSnapshot } from "../command-center-live.js";

function insertSession(
  db: Database,
  opts: {
    id: string;
    taskId?: string | null;
    agentState: string;
    terminationReason?: string | null;
    worktreePath?: string | null;
    purpose?: string;
  },
): void {
  db.prepare(
    `INSERT INTO cli_sessions
       (id, taskId, purpose, projectId, adapterId, agentState, terminationReason, worktreePath, createdAt, updatedAt)
     VALUES (?, ?, ?, 'proj-1', 'claude-local', ?, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    opts.taskId ?? null,
    opts.purpose ?? "execute",
    opts.agentState,
    opts.terminationReason ?? null,
    opts.worktreePath ?? null,
    "2026-03-01T00:00:00.000Z",
    "2026-03-01T00:00:00.000Z",
  );
}

function insertAgent(db: Database, id: string): void {
  db.prepare(
    `INSERT INTO agents (id, name, role, state, createdAt, updatedAt)
     VALUES (?, ?, 'executor', 'idle', ?, ?)`,
  ).run(id, id, "2026-03-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z");
}

function insertRun(
  db: Database,
  opts: { id: string; agentId: string; status: string; taskId?: string },
): void {
  db.prepare(
    `INSERT INTO agentRuns (id, agentId, data, startedAt, endedAt, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    opts.agentId,
    JSON.stringify(opts.taskId ? { taskId: opts.taskId } : {}),
    "2026-03-01T00:00:00.000Z",
    opts.status === "active" ? null : "2026-03-01T01:00:00.000Z",
    opts.status,
  );
}

function insertTask(db: Database, id: string, column: string): void {
  db.prepare(
    `INSERT INTO tasks (id, description, "column", createdAt, updatedAt)
     VALUES (?, 'desc', ?, ?, ?)`,
  ).run(id, column, "2026-03-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z");
}

describe("command-center-live", () => {
  let tmpDir: string;
  let db: Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kb-cc-live-"));
    db = new Database(join(tmpDir, ".fusion"));
    db.init();
  });

  afterEach(async () => {
    db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("composes an empty snapshot with zeroed counts (not nulls)", () => {
    const snap = composeLiveSnapshot(db, Date.parse("2026-03-01T12:00:00.000Z"));
    expect(snap.capturedAt).toBe("2026-03-01T12:00:00.000Z");
    expect(snap.activeSessions).toBe(0);
    expect(snap.activeRuns).toBe(0);
    expect(snap.activeNodes).toBe(0);
    expect(snap.sessions).toEqual([]);
    expect(snap.runs).toEqual([]);
    expect(snap.columns).toEqual([]);
  });

  it("counts active sessions and active nodes, excluding terminal/terminated", () => {
    insertSession(db, { id: "s1", agentState: "busy", worktreePath: "/wt/node-a" });
    insertSession(db, { id: "s2", agentState: "ready", worktreePath: "/wt/node-b" });
    // same worktree as s1 → one distinct node
    insertSession(db, { id: "s3", agentState: "waitingOnInput", worktreePath: "/wt/node-a" });
    // terminal state → excluded
    insertSession(db, { id: "s4", agentState: "done", worktreePath: "/wt/node-c" });
    // terminated → excluded even though state is non-terminal
    insertSession(db, {
      id: "s5",
      agentState: "busy",
      terminationReason: "userExited",
      worktreePath: "/wt/node-d",
    });

    const snap = composeLiveSnapshot(db);
    expect(snap.activeSessions).toBe(3); // s1, s2, s3
    expect(snap.activeNodes).toBe(2); // /wt/node-a, /wt/node-b
    expect(snap.sessions.map((s) => s.id).sort()).toEqual(["s1", "s2", "s3"]);
  });

  it("counts active runs only and extracts taskId from run data", () => {
    insertAgent(db, "agent-1");
    insertRun(db, { id: "r1", agentId: "agent-1", status: "active", taskId: "FN-1" });
    insertRun(db, { id: "r2", agentId: "agent-1", status: "completed", taskId: "FN-2" });
    insertRun(db, { id: "r3", agentId: "agent-1", status: "active" });

    const snap = composeLiveSnapshot(db);
    expect(snap.activeRuns).toBe(2);
    expect(snap.runs.map((r) => r.id).sort()).toEqual(["r1", "r3"]);
    const r1 = snap.runs.find((r) => r.id === "r1");
    expect(r1?.taskId).toBe("FN-1");
    const r3 = snap.runs.find((r) => r.id === "r3");
    expect(r3?.taskId).toBeNull();
  });

  it("produces current per-column task counts", () => {
    insertTask(db, "FN-1", "todo");
    insertTask(db, "FN-2", "todo");
    insertTask(db, "FN-3", "in-progress");
    insertTask(db, "FN-4", "done");

    const snap = composeLiveSnapshot(db);
    const byColumn = Object.fromEntries(snap.columns.map((c) => [c.column, c.count]));
    expect(byColumn).toEqual({ todo: 2, "in-progress": 1, done: 1 });
  });

  it("is a pure read — does not mutate the database", () => {
    insertTask(db, "FN-1", "todo");
    composeLiveSnapshot(db);
    composeLiveSnapshot(db);
    const count = (
      db.prepare(`SELECT COUNT(*) AS count FROM tasks`).get() as { count: number }
    ).count;
    expect(count).toBe(1);
  });
});
