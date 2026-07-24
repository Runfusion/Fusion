import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "@fusion/core";
import { SelfHealingManager } from "../../self-healing.js";
import { TriageProcessor } from "../../triage.js";

function triageTask(overrides: Partial<Task> & Pick<Task, "id">): Task {
  const { id, ...rest } = overrides;
  return {
    id,
    title: overrides.id,
    description: overrides.id,
    priority: "low",
    column: "triage",
    dependencies: [],
    steps: [],
    currentStep: 0,
    status: null,
    createdAt: "2026-05-15T10:00:00.000Z",
    updatedAt: "2026-05-15T10:00:00.000Z",
    columnMovedAt: "2026-05-15T10:00:00.000Z",
    ...rest,
  } as Task;
}

describe("reliability interaction: starved refinement x triage poll", () => {
  it("escalation surfaces a previously-starved refinement to poll within bounded ticks", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-fn4662-poll-"));
    await mkdir(join(root, ".fusion", "tasks"), { recursive: true });

    try {
      const tasks: Task[] = [
        triageTask({ id: "FN-R1", sourceType: "task_refine" }),
        ...Array.from({ length: 6 }, (_, idx) => triageTask({ id: `FN-B${idx + 1}`, createdAt: `2026-05-15T09:${String(10 + idx).padStart(2, "0")}:00.000Z`, priority: "normal" })),
        triageTask({ id: "FN-P1", column: "todo", sourceType: "dashboard_ui", updatedAt: "2026-05-15T10:15:00.000Z" }),
        triageTask({ id: "FN-P2", column: "todo", sourceType: "dashboard_ui", updatedAt: "2026-05-15T10:16:00.000Z" }),
        triageTask({ id: "FN-P3", column: "todo", sourceType: "dashboard_ui", updatedAt: "2026-05-15T10:17:00.000Z" }),
      ];

      const store: any = {
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 1, maxTriageConcurrent: 1, pollIntervalMs: 10_000, globalPause: false, enginePaused: false }),
        listTasks: vi.fn().mockImplementation(async () => tasks.map((t) => ({ ...t }))),
        updateTask: vi.fn().mockImplementation(async (id: string, patch: Partial<Task>) => {
          const idx = tasks.findIndex((t) => t.id === id);
          tasks[idx] = { ...tasks[idx], ...patch, updatedAt: new Date().toISOString() } as Task;
        }),
        logEntry: vi.fn().mockResolvedValue(undefined),
        recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
        on: () => {},
        off: () => {},
        removeListener: () => {},
      };

      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-15T11:00:00.000Z"));
      const manager = new SelfHealingManager(store, { rootDir: root, getPlanningTaskIds: () => new Set() });
      await expect(manager.recoverStarvedRefinementTriageTasks()).resolves.toBe(1);

      const triage = new TriageProcessor(store, root);
      const specifySpy = vi.spyOn(triage, "specifyTask").mockImplementation(async (task) => {
        const idx = tasks.findIndex((t) => t.id === task.id);
        if (idx >= 0) tasks[idx] = { ...tasks[idx], column: "todo" };
      });

      (triage as any).running = true;
      /*
      FNXC:EngineTests 2026-07-23-21:30:
      FN-8453 (commit eef5eb751) replaced priority-based triage ordering with the unified
      oldest-createdAt-first admission coordinator, so the self-healing priority bump no
      longer reorders admission. The surviving reliability invariant is FIFO fairness:
      with maxConcurrent=1 and 6 older backlog tasks, the starved refinement must be
      admitted within 7 bounded polls (one admission per poll).
      */
      for (let i = 0; i < 7; i++) {
        await (triage as any).poll();
        if (tasks.find((t) => t.id === "FN-R1")?.column === "todo") break;
      }

      expect(specifySpy.mock.calls.some(([t]) => t.id === "FN-R1")).toBe(true);
      expect(tasks.find((t) => t.id === "FN-R1")?.column).toBe("todo");
      vi.useRealTimers();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
