/**
 * FNXC:IncompletePgPorts 2026-07-26-20:50:
 * End-to-end PostgreSQL coverage for incomplete-port fixes: historical ID reservation, orphaned task.json reconciliation, health
 * snapshot refresh, settingsSyncCache, and prompt-override async load.
 */
import { it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import * as schema from "../../postgres/schema/index.js";

const pgTest = pgDescribe;

pgTest("incomplete PG ports (reconcile, health, settings)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_incomplete_pg_ports",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("taskIdExistsAnywhere includes cold archive.archived_tasks IDs", async () => {
    const store = h.store();
    const layer = h.layer();
    const projectId = layer.projectId?.trim() || "__legacy_unscoped__";
    const task = await store.createTask({ description: "Cold archive representation" });
    // Remove live row so only cold archive remains.
    await layer.db.delete(schema.project.tasks);
    await layer.db.insert(schema.archive.archivedTasks).values({
      id: task.id,
      projectId,
      taskJson: JSON.stringify(task),
      archivedAt: new Date().toISOString(),
      title: task.title,
      description: task.description,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    });
    expect(await store.taskIdExistsAnywhere(task.id)).toBe(true);
    expect(await store.isTaskIdPresentInArchivedTasksTableAsync(task.id)).toBe(true);
  });

  it("reconcileOrphanedTaskDirs re-imports a task.json missing from PostgreSQL", async () => {
    const store = h.store();
    const id = "FN-ORPHAN-1";
    const taskDir = join(store.tasksDir, id);
    await mkdir(taskDir, { recursive: true });
    const now = new Date().toISOString();
    const task = {
      id,
      title: "orphan recover",
      description: "from disk",
      column: "todo",
      status: "todo",
      createdAt: now,
      updatedAt: now,
      dependencies: [],
      comments: [],
      priority: "medium",
    };
    await writeFile(join(taskDir, "task.json"), JSON.stringify(task, null, 2), "utf8");

    expect(await store.taskIdExistsAnywhere(id)).toBe(false);
    const result = await store.reconcileOrphanedTaskDirs({ ignoreRecencyWindow: true });
    expect(result.recovered).toContain(id);
    expect(await store.taskIdExistsAnywhere(id)).toBe(true);
    const live = await store.getTask(id);
    expect(live?.title).toBe("orphan recover");
  });

  it("refreshDatabaseHealthAsync records a healthy postgresHealthSnapshot", async () => {
    const store = h.store();
    expect(store.postgresHealthSnapshot).toBeNull();
    const health = await store.refreshDatabaseHealthAsync();
    expect(health.healthy).toBe(true);
    expect(health.corruptionDetected).toBe(false);
    expect(health.lastCheckedAt).toBeInstanceOf(Date);
    expect(store.getDatabaseHealth().healthy).toBe(true);
    expect(store.healthCheck()).toBe(true);
  });

  it("getSettings populates settingsSyncCache for getSettingsSync", async () => {
    const store = h.store();
    expect(store.getSettingsSync()).toBeTruthy();
    await store.getSettings();
    expect(store.settingsSyncCache).not.toBeNull();
    expect(store.getSettingsSync()).toEqual(store.settingsSyncCache);
  });

  it("applyBuiltInPromptOverridesAsync loads PostgreSQL prompt overrides", async () => {
    const store = h.store();
    const projectId = store.getWorkflowSettingsProjectId();
    const workflowId = "builtin:coding";
    await store.updateWorkflowPromptOverrides(workflowId, projectId, {
      plan: "CUSTOM_PLAN_PROMPT_OVERRIDE",
    });
    // Direct async helper must load the row.
    const loaded = await store.getWorkflowPromptOverridesAsync(workflowId, projectId);
    expect(loaded.plan).toBe("CUSTOM_PLAN_PROMPT_OVERRIDE");
    const def = await store.getWorkflowDefinition(workflowId);
    expect(def).toBeTruthy();
    // Builtin IR after applyBuiltInPromptOverridesAsync should include the custom plan prompt.
    const irText = JSON.stringify(def!.ir);
    expect(irText).toContain("CUSTOM_PLAN_PROMPT_OVERRIDE");
  });
});
