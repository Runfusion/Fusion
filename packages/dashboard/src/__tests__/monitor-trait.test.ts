// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Database } from "@fusion/core";
import type { Task, TaskCreateInput, TaskStore } from "@fusion/core";
import { runMonitorOnRegression, isMonitorFixTask } from "../monitor-trait.js";
import {
  DEFAULT_STORM_GUARD,
  claimIncidentForFixTask,
  ingestIncidentSignal,
  getIncident,
  getOpenIncidentByGroupingKey,
} from "../monitor-store.js";

/**
 * A minimal TaskStore stub: a real Database (for the incidents/deployments
 * tables the monitor store writes) plus a `createTask` that records created
 * tasks so we can assert exactly how many fix tasks were opened.
 */
function makeStore(db: Database): { store: TaskStore; created: Task[] } {
  const created: Task[] = [];
  let seq = 0;
  const store = {
    getDatabase: () => db,
    async createTask(input: TaskCreateInput): Promise<Task> {
      const task = {
        id: `FN-${++seq}`,
        title: input.title,
        description: input.description,
        column: input.column,
        source: input.source,
      } as unknown as Task;
      created.push(task);
      return task;
    },
  } as unknown as TaskStore;
  return { store, created };
}

function makeDb(): { db: Database; tmpDir: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), "kb-monitor-trait-"));
  const db = new Database(join(tmpDir, ".fusion"));
  db.init();
  return { db, tmpDir };
}

describe("monitor-trait runMonitorOnRegression (U13)", () => {
  let db: Database;
  let tmpDir: string;

  beforeEach(() => {
    ({ db, tmpDir } = makeDb());
  });
  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("a post-ship error signal past the gate auto-creates ONE linked fix task in triage", async () => {
    const { store, created } = makeStore(db);
    let outcome;
    // Fire 3 times (threshold) sharing one groupingKey.
    for (let i = 0; i < 3; i += 1) {
      outcome = await runMonitorOnRegression(
        { groupingKey: "g1", title: "Checkout 500s", severity: "error", source: "sentry" },
        { store },
      );
    }
    expect(created).toHaveLength(1);
    expect(outcome?.kind).toBe("fix-task-opened");
    const fix = created[0];
    expect(fix.column).toBe("triage");
    expect(isMonitorFixTask(fix)).toBe(true);
  });

  it("a 100-event burst sharing one groupingKey yields exactly ONE fix task", async () => {
    const { store, created } = makeStore(db);
    for (let i = 0; i < 100; i += 1) {
      await runMonitorOnRegression(
        { groupingKey: "g-burst", title: "Flood", severity: "error" },
        { store },
      );
    }
    expect(created).toHaveLength(1);
  });

  it("a flapping alert (single firing, gate not met) yields NO new task", async () => {
    const { store, created } = makeStore(db);
    const outcome = await runMonitorOnRegression(
      { groupingKey: "g-flap", title: "Blip", severity: "warning" },
      { store },
    );
    expect(created).toHaveLength(0);
    expect(outcome.kind).toBe("suppressed");
  });

  it("an already-open fix task absorbs repeat signals (cooldown, no second task)", async () => {
    const { store, created } = makeStore(db);
    // Open a fix task via threshold.
    for (let i = 0; i < 3; i += 1) {
      await runMonitorOnRegression({ groupingKey: "g1", title: "Down" }, { store });
    }
    expect(created).toHaveLength(1);
    // Further firings absorb.
    const absorbed = await runMonitorOnRegression({ groupingKey: "g1", title: "Down again" }, { store });
    expect(absorbed.kind).toBe("absorbed");
    expect(created).toHaveLength(1);
  });

  it("circuit breaker caps auto-created tasks per window", async () => {
    const { store, created } = makeStore(db);
    const config = { ...DEFAULT_STORM_GUARD, threshold: 1, maxTasksPerWindow: 2 };
    for (let g = 0; g < 5; g += 1) {
      await runMonitorOnRegression({ groupingKey: `g-${g}`, title: "x" }, { store, config });
    }
    expect(created).toHaveLength(2);
  });

  it("the sustained-duration gate opens a task for a low-frequency but long-lived incident", async () => {
    const { store, created } = makeStore(db);
    const past = "2026-03-02T10:00:00.000Z";
    const openMoment = Date.parse(past);
    // Open with a single firing (occurrences=1) evaluated AT open time — the
    // sustained gate (5 min) is not yet met.
    await runMonitorOnRegression(
      { groupingKey: "g-slow", title: "Slow leak", at: past },
      { store, nowMs: openMoment },
    );
    expect(created).toHaveLength(0); // first firing: gate not met at open time
    // Evaluate "now" 10 minutes later so the sustained gate is satisfied.
    const later = Date.parse("2026-03-02T10:10:00.000Z");
    const outcome = await runMonitorOnRegression(
      { groupingKey: "g-slow", title: "Slow leak", at: past },
      { store, nowMs: later },
    );
    expect(outcome.kind).toBe("fix-task-opened");
    expect(created).toHaveLength(1);
  });

  it("two CONCURRENT regression ingests for the same open incident open exactly ONE fix task", async () => {
    // Force the interleaving the storm guard alone cannot prevent: both callers
    // pass decideStormGuard (fixTaskId still null) and both reach the await on
    // task creation before either links. A gated createTask holds both calls at
    // that exact yield point so they overlap; only the claim-holder should win.
    const created: Task[] = [];
    let seq = 0;
    // FNXC:Monitor 2026-06-16-15:40: the gate (a Promise both createTask calls
    // await) holds both concurrent callers suspended at the createTask yield
    // point so the claim race is reproduced deterministically rather than by
    // chance scheduling. With both callers parked there, releaseGate() unblocks
    // them together, proving the atomic claim lets exactly ONE fix task open
    // (the loser absorbs on the lost claim, not on scheduling luck).
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let createCalls = 0;
    const store = {
      getDatabase: () => db,
      async createTask(input: TaskCreateInput): Promise<Task> {
        createCalls += 1;
        await gate; // suspend here so a concurrent caller can interleave
        const task = {
          id: `FN-${++seq}`,
          title: input.title,
          column: input.column,
          source: input.source,
        } as unknown as Task;
        created.push(task);
        return task;
      },
    } as unknown as TaskStore;

    // Prime an open incident already past the gate (occurrences >= threshold) so
    // both concurrent firings decide open-fix-task.
    for (let i = 0; i < DEFAULT_STORM_GUARD.threshold; i += 1) {
      ingestIncidentSignal(db, { groupingKey: "g-race", title: "Race 500s" });
    }

    const a = runMonitorOnRegression({ groupingKey: "g-race", title: "Race 500s" }, { store });
    const b = runMonitorOnRegression({ groupingKey: "g-race", title: "Race 500s" }, { store });
    // Let both reach (or skip) the await, then release.
    await Promise.resolve();
    releaseGate();
    const [ra, rb] = await Promise.all([a, b]);

    // Exactly one task created; the other caller absorbed via the lost claim.
    expect(createCalls).toBe(1);
    expect(created).toHaveLength(1);
    const kinds = [ra.kind, rb.kind].sort();
    expect(kinds).toEqual(["absorbed", "fix-task-opened"]);

    // The incident is linked to the single real task, not a sentinel.
    const openedOutcome = ra.kind === "fix-task-opened" ? ra : rb;
    if (openedOutcome.kind !== "fix-task-opened") {
      throw new Error(`expected exactly one fix-task-opened outcome, got ${ra.kind} + ${rb.kind}`);
    }
    const incident = getIncident(db, openedOutcome.incidentId);
    expect(incident?.fixTaskId).toBe(created[0].id);
  });

  // FNXC:Monitor 2026-06-16-15:40: if createTask throws AFTER the claim, the
  // claim must be released so the sentinel can't permanently absorb/suppress
  // future regressions for the same incident.
  it("a createTask failure after claim releases the claim so a later regression can open a fix task", async () => {
    let failNext = true;
    const created: Task[] = [];
    let seq = 0;
    const store = {
      getDatabase: () => db,
      async createTask(input: TaskCreateInput): Promise<Task> {
        if (failNext) {
          failNext = false;
          throw new Error("task store unavailable");
        }
        const task = {
          id: `FN-${++seq}`,
          title: input.title,
          column: input.column,
          source: input.source,
        } as unknown as Task;
        created.push(task);
        return task;
      },
    } as unknown as TaskStore;

    // Prime an open incident past the gate so the guard decides open-fix-task.
    for (let i = 0; i < DEFAULT_STORM_GUARD.threshold; i += 1) {
      ingestIncidentSignal(db, { groupingKey: "g-fail", title: "Boom" });
    }

    // First open-fix-task attempt: createTask throws → claim released, error out.
    const failed = await runMonitorOnRegression({ groupingKey: "g-fail", title: "Boom" }, { store });
    expect(failed.kind).toBe("error");
    expect(created).toHaveLength(0);
    const incident = getOpenIncidentByGroupingKey(db, "g-fail");
    expect(incident?.fixTaskId).toBeNull(); // claim released, not stranded

    // A later regression can now open a fix task again (not absorbed by a sentinel).
    const reopened = await runMonitorOnRegression({ groupingKey: "g-fail", title: "Boom" }, { store });
    expect(reopened.kind).toBe("fix-task-opened");
    expect(created).toHaveLength(1);
  });

  it("the atomic claim step prevents a second create once an incident is claimed/linked", () => {
    const { incident } = ingestIncidentSignal(db, { groupingKey: "g-claim", title: "Claim me" });
    // First claim wins.
    expect(claimIncidentForFixTask(db, incident.incidentId)).toBe(true);
    // A second concurrent caller loses the claim (fixTaskId no longer NULL).
    expect(claimIncidentForFixTask(db, incident.incidentId)).toBe(false);
  });
});
