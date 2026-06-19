import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Database } from "../db.js";
import { emitUsageEvent } from "../usage-events.js";
import { aggregateToolAnalytics, countInterventions } from "../tool-analytics.js";
import type { SteeringComment } from "../types.js";

function insertTaskWithSteers(db: Database, id: string, steers: SteeringComment[]): void {
  db.prepare(
    `INSERT INTO tasks (id, description, "column", createdAt, updatedAt, steeringComments)
     VALUES (?, 'desc', 'todo', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ?)`,
  ).run(id, JSON.stringify(steers));
}

function insertApprovalRequest(db: Database, id: string): void {
  db.prepare(
    `INSERT INTO approval_requests
       (id, status, requesterActorId, requesterActorType, requesterActorName,
        targetActionCategory, targetActionOperation, targetActionSummary,
        targetResourceType, targetResourceId, requestedAt, createdAt, updatedAt)
     VALUES (?, 'pending', 'a', 'agent', 'A', 'cat', 'op', 'sum', 'res', 'r1',
             '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z')`,
  ).run(id);
}

function insertApprovalEvent(db: Database, id: string, requestId: string, eventType: string, createdAt: string): void {
  db.prepare(
    `INSERT INTO approval_request_audit_events
       (id, requestId, eventType, actorId, actorType, actorName, createdAt)
     VALUES (?, ?, ?, 'u1', 'user', 'User', ?)`,
  ).run(id, requestId, eventType, createdAt);
}

describe("tool-analytics", () => {
  let tmpDir: string;
  let db: Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kb-tool-analytics-"));
    db = new Database(join(tmpDir, ".fusion"));
    db.init();
  });

  afterEach(async () => {
    db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("counts tool calls by category, sorted descending", () => {
    emitUsageEvent(db, { kind: "tool_call", category: "read", ts: "2026-03-01T00:00:00.000Z" });
    emitUsageEvent(db, { kind: "tool_call", category: "read", ts: "2026-03-01T01:00:00.000Z" });
    emitUsageEvent(db, { kind: "tool_call", category: "edit", ts: "2026-03-01T02:00:00.000Z" });
    // a non-tool_call event is not counted
    emitUsageEvent(db, { kind: "user_message", ts: "2026-03-01T03:00:00.000Z" });

    const result = aggregateToolAnalytics(db, { from: "2026-03-01T00:00:00.000Z", to: "2026-03-31T00:00:00.000Z" });
    expect(result.toolCalls).toBe(3);
    expect(result.byCategory).toEqual([
      { category: "read", count: 2 },
      { category: "edit", count: 1 },
    ]);
  });

  it("re-buckets historical other tool calls by tool name while preserving explicit categories", () => {
    const ts = "2026-03-01T00:00:00.000Z";
    emitUsageEvent(db, { kind: "tool_call", toolName: "fn_task_create", category: "other", ts });
    emitUsageEvent(db, { kind: "tool_call", toolName: "fn_research_run", category: "other", ts });
    emitUsageEvent(db, { kind: "tool_call", toolName: "fn_memory_append", category: null, ts });
    emitUsageEvent(db, { kind: "tool_call", toolName: "fn_mission_show", category: "other", ts });
    emitUsageEvent(db, { kind: "tool_call", toolName: "fn_skills_search", category: "other", ts });
    emitUsageEvent(db, { kind: "tool_call", toolName: "Read", category: "other", ts });
    emitUsageEvent(db, { kind: "tool_call", toolName: "Bash", category: "other", ts });
    emitUsageEvent(db, { kind: "tool_call", toolName: "Unknown", category: "other", ts });
    emitUsageEvent(db, { kind: "tool_call", toolName: null, category: "other", ts });
    emitUsageEvent(db, { kind: "tool_call", toolName: "fn_task_update", category: "custom", ts });

    const result = aggregateToolAnalytics(db, { from: "2026-03-01T00:00:00.000Z", to: "2026-03-31T00:00:00.000Z" });
    const byCategory = new Map(result.byCategory.map((row) => [row.category, row.count]));

    expect(result.toolCalls).toBe(10);
    expect(byCategory).toEqual(
      new Map([
        ["other", 2],
        ["custom", 1],
        ["edit", 1],
        ["execute", 1],
        ["memory", 1],
        ["planning", 1],
        ["read", 1],
        ["research", 1],
        ["skills", 1],
      ]),
    );
    expect(result.byCategory[0]).toEqual({ category: "other", count: 2 });
  });

  it("autonomy denominator counts a USER steer + an approval but NOT an agent steer", () => {
    insertTaskWithSteers(db, "task-1", [
      { id: "s1", text: "do X", createdAt: "2026-03-02T00:00:00.000Z", author: "user" },
      { id: "s2", text: "agent note", createdAt: "2026-03-02T01:00:00.000Z", author: "agent" },
    ]);
    insertApprovalRequest(db, "req-1");
    insertApprovalEvent(db, "ev-created", "req-1", "created", "2026-03-02T00:30:00.000Z");
    insertApprovalEvent(db, "ev-approved", "req-1", "approved", "2026-03-02T00:31:00.000Z");
    // a non-human eventType must NOT count
    insertApprovalEvent(db, "ev-completed", "req-1", "completed", "2026-03-02T00:32:00.000Z");

    const breakdown = countInterventions(db, { from: "2026-03-01T00:00:00.000Z", to: "2026-03-31T00:00:00.000Z" });
    expect(breakdown.userSteers).toBe(1); // agent steer excluded
    expect(breakdown.approvals).toBe(2); // created + approved, completed excluded
    expect(breakdown.total).toBe(3);
  });

  it("autonomy ratio = toolCalls / interventions for an interactive session", () => {
    // 12 tool calls, 3 interventions (1 user steer + 2 approvals) -> ratio 4
    for (let i = 0; i < 12; i++) {
      emitUsageEvent(db, { kind: "tool_call", category: "read", ts: `2026-03-02T00:0${i % 6}:0${i % 6}.000Z` });
    }
    emitUsageEvent(db, { kind: "session_start", ts: "2026-03-02T00:00:00.000Z" });
    insertTaskWithSteers(db, "task-1", [{ id: "s1", text: "x", createdAt: "2026-03-02T00:10:00.000Z", author: "user" }]);
    insertApprovalRequest(db, "req-1");
    insertApprovalEvent(db, "ev-c", "req-1", "created", "2026-03-02T00:11:00.000Z");
    insertApprovalEvent(db, "ev-a", "req-1", "approved", "2026-03-02T00:12:00.000Z");

    const result = aggregateToolAnalytics(db, { from: "2026-03-01T00:00:00.000Z", to: "2026-03-31T00:00:00.000Z" });
    expect(result.interventions.total).toBe(3);
    expect(result.toolCalls).toBe(12);
    expect(result.autonomyRatio).toBe(4);
    expect(result.fullyAutonomous).toBe(false);
  });

  it("fully-autonomous session (zero interventions) reports tool-calls-per-session, not infinity", () => {
    // 10 tool calls across 2 sessions, zero interventions -> 5 per session
    for (let i = 0; i < 10; i++) {
      emitUsageEvent(db, { kind: "tool_call", category: "execute", ts: "2026-03-02T00:00:00.000Z" });
    }
    emitUsageEvent(db, { kind: "session_start", ts: "2026-03-02T00:00:00.000Z" });
    emitUsageEvent(db, { kind: "session_start", ts: "2026-03-02T01:00:00.000Z" });

    const result = aggregateToolAnalytics(db, { from: "2026-03-01T00:00:00.000Z", to: "2026-03-31T00:00:00.000Z" });
    expect(result.interventions.total).toBe(0);
    expect(result.fullyAutonomous).toBe(true);
    expect(result.autonomyRatio).toBe(5);
    expect(Number.isFinite(result.autonomyRatio)).toBe(true);
  });

  it("zero interventions and zero sessions does not divide by zero", () => {
    for (let i = 0; i < 4; i++) {
      emitUsageEvent(db, { kind: "tool_call", category: "read", ts: "2026-03-02T00:00:00.000Z" });
    }
    const result = aggregateToolAnalytics(db, {});
    expect(result.sessions).toBe(0);
    expect(result.fullyAutonomous).toBe(true);
    // toolCalls / max(sessions, 1) = 4 / 1
    expect(result.autonomyRatio).toBe(4);
  });

  it("empty range returns zeroed structures, not nulls", () => {
    const result = aggregateToolAnalytics(db, { from: "2027-01-01T00:00:00.000Z", to: "2027-12-31T00:00:00.000Z" });
    expect(result.toolCalls).toBe(0);
    expect(result.byCategory).toEqual([]);
    expect(result.sessions).toBe(0);
    expect(result.interventions).toEqual({ approvals: 0, userSteers: 0, total: 0 });
    expect(result.autonomyRatio).toBe(0);
  });

  it("user steers outside the range are not counted", () => {
    insertTaskWithSteers(db, "task-1", [
      { id: "s1", text: "old", createdAt: "2025-01-01T00:00:00.000Z", author: "user" },
      { id: "s2", text: "in range", createdAt: "2026-03-15T00:00:00.000Z", author: "user" },
    ]);
    const breakdown = countInterventions(db, { from: "2026-03-01T00:00:00.000Z", to: "2026-03-31T00:00:00.000Z" });
    expect(breakdown.userSteers).toBe(1);
  });
});
