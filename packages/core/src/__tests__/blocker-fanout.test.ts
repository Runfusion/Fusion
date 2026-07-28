import { describe, expect, it } from "vitest";
import type { Task } from "../types.js";
import { computeBlockerFanoutMap } from "../blocker-fanout.js";

const MAX_AUTO_MERGE_RETRIES = 3;

function createTask(id: string, column: Task["column"], overrides: Partial<Task> = {}): Task {
  return {
    id,
    description: id,
    column,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    updatedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    ...overrides,
  };
}

describe("computeBlockerFanoutMap escalation", () => {
  it("escalates high overlap fan-out blockers when age crosses threshold", () => {
    const nowMs = Date.parse("2026-01-01T06:00:00.000Z");
    const blocker = createTask("B", "in-progress", { columnMovedAt: "2026-01-01T00:00:00.000Z" });
    const blockedByDependents = [1, 2, 3, 4, 5].map((n) => createTask(`D${n}`, "todo", { blockedBy: "B" }));

    const entry = computeBlockerFanoutMap([blocker, ...blockedByDependents], MAX_AUTO_MERGE_RETRIES, {
      nowMs,
      staleHighFanoutAgeThresholdMs: 60 * 60 * 1000,
    }).get("B");

    expect(entry?.escalation).toEqual({
      blockerId: "B",
      activeTodoCount: 5,
      totalActiveCount: 5,
      blockingAgeMs: 6 * 60 * 60 * 1000,
    });
  });

  it("does not classify dependency-only fan-out as overlap bottleneck", () => {
    const blocker = createTask("B", "in-progress", { columnMovedAt: "2026-01-01T00:00:00.000Z" });
    const dependencyDependents = [1, 2, 3, 4, 5].map((n) => createTask(`D${n}`, "todo", { dependencies: ["B"] }));

    const entry = computeBlockerFanoutMap([blocker, ...dependencyDependents], MAX_AUTO_MERGE_RETRIES).get("B");

    expect(entry?.overlapBlockedTodoCount).toBe(0);
    expect(entry?.activeTodoCount).toBe(5);
    expect(entry?.isHighFanout).toBe(false);
    expect(entry?.escalation).toBeUndefined();
  });

  it("keeps short-lived high overlap fan-out blockers quiet", () => {
    const nowMs = Date.parse("2026-01-01T00:10:00.000Z");
    const blocker = createTask("B", "in-progress", { columnMovedAt: "2026-01-01T00:00:00.000Z" });
    const blockedByDependents = [1, 2, 3, 4, 5].map((n) => createTask(`D${n}`, "todo", { blockedBy: "B" }));

    const entry = computeBlockerFanoutMap([blocker, ...blockedByDependents], MAX_AUTO_MERGE_RETRIES, {
      nowMs,
      staleHighFanoutAgeThresholdMs: 60 * 60 * 1000,
    }).get("B");

    expect(entry?.isHighFanout).toBe(true);
    expect(entry?.escalation).toBeUndefined();
  });
});

/*
FNXC:WorkflowLifecycleColumns 2026-07-27-21:45 (Phase B / U6 — vocabulary conversion):
RED-GREEN PROOF for the two column guards in `computeBlockerFanoutMap`, written
BEFORE the conversion and asserted to fail against the literal implementation.

Two distinct guards, converted for different reasons:

  ACTIVE — was an ENUMERATION (`triage/todo/in-progress/in-review`), which silently
  excludes every column a custom workflow adds. Inverted to the plan's own
  phrasing: active means NOT complete and NOT archived. That is the definition the
  concept always had; the enumeration was a default-workflow-shaped stand-in for it,
  and it under-counted for any other workflow rather than failing.

  HOLD (`isTodo`) — the fan-out metric "how many blocked cards are waiting for
  capacity" is about the hold role, not the id `todo`.
*/
describe("computeBlockerFanoutMap — column roles are resolved, not enumerated (U6)", () => {
  function task(id: string, column: string, dependencies: string[] = []): Task {
    return {
      id, column, dependencies,
      title: id, description: "", priority: "normal", steps: [],
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
      columnMovedAt: "2026-07-01T00:00:00.000Z",
    } as unknown as Task;
  }

  it("counts a DEFAULT-workflow dependent as active and as waiting in hold (regression floor)", () => {
    const map = computeBlockerFanoutMap([task("FN-1", "in-review"), task("FN-2", "todo", ["FN-1"])], 3);
    expect(map.get("FN-1")?.totalCount).toBe(1);
    expect(map.get("FN-1")?.activeTodoCount).toBe(1);
  });

  it("counts a RENAMED-workflow dependent as active — the enumeration silently missed it", () => {
    // `writing` is in no legacy enum, so the literal ACTIVE_COLUMNS set scored 0
    // active dependents and the blocker looked unblocking. No error, no failure.
    const map = computeBlockerFanoutMap(
      [task("FN-1", "editorial-review"), task("FN-2", "drafting", ["FN-1"])],
      3,
      { terminalColumns: new Set(["published", "shelved"]), holdColumn: "drafting" },
    );
    expect(map.get("FN-1")?.totalCount).toBe(1);
    expect(map.get("FN-1")?.activeTodoCount).toBe(1);
  });

  it("excludes the renamed workflow's OWN terminal columns from active", () => {
    // The other half: 'not complete, not archived' must still exclude something.
    const map = computeBlockerFanoutMap(
      [task("FN-1", "editorial-review"), task("FN-2", "published", ["FN-1"])],
      3,
      { terminalColumns: new Set(["published", "shelved"]), holdColumn: "drafting" },
    );
    expect(map.get("FN-1")?.totalCount).toBe(0);
    expect(map.get("FN-1")?.activeTodoCount).toBe(0);
  });

  it("does not count a non-hold column toward the hold-wait metric", () => {
    const map = computeBlockerFanoutMap(
      [task("FN-1", "editorial-review"), task("FN-2", "writing", ["FN-1"])],
      3,
      { terminalColumns: new Set(["published", "shelved"]), holdColumn: "drafting" },
    );
    expect(map.get("FN-1")?.totalCount).toBe(1);
    expect(map.get("FN-1")?.activeTodoCount).toBe(0);
  });
});
