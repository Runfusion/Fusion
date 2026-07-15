import { describe, expect, it } from "vitest";
import {
  formatAssignedTasksWakeDeltaSection,
  rankAssignedTasksForWakeDelta,
  WAKE_DELTA_ASSIGNED_TASKS_CAP,
  type AssignedTaskLike,
} from "../assigned-task-ranking.js";

function task(partial: Partial<AssignedTaskLike> & Pick<AssignedTaskLike, "id" | "column">): AssignedTaskLike {
  return {
    createdAt: "2026-07-01T00:00:00.000Z",
    ...partial,
  };
}

describe("rankAssignedTasksForWakeDelta", () => {
  it("orders in_progress before ready_todo before partial_blocked", () => {
    const result = rankAssignedTasksForWakeDelta(
      [
        task({ id: "FN-T", column: "todo", title: "Ready", createdAt: "2026-07-03T00:00:00.000Z" }),
        task({ id: "FN-B", column: "todo", title: "Blocked", dependencies: ["FN-X"], createdAt: "2026-07-02T00:00:00.000Z" }),
        task({ id: "FN-P", column: "in-progress", title: "Active", createdAt: "2026-07-01T00:00:00.000Z" }),
      ],
      { agentId: "agent-1", boundTaskId: "FN-P" },
    );
    expect(result.ranked.map((r) => r.task.id)).toEqual(["FN-P", "FN-T", "FN-B"]);
    expect(result.ranked[0]?.labels).toContain("bound");
  });

  it("excludes done/archived, counts paused as not actionable, and keeps open custom columns titled", () => {
    const result = rankAssignedTasksForWakeDelta(
      [
        task({ id: "FN-1", column: "todo", title: "Open" }),
        task({ id: "FN-2", column: "done", title: "Done" }),
        task({ id: "FN-3", column: "todo", title: "Paused", paused: true }),
        task({ id: "FN-4", column: "in-review", title: "Review" }),
        task({ id: "FN-5", column: "ready-for-dev", title: "Custom workflow ready" }),
      ],
      { agentId: "agent-1" },
    );
    // todo first, then other-tier open columns (in-review + custom) by createdAt
    expect(result.ranked.map((r) => r.task.id)).toEqual(["FN-1", "FN-4", "FN-5"]);
    expect(result.ranked.find((r) => r.task.id === "FN-5")?.tier).toBe("other");
    expect(result.notActionableCount).toBe(1); // paused only
    expect(result.totalOpen).toBe(4); // excludes done
  });

  it("caps titled lines and marks truncated", () => {
    const tasks = Array.from({ length: WAKE_DELTA_ASSIGNED_TASKS_CAP + 4 }, (_, i) =>
      task({
        id: `FN-${i}`,
        column: "todo",
        title: `Task ${i}`,
        createdAt: `2026-07-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
      }),
    );
    const result = rankAssignedTasksForWakeDelta(tasks, { agentId: "agent-1" });
    expect(result.ranked).toHaveLength(WAKE_DELTA_ASSIGNED_TASKS_CAP);
    expect(result.truncated).toBe(true);
  });

  it("annotates foreign lease", () => {
    const result = rankAssignedTasksForWakeDelta(
      [task({ id: "FN-1", column: "todo", title: "Held", checkedOutBy: "other-agent" })],
      { agentId: "agent-1" },
    );
    expect(result.ranked[0]?.labels.some((l) => l.includes("held-by-other"))).toBe(true);
  });
});

describe("formatAssignedTasksWakeDeltaSection", () => {
  it("omits empty inventory", () => {
    const result = rankAssignedTasksForWakeDelta([], { agentId: "agent-1" });
    expect(formatAssignedTasksWakeDeltaSection(result)).toBe("");
  });

  it("omits single bound-only titled inventory by default", () => {
    const result = rankAssignedTasksForWakeDelta(
      [task({ id: "FN-1", column: "in-progress", title: "Only" })],
      { agentId: "agent-1", boundTaskId: "FN-1" },
    );
    expect(formatAssignedTasksWakeDeltaSection(result, { boundTaskId: "FN-1" })).toBe("");
  });

  it("renders multi inventory with coordination framing", () => {
    const result = rankAssignedTasksForWakeDelta(
      [
        task({ id: "FN-1", column: "in-progress", title: "A" }),
        task({ id: "FN-2", column: "todo", title: "B" }),
      ],
      { agentId: "agent-1", boundTaskId: "FN-1" },
    );
    const text = formatAssignedTasksWakeDeltaSection(result, { boundTaskId: "FN-1" });
    expect(text).toContain("coordination inventory");
    expect(text).toContain("FN-1");
    expect(text).toContain("FN-2");
    expect(text).toContain("(bound)");
  });
});
