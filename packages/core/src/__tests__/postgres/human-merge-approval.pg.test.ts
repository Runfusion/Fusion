/*
FNXC:HumanMergeApproval 2026-09-17-18:09:
FN-514 — the per-card DELIVERY lock is merge-gating state, so it must survive the real PostgreSQL
TaskStore boundary: JSONB round-trip of decision/destination/receipt/rejection, explicit-null clear,
reset and duplication semantics, project partitioning of the same task ID (including identical PR
numbers), legacy NULL rows staying unarmed, refusal of proof forged at creation, and repeated schema
application.
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
import {
  getHumanMergeApprovalBlocker,
  hasCurrentHumanMergeApproval,
  HUMAN_MERGE_APPROVAL_BLOCKER,
  HUMAN_MERGE_REJECTION_BLOCKER,
} from "../../merge/human-merge-approval.js";
import { buildResetTask } from "../../task-store/reset-lifecycle.js";
import type { HumanMergeApprovalState, HumanMergeCandidateIdentity } from "../../types.js";

const CANDIDATE: HumanMergeCandidateIdentity = {
  lockGeneration: 1,
  workflowSignature: "builtin:coding@7",
  reviewEpisodeId: "2026-09-17T10:00:00.000Z",
  contentSignature: "singular:fp:" + "a".repeat(64),
  targetSignature: "merge:repo@origin:fusion/FN-1->main",
};

const MERGE_DECISION: HumanMergeApprovalState = {
  enabled: true,
  generation: 1,
  decision: {
    requestId: "req-42",
    action: "merge",
    deliveryAction: "merge",
    message: "Livre-le, mais surveille la migration ✅",
    decidedBy: "dashboard-operator",
    decidedAt: "2026-09-17T11:00:00.000Z",
    candidate: CANDIDATE,
    receipt: { state: "succeeded", at: "2026-09-17T11:00:05.000Z" },
  },
};

pgDescribe("TaskStore human merge approval persistence (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_human_merge_approval",
  });

  beforeAll(async () => {
    await h.beforeAll();
    await applySchemaBaseline(h.adminDb());
  });
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("arms at creation with generation 1 and no decision, then round-trips a full decision", async () => {
    const store = h.store();
    const created = await store.createTask({
      description: "Carte verrouillée avant livraison.",
      humanMergeApproval: true,
    });
    expect(created.humanMergeApproval).toEqual({ enabled: true, generation: 1 });
    // Armed with no decision means the delivery door is closed, not that it merges.
    expect(getHumanMergeApprovalBlocker(created)).toBe(HUMAN_MERGE_APPROVAL_BLOCKER);

    expect((await store.getTask(created.id))?.humanMergeApproval).toEqual({ enabled: true, generation: 1 });
    const listed = (await store.listTasks()).find((task) => task.id === created.id);
    expect(listed?.humanMergeApproval).toEqual({ enabled: true, generation: 1 });

    await store.updateTask(created.id, { humanMergeApproval: MERGE_DECISION });
    const reread = await store.getTask(created.id);
    expect(reread?.humanMergeApproval).toEqual(MERGE_DECISION);
    expect(hasCurrentHumanMergeApproval(reread!)).toBe(true);

    const persisted = await h.adminDb()
      .select({ humanMergeApproval: schema.project.tasks.humanMergeApproval })
      .from(schema.project.tasks)
      .where(eq(schema.project.tasks.id, created.id));
    expect(persisted).toEqual([{ humanMergeApproval: MERGE_DECISION }]);
  });

  it("round-trips a create-pr receipt that never authorizes a merge", async () => {
    const store = h.store();
    const created = await store.createTask({ description: "Transfert PR manuel.", humanMergeApproval: true });
    const createPr: HumanMergeApprovalState = {
      enabled: true,
      generation: 1,
      decision: {
        requestId: "req-pr",
        action: "create-pr",
        deliveryAction: "create-pr",
        decidedBy: "dashboard-operator",
        decidedAt: "2026-09-17T11:10:00.000Z",
        candidate: { ...CANDIDATE, targetSignature: "create-pr:repo@origin:fusion/FN-1->main" },
        receipt: { state: "succeeded", at: "2026-09-17T11:10:09.000Z", prNumber: 4242, prUrl: "https://example.test/pr/4242", repository: "repo" },
      },
    };
    await store.updateTask(created.id, { humanMergeApproval: createPr });
    const reread = await store.getTask(created.id);
    expect(reread?.humanMergeApproval?.decision?.receipt?.prNumber).toBe(4242);
    expect(hasCurrentHumanMergeApproval(reread!)).toBe(false);
    expect(getHumanMergeApprovalBlocker(reread!)).toBe(HUMAN_MERGE_APPROVAL_BLOCKER);
  });

  it("round-trips an accepted rejection whose obligation outlives the lock being disarmed", async () => {
    const store = h.store();
    const created = await store.createTask({ description: "Refus humain.", humanMergeApproval: true });
    await store.updateTask(created.id, {
      humanMergeApproval: {
        enabled: true,
        generation: 1,
        remediationGeneration: 1,
        rejection: {
          requestId: "rej-1",
          instruction: "Le parcours de navigation est faux, refais-le.",
          rejectedBy: "dashboard-operator",
          rejectedAt: "2026-09-17T11:20:00.000Z",
          candidate: CANDIDATE,
          remediationGeneration: 1,
          state: "pending",
        },
      },
    });
    expect(getHumanMergeApprovalBlocker((await store.getTask(created.id))!)).toBe(HUMAN_MERGE_REJECTION_BLOCKER);

    // Disarming the lock (generation bump, enabled false) keeps the rejection row intact.
    const live = await store.getTask(created.id);
    await store.updateTask(created.id, {
      humanMergeApproval: { enabled: false, generation: 2, remediationGeneration: 1, rejection: live!.humanMergeApproval!.rejection },
    });
    const afterUnlock = await store.getTask(created.id);
    expect(afterUnlock?.humanMergeApproval?.rejection?.instruction).toBe("Le parcours de navigation est faux, refais-le.");
    expect(getHumanMergeApprovalBlocker(afterUnlock!)).toBe(HUMAN_MERGE_REJECTION_BLOCKER);
  });

  it("clears the whole state with the explicit null sentinel and ignores an omitted field", async () => {
    const store = h.store();
    const created = await store.createTask({ description: "Nettoyage explicite.", humanMergeApproval: true });
    await store.updateTask(created.id, { humanMergeApproval: MERGE_DECISION });

    // An unrelated generic patch must neither erase nor forge the decision.
    await store.updateTask(created.id, { summary: "unrelated" });
    expect((await store.getTask(created.id))?.humanMergeApproval).toEqual(MERGE_DECISION);

    await store.updateTask(created.id, { humanMergeApproval: null });
    expect((await store.getTask(created.id))?.humanMergeApproval).toBeUndefined();
    expect(getHumanMergeApprovalBlocker((await store.getTask(created.id))!)).toBeUndefined();
  });

  it("leaves a card without the option, and a legacy NULL row, completely unarmed", async () => {
    const store = h.store();
    const plain = await store.createTask({ description: "Carte ordinaire." });
    expect(plain.humanMergeApproval).toBeUndefined();

    /*
    A historical row predating this column reads NULL. `auto_merge: false` must NOT be projected onto
    it: a project that had merged manually for years must not suddenly acquire a delivery lock.
    */
    await h.adminDb().execute(sql`
      UPDATE project.tasks SET human_merge_approval = NULL, auto_merge = 0 WHERE id = ${plain.id}
    `);
    const reread = await store.getTask(plain.id);
    expect(reread?.humanMergeApproval).toBeUndefined();
    expect(getHumanMergeApprovalBlocker(reread!)).toBeUndefined();
  });

  it("refuses delivery proof forged at creation time", async () => {
    const store = h.store();
    const created = await store.createTask({
      description: "Tentative de preuve forgée.",
      humanMergeApproval: MERGE_DECISION as unknown as boolean,
    });
    expect(created.humanMergeApproval).toEqual({ enabled: true, generation: 1 });
    const reread = await store.getTask(created.id);
    expect(reread?.humanMergeApproval?.decision).toBeUndefined();
    expect(hasCurrentHumanMergeApproval(reread!)).toBe(false);
  });

  it("the reset patch keeps the intent, bumps the generation and drops the accord across the DB boundary", async () => {
    const store = h.store();
    const created = await store.createTask({ description: "Reset après décision.", humanMergeApproval: true });
    await store.updateTask(created.id, { humanMergeApproval: MERGE_DECISION });

    /*
    Exercise the SHARED reset patch builder against the real row, so the persisted shape after a
    Reset is proven rather than assumed: the store method is the lifecycle orchestration, while this
    is the durable state contract the delivery doors read afterwards.
    */
    const live = await store.getTask(created.id);
    const patch = buildResetTask(live!, "triage");
    await store.updateTask(created.id, { humanMergeApproval: patch.humanMergeApproval ?? null });

    const reread = await store.getTask(created.id);
    expect(reread?.humanMergeApproval?.enabled).toBe(true);
    expect(reread?.humanMergeApproval?.generation).toBe(2);
    expect(reread?.humanMergeApproval?.decision).toBeUndefined();
    expect(hasCurrentHumanMergeApproval(reread!)).toBe(false);
    expect(getHumanMergeApprovalBlocker(reread!)).toBe(HUMAN_MERGE_APPROVAL_BLOCKER);
  });

  it("isolates two projects holding the same task ID and the same PR number", async () => {
    const store = h.store();
    const created = await store.createTask({ description: "Isolation inter-projets.", humanMergeApproval: true });
    await store.updateTask(created.id, { humanMergeApproval: MERGE_DECISION });

    const foreignProjectId = "fn-514-foreign-project";
    const ownProjectId = (await h.adminDb()
      .select({ projectId: schema.project.tasks.projectId })
      .from(schema.project.tasks)
      .where(eq(schema.project.tasks.id, created.id)))[0]?.projectId;
    expect(ownProjectId).toBeTruthy();
    expect(ownProjectId).not.toBe(foreignProjectId);

    // Same task ID, same PR number, different project, and deliberately NO accord.
    await h.adminDb().insert(schema.project.tasks).values({
      projectId: foreignProjectId,
      id: created.id,
      title: "foreign",
      description: "foreign",
      column: "in-review",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      humanMergeApproval: { enabled: true, generation: 1 },
      prInfo: { number: 4242, url: "https://example.test/pr/4242", state: "open", manual: true },
    } as never);

    /*
    The bound store reads only its own project's accord. The foreign row carries the SAME task ID and
    the SAME PR number with no accord at all, so a read that ignored project scope would hand this
    card a merge authorization that no operator on this project ever gave.
    */
    const own = await store.getTask(created.id);
    expect(own?.humanMergeApproval).toEqual(MERGE_DECISION);
    expect(hasCurrentHumanMergeApproval(own!)).toBe(true);
    const foreign = await h.adminDb()
      .select({ humanMergeApproval: schema.project.tasks.humanMergeApproval })
      .from(schema.project.tasks)
      .where(and(
        eq(schema.project.tasks.projectId, foreignProjectId),
        eq(schema.project.tasks.id, created.id),
      ));
    expect(foreign).toEqual([{ humanMergeApproval: { enabled: true, generation: 1 } }]);
  });

  it("applies the additive column migration idempotently, and re-adds it when dropped", async () => {
    const columnCount = async () => ((await h.adminDb().execute(sql`
      SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema = 'project' AND table_name = 'tasks' AND column_name = 'human_merge_approval'
    `)) as unknown as Array<{ n: number }>)[0]?.n;

    expect(await columnCount()).toBe(1);
    await applySchemaBaseline(h.adminDb());
    await applySchemaBaseline(h.adminDb());
    expect(await columnCount()).toBe(1);

    /*
    A stale bookkeeping marker must never be trusted alone: a delivery door reading a column the
    database lacks would fail EVERY merge, so the applier re-adds it on a missing column.
    */
    await h.adminDb().execute(sql`ALTER TABLE project.tasks DROP COLUMN human_merge_approval`);
    expect(await columnCount()).toBe(0);
    await applySchemaBaseline(h.adminDb());
    expect(await columnCount()).toBe(1);
  });
});
