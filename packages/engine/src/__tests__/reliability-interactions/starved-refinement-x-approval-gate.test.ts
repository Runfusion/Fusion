import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "@fusion/core";
import { SelfHealingManager } from "../../self-healing.js";
import { TriageProcessor } from "../../triage.js";

function task(overrides: Partial<Task> & Pick<Task, "id">): Task {
  const { id, ...rest } = overrides;
  return {
    id,
    title: overrides.id,
    description: overrides.id,
    priority: "normal",
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

describe("reliability interaction: starved refinement x approval gate", () => {
  it("keeps requirePlanApproval flow after starvation escalation", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-fn4662-approval-"));
    try {
      const updates: Array<Record<string, unknown>> = [];
      const moves: string[] = [];
      const refinement = task({ id: "FN-RA", sourceType: "task_refine" });
      const tasks: Task[] = [
        refinement,
        task({ id: "FN-P1", column: "todo", sourceType: "dashboard_ui", updatedAt: "2026-05-15T10:15:00.000Z" }),
        task({ id: "FN-P2", column: "todo", sourceType: "dashboard_ui", updatedAt: "2026-05-15T10:16:00.000Z" }),
        task({ id: "FN-P3", column: "todo", sourceType: "dashboard_ui", updatedAt: "2026-05-15T10:17:00.000Z" }),
      ];

      const store: any = {
        listTasks: vi.fn().mockResolvedValue(tasks),
        updateTask: vi.fn().mockImplementation(async (_id: string, patch: Record<string, unknown>) => {
          updates.push(patch);
        }),
        moveTask: vi.fn().mockImplementation(async (_id: string, to: string) => {
          moves.push(to);
        }),
        logEntry: vi.fn().mockResolvedValue(undefined),
        recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
        parseDependenciesFromPrompt: vi.fn().mockResolvedValue([]),
        parseStepsFromPrompt: vi.fn().mockResolvedValue([]),
        on: () => {},
        off: () => {},
        removeListener: () => {},
      };

      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-15T11:00:00.000Z"));
      const manager = new SelfHealingManager(store, { rootDir: root, getPlanningTaskIds: () => new Set() });
      await expect(manager.recoverStarvedRefinementTriageTasks()).resolves.toBe(1);

      const taskDir = join(root, ".fusion", "tasks", "FN-RA");
      await mkdir(taskDir, { recursive: true });
      /*
      FNXC:EngineTests 2026-07-21-00:20:
      Finalize needs executable steps + getTask/moveTaskIf/withTaskLock for planning CAS.
      */
      const spec = "# FN-RA\n\n## File Scope\n- packages/engine/src/self-healing.ts\n\n## Steps\n\n### Step 0: Implement\n- [ ] do the work\n";
      await writeFile(join(taskDir, "PROMPT.md"), spec, "utf8");
      store.getTask = vi.fn().mockImplementation(async (id: string) => (id === "FN-RA" ? refinement : undefined));
      store.parseFileScopeFromPrompt = vi.fn().mockResolvedValue([]);
      store.withTaskLock = vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn());
      store.readTaskForMove = vi.fn(async (id: string) => store.getTask(id));
      store.moveTaskIf = vi.fn(async (id: string, column: string, predicate: (t: any) => boolean) => {
        const live = await store.getTask(id);
        if (live && !predicate(live)) return { moved: false, task: live };
        await store.moveTask(id, column);
        return { moved: true, task: live };
      });

      const triage = new TriageProcessor(store, root);
      await (triage as any).finalizeApprovedTask(
        refinement,
        spec,
        { requirePlanApproval: true },
      );

      expect(updates.some((u) => u.priority === "high")).toBe(true);
      expect(updates.some((u) => u.status === "awaiting-approval")).toBe(true);
      expect(moves).toEqual([]);
      vi.useRealTimers();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
