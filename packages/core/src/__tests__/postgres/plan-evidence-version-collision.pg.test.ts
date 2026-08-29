/*
FNXC:SpecLock 2026-08-11-02:04:
FN-8969 reproduces the operator-visible FN-8964 wedge against PostgreSQL: durable row versions,
not stale snapshot payload versions, must advance every authoritative PROMPT.md write.
*/
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { type TaskStore } from "../../store.js";
import * as schema from "../../postgres/schema/index.js";
import { createCurrentPlanEvidence } from "../../planner/spec-lock.js";

const prompt = (body: string) => `# Task\n\n## Mission\n\n${body}\n\n## File Scope\n\n- packages/core/src/store.ts\n\n## Steps\n\n1. Preserve plan evidence\n\n## Completion Criteria\n\n- [ ] Plan write succeeds\n\n## Do NOT\n\n- Drop evidence\n\n## Dependencies\n\n- None\n`;

pgDescribe("plan evidence version collisions", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_plan_evidence_collision" });
  let store: TaskStore;

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(async () => { await h.beforeEach(); store = h.store(); });
  afterEach(h.afterEach);

  async function seedDriftedEvidence(taskId: string) {
    await h.layer().db.delete(schema.project.currentPlanEvidence).where(eq(schema.project.currentPlanEvidence.taskId, taskId));
    const evidence = createCurrentPlanEvidence({ version: 4, sourceRevision: Date.now(), capturedAt: new Date().toISOString(), prompt: prompt("stale snapshot") });
    await h.layer().db.insert(schema.project.currentPlanEvidence).values({
      projectId: "", taskId, version: 5, sourceRevision: evidence.sourceRevision,
      sourceHash: evidence.sourceHash, capturedAt: evidence.capturedAt, snapshot: evidence,
    });
  }

  it.sequential("self-heals a durable-version/snapshot-version wedge and dedupes a repeated prompt", async () => {
    const task = await store.createTask({ description: "drifted evidence prompt write" });
    await seedDriftedEvidence(task.id);
    const revised = prompt("new authoritative content");

    await expect(store.updateTask(task.id, { prompt: revised })).resolves.toBeDefined();
    expect((await store.getTask(task.id)).prompt).toBe(revised);
    const afterFirst = await h.layer().db.select({ version: schema.project.currentPlanEvidence.version })
      .from(schema.project.currentPlanEvidence).where(and(eq(schema.project.currentPlanEvidence.taskId, task.id))).orderBy(schema.project.currentPlanEvidence.version);
    expect(afterFirst.map((row) => row.version)).toContain(6);

    await expect(store.updateTask(task.id, { prompt: revised })).resolves.toBeDefined();
    const afterRepeat = await h.layer().db.select({ version: schema.project.currentPlanEvidence.version })
      .from(schema.project.currentPlanEvidence).where(and(eq(schema.project.currentPlanEvidence.taskId, task.id)));
    expect(afterRepeat).toHaveLength(afterFirst.length);
  });

  it.sequential("uses unbound-layer reads and accepts concurrent distinct and identical prompt writes", async () => {
    const task = await store.createTask({ description: "unbound concurrent plan writes" });
    await seedDriftedEvidence(task.id);
    await expect(Promise.all([
      store.updateTask(task.id, { prompt: prompt("concurrent one") }),
      store.updateTask(task.id, { prompt: prompt("concurrent two") }),
    ])).resolves.toHaveLength(2);
    const distinct = await h.layer().db.select({ version: schema.project.currentPlanEvidence.version, sourceHash: schema.project.currentPlanEvidence.sourceHash })
      .from(schema.project.currentPlanEvidence).where(eq(schema.project.currentPlanEvidence.taskId, task.id)).orderBy(schema.project.currentPlanEvidence.version);
    expect(distinct.map((row) => row.version)).toEqual(expect.arrayContaining([5, 6, 7]));

    const same = prompt("same concurrent content");
    await expect(Promise.all([store.updateTask(task.id, { prompt: same }), store.updateTask(task.id, { prompt: same })])).resolves.toHaveLength(2);
    const rows = await h.layer().db.select({ sourceHash: schema.project.currentPlanEvidence.sourceHash })
      .from(schema.project.currentPlanEvidence).where(eq(schema.project.currentPlanEvidence.taskId, task.id));
    const sameEvidence = createCurrentPlanEvidence({ version: 1, sourceRevision: 0, capturedAt: "", prompt: same });
    expect(rows.filter((row) => row.sourceHash === sameEvidence.sourceHash)).toHaveLength(1);
  });
});
