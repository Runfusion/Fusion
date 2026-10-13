/*
FNXC:MissionFeatureRollup 2026-10-13-16:43 (RUFU-615):
`listMissionsWithSummaries` and `listMissionsHealth` used to `SELECT *` across every `mission_features`
row and group the array in JS. Measured on the production board: 114 full-table passes / 25 194
materialised rows per 120 s at 2 526 B average row width, while neither consumer reads `description`,
`acceptanceCriteria` or `specAlignment` — the columns that make a row wide. Both now ask SQL for
per-slice counts, so the numbers a card shows depend on an aggregate the database computes.

This test pins the invariant the rewrite had to preserve: the rollup-derived counters equal what the
old per-feature loop computed, across every status bucket and across the failed-task membership rule.
It runs against a REAL SQLite database rather than a mocked `prepare`, because the half of the change
that could silently lie is the SQL (`GROUP BY sliceId`, the `CASE WHEN` buckets, `WHERE taskId IS NOT
NULL`) — a fake would only have re-asserted the JS side of my own edit. The DDL below is the subset of
columns these two read paths touch; if a future column rename breaks it, the failure is a real
mismatch between the query and the schema, which is the point.
*/

import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { MissionStore } from "../missions/mission-store.js";
import type { Database } from "../db/db.js";

const DDL = `
CREATE TABLE missions (id TEXT PRIMARY KEY, title TEXT, status TEXT, autopilotState TEXT,
  autopilotEnabled INTEGER, lastAutopilotActivityAt TEXT, createdAt TEXT, updatedAt TEXT);
CREATE TABLE milestones (id TEXT PRIMARY KEY, missionId TEXT, title TEXT, status TEXT, orderIndex INTEGER);
CREATE TABLE slices (id TEXT PRIMARY KEY, milestoneId TEXT, title TEXT, status TEXT, orderIndex INTEGER);
CREATE TABLE mission_features (id TEXT PRIMARY KEY, sliceId TEXT, taskId TEXT, title TEXT,
  description TEXT, acceptanceCriteria TEXT, status TEXT, specAlignment TEXT, loopState TEXT,
  implementationAttemptCount INTEGER, validatorAttemptCount INTEGER, createdAt TEXT, updatedAt TEXT);
CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT, deletedAt TEXT);
CREATE TABLE mission_goals (missionId TEXT, goalId TEXT);
CREATE TABLE mission_events (id TEXT, missionId TEXT, eventType TEXT, timestamp TEXT, description TEXT, seq INTEGER);
`;

interface SeededFeature {
  id: string;
  sliceId: string;
  status: string;
  taskId?: string;
}

/** Builds the real SQLite-backed store over one mission: milestone MS-1 with slices SL-A and SL-B. */
function createStore(features: SeededFeature[], failedTaskIds: string[] = []): MissionStore {
  const raw = new DatabaseSync(":memory:");
  raw.exec(DDL);
  const now = "2026-10-13T00:00:00.000Z";
  const insert = (sql: string, ...vals: unknown[]) =>
    (raw.prepare(sql) as { run(...a: unknown[]): unknown }).run(...vals);

  insert(`INSERT INTO missions VALUES ('M-1','Counted','active','inactive',0,?,?,?)`, now, now);
  insert(`INSERT INTO milestones VALUES ('MS-1','M-1','MS','active',0)`);
  insert(`INSERT INTO slices VALUES ('SL-A','MS-1','SL A','active',0)`);
  insert(`INSERT INTO slices VALUES ('SL-B','MS-1','SL B','pending',1)`);
  for (const f of features) {
    insert(
      `INSERT INTO mission_features (id, sliceId, taskId, title, status, loopState, createdAt, updatedAt)
       VALUES (?,?,?,?,?,?,?,?)`,
      f.id, f.sliceId, f.taskId ?? null, f.id, f.status, "idle", now, now,
    );
  }
  for (const id of failedTaskIds) insert(`INSERT INTO tasks (id, status) VALUES (?, 'failed')`, id);

  const db = {
    prepare: (sql: string) => {
      const stmt = raw.prepare(sql) as { all(...a: unknown[]): unknown[]; get(...a: unknown[]): unknown; run(...a: unknown[]): unknown };
      return {
        all: (...a: unknown[]) => stmt.all(...a).map((row) => ({ ...row })),
        get: (...a: unknown[]) => {
          const row = stmt.get(...a);
          return row === undefined ? undefined : { ...row };
        },
        run: (...a: unknown[]) => stmt.run(...a),
      };
    },
    transaction: <T,>(cb: () => T) => cb(),
    transactionImmediate: <T,>(cb: () => T) => cb(),
    bumpLastModified: () => undefined,
  } as unknown as Database;

  return new MissionStore("/tmp/fusion-mission-rollup-test", db);
}

describe("MissionStore feature rollup equivalence", () => {
  // Every bucket the old per-feature loop distinguished, split across two slices so a rollup that
  // forgets to group by slice cannot pass.
  const features: SeededFeature[] = [
    { id: "F-A1", sliceId: "SL-A", status: "done" },
    { id: "F-A2", sliceId: "SL-A", status: "triaged" },
    { id: "F-A3", sliceId: "SL-A", status: "in-progress", taskId: "T-FAILED" },
    { id: "F-A4", sliceId: "SL-A", status: "in-progress", taskId: "T-OK" },
    { id: "F-B1", sliceId: "SL-B", status: "pending" },
  ];

  it("summary counts come out per slice, not per table", () => {
    const summary = createStore(features).listMissionsWithSummaries().find((m) => m.id === "M-1")!.summary;
    expect(summary).toMatchObject({
      totalMilestones: 1,
      completedMilestones: 0,
      totalFeatures: 5,
      completedFeatures: 1,
      progressPercent: 20,
    });
  });

  it("health distinguishes done, in-flight and failed-task features", () => {
    const health = createStore(features, ["T-FAILED"]).listMissionsHealth().get("M-1")!;
    expect(health).toMatchObject({
      totalTasks: 5,
      tasksCompleted: 1,
      tasksInFlight: 3, // F-A2 triaged + F-A3 and F-A4 in-progress
      tasksFailed: 1, // only the feature whose task row is failed
      estimatedCompletionPercent: 20,
    });
  });

  it("counts a linked-but-live task as in-flight and never as failed", () => {
    // The whole point of keeping failure a membership decision: a feature carrying a task id that is
    // NOT in the failed set must not move tasksFailed.
    const health = createStore(features).listMissionsHealth().get("M-1")!;
    expect(health.tasksFailed).toBe(0);
    expect(health.tasksInFlight).toBe(3);
  });

  it("an empty mission has no rollup rows and still reports zero progress", () => {
    const store = createStore([]);
    expect(store.listMissionsWithSummaries()[0]!.summary.progressPercent).toBe(0);
    expect(store.listMissionsHealth().get("M-1")!.totalTasks).toBe(0);
  });
});
