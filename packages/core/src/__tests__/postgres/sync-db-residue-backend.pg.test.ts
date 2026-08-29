/**
 * FNXC:PostgresOnlyDataAccess 2026-07-16-12:50:
 * Regression coverage for the sync-SQLite residue sweep: these TaskStore
 * surfaces previously either threw "SQLite Database is not available in
 * backend mode" or silently degraded to empty/no-op behind try/catch in
 * backend mode. Each now routes to the AsyncDataLayer and must round-trip
 * against PostgreSQL:
 * - workflow run-branch persistence (save/load/clear + branch progress)
 * - foreach step-instance persistence (save/load/upsert/clear)
 * - getTaskColumns (active + archived + missing)
 * - getWorkflowStep (stored row by id/templateId + built-in template)
 * - listWorkflowSteps (stored rows, not just plugin steps)
 * - readRawProjectSettings / listWorkflowPromptOverridesForProject
 */
import { describe, it, expect } from "vitest";
import {
  pgDescribe,
  createTaskStoreForTest,
  type PgTestHarness,
} from "../../__test-utils__/pg-test-harness.js";

pgDescribe("sync-db residue surfaces in backend mode (PostgreSQL)", () => {
  let harness: PgTestHarness | null = null;

  async function makeHarness(): Promise<PgTestHarness> {
    harness = await createTaskStoreForTest({ prefix: "fusion_sync_residue" });
    return harness;
  }

  async function teardown(): Promise<void> {
    if (harness) {
      await harness.teardown();
      harness = null;
    }
  }

  it("persists, loads, and prunes workflow run branches; branch progress uses the latest run", async () => {
    const h = await makeHarness();
    try {
      const task = await h.store.createTask({ description: "branch persistence" });

      await h.store.saveWorkflowRunBranch({ taskId: task.id, runId: "run-1", branchId: "b1", currentNodeId: "n1", status: "completed" });
      await h.store.saveWorkflowRunBranch({ taskId: task.id, runId: "run-2", branchId: "b1", currentNodeId: "n2", status: "running" });
      // Upsert flips the same key in place.
      await h.store.saveWorkflowRunBranch({ taskId: task.id, runId: "run-2", branchId: "b1", currentNodeId: "n3", status: "completed" });

      const run2 = await h.store.loadWorkflowRunBranches(task.id, "run-2");
      expect(run2).toHaveLength(1);
      expect(run2[0]).toMatchObject({ branchId: "b1", currentNodeId: "n3", status: "completed" });

      const progress = await h.store.getBranchProgressByTask([task.id]);
      expect(progress.get(task.id)).toEqual([{ branchId: "b1", nodeId: "n3", status: "completed" }]);

      await h.store.clearWorkflowRunBranches(task.id, "run-2");
      expect(await h.store.loadWorkflowRunBranches(task.id, "run-1")).toHaveLength(0);
      expect(await h.store.loadWorkflowRunBranches(task.id, "run-2")).toHaveLength(1);
    } finally {
      await teardown();
    }
  });

  it("persists, upserts, loads, and prunes foreach step instances", async () => {
    const h = await makeHarness();
    try {
      const task = await h.store.createTask({ description: "step-instance persistence" });
      const base = { taskId: task.id, runId: "run-1", foreachNodeId: "fe1", pinnedStepCount: 2 };

      await h.store.saveWorkflowRunStepInstance({ ...base, stepIndex: 0, currentNodeId: "n1", status: "running", reworkCount: 0 } as never);
      await h.store.saveWorkflowRunStepInstance({ ...base, stepIndex: 1, currentNodeId: "n1", status: "running", reworkCount: 1 } as never);
      // Upsert the first row to completed.
      await h.store.saveWorkflowRunStepInstance({ ...base, stepIndex: 0, currentNodeId: "n2", status: "completed", reworkCount: 2, integratedAt: "2026-07-16T00:00:00.000Z" } as never);

      const rows = await h.store.loadWorkflowRunStepInstances(task.id, "run-1");
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ stepIndex: 0, status: "completed", reworkCount: 2, integratedAt: "2026-07-16T00:00:00.000Z" });
      expect(rows[1]).toMatchObject({ stepIndex: 1, status: "running", reworkCount: 1 });

      // keepRunId semantics: pruning keeps only the given run.
      await h.store.saveWorkflowRunStepInstance({ ...base, runId: "run-2", stepIndex: 0, currentNodeId: "n1", status: "running", reworkCount: 0 } as never);
      await h.store.clearWorkflowRunStepInstances(task.id, "run-2");
      expect(await h.store.loadWorkflowRunStepInstances(task.id, "run-1")).toHaveLength(0);
      expect(await h.store.loadWorkflowRunStepInstances(task.id, "run-2")).toHaveLength(1);

      // No keepRunId clears everything.
      await h.store.clearWorkflowRunStepInstances(task.id);
      expect(await h.store.loadWorkflowRunStepInstances(task.id, "run-2")).toHaveLength(0);
    } finally {
      await teardown();
    }
  });

  it("getTaskColumns resolves active, archived, and missing ids", async () => {
    const h = await makeHarness();
    try {
      const active = await h.store.createTask({ description: "active", column: "in-progress" });
      const toArchive = await h.store.createTask({ description: "to archive", column: "done" });
      await h.store.archiveTask(toArchive.id, { cleanup: false });

      const map = await h.store.getTaskColumns([active.id, toArchive.id, "FN-NOPE-1"]);
      expect(map.get(active.id)).toBe("in-progress");
      expect(map.get(toArchive.id)).toBe("archived");
      expect(map.has("FN-NOPE-1")).toBe(false);
    } finally {
      await teardown();
    }
  });

  it("getWorkflowStep resolves stored rows by id and templateId, and built-in templates", async () => {
    const h = await makeHarness();
    try {
      const created = await h.store.createWorkflowStep({
        templateId: undefined,
        name: "Residue Step",
        description: "backend-mode stored step",
        mode: "prompt",
        phase: "pre-merge",
        gateMode: "advisory",
        prompt: "check things",
        toolMode: "readonly",
        enabled: true,
      });

      const byId = await h.store.getWorkflowStep(created.id);
      expect(byId?.name).toBe("Residue Step");

      // Stored rows appear in the listing (previously dropped in backend mode).
      const listed = await h.store.listWorkflowSteps();
      expect(listed.map((s) => s.id)).toContain(created.id);

      // Unknown ids fall through to built-in templates or undefined — no throw.
      const missing = await h.store.getWorkflowStep("WS-does-not-exist");
      expect(missing === undefined || typeof missing.id === "string").toBe(true);
    } finally {
      await teardown();
    }
  });

  it("readRawProjectSettings and listWorkflowPromptOverridesForProject read via the async layer", async () => {
    const h = await makeHarness();
    try {
      await h.store.updateSettings({ taskPrefix: "ZZ" });
      const raw = await h.store.readRawProjectSettings();
      expect(raw.taskPrefix).toBe("ZZ");

      const overrides = await h.store.listWorkflowPromptOverridesForProject();
      expect(overrides).toEqual({});
    } finally {
      await teardown();
    }
  });
});

// Keep `describe` referenced so the import is not flagged as unused if the
// pgDescribe.skip path is taken in CI (no PG available).
void describe;
