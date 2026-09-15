/*
FNXC:HumanPlanApproval 2026-09-15-06:24:
FN-408 — the per-card human plan decision is release-gating state, so it must survive the real
PostgreSQL TaskStore boundary: JSONB round-trip, explicit-null clear, project partitioning of the
same task ID, repeated schema application, and refusal of a decision forged at creation or update.
*/
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import * as schema from "../../postgres/schema/index.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
import type { HumanPlanApprovalDecision } from "../../types.js";

const DECISION: HumanPlanApprovalDecision = {
  requestId: "req-42",
  decision: "approved",
  message: "Fais juste attention à la migration ✅",
  decidedBy: "dashboard-operator",
  decidedAt: "2026-09-15T06:24:00.000Z",
  planFingerprint: "c".repeat(64),
  planningEpisodeId: "2026-09-15T06:20:00.000Z",
};

pgDescribe("TaskStore human plan approval persistence (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_human_plan_approval",
  });

  beforeAll(async () => {
    await h.beforeAll();
    await applySchemaBaseline(h.adminDb());
  });
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("arms at creation without a decision and round-trips a persisted decision", async () => {
    const store = h.store();
    const created = await store.createTask({
      description: "Carte nécessitant une validation humaine du plan.",
      humanPlanApproval: true,
    });
    expect(created.humanPlanApproval).toEqual({ enabled: true });

    // get / list must both observe the armed state.
    expect((await store.getTask(created.id))?.humanPlanApproval).toEqual({ enabled: true });
    const listed = (await store.listTasks()).find((task) => task.id === created.id);
    expect(listed?.humanPlanApproval).toEqual({ enabled: true });

    await store.updateTask(created.id, { humanPlanApproval: { enabled: true, decision: DECISION } });
    const reread = await store.getTask(created.id);
    expect(reread?.humanPlanApproval).toEqual({ enabled: true, decision: DECISION });

    const persisted = await h.adminDb()
      .select({ humanPlanApproval: schema.project.tasks.humanPlanApproval })
      .from(schema.project.tasks)
      .where(eq(schema.project.tasks.id, created.id));
    expect(persisted).toEqual([{ humanPlanApproval: { enabled: true, decision: DECISION } }]);
  });

  it("clears the whole state with the explicit null sentinel and ignores an omitted field", async () => {
    const store = h.store();
    const created = await store.createTask({
      description: "Carte validée puis nettoyée.",
      humanPlanApproval: true,
    });
    await store.updateTask(created.id, { humanPlanApproval: { enabled: true, decision: DECISION } });

    // An unrelated patch must not disturb the state.
    await store.updateTask(created.id, { summary: "unrelated" });
    expect((await store.getTask(created.id))?.humanPlanApproval).toEqual({ enabled: true, decision: DECISION });

    await store.updateTask(created.id, { humanPlanApproval: null });
    expect((await store.getTask(created.id))?.humanPlanApproval).toBeUndefined();
  });

  it("leaves a card without the option, and a legacy row, completely unarmed", async () => {
    const store = h.store();
    const plain = await store.createTask({ description: "Carte ordinaire sans option." });
    expect(plain.humanPlanApproval).toBeUndefined();
    expect((await store.getTask(plain.id))?.humanPlanApproval).toBeUndefined();

    /*
    A historical row predating this column reads as NULL. The retired FN-234 `require_plan_approval`
    value must never be projected onto the new field.
    */
    await h.adminDb().execute(sql`
      UPDATE project.tasks SET human_plan_approval = NULL WHERE id = ${plain.id}
    `);
    expect((await store.getTask(plain.id))?.humanPlanApproval).toBeUndefined();
  });

  it("refuses a decision forged at creation time", async () => {
    const store = h.store();
    const created = await store.createTask({
      description: "Tentative de décision forgée à la création.",
      // Only the boolean arming flag is part of the create contract; a decision cannot be supplied.
      humanPlanApproval: { enabled: true, decision: DECISION } as unknown as boolean,
    });
    expect(created.humanPlanApproval).toEqual({ enabled: true });
    expect((await store.getTask(created.id))?.humanPlanApproval).toEqual({ enabled: true });
  });

  /*
  FN-408 remediation: Fast and the per-card requirement are mutually exclusive, and the requirement
  wins at the WRITE boundary. Fast skips planning and plan review, so an armed fast row could never
  reach a decidable review episode and would be immobilized with no operator recourse.
  */
  it("neutralizes fast execution when the card is armed, at creation and on update", async () => {
    const store = h.store();
    const created = await store.createTask({
      description: "Carte Fast + validation humaine du plan.",
      executionMode: "fast",
      humanPlanApproval: true,
    });
    expect(created.executionMode).toBeUndefined();
    expect(created.humanPlanApproval).toEqual({ enabled: true });
    expect((await store.getTask(created.id))?.executionMode).toBeUndefined();

    // A later Fast toggle on the armed card is neutralized too.
    await store.updateTask(created.id, { executionMode: "fast" });
    expect((await store.getTask(created.id))?.executionMode).toBeUndefined();

    // The control: an unarmed card keeps Fast exactly as before.
    const fastOnly = await store.createTask({ description: "Carte Fast ordinaire.", executionMode: "fast" });
    expect(fastOnly.executionMode).toBe("fast");
    expect((await store.getTask(fastOnly.id))?.executionMode).toBe("fast");
  });

  it("isolates two projects holding the same task ID", async () => {
    const store = h.store();
    const created = await store.createTask({
      description: "Isolation inter-projets du même identifiant.",
      humanPlanApproval: true,
    });
    await store.updateTask(created.id, { humanPlanApproval: { enabled: true, decision: DECISION } });

    const foreignProjectId = "fn-408-foreign-project";
    const ownProjectId = (await h.adminDb()
      .select({ projectId: schema.project.tasks.projectId })
      .from(schema.project.tasks)
      .where(eq(schema.project.tasks.id, created.id)))[0]?.projectId;
    expect(ownProjectId).toBeTruthy();

    // Clone the row under a different project scope with NO decision.
    await h.adminDb().insert(schema.project.tasks).values({
      projectId: foreignProjectId,
      id: created.id,
      title: "foreign",
      description: "foreign",
      column: "triage",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      humanPlanApproval: { enabled: true },
    } as never);

    // The bound store must still read only its own project's decision.
    expect((await store.getTask(created.id))?.humanPlanApproval).toEqual({ enabled: true, decision: DECISION });
    const foreign = await h.adminDb()
      .select({ humanPlanApproval: schema.project.tasks.humanPlanApproval })
      .from(schema.project.tasks)
      .where(and(
        eq(schema.project.tasks.projectId, foreignProjectId),
        eq(schema.project.tasks.id, created.id),
      ));
    expect(foreign).toEqual([{ humanPlanApproval: { enabled: true } }]);
  });

  it("applies the additive column migration idempotently", async () => {
    const columnCount = async () => ((await h.adminDb().execute(sql`
      SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema = 'project' AND table_name = 'tasks' AND column_name = 'human_plan_approval'
    `)) as unknown as Array<{ n: number }>)[0]?.n;

    expect(await columnCount()).toBe(1);
    await applySchemaBaseline(h.adminDb());
    await applySchemaBaseline(h.adminDb());
    expect(await columnCount()).toBe(1);
  });
});
